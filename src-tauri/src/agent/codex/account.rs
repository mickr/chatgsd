use std::sync::LazyLock;
use std::time::{Duration, Instant};
use serde_json::{json, Value};
use tokio::sync::{watch, Mutex};
use super::{transport::{self, Server}, AgentStatus, ChatGptAccount};

static AUTH_LOCK: Mutex<()> = Mutex::const_new(());
static CACHED_EMAIL: Mutex<Option<(String, Instant)>> = Mutex::const_new(None);
const EMAIL_CACHE_TTL: Duration = Duration::from_secs(300);
static LOGIN_CANCEL: LazyLock<watch::Sender<u64>> = LazyLock::new(|| watch::channel(0).0);
pub(super) static ACCOUNT_CHANGED: LazyLock<watch::Sender<u64>> = LazyLock::new(|| watch::channel(0).0);

fn changed(sender: &watch::Sender<u64>) { sender.send_modify(|generation| *generation = generation.wrapping_add(1)); }

pub(super) async fn invalidate_cache() {
    *CACHED_EMAIL.lock().await = None;
    transport::clear_pool().await;
}

/// Fast path for interactive runs & parallel swarm workers: avoids serializing
/// every turn/worker behind a network `refreshToken: true` round-trip.
pub(super) async fn read_cached(server: &mut Server) -> Result<Option<String>, String> {
    if let Some((email, cached_at)) = CACHED_EMAIL.lock().await.as_ref() {
        if cached_at.elapsed() < EMAIL_CACHE_TTL {
            return Ok(Some(email.clone()));
        }
    }
    let _guard = AUTH_LOCK.lock().await;
    if let Some((email, cached_at)) = CACHED_EMAIL.lock().await.as_ref() {
        if cached_at.elapsed() < EMAIL_CACHE_TTL {
            return Ok(Some(email.clone()));
        }
    }
    let email = read_unlocked(server, false).await?;
    let email = match email {
        Some(email) => Some(email),
        None => read_unlocked(server, true).await?,
    };
    if let Some(ref email) = email {
        *CACHED_EMAIL.lock().await = Some((email.clone(), Instant::now()));
    }
    Ok(email)
}

async fn read_unlocked(server: &mut Server, refresh_token: bool) -> Result<Option<String>, String> {
    let result = server.rpc("account/read", json!({"refreshToken":refresh_token})).await?;
    let Some(account) = result.get("account").filter(|value| !value.is_null()) else { return Ok(None); };
    if account["type"] != "chatgpt" { return Err("Sign in with a ChatGPT account, not an API key, to use ChatGSD.".into()); }
    account["email"].as_str().filter(|email| !email.is_empty()).map(|email| Some(email.to_owned()))
        .ok_or_else(|| "Codex returned no email for the signed-in ChatGPT account.".into())
}

async fn account(app: &tauri::AppHandle, email: String) -> Result<ChatGptAccount, String> {
    let path = transport::home(app)?.join("plan-notices.json");
    let seen: Vec<String> = match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| format!("Cannot read Codex plan notice: {error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(format!("Cannot read Codex plan notice: {error}")),
    };
    let plan_notice_seen = seen.iter().any(|value| value.eq_ignore_ascii_case(&email));
    Ok(ChatGptAccount { email, plan_usage: true, plan_notice_seen })
}

pub async fn status(app: &tauri::AppHandle) -> AgentStatus {
    let result = async {
        let mut server = Server::start(app).await?;
        let _guard = AUTH_LOCK.lock().await;
        match read_unlocked(&mut server, true).await? {
            Some(email) => {
                *CACHED_EMAIL.lock().await = Some((email.clone(), Instant::now()));
                Ok(Some(account(app, email).await?))
            }
            None => {
                *CACHED_EMAIL.lock().await = None;
                Ok(None)
            }
        }
    }.await;
    match result {
        Ok(Some(account)) => {
            transport::warm_pool(app);
            AgentStatus { status: "ready".into(), detail: None, account: Some(account) }
        }
        Ok(None) => AgentStatus { status: "signed_out".into(), detail: Some("Sign in with ChatGPT to use Codex in ChatGSD.".into()), account: None },
        Err(error) => AgentStatus { status: "error".into(), detail: Some(error), account: None },
    }
}

/// Refresh through Codex, then read only its app-owned bearer credential.
pub(super) async fn decisions_token(app: &tauri::AppHandle) -> Result<(String, String), String> {
    let mut server = Server::acquire(app, false).await?;
    let _guard = AUTH_LOCK.lock().await;
    let email = read_unlocked(&mut server, true).await?
        .ok_or("Sign in with ChatGPT to classify inline requests.")?;
    if !account(app, email.clone()).await?.plan_notice_seen {
        return Err("Confirm ChatGPT plan use in the sidebar first.".into());
    }
    #[derive(serde::Deserialize)]
    struct Tokens { access_token: String }
    #[derive(serde::Deserialize)]
    struct Auth { tokens: Tokens }
    let bytes = tokio::fs::read(server.home.join("auth.json")).await
        .map_err(|_| "Cannot read the app's ChatGPT authentication.".to_owned())?;
    let auth: Auth = serde_json::from_slice(&bytes)
        .map_err(|_| "ChatGPT authentication has no usable access token.".to_owned())?;
    if auth.tokens.access_token.is_empty() {
        return Err("Sign in with ChatGPT again to classify inline requests.".into());
    }
    Ok((auth.tokens.access_token, email))
}

#[tauri::command]
pub async fn chatgpt_sign_in(app: tauri::AppHandle) -> Result<ChatGptAccount, String> {
    let mut cancelled = LOGIN_CANCEL.subscribe();
    let _guard = tokio::select! {
        biased;
        _ = cancelled.changed() => return Err("ChatGPT sign-in cancelled".into()),
        guard = AUTH_LOCK.lock() => guard,
    };
    let mut server = tokio::select! {
        biased;
        _ = cancelled.changed() => return Err("ChatGPT sign-in cancelled".into()),
        server = Server::start(&app) => server?,
    };
    let login = tokio::select! {
        biased;
        _ = cancelled.changed() => return Err("ChatGPT sign-in cancelled".into()),
        login = server.rpc("account/login/start", json!({"type":"chatgpt"})) => login?,
    };
    let login_id = login["loginId"].as_str().ok_or("Codex returned no login ID")?.to_owned();
    let url = login["authUrl"].as_str().ok_or("Codex returned no browser sign-in URL")?;
    let parsed = url::Url::parse(url).map_err(|_| "Codex returned an invalid sign-in URL")?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("auth.openai.com") {
        return Err("Codex returned an unexpected sign-in destination".into());
    }
    if cancelled.has_changed().unwrap_or(true) { return Err("ChatGPT sign-in cancelled".into()); }
    open::that(url).map_err(|error| format!("Cannot open ChatGPT sign-in: {error}"))?;
    loop {
        let message = tokio::select! {
            result = server.next() => result?,
            _ = cancelled.changed() => {
                let _ = server.rpc("account/login/cancel", json!({"loginId":login_id})).await;
                return Err("ChatGPT sign-in cancelled".into());
            }
        };
        if message["method"] == "account/login/completed" && message["params"]["loginId"] == login_id {
            if message["params"]["success"] != true {
                return Err(message["params"]["error"].as_str().unwrap_or("ChatGPT sign-in did not complete").into());
            }
            let email = read_unlocked(&mut server, true).await?.ok_or("Codex did not save the signed-in account")?;
            *CACHED_EMAIL.lock().await = Some((email.clone(), Instant::now()));
            changed(&ACCOUNT_CHANGED);
            transport::clear_pool().await;
            transport::warm_pool(&app);
            return account(&app, email).await;
        }
        if message.get("id").is_some() { server.reject(&message).await?; }
    }
}

#[tauri::command]
pub async fn chatgpt_cancel_sign_in() -> Result<(), String> {
    changed(&LOGIN_CANCEL);
    Ok(())
}

#[tauri::command]
pub async fn chatgpt_sign_out(app: tauri::AppHandle) -> Result<(), String> {
    changed(&LOGIN_CANCEL);
    changed(&ACCOUNT_CHANGED);
    invalidate_cache().await;
    let _guard = AUTH_LOCK.lock().await;
    let mut server = Server::start(&app).await?;
    server.rpc("account/logout", Value::Null).await?;
    Ok(())
}

#[tauri::command]
pub async fn chatgpt_ack_plan_notice(app: tauri::AppHandle) -> Result<(), String> {
    let _guard = AUTH_LOCK.lock().await;
    let mut server = Server::start(&app).await?;
    let email = read_unlocked(&mut server, true).await?.ok_or("Sign in with ChatGPT first")?;
    let path = transport::home(&app)?.join("plan-notices.json");
    let mut seen: Vec<String> = match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.to_string()),
    };
    if !seen.iter().any(|value| value.eq_ignore_ascii_case(&email)) { seen.push(email); }
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(&temporary, serde_json::to_vec(&seen).map_err(|error| error.to_string())?).await.map_err(|error| error.to_string())?;
    tokio::fs::rename(&temporary, &path).await.map_err(|error| error.to_string())
}

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::watch;
use uuid::Uuid;

use super::{
    errors::{api_error, auth, other, response_error, unusable_refresh},
    storage::{Credentials, Registration, Storage},
    AgentError, ChatGptAccount, CLIENT, PLAN_SCOPE, STORAGE_LOCK,
};

const ISSUER: &str = "https://auth.openai.com";
const TOKEN_ENDPOINT: &str = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

struct Pending {
    id: Uuid,
    stop: Arc<AtomicBool>,
    cancel: watch::Sender<bool>,
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

struct AttemptGuard(Uuid);

impl Drop for AttemptGuard {
    fn drop(&mut self) {
        let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        if pending.as_ref().is_some_and(|attempt| attempt.id == self.0) {
            if let Some(attempt) = pending.take() {
                attempt.stop.store(true, Ordering::Release);
            }
        }
    }
}

pub(super) fn cancel_sign_in() {
    let pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(attempt) = pending.as_ref() {
        attempt.stop.store(true, Ordering::Release);
        let _ = attempt.cancel.send(true);
    }
}

pub(super) async fn sign_in(app: &tauri::AppHandle) -> Result<ChatGptAccount, String> {
    let id = Uuid::new_v4();
    let stop = Arc::new(AtomicBool::new(false));
    let (cancel, mut cancelled) = watch::channel(false);
    {
        let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        if pending.is_some() {
            return Err("A ChatGPT sign-in is already open. Finish or cancel it first.".into());
        }
        *pending = Some(Pending {
            id,
            stop: stop.clone(),
            cancel,
        });
    }
    let _guard = AttemptGuard(id);
    tokio::select! {
        _ = cancelled.changed() => Err("ChatGPT sign-in was cancelled".into()),
        result = tokio::time::timeout(SIGN_IN_TIMEOUT, authorize(app, stop)) => {
            result.map_err(|_| "ChatGPT sign-in timed out. Please try again.".to_owned())?
                .map_err(|error| error.message)
        }
    }
}

async fn authorize(
    app: &tauri::AppHandle,
    stop: Arc<AtomicBool>,
) -> Result<ChatGptAccount, AgentError> {
    let storage = Storage::new(app).map_err(other)?;
    let (host_id, registration, previous) = {
        let _lock = STORAGE_LOCK.lock().await;
        let host_id = storage.host_id().await.map_err(other)?;
        let registrations = storage.registrations().await.map_err(other)?;
        let registration = registrations.last_subject.as_ref().and_then(|subject| {
            registrations
                .accounts
                .get(subject)
                .map(|account| (subject.clone(), account.clone()))
        });
        (
            host_id,
            registration,
            storage.credentials().await.map_err(other)?,
        )
    };
    let server = tiny_http::Server::http("127.0.0.1:1455")
        .or_else(|_| tiny_http::Server::http("127.0.0.1:0"))
        .map_err(|_| other("Could not open a local callback listener for ChatGPT sign-in"))?;
    let address = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| other("ChatGPT sign-in requires a loopback listener"))?;
    let redirect_uri = format!("http://127.0.0.1:{}/auth/callback", address.port());
    let state = random_secret();
    let nonce = random_secret();
    let verifier = random_secret();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let client_id = registration
        .as_ref()
        .map(|(_, account)| account.client_id.as_str())
        .unwrap_or("dynamic_agent_client");
    let mut url = url::Url::parse("https://auth.openai.com/api/accounts/authorize")
        .map_err(|_| other("Invalid ChatGPT authorization endpoint"))?;
    {
        let mut query = url.query_pairs_mut();
        query.extend_pairs([
            ("client_id", client_id),
            ("ext_agent_host_id", host_id.as_str()),
            ("response_type", "code"),
            ("redirect_uri", redirect_uri.as_str()),
            ("scope", SCOPES),
            ("resource", RESOURCE),
            ("state", state.as_str()),
            ("nonce", nonce.as_str()),
            ("code_challenge_method", "S256"),
            ("code_challenge", challenge.as_str()),
        ]);
        if let Some((subject, account)) = &registration {
            query.append_pair("login_hint", &account.email);
            if let Some(previous) = previous.as_ref().filter(|credentials| {
                &credentials.subject == subject && credentials.client_id == account.client_id
            }) {
                query.append_pair("id_token_hint", &previous.id_token);
                if !previous.scopes.iter().any(|scope| scope == PLAN_SCOPE) {
                    query.append_pair("prompt", "consent");
                }
            }
        } else {
            query.append_pair("agent_name_hint", "Scratch");
        }
    }
    // Browser failures must never echo the authorization URL or its ID-token hint.
    open::that_detached(url.as_str())
        .map_err(|_| other("Could not open your browser for ChatGPT sign-in"))?;
    let selected_client = registration
        .as_ref()
        .map(|(_, account)| account.client_id.clone());
    let callback = tokio::task::spawn_blocking(move || {
        receive_callback(server, &state, selected_client.as_deref(), &stop)
    })
    .await
    .map_err(|_| other("ChatGPT's callback listener stopped unexpectedly"))??;
    let token = CLIENT
        .post(TOKEN_ENDPOINT)
        .timeout(Duration::from_secs(30))
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", callback.client_id.as_str()),
            ("code", callback.code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("resource", RESOURCE),
        ])
        .send()
        .await
        .map_err(|_| {
            other("Could not exchange the ChatGPT sign-in code. Please try signing in again.")
        })?;
    if !token.status().is_success() {
        return Err(response_error(token).await);
    }
    let token: TokenResponse = token
        .json()
        .await
        .map_err(|_| other("ChatGPT returned an invalid token response"))?;
    let id_token = token
        .id_token
        .as_deref()
        .ok_or_else(|| auth("ChatGPT did not return an ID token"))?;
    let claims = validate_identity(id_token, &callback.client_id, &nonce).await?;
    if registration
        .as_ref()
        .is_some_and(|(subject, _)| subject != &claims.sub)
    {
        return Err(auth(
            "ChatGPT returned a different account. The saved account was not changed.",
        ));
    }
    let mut credentials = Credentials {
        email: claims.email,
        issuer: ISSUER.to_owned(),
        subject: claims.sub,
        client_id: callback.client_id,
        ext_agent_host_id: host_id,
        id_token: id_token.to_owned(),
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        token_type: token.token_type,
        expires_in: token.expires_in,
        scopes: token
            .scope
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_owned)
            .collect(),
        saved_at: chrono::Utc::now().to_rfc3339(),
        plan_notice_seen: false,
    };
    let _lock = STORAGE_LOCK.lock().await;
    let mut registrations = storage.registrations().await.map_err(other)?;
    credentials.plan_notice_seen = registrations
        .accounts
        .get(&credentials.subject)
        .is_some_and(|account| account.plan_notice_seen);
    registrations.last_subject = Some(credentials.subject.clone());
    registrations.accounts.insert(
        credentials.subject.clone(),
        Registration {
            client_id: credentials.client_id.clone(),
            email: credentials.email.clone(),
            plan_notice_seen: credentials.plan_notice_seen,
        },
    );
    storage
        .save_registrations(&registrations)
        .await
        .map_err(other)?;
    storage
        .save_credentials(&credentials)
        .await
        .map_err(other)?;
    super::invalidate_sessions();
    Ok(credentials.account())
}

fn random_secret() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}

struct Callback {
    code: String,
    client_id: String,
}

fn receive_callback(
    server: tiny_http::Server,
    state: &str,
    client_id: Option<&str>,
    stop: &AtomicBool,
) -> Result<Callback, AgentError> {
    let deadline = Instant::now() + SIGN_IN_TIMEOUT;
    while !stop.load(Ordering::Acquire) && Instant::now() < deadline {
        let Some(request) = server
            .recv_timeout(Duration::from_millis(100))
            .map_err(|_| other("ChatGPT's callback listener failed"))?
        else {
            continue;
        };
        let url = url::Url::parse(&format!("http://127.0.0.1{}", request.url()))
            .map_err(|_| auth("Invalid ChatGPT sign-in callback"))?;
        if request.method() != &tiny_http::Method::Get || url.path() != "/auth/callback" {
            let _ = request
                .respond(tiny_http::Response::from_string("Not found").with_status_code(404));
            continue;
        }
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        if query.get("state").is_none_or(|value| value != state) {
            let _ = request.respond(
                tiny_http::Response::from_string("Invalid sign-in state").with_status_code(400),
            );
            continue;
        }
        let result = parse_callback(&query, client_id);
        let message = if result.is_ok() {
            "You can return to Scratch to finish signing in."
        } else {
            "Sign-in did not finish. Return to Scratch for details."
        };
        let mut response = tiny_http::Response::from_string(format!("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Scratch</title><body><h1>Scratch</h1><p>{message}</p></body></html>"));
        if let Ok(header) =
            tiny_http::Header::from_bytes("Content-Type", "text/html; charset=utf-8")
        {
            response.add_header(header);
        }
        if let Ok(header) = tiny_http::Header::from_bytes("Cache-Control", "no-store") {
            response.add_header(header);
        }
        let _ = request.respond(response);
        return result;
    }
    Err(auth("ChatGPT sign-in was cancelled or timed out"))
}

fn parse_callback(
    query: &std::collections::HashMap<String, String>,
    client_id: Option<&str>,
) -> Result<Callback, AgentError> {
    if let Some(error) = query.get("error") {
        return Err(auth(if error == "access_denied" {
            "ChatGPT sign-in was declined. Continue with ChatGPT to try again."
        } else {
            "ChatGPT could not authorize Scratch. Please try signing in again."
        }));
    }
    let issued = match (client_id, query.get("client_id")) {
        (Some(saved), Some(issued)) if saved != issued => {
            return Err(auth("ChatGPT returned a different client registration"))
        }
        (Some(saved), _) => saved,
        (None, Some(issued)) if !issued.is_empty() && issued != "dynamic_agent_client" => issued,
        _ => {
            return Err(auth(
                "ChatGPT registration did not return an issued client ID. Please sign in again.",
            ))
        }
    };
    let code = query
        .get("code")
        .filter(|code| !code.is_empty())
        .ok_or_else(|| auth("ChatGPT did not return a sign-in code"))?;
    Ok(Callback {
        code: code.clone(),
        client_id: issued.to_owned(),
    })
}

#[derive(Deserialize)]
struct Discovery {
    jwks_uri: String,
    revocation_endpoint: String,
}

async fn discovery() -> Result<Discovery, AgentError> {
    let response = CLIENT
        .get(format!("{ISSUER}/.well-known/openid-configuration"))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| other("Could not load ChatGPT's sign-in configuration"))?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    response
        .json()
        .await
        .map_err(|_| other("ChatGPT returned invalid sign-in configuration"))
}

#[derive(Deserialize)]
struct Claims {
    sub: String,
    email: String,
    nonce: String,
}

async fn validate_identity(
    id_token: &str,
    client_id: &str,
    nonce: &str,
) -> Result<Claims, AgentError> {
    let metadata = discovery().await?;
    let response = CLIENT
        .get(&metadata.jwks_uri)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| other("Could not load ChatGPT's identity signing keys"))?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let jwks: JwkSet = response
        .json()
        .await
        .map_err(|_| auth("ChatGPT returned invalid identity signing keys"))?;
    let header =
        decode_header(id_token).map_err(|_| auth("ChatGPT returned an invalid ID token"))?;
    if header.alg != Algorithm::RS256 {
        return Err(auth(
            "ChatGPT's ID token used an unsupported signature algorithm",
        ));
    }
    let key = header
        .kid
        .as_deref()
        .and_then(|kid| jwks.find(kid))
        .ok_or_else(|| auth("ChatGPT's ID-token signing key was not found"))?;
    let key =
        DecodingKey::from_jwk(key).map_err(|_| auth("ChatGPT's signing key could not be read"))?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[ISSUER]);
    validation.set_audience(&[client_id]);
    validation.leeway = 0;
    let claims = decode::<Claims>(id_token, &key, &validation)
        .map_err(|_| {
            auth("ChatGPT's ID token failed signature, issuer, audience, or expiration validation")
        })?
        .claims;
    if claims.nonce != nonce || claims.sub.is_empty() {
        return Err(auth(
            "ChatGPT's ID token did not match this sign-in attempt",
        ));
    }
    Ok(claims)
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    id_token: Option<String>,
    token_type: String,
    expires_in: u64,
    scope: Option<String>,
}

pub(super) async fn access_token(
    app: &tauri::AppHandle,
    rejected_token: Option<&str>,
) -> Result<String, AgentError> {
    let _lock = STORAGE_LOCK.lock().await;
    let storage = Storage::new(app).map_err(other)?;
    let mut credentials = storage
        .credentials()
        .await
        .map_err(other)?
        .ok_or_else(|| auth("Continue with ChatGPT to use your plan"))?;
    if !credentials.account().plan_usage {
        return Err(auth(
            "ChatGPT plan usage is not enabled. Continue with ChatGPT in settings to enable it.",
        ));
    }
    let force_refresh = rejected_token.is_some_and(|rejected| rejected == credentials.access_token);
    if !credentials.expires_soon() && !force_refresh {
        return Ok(credentials.access_token);
    }
    let response = CLIENT
        .post(TOKEN_ENDPOINT)
        .timeout(Duration::from_secs(30))
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", credentials.client_id.as_str()),
            ("refresh_token", credentials.refresh_token.as_str()),
            ("resource", RESOURCE),
        ])
        .send()
        .await
        .map_err(|_| {
            other("Could not renew your ChatGPT session. Check your connection and try again.")
        })?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let request_id = response
            .headers()
            .get("x-request-id")
            .and_then(|h| h.to_str().ok())
            .map(str::to_owned);
        let body = response.json().await.unwrap_or(serde_json::Value::Null);
        let mut error = api_error(Some(status), &body, request_id.as_deref());
        if unusable_refresh(&body) {
            storage.clear_credentials().await.map_err(other)?;
            error.kind = super::super::AgentErrorKind::Auth;
            error
                .message
                .push_str(" Continue with ChatGPT to sign in again.");
        }
        return Err(error);
    }
    let token: TokenResponse = response
        .json()
        .await
        .map_err(|_| other("ChatGPT returned an invalid session renewal response"))?;
    credentials.access_token = token.access_token;
    credentials.refresh_token = token.refresh_token;
    credentials.token_type = token.token_type;
    credentials.expires_in = token.expires_in;
    credentials.saved_at = chrono::Utc::now().to_rfc3339();
    if let Some(scope) = token.scope {
        credentials.scopes = scope.split_whitespace().map(str::to_owned).collect();
    }
    // Keep the previously validated identity token as a hint, not as renewed identity proof.
    storage
        .save_credentials(&credentials)
        .await
        .map_err(other)?;
    if !credentials.account().plan_usage {
        return Err(auth(
            "ChatGPT plan usage is no longer enabled. Continue with ChatGPT in settings.",
        ));
    }
    Ok(credentials.access_token)
}

pub(super) async fn sign_out(app: &tauri::AppHandle) -> Result<(), String> {
    cancel_sign_in();
    let _lock = STORAGE_LOCK.lock().await;
    let storage = Storage::new(app)?;
    let credentials = storage.credentials().await?;
    let result = if let Some(credentials) = credentials {
        revoke(&credentials).await
    } else {
        Ok(())
    };
    storage.clear_credentials().await?;
    result.map_err(|error| format!("Signed out locally, but remote revocation was not confirmed. You can disconnect Scratch in ChatGPT Settings. {}", error.message))
}

async fn revoke(credentials: &Credentials) -> Result<(), AgentError> {
    let metadata = discovery().await?;
    for attempt in 0..3 {
        let response = CLIENT
            .post(&metadata.revocation_endpoint)
            .timeout(Duration::from_secs(30))
            .form(&[
                ("token", credentials.refresh_token.as_str()),
                ("token_type_hint", "refresh_token"),
                ("client_id", credentials.client_id.as_str()),
            ])
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) if !response.status().is_server_error() || attempt == 2 => {
                return Err(response_error(response).await)
            }
            Err(_) if attempt == 2 => {
                return Err(other("Could not contact ChatGPT to revoke this session"))
            }
            _ => tokio::time::sleep(Duration::from_secs(1 << attempt)).await,
        }
    }
    Err(other("ChatGPT session revocation was not confirmed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(pairs: &[(&str, &str)]) -> std::collections::HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn new_registration_requires_an_issued_client_id() {
        assert!(parse_callback(&query(&[("code", "code_1")]), None).is_err());
        assert!(parse_callback(
            &query(&[("code", "code_1"), ("client_id", "dynamic_agent_client")]),
            None
        )
        .is_err());
        let callback = parse_callback(
            &query(&[("code", "code_1"), ("client_id", "oaiapp_1")]),
            None,
        )
        .unwrap();
        assert_eq!(callback.client_id, "oaiapp_1");
        assert_eq!(callback.code, "code_1");
    }

    #[test]
    fn returning_registration_keeps_its_client_and_rejects_mismatches_or_denial() {
        let callback = parse_callback(&query(&[("code", "code_2")]), Some("oaiapp_1")).unwrap();
        assert_eq!(callback.client_id, "oaiapp_1");
        assert!(parse_callback(
            &query(&[("code", "code_2"), ("client_id", "oaiapp_2")]),
            Some("oaiapp_1")
        )
        .is_err());
        assert!(parse_callback(&query(&[("error", "access_denied")]), Some("oaiapp_1")).is_err());
    }

    #[test]
    fn oauth_secrets_are_fresh_unpadded_base64url() {
        let first = random_secret();
        let second = random_secret();
        assert_ne!(first, second);
        assert_eq!(first.len(), 43);
        assert!(!first.contains('='));
        assert_eq!(URL_SAFE_NO_PAD.decode(first).unwrap().len(), 32);
    }
}

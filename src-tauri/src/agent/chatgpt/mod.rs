mod context;
mod errors;
mod oauth;
mod storage;
mod stream;

use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{watch, Mutex as AsyncMutex};
use uuid::Uuid;

use super::{
    conversations,
    events::{self, AgentEvent},
    prompt, tools, AgentError, AgentStatus, ChatGptAccount, ModelInfo, RunContext, RunResult,
};
use errors::{auth, other, response_error};
use storage::Storage;

const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
/// Tool rounds per message; reading a long note in parts takes several.
const MAX_ITERATIONS: usize = 50;
const OTHER_ACCOUNT: &str =
    "This conversation was with another ChatGPT account. Start a new conversation.";
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);
// Credential mutations and rotating refreshes must not race one another.
static STORAGE_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());
static ACCOUNT_CHANGED: LazyLock<watch::Sender<()>> = LazyLock::new(|| watch::channel(()).0);

/// In-memory cache of a conversation's model input; `conversations` persists it.
struct Session {
    account: String,
    history: Arc<AsyncMutex<Vec<Value>>>,
}

static SESSIONS: LazyLock<Mutex<HashMap<String, Session>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn invalidate_sessions() {
    ACCOUNT_CHANGED.send_replace(());
    SESSIONS
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clear();
}

#[tauri::command]
pub async fn chatgpt_sign_in(app: tauri::AppHandle) -> Result<ChatGptAccount, String> {
    oauth::sign_in(&app).await
}

#[tauri::command]
pub async fn chatgpt_cancel_sign_in() -> Result<(), String> {
    oauth::cancel_sign_in();
    Ok(())
}

#[tauri::command]
pub async fn chatgpt_sign_out(app: tauri::AppHandle) -> Result<(), String> {
    invalidate_sessions();
    oauth::sign_out(&app).await
}

#[tauri::command]
pub async fn chatgpt_ack_plan_notice(app: tauri::AppHandle) -> Result<(), String> {
    let _lock = STORAGE_LOCK.lock().await;
    let storage = Storage::new(&app)?;
    let mut credentials = storage
        .credentials()
        .await?
        .ok_or("Continue with ChatGPT to use your plan")?;
    credentials.plan_notice_seen = true;
    let mut registrations = storage.registrations().await?;
    if let Some(registration) = registrations.accounts.get_mut(&credentials.subject) {
        registration.plan_notice_seen = true;
    }
    storage.save_registrations(&registrations).await?;
    storage.save_credentials(&credentials).await
}

pub async fn status(app: &tauri::AppHandle) -> AgentStatus {
    let _lock = STORAGE_LOCK.lock().await;
    let result = match Storage::new(app) {
        Ok(storage) => storage.credentials().await,
        Err(error) => Err(error),
    };
    let (status, detail, account) = match result {
        Ok(Some(credentials)) => {
            let account = credentials.account();
            if account.plan_usage {
                ("ready", None, Some(account))
            } else {
                (
                    "plan_usage_disabled",
                    Some("Continue with ChatGPT to enable ChatGPT plan usage".to_owned()),
                    Some(account),
                )
            }
        }
        Ok(None) => (
            "signed_out",
            Some("Continue with ChatGPT to use your plan".to_owned()),
            None,
        ),
        Err(error) => ("signed_out", Some(error), None),
    };
    AgentStatus {
        status: status.to_owned(),
        detail,
        account,
    }
}

pub async fn list_models(app: &tauri::AppHandle) -> Result<Vec<ModelInfo>, String> {
    fetch_models(app).await.map_err(|error| error.message)
}

async fn fetch_models(app: &tauri::AppHandle) -> Result<Vec<ModelInfo>, AgentError> {
    let response = authorized_request(app, |token| {
        CLIENT
            .get("https://api.openai.com/v1/models")
            .timeout(Duration::from_secs(60))
            .bearer_auth(token)
    })
    .await?;
    let catalog: Value = response
        .json()
        .await
        .map_err(|_| other("ChatGPT returned an invalid model catalog"))?;
    let models = catalog
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| other("ChatGPT's model catalog did not include models"))?;
    models
        .iter()
        .filter(|model| model.get("visibility").and_then(Value::as_str) == Some("list"))
        .map(|model| {
            let id = model
                .get("slug")
                .and_then(Value::as_str)
                .ok_or_else(|| other("ChatGPT returned a model without a slug"))?;
            let label = model
                .get("display_name")
                .and_then(Value::as_str)
                .ok_or_else(|| other("ChatGPT returned a model without a display name"))?;
            Ok(ModelInfo {
                id: id.to_owned(),
                label: label.to_owned(),
            })
        })
        .collect()
}

async fn authorized_request(
    app: &tauri::AppHandle,
    request: impl Fn(&str) -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, AgentError> {
    let token = oauth::access_token(app, None).await?;
    let response = request(&token)
        .send()
        .await
        .map_err(|_| other("Could not reach ChatGPT. Check your connection and try again."))?;
    let response = if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        let token = oauth::access_token(app, Some(&token)).await?;
        request(&token)
            .send()
            .await
            .map_err(|_| other("Could not reach ChatGPT after renewing the session"))?
    } else {
        response
    };
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    Ok(response)
}

#[derive(Serialize)]
struct ResponseRequest<'a> {
    model: &'a str,
    instructions: &'a str,
    input: &'a [Value],
    tools: &'a [Value],
    store: bool,
    stream: bool,
    include: [&'a str; 1],
    parallel_tool_calls: bool,
}

pub async fn run(
    app: tauri::AppHandle,
    ctx: RunContext,
    model: Option<String>,
    session_id: Option<String>,
    user_prompt: String,
) -> RunResult {
    let mut account_changed = ACCOUNT_CHANGED.subscribe();
    tokio::select! {
        result = run_session(app, ctx, model, session_id, user_prompt) => result,
        _ = account_changed.changed() => Err(auth("The ChatGPT account changed or signed out. Start a new conversation.")),
    }
}

async fn run_session(
    app: tauri::AppHandle,
    ctx: RunContext,
    model: Option<String>,
    session_id: Option<String>,
    user_prompt: String,
) -> RunResult {
    let session_id = session_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    if Uuid::parse_str(&session_id).is_err() {
        return Err(other("Invalid ChatGPT session ID"));
    }
    conversations::begin(&app, &ctx.notes_folder, &ctx.note_id, &session_id, &user_prompt)
        .await
        .map_err(other)?;
    events::emit(
        &app,
        &ctx.run_id,
        AgentEvent::Session {
            session_id: session_id.clone(),
        },
    );
    let account = {
        let _lock = STORAGE_LOCK.lock().await;
        let credentials = Storage::new(&app)
            .map_err(other)?
            .credentials()
            .await
            .map_err(other)?
            .ok_or_else(|| auth("Continue with ChatGPT to use your plan"))?;
        format!("{}:{}", credentials.subject, credentials.client_id)
    };
    let cached = SESSIONS
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&session_id)
        .map(|session| (session.account.clone(), session.history.clone()));
    let history = match cached {
        Some((owner, history)) if owner == account => history,
        Some(_) => return Err(other(OTHER_ACCOUNT)),
        None => {
            // Reasoning items are encrypted for the account that produced them.
            let saved = match conversations::load_model(&app, &ctx.notes_folder, &session_id)
                .await
                .map_err(other)?
            {
                Some(saved) if saved.account != account => return Err(other(OTHER_ACCOUNT)),
                Some(saved) => saved.items,
                None => Vec::new(),
            };
            SESSIONS
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .entry(session_id.clone())
                .or_insert_with(|| Session {
                    account: account.clone(),
                    history: Arc::new(AsyncMutex::new(saved)),
                })
                .history
                .clone()
        }
    };
    let mut saved_history = history.lock().await;
    let mut input = saved_history.clone();
    context::compact(&mut input);
    input.push(json!({"role": "user", "content": prompt::user_message(&user_prompt, &ctx)}));
    let model = match model.filter(|model| !model.is_empty()) {
        Some(model) => model,
        None => {
            fetch_models(&app)
                .await?
                .into_iter()
                .next()
                .ok_or_else(|| other("No ChatGPT models are available for this account"))?
                .id
        }
    };
    let instructions = prompt::instructions(&ctx);
    let functions: Vec<_> = tools::catalog()
        .into_iter()
        .map(|tool| {
            json!({
                "type":"function", "name":tool.name, "description":tool.description,
                "parameters":tool.parameters, "strict":tool.strict,
            })
        })
        .collect();
    let tools = [
        json!({"type":"namespace", "name":"scratch", "description":"Read and precisely edit the live Scratch note, or read workspace notes.", "tools":functions}),
    ];
    for _ in 0..MAX_ITERATIONS {
        context::fit(&mut input, context::MAX_INPUT_BYTES);
        let body = ResponseRequest {
            model: &model,
            instructions: &instructions,
            input: &input,
            tools: &tools,
            store: false,
            stream: true,
            include: ["reasoning.encrypted_content"],
            parallel_tool_calls: false,
        };
        let response = authorized_request(&app, |token| {
            CLIENT
                .post("https://api.openai.com/v1/responses")
                .bearer_auth(token)
                .json(&body)
        })
        .await?;
        let items = stream::consume(&app, &ctx.run_id, response).await?;
        let calls: Vec<_> = items
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
            .map(parse_tool_call)
            .collect::<Result<_, _>>()?;
        input.extend(items);
        for call in &calls {
            let name = events::canonical_tool_name(&call.name);
            events::emit(
                &app,
                &ctx.run_id,
                AgentEvent::ToolCall {
                    call_id: call.id.clone(),
                    name: name.to_owned(),
                    input: call.args.clone(),
                },
            );
            let output = tools::execute(&app, &ctx.run_id, name, call.args.clone()).await;
            events::emit(
                &app,
                &ctx.run_id,
                AgentEvent::ToolResult {
                    call_id: call.id.clone(),
                    ok: output.ok,
                    output: output.text.chars().take(2000).collect(),
                },
            );
            input.push(
                json!({"type":"function_call_output", "call_id":call.id, "output":output.text}),
            );
        }
        // Commit only complete rounds, so cancellation cannot leave dangling tool calls in history.
        saved_history.clone_from(&input);
        if let Err(error) =
            conversations::save_model(&app, &ctx.notes_folder, &session_id, &account, &input).await
        {
            eprintln!("Couldn't save ChatGPT conversation {session_id}: {error}");
        }
        if calls.is_empty() {
            return Ok(());
        }
    }
    Err(other(format!(
        "ChatGPT reached the limit of {MAX_ITERATIONS} tool rounds. Send another message to continue."
    )))
}

struct ToolCall {
    id: String,
    name: String,
    args: Value,
}

fn parse_tool_call(item: &Value) -> Result<ToolCall, AgentError> {
    let id = item
        .get("call_id")
        .and_then(Value::as_str)
        .ok_or_else(|| other("ChatGPT returned a tool call without a call ID"))?;
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| other("ChatGPT returned a tool call without a name"))?;
    if item
        .get("namespace")
        .and_then(Value::as_str)
        .is_some_and(|namespace| namespace != "scratch")
    {
        return Err(other(
            "ChatGPT requested a tool outside the Scratch namespace",
        ));
    }
    let args = item
        .get("arguments")
        .and_then(Value::as_str)
        .ok_or_else(|| other("ChatGPT returned a tool call without arguments"))?;
    let args =
        serde_json::from_str(args).map_err(|_| other("ChatGPT returned invalid tool arguments"))?;
    Ok(ToolCall {
        id: id.to_owned(),
        name: name.to_owned(),
        args,
    })
}

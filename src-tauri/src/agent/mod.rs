mod bridge;
pub mod chatgpt;
mod computer;
pub mod computer_permissions;
pub mod conversations;
pub mod events;
pub mod note_edits;
pub mod prompt;
mod reading;
pub mod skills;
pub mod tools;
mod web;
mod workspace;
use events::{emit, AgentEvent};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

#[derive(Clone)]
pub struct RunContext {
    pub run_id: String,
    pub note_id: String,
    pub note_title: String,
    pub selection: Option<String>,
    pub computer_access: bool,
    /// Internet access for this message: research and skill offers.
    pub web_access: bool,
    /// Model for the research role; `None` runs it on the conversation's model.
    pub research_model: Option<String>,
    /// The user's brief for the research role; `None` uses the default.
    pub research_brief: Option<String>,
    pub notes_folder: PathBuf,
    /// Scratch UI block guide from the frontend, generated from its component catalog.
    pub ui_guide: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentErrorKind {
    Auth,
    UsageLimit,
    NotEligible,
    Other,
}

#[derive(Debug)]
pub struct AgentError {
    pub kind: AgentErrorKind,
    pub message: String,
}
pub type RunResult = Result<(), AgentError>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptAccount {
    pub email: String,
    pub plan_usage: bool,
    pub plan_notice_seen: bool,
}
/// Whether the agent can run: signed in to ChatGPT with plan usage granted.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub status: String,
    pub detail: Option<String>,
    pub account: Option<ChatGptAccount>,
}
#[derive(Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestContext {
    note_id: String,
    note_title: String,
    selection: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunRequest {
    model: Option<String>,
    ui_guide: String,
    session_id: Option<String>,
    prompt: String,
    #[serde(default)]
    computer_access: bool,
    #[serde(default)]
    web_access: bool,
    research_model: Option<String>,
    research_brief: Option<String>,
    context: RequestContext,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunResponse {
    run_id: String,
}
struct Run {
    task: tauri::async_runtime::JoinHandle<()>,
    context: RunContext,
}
#[derive(Default)]
pub struct AgentState {
    runs: Mutex<HashMap<String, Run>>,
    bridge: bridge::ToolBridge,
    
}
impl AgentState {
    fn context(&self, run_id: &str) -> Option<RunContext> {
        self.runs
            .lock()
            .expect("agent runs mutex")
            .get(run_id)
            .map(|r| r.context.clone())
    }
}

#[tauri::command]
pub async fn agent_status(app: tauri::AppHandle) -> AgentStatus {
    chatgpt::status(&app).await
}
#[tauri::command]
pub async fn agent_list_models(app: tauri::AppHandle) -> Result<Vec<ModelInfo>, String> {
    chatgpt::list_models(&app).await
}
/// The research role's built-in brief, shown in settings until the user edits it.
#[tauri::command]
pub fn agent_research_brief_default() -> &'static str {
    prompt::DEFAULT_RESEARCH_BRIEF
}
/// The configured notes folder, canonicalized.
pub(crate) async fn notes_folder(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let folder = app
        .state::<crate::AppState>()
        .app_config
        .read()
        .expect("app config lock")
        .notes_folder
        .clone()
        .ok_or("Choose a notes folder first")?;
    tokio::fs::canonicalize(folder)
        .await
        .map_err(|e| format!("Cannot open notes folder: {e}"))
}
#[tauri::command]
pub async fn agent_start_run(
    app: tauri::AppHandle,
    request: StartRunRequest,
    state: State<'_, AgentState>,
) -> Result<StartRunResponse, String> {
    if request.prompt.trim().is_empty() {
        return Err("Enter a message first".into());
    }
    let notes_folder = notes_folder(&app).await?;
    crate::abs_path_from_id(&notes_folder, &request.context.note_id)?;
    let run_id = uuid::Uuid::new_v4().to_string();
    let ctx = RunContext {
        run_id: run_id.clone(),
        note_id: request.context.note_id,
        note_title: request.context.note_title,
        selection: request.context.selection,
        computer_access: request.computer_access,
        web_access: request.web_access,
        research_model: request.research_model.filter(|model| !model.is_empty()),
        research_brief: request
            .research_brief
            .map(|brief| brief.trim().chars().take(prompt::MAX_BRIEF_CHARS).collect::<String>())
            .filter(|brief| !brief.is_empty()),
        ui_guide: request.ui_guide,
        notes_folder,
    };
    let task_ctx = ctx.clone();
    let task_app = app.clone();
    // The gate ensures tools cannot arrive before the run and its context are registered.
    let (start, ready) = tokio::sync::oneshot::channel();
    let task = tauri::async_runtime::spawn(async move {
        if ready.await.is_err() {
            return;
        }
        let model = request.model.filter(|m| !m.is_empty());
        let result = chatgpt::run(
            task_app.clone(),
            task_ctx.clone(),
            model,
            request.session_id,
            request.prompt,
        )
        .await;
        let state = task_app.state::<AgentState>();
        // Removing under the same lock as cancellation chooses exactly one terminal owner.
        let removed = state
            .runs
            .lock()
            .expect("agent runs mutex")
            .remove(&task_ctx.run_id);
        if removed.is_none() {
            return;
        }
        state.bridge.cleanup(&task_ctx.run_id);
        let event = match result {
            Ok(()) => AgentEvent::Done {
                stop_reason: "completed".into(),
            },
            Err(error) => AgentEvent::Error {
                kind: error.kind,
                message: error.message,
            },
        };
        emit(&task_app, &task_ctx.run_id, event);
    });
    state
        .runs
        .lock()
        .expect("agent runs mutex")
        .insert(run_id.clone(), Run { task, context: ctx });
    let _ = start.send(());
    Ok(StartRunResponse { run_id })
}
#[tauri::command]
pub fn agent_cancel_run(app: tauri::AppHandle, run_id: String, state: State<'_, AgentState>) {
    let run = state.runs.lock().expect("agent runs mutex").remove(&run_id);
    if let Some(run) = run {
        run.task.abort();
        state.bridge.cleanup(&run_id);
        emit(
            &app,
            &run_id,
            AgentEvent::Done {
                stop_reason: "cancelled".into(),
            },
        );
    }
}
#[tauri::command]
pub fn agent_tool_respond(
    request_id: String,
    ok: bool,
    output: String,
    state: State<'_, AgentState>,
) {
    state
        .bridge
        .respond(&request_id, tools::ToolOutput { ok, text: output });
}

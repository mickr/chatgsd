pub mod antigravity;
mod bridge;
pub mod codex;
mod compaction;
mod computer;
pub mod computer_permissions;
pub mod conversations;
pub mod events;
pub mod expression;
pub mod note_edits;
pub mod profile;
pub mod projects;
pub mod prompt;
pub mod memory;
pub mod mcp;
mod reading;
pub mod skills;
pub mod skills_sh;
pub mod tools;
mod web;
pub mod webdav;
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
    /// Background writing suggestions can only read the current document.
    pub read_only: bool,
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
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceTierInfo {
    pub id: String,
    pub name: String,
    pub description: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub efforts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub service_tiers: Vec<ServiceTierInfo>,
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
    #[serde(default)]
    effort: Option<String>,
    #[serde(default)]
    service_tier: Option<String>,
    ui_guide: String,
    session_id: Option<String>,
    prompt: String,
    #[serde(default)]
    read_only: bool,
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
    cancel: Option<tokio::sync::oneshot::Sender<()>>,
    context: RunContext,
    /// Messages the user sends while the run works reach it here.
    steer: tokio::sync::mpsc::UnboundedSender<String>,
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
    codex::status(&app).await
}
#[tauri::command]
pub async fn agent_list_models(
    app: tauri::AppHandle,
    include_antigravity: Option<bool>,
) -> Result<Vec<ModelInfo>, String> {
    let mut models = Vec::new();
    let mut errors = Vec::new();
    match codex::list_models(&app).await {
        Ok(list) => models.extend(list),
        Err(error) => errors.push(error),
    }
    if include_antigravity.unwrap_or(false) {
        match antigravity::list_models(&app).await {
            Ok(list) => models.extend(list),
            Err(error) => errors.push(error),
        }
    }
    if models.is_empty() {
        if let Some(error) = errors.into_iter().next() {
            return Err(error);
        }
    }
    Ok(models)
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
/// The file behind the open document: a note in the notes folder, or a
/// linked project's file by its `project:` ID (open in its own window).
pub(crate) async fn document_path(app: &tauri::AppHandle, notes_folder: &std::path::Path, note_id: &str) -> Result<PathBuf, String> {
    if note_id.starts_with(projects::ID_PREFIX) {
        projects::note_path(app, note_id).await
    } else {
        crate::abs_path_from_id(notes_folder, note_id)
    }
}
pub(super) async fn check_memory_folder(app: &tauri::AppHandle, expected: &std::path::Path) -> Result<(), String> {
    let expected = tokio::fs::canonicalize(expected).await.map_err(|e| e.to_string())?;
    if notes_folder(app).await? != expected { return Err("The notes folder changed.".into()); }
    Ok(())
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
    document_path(&app, &notes_folder, &request.context.note_id).await?;
    let run_id = uuid::Uuid::new_v4().to_string();
    let ctx = RunContext {
        run_id: run_id.clone(),
        note_id: request.context.note_id,
        note_title: request.context.note_title,
        selection: request.context.selection,
        read_only: request.read_only,
        computer_access: request.computer_access && !request.read_only,
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
    let model = request.model.filter(|m| !m.is_empty());
    let effort = request.effort.filter(|e| !e.is_empty());
    let service_tier = request.service_tier.filter(|tier| !tier.is_empty());
    let use_antigravity = antigravity::is_model(model.as_deref());
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    // The gate ensures tools cannot arrive before the run and its context are registered.
    let (start, ready) = tokio::sync::oneshot::channel();
    let (steer, steered) = tokio::sync::mpsc::unbounded_channel();
    let task = tauri::async_runtime::spawn(async move {
        if ready.await.is_err() {
            return;
        }
        let result = if use_antigravity {
            antigravity::run(
                task_app.clone(),
                task_ctx.clone(),
                model,
                effort,
                request.session_id,
                request.prompt,
                cancel_rx,
            )
            .await
        } else {
            codex::run(
                task_app.clone(),
                task_ctx.clone(),
                codex::TurnOptions {
                    model,
                    effort,
                    service_tier,
                },
                request.session_id,
                request.prompt,
                steered,
            )
            .await
        };
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
        .insert(
            run_id.clone(),
            Run {
                task,
                cancel: use_antigravity.then_some(cancel_tx),
                context: ctx,
                steer,
            },
        );
    let _ = start.send(());
    Ok(StartRunResponse { run_id })
}
/// Hands the working agent a message from the user without stopping it. The
/// run delivers it between steps, or as its next turn if this one just ended.
#[tauri::command]
pub fn agent_steer_run(run_id: String, text: String, state: State<'_, AgentState>) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Enter a message first".into());
    }
    let finished = || "The agent has already finished. Send this as a new message.".to_owned();
    let runs = state.runs.lock().expect("agent runs mutex");
    let run = runs.get(&run_id).ok_or_else(finished)?;
    if run.context.read_only {
        return Err("A background check can't be steered".into());
    }
    run.steer.send(text.to_owned()).map_err(|_| finished())
}
#[tauri::command]
pub fn agent_cancel_run(app: tauri::AppHandle, run_id: String, state: State<'_, AgentState>) {
    let run = state.runs.lock().expect("agent runs mutex").remove(&run_id);
    if let Some(run) = run {
        if let Some(cancel) = run.cancel {
            let _ = cancel.send(());
        } else {
            run.task.abort();
        }
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

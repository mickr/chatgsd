use super::{skills::SkillOffer, AgentErrorKind};
use serde::Serialize;
use serde_json::Value;
use tauri::Emitter;

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    Session {
        session_id: String,
    },
    TextDelta {
        text: String,
    },
    ToolCall {
        call_id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        call_id: String,
        ok: bool,
        output: String,
    },
    /// A skill found on the web, for the user to review and save from a card.
    SkillOffer(SkillOffer),
    Done {
        stop_reason: String,
    },
    Error {
        kind: AgentErrorKind,
        message: String,
    },
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventEnvelope<'a> {
    run_id: &'a str,
    event: AgentEvent,
}

pub fn emit(app: &tauri::AppHandle, run_id: &str, event: AgentEvent) {
    let _ = app.emit("agent:event", EventEnvelope { run_id, event });
}
/// Responses may qualify a namespaced function as `scratch.<tool>`.
pub fn canonical_tool_name(raw: &str) -> &str {
    raw.strip_prefix("scratch.").unwrap_or(raw)
}

use super::{expression::ExpressionUpdate, skills::SkillOffer, AgentErrorKind};
use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Emitter;

static NEXT_EVENT_SEQ: AtomicU64 = AtomicU64::new(1);

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
    ComputerUnavailable {
        message: String,
        permissions: Vec<super::computer_permissions::ComputerPermission>,
    },
    TextDelta {
        text: String,
    },
    /// Streamed reasoning / thinking summary from Codex or Antigravity.
    ThinkingDelta {
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
    Expression(ExpressionUpdate),
    /// A skill found on the web, for the user to review and save from a card.
    SkillOffer(SkillOffer),
    /// Live status update from a coordinated subagent / swarm worker.
    Subagent(super::subagents::SubagentEvent),
    /// The run's whole swarm board after a post, shown on its newest swarm card.
    SwarmBoard {
        entries: Vec<super::subagents::SwarmNote>,
    },
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
    seq: u64,
    event: AgentEvent,
}

pub fn emit(app: &tauri::AppHandle, run_id: &str, event: AgentEvent) {
    let seq = NEXT_EVENT_SEQ.fetch_add(1, Ordering::Relaxed);
    let _ = app.emit("agent:event", EventEnvelope { run_id, seq, event });
}
/// Responses may qualify a namespaced function as `scratch.<tool>` or `mcp_scratch_<tool>`.
pub fn canonical_tool_name(raw: &str) -> &str {
    raw.strip_prefix("scratch.")
        .or_else(|| raw.strip_prefix("mcp_scratch_"))
        .unwrap_or(raw)
}

#[cfg(test)]
mod tests {
    use super::{AgentEvent, EventEnvelope};
    use crate::agent::expression::{Expression, ExpressionUpdate};
    use serde_json::json;

    #[test]
    fn expression_event_preserves_run_scope_and_wire_fields() {
        let envelope = EventEnvelope {
            run_id: "current-run",
            seq: 1,
            event: AgentEvent::Expression(ExpressionUpdate {
                expression: Expression::Curious,
                sentiment: 0.25,
                intensity: 0.75,
            }),
        };

        assert_eq!(
            serde_json::to_value(envelope).unwrap(),
            json!({
                "runId": "current-run",
                "seq": 1,
                "event": {
                    "type": "expression",
                    "expression": "curious",
                    "sentiment": 0.25,
                    "intensity": 0.75
                }
            })
        );
    }

    #[test]
    fn thinking_delta_serializes_with_expected_wire_fields() {
        let envelope = EventEnvelope {
            run_id: "current-run",
            seq: 2,
            event: AgentEvent::ThinkingDelta {
                text: "Checking the draft structure.".into(),
            },
        };
        assert_eq!(
            serde_json::to_value(envelope).unwrap(),
            json!({
                "runId": "current-run",
                "seq": 2,
                "event": {
                    "type": "thinking_delta",
                    "text": "Checking the draft structure."
                }
            })
        );
    }
}

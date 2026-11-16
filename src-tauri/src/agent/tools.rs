use super::{events::canonical_tool_name, AgentState};
use serde_json::{json, Value};
use tauri::Manager;

pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: Value,
}
pub fn catalog() -> Vec<ToolSpec> {
    vec![
        ToolSpec { name: "read_document", description: "Read the current live note and selection. Always call before editing.", parameters: json!({"type":"object","properties":{},"required":[],"additionalProperties":false}) },
        // Bounds live in the description and the executor: Responses strict mode rejects
        // some JSON Schema validation keywords (minLength and friends).
        ToolSpec { name: "edit_document", description: "Apply 1 to 20 precise replacements atomically, in order. Each old_text must be nonempty and match exactly once in the markdown from read_document; include surrounding text to make it unique. Preserve unchanged markdown.", parameters: json!({"type":"object","properties":{"edits":{"type":"array","items":{"type":"object","properties":{"old_text":{"type":"string"},"new_text":{"type":"string"}},"required":["old_text","new_text"],"additionalProperties":false}}},"required":["edits"],"additionalProperties":false}) },
        ToolSpec { name: "replace_selection", description: "Replace the selection captured when the user sent their message.", parameters: json!({"type":"object","properties":{"new_text":{"type":"string"}},"required":["new_text"],"additionalProperties":false}) },
        ToolSpec { name: "search_notes", description: "Search other notes in the workspace. Returns the top eight results.", parameters: json!({"type":"object","properties":{"query":{"type":"string"}},"required":["query"],"additionalProperties":false}) },
        ToolSpec { name: "read_note", description: "Read the markdown of another workspace note by its ID.", parameters: json!({"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}) },
    ]
}
pub struct ToolOutput {
    pub ok: bool,
    pub text: String,
}
impl ToolOutput {
    pub fn error(text: impl Into<String>) -> Self {
        Self {
            ok: false,
            text: text.into(),
        }
    }
}
pub async fn execute(app: &tauri::AppHandle, run_id: &str, name: &str, args: Value) -> ToolOutput {
    let name = canonical_tool_name(name);
    let state = app.state::<AgentState>();
    let Some(ctx) = state.context(run_id) else {
        return ToolOutput::error("This agent run has ended");
    };
    match name {
        "read_document" | "edit_document" | "replace_selection" => {
            state.bridge.execute(app, run_id, name, args).await
        }
        "search_notes" => {
            let Some(query) = args.get("query").and_then(Value::as_str) else {
                return ToolOutput::error("query must be a string");
            };
            let current_folder = app
                .state::<crate::AppState>()
                .app_config
                .read()
                .expect("app config lock")
                .notes_folder
                .clone();
            if !is_run_folder(current_folder, &ctx.notes_folder).await {
                return ToolOutput::error("The notes folder changed. Start a new conversation.");
            }
            match crate::search_notes(query.into(), app.state::<crate::AppState>()).await {
                Ok(results) => ToolOutput {
                    ok: true,
                    text: results
                        .into_iter()
                        .take(8)
                        .map(|r| format!("{} — {}: {}", r.id, r.title, r.preview))
                        .collect::<Vec<_>>()
                        .join("\n"),
                },
                Err(error) => ToolOutput::error(error),
            }
        }
        "read_note" => {
            let Some(id) = args
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            else {
                return ToolOutput::error("id must be a nonempty string");
            };
            let path = match crate::abs_path_from_id(&ctx.notes_folder, id) {
                Ok(p) => p,
                Err(e) => return ToolOutput::error(e),
            };
            let canonical = match tokio::fs::canonicalize(path).await {
                Ok(p) => p,
                Err(e) => return ToolOutput::error(format!("Cannot read note: {e}")),
            };
            if !canonical.starts_with(&ctx.notes_folder) {
                return ToolOutput::error("This note is outside the notes folder");
            }
            match tokio::fs::read_to_string(canonical).await {
                Ok(text) => ToolOutput { ok: true, text },
                Err(e) => ToolOutput::error(format!("Cannot read note: {e}")),
            }
        }
        _ => ToolOutput::error(format!("Unknown Scratch tool: {name}")),
    }
}

/// The run stores the canonical notes folder; the config may spell the same
/// folder through a symlink (e.g. /tmp → /private/tmp on macOS).
async fn is_run_folder(configured: Option<String>, run_root: &std::path::Path) -> bool {
    let Some(folder) = configured else {
        return false;
    };
    tokio::fs::canonicalize(folder)
        .await
        .is_ok_and(|path| path == run_root)
}

#[cfg(test)]
mod tests {
    use super::is_run_folder;

    #[cfg(unix)]
    #[tokio::test]
    async fn run_folder_matches_through_a_symlinked_config_path() {
        let base = std::env::temp_dir().join(format!("scratch-run-folder-{}", uuid::Uuid::new_v4()));
        let notes = base.join("notes");
        let link = base.join("linked-notes");
        let other = base.join("other");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::os::unix::fs::symlink(&notes, &link).unwrap();
        let run_root = std::fs::canonicalize(&notes).unwrap();
        let as_config = |path: &std::path::Path| Some(path.to_string_lossy().into_owned());

        let via_symlink = is_run_folder(as_config(&link), &run_root).await;
        let direct = is_run_folder(as_config(&notes), &run_root).await;
        let different = is_run_folder(as_config(&other), &run_root).await;
        let unset = is_run_folder(None, &run_root).await;
        std::fs::remove_dir_all(&base).unwrap();

        assert!(via_symlink, "a symlinked config path names the same folder");
        assert!(direct);
        assert!(!different, "a different folder must still be rejected");
        assert!(!unset);
    }
}

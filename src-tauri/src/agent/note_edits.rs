//! Edits to notes other than the open one. The agent writes them directly using
//! compare-and-swap against the saved note; conflicting writes are rejected.
//! The open note uses direct transactions in the live editor.
use super::{tools::ToolOutput, workspace, RunContext};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MAX_EDITS: usize = 20;

#[derive(Deserialize)]
struct NoteEdit {
    pub old_text: String,
    pub new_text: String,
}

/// Applies edits in order. Each `old_text` must match exactly once in the text
/// as the earlier edits left it, so an edit can never land somewhere unintended.
fn apply(content: &str, edits: &[NoteEdit]) -> Result<String, String> {
    if edits.is_empty() || edits.len() > MAX_EDITS {
        return Err(format!("edits must list 1 to {MAX_EDITS} replacements"));
    }
    let mut text = content.to_owned();
    for (index, edit) in edits.iter().enumerate() {
        let number = index + 1;
        if edit.old_text.is_empty() {
            return Err(format!("Edit {number}: old_text must not be empty"));
        }
        let mut matches = text.match_indices(&edit.old_text).map(|(start, _)| start);
        let start = match (matches.next(), matches.next()) {
            (Some(start), None) => start,
            (None, _) => return Err(format!("Edit {number}: old_text isn't in the note")),
            (Some(_), Some(_)) => {
                return Err(format!(
                    "Edit {number}: old_text matches more than once; include more surrounding text"
                ))
            }
        };
        let end = start + edit.old_text.len();
        text.replace_range(start..end, &edit.new_text);
    }
    Ok(text)
}


/// Applies edits directly with compare-and-swap against the saved note.
/// Conflicting writes are rejected with an error message.
pub async fn apply_note_edit(ctx: &RunContext, args: &Value) -> ToolOutput {
    let Some(id) = args.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) else {
        return ToolOutput::error("id must be a note ID");
    };
    if id == ctx.note_id {
        return ToolOutput::error(
            "This is the open note. Use edit_document to edit it live.",
        );
    }
    let summary = args.get("summary").and_then(Value::as_str).unwrap_or("").trim();
    let edits: Vec<NoteEdit> = match args.get("edits").cloned().map(serde_json::from_value) {
        Some(Ok(edits)) => edits,
        _ => return ToolOutput::error("edits must be a list of {old_text, new_text}"),
    };
    let path = match workspace::note_path(&ctx.notes_folder, id).await {
        Ok(path) => path,
        Err(error) => return ToolOutput::error(error),
    };
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(error) => return ToolOutput::error(error.to_string()),
    };
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let content = match String::from_utf8(bytes) {
        Ok(content) => content,
        Err(error) => return ToolOutput::error(error.to_string()),
    };
    let updated = match apply(&content, &edits) {
        Ok(updated) if updated == content => return ToolOutput::error("These edits don't change the note"),
        Ok(updated) => updated,
        Err(error) => return ToolOutput::error(error),
    };
    match crate::checked_write(&path, &path, &updated, Some(&hash)).await {
        Ok(None) => ToolOutput::ok(json!({
            "id": id,
            "title": crate::extract_title(&updated),
            "summary": summary,
            "editsApplied": edits.len(),
        }).to_string()),
        Ok(Some(_)) => ToolOutput::error("The note changed while saving. Read it again before editing."),
        Err(error) => ToolOutput::error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn edit(old_text: &str, new_text: &str) -> NoteEdit {
        NoteEdit { old_text: old_text.into(), new_text: new_text.into() }
    }

    #[test]
    fn applies_ordered_edits_and_refuses_ambiguous_matches() {
        assert_eq!(apply("Rain jacket", &[edit("Rain jacket", "Rain coat"), edit("coat", "boots")]).unwrap(), "Rain boots");
        assert!(apply("Tea. Tea.", &[edit("Tea", "Coffee")]).is_err());
        assert!(apply("Tea", &[edit("Coffee", "Water")]).is_err());
        assert!(apply("Tea", &[edit("", "Water")]).is_err());
        assert!(apply("Tea", &[]).is_err());
        assert_eq!(apply("Tea", &[edit("Tea", "")]).unwrap(), "");
    }

    struct Workspace(PathBuf);
    impl Workspace {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("scratch-edit-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            std::fs::write(path.join("Plan.md"), "# Plan\n\nPack a jacket.\n").unwrap();
            Self(std::fs::canonicalize(path).unwrap())
        }
        fn context(&self) -> RunContext {
            RunContext {
                run_id: "test".into(), note_id: "Open".into(), note_title: "Open".into(),
                selection: None, read_only: false, computer_access: false, web_access: false, research_model: None,
                research_brief: None, notes_folder: self.0.clone(), ui_guide: String::new(), skill: None,
                model: None, service_tier: None,
            }
        }
    }
    impl Drop for Workspace {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    #[tokio::test]
    async fn writes_only_the_run_workspace_and_rejects_open_or_changed_text() {
        let workspace = Workspace::new();
        let other = Workspace::new();
        let args = json!({"id":"Plan","summary":"Pack boots","edits":[{"old_text":"jacket","new_text":"boots"}]});
        let result = apply_note_edit(&workspace.context(), &args).await;
        assert!(result.ok, "{}", result.text);
        assert_eq!(std::fs::read_to_string(workspace.0.join("Plan.md")).unwrap(), "# Plan\n\nPack a boots.\n");
        assert_eq!(std::fs::read_to_string(other.0.join("Plan.md")).unwrap(), "# Plan\n\nPack a jacket.\n");
        assert!(!apply_note_edit(&workspace.context(), &args).await.ok);
        let mut ctx = other.context();
        ctx.note_id = "Plan".into();
        assert!(!apply_note_edit(&ctx, &args).await.ok);
        assert_eq!(std::fs::read_to_string(other.0.join("Plan.md")).unwrap(), "# Plan\n\nPack a jacket.\n");
    }

    #[tokio::test]
    async fn refuses_invalid_utf8_without_changing_the_file() {
        let workspace = Workspace::new();
        let path = workspace.0.join("Plan.md");
        std::fs::write(&path, [0xff, 0xfe]).unwrap();
        let result = apply_note_edit(&workspace.context(), &json!({
            "id":"Plan","edits":[{"old_text":"x","new_text":"y"}]
        })).await;
        assert!(!result.ok);
        assert_eq!(std::fs::read(path).unwrap(), [0xff, 0xfe]);
    }
}

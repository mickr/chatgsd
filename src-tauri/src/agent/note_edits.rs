//! Edits to notes other than the open one. The agent proposes them, the user
//! approves each in the panel, and only then is the file written. The open
//! note keeps its own path: tracked changes in the live editor.
use super::{tools::ToolOutput, workspace, AgentState, RunContext};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;

const MAX_EDITS: usize = 20;
/// How much of the surrounding line a preview shows on each side of an edit.
const CONTEXT_CHARS: usize = 80;

#[derive(Clone, Deserialize, Serialize)]
pub struct NoteEdit {
    pub old_text: String,
    pub new_text: String,
}

/// One edit as the user reviews it: the replaced text in its line.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditPreview {
    before: String,
    removed: String,
    added: String,
    after: String,
}

/// Applies edits in order. Each `old_text` must match exactly once in the text
/// as the earlier edits left it, so an edit can never land somewhere unintended.
pub fn apply(content: &str, edits: &[NoteEdit]) -> Result<(String, Vec<EditPreview>), String> {
    if edits.is_empty() || edits.len() > MAX_EDITS {
        return Err(format!("edits must list 1 to {MAX_EDITS} replacements"));
    }
    let mut text = content.to_owned();
    let mut previews = Vec::with_capacity(edits.len());
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
        previews.push(EditPreview {
            before: line_before(&text[..start]),
            removed: edit.old_text.clone(),
            added: edit.new_text.clone(),
            after: line_after(&text[end..]),
        });
        text.replace_range(start..end, &edit.new_text);
    }
    Ok((text, previews))
}

fn line_before(text: &str) -> String {
    let line = text.rsplit('\n').next().unwrap_or("");
    let count = line.chars().count();
    if count <= CONTEXT_CHARS {
        return line.to_owned();
    }
    let tail: String = line.chars().skip(count - CONTEXT_CHARS).collect();
    format!("…{tail}")
}

fn line_after(text: &str) -> String {
    let line = text.split('\n').next().unwrap_or("");
    if line.chars().count() <= CONTEXT_CHARS {
        return line.to_owned();
    }
    let head: String = line.chars().take(CONTEXT_CHARS).collect();
    format!("{head}…")
}

/// Validates the proposal against the note as saved now, then waits for the
/// user's decision; the panel applies an approved edit and reports back.
pub async fn propose(app: &tauri::AppHandle, run_id: &str, ctx: &RunContext, args: &Value) -> ToolOutput {
    let Some(id) = args.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) else {
        return ToolOutput::error("id must be a note ID");
    };
    if id == ctx.note_id {
        return ToolOutput::error(
            "This is the open note. Use edit_document; its edits show up in the note for review.",
        );
    }
    let summary = args.get("summary").and_then(Value::as_str).unwrap_or("").trim();
    let edits: Vec<NoteEdit> = match args.get("edits").cloned().map(serde_json::from_value) {
        Some(Ok(edits)) => edits,
        _ => return ToolOutput::error("edits must be a list of {old_text, new_text}"),
    };
    let content = match read(ctx, id).await {
        Ok(content) => content,
        Err(error) => return ToolOutput::error(error),
    };
    let preview = match apply(&content, &edits) {
        Ok((updated, _)) if updated == content => {
            return ToolOutput::error("These edits don't change the note")
        }
        Ok((_, preview)) => preview,
        Err(error) => return ToolOutput::error(error),
    };
    let request = json!({
        "id": id,
        "title": crate::extract_title(&content),
        "summary": summary,
        "edits": edits,
        "preview": preview,
    });
    // Waits for the user, however long they take; Stop cancels the run.
    app.state::<AgentState>()
        .bridge
        .execute(app, run_id, "edit_note", request, None)
        .await
}

async fn read(ctx: &RunContext, id: &str) -> Result<String, String> {
    let path = workspace::note_path(&ctx.notes_folder, id).await?;
    tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())
}

/// Writes an approved edit. The edits are re-applied to the note as it is now,
/// so text the user changed since the proposal is kept or the edit is refused,
/// and the write itself is compare-and-swap against what was read.
#[tauri::command]
pub async fn agent_apply_note_edit(app: tauri::AppHandle, note_id: String, edits: Vec<NoteEdit>) -> Result<(), String> {
    let folder = super::notes_folder(&app).await?;
    let path = workspace::note_path(&folder, &note_id).await?;
    let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let content = String::from_utf8(bytes).map_err(|e| e.to_string())?;
    let (updated, _) =
        apply(&content, &edits).map_err(|error| format!("The note changed since this was proposed. {error}."))?;
    match crate::checked_write(&path, &path, &updated, Some(&hash)).await? {
        None => Ok(()),
        Some(_) => Err("The note changed while saving. Ask ChatGPT to try again.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(old_text: &str, new_text: &str) -> NoteEdit {
        NoteEdit {
            old_text: old_text.into(),
            new_text: new_text.into(),
        }
    }

    #[test]
    fn applies_in_order_with_line_context() {
        let note = "# Packing\n\n- Rain jacket\n- Passport\n";
        let (updated, preview) = apply(
            note,
            &[edit("Rain jacket", "Rain jacket and umbrella"), edit("- Passport\n", "- Passport\n- Power bank\n")],
        )
        .unwrap();
        assert_eq!(updated, "# Packing\n\n- Rain jacket and umbrella\n- Passport\n- Power bank\n");
        assert_eq!(preview[0].before, "- ");
        assert_eq!(preview[0].after, "");
        assert_eq!(preview[1].before, "");
    }

    #[test]
    fn refuses_missing_ambiguous_and_empty_matches() {
        let note = "Tea. Tea.";
        assert!(apply(note, &[edit("Coffee", "Tea")]).unwrap_err().contains("isn't in the note"));
        assert!(apply(note, &[edit("Tea", "Coffee")]).unwrap_err().contains("more than once"));
        assert!(apply(note, &[edit("", "x")]).is_err());
        assert!(apply(note, &[]).is_err());
    }

    #[test]
    fn long_lines_are_trimmed_around_the_edit() {
        let note = format!("{}MARK{}", "a".repeat(200), "b".repeat(200));
        let (_, preview) = apply(&note, &[edit("MARK", "mark")]).unwrap();
        assert!(preview[0].before.starts_with('…'));
        assert_eq!(preview[0].before.chars().count(), CONTEXT_CHARS + 1);
        assert!(preview[0].after.ends_with('…'));
    }
}

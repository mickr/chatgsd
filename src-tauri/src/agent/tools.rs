use super::{
    events::{canonical_tool_name, emit, AgentEvent},
    note_edits, reading, skills, web, workspace, AgentState, RunContext,
};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::Manager;

/// Editor tools answer within milliseconds; a longer wait means the editor is gone.
const EDITOR_TOOL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_NOTES_PER_READ: usize = 5;
const DEFAULT_LIST_LIMIT: u64 = 30;
const MAX_LIST_LIMIT: u64 = 100;
const SEARCH_RESULT_LIMIT: usize = 8;

/// Increment when saved native threads need a new dynamic tool catalog.
pub const CATALOG_VERSION: u32 = 1;

pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: Value,
}
/// The agent's tools for one message. Web tools are listed only when the
/// message was sent with internet access on.
pub fn catalog(web_access: bool, read_only: bool) -> Vec<ToolSpec> {
    let mut tools = vec![
        ToolSpec { name: "set_expression", description: "Set the agent face's expressive UI metadata from conversation and task context, not the user's psychological state or task completion. expression is neutral, curious, focused, uncertain, pleased or concerned; sentiment is a number from -1 to 1; intensity is a number from 0 to 1. Use at the start and meaningful shifts alongside useful work, never repetitive animation calls.", parameters: json!({"type":"object","properties":{"expression":{"type":"string","enum":["neutral","curious","focused","uncertain","pleased","concerned"]},"sentiment":{"type":"number"},"intensity":{"type":"number"}},"required":["expression","sentiment","intensity"],"additionalProperties":false}) },
        ToolSpec { name: "read_document", description: "Read the current live note, including unsaved typing, and the user's selection. Always call before editing. Short notes come back whole; a long note comes back as an outline with line numbers and its opening, so pass start_line and end_line (1-based, inclusive, up to 400 lines) to read further. Pass null for both to start.", parameters: json!({"type":"object","properties":{"start_line":{"type":["integer","null"]},"end_line":{"type":["integer","null"]}},"required":["start_line","end_line"],"additionalProperties":false}) },
        ToolSpec { name: "offer_writing_help", description: "Offer one grounded writing interaction without changing the note. Read the live note first. kind rewrite proposes plain-text replacement for quote; question asks one useful question at quote and traces up to three exact passages in argument order; evidence returns source detail for a claim, using only URLs successfully opened by research in this run; move previews moving the entire quoted top-level paragraph immediately BEFORE the entire earlier destination paragraph. quote, destination and trace must copy exact visible plain text from the note (not markdown syntax). explanation is brief. Use null for irrelevant replacement/question/destination; trace and sources are empty when unused. The user can review, edit, accept or dismiss. An offer is not an applied edit. Do not repeat the offer in chat.", parameters: json!({"type":"object","properties":{
            "kind":{"type":"string","enum":["rewrite","question","evidence","move"]},
            "quote":{"type":"string"},"explanation":{"type":"string"},
            "replacement":{"type":["string","null"]},"question":{"type":["string","null"]},"destination":{"type":["string","null"]},
            "trace":{"type":"array","maxItems":3,"items":{"type":"string"}},
            "sources":{"type":"array","maxItems":3,"items":{"type":"object","properties":{"title":{"type":"string"},"url":{"type":"string"},"excerpt":{"type":"string"}},"required":["title","url","excerpt"],"additionalProperties":false}}
        },"required":["kind","quote","explanation","replacement","question","destination","trace","sources"],"additionalProperties":false}) },
        ToolSpec { name: "edit_document", description: "Apply 1 to 20 precise replacements atomically, in order. Each old_text must be nonempty and match exactly once in the markdown from read_document; include surrounding text to make it unique. Preserve unchanged markdown.", parameters: json!({"type":"object","properties":{"edits":{"type":"array","items":{"type":"object","properties":{"old_text":{"type":"string"},"new_text":{"type":"string"}},"required":["old_text","new_text"],"additionalProperties":false}}},"required":["edits"],"additionalProperties":false}) },
        ToolSpec { name: "replace_selection", description: "Replace the selection captured when the user sent their message.", parameters: json!({"type":"object","properties":{"new_text":{"type":"string"}},"required":["new_text"],"additionalProperties":false}) },
        ToolSpec { name: "ask_user", description: "Ask the user one short clarifying question and wait for the answer. Use it when the request is ambiguous in a way that changes what you would write and the answer isn't in this note or other notes. Give 2 to 4 short options when the choices are discrete, or an empty options array for a free-text answer. For a question with several parts or that needs context alongside it, also pass form: a Scratch UI spec {root, elements, state} with inputs bound to /answers/<key>; otherwise form is null.", parameters: json!({"type":"object","properties":{"question":{"type":"string"},"options":{"type":"array","items":{"type":"string"}},"form":{"type":["object","null"]}},"required":["question","options","form"],"additionalProperties":false}) },
        ToolSpec { name: "search_notes", description: "Full-text search across the user's notes. Returns up to eight matches with ID, title, last-modified time and a preview; follow up with read_notes for the full text.", parameters: json!({"type":"object","properties":{"query":{"type":"string"}},"required":["query"],"additionalProperties":false}) },
        ToolSpec { name: "list_notes", description: "List notes to find related context. folder limits to a folder path (\"\" for every note), sort is \"recent\" or \"title\", limit is 1 to 100.", parameters: json!({"type":"object","properties":{"folder":{"type":"string"},"sort":{"type":"string","enum":["recent","title"]},"limit":{"type":"integer"}},"required":["folder","sort","limit"],"additionalProperties":false}) },
        ToolSpec { name: "read_notes", description: "Read the latest saved markdown of 1 to 5 other notes by ID, with each note's title and last-modified time. Long notes come back as an outline and their opening; to read further, pass one ID with start_line and end_line (1-based, inclusive, up to 400 lines), otherwise null. For the open note use read_document instead.", parameters: json!({"type":"object","properties":{"ids":{"type":"array","items":{"type":"string"}},"start_line":{"type":["integer","null"]},"end_line":{"type":["integer","null"]}},"required":["ids","start_line","end_line"],"additionalProperties":false}) },
        ToolSpec { name: "find_in_note", description: "Find the lines of one note that contain some text (case-insensitive), with line numbers, to jump around long notes. id \"\" means the open note, including unsaved typing.", parameters: json!({"type":"object","properties":{"id":{"type":"string"},"query":{"type":"string"}},"required":["id","query"],"additionalProperties":false}) },
        ToolSpec { name: "edit_note", description: "Apply 1 to 20 precise replacements atomically to another note (not the open one; use edit_document for that). Each old_text must be nonempty and match exactly once in that note as read with read_notes, applied in order. Conflicting writes (if the note changed since it was read) are rejected with an error. summary is one short sentence saying what changes and why.", parameters: json!({"type":"object","properties":{"id":{"type":"string"},"summary":{"type":"string"},"edits":{"type":"array","items":{"type":"object","properties":{"old_text":{"type":"string"},"new_text":{"type":"string"}},"required":["old_text","new_text"],"additionalProperties":false}}},"required":["id","summary","edits"],"additionalProperties":false}) },
        ToolSpec { name: "note_links", description: "Show a note's [[wikilinks]] and the notes that link back to it. id \"\" means the open note.", parameters: json!({"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}) },
        ToolSpec { name: "read_skill", description: "Load one of the user's installed skills by name before doing a task its description covers. Returns the skill's full instructions; follow them for that task. A skill may list files that came with it: pass file to read one, otherwise null.", parameters: json!({"type":"object","properties":{"name":{"type":"string"},"file":{"type":["string","null"]}},"required":["name","file"],"additionalProperties":false}) },
    ];
    if web_access {
        tools.extend([
            ToolSpec { name: "research", description: "Ask the research assistant to search and read the web, then report what it found with source URLs. Use it for documentation, current facts and anything the notes don't contain. It sees neither the notes nor this conversation, so question must stand on its own: say exactly what you need, name the product and version, and include a URL when the user gave one. Can take a minute.", parameters: json!({"type":"object","properties":{"question":{"type":"string"}},"required":["question"],"additionalProperties":false}) },
            ToolSpec { name: "offer_skill", description: "Show the user a card offering to save a skill from the web, given the URL of its SKILL.md. research lists the skills published by the sites it consulted. Offer a skill only when it fits what the user is working on, and only once. The user decides on the card; this returns right away.", parameters: json!({"type":"object","properties":{"url":{"type":"string"}},"required":["url"],"additionalProperties":false}) },
        ]);
    }
    if read_only { tools.retain(|tool| companion_tool(tool.name)); }
    tools
}

/// Suggestions can offer help and research within the run's internet setting.
/// They cannot edit, ask blocking questions, or access other notes/apps.
fn companion_tool(name: &str) -> bool {
    matches!(name, "read_document" | "set_expression" | "offer_writing_help" | "research")
}
pub struct ToolOutput {
    pub ok: bool,
    pub text: String,
}
impl ToolOutput {
    pub fn ok(text: impl Into<String>) -> Self {
        Self {
            ok: true,
            text: text.into(),
        }
    }
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
    if ctx.read_only && !companion_tool(name) {
        return ToolOutput::error("Writing check-ins can only read the current note, research when enabled, and offer a suggestion.");
    }
    let range = (line_arg(&args, "start_line"), line_arg(&args, "end_line"));
    match name {
        "read_document" => match live_note(app, run_id).await {
            Ok(note) => ToolOutput::ok(format!(
                "{}\n---\n{}",
                note.header,
                reading::view(&note.markdown, range.0, range.1)
            )),
            Err(error) => error,
        },
        "edit_document" | "replace_selection" | "offer_writing_help" => {
            state
                .bridge
                .execute(app, run_id, name, args, Some(EDITOR_TOOL_TIMEOUT))
                .await
        }
        // Waits for the user, however long they take; Stop cancels the run.
        "ask_user" => state.bridge.execute(app, run_id, name, args, None).await,
        "search_notes" | "list_notes" | "read_notes" | "note_links" | "find_in_note" | "edit_note" => {
            if let Err(error) = ensure_run_folder(app, &ctx).await {
                return error;
            }
            match name {
                "search_notes" => search_notes(app, &args).await,
                "list_notes" => list_notes(app, &ctx, &args).await,
                "read_notes" => read_notes(&ctx, &args, range).await,
                "find_in_note" => find_in_note(app, run_id, &ctx, &args).await,
                "edit_note" => note_edits::apply_note_edit(&ctx, &args).await,
                _ => note_links(app, run_id, &ctx, &args).await,
            }
        }
        "set_expression" => match super::expression::ExpressionUpdate::from_args(args) {
            Ok(update) => {
                emit(app, run_id, AgentEvent::Expression(update));
                ToolOutput::ok("Expression updated.")
            }
            Err(error) => ToolOutput::error(error),
        },
        "read_skill" => match args.get("name").and_then(Value::as_str) {
            Some(skill) => match skills::read(app, skill, args.get("file").and_then(Value::as_str)).await {
                Ok(text) => ToolOutput::ok(text),
                Err(error) => ToolOutput::error(error),
            },
            None => ToolOutput::error("name must be a string"),
        },
        "offer_skill" if ctx.web_access => offer_skill(app, run_id, &args).await,
        "offer_skill" => ToolOutput::error("Internet access is off for this message"),
        _ => ToolOutput::error(format!("Unknown Scratch tool: {name}")),
    }
}

/// Fetches and checks the skill, then shows the user its card. Saving is theirs.
async fn offer_skill(app: &tauri::AppHandle, run_id: &str, args: &Value) -> ToolOutput {
    let Some(address) = args.get("url").and_then(Value::as_str) else {
        return ToolOutput::error("url must be a string");
    };
    // The agent has only the address; hold the download to what its index published.
    let published = web::http_url(address)
        .map(|url| web::listed_digests(url.as_str()))
        .unwrap_or_default();
    let offer = match skills::fetch_offer(web::PUBLIC, address, &published).await {
        Ok(offer) => offer,
        Err(error) => return ToolOutput::error(error),
    };
    let name = offer.name.clone();
    if skills::is_installed(app, &offer).await {
        return ToolOutput::ok(format!(
            "The skill {name:?} is already installed. Load it with read_skill when it applies."
        ));
    }
    emit(app, run_id, AgentEvent::SkillOffer(offer));
    ToolOutput::ok(format!(
        "The user now sees a card offering to save the skill {name:?}. The choice is theirs: don't describe the card or ask again in your reply."
    ))
}

fn line_arg(args: &Value, key: &str) -> Option<usize> {
    args.get(key)
        .and_then(Value::as_u64)
        .filter(|line| *line > 0)
        .map(|line| line as usize)
}

/// The open note as the editor has it now, unsaved typing included.
struct LiveNote {
    /// The title and selection lines read_document reports above the text.
    header: String,
    markdown: String,
}

async fn live_note(app: &tauri::AppHandle, run_id: &str) -> Result<LiveNote, ToolOutput> {
    let live = app
        .state::<AgentState>()
        .bridge
        .execute(app, run_id, "read_document", json!({}), Some(EDITOR_TOOL_TIMEOUT))
        .await;
    if !live.ok {
        return Err(live);
    }
    let (header, markdown) = live.text.split_once("\n---\n").unwrap_or((&live.text, ""));
    Ok(LiveNote {
        header: header.to_owned(),
        markdown: markdown.to_owned(),
    })
}

async fn find_in_note(app: &tauri::AppHandle, run_id: &str, ctx: &RunContext, args: &Value) -> ToolOutput {
    let id = args.get("id").and_then(Value::as_str).unwrap_or("");
    let Some(query) = args.get("query").and_then(Value::as_str) else {
        return ToolOutput::error("query must be a string");
    };
    let markdown = if id.is_empty() || id == ctx.note_id {
        match live_note(app, run_id).await {
            Ok(note) => note.markdown,
            Err(error) => return error,
        }
    } else {
        let path = match workspace::note_path(&ctx.notes_folder, id).await {
            Ok(path) => path,
            Err(error) => return ToolOutput::error(error),
        };
        match tokio::fs::read_to_string(&path).await {
            Ok(content) => content,
            Err(error) => return ToolOutput::error(error.to_string()),
        }
    };
    ToolOutput::ok(reading::find(&markdown, query))
}

async fn ensure_run_folder(app: &tauri::AppHandle, ctx: &RunContext) -> Result<(), ToolOutput> {
    let configured = app
        .state::<crate::AppState>()
        .app_config
        .read()
        .expect("app config lock")
        .notes_folder
        .clone();
    if is_run_folder(configured, &ctx.notes_folder).await {
        Ok(())
    } else {
        Err(ToolOutput::error(
            "The notes folder changed. Start a new conversation.",
        ))
    }
}

async fn search_notes(app: &tauri::AppHandle, args: &Value) -> ToolOutput {
    let Some(query) = args.get("query").and_then(Value::as_str) else {
        return ToolOutput::error("query must be a string");
    };
    match crate::search_notes(query.into(), app.state::<crate::AppState>()).await {
        Ok(results) if results.is_empty() => ToolOutput::ok(format!("No notes match {query:?}.")),
        Ok(results) => ToolOutput::ok(
            results
                .into_iter()
                .take(SEARCH_RESULT_LIMIT)
                .map(|r| {
                    format!(
                        "- {} — {} (modified {}): {}",
                        r.id,
                        r.title,
                        workspace::modified_label(r.modified),
                        r.preview
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        Err(error) => ToolOutput::error(error),
    }
}

async fn list_notes(app: &tauri::AppHandle, ctx: &RunContext, args: &Value) -> ToolOutput {
    let folder = args
        .get("folder")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_matches('/');
    let by_title = args.get("sort").and_then(Value::as_str) == Some("title");
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .filter(|limit| *limit > 0)
        .unwrap_or(DEFAULT_LIST_LIMIT)
        .min(MAX_LIST_LIMIT) as usize;
    let mut notes = match workspace::load(app, &ctx.notes_folder).await {
        Ok(notes) => notes,
        Err(error) => return ToolOutput::error(error),
    };
    let prefix = format!("{folder}/");
    notes.retain(|note| folder.is_empty() || note.id.starts_with(&prefix));
    if by_title {
        notes.sort_by_key(|note| note.title.to_lowercase());
    } else {
        notes.sort_by_key(|note| std::cmp::Reverse(note.modified));
    }
    if notes.is_empty() {
        return ToolOutput::ok(if folder.is_empty() {
            "There are no notes.".to_string()
        } else {
            format!("No notes in {folder:?}.")
        });
    }
    let lines: Vec<String> = notes
        .iter()
        .take(limit)
        .map(|note| {
            let open = if note.id == ctx.note_id { " [open]" } else { "" };
            format!(
                "- {} — {} (modified {}){open}",
                note.id,
                note.title,
                workspace::modified_label(note.modified)
            )
        })
        .collect();
    ToolOutput::ok(format!(
        "Showing {} of {} notes.\n{}",
        lines.len(),
        notes.len(),
        lines.join("\n")
    ))
}

async fn read_notes(ctx: &RunContext, args: &Value, range: (Option<usize>, Option<usize>)) -> ToolOutput {
    let ids: Vec<&str> = args
        .get("ids")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .filter(|id| !id.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if ids.is_empty() || ids.len() > MAX_NOTES_PER_READ {
        return ToolOutput::error(format!("ids must list 1 to {MAX_NOTES_PER_READ} note IDs"));
    }
    if ids.len() > 1 && (range.0.is_some() || range.1.is_some()) {
        return ToolOutput::error("Line ranges work with one note at a time");
    }
    let mut sections = Vec::with_capacity(ids.len());
    let mut any_read = false;
    for id in ids {
        match read_saved_note(ctx, id, range).await {
            Ok(section) => {
                any_read = true;
                sections.push(section);
            }
            Err(error) => sections.push(format!("## {id}\nCould not read: {error}")),
        }
    }
    ToolOutput {
        ok: any_read,
        text: sections.join("\n\n"),
    }
}

async fn read_saved_note(ctx: &RunContext, id: &str, range: (Option<usize>, Option<usize>)) -> Result<String, String> {
    if id == ctx.note_id {
        return Ok(format!(
            "## {}\nID: {id}\nThis is the open note. Use read_document for its live version, including unsaved typing.",
            ctx.note_title
        ));
    }
    let canonical = workspace::note_path(&ctx.notes_folder, id).await?;
    let content = tokio::fs::read_to_string(&canonical)
        .await
        .map_err(|e| e.to_string())?;
    let modified = tokio::fs::metadata(&canonical)
        .await
        .map(|metadata| workspace::modified_secs(&metadata))
        .unwrap_or(0);
    Ok(format!(
        "## {}\nID: {id}\nModified: {}\n{}",
        crate::extract_title(&content),
        workspace::modified_label(modified),
        reading::view(&content, range.0, range.1)
    ))
}

async fn note_links(
    app: &tauri::AppHandle,
    run_id: &str,
    ctx: &RunContext,
    args: &Value,
) -> ToolOutput {
    let requested = args.get("id").and_then(Value::as_str).unwrap_or("");
    let notes = match workspace::load(app, &ctx.notes_folder).await {
        Ok(notes) => notes,
        Err(error) => return ToolOutput::error(error),
    };
    let (id, title, content) = if requested.is_empty() || requested == ctx.note_id {
        // The open note's live text, so links typed but not yet saved count.
        let live = match live_note(app, run_id).await {
            Ok(live) => live,
            Err(error) => return error,
        };
        let title = live
            .header
            .lines()
            .next()
            .and_then(|line| line.strip_prefix("Note: "))
            .unwrap_or(&ctx.note_title)
            .to_string();
        (ctx.note_id.clone(), title, live.markdown)
    } else {
        match notes.iter().find(|note| note.id == requested) {
            Some(note) => (note.id.clone(), note.title.clone(), note.content.clone()),
            None => {
                return ToolOutput::error(
                    "No note has this ID. Use list_notes or search_notes to find IDs.",
                )
            }
        }
    };
    let outgoing: Vec<String> = workspace::wikilinks(&content)
        .into_iter()
        .map(|link| match workspace::find_by_title(&notes, &link) {
            Some(note) => format!("- [[{link}]] → {}", note.id),
            None => format!("- [[{link}]] → no note with this title yet"),
        })
        .collect();
    let incoming: Vec<String> = workspace::backlinks(&notes, &title, &id)
        .into_iter()
        .map(|note| format!("- {} — {}", note.id, note.title))
        .collect();
    let list = |lines: Vec<String>| {
        if lines.is_empty() {
            "- none".to_string()
        } else {
            lines.join("\n")
        }
    };
    ToolOutput::ok(format!(
        "Links for {title} ({id})\nLinks out:\n{}\nLinked from:\n{}",
        list(outgoing),
        list(incoming)
    ))
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
    use super::{catalog, companion_tool, is_run_folder};

    #[test]
    fn companion_runs_expose_only_current_note_observation() {
        let regular = catalog(true, false);
        let offline = catalog(false, true);
        assert!(!offline.iter().any(|tool| tool.name == "research"));
        assert!(offline.iter().any(|tool| tool.name == "offer_writing_help"));
        let companion = catalog(true, true);
        assert_eq!(companion.iter().map(|tool| tool.name).collect::<Vec<_>>(), ["set_expression", "read_document", "offer_writing_help", "research"]);
        for tool in regular {
            assert_eq!(companion_tool(tool.name), matches!(tool.name, "read_document" | "set_expression" | "offer_writing_help" | "research"));
        }
        for name in ["edit_document", "replace_selection", "edit_note", "ask_user", "read_notes", "cua_click", "unknown"] {
            assert!(!companion_tool(name), "{name} must not run during an unsolicited check-in");
        }
    }

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

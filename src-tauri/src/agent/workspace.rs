//! Read-only view of the notes folder for the agent's context tools. Every call
//! reads the files fresh, so the agent sees other notes' latest saved versions.

use regex::Regex;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use tauri::Manager;

pub struct WorkspaceNote {
    pub id: String,
    pub title: String,
    pub modified: i64,
    pub content: String,
}

pub async fn load(app: &tauri::AppHandle, root: &Path) -> Result<Vec<WorkspaceNote>, String> {
    let ignored = {
        let state = app.state::<crate::AppState>();
        let settings = state.settings.read().expect("settings read lock");
        crate::get_effective_ignored_dirs(&settings)
    };
    let root = root.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || walk(&root, &ignored))
        .await
        .map_err(|e| format!("Cannot read notes: {e}"))
}

fn walk(root: &Path, ignored: &[String]) -> Vec<WorkspaceNote> {
    walkdir::WalkDir::new(root)
        .max_depth(10)
        .into_iter()
        .filter_entry(|entry| crate::is_visible_notes_entry(entry, ignored))
        .flatten()
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| {
            let id = crate::id_from_abs_path(root, entry.path(), ignored)?;
            let content = std::fs::read_to_string(entry.path()).ok()?;
            let modified = modified_secs(&entry.metadata().ok()?);
            Some(WorkspaceNote {
                title: crate::extract_title(&content),
                id,
                modified,
                content,
            })
        })
        .collect()
}

/// Resolves a note ID to its file, refusing anything outside the notes folder
/// (including through symlinks). `root` must be canonical.
pub async fn note_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    let path = crate::abs_path_from_id(root, id)?;
    let canonical = tokio::fs::canonicalize(&path)
        .await
        .map_err(|_| "No note has this ID. Use list_notes or search_notes to find IDs.".to_string())?;
    if canonical.starts_with(root) {
        Ok(canonical)
    } else {
        Err("This note is outside the notes folder".into())
    }
}

pub fn modified_secs(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

pub fn modified_label(secs: i64) -> String {
    chrono::DateTime::from_timestamp(secs, 0)
        .map(|time| {
            time.with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M")
                .to_string()
        })
        .unwrap_or_else(|| "unknown".into())
}

static WIKILINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]]+?)\]\]").expect("valid wikilink pattern"));

/// `[[Title]]` targets in order of first appearance, ignoring fenced code,
/// matching the editor's wikilink syntax.
pub fn wikilinks(markdown: &str) -> Vec<String> {
    let mut in_fence = false;
    let mut links: Vec<String> = Vec::new();
    for line in markdown.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        for capture in WIKILINK.captures_iter(line) {
            let title = capture[1].trim().to_string();
            if !links.iter().any(|link| link.eq_ignore_ascii_case(&title)) {
                links.push(title);
            }
        }
    }
    links
}

/// Resolve a wikilink title the way the editor does: case-insensitive title match.
pub fn find_by_title<'a>(notes: &'a [WorkspaceNote], title: &str) -> Option<&'a WorkspaceNote> {
    notes
        .iter()
        .find(|note| note.title.to_lowercase() == title.to_lowercase())
}

/// Notes other than `target_id` that contain a wikilink to `target_title`.
pub fn backlinks<'a>(
    notes: &'a [WorkspaceNote],
    target_title: &str,
    target_id: &str,
) -> Vec<&'a WorkspaceNote> {
    let target = target_title.to_lowercase();
    notes
        .iter()
        .filter(|note| note.id != target_id)
        .filter(|note| {
            wikilinks(&note.content)
                .iter()
                .any(|link| link.to_lowercase() == target)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: &str, title: &str, content: &str) -> WorkspaceNote {
        WorkspaceNote {
            id: id.into(),
            title: title.into(),
            modified: 0,
            content: content.into(),
        }
    }

    #[test]
    fn wikilinks_are_ordered_deduplicated_and_skip_code() {
        let markdown = "See [[Trip Budget]] and [[packing]].\n\n```md\n[[Not A Link]]\n```\n\nAgain [[trip budget]].";
        assert_eq!(wikilinks(markdown), vec!["Trip Budget", "packing"]);
    }

    #[test]
    fn backlinks_match_titles_case_insensitively_and_exclude_the_target() {
        let notes = vec![
            note("trip", "Trip plan", "Links to [[Budget]] and itself [[Trip plan]]."),
            note("journal/day-1", "Day 1", "Planning with [[trip PLAN]]."),
            note("budget", "Budget", "No links here."),
        ];
        let ids: Vec<&str> = backlinks(&notes, "Trip plan", "trip")
            .iter()
            .map(|n| n.id.as_str())
            .collect();
        assert_eq!(ids, vec!["journal/day-1"]);
        assert_eq!(find_by_title(&notes, "budget").map(|n| n.id.as_str()), Some("budget"));
        assert!(find_by_title(&notes, "Missing").is_none());
    }
}

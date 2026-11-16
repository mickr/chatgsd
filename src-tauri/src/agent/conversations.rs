//! Per-document agent conversations, kept in app data rather than the notes
//! folder: git sync commits the notes folder wholesale, and these hold note
//! excerpts plus account-bound reasoning that shouldn't travel with the notes.
//!
//! Layout under `{APP_DATA}/agent/conversations/<notes folder key>/`:
//! - `index.json`: stable document IDs mapped to each note's current ID (its
//!   path, which changes on rename), and every conversation's summary.
//! - `<session>.json`: the panel transcript, written by the frontend.
//! - `<session>.model.json`: the ChatGPT input history, written each round so a
//!   conversation can continue after a restart.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex as AsyncMutex;

/// Serializes index read-modify-write cycles across runs and note commands.
static INDEX_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());
const TITLE_CHARS: usize = 60;

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Index {
    documents: BTreeMap<String, String>,
    sessions: Vec<ConversationSummary>,
}

impl Index {
    fn document_for(&self, note_id: &str) -> Option<&str> {
        self.documents
            .iter()
            .find(|(_, id)| id.as_str() == note_id)
            .map(|(document, _)| document.as_str())
    }

    /// The session, if it exists and belongs to the note's document.
    fn owned(&mut self, note_id: &str, session_id: &str) -> Result<&mut ConversationSummary, String> {
        let document = self.document_for(note_id).map(str::to_owned);
        self.sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .filter(|session| Some(&session.document_id) == document.as_ref())
            .ok_or_else(|| "That conversation isn't part of this note's history.".to_owned())
    }

    /// Save through stable session ownership, never a path captured before a rename.
    fn session_for_save(&mut self, session_id: &str) -> Result<&mut ConversationSummary, String> {
        self.sessions
            .iter_mut()
            .find(|session| session.id == session_id && self.documents.contains_key(&session.document_id))
            .ok_or_else(|| "That conversation no longer belongs to a note in this folder.".to_owned())
    }

    /// Rewrites note IDs after a rename or move. A `from` ending in `/` is a
    /// folder prefix; anything else is one note.
    fn rename(&mut self, from: &str, to: &str) -> bool {
        let mut changed = false;
        for id in self.documents.values_mut() {
            let next = if from.ends_with('/') {
                id.strip_prefix(from).map(|rest| format!("{to}{rest}"))
            } else {
                (id == from).then(|| to.to_owned())
            };
            if let Some(next) = next {
                *id = next;
                changed = true;
            }
        }
        changed
    }

    /// Forgets deleted notes, returning the conversations that went with them.
    fn forget(&mut self, target: &str) -> Vec<String> {
        let gone: Vec<String> = self
            .documents
            .iter()
            .filter(|(_, id)| {
                if target.ends_with('/') {
                    id.starts_with(target)
                } else {
                    id.as_str() == target
                }
            })
            .map(|(document, _)| document.clone())
            .collect();
        self.documents.retain(|document, _| !gone.contains(document));
        let mut removed = Vec::new();
        self.sessions.retain(|session| {
            let keep = !gone.contains(&session.document_id);
            if !keep {
                removed.push(session.id.clone());
            }
            keep
        });
        removed
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub document_id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Deserialize)]
pub struct ModelHistory {
    pub account: String,
    pub items: Vec<Value>,
}

#[derive(Serialize)]
struct ModelHistoryRef<'a> {
    account: &'a str,
    items: &'a [Value],
}

struct Store {
    dir: PathBuf,
}

impl Store {
    async fn open(app: &AppHandle, notes_folder: &Path) -> Result<Self, String> {
        // Key on the canonical path so a symlinked folder and its target share history.
        let canonical = tokio::fs::canonicalize(notes_folder)
            .await
            .unwrap_or_else(|_| notes_folder.to_path_buf());
        let digest = format!("{:x}", Sha256::digest(canonical.to_string_lossy().as_bytes()));
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("agent")
            .join("conversations")
            .join(&digest[..24]);
        Ok(Self { dir })
    }

    fn session_file(&self, session_id: &str, suffix: &str) -> Result<PathBuf, String> {
        uuid::Uuid::parse_str(session_id).map_err(|_| "Invalid conversation ID".to_owned())?;
        Ok(self.dir.join(format!("{session_id}{suffix}.json")))
    }

    async fn read<T: for<'de> Deserialize<'de>>(&self, path: &Path) -> Result<Option<T>, String> {
        match tokio::fs::read(path).await {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|e| format!("Conversation history is unreadable: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("Couldn't read conversation history: {e}")),
        }
    }

    async fn write<T: Serialize>(&self, path: &Path, value: &T) -> Result<(), String> {
        let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        tokio::fs::create_dir_all(&self.dir)
            .await
            .map_err(|e| format!("Couldn't save conversation history: {e}"))?;
        // Write then rename, so a crash never leaves a half-written file behind.
        let partial = path.with_extension("json.partial");
        tokio::fs::write(&partial, bytes)
            .await
            .map_err(|e| format!("Couldn't save conversation history: {e}"))?;
        tokio::fs::rename(&partial, path)
            .await
            .map_err(|e| format!("Couldn't save conversation history: {e}"))
    }

    fn index_path(&self) -> PathBuf {
        self.dir.join("index.json")
    }

    async fn index(&self) -> Result<Index, String> {
        Ok(self.read(&self.index_path()).await?.unwrap_or_default())
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn title_from(prompt: &str) -> String {
    let line = prompt.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("Conversation");
    let mut title: String = line.chars().take(TITLE_CHARS).collect();
    if line.chars().nth(TITLE_CHARS).is_some() {
        title.push('…');
    }
    title
}

/// Registers a run's conversation under the note's document, or checks that a
/// continued conversation still belongs to it (renames keep the mapping current).
pub async fn begin(app: &AppHandle, notes_folder: &Path, note_id: &str, session_id: &str, prompt: &str) -> Result<(), String> {
    let store = Store::open(app, notes_folder).await?;
    store.session_file(session_id, "")?;
    let _lock = INDEX_LOCK.lock().await;
    let mut index = store.index().await?;
    if index.sessions.iter().any(|session| session.id == session_id) {
        index.owned(note_id, session_id).map_err(|_| {
            "This conversation belongs to another note. Start a new conversation.".to_owned()
        })?;
        return Ok(());
    }
    let document_id = match index.document_for(note_id) {
        Some(document) => document.to_owned(),
        None => {
            let document = uuid::Uuid::new_v4().to_string();
            index.documents.insert(document.clone(), note_id.to_owned());
            document
        }
    };
    let time = now();
    index.sessions.push(ConversationSummary {
        id: session_id.to_owned(),
        document_id,
        title: title_from(prompt),
        created_at: time,
        updated_at: time,
    });
    store.write(&store.index_path(), &index).await
}

pub async fn load_model(app: &AppHandle, notes_folder: &Path, session_id: &str) -> Result<Option<ModelHistory>, String> {
    let store = Store::open(app, notes_folder).await?;
    store.read(&store.session_file(session_id, ".model")?).await
}

pub async fn save_model(app: &AppHandle, notes_folder: &Path, session_id: &str, account: &str, items: &[Value]) -> Result<(), String> {
    let store = Store::open(app, notes_folder).await?;
    store
        .write(&store.session_file(session_id, ".model")?, &ModelHistoryRef { account, items })
        .await
}

/// Keeps documents pointing at their notes after a rename or move. `from` and
/// `to` are note IDs, or folder prefixes ending in `/`.
pub async fn notes_moved(app: &AppHandle, notes_folder: &Path, from: &str, to: &str) {
    let result = async {
        let store = Store::open(app, notes_folder).await?;
        let _lock = INDEX_LOCK.lock().await;
        let mut index = store.index().await?;
        if index.rename(from, to) {
            store.write(&store.index_path(), &index).await?;
        }
        Ok::<_, String>(())
    }
    .await;
    if let Err(error) = result {
        eprintln!("Couldn't move agent conversations from {from} to {to}: {error}");
    }
}

/// Drops the conversations of deleted notes. `target` is a note ID, or a
/// folder prefix ending in `/`.
pub async fn notes_deleted(app: &AppHandle, notes_folder: &Path, target: &str) {
    let result = async {
        let store = Store::open(app, notes_folder).await?;
        let _lock = INDEX_LOCK.lock().await;
        let mut index = store.index().await?;
        let documents = index.documents.len();
        let removed = index.forget(target);
        if index.documents.len() == documents {
            return Ok(());
        }
        store.write(&store.index_path(), &index).await?;
        for session in removed {
            for suffix in ["", ".model"] {
                let _ = tokio::fs::remove_file(store.session_file(&session, suffix)?).await;
            }
        }
        Ok::<_, String>(())
    }
    .await;
    if let Err(error) = result {
        eprintln!("Couldn't remove agent conversations for {target}: {error}");
    }
}

#[tauri::command]
pub async fn agent_list_conversations(app: AppHandle, note_id: String) -> Result<Vec<ConversationSummary>, String> {
    let store = Store::open(&app, &super::notes_folder(&app).await?).await?;
    let index = store.index().await?;
    let Some(document) = index.document_for(&note_id) else {
        return Ok(Vec::new());
    };
    let mut sessions: Vec<_> = index
        .sessions
        .iter()
        .filter(|session| session.document_id == document)
        .cloned()
        .collect();
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    Ok(sessions)
}

#[tauri::command]
pub async fn agent_load_conversation(app: AppHandle, note_id: String, session_id: String) -> Result<Value, String> {
    let store = Store::open(&app, &super::notes_folder(&app).await?).await?;
    store.index().await?.owned(&note_id, &session_id)?;
    Ok(store
        .read(&store.session_file(&session_id, "")?)
        .await?
        .unwrap_or(Value::Array(Vec::new())))
}

#[tauri::command]
pub async fn agent_save_conversation(app: AppHandle, session_id: String, items: Value) -> Result<(), String> {
    if !items.is_array() {
        return Err("A conversation transcript must be a list".into());
    }
    let store = Store::open(&app, &super::notes_folder(&app).await?).await?;
    let _lock = INDEX_LOCK.lock().await;
    let mut index = store.index().await?;
    index.session_for_save(&session_id)?.updated_at = now();
    store.write(&store.session_file(&session_id, "")?, &items).await?;
    store.write(&store.index_path(), &index).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index() -> Index {
        let mut index = Index::default();
        for (document, note) in [("d1", "Trip plan"), ("d2", "Travel/Budget"), ("d3", "Travel/Packing")] {
            index.documents.insert(document.into(), note.into());
            index.sessions.push(ConversationSummary {
                id: format!("s-{document}"),
                document_id: document.into(),
                title: String::new(),
                created_at: 0,
                updated_at: 0,
            });
        }
        index
    }

    #[test]
    fn queued_session_save_survives_rename_but_not_deletion() {
        let mut index = index();
        let queued_session = "s-d1";
        assert!(index.rename("Trip plan", "Summer trip"));
        index.session_for_save(queued_session).unwrap().updated_at = 42;
        assert_eq!(index.owned("Summer trip", queued_session).unwrap().updated_at, 42);
        assert!(Index::default().session_for_save(queued_session).is_err());
        index.forget("Summer trip");
        assert!(index.session_for_save(queued_session).is_err());
    }

    #[test]
    fn renames_follow_notes_and_folders() {
        let mut index = index();
        assert!(index.rename("Trip plan", "Summer trip"));
        assert!(index.rename("Travel/", "Trips/2025/"));
        assert!(!index.rename("Travel/", "Elsewhere/"));
        assert_eq!(index.document_for("Summer trip"), Some("d1"));
        assert_eq!(index.document_for("Trips/2025/Budget"), Some("d2"));
        assert!(index.owned("Summer trip", "s-d1").is_ok());
        assert!(index.owned("Trips/2025/Budget", "s-d1").is_err());
    }

    #[test]
    fn deleting_a_folder_drops_only_its_notes_conversations() {
        let mut index = index();
        let mut removed = index.forget("Travel/");
        removed.sort();
        assert_eq!(removed, ["s-d2", "s-d3"]);
        assert_eq!(index.document_for("Trip plan"), Some("d1"));
        assert_eq!(index.sessions.len(), 1);
    }

    #[test]
    fn titles_use_the_first_line_and_stay_short() {
        assert_eq!(title_from("\n  Plan the trip  \nmore"), "Plan the trip");
        let long = "a".repeat(80);
        assert_eq!(title_from(&long).chars().count(), TITLE_CHARS + 1);
    }
}

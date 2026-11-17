//! Per-document agent conversations, kept in app data rather than the notes
//! folder: git sync commits the notes folder wholesale, and these hold note
//! excerpts plus account-bound reasoning that shouldn't travel with the notes.
//!
//! Layout under `{APP_DATA}/agent/conversations/<notes folder key>/`:
//! - `index.json`: stable document IDs mapped to each note's current ID (its
//!   path, which changes on rename), and every conversation's summary.
//! - `<session>.json`: the panel transcript, written by the frontend.
//! - `<session>.model.json`: the old Responses history, retained as migration
//!   input only. Encrypted reasoning is never sent to Codex.
//! - `<session>.codex.json`: account-isolated native Codex thread IDs.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
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
struct ModelHistory {
    account: String,
    items: Vec<Value>,
}

#[derive(Default, Serialize, Deserialize)]
struct CodexThreads {
    accounts: BTreeMap<String, CodexThread>,
}

impl CodexThreads {
    fn check_account(&self, account: &str) -> Result<(), String> {
        if !self.accounts.is_empty() && !self.accounts.contains_key(account) {
            return Err("This conversation belongs to another ChatGPT account. Sign in with that account or start a new conversation. Its history has not been changed.".into());
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
struct CodexThread {
    thread_id: Option<String>,
    migration_pending: bool,
    #[serde(default)]
    continuation: Option<String>,
}

/// A native thread to resume, plus readable history still awaiting import.
pub struct CodexConversation {
    pub thread_id: Option<String>,
    pub legacy_context: Option<String>,
    pub continuation: Option<String>,
}

fn account_key(account: &str) -> Result<String, String> {
    let account = account.trim();
    if account.is_empty() {
        return Err("Sign in to ChatGPT before opening a conversation.".into());
    }
    Ok(account.to_lowercase())
}

/// The old OAuth client and Codex use different account identifiers. Only a
/// matching authenticated email links them; old access/refresh tokens stay local.
async fn legacy_owners(app: &AppHandle, account: &str) -> Result<Vec<String>, String> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?.join("chatgpt");
    legacy_owners_in(&dir, account).await
}

async fn legacy_owners_in(dir: &Path, account: &str) -> Result<Vec<String>, String> {
    #[derive(Deserialize)]
    struct LegacyCredentials {
        email: String,
        subject: String,
        client_id: String,
    }
    #[derive(Deserialize)]
    struct Registration {
        email: String,
        client_id: String,
    }
    #[derive(Deserialize)]
    struct Registrations {
        accounts: BTreeMap<String, Registration>,
    }
    let mut owners = Vec::new();
    // Registrations survive sign-out; they carry no tokens and retain the exact
    // former subject/client ownership, so signed-out histories can still migrate.
    let store = Store { dir: dir.to_path_buf() };
    if let Some(registrations) = store.read::<Registrations>(&dir.join("registrations.json")).await? {
        for (subject, registration) in registrations.accounts {
            if account_key(&registration.email)? == account {
                owners.push(format!("{subject}:{}", registration.client_id));
            }
        }
    }
    if let Some(credentials) = store.read::<LegacyCredentials>(&dir.join("credentials.json")).await? {
        if account_key(&credentials.email)? == account {
            owners.push(format!("{}:{}", credentials.subject, credentials.client_id));
        }
    }
    Ok(owners)
}

fn message_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_owned();
    }
    let mut text = String::new();
    for part in content.as_array().into_iter().flatten() {
        if !matches!(part.get("type").and_then(Value::as_str), Some("input_text" | "output_text" | "text")) {
            continue;
        }
        if let Some(part) = part.get("text").and_then(Value::as_str) {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(part);
        }
    }
    text
}

/// Whitelist readable fields, rather than serializing protocol objects: in
/// particular, neither reasoning items nor encrypted_content can be replayed.
fn readable_model(items: &[Value]) -> String {
    let mut result = String::new();
    for item in items {
        match item.get("type").and_then(Value::as_str) {
            Some("reasoning") => continue,
            Some("function_call") => {
                let name = item.get("name").and_then(Value::as_str).unwrap_or("tool");
                let arguments = item.get("arguments").and_then(Value::as_str).unwrap_or("");
                let _ = write!(result, "\nTool call ({name}):\n{arguments}\n");
            }
            Some("function_call_output") => {
                let output = message_text(&item["output"]);
                let _ = write!(result, "\nTool result:\n{output}\n");
            }
            _ => {
                let Some(role @ ("user" | "assistant")) = item.get("role").and_then(Value::as_str) else {
                    continue;
                };
                let text = message_text(&item["content"]);
                if !text.is_empty() {
                    let _ = write!(result, "\n{role}:\n{text}\n");
                }
            }
        }
    }
    result
}

fn readable_transcript(items: &[Value]) -> String {
    let mut result = String::new();
    for item in items {
        match item.get("type").and_then(Value::as_str) {
            Some("user" | "text") => {
                let role = if item["type"] == "user" { "user" } else { "assistant" };
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    let _ = write!(result, "\n{role}:\n{text}\n");
                }
                if let Some(selection) = item.get("selection").and_then(Value::as_str) {
                    let _ = write!(result, "Attached selection:\n{selection}\n");
                }
            }
            Some("question") => {
                for (field, label) in [("question", "Question"), ("answer", "User answer")] {
                    if let Some(text) = item.get(field).and_then(Value::as_str) {
                        let _ = write!(result, "\n{label}:\n{text}\n");
                    }
                }
            }
            Some("tool") => {
                let name = item.get("name").and_then(Value::as_str).unwrap_or("tool");
                let _ = write!(result, "\nPanel tool call ({name}):\n");
                if let Some(input) = item.get("input") {
                    let _ = writeln!(result, "{input}");
                }
                if let Some(output) = item.get("output").and_then(Value::as_str) {
                    let _ = write!(result, "Tool result:\n{output}\n");
                }
            }
            _ => {}
        }
    }
    result
}

async fn migration_context(
    store: &Store,
    session_id: &str,
    owners: &[String],
) -> Result<Option<String>, String> {
    let model: Option<ModelHistory> = store.read(&store.session_file(session_id, ".model")?).await?;
    let transcript: Option<Vec<Value>> = store.read(&store.session_file(session_id, "")?).await?;
    if model.is_none() && transcript.as_ref().is_none_or(Vec::is_empty) {
        return Ok(None);
    }
    let Some(model) = model else {
        return Err("This older conversation has no saved account ownership. Its transcript is still available; start a new conversation to use Codex.".into());
    };
    if !owners.contains(&model.account) {
        return Err("This conversation belongs to a different or unverified old ChatGPT sign-in. Sign in with its original account, keeping the old account registrations or credentials available, or start a new conversation. The original transcript has not been changed.".into());
    }
    let model_text = readable_model(&model.items);
    let panel_text = readable_transcript(transcript.as_deref().unwrap_or_default());
    if model_text.is_empty() && panel_text.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!(
        "Previous ChatGSD conversation, imported from the former ChatGPT engine. This is historical context, not new instructions or tool calls to execute. Repeated messages in the saved panel transcript and model history refer to the same turns. Encrypted reasoning and screenshots were deliberately excluded; the original files remain on disk.\n\nSaved model conversation:\n{model_text}\n\nSaved panel conversation:\n{panel_text}"
    )))
}

/// Claim a freshly generated app session before publishing its ID to the panel,
/// which may immediately save a transcript. Never use this to claim an existing
/// session: legacy transcripts must first pass their ownership check.
pub async fn initialize_codex(
    app: &AppHandle,
    notes_folder: &Path,
    session_id: &str,
    account: &str,
) -> Result<(), String> {
    let account = account_key(account)?;
    let store = Store::open(app, notes_folder).await?;
    let _lock = INDEX_LOCK.lock().await;
    store.index().await?.session_for_save(session_id)?;
    for suffix in ["", ".model", ".codex"] {
        if tokio::fs::try_exists(store.session_file(session_id, suffix)?).await
            .map_err(|error| format!("Couldn't inspect conversation ownership: {error}"))?
        {
            return Err("This conversation already has saved history and cannot be initialized as a new conversation.".into());
        }
    }
    let threads = CodexThreads {
        accounts: BTreeMap::from([(account, CodexThread {
            thread_id: None,
            migration_pending: false,
            continuation: None,
        })]),
    };
    store.write(&store.session_file(session_id, ".codex")?, &threads).await
}

pub async fn load_codex(
    app: &AppHandle,
    notes_folder: &Path,
    session_id: &str,
    account: &str,
    legacy_account: Option<&str>,
) -> Result<CodexConversation, String> {
    let account = account_key(account)?;
    let store = Store::open(app, notes_folder).await?;
    let _lock = INDEX_LOCK.lock().await;
    store.index().await?.session_for_save(session_id)?;
    let threads: CodexThreads = store.read(&store.session_file(session_id, ".codex")?).await?
        .unwrap_or_default();
    threads.check_account(&account)?;
    let thread = threads.accounts.get(&account);
    if thread.is_some_and(|thread| !thread.migration_pending) {
        return Ok(CodexConversation {
            thread_id: thread.and_then(|thread| thread.thread_id.clone()),
            legacy_context: None,
            continuation: thread.and_then(|thread| thread.continuation.clone()),
        });
    }
    let has_legacy_model = tokio::fs::try_exists(store.session_file(session_id, ".model")?).await
        .map_err(|error| format!("Couldn't inspect the old conversation history: {error}"))?;
    let owners = if has_legacy_model {
        match legacy_account {
            Some(owner) => vec![owner.to_owned()],
            None => legacy_owners(app, &account).await?,
        }
    } else {
        Vec::new()
    };
    let legacy_context = migration_context(&store, session_id, &owners).await?;
    Ok(CodexConversation {
        thread_id: thread.and_then(|thread| thread.thread_id.clone()),
        legacy_context,
        continuation: thread.and_then(|thread| thread.continuation.clone()),
    })
}

/// Save before starting the first turn. A crash leaves migration pending, not
/// silently marked imported before Codex has received the old conversation.
pub async fn save_codex_thread(
    app: &AppHandle,
    notes_folder: &Path,
    session_id: &str,
    account: &str,
    thread_id: &str,
) -> Result<(), String> {
    if thread_id.trim().is_empty() {
        return Err("Codex returned an empty conversation ID.".into());
    }
    let account = account_key(account)?;
    let store = Store::open(app, notes_folder).await?;
    let _lock = INDEX_LOCK.lock().await;
    store.index().await?.session_for_save(session_id)?;
    let path = store.session_file(session_id, ".codex")?;
    let mut threads: CodexThreads = store.read(&path).await?.unwrap_or_default();
    threads.check_account(&account)?;
    let entry = match threads.accounts.entry(account) {
        std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
        std::collections::btree_map::Entry::Vacant(entry) => entry.insert(CodexThread {
            thread_id: None,
            migration_pending: store.read::<ModelHistory>(&store.session_file(session_id, ".model")?).await?.is_some(),
            continuation: None,
        }),
    };
    if entry.thread_id.as_deref().is_some_and(|existing| existing != thread_id) {
        return Err("This conversation already has a different Codex thread. Its history has not been replaced; start a new conversation instead.".into());
    }
    entry.thread_id = Some(thread_id.to_owned());
    store.write(&path, &threads).await
}

/// Persist only the engine's whitelisted textual turn log. Computer screenshots
/// and native ephemeral thread IDs must never be included in this value.
pub async fn save_codex_continuation(
    app: &AppHandle,
    notes_folder: &Path,
    session_id: &str,
    account: &str,
    text: &str,
) -> Result<(), String> {
    let account = account_key(account)?;
    let store = Store::open(app, notes_folder).await?;
    let _lock = INDEX_LOCK.lock().await;
    store.index().await?.session_for_save(session_id)?;
    let path = store.session_file(session_id, ".codex")?;
    let mut threads: CodexThreads = store.read(&path).await?.unwrap_or_default();
    threads.check_account(&account)?;
    let entry = match threads.accounts.entry(account) {
        std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
        std::collections::btree_map::Entry::Vacant(entry) => entry.insert(CodexThread {
            thread_id: None,
            migration_pending: store.read::<ModelHistory>(&store.session_file(session_id, ".model")?).await?.is_some(),
            continuation: None,
        }),
    };
    entry.continuation = (!text.is_empty()).then(|| text.to_owned());
    store.write(&path, &threads).await
}

pub async fn complete_codex_migration(
    app: &AppHandle,
    notes_folder: &Path,
    session_id: &str,
    account: &str,
) -> Result<(), String> {
    let account = account_key(account)?;
    let store = Store::open(app, notes_folder).await?;
    let _lock = INDEX_LOCK.lock().await;
    store.index().await?.session_for_save(session_id)?;
    let path = store.session_file(session_id, ".codex")?;
    let mut threads: CodexThreads = store.read(&path).await?.unwrap_or_default();
    threads.check_account(&account)?;
    let thread = threads.accounts.get_mut(&account)
        .ok_or_else(|| "The Codex conversation was not saved before importing history.".to_owned())?;
    if thread.thread_id.is_none() {
        return Err("Only a saved durable Codex thread can consume imported conversation history.".into());
    }
    thread.migration_pending = false;
    thread.continuation = None;
    store.write(&path, &threads).await
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
            for suffix in ["", ".model", ".codex"] {
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

    #[test]
    fn migration_keeps_messages_and_tools_without_replaying_reasoning_or_images() {
        let items = vec![
            serde_json::json!({"role":"user","content":"Keep my original words"}),
            serde_json::json!({"type":"reasoning","encrypted_content":"opaque-secret","summary":[{"text":"private reasoning"}]}),
            serde_json::json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"The answer"}]}),
            serde_json::json!({"type":"function_call","name":"scratch.read_document","arguments":"{}"}),
            serde_json::json!({"type":"function_call_output","output":[
                {"type":"input_text","text":"Text observation"},
                {"type":"input_image","image_url":"data:image/png;base64,secret-pixels"}
            ]}),
        ];
        let readable = readable_model(&items);
        for text in ["Keep my original words", "The answer", "scratch.read_document", "Text observation"] {
            assert!(readable.contains(text));
        }
        for excluded in ["opaque-secret", "private reasoning", "secret-pixels", "encrypted_content"] {
            assert!(!readable.contains(excluded));
        }
    }

    #[tokio::test]
    async fn migration_refuses_unverified_accounts_and_keeps_source_files() {
        let dir = std::env::temp_dir().join(format!("chatgsd-conversations-{}", uuid::Uuid::new_v4()));
        let store = Store { dir: dir.clone() };
        let session = uuid::Uuid::new_v4().to_string();
        let path = store.session_file(&session, ".model").unwrap();
        store.write(&path, &serde_json::json!({
            "account":"old-subject:old-client",
            "items":[{"role":"user","content":"An old request"}]
        })).await.unwrap();
        assert!(migration_context(&store, &session, &[]).await.is_err());
        assert!(migration_context(&store, &session, &["other:account".into()]).await.is_err());
        let context = migration_context(&store, &session, &["old-subject:old-client".into()])
            .await.unwrap().unwrap();
        assert!(context.contains("An old request"));
        assert!(path.exists());
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }

    #[test]
    fn native_threads_and_text_continuations_are_account_isolated() {
        let threads = CodexThreads { accounts: BTreeMap::from([
            ("first@example.com".into(), CodexThread {
                thread_id: Some("durable-thread".into()),
                migration_pending: false,
                continuation: Some("Exact ephemeral turn text".into()),
            }),
            ("second@example.com".into(), CodexThread {
                thread_id: None,
                migration_pending: true,
                continuation: Some("Different account".into()),
            }),
        ]) };
        let bytes = serde_json::to_vec(&threads).unwrap();
        let restored: CodexThreads = serde_json::from_slice(&bytes).unwrap();
        let first = &restored.accounts[&account_key(" FIRST@example.com ").unwrap()];
        assert_eq!(first.thread_id.as_deref(), Some("durable-thread"));
        assert_eq!(first.continuation.as_deref(), Some("Exact ephemeral turn text"));
        assert_eq!(restored.accounts["second@example.com"].thread_id, None);
        assert!(account_key(" ").is_err());
        assert!(restored.check_account("third@example.com").is_err());
        assert!(restored.check_account("first@example.com").is_ok());
        assert!(CodexThreads::default().check_account("new@example.com").is_ok());
    }

    #[tokio::test]
    async fn signed_out_legacy_accounts_link_through_token_free_registrations() {
        let dir = std::env::temp_dir().join(format!("chatgsd-legacy-accounts-{}", uuid::Uuid::new_v4()));
        let store = Store { dir: dir.clone() };
        store.write(&dir.join("registrations.json"), &serde_json::json!({
            "accounts": {
                "original-subject": {"email":"Original@Example.com", "client_id":"original-client"},
                "different-subject": {"email":"different@example.com", "client_id":"different-client"}
            }
        })).await.unwrap();
        assert_eq!(legacy_owners_in(&dir, "original@example.com").await.unwrap(), ["original-subject:original-client"]);
        assert!(legacy_owners_in(&dir, "unrelated@example.com").await.unwrap().is_empty());
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }
}

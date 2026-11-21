//! Persistent stdio JSON-RPC client for the local Antigravity ACP server (`agy acp`).

use super::mcp::McpServer;
use crate::agent::ModelInfo;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::time::timeout;

const RPC_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_MESSAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_WARM_SESSIONS: usize = 6;
const ASK_TIMEOUT: Duration = Duration::from_secs(120);

pub(super) const BASE_BRIDGE_RULES: &str = "\
Runtime bridge rules:
- You are connected to ChatGSD through the `scratch` MCP server.
- Use ONLY the `mcp_scratch_*` tools. Every tool your instructions name is one of them under \
that prefix: `mcp_tools` is `mcp_scratch_mcp_tools`.
- Never call built-in shell, terminal, browser, or filesystem tools; the workspace folder is \
intentionally empty and every note lives inside ChatGSD's tracked editor tools.
- Every turn already includes the live open note snapshot inside `<live_note>` (identical to \
calling `read_document`). Do NOT call `read_document` first—go straight to `edit_document`, \
`replace_selection`, `offer_writing_help`, or your direct answer. Only call `read_document` if \
`<live_note>` is an outline and you need unseen lines, or if an edit fails because the writer \
typed concurrently.
- Minimize tool turns: invoke `edit_document` or `replace_selection` as your single first \
tool call. Never call `set_expression` or `read_document` before an edit.";

pub(super) struct WarmSession {
    pub acp_session_id: String,
    pub read_only: bool,
    pub last_used: u64,
}

pub(super) struct StandbySession {
    pub acp_session_id: String,
    pub read_only: bool,
    pub instructions_hash: Option<u64>,
}

pub(super) struct EnsuredSession {
    pub acp_session_id: String,
    pub reused: bool,
    pub needs_instructions_preamble: bool,
}

pub(super) fn hash_str(value: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

pub(super) struct AcpClient {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    stderr: tokio::task::JoinHandle<()>,
    pub mcp: McpServer,
    pub cwd: PathBuf,
    request_id: u64,
    queued: VecDeque<Value>,
    sessions: HashMap<String, WarmSession>,
    standby: Option<StandbySession>,
    session_models: HashMap<String, String>,
    session_tick: u64,
    pub cached_models: Vec<ModelInfo>,
    variant_map: HashMap<(String, String), String>,
    raw_model_ids: std::collections::HashSet<String>,
    pub dirty: bool,
}

pub(super) fn find_executable(app: Option<&tauri::AppHandle>) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("AGY_PATH") {
        let path = PathBuf::from(path);
        if path.is_absolute() && path.is_file() {
            return Some(path);
        }
    }
    if let Ok(path) = which::which("agy") {
        return Some(path);
    }
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/agy"),
        PathBuf::from("/usr/local/bin/agy"),
        PathBuf::from("/Applications/Antigravity.app/Contents/Resources/app/bin/agy"),
    ];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        candidates.push(home.join(".local/bin/agy"));
        candidates.push(home.join(".antigravity/bin/agy"));
        candidates.push(home.join(".gemini/antigravity-cli/bin/agy"));
        candidates.push(home.join("bin/agy"));
    }
    if let Some(managed) = app.and_then(super::install::app_managed_binary) {
        candidates.push(managed);
    }
    candidates.into_iter().find(|path| path.is_file())
}

pub(super) fn is_auth_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("unauthenticated")
        || lower.contains("not signed in")
        || lower.contains("login required")
        || lower.contains("authentication required")
        || lower.contains("auth required")
        || lower.contains("unauthorized")
}

pub(super) fn permission_outcome(params: &Value) -> Value {
    let tool_name = params["toolCall"]["name"].as_str().unwrap_or_default();
    let allow = tool_name.starts_with("mcp_scratch_");
    let options = params["options"].as_array();
    let option_id = if allow {
        options
            .and_then(|opts| {
                opts.iter()
                    .find(|opt| opt["kind"].as_str() == Some("allow_always"))
                    .or_else(|| {
                        opts.iter()
                            .find(|opt| opt["kind"].as_str() == Some("allow_once"))
                    })
                    .or_else(|| {
                        opts.iter().find(|opt| {
                            opt["kind"]
                                .as_str()
                                .is_some_and(|kind| kind.starts_with("allow"))
                        })
                    })
                    .and_then(|opt| opt["optionId"].as_str())
            })
            .unwrap_or("allow")
    } else {
        options
            .and_then(|opts| {
                opts.iter()
                    .find(|opt| opt["kind"].as_str() == Some("reject_once"))
                    .or_else(|| {
                        opts.iter().find(|opt| {
                            opt["kind"]
                                .as_str()
                                .is_some_and(|kind| kind.starts_with("reject"))
                        })
                    })
                    .and_then(|opt| opt["optionId"].as_str())
            })
            .unwrap_or("deny")
    };
    json!({
        "outcome": {
            "outcome": "selected",
            "optionId": option_id,
        }
    })
}

fn workspace_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("antigravity").join("workspace"))
        .map_err(|error| format!("Cannot find Antigravity workspace directory: {error}"))
}

const EFFORT_ORDER: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh"];

fn split_effort_suffix(model_id: &str) -> Option<(&str, &str)> {
    for &effort in EFFORT_ORDER {
        if let Some(base) = model_id.strip_suffix(&format!("-{effort}")) {
            if !base.is_empty() {
                return Some((base, effort));
            }
        }
    }
    None
}

fn clean_base_label(name: &str) -> String {
    for suffix in [" (None)", " (Minimal)", " (Low)", " (Medium)", " (High)", " (XHigh)", " (Extra)"] {
        if let Some(stripped) = name.strip_suffix(suffix) {
            return stripped.to_owned();
        }
    }
    name.to_owned()
}

struct ParsedCatalog {
    models: Vec<ModelInfo>,
    variants: HashMap<(String, String), String>,
    raw_ids: std::collections::HashSet<String>,
}

fn parse_models(response: &Value) -> ParsedCatalog {
    // Prefer base labels from ACP configOptions when provided.
    let mut config_labels: HashMap<String, String> = HashMap::new();
    for opt in response["configOptions"].as_array().into_iter().flatten() {
        if opt["id"].as_str() == Some("model") {
            for item in opt["options"].as_array().into_iter().flatten() {
                if let (Some(value), Some(name)) = (item["value"].as_str(), item["name"].as_str()) {
                    config_labels.insert(value.to_owned(), name.to_owned());
                }
            }
        }
    }

    struct Group {
        base_id: String,
        label: String,
        efforts: Vec<String>,
        single_raw_id: String,
    }

    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Group> = HashMap::new();
    let mut variants: HashMap<(String, String), String> = HashMap::new();
    let mut raw_ids = std::collections::HashSet::new();

    let entries = response["models"]["availableModels"]
        .as_array()
        .into_iter()
        .flatten();
    for entry in entries {
        let Some(id) = entry["modelId"].as_str().filter(|id| !id.is_empty()) else {
            continue;
        };
        // Skip internal multi-agent orchestrator presets not meant for prose editing.
        if id.contains("orchestrator") {
            continue;
        }
        raw_ids.insert(id.to_owned());
        let raw_name = entry["name"].as_str().unwrap_or(id);
        let (base_id, effort) = if config_labels.contains_key(id) {
            (id, None)
        } else if let Some((base, level)) = split_effort_suffix(id) {
            (base, Some(level))
        } else {
            (id, None)
        };
        let entry_group = groups.entry(base_id.to_owned()).or_insert_with(|| {
            order.push(base_id.to_owned());
            let label = config_labels
                .get(base_id)
                .cloned()
                .unwrap_or_else(|| clean_base_label(raw_name));
            Group {
                base_id: base_id.to_owned(),
                label,
                efforts: Vec::new(),
                single_raw_id: id.to_owned(),
            }
        });
        if let Some(level) = effort {
            if !entry_group.efforts.iter().any(|existing| existing == level) {
                entry_group.efforts.push(level.to_owned());
            }
            variants.insert((base_id.to_owned(), level.to_owned()), id.to_owned());
        }
    }

    let mut models = Vec::with_capacity(order.len());
    for base_id in order {
        let Some(mut group) = groups.remove(&base_id) else {
            continue;
        };
        group.efforts.sort_by_key(|level| {
            EFFORT_ORDER
                .iter()
                .position(|candidate| candidate == level)
                .unwrap_or(usize::MAX)
        });
        // Models with only a single fixed variant (e.g. gpt-oss-120b-medium)
        // stay as a single model with no thinking switcher.
        let (id, efforts, default_effort) = if group.efforts.len() > 1 {
            let default = if group.efforts.iter().any(|level| level == "low") {
                Some("low".to_owned())
            } else {
                group.efforts.first().cloned()
            };
            (group.base_id, group.efforts, default)
        } else {
            (group.single_raw_id, Vec::new(), None)
        };
        models.push(ModelInfo {
            id: format!("{}{id}", super::MODEL_PREFIX),
            label: group.label,
            provider: Some("antigravity".to_owned()),
            efforts,
            default_effort,
            service_tiers: Vec::new(),
        });
    }

    ParsedCatalog {
        models,
        variants,
        raw_ids,
    }
}

impl AcpClient {
    pub async fn start(app: &tauri::AppHandle, default_read_only: bool) -> Result<Self, String> {
        let binary = find_executable(Some(app))
            .ok_or_else(|| "Antigravity CLI (`agy`) was not found on this Mac.".to_owned())?;
        let cwd = workspace_dir(app)?;
        tokio::fs::create_dir_all(&cwd)
            .await
            .map_err(|error| format!("Cannot prepare Antigravity workspace: {error}"))?;
        let mcp = McpServer::start(default_read_only).await?;
        Self::spawn(binary, cwd, mcp).await
    }

    async fn spawn(binary: PathBuf, cwd: PathBuf, mcp: McpServer) -> Result<Self, String> {
        let mut command = Command::new(&binary);
        command
            .args([
                "acp",
                "--stdio",
                "--include-default-customizations=false",
                "--disable-telemetry",
            ])
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|error| format!("Cannot start Antigravity (`agy acp`): {error}"))?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| "Antigravity stdin unavailable".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Antigravity stdout unavailable".to_owned())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Antigravity stderr unavailable".to_owned())?;
        let stderr = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                line.clear();
            }
        });
        let mut client = Self {
            child,
            input,
            output: BufReader::new(stdout),
            stderr,
            mcp,
            cwd,
            request_id: 0,
            queued: VecDeque::new(),
            sessions: HashMap::new(),
            standby: None,
            session_models: HashMap::new(),
            session_tick: 0,
            cached_models: Vec::new(),
            variant_map: HashMap::new(),
            raw_model_ids: std::collections::HashSet::new(),
            dirty: false,
        };
        client
            .rpc(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {},
                    "clientInfo": {
                        "name": "ChatGSD",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                }),
            )
            .await?;
        Ok(client)
    }

    pub fn is_alive(&mut self) -> bool {
        !self.dirty && matches!(self.child.try_wait(), Ok(None))
    }

    pub fn next_id(&mut self) -> u64 {
        self.request_id += 1;
        self.request_id
    }

    pub async fn send(&mut self, value: Value) -> Result<(), String> {
        let mut line = serde_json::to_string(&value).map_err(|error| error.to_string())?;
        line.push('\n');
        timeout(RPC_TIMEOUT, async {
            self.input.write_all(line.as_bytes()).await?;
            self.input.flush().await
        })
        .await
        .map_err(|_| "Antigravity timed out while sending a request.".to_owned())?
        .map_err(|error| format!("Antigravity connection closed: {error}"))
    }

    pub async fn read_line_json(&mut self) -> Result<Value, String> {
        let mut buf = Vec::new();
        let read = self
            .output
            .read_until(b'\n', &mut buf)
            .await
            .map_err(|error| format!("Antigravity stream failed: {error}"))?;
        if read == 0 {
            return Err("Antigravity ACP server exited unexpectedly.".into());
        }
        if buf.len() > MAX_MESSAGE_BYTES {
            return Err("Antigravity returned an oversized message.".into());
        }
        serde_json::from_slice(&buf)
            .map_err(|error| format!("Antigravity returned invalid JSON: {error}"))
    }

    pub async fn next_message(&mut self) -> Result<Value, String> {
        if let Some(queued) = self.queued.pop_front() {
            return Ok(queued);
        }
        self.read_line_json().await
    }

    pub async fn rpc(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id();
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .await?;
        timeout(RPC_TIMEOUT, async {
            loop {
                let message = self.read_line_json().await?;
                if message.get("id").and_then(Value::as_u64) == Some(id)
                    && message.get("method").is_none()
                {
                    if let Some(error) = message.get("error") {
                        let detail = error["message"]
                            .as_str()
                            .unwrap_or("Antigravity request failed");
                        return Err(detail.to_owned());
                    }
                    return Ok(message["result"].clone());
                }
                if message.get("id").is_some()
                    && message["method"].as_str() == Some("session/request_permission")
                {
                    let outcome = permission_outcome(&message["params"]);
                    self.send(json!({
                        "jsonrpc": "2.0",
                        "id": message["id"],
                        "result": outcome,
                    }))
                    .await?;
                    continue;
                }
                self.queued.push_back(message);
            }
        })
        .await
        .map_err(|_| format!("Antigravity timed out waiting for `{method}`."))?
    }

    fn store_catalog(&mut self, catalog: ParsedCatalog) {
        if !catalog.models.is_empty() {
            self.cached_models = catalog.models;
            self.variant_map = catalog.variants;
            self.raw_model_ids = catalog.raw_ids;
        }
    }

    pub fn base_model_id<'a>(&self, model: &'a str) -> &'a str {
        if let Some((stripped, _)) = split_effort_suffix(model) {
            if self.variant_map.keys().any(|(b, _)| b == stripped) {
                return stripped;
            }
        }
        model
    }

    pub fn resolve_model_id(&self, model: &str, effort: Option<&str>) -> String {
        let base = self.base_model_id(model);
        if let Some(level) = effort.filter(|l| !l.is_empty()) {
            if let Some(exact) = self.variant_map.get(&(base.to_owned(), level.to_owned())) {
                return exact.clone();
            }
        }
        if self.raw_model_ids.contains(model) {
            return model.to_owned();
        }
        for preferred in ["low", "medium", "high", "xhigh"] {
            if let Some(exact) = self.variant_map.get(&(base.to_owned(), preferred.to_owned())) {
                return exact.clone();
            }
        }
        model.to_owned()
    }

    pub async fn apply_model(
        &mut self,
        acp_session_id: &str,
        raw_model: &str,
        effort: Option<&str>,
    ) -> Result<(), String> {
        let model_id = self.resolve_model_id(raw_model, effort);
        if model_id.is_empty() {
            return Ok(());
        }
        if self
            .session_models
            .get(acp_session_id)
            .is_some_and(|current| current == &model_id)
        {
            return Ok(());
        }
        match self
            .rpc(
                "session/set_model",
                json!({
                    "sessionId": acp_session_id,
                    "modelId": model_id,
                }),
            )
            .await
        {
            Ok(_) => {
                self.session_models
                    .insert(acp_session_id.to_owned(), model_id);
                Ok(())
            }
            Err(error) if error.contains("Unknown model ID") => {
                // Fall back to ACP configOptions (`model` + `thought_level`).
                let base = self.base_model_id(raw_model).to_owned();
                self.rpc(
                    "session/set_config_option",
                    json!({
                        "sessionId": acp_session_id,
                        "configId": "model",
                        "value": base,
                    }),
                )
                .await
                .map_err(|_| error.clone())?;
                if let Some(level) = effort.filter(|l| !l.is_empty()) {
                    let _ = self
                        .rpc(
                            "session/set_config_option",
                            json!({
                                "sessionId": acp_session_id,
                                "configId": "thought_level",
                                "value": level,
                            }),
                        )
                        .await;
                }
                self.session_models
                    .insert(acp_session_id.to_owned(), model_id);
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    async fn create_session(&mut self, system_prompt: &str) -> Result<String, String> {
        let response = self
            .rpc(
                "session/new",
                json!({
                    "cwd": self.cwd,
                    "mcpServers": [self.mcp.mcp_server_config()],
                    "_meta": {
                        "antigravity": {
                            "systemPrompt": {
                                "append": system_prompt,
                            }
                        }
                    }
                }),
            )
            .await?;
        let acp_session_id = response["sessionId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "Antigravity returned no session ID.".to_owned())?
            .to_owned();
        if let Some(current) = response["models"]["currentModelId"]
            .as_str()
            .filter(|id| !id.is_empty())
        {
            self.session_models
                .insert(acp_session_id.clone(), current.to_owned());
        }
        let discovered = parse_models(&response);
        self.store_catalog(discovered);
        Ok(acp_session_id)
    }

    pub async fn discover_models(&mut self) -> Result<Vec<ModelInfo>, String> {
        // Connect the Scratch MCP server during discovery and keep the session
        // as a warm standby so the first conversation skips `session/new`.
        let acp_session_id = self.create_session(BASE_BRIDGE_RULES).await?;
        self.queued.clear();
        if self.cached_models.is_empty() {
            self.close_session(&acp_session_id).await;
            return Err("Antigravity returned no models.".into());
        }
        if let Some(old) = self.standby.take() {
            self.close_session(&old.acp_session_id).await;
        }
        self.standby = Some(StandbySession {
            acp_session_id,
            read_only: false,
            instructions_hash: None,
        });
        Ok(self.cached_models.clone())
    }

    pub fn needs_standby(&self, read_only: bool, system_prompt: &str) -> bool {
        let target_hash = hash_str(system_prompt);
        !matches!(
            &self.standby,
            Some(standby)
                if standby.read_only == read_only
                    && standby.instructions_hash == Some(target_hash)
        )
    }

    pub async fn prewarm_standby(
        &mut self,
        read_only: bool,
        system_prompt: &str,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<(), String> {
        let target_hash = hash_str(system_prompt);
        if matches!(
            &self.standby,
            Some(standby)
                if standby.read_only == read_only
                    && standby.instructions_hash == Some(target_hash)
        ) {
            if let (Some(standby), Some(raw_model)) = (&self.standby, model) {
                let sid = standby.acp_session_id.clone();
                let _ = self.apply_model(&sid, raw_model, effort).await;
            }
            return Ok(());
        }
        if let Some(old) = self.standby.take() {
            self.close_session(&old.acp_session_id).await;
        }
        let acp_session_id = self.create_session(system_prompt).await?;
        if let Some(raw_model) = model {
            let _ = self.apply_model(&acp_session_id, raw_model, effort).await;
        }
        self.queued.clear();
        self.standby = Some(StandbySession {
            acp_session_id,
            read_only,
            instructions_hash: Some(target_hash),
        });
        Ok(())
    }

    fn record_warm_session(&mut self, chat_session_id: &str, acp_session_id: &str, read_only: bool) -> Vec<String> {
        self.sessions.insert(
            chat_session_id.to_owned(),
            WarmSession {
                acp_session_id: acp_session_id.to_owned(),
                read_only,
                last_used: self.session_tick,
            },
        );
        let mut evicted = Vec::new();
        while self.sessions.len() > MAX_WARM_SESSIONS {
            if let Some((oldest_key, oldest)) = self
                .sessions
                .iter()
                .min_by_key(|(_, session)| session.last_used)
                .map(|(k, v)| (k.clone(), v.acp_session_id.clone()))
            {
                self.sessions.remove(&oldest_key);
                evicted.push(oldest);
            }
        }
        evicted
    }

    pub async fn ensure_session(
        &mut self,
        chat_session_id: Option<&str>,
        read_only: bool,
        system_prompt: &str,
    ) -> Result<EnsuredSession, String> {
        self.session_tick += 1;
        if let Some(key) = chat_session_id {
            if let Some(existing) = self.sessions.get_mut(key) {
                if existing.read_only == read_only {
                    existing.last_used = self.session_tick;
                    return Ok(EnsuredSession {
                        acp_session_id: existing.acp_session_id.clone(),
                        reused: true,
                        needs_instructions_preamble: false,
                    });
                }
                let old_id = existing.acp_session_id.clone();
                self.sessions.remove(key);
                self.close_session(&old_id).await;
            }
        }
        let target_hash = hash_str(system_prompt);
        let claimed = match &self.standby {
            Some(standby)
                if standby.read_only == read_only
                    && (standby.instructions_hash == Some(target_hash)
                        || (!read_only && standby.instructions_hash.is_none())) =>
            {
                self.standby.take()
            }
            _ => None,
        };
        let (acp_session_id, needs_instructions_preamble) = if let Some(standby) = claimed {
            (standby.acp_session_id, standby.instructions_hash.is_none())
        } else {
            (self.create_session(system_prompt).await?, false)
        };
        if let Some(key) = chat_session_id {
            let evicted = self.record_warm_session(key, &acp_session_id, read_only);
            for old in evicted {
                self.close_session(&old).await;
            }
        }
        Ok(EnsuredSession {
            acp_session_id,
            reused: false,
            needs_instructions_preamble,
        })
    }

    pub async fn close_session(&mut self, acp_session_id: &str) {
        self.session_models.remove(acp_session_id);
        let _ = self
            .rpc("session/close", json!({ "sessionId": acp_session_id }))
            .await;
    }

    /// One reply from a session of its own that has no tools: the client's
    /// model answers `text` under `system_prompt`, and the session is closed.
    pub async fn ask(&mut self, system_prompt: &str, text: &str) -> Result<String, String> {
        let response = self
            .rpc(
                "session/new",
                json!({
                    "cwd": self.cwd,
                    "mcpServers": [],
                    "_meta": { "antigravity": { "systemPrompt": { "append": system_prompt } } }
                }),
            )
            .await?;
        let session = response["sessionId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "Antigravity returned no session ID.".to_owned())?
            .to_owned();
        let prompt_id = self.next_id();
        self.dirty = true;
        self.send(json!({
            "jsonrpc": "2.0",
            "id": prompt_id,
            "method": "session/prompt",
            "params": { "sessionId": session, "prompt": [{ "type": "text", "text": text }] },
        }))
        .await?;
        let mut reply = String::new();
        let finished = timeout(ASK_TIMEOUT, async {
            loop {
                let message = self.next_message().await?;
                if message.get("id").and_then(Value::as_u64) == Some(prompt_id) && message.get("method").is_none() {
                    return match message.get("error") {
                        Some(error) => Err(error["message"].as_str().unwrap_or("Antigravity request failed").to_owned()),
                        None => Ok(()),
                    };
                }
                if message.get("id").is_some() && message["method"].as_str() == Some("session/request_permission") {
                    self.send(json!({
                        "jsonrpc": "2.0",
                        "id": message["id"],
                        "result": { "outcome": { "outcome": "cancelled" } },
                    }))
                    .await?;
                    continue;
                }
                let update = &message["params"]["update"];
                if message["method"].as_str() == Some("session/update")
                    && message["params"]["sessionId"].as_str() == Some(session.as_str())
                    && update["sessionUpdate"].as_str() == Some("agent_message_chunk")
                {
                    if let Some(chunk) = update["content"]["text"].as_str() {
                        reply.push_str(chunk);
                    }
                }
            }
        })
        .await;
        match finished {
            Ok(Ok(())) => {
                self.dirty = false;
                self.close_session(&session).await;
                Ok(reply)
            }
            Ok(Err(error)) => Err(error),
            Err(_) => {
                self.cancel_session(&session).await;
                Err("Antigravity took too long to answer.".into())
            }
        }
    }

    pub async fn cancel_session(&mut self, acp_session_id: &str) {
        let _ = self
            .send(json!({
                "jsonrpc": "2.0",
                "method": "session/cancel",
                "params": { "sessionId": acp_session_id },
            }))
            .await;
    }
}

impl Drop for AcpClient {
    fn drop(&mut self) {
        self.stderr.abort();
        let _ = self.child.start_kill();
    }
}

const LOGIN_START_TIMEOUT: Duration = Duration::from_secs(15);
const LOGIN_COMPLETE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_LOGIN_STDERR_BYTES: usize = 16 * 1024;

pub(super) struct LoginSession {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    stderr: tokio::task::JoinHandle<String>,
}

pub(super) enum LoginStartOutcome {
    /// Browser OAuth URL printed by `agy acp --login`; session is waiting on stdin for the code.
    NeedsCode {
        auth_url: String,
        session: Box<LoginSession>,
    },
    /// `agy acp --login` exited cleanly without asking for a code.
    Completed,
}

impl Drop for LoginSession {
    fn drop(&mut self) {
        self.stderr.abort();
        let _ = self.child.start_kill();
    }
}

pub(super) fn extract_auth_url(line: &str) -> Option<String> {
    for token in line.split_whitespace() {
        let candidate = token.trim_matches(|ch| matches!(ch, '"' | '\'' | '<' | '>' | '(' | ')' | ',' | ';'));
        let Ok(parsed) = url::Url::parse(candidate) else {
            continue;
        };
        if parsed.scheme() == "https" && parsed.host_str().is_some() {
            return Some(parsed.to_string());
        }
    }
    None
}

fn summarize_login_output(stdout_lines: &[String], stderr: &str) -> String {
    let detail = stderr
        .lines()
        .chain(stdout_lines.iter().map(String::as_str))
        .map(str::trim)
        .rfind(|line| !line.is_empty() && extract_auth_url(line).is_none());
    match detail {
        Some(message) => format!("Antigravity Google sign-in failed: {message}"),
        None => "Antigravity Google sign-in did not complete.".to_owned(),
    }
}

impl LoginSession {
    pub async fn start(binary: &Path) -> Result<LoginStartOutcome, String> {
        let mut command = Command::new(binary);
        command
            .args(["acp", "--login"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|error| format!("Cannot start Antigravity sign-in: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Antigravity sign-in stdin unavailable.".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Antigravity sign-in stdout unavailable.".to_owned())?;
        let stderr_pipe = child
            .stderr
            .take()
            .ok_or_else(|| "Antigravity sign-in stderr unavailable.".to_owned())?;
        let stderr = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr_pipe);
            let mut out = String::new();
            let mut line = String::new();
            while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                if out.len() < MAX_LOGIN_STDERR_BYTES {
                    out.push_str(&line);
                }
                line.clear();
            }
            out
        });

        let mut reader = BufReader::new(stdout);
        let mut seen_lines = Vec::new();
        let auth_url = timeout(LOGIN_START_TIMEOUT, async {
            let mut line = String::new();
            loop {
                line.clear();
                let read = reader
                    .read_line(&mut line)
                    .await
                    .map_err(|error| format!("Cannot read Antigravity sign-in output: {error}"))?;
                if read == 0 {
                    return Ok::<Option<String>, String>(None);
                }
                if let Some(url) = extract_auth_url(&line) {
                    return Ok(Some(url));
                }
                seen_lines.push(line.trim().to_owned());
            }
        })
        .await
        .map_err(|_| "Timed out waiting for Antigravity sign-in link.".to_owned())??;

        if let Some(auth_url) = auth_url {
            return Ok(LoginStartOutcome::NeedsCode {
                auth_url,
                session: Box::new(Self {
                    child,
                    stdin: Some(stdin),
                    stdout: reader,
                    stderr,
                }),
            });
        }

        drop(stdin);
        let status = timeout(Duration::from_secs(5), child.wait())
            .await
            .map_err(|_| "Antigravity sign-in exited unexpectedly.".to_owned())?
            .map_err(|error| format!("Antigravity sign-in failed: {error}"))?;
        let stderr_text = stderr.await.unwrap_or_default();
        if status.success() {
            Ok(LoginStartOutcome::Completed)
        } else {
            Err(summarize_login_output(&seen_lines, &stderr_text))
        }
    }

    pub async fn complete(mut self, code: &str) -> Result<(), String> {
        let trimmed = code.trim();
        if trimmed.is_empty() {
            return Err("Paste the authorization code or callback URL first.".into());
        }
        let mut stdin = self
            .stdin
            .take()
            .ok_or_else(|| "Antigravity sign-in session is no longer accepting input.".to_owned())?;
        let payload = format!("{trimmed}\n");
        timeout(Duration::from_secs(5), async {
            stdin.write_all(payload.as_bytes()).await?;
            stdin.flush().await
        })
        .await
        .map_err(|_| "Timed out sending authorization code to Antigravity.".to_owned())?
        .map_err(|error| format!("Cannot send authorization code to Antigravity: {error}"))?;
        drop(stdin);

        let mut stdout_lines = Vec::new();
        let status = timeout(LOGIN_COMPLETE_TIMEOUT, async {
            let mut line = String::new();
            while self.stdout.read_line(&mut line).await.unwrap_or(0) > 0 {
                let trimmed_line = line.trim();
                if !trimmed_line.is_empty() {
                    stdout_lines.push(trimmed_line.to_owned());
                }
                line.clear();
            }
            self.child
                .wait()
                .await
                .map_err(|error| format!("Antigravity sign-in failed: {error}"))
        })
        .await
        .map_err(|_| "Timed out waiting for Antigravity to verify the authorization code.".to_owned())??;

        let stderr_text = (&mut self.stderr).await.unwrap_or_default();
        if status.success() {
            Ok(())
        } else {
            Err(summarize_login_output(&stdout_lines, &stderr_text))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_auth_url_finds_https_oauth_link_and_ignores_non_https() {
        let oauth_line = "  https://accounts.google.com/o/oauth2/auth?client_id=abc&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback\n";
        assert_eq!(
            extract_auth_url(oauth_line).as_deref(),
            Some("https://accounts.google.com/o/oauth2/auth?client_id=abc&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback")
        );
        assert_eq!(
            extract_auth_url("Open this link in a browser to log in with Google:\n"),
            None
        );
        assert_eq!(extract_auth_url("http://insecure.example/callback"), None);
    }

    #[test]
    fn permission_outcome_allows_only_scratch_mcp_tools() {
        let options = json!([
            { "optionId": "allow_once_id", "kind": "allow_once" },
            { "optionId": "allow_always_id", "kind": "allow_always" },
            { "optionId": "deny", "kind": "reject_once" },
        ]);
        let mcp_req = json!({
            "toolCall": { "name": "mcp_scratch_edit_document" },
            "options": options,
        });
        assert_eq!(
            permission_outcome(&mcp_req),
            json!({ "outcome": { "outcome": "selected", "optionId": "allow_always_id" } })
        );

        let once_only = json!({
            "toolCall": { "name": "mcp_scratch_read_document" },
            "options": [
                { "optionId": "allow", "kind": "allow_once" },
                { "optionId": "deny", "kind": "reject_once" },
            ],
        });
        assert_eq!(
            permission_outcome(&once_only),
            json!({ "outcome": { "outcome": "selected", "optionId": "allow" } })
        );

        let shell_req = json!({
            "toolCall": { "name": "run_command" },
            "options": options,
        });
        assert_eq!(
            permission_outcome(&shell_req),
            json!({ "outcome": { "outcome": "selected", "optionId": "deny" } })
        );
    }

    #[test]
    fn parse_models_groups_efforts_filters_orchestrators_and_prefixes_ids() {
        let response = json!({
            "models": {
                "availableModels": [
                    { "modelId": "gemini-4-neon-high", "name": "Gemini 4 Neon (High)" },
                    { "modelId": "gemini-4-neon-xhigh", "name": "Gemini 4 Neon (XHigh)" },
                    { "modelId": "gemini-4-neon-low", "name": "Gemini 4 Neon (Low)" },
                    { "modelId": "gemini-pro-orchestrator-neon", "name": "Orchestrator (Neon)" },
                    { "modelId": "gemini-3.8-flash-high", "name": "Gemini 3.8 Flash (High)" },
                    { "modelId": "gemini-3.8-flash-low", "name": "Gemini 3.8 Flash (Low)" },
                    { "modelId": "gpt-oss-120b-medium", "name": "GPT-OSS 120B (Medium)" },
                ]
            },
            "configOptions": [{
                "id": "model",
                "options": [
                    { "value": "gemini-4-neon", "name": "Gemini 4 Neon" },
                    { "value": "gemini-3.8-flash", "name": "Gemini 3.8 Flash" },
                    { "value": "gpt-oss-120b-medium", "name": "GPT-OSS 120B (Medium)" },
                ]
            }]
        });
        let catalog = parse_models(&response);
        assert_eq!(catalog.models.len(), 3);
        assert_eq!(catalog.models[0].id, "agy:gemini-4-neon");
        assert_eq!(catalog.models[0].label, "Gemini 4 Neon");
        assert_eq!(catalog.models[0].efforts, vec!["low", "high", "xhigh"]);
        assert_eq!(catalog.models[0].default_effort.as_deref(), Some("low"));
        assert_eq!(catalog.models[1].id, "agy:gemini-3.8-flash");
        assert_eq!(catalog.models[1].efforts, vec!["low", "high"]);
        assert_eq!(catalog.models[2].id, "agy:gpt-oss-120b-medium");
        assert!(catalog.models[2].efforts.is_empty());
        assert_eq!(
            catalog.variants.get(&("gemini-4-neon".into(), "xhigh".into())).map(String::as_str),
            Some("gemini-4-neon-xhigh")
        );
    }
}

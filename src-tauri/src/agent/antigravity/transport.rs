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

pub(super) struct WarmSession {
    pub acp_session_id: String,
    pub read_only: bool,
    pub last_used: u64,
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
    session_tick: u64,
    pub cached_models: Vec<ModelInfo>,
    variant_map: HashMap<(String, String), String>,
    raw_model_ids: std::collections::HashSet<String>,
    pub dirty: bool,
}

pub(super) fn find_executable() -> Option<PathBuf> {
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
                    .find(|opt| opt["kind"].as_str() == Some("allow_once"))
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
    pub async fn start(app: &tauri::AppHandle) -> Result<Self, String> {
        let binary = find_executable()
            .ok_or_else(|| "Antigravity CLI (`agy`) was not found on this Mac.".to_owned())?;
        let cwd = workspace_dir(app)?;
        tokio::fs::create_dir_all(&cwd)
            .await
            .map_err(|error| format!("Cannot prepare Antigravity workspace: {error}"))?;
        let mcp = McpServer::start().await?;
        Self::spawn(binary, cwd, mcp).await
    }

    async fn spawn(binary: PathBuf, cwd: PathBuf, mcp: McpServer) -> Result<Self, String> {
        let mut command = Command::new(&binary);
        command
            .args(["acp", "--stdio", "--include-default-customizations=false"])
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
            Ok(_) => Ok(()),
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
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    pub async fn discover_models(&mut self) -> Result<Vec<ModelInfo>, String> {
        let response = self
            .rpc(
                "session/new",
                json!({
                    "cwd": self.cwd,
                    "mcpServers": [],
                }),
            )
            .await?;
        let catalog = parse_models(&response);
        if let Some(sid) = response["sessionId"].as_str() {
            let _ = self.rpc("session/close", json!({ "sessionId": sid })).await;
        }
        self.queued.clear();
        if catalog.models.is_empty() {
            return Err("Antigravity returned no models.".into());
        }
        self.store_catalog(catalog);
        Ok(self.cached_models.clone())
    }

    pub async fn ensure_session(
        &mut self,
        chat_session_id: Option<&str>,
        read_only: bool,
        system_prompt: &str,
    ) -> Result<(String, bool), String> {
        self.session_tick += 1;
        if let Some(key) = chat_session_id {
            if let Some(existing) = self.sessions.get_mut(key) {
                if existing.read_only == read_only {
                    existing.last_used = self.session_tick;
                    return Ok((existing.acp_session_id.clone(), true));
                }
                let old_id = existing.acp_session_id.clone();
                self.sessions.remove(key);
                let _ = self
                    .rpc("session/close", json!({ "sessionId": old_id }))
                    .await;
            }
        }
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
        let discovered = parse_models(&response);
        self.store_catalog(discovered);
        if let Some(key) = chat_session_id {
            self.sessions.insert(
                key.to_owned(),
                WarmSession {
                    acp_session_id: acp_session_id.clone(),
                    read_only,
                    last_used: self.session_tick,
                },
            );
            while self.sessions.len() > MAX_WARM_SESSIONS {
                if let Some((oldest_key, oldest)) = self
                    .sessions
                    .iter()
                    .min_by_key(|(_, session)| session.last_used)
                    .map(|(k, v)| (k.clone(), v.acp_session_id.clone()))
                {
                    self.sessions.remove(&oldest_key);
                    let _ = self
                        .rpc("session/close", json!({ "sessionId": oldest }))
                        .await;
                }
            }
        }
        Ok((acp_session_id, false))
    }

    pub async fn close_session(&mut self, acp_session_id: &str) {
        let _ = self
            .rpc("session/close", json!({ "sessionId": acp_session_id }))
            .await;
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

pub(super) async fn run_interactive_login(binary: &Path) -> Result<(), String> {
    let status = Command::new(binary)
        .args(["acp", "--login"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .await
        .map_err(|error| format!("Cannot start Antigravity sign-in: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Antigravity Google sign-in did not complete.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_outcome_allows_only_scratch_mcp_tools() {
        let options = json!([
            { "optionId": "allow", "kind": "allow_once" },
            { "optionId": "deny", "kind": "reject_once" },
        ]);
        let mcp_req = json!({
            "toolCall": { "name": "mcp_scratch_edit_document" },
            "options": options,
        });
        assert_eq!(
            permission_outcome(&mcp_req),
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

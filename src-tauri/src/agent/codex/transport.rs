use std::{collections::VecDeque, path::{Path, PathBuf}, process::Stdio, time::Duration};
use serde_json::{json, Value};
use tauri::Manager;
use tokio::{io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader}, process::{Child, ChildStdin, ChildStdout, Command}, time::timeout};

const RPC_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_MESSAGE_BYTES: usize = 32 * 1024 * 1024;
static CONFIG_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// An owned, private app server. Dropping a cancelled future closes stdin and
/// kills the process; there is no detached dispatcher that can execute tools.
pub(super) struct Server {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    stderr: tokio::task::JoinHandle<()>,
    queued: VecDeque<Value>,
    /// The start of a message still arriving, kept here so a read that is
    /// dropped while waiting loses nothing.
    partial: Vec<u8>,
    request_id: u64,
    pub home: PathBuf,
    pub cwd: PathBuf,
}

pub(super) fn home(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|path| path.join("codex"))
        .map_err(|error| format!("Cannot find Codex app data: {error}"))
}

fn executable(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        if let Some(path) = std::env::var_os("CHATGSD_CODEX_PATH") {
            let path = PathBuf::from(path);
            if path.is_absolute() && path.is_file() { return Ok(path); }
            return Err("CHATGSD_CODEX_PATH must name an absolute Codex executable path".into());
        }
    }
    let bundled = app.path().resource_dir().map_err(|error| error.to_string())?.join("codex/codex");
    if bundled.is_file() { return Ok(bundled); }
    if cfg!(debug_assertions) {
        let resource = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/codex/codex");
        if resource.is_file() { return Ok(resource); }
        return which::which("codex").map_err(|_| "Install Codex or set CHATGSD_CODEX_PATH for development".into());
    }
    Err("The bundled Codex runtime is missing. Reinstall ChatGSD.".into())
}

// These are runtime restrictions, not instructions. Read-only plus rejection
// of every native approval prevents a hallucinated patch from writing notes.
const OVERRIDES: &[&str] = &[
    "cli_auth_credentials_store=\"file\"", "forced_login_method=\"chatgpt\"",
    "approval_policy=\"on-request\"", "sandbox_mode=\"read-only\"",
    "project_doc_max_bytes=0", "web_search=\"disabled\"", "agents.enabled=false",
    "features.shell_tool=false", "features.unified_exec=false", "features.view_image=false",
    "features.hooks=false", "features.plugins=false", "features.apps=false",
    "features.browser_use=false", "features.computer_use=false", "features.multi_agent=false",
    "features.multi_agent_v2=false", "features.js_repl=false", "features.code_mode=false",
    "features.skill_mcp_dependency_install=false", "features.skill_env_var_dependency_prompt=false",
    "features.request_permissions_tool=false", "features.tool_suggest=false",
    "features.workspace_dependencies=false", "features.memories=false",
    "features.use_agent_identity=false", "features.token_budget=false",
    "tools.experimental_request_user_input.enabled=false", "tools.update_plan.enabled=false",
];

impl Server {
    pub async fn start(app: &tauri::AppHandle) -> Result<Self, String> {
        Self::spawn(&executable(app)?, &home(app)?).await
    }

    async fn spawn(binary: &Path, home: &Path) -> Result<Self, String> {
        let _configuration = CONFIG_LOCK.lock().await;
        let cwd = home.join("workspace");
        let user_home = home.join("home");
        tokio::fs::create_dir_all(&cwd).await.map_err(|error| error.to_string())?;
        tokio::fs::create_dir_all(&user_home).await.map_err(|error| error.to_string())?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(home, std::fs::Permissions::from_mode(0o700)).await.map_err(|error| error.to_string())?;
        }
        // This home belongs exclusively to ChatGSD. Never inherit providers,
        // MCP servers, hooks or executable configuration from a CLI profile.
        let config = home.join(format!(".config-{}.tmp", uuid::Uuid::new_v4()));
        tokio::fs::write(&config, "# Managed by ChatGSD; configure skills in the app.\n").await.map_err(|error| error.to_string())?;
        tokio::fs::rename(&config, home.join("config.toml")).await.map_err(|error| error.to_string())?;
        let mut command = Command::new(binary);
        command.arg("app-server").args(["--listen", "stdio://"])
            .env_clear().env("CODEX_HOME", home).env("HOME", &user_home)
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .current_dir(&cwd).kill_on_drop(true)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        // CLI restrictions remain authoritative over native skill configuration.
        for value in OVERRIDES { command.args(["-c", value]); }
        let mut child = command.spawn().map_err(|error| format!("Cannot start Codex: {error}"))?;
        let input = child.stdin.take().ok_or("Codex did not open stdin")?;
        let output = BufReader::new(child.stdout.take().ok_or("Codex did not open stdout")?);
        let mut stderr = child.stderr.take().ok_or("Codex did not open stderr")?;
        // Always drain diagnostics, but never log server output containing private
        // notes, browser observations, or credential-bearing URLs.
        let drain = tokio::spawn(async move {
            let mut bytes = [0; 4096];
            while matches!(stderr.read(&mut bytes).await, Ok(count) if count > 0) {}
        });
        let mut server = Self { child, input, output, stderr: drain, queued: VecDeque::new(), partial: Vec::new(), request_id: 0, home: home.into(), cwd };
        server.rpc("initialize", json!({"clientInfo":{"name":"chatgsd","title":"ChatGSD","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}})).await?;
        server.send(json!({"method":"initialized"})).await?;
        Ok(server)
    }

    pub async fn send(&mut self, message: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        timeout(RPC_TIMEOUT, self.input.write_all(&bytes)).await
            .map_err(|_| "Codex transport write timed out".to_owned())?
            .map_err(|error| format!("Codex transport closed: {error}"))
    }

    async fn read(&mut self) -> Result<Value, String> {
        loop {
            let bytes = self.output.fill_buf().await.map_err(|error| error.to_string())?;
            if bytes.is_empty() {
                return Err("Codex exited unexpectedly. No further tools were dispatched.".into());
            }
            let count = bytes.iter().position(|byte| *byte == b'\n').map_or(bytes.len(), |index| index + 1);
            if self.partial.len() + count > MAX_MESSAGE_BYTES { return Err("Codex exceeded the transport message limit".into()); }
            let complete = bytes[count - 1] == b'\n';
            self.partial.extend_from_slice(&bytes[..count]);
            self.output.consume(count);
            if complete { break; }
        }
        let line = std::mem::take(&mut self.partial);
        serde_json::from_slice(&line).map_err(|error| format!("Invalid Codex protocol message: {error}"))
    }

    pub async fn next(&mut self) -> Result<Value, String> {
        if let Some(message) = self.queued.pop_front() { return Ok(message); }
        self.read().await
    }

    pub async fn rpc(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.request_id += 1;
        let id = self.request_id;
        let exchange = async {
            self.send(json!({"id":id,"method":method,"params":params})).await?;
            loop {
                let message = self.read().await?;
                if message.get("id").and_then(Value::as_u64) == Some(id) && message.get("method").is_none() {
                    if let Some(error) = message.get("error") { return Err(format!("Codex {method}: {error}")); }
                    return message.get("result").cloned().ok_or_else(|| format!("Codex {method} returned no result"));
                }
                if message.get("id").is_some() && message.get("method").is_some() && message["method"] != "item/tool/call" {
                    // Never authorize native execution or permission requests.
                    self.reject(&message).await?;
                } else {
                    if self.queued.len() >= 4096 { return Err("Codex sent too many pending notifications".into()); }
                    self.queued.push_back(message);
                }
            }
        };
        timeout(RPC_TIMEOUT, exchange).await.map_err(|_| format!("Codex {method} timed out"))?
    }

    pub async fn reject(&mut self, message: &Value) -> Result<(), String> {
        self.send(json!({"id":message["id"],"error":{"code":-32601,"message":"ChatGSD permits only its registered dynamic tools; native execution, file changes, permissions, installations and external MCP requests are disabled"}})).await
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
        self.stderr.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Explicitly opt in: CHATGSD_CODEX_PATH=/absolute/codex cargo test codex_runtime -- --ignored
    /// Uses a new empty home, never the developer's credentials or configuration.
    #[tokio::test]
    #[ignore = "requires an explicitly selected installed Codex runtime"]
    async fn codex_runtime_handshake_account_and_dynamic_thread() {
        runtime_dynamic_thread(false, false).await;
    }

    #[tokio::test]
    #[ignore = "requires an explicitly selected installed Codex runtime"]
    async fn codex_runtime_steers_a_working_turn() {
        runtime_dynamic_thread(false, true).await;
    }

    #[tokio::test]
    #[ignore = "requires an explicitly selected installed Codex runtime and its code-mode host"]
    async fn codex_runtime_code_mode_dispatches_document_tools() {
        runtime_dynamic_thread(true, false).await;
    }

    /// `steer` sends the user's follow-up while the first tool call is still open.
    async fn runtime_dynamic_thread(code_mode: bool, steer: bool) {
        let binary = PathBuf::from(std::env::var_os("CHATGSD_CODEX_PATH").expect("select Codex with CHATGSD_CODEX_PATH"));
        let home = std::env::temp_dir().join(format!("chatgsd-codex-test-{}", uuid::Uuid::new_v4()));
        // A local Responses fixture exercises the real Codex runtime without
        // credentials, paid model requests, or access to the developer's notes.
        let provider = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = format!("http://{}", provider.server_addr());
        let fixture = std::thread::spawn(move || {
            for round in 0..2 {
                let mut request = provider.recv_timeout(Duration::from_secs(30)).unwrap().expect("Codex model request");
                let mut body = String::new();
                request.as_reader().read_to_string(&mut body).unwrap();
                if round == 1 { assert!(body.contains("Unsaved live note")); }
                assert_eq!(body.contains("Use British spelling."), steer && round == 1, "steering reaches the model's next request only");
                let item = if round == 0 && code_mode {
                    json!({"type":"custom_tool_call","id":"tool-item","call_id":"read-live","name":"exec","input":"text(await tools.scratch__read_document({}));","status":"completed"})
                } else if round == 0 {
                    json!({"type":"function_call","id":"tool-item","call_id":"read-live","namespace":"scratch","name":"read_document","arguments":"{}","status":"completed"})
                } else {
                    json!({"type":"message","id":"answer","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Read the unsaved note.","annotations":[]}]})
                };
                let events = [
                    json!({"type":"response.created","response":{"id":format!("response-{round}"),"status":"in_progress","output":[]}}),
                    json!({"type":"response.output_item.added","output_index":0,"item":item}),
                    json!({"type":"response.output_item.done","output_index":0,"item":item}),
                    json!({"type":"response.completed","response":{"id":format!("response-{round}"),"status":"completed","output":[item],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}),
                ];
                let body = events.iter().map(|event| format!("data: {event}\n\n")).collect::<String>();
                request.respond(tiny_http::Response::from_string(body).with_header(
                    tiny_http::Header::from_bytes("Content-Type", "text/event-stream").unwrap()
                )).unwrap();
            }
        });
        let mut server = Server::spawn(&binary, &home).await.unwrap();
        let account = server.rpc("account/read", json!({"refreshToken":false})).await.unwrap();
        assert!(account["account"].is_null());
        let config = json!({
            "model_provider":"fixture",
            "model_providers.fixture":{"name":"Local fixture","base_url":address,"wire_api":"responses","requires_openai_auth":false},
            "features.enable_request_compression":false,
            "features.code_mode":code_mode
        });
        let started = server.rpc("thread/start", json!({
            "model":if code_mode { "gpt-6.1-sol" } else { "gpt-5.4" },"config":config,"cwd":server.cwd,"sandbox":"read-only","approvalPolicy":"on-request",
            "dynamicTools":[{"type":"namespace","name":"scratch","description":"Live editor","tools":[
                super::super::dynamic_tool("read_document", "Read the live document", json!({"type":"object","properties":{}}))
            ]}]
        })).await.unwrap();
        let thread = started["thread"]["id"].as_str().unwrap().to_owned();
        let started = server.rpc("turn/start", json!({"threadId":thread,"input":[{"type":"text","text":"Read the live note.","text_elements":[]}]})).await.unwrap();
        let turn = started["turn"]["id"].clone();
        let mut saw_tool = false;
        let mut saw_answer = false;
        timeout(Duration::from_secs(30), async {
            loop {
                let message = server.next().await.unwrap();
                if message["method"] == "item/tool/call" {
                    assert_eq!(message["params"]["tool"], "read_document");
                    assert_eq!(message["params"]["namespace"], "scratch");
                    saw_tool = true;
                    if steer {
                        let steered = server.rpc("turn/steer", json!({"threadId":thread,"expectedTurnId":turn,
                            "input":[{"type":"text","text":"Use British spelling.","text_elements":[]}]})).await.unwrap();
                        assert_eq!(steered["turnId"], turn);
                    }
                    server.send(json!({"id":message["id"],"result":{"success":true,"contentItems":[{"type":"inputText","text":"Unsaved live note"}]}})).await.unwrap();
                } else if message.get("id").is_some() {
                    server.reject(&message).await.unwrap();
                } else if message["method"] == "item/completed" && message["params"]["item"]["type"] == "agentMessage" {
                    saw_answer = message["params"]["item"]["text"] == "Read the unsaved note.";
                } else if message["method"] == "turn/completed" && message["params"]["turn"]["id"] == turn {
                    assert_eq!(message["params"]["turn"]["status"], "completed", "{message}");
                    break;
                }
            }
        }).await.unwrap();
        assert!(saw_tool && saw_answer);
        fixture.join().unwrap();
        server.child.start_kill().unwrap();
        server.child.wait().await.unwrap();
        drop(server);
        let mut server = Server::spawn(&binary, &home).await.unwrap();
        let resumed = server.rpc("thread/resume", json!({"threadId":thread,"config":config,"sandbox":"read-only","approvalPolicy":"on-request"})).await.unwrap();
        assert_eq!(resumed["thread"]["id"], thread);
        server.child.start_kill().unwrap();
        server.child.wait().await.unwrap();
        drop(server);
        tokio::fs::remove_dir_all(home).await.unwrap();
    }

    /// The model refuses the turn as too long; the thread is compacted and
    /// the same message is sent again over the summary.
    #[tokio::test]
    #[ignore = "requires an explicitly selected installed Codex runtime"]
    async fn codex_runtime_compacts_and_retries_a_turn_that_exceeds_the_window() {
        let binary = PathBuf::from(std::env::var_os("CHATGSD_CODEX_PATH").expect("select Codex with CHATGSD_CODEX_PATH"));
        let home = std::env::temp_dir().join(format!("chatgsd-codex-test-{}", uuid::Uuid::new_v4()));
        let provider = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = format!("http://{}", provider.server_addr());
        let fixture = std::thread::spawn(move || {
            let message = |id: &str, text: &str| json!({"type":"message","id":id,"role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]});
            let mut bodies = Vec::new();
            for round in 0..3 {
                let mut request = provider.recv_timeout(Duration::from_secs(30)).unwrap().expect("Codex model request");
                let mut body = String::new();
                request.as_reader().read_to_string(&mut body).unwrap();
                bodies.push(body);
                let events = if round == 0 {
                    vec![json!({"type":"response.failed","response":{"id":"response-0","status":"failed","error":{"code":"context_length_exceeded","message":"Your input exceeds the context window of this model."}}})]
                } else {
                    let item = if round == 1 { message("summary", "Fixture summary of the plan.") } else { message("answer", "Tightened the opening.") };
                    vec![
                        json!({"type":"response.created","response":{"id":format!("response-{round}"),"status":"in_progress","output":[]}}),
                        json!({"type":"response.output_item.added","output_index":0,"item":item}),
                        json!({"type":"response.output_item.done","output_index":0,"item":item}),
                        json!({"type":"response.completed","response":{"id":format!("response-{round}"),"status":"completed","output":[item],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}),
                    ]
                };
                let body = events.iter().map(|event| format!("data: {event}\n\n")).collect::<String>();
                request.respond(tiny_http::Response::from_string(body).with_header(
                    tiny_http::Header::from_bytes("Content-Type", "text/event-stream").unwrap()
                )).unwrap();
            }
            bodies
        });
        let mut server = Server::spawn(&binary, &home).await.unwrap();
        let config = json!({
            "model_provider":"fixture",
            "model_providers.fixture":{"name":"Local fixture","base_url":address,"wire_api":"responses","requires_openai_auth":false,"request_max_retries":0,"stream_max_retries":0},
            "features.enable_request_compression":false
        });
        let started = server.rpc("thread/start", json!({"model":"gpt-5.4","config":config,"cwd":server.cwd,"sandbox":"read-only","approvalPolicy":"on-request"})).await.unwrap();
        let thread = started["thread"]["id"].as_str().unwrap().to_owned();
        let turn_params = json!({"threadId":thread,"input":[{"type":"text","text":"Tighten the opening.","text_elements":[]}]});
        async fn finished(server: &mut Server, turn: &Value) -> Value {
            loop {
                let message = server.next().await.unwrap();
                if message.get("id").is_some() { server.reject(&message).await.unwrap(); }
                else if message["method"] == "turn/completed" && message["params"]["turn"]["id"] == *turn { return message["params"]["turn"].clone(); }
            }
        }
        timeout(Duration::from_secs(60), async {
            let started = server.rpc("turn/start", turn_params.clone()).await.unwrap();
            let failed = finished(&mut server, &started["turn"]["id"]).await;
            assert!(super::super::overflowed(&failed), "{failed}");
            super::super::compact_thread(&mut server, &thread).await.unwrap();
            let started = server.rpc("turn/start", turn_params.clone()).await.unwrap();
            let retried = finished(&mut server, &started["turn"]["id"]).await;
            assert_eq!(retried["status"], "completed", "{retried}");
        }).await.unwrap();
        let bodies = fixture.join().unwrap();
        assert!(bodies[2].contains("Fixture summary of the plan."), "the retry is sent over the compacted context");
        assert!(bodies[2].contains("Tighten the opening."));
        server.child.start_kill().unwrap();
        server.child.wait().await.unwrap();
        drop(server);
        tokio::fs::remove_dir_all(home).await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires an explicitly selected installed Codex runtime"]
    async fn codex_runtime_browser_login_can_be_cancelled_without_opening_browser() {
        let binary = PathBuf::from(std::env::var_os("CHATGSD_CODEX_PATH").expect("select Codex with CHATGSD_CODEX_PATH"));
        let home = std::env::temp_dir().join(format!("chatgsd-codex-auth-test-{}", uuid::Uuid::new_v4()));
        let mut server = Server::spawn(&binary, &home).await.unwrap();
        let login = server.rpc("account/login/start", json!({"type":"chatgpt"})).await.unwrap();
        assert_eq!(login["type"], "chatgpt");
        let url = url::Url::parse(login["authUrl"].as_str().unwrap()).unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("auth.openai.com"));
        let cancelled = server.rpc("account/login/cancel", json!({"loginId":login["loginId"]})).await.unwrap();
        assert_eq!(cancelled["status"], "canceled");
        let account = server.rpc("account/read", json!({"refreshToken":false})).await.unwrap();
        assert!(account["account"].is_null());
        drop(server);
        tokio::fs::remove_dir_all(home).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn interleaved_requests_are_denied_or_queued_before_rpc_result() {
        use std::os::unix::fs::PermissionsExt;
        let home = std::env::temp_dir().join(format!("chatgsd-codex-wire-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&home).await.unwrap();
        let script = home.join("server");
        tokio::fs::write(&script, r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{"method":"warning","params":{"message":"early notification"}}' '{"id":1,"result":{}}'
      ;;
    *'"method":"thread/start"'*)
      printf '%s\n' '{"id":"deny-native","method":"item/fileChange/requestApproval","params":{}}' '{"id":"dynamic","method":"item/tool/call","params":{"tool":"read_document","callId":"call","threadId":"thread","turnId":"turn","arguments":{}}}' '{"id":2,"result":{"thread":{"id":"thread"}}}'
      ;;
    *'"id":"deny-native"'*)
      case "$line" in *'"error"'*) printf '%s\n' '{"method":"denied","params":{}}' ;; *) exit 7 ;; esac
      ;;
    *'"method":"ping"'*) printf '%s\n' '{"id":3,"result":{"ok":true}}' ;;
  esac
done
"#).await.unwrap();
        tokio::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).await.unwrap();
        let mut server = Server::spawn(&script, &home).await.unwrap();
        let response = server.rpc("thread/start", json!({})).await.unwrap();
        assert_eq!(response["thread"]["id"], "thread");
        assert_eq!(server.next().await.unwrap()["method"], "warning");
        let request = server.next().await.unwrap();
        assert_eq!(request["method"], "item/tool/call");
        assert_eq!(request["id"], "dynamic");
        assert_eq!(server.rpc("ping", json!({})).await.unwrap()["ok"], true);
        assert_eq!(server.next().await.unwrap()["method"], "denied");
        server.child.start_kill().unwrap();
        server.child.wait().await.unwrap();
        drop(server);
        tokio::fs::remove_dir_all(home).await.unwrap();
    }
}

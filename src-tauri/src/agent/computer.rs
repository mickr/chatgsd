use super::computer_permissions::ComputerUnavailable;
#[cfg(any(target_os = "macos", test))]
use super::computer_permissions::ComputerPermission;
use serde_json::{json, Value};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Mutex, MutexGuard},
    time::{timeout, Instant},
};

const CALL_TIMEOUT: Duration = Duration::from_secs(60);
const START_TIMEOUT: Duration = Duration::from_secs(15);
static CONTROLLER: Mutex<()> = Mutex::const_new(());
const ALLOWED: &[&str] = &[
    "list_apps", "list_windows", "launch_app", "get_window_state",
    "get_browser_state", "browser_prepare", "browser_click", "browser_type",
    "browser_scroll", "browser_select", "browser_navigate", "browser_press_key",
    "click", "type_text", "set_value", "scroll", "press_key", "hotkey", "verify_state",
];
const HIDDEN_ARGUMENTS: &[&str] = &[
    "session", "screenshot_out_file", "additional_arguments", "webkit_inspector_port",
    "creates_new_application_instance",
];

/// One private runtime per opted-in run. Keeping the handles and lock here makes
/// cancellation during startup or a tool call close the same owned processes.
pub struct ComputerSession {
    daemon: Option<Child>,
    proxy: Option<Child>,
    input: Option<ChildStdin>,
    output: Option<BufReader<ChildStdout>>,
    directory: PathBuf,
    catalog: Vec<Value>,
    request_id: u64,
    stopped: bool,
    _controller: MutexGuard<'static, ()>,
}

impl ComputerSession {
    pub async fn start(host_bundle_id: &str) -> Result<Self, ComputerUnavailable> {
        let controller = CONTROLLER.try_lock()
            .map_err(|_| "Another ChatGSD agent is using the computer. Stop that run first.")?;
        let binary = resolve_binary()?;
        let id = uuid::Uuid::new_v4().to_string();
        #[cfg(unix)]
        let directory = PathBuf::from("/tmp").join(format!("scratch-cua-{id}"));
        #[cfg(not(unix))]
        let directory = std::env::temp_dir().join(format!("scratch-cua-{id}"));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&directory).map_err(|e| format!("Cannot create private Cua directory: {e}"))?;
        #[cfg(windows)]
        let socket = PathBuf::from(format!(r"\\.\pipe\scratch-cua-{id}"));
        #[cfg(not(windows))]
        let socket = directory.join("driver.sock");
        let mut session = Self {
            daemon: None, proxy: None, input: None, output: None, directory,
            catalog: Vec::new(), request_id: 0, stopped: false, _controller: controller,
        };
        let mut daemon = command(&binary);
        daemon.args(["serve", "--embedded", "--permission-mode", "standard", "--grant", "existing-profile"])
            .arg("--socket").arg(&socket)
            .arg("--pid-file").arg(session.directory.join("driver.pid"))
            .env("CUA_DRIVER_HOST_BUNDLE_ID", host_bundle_id)
            // The daemon watches EOF on this private pipe, including abrupt host death.
            .env("CUA_DRIVER_PARENT_LIVENESS_STDIN", "1")
            .stdin(Stdio::piped()).stdout(Stdio::null());
        session.daemon = Some(daemon.spawn().map_err(|e| format!("Cannot start Cua Driver: {e}"))?);
        let deadline = Instant::now() + START_TIMEOUT;
        loop {
            if session.daemon.as_mut().unwrap().try_wait().map_err(|e| e.to_string())?.is_some() {
                return Err("Cua Driver exited during startup. Check the installed driver and ChatGSD's permissions.".into());
            }
            if socket_ready(&socket).await { break; }
            if Instant::now() >= deadline {
                return Err("Cua Driver did not become ready within 15 seconds.".into());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let mut proxy = command(&binary);
        proxy.args(["mcp", "--embedded", "--socket"]).arg(&socket)
            .stdin(Stdio::piped()).stdout(Stdio::piped());
        session.proxy = Some(proxy.spawn().map_err(|e| format!("Cannot connect to Cua Driver: {e}"))?);
        let child = session.proxy.as_mut().unwrap();
        session.input = child.stdin.take();
        session.output = child.stdout.take().map(BufReader::new);
        session.rpc("initialize", json!({
            "protocolVersion":"2024-11-05", "capabilities":{},
            "clientInfo":{"name":"ChatGSD","version":env!("CARGO_PKG_VERSION")}
        })).await?;
        session.send(json!({"jsonrpc":"2.0","method":"notifications/initialized"})).await?;
        #[cfg(target_os = "macos")]
        {
            let result = session.rpc("tools/call", json!({"name":"check_permissions","arguments":{}})).await?;
            let permissions = structured(&result);
            check_permissions(&permissions)?;
        }
        let mut cursor: Option<String> = None;
        loop {
            let params = cursor.as_ref().map(|value| json!({"cursor":value})).unwrap_or_else(|| json!({}));
            let page = session.rpc("tools/list", params).await?;
            let tools = page.get("tools").and_then(Value::as_array).ok_or("Cua returned an invalid tool catalog")?;
            for tool in tools {
                let Some(name) = tool.get("name").and_then(Value::as_str) else { continue };
                if !ALLOWED.contains(&name) { continue; }
                let Some(mut schema) = tool.get("inputSchema").cloned() else { continue };
                narrow_schema(&mut schema);
                session.catalog.push(json!({
                    "type":"function","name":format!("cua_{name}"),
                    "description":tool.get("description").and_then(Value::as_str).unwrap_or(name),
                    "parameters":schema
                }));
            }
            let next = page.get("nextCursor").and_then(Value::as_str).map(str::to_owned);
            if next.is_none() { break; }
            if next == cursor { return Err("Cua repeated its tool catalog cursor".into()); }
            cursor = next;
        }
        if session.catalog.is_empty() { return Err("Cua Driver exposed no supported computer tools.".into()); }
        Ok(session)
    }

    pub fn tools(&self) -> Vec<Value> { self.catalog.clone() }

    pub async fn call(&mut self, name: &str, args: Value) -> Result<Value, String> {
        if self.stopped { return Err("Computer access has ended. Start a new message to reconnect.".into()); }
        if !self.catalog.iter().any(|tool| tool["name"] == name) {
            return Err("This computer tool is not available.".into());
        }
        validate_arguments(&args)?;
        if !args.is_object() { return Err("Computer tool arguments must be an object.".into()); }
        let tool = name.strip_prefix("cua_").ok_or("Invalid computer tool name")?;
        self.rpc("tools/call", json!({"name":tool,"arguments":args})).await
    }

    async fn send(&mut self, message: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        let input = self.input.as_mut().ok_or("Cua connection is closed")?;
        timeout(CALL_TIMEOUT, input.write_all(&bytes)).await
            .map_err(|_| "Cua write timed out. The action's outcome is unknown.")?
            .map_err(|e| format!("Cua connection failed: {e}"))
    }

    async fn rpc(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.request_id += 1;
        let id = self.request_id;
        let exchange = async {
            self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})).await?;
            loop {
                let mut line = String::new();
                let read = self.output.as_mut().ok_or("Cua connection is closed")?
                    .read_line(&mut line).await.map_err(|e| e.to_string())?;
                if read == 0 { return Err("Cua connection closed. The last action's outcome may be unknown.".into()); }
                let response: Value = serde_json::from_str(&line).map_err(|e| format!("Invalid Cua response: {e}"))?;
                if response.get("id").and_then(Value::as_u64) != Some(id) {
                    // Notifications are allowed, but never authorize server-initiated requests.
                    if response.get("method").is_some() && response.get("id").is_some() {
                        self.send(json!({"jsonrpc":"2.0","id":response["id"],"error":{"code":-32601,"message":"Host requests are not supported"}})).await?;
                    }
                    continue;
                }
                if let Some(error) = response.get("error") { return Err(format!("Cua refused the request: {error}")); }
                return response.get("result").cloned().ok_or_else(|| "Cua returned no result".into());
            }
        };
        match timeout(CALL_TIMEOUT, exchange).await {
            Ok(Ok(result)) => Ok(result),
            result => {
                self.terminate();
                match result {
                    Ok(Err(error)) => Err(error),
                    _ => Err("Cua timed out; computer access has ended. The last action may have happened. Do not replay it without checking.".into()),
                }
            }
        }
    }

    pub async fn shutdown(&mut self) {
        if !self.stopped {
            // End the transport's implicit lifecycle before stopping its runtime.
            let _ = timeout(Duration::from_secs(5), self.rpc("tools/call", json!({"name":"end_session","arguments":{}}))).await;
        }
        self.terminate();
        for child in [&mut self.proxy, &mut self.daemon].into_iter().flatten() {
            let _ = timeout(Duration::from_secs(2), child.wait()).await;
        }
    }

    fn terminate(&mut self) {
        self.stopped = true;
        self.input.take();
        if let Some(child) = self.proxy.as_mut() { let _ = child.start_kill(); }
        if let Some(child) = self.daemon.as_mut() {
            child.stdin.take();
            let _ = child.start_kill();
        }
    }
}

impl Drop for ComputerSession {
    fn drop(&mut self) {
        self.terminate();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn command(binary: &PathBuf) -> Command {
    let mut command = Command::new(binary);
    // Do not inherit a permissive Cua profile, HTTP listener or debug settings.
    command.env_clear();
    for key in ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "DISPLAY", "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG", "LC_ALL",
        "SYSTEMROOT", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA"] {
        if let Some(value) = std::env::var_os(key) { command.env(key, value); }
    }
    command.env("CUA_DRIVER_EMBEDDED", "1").kill_on_drop(true).stderr(Stdio::null());
    command
}

async fn socket_ready(socket: &std::path::Path) -> bool {
    #[cfg(unix)]
    { tokio::net::UnixStream::connect(socket).await.is_ok() }
    #[cfg(windows)]
    { tokio::net::windows::named_pipe::ClientOptions::new().open(socket).is_ok() }
    #[cfg(not(any(unix, windows)))]
    { let _ = socket; false }
}

fn resolve_binary() -> Result<PathBuf, String> {
    resolve_binary_at(
        std::env::var_os("CUA_DRIVER_PATH").map(PathBuf::from),
        std::env::current_exe().ok(),
    )
}

fn resolve_binary_at(override_path: Option<PathBuf>, executable: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(path) = override_path {
        return path.is_file().then_some(path).ok_or_else(|| "CUA_DRIVER_PATH does not name a driver executable.".into());
    }
    // Tauri places sidecars beside the host executable, including inside the
    // signed .app. This works without a shell PATH or a separate installation.
    if let Some(directory) = executable.as_deref().and_then(std::path::Path::parent) {
        let bundled = directory.join(if cfg!(windows) { "cua-driver.exe" } else { "cua-driver" });
        if bundled.is_file() { return Ok(bundled); }
    }
    let mut paths = vec![PathBuf::from("/Applications/CuaDriver.app/Contents/MacOS/cua-driver")];
    if let Some(home) = std::env::var_os("HOME") { paths.push(PathBuf::from(home).join(".local/bin/cua-driver")); }
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path).map(|path| path.join(if cfg!(windows) { "cua-driver.exe" } else { "cua-driver" })));
    }
    paths.extend(["/opt/homebrew/bin/cua-driver", "/usr/local/bin/cua-driver"].map(PathBuf::from));
    paths.into_iter().find(|path| path.is_file()).ok_or_else(|| "Cua Driver is missing from this ChatGSD installation. Reinstall or update ChatGSD. For source builds, prepare the bundled driver or set CUA_DRIVER_PATH.".into())
}

#[cfg(target_os = "macos")]
fn structured(result: &Value) -> Value {
    if let Some(value) = result.get("structuredContent") { return value.clone(); }
    result.get("content").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .find_map(|text| serde_json::from_str(text).ok()).unwrap_or(Value::Null)
}

#[cfg(any(target_os = "macos", test))]
fn check_permissions(permissions: &Value) -> Result<(), ComputerUnavailable> {
    let missing: Vec<_> = [
        ("accessibility", ComputerPermission::Accessibility),
        ("screen_recording", ComputerPermission::ScreenRecording),
    ].into_iter().filter_map(|(key, permission)| {
        (permissions.get(key).and_then(Value::as_bool) != Some(true)).then_some(permission)
    }).collect();
    if missing.is_empty() { return Ok(()); }
    let names = missing.iter().map(|permission| match permission {
        ComputerPermission::Accessibility => "Accessibility",
        ComputerPermission::ScreenRecording => "Screen Recording",
    }).collect::<Vec<_>>().join(" and ");
    Err(ComputerUnavailable {
        message: format!("To interact with other apps, enable {names} for ChatGSD in System Settings. If macOS asks you to quit and reopen ChatGSD, do so to apply the change."),
        permissions: missing,
    })
}

fn narrow_schema(schema: &mut Value) {
    match schema {
        Value::Object(object) => {
            if let Some(properties) = object.get_mut("properties").and_then(Value::as_object_mut) {
                for key in HIDDEN_ARGUMENTS { properties.remove(*key); }
                for (key, allowed) in [("delivery_mode", "background"), ("scope", "window")] {
                    if let Some(property) = properties.get_mut(key) {
                        *property = json!({"type":"string","enum":[allowed]});
                    }
                }
                if let Some(kind) = properties.get_mut("kind") {
                    if kind.get("enum").and_then(Value::as_array)
                        .is_some_and(|values| values.iter().any(|value| value == "desktop"))
                    {
                        *kind = json!({"type":"string","enum":["window"]});
                    }
                }
            }
            if let Some(required) = object.get_mut("required").and_then(Value::as_array_mut) {
                required.retain(|key| !key.as_str().is_some_and(|key| HIDDEN_ARGUMENTS.contains(&key)));
            }
            for value in object.values_mut() { narrow_schema(value); }
        }
        Value::Array(values) => for value in values { narrow_schema(value); },
        _ => {}
    }
}

fn validate_arguments(value: &Value) -> Result<(), String> {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if key.starts_with('_') || HIDDEN_ARGUMENTS.contains(&key.as_str()) {
                    return Err(format!("Computer argument {key} is owned by ChatGSD."));
                }
                if key == "delivery_mode" && value.as_str() != Some("background") {
                    return Err("Foreground computer control is not enabled.".into());
                }
                if key == "scope" && value.as_str() != Some("window") {
                    return Err("Desktop input is not enabled. Use an exact background window.".into());
                }
                if key == "kind" && value.as_str() == Some("desktop") {
                    return Err("Desktop input is not enabled. Use an exact background window.".into());
                }
                if key == "pid" && value.as_u64() == Some(std::process::id() as u64) {
                    return Err("Use ChatGSD's document tools for this editor, not computer input.".into());
                }
                if key == "urls" {
                    let urls = value.as_array().ok_or("App URLs must be an array")?;
                    for url in urls {
                        let parsed = url.as_str().and_then(|url| url::Url::parse(url).ok()).ok_or("Invalid app URL")?;
                        if !matches!(parsed.scheme(), "http" | "https") {
                            return Err("Only web URLs may be opened through computer tools.".into());
                        }
                    }
                }
                validate_arguments(value)?;
            }
        }
        Value::Array(values) => for value in values { validate_arguments(value)?; },
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_recovery_targets_only_missing_grants() {
        assert!(check_permissions(&json!({"accessibility":true,"screen_recording":true})).is_ok());
        let issue = check_permissions(&json!({"accessibility":true,"screen_recording":false})).unwrap_err();
        assert_eq!(issue.permissions, vec![ComputerPermission::ScreenRecording]);
        assert!(issue.message.contains("Screen Recording"));
        assert!(!issue.message.contains("Accessibility"));
        let issue = check_permissions(&json!({"accessibility":false,"screen_recording":true})).unwrap_err();
        assert_eq!(issue.permissions, vec![ComputerPermission::Accessibility]);
        // An incomplete driver response must never grant computer access.
        let issue = check_permissions(&Value::Null).unwrap_err();
        assert_eq!(issue.permissions, vec![ComputerPermission::Accessibility, ComputerPermission::ScreenRecording]);
    }

    #[test]
    fn resolves_bundled_driver_and_honors_explicit_override() {
        let root = std::env::temp_dir().join(format!("chatgsd-driver-test-{}", uuid::Uuid::new_v4()));
        let app = root.join("ChatGSD.app/Contents/MacOS");
        std::fs::create_dir_all(&app).unwrap();
        let host = app.join("ChatGSD");
        let bundled = app.join(if cfg!(windows) { "cua-driver.exe" } else { "cua-driver" });
        let custom = root.join("custom-driver");
        std::fs::write(&bundled, b"bundled").unwrap();
        std::fs::write(&custom, b"custom").unwrap();

        assert_eq!(resolve_binary_at(None, Some(host.clone())).unwrap(), bundled);
        assert_eq!(resolve_binary_at(Some(custom.clone()), Some(host.clone())).unwrap(), custom);
        // A bad explicit override must not silently run a different executable.
        assert!(resolve_binary_at(Some(root.join("missing")), Some(host)).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_nested_scope_and_host_overrides() {
        for args in [
            json!({"target":{"kind":"desktop"}}),
            json!({"target":{"kind":"window","pid":std::process::id()}}),
            json!({"delivery_mode":"foreground"}),
            json!({"_session_id":"other"}),
            json!({"screenshot_out_file":"/tmp/private.png"}),
            json!({"additional_arguments":["--execute","command"]}),
            json!({"urls":["file:///etc/passwd"]}),
        ] { assert!(validate_arguments(&args).is_err(), "{args}"); }
        assert!(validate_arguments(&json!({"target":{"kind":"window","pid":0,"window_id":7},"delivery_mode":"background","element_token":"snapshot:1"})).is_ok());
    }

    #[test]
    fn legacy_desktop_scope_is_rejected_and_not_advertised() {
        assert!(validate_arguments(&json!({"scope":"desktop","text":"unsafe input"})).is_err());
        assert!(validate_arguments(&json!({"scope":"window","pid":1,"window_id":7,"text":"window input"})).is_ok());
        let mut schema = json!({
            "type":"object",
            "properties":{
                "scope":{"type":"string","enum":["window","desktop"],"default":"window"},
                "target":{"type":"object","properties":{
                    "kind":{"type":"string","enum":["window","desktop"]},
                    "pid":{"type":"integer"}
                }},
                "strategy":{"type":"object","properties":{
                    "kind":{"type":"string","enum":["existing_profile"]}
                }},
                "delivery_mode":{"type":"string","enum":["background","foreground"]}
            }
        });
        narrow_schema(&mut schema);
        assert_eq!(schema["properties"]["scope"]["enum"], json!(["window"]));
        assert_eq!(schema["properties"]["target"]["properties"]["kind"]["enum"], json!(["window"]));
        assert_eq!(schema["properties"]["delivery_mode"]["enum"], json!(["background"]));
        assert_eq!(schema["properties"]["strategy"]["properties"]["kind"]["enum"], json!(["existing_profile"]));
    }

    #[test]
    fn destructive_and_unbounded_tools_are_not_exposed() {
        for tool in ["run_script", "run_steps", "browser_evaluate", "get_desktop_state",
            "browser_upload", "close_app", "set_agent_cursor_enabled"] {
            assert!(!ALLOWED.contains(&tool), "{tool}");
        }
    }
}

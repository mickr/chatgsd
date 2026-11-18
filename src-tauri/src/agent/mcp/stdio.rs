//! The client side of MCP's stdio transport: the server is a program ChatGSD
//! starts, and JSON-RPC messages travel as lines on its stdin and stdout. The
//! program runs as the user, with what `mcp.json` gives it, for as long as the
//! server is on.
use super::client::{self, Error, Rpc};
use super::config::Launch;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::oneshot;

/// A first run may download the server before it can answer.
const START_TIMEOUT: Duration = Duration::from_secs(90);
/// How long a program has to stop by itself once its stdin is closed.
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_LINE_BYTES: u64 = 8_000_000;
/// The most of what a program wrote to stderr that an error quotes.
const MAX_ERROR_CHARS: usize = 400;
const PATH_MARKER: &str = "__CHATGSD_PATH__";

type Input = Arc<tokio::sync::Mutex<ChildStdin>>;

/// Requests waiting for the program's answer.
#[derive(Default)]
struct Waiting {
    replies: HashMap<u64, oneshot::Sender<Value>>,
    /// The program's output ended: nothing more will be answered.
    closed: bool,
}

pub struct Process {
    /// What started it, to tell when `mcp.json` has since changed.
    pub launch: Launch,
    label: String,
    input: Input,
    waiting: Arc<Mutex<Waiting>>,
    errors: Arc<Mutex<String>>,
    child: Option<Child>,
}

/// A leading `~` as the user's home folder, which no shell is there to expand.
fn expand(text: &str) -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    match (text.strip_prefix('~'), home) {
        (Some(""), Some(home)) => home,
        (Some(rest), Some(home)) if rest.starts_with('/') => home.join(&rest[1..]),
        _ => PathBuf::from(text),
    }
}

async fn shell_path() -> Option<OsString> {
    let shell = std::env::var_os("SHELL")?;
    let script = format!("printf '\\n{PATH_MARKER}%s\\n' \"$PATH\"");
    let run = Command::new(shell).args(["-ilc", &script])
        .stdin(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true).output();
    let output = tokio::time::timeout(Duration::from_secs(5), run).await.ok()?.ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let path = text.lines().rev().find_map(|line| line.strip_prefix(PATH_MARKER))?;
    (!path.is_empty()).then(|| path.into())
}

/// Where the user's shell looks for programs. An app opened from Finder is
/// given only the system's folders, without the ones `npx` or `uvx` live in.
async fn search_path() -> &'static OsString {
    static SEARCH_PATH: tokio::sync::OnceCell<OsString> = tokio::sync::OnceCell::const_new();
    SEARCH_PATH.get_or_init(|| async {
        match shell_path().await {
            Some(path) => path,
            None => {
                let mut folders: Vec<PathBuf> = std::env::var_os("PATH").iter().flat_map(std::env::split_paths).collect();
                folders.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
                std::env::join_paths(folders).unwrap_or_default()
            }
        }
    }).await
}

/// The next line of the program's output. `None` when the output ends, or
/// sends a line too long to be a message.
async fn next_line(output: &mut BufReader<ChildStdout>, line: &mut Vec<u8>) -> Option<()> {
    line.clear();
    let read = output.take(MAX_LINE_BYTES).read_until(b'\n', line).await.ok()?;
    (read > 0 && line.ends_with(b"\n")).then_some(())
}

async fn write(input: &Input, message: &Value) -> std::io::Result<()> {
    let mut input = input.lock().await;
    input.write_all(format!("{message}\n").as_bytes()).await?;
    input.flush().await
}

/// Hands each response to the request waiting for it. The program may ask
/// things of this client too; it offers no capabilities, and says so. Its
/// stdin is only borrowed here, so dropping the `Process` closes it.
async fn listen(output: ChildStdout, input: Weak<tokio::sync::Mutex<ChildStdin>>, waiting: Arc<Mutex<Waiting>>, errors: tokio::task::JoinHandle<()>) {
    let mut output = BufReader::new(output);
    let mut line = Vec::new();
    while next_line(&mut output, &mut line).await.is_some() {
        // A program that prints something else on stdout is read past.
        let Ok(message) = serde_json::from_slice::<Value>(&line) else { continue };
        let id = message.get("id").filter(|id| !id.is_null()).cloned();
        match (message.get("method").and_then(Value::as_str), id) {
            (Some(method), Some(id)) => {
                let answer = match method {
                    "ping" => json!({"jsonrpc":"2.0","id":id,"result":{}}),
                    _ => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"ChatGSD doesn't answer this request"}}),
                };
                // Not awaited here: a program busy writing must still be read.
                if let Some(input) = input.upgrade() {
                    tokio::spawn(async move { let _ = write(&input, &answer).await; });
                }
            }
            (None, Some(id)) => {
                let reply = id.as_u64().and_then(|id| waiting.lock().expect("mcp replies mutex").replies.remove(&id));
                if let Some(reply) = reply {
                    let _ = reply.send(message);
                }
            }
            _ => {}
        }
    }
    // What the program said as it stopped is the reason to show.
    let _ = tokio::time::timeout(Duration::from_millis(500), errors).await;
    let mut waiting = waiting.lock().expect("mcp replies mutex");
    waiting.closed = true;
    waiting.replies.clear();
}

/// Keeps the end of what the program writes to stderr. It is quoted when the
/// program fails and never logged.
async fn keep_errors(mut errors: ChildStderr, kept: Arc<Mutex<String>>) {
    let mut chunk = [0_u8; 2048];
    while let Ok(read @ 1..) = errors.read(&mut chunk).await {
        let mut kept = kept.lock().expect("mcp errors mutex");
        kept.push_str(&String::from_utf8_lossy(&chunk[..read]));
        let start = kept.char_indices().rev().nth(MAX_ERROR_CHARS - 1).map_or(0, |(index, _)| index);
        kept.drain(..start);
    }
}

impl Process {
    /// Starts the program and opens the session with it.
    pub async fn start(launch: &Launch) -> Result<Self, Error> {
        let program = expand(&launch.command);
        let label = program.file_name().unwrap_or(program.as_os_str()).to_string_lossy().into_owned();
        let folder = launch.cwd.as_deref().map(expand).or_else(|| std::env::var_os("HOME").map(PathBuf::from));
        let mut command = Command::new(&program);
        command.args(launch.args.iter().map(|argument| expand(argument)))
            .env("PATH", search_path().await).envs(&launch.env)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        if let Some(folder) = folder.filter(|folder| folder.is_dir()) {
            command.current_dir(folder);
        }
        let mut child = command.spawn().map_err(|error| Error::Other(match error.kind() {
            std::io::ErrorKind::NotFound => format!("Couldn't find {} on this Mac. Check the command, or give its full path.", launch.command),
            _ => format!("Couldn't start {label}: {error}"),
        }))?;
        let pipe = || Error::Other(format!("Couldn't start {label}"));
        let input = Arc::new(tokio::sync::Mutex::new(child.stdin.take().ok_or_else(pipe)?));
        let output = child.stdout.take().ok_or_else(pipe)?;
        let waiting = Arc::new(Mutex::new(Waiting::default()));
        let errors = Arc::new(Mutex::new(String::new()));
        let kept = tokio::spawn(keep_errors(child.stderr.take().ok_or_else(pipe)?, errors.clone()));
        tokio::spawn(listen(output, Arc::downgrade(&input), waiting.clone(), kept));
        let process = Self { launch: launch.clone(), label, input, waiting, errors, child: Some(child) };
        let hello = process.request("initialize", client::initialize_params(), START_TIMEOUT).await?;
        client::welcome(&hello, &process.label)?;
        process.send(&json!({"jsonrpc":"2.0","method":"notifications/initialized"})).await?;
        Ok(process)
    }

    /// Whether the program is still there to answer.
    pub fn alive(&self) -> bool {
        !self.waiting.lock().expect("mcp replies mutex").closed
    }

    fn stopped(&self) -> Error {
        let errors = self.errors.lock().expect("mcp errors mutex");
        Error::Other(match errors.trim() {
            "" => format!("{} stopped before answering", self.label),
            said => format!("{} stopped: {said}", self.label),
        })
    }

    async fn send(&self, message: &Value) -> Result<(), Error> {
        write(&self.input, message).await.map_err(|_| self.stopped())
    }
}

impl Drop for Process {
    /// Dropping this closes the program's stdin, which is how a server is
    /// asked to stop, along with anything it started to do its work. One still
    /// running a moment later is killed.
    fn drop(&mut self) {
        let (Some(mut child), Ok(runtime)) = (self.child.take(), tokio::runtime::Handle::try_current()) else { return };
        runtime.spawn(async move {
            if tokio::time::timeout(STOP_TIMEOUT, child.wait()).await.is_err() {
                let _ = child.kill().await;
            }
        });
    }
}

impl Rpc for Process {
    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, Error> {
        let id = client::next_id();
        let (reply, answered) = oneshot::channel();
        {
            let mut waiting = self.waiting.lock().expect("mcp replies mutex");
            if waiting.closed {
                return Err(self.stopped());
            }
            waiting.replies.insert(id, reply);
        }
        let forget = || self.waiting.lock().expect("mcp replies mutex").replies.remove(&id);
        if let Err(error) = self.send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})).await {
            forget();
            return Err(error);
        }
        match tokio::time::timeout(timeout, answered).await {
            Ok(Ok(message)) => client::result_of(message, &self.label),
            Ok(Err(_)) => Err(self.stopped()),
            Err(_) => {
                forget();
                Err(Error::Other(format!("{} took too long to answer", self.label)))
            }
        }
    }
}

#[cfg(all(test, unix))]
pub(super) mod tests {
    use super::*;

    /// A server in a few lines of shell: it answers the handshake, lists one
    /// tool, asks the client something mid-call, and stops on `crash`.
    pub const SERVER: &str = r#"
        id() { printf '%s' "$1" | sed -n 's/.*"id":\([0-9]*\).*/\1/p'; }
        echo "starting up, not a message"
        while read -r line; do
            case "$line" in
                *'"initialize"'*) echo "{\"jsonrpc\":\"2.0\",\"id\":$(id "$line"),\"result\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"fixture\"}}}" ;;
                *'"tools/list"'*) echo "{\"jsonrpc\":\"2.0\",\"id\":$(id "$line"),\"result\":{\"tools\":[{\"name\":\"greet\",\"description\":\"Says hello to $GREETING_TARGET\",\"inputSchema\":{\"type\":\"object\"},\"annotations\":{\"readOnlyHint\":true}}]}}" ;;
                *'"crash"'*) echo "out of memory" >&2; exit 1 ;;
                *'"tools/call"'*)
                    echo '{"jsonrpc":"2.0","id":"ask-1","method":"roots/list"}'
                    read -r refusal
                    case "$refusal" in *'-32601'*) heard=refused ;; *) heard=unanswered ;; esac
                    echo "{\"jsonrpc\":\"2.0\",\"id\":$(id "$line"),\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"hello $GREETING_TARGET, $heard\"}]}}" ;;
            esac
        done
        if [ -n "$STOPPED_FILE" ]; then : > "$STOPPED_FILE"; fi
    "#;

    pub fn launch(target: &str) -> Launch {
        Launch {
            command: "sh".into(), args: vec!["-c".into(), SERVER.into()],
            env: [("GREETING_TARGET".to_owned(), target.to_owned())].into(), cwd: None,
        }
    }

    #[tokio::test]
    async fn a_program_is_started_asked_and_told_when_it_asks_back() {
        let process = Process::start(&launch("world")).await.unwrap();
        let tools = client::list_tools(&process).await.unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].description, "Says hello to world", "the program gets its variables");
        assert!(tools[0].read_only);

        let result = client::call_tool(&process, "greet", &json!({})).await.unwrap();
        assert_eq!(result["content"][0]["text"], "hello world, refused");
        assert!(process.alive());
    }

    #[tokio::test]
    async fn a_program_that_stops_says_why() {
        let process = Process::start(&launch("world")).await.unwrap();
        let error = client::call_tool(&process, "crash", &json!({})).await.unwrap_err();
        assert_eq!(error.to_string(), "sh stopped: out of memory");
        assert!(!process.alive());
        assert!(client::list_tools(&process).await.is_err(), "nothing is sent to a program that stopped");
    }

    #[tokio::test]
    async fn a_server_behind_a_launcher_is_told_to_stop_when_it_is_dropped() {
        let stopped = std::env::temp_dir().join(format!("chatgsd-mcp-stopped-{}", uuid::Uuid::new_v4()));
        // The way `npx` runs a server: as a child of the program that was started.
        let launcher = Launch {
            command: "sh".into(), args: vec!["-c".into(), "sh -c \"$1\"; true".into(), "launcher".into(), SERVER.into()],
            env: [("STOPPED_FILE".to_owned(), stopped.to_string_lossy().into_owned())].into(), cwd: None,
        };
        let process = Process::start(&launcher).await.unwrap();
        assert_eq!(client::list_tools(&process).await.unwrap().len(), 1);
        drop(process);
        for _ in 0..40 {
            if stopped.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(stopped.exists(), "the server saw its input close and finished");
        std::fs::remove_file(stopped).unwrap();
    }

    #[tokio::test]
    async fn a_missing_program_is_named() {
        let missing = Launch { command: "chatgsd-no-such-server".into(), args: Vec::new(), env: Default::default(), cwd: None };
        let error = Process::start(&missing).await.err().unwrap();
        assert!(error.to_string().contains("Couldn't find chatgsd-no-such-server"), "{error}");
    }

    #[test]
    fn a_leading_tilde_is_the_home_folder() {
        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        assert_eq!(expand("~/notes"), home.join("notes"));
        assert_eq!(expand("~"), home);
        assert_eq!(expand("~other/notes"), PathBuf::from("~other/notes"));
        assert_eq!(expand("--root=~/notes"), PathBuf::from("--root=~/notes"));
    }
}

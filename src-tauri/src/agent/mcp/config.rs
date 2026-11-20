//! Servers that run as programs on this Mac. They are defined in `mcp.json`,
//! in the format other MCP clients use:
//!
//! ```json
//! { "mcpServers": { "files": { "command": "npx", "args": ["-y", "a-server"], "env": { "KEY": "value" } } } }
//! ```
//!
//! The file is the definition: settings writes to it, and an edit made by
//! hand counts the same. An entry may also carry a `hint`: the user's own
//! words to the agent about using the server. Entries ChatGSD doesn't run,
//! and anything else in the file, are left as they are.
use super::store;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const FILE: &str = "mcp.json";
const SERVERS: &str = "mcpServers";
pub const HINT: &str = "hint";

static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// How a server is started.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Launch {
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// Splits a command line the way a shell would: spaces separate words, quotes
/// keep them together, and a backslash takes the next character as it is.
fn words(line: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut word: Option<String> = None;
    let mut quote: Option<char> = None;
    let mut characters = line.chars().peekable();
    while let Some(character) = characters.next() {
        match (quote, character) {
            (Some(open), close) if open == close => quote = None,
            (None, '\'' | '"') => {
                quote = Some(character);
                word.get_or_insert_default();
            }
            (None, '\\') => word.get_or_insert_default().push(characters.next().unwrap_or('\\')),
            (Some('"'), '\\') if matches!(characters.peek(), Some('"' | '\\')) => {
                word.get_or_insert_default().extend(characters.next());
            }
            (None, space) if space.is_whitespace() => words.extend(word.take()),
            (_, other) => word.get_or_insert_default().push(other),
        }
    }
    if quote.is_some() {
        return Err("Close the quote in the command".into());
    }
    words.extend(word);
    Ok(words)
}

fn quoted(word: &str) -> String {
    let plain = !word.is_empty() && !word.chars().any(|character| character.is_whitespace() || "'\"\\".contains(character));
    if plain { word.to_owned() } else { format!("'{}'", word.replace('\'', "'\\''")) }
}

impl Launch {
    /// From a command line and `NAME=value` lines, as typed in settings.
    pub fn parse(command: &str, env: &str) -> Result<Self, String> {
        let mut words = words(command)?.into_iter();
        let command = words.next().ok_or("Enter the command that starts the server")?;
        let mut variables = BTreeMap::new();
        for line in env.lines().map(str::trim).filter(|line| !line.is_empty()) {
            let named = line.split_once('=').filter(|(name, _)| {
                !name.starts_with(|first: char| first.is_ascii_digit())
                    && !name.is_empty()
                    && name.chars().all(|character| character.is_ascii_alphanumeric() || character == '_')
            });
            let (name, value) = named.ok_or("Write each environment variable on its own line as NAME=value")?;
            variables.insert(name.to_owned(), value.to_owned());
        }
        Ok(Self { command, args: words.collect(), env: variables, cwd: None })
    }

    /// The command with its arguments, for display. Variables are left out:
    /// they often hold keys.
    pub fn line(&self) -> String {
        std::iter::once(&self.command).chain(&self.args).map(|word| quoted(word)).collect::<Vec<_>>().join(" ")
    }
}

/// One server `mcp.json` says to run.
pub struct Program {
    pub name: String,
    pub launch: Launch,
    pub hint: Option<String>,
}

/// What `mcp.json` says to run, and the entries it has that ChatGSD can't.
#[derive(Default)]
pub struct Config {
    pub servers: Vec<Program>,
    pub skipped: Vec<String>,
}

pub fn path(root: &Path) -> PathBuf {
    root.join(FILE)
}

async fn document(root: &Path) -> Result<Map<String, Value>, String> {
    match tokio::fs::read(path(root)).await {
        Ok(bytes) if bytes.iter().all(u8::is_ascii_whitespace) => Ok(Map::new()),
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| format!("{FILE} isn't valid JSON: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(error) => Err(format!("Couldn't read {FILE}: {error}")),
    }
}

fn entries(document: &Map<String, Value>) -> Config {
    let mut config = Config::default();
    for (name, entry) in document.get(SERVERS).and_then(Value::as_object).into_iter().flatten() {
        let launch = serde_json::from_value::<Launch>(entry.clone()).ok().filter(|launch| !launch.command.trim().is_empty());
        match launch {
            Some(launch) if !name.trim().is_empty() => config.servers.push(Program {
                name: name.clone(),
                launch,
                hint: super::clean(entry.get(HINT).and_then(Value::as_str).map(str::to_owned), super::MAX_HINT_CHARS),
            }),
            _ => config.skipped.push(name.clone()),
        }
    }
    config
}

pub async fn read(root: &Path) -> Result<Config, String> {
    document(root).await.map(|document| entries(&document))
}

/// Changes the file's servers and saves it, creating it if there is none.
/// Everything else in the file is kept.
pub async fn change(root: &Path, change: impl FnOnce(&mut Map<String, Value>) -> Result<(), String>) -> Result<(), String> {
    let _guard = LOCK.lock().await;
    let mut document = document(root).await?;
    let servers = document.entry(SERVERS).or_insert_with(|| json!({})).as_object_mut()
        .ok_or_else(|| format!("{SERVERS} in {FILE} isn't a list of servers by name"))?;
    change(servers)?;
    tokio::fs::create_dir_all(root).await.map_err(|error| format!("Couldn't save {FILE}: {error}"))?;
    store::save(&path(root), &document).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_lines_split_like_a_shell_and_show_the_same_way() {
        let launch = Launch::parse(r#"npx -y "@acme/notes server" --root '/Users/me/My Notes' a\ b """#, "").unwrap();
        assert_eq!(launch.command, "npx");
        assert_eq!(launch.args, ["-y", "@acme/notes server", "--root", "/Users/me/My Notes", "a b", ""]);
        assert_eq!(launch.line(), "npx -y '@acme/notes server' --root '/Users/me/My Notes' 'a b' ''");
        assert_eq!(Launch::parse(&launch.line(), "").unwrap(), launch, "the shown line reads back the same");
        assert_eq!(Launch::parse(r#"say "it's \"so\"""#, "").unwrap().args, ["it's \"so\""]);
        assert!(Launch::parse("   ", "").is_err());
        assert!(Launch::parse("npx 'unclosed", "").is_err());
    }

    #[test]
    fn variables_are_one_name_and_value_per_line() {
        let refused = Launch::parse("server", "API_KEY=abc=def\n\n  REGION = eu \n").unwrap_err();
        assert!(refused.contains("NAME=value"), "a name has no spaces: {refused}");
        let launch = Launch::parse("server", "API_KEY=abc=def\n\nEMPTY=\n").unwrap();
        assert_eq!(launch.env.get("API_KEY").map(String::as_str), Some("abc=def"));
        assert_eq!(launch.env.get("EMPTY").map(String::as_str), Some(""));
        assert!(Launch::parse("server", "1ST=x").is_err());
        assert!(!launch.line().contains("abc"), "variables stay out of the shown command");
    }

    #[tokio::test]
    async fn the_file_is_read_and_changed_without_losing_what_it_holds() {
        let root = std::env::temp_dir().join(format!("chatgsd-mcp-config-{}", uuid::Uuid::new_v4()));
        assert!(read(&root).await.unwrap().servers.is_empty(), "no file means no servers");

        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(path(&root), r#"{
            "theme": "dark",
            "mcpServers": {
                "files": {"type": "stdio", "command": "npx", "args": ["-y", "files-server"], "env": {"ROOT": "/tmp"}, "hint": " Show a file as a card. "},
                "tracker": {"type": "http", "url": "https://mcp.example.com/mcp"},
                "broken": {"command": 7}
            }
        }"#).unwrap();
        let mut config = read(&root).await.unwrap();
        config.skipped.sort();
        assert_eq!(config.servers.len(), 1);
        assert_eq!(config.servers[0].name, "files");
        assert_eq!(config.servers[0].launch.line(), "npx -y files-server");
        assert_eq!(config.servers[0].launch.env["ROOT"], "/tmp");
        assert_eq!(config.servers[0].hint.as_deref(), Some("Show a file as a card."));
        assert_eq!(config.skipped, ["broken", "tracker"]);

        let launch = Launch::parse("uvx notes-server", "KEY=secret").unwrap();
        change(&root, |servers| {
            servers.insert("notes".into(), serde_json::to_value(&launch).unwrap());
            Ok(())
        }).await.unwrap();
        let saved: Value = serde_json::from_slice(&std::fs::read(path(&root)).unwrap()).unwrap();
        assert_eq!(saved["theme"], "dark");
        assert_eq!(saved["mcpServers"]["tracker"]["url"], "https://mcp.example.com/mcp");
        assert_eq!(saved["mcpServers"]["notes"], json!({"command":"uvx","args":["notes-server"],"env":{"KEY":"secret"}}));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(path(&root)).unwrap().permissions().mode() & 0o777, 0o600);
        }

        std::fs::write(path(&root), "{ not json").unwrap();
        assert!(read(&root).await.err().unwrap().contains("isn't valid JSON"));
        assert!(change(&root, |_| Ok(())).await.is_err(), "a file that can't be read is never overwritten");
        assert_eq!(std::fs::read_to_string(path(&root)).unwrap(), "{ not json");
        std::fs::remove_dir_all(root).unwrap();
    }
}

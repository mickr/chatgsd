//! Servers other apps on this Mac are already set up with. Codex, Claude,
//! Cursor and the rest each keep their own list; they are gathered here so
//! the user can add any of them without typing it again. A server set up in
//! several places is listed once, with every place named: entries are the
//! same server when they are defined the same way or share a name. Nothing
//! found is run or contacted until the user adds it.
use super::config::Launch;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use url::Url;

const SERVERS: &str = "mcpServers";
const CODEX: &str = "Codex";
const CLAUDE_CODE: &str = "Claude Code";

/// Apps that keep their servers in one JSON file: the app's name, the file
/// under the home folder, and the key its servers are listed under.
const APPS: &[(&str, &str, &str)] = &[
    ("Claude", "Library/Application Support/Claude/claude_desktop_config.json", SERVERS),
    ("Cursor", ".cursor/mcp.json", SERVERS),
    ("VS Code", "Library/Application Support/Code/User/mcp.json", "servers"),
    ("Windsurf", ".codeium/windsurf/mcp_config.json", SERVERS),
    ("Gemini CLI", ".gemini/settings.json", SERVERS),
    ("Antigravity", ".gemini/antigravity/mcp_config.json", SERVERS),
    ("Copilot CLI", ".copilot/mcp-config.json", SERVERS),
    ("Cline", "Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json", SERVERS),
    ("Roo Code", "Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json", SERVERS),
    ("Kiro", ".kiro/settings/mcp.json", SERVERS),
    ("Amazon Q", ".aws/amazonq/mcp.json", SERVERS),
    ("LM Studio", ".lmstudio/mcp.json", SERVERS),
    ("Pi", ".pi/agent/mcp.json", SERVERS),
    ("Oh My Pi", ".omp/agent/mcp.json", SERVERS),
];

/// What adding a found server takes: a program to run, or an address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    Program(Launch),
    Address(String),
}

impl Source {
    /// The command or the address, for display. Variables are left out.
    pub fn detail(&self) -> String {
        match self {
            Self::Program(launch) => launch.line(),
            Self::Address(address) => address.clone(),
        }
    }

    /// Names the definition, so a server keeps its ID until it changes.
    fn id(&self) -> String {
        let definition = match self {
            Self::Program(launch) => format!("program {}", serde_json::to_string(launch).unwrap_or_default()),
            Self::Address(address) => format!("address {address}"),
        };
        Sha256::digest(definition).iter().take(8).map(|byte| format!("{byte:02x}")).collect()
    }
}

/// A server another app on this Mac is set up with.
pub struct Found {
    pub id: String,
    pub name: String,
    pub source: Source,
    /// Every place it is set up, as shown to the user.
    pub places: Vec<String>,
}

/// A server's entry, in the shape these apps share.
#[derive(Deserialize)]
struct Entry {
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    cwd: Option<String>,
    #[serde(alias = "serverUrl", alias = "httpUrl")]
    url: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    enabled: Option<bool>,
    disabled: Option<bool>,
}

impl Entry {
    /// Nothing for an entry that is switched off, or that only speaks the
    /// older SSE transport. A program set up for one folder runs in it.
    fn source(self, folder: Option<&Path>) -> Option<Source> {
        if self.enabled == Some(false) || self.disabled == Some(true) || self.kind.as_deref() == Some("sse") {
            return None;
        }
        match (self.command.filter(|command| !command.trim().is_empty()), self.url) {
            (Some(command), _) => Some(Source::Program(Launch {
                command,
                args: self.args,
                env: self.env,
                cwd: self.cwd.or_else(|| folder.map(|folder| folder.to_string_lossy().into_owned())),
            })),
            (None, Some(address)) => Url::parse(address.trim()).ok()
                .filter(|address| matches!(address.scheme(), "http" | "https"))
                .map(|address| Source::Address(address.into())),
            (None, None) => None,
        }
    }
}

struct Place {
    app: &'static str,
    /// The folder a server is set up for, when it isn't set up for every folder.
    folder: Option<PathBuf>,
}

impl Place {
    fn folder_name(&self) -> Option<String> {
        self.folder.as_deref().and_then(Path::file_name).map(|name| name.to_string_lossy().into_owned())
    }

    fn label(&self) -> String {
        match self.folder_name() {
            Some(folder) => format!("{} ({folder})", self.app),
            None => self.app.to_owned(),
        }
    }

    /// What tells two servers of one name apart.
    fn short(&self) -> String {
        self.folder_name().unwrap_or_else(|| self.app.to_owned())
    }
}

struct Seen {
    name: String,
    source: Source,
    place: Place,
}

/// A configuration file as JSON, whether it is written as JSON or TOML.
async fn document(path: &Path) -> Option<Value> {
    let text = tokio::fs::read_to_string(path).await.ok()?;
    if path.extension().is_some_and(|extension| extension == "toml") {
        toml::from_str(&text).ok()
    } else {
        serde_json::from_str(&text).ok()
    }
}

fn note(seen: &mut Vec<Seen>, document: &Value, key: &str, app: &'static str, folder: Option<&Path>) {
    for (name, entry) in document.get(key).and_then(Value::as_object).into_iter().flatten() {
        let source = Entry::deserialize(entry).ok().and_then(|entry| entry.source(folder));
        if let Some(source) = source.filter(|_| !name.trim().is_empty()) {
            seen.push(Seen { name: name.clone(), source, place: Place { app, folder: folder.map(Path::to_path_buf) } });
        }
    }
}

/// One entry per server, in name order. Entries defined the same way are one
/// server, and so are entries of one name, where the first found says how it
/// runs. A name set up for one folder is that folder's own server, told apart
/// from the others of its name by where it was found.
fn merge(seen: Vec<Seen>) -> Vec<Found> {
    let mut merged: Vec<(String, Source, Vec<Place>)> = Vec::new();
    for Seen { name, source, place } in seen {
        let same = merged.iter_mut().find(|(other, definition, places)| {
            *definition == source || (super::slug(other) == super::slug(&name) && places[0].folder == place.folder)
        });
        match same {
            Some((_, _, places)) => places.push(place),
            None => merged.push((name, source, vec![place])),
        }
    }
    let shared = |name: &str| merged.iter().filter(|(other, ..)| super::slug(other) == super::slug(name)).count() > 1;
    let mut found: Vec<Found> = merged.iter().map(|(name, source, places)| {
        let mut labels: Vec<String> = Vec::new();
        for label in places.iter().map(Place::label) {
            if !labels.contains(&label) {
                labels.push(label);
            }
        }
        Found {
            id: source.id(),
            name: if shared(name) { format!("{name} ({})", places[0].short()) } else { name.clone() },
            source: source.clone(),
            places: labels,
        }
    }).collect();
    found.sort_by_key(|found| found.name.to_lowercase());
    found
}

async fn found_in(home: &Path, codex: &Path) -> Vec<Found> {
    let mut seen = Vec::new();
    if let Some(config) = document(&codex.join("config.toml")).await {
        note(&mut seen, &config, "mcp_servers", CODEX, None);
    }
    for (app, file, key) in APPS {
        if let Some(config) = document(&home.join(file)).await {
            note(&mut seen, &config, key, app, None);
        }
    }
    // Claude Code keeps servers for every folder and for single folders in
    // one file, and reads the ones a folder shares from its `.mcp.json`.
    if let Some(config) = document(&home.join(".claude.json")).await {
        note(&mut seen, &config, SERVERS, CLAUDE_CODE, None);
        for (folder, project) in config.get("projects").and_then(Value::as_object).into_iter().flatten() {
            let folder = Path::new(folder);
            if !tokio::fs::metadata(folder).await.is_ok_and(|folder| folder.is_dir()) {
                continue;
            }
            note(&mut seen, project, SERVERS, CLAUDE_CODE, Some(folder));
            if let Some(shared) = document(&folder.join(".mcp.json")).await {
                note(&mut seen, &shared, SERVERS, CLAUDE_CODE, Some(folder));
            }
        }
    }
    merge(seen)
}

/// Every server the apps on this Mac are set up with.
pub async fn found() -> Vec<Found> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return Vec::new() };
    let codex = std::env::var_os("CODEX_HOME").map_or_else(|| home.join(".codex"), PathBuf::from);
    found_in(&home, &codex).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn program(found: &Found) -> &Launch {
        match &found.source {
            Source::Program(launch) => launch,
            Source::Address(address) => panic!("{} is at {address}, not a program", found.name),
        }
    }

    #[tokio::test]
    async fn servers_are_gathered_from_every_app_and_listed_once() {
        let home = std::env::temp_dir().join(format!("chatgsd-mcp-discover-{}", uuid::Uuid::new_v4()));
        let shop = home.join("code/shop");
        let blog = home.join("code/blog");
        std::fs::create_dir_all(&shop).unwrap();
        std::fs::create_dir_all(&blog).unwrap();
        write(&home.join(".codex/config.toml"), r#"
            model = "gpt-5"

            [mcp_servers.browser]
            command = "/Applications/Browser.app/Contents/MacOS/browser"
            args = ["mcp"]
            tool_timeout_sec = 900

            [mcp_servers.browser.env]
            MODE = "quiet"

            [mcp_servers.tracker]
            url = "https://mcp.example.com/mcp"
            bearer_token_env_var = "TRACKER_TOKEN"

            [mcp_servers.off]
            command = "off-server"
            enabled = false

            [mcp_servers.empty]
            startup_timeout_sec = 5
        "#);
        write(&home.join(".cursor/mcp.json"), &json!({"mcpServers": {
            "Browser": {"command": "/Applications/Browser.app/Contents/MacOS/browser", "args": ["mcp"], "env": {"MODE": "quiet"}},
            "issues": {"url": "https://MCP.example.com/mcp"},
            "search": {"command": "npx", "args": ["-y", "search-server"], "env": {"KEY": "cursor-key"}},
            "paused": {"command": "paused-server", "disabled": true},
            "stream": {"type": "sse", "url": "https://sse.example.com/sse"},
            "socket": {"url": "ws://example.com/mcp"},
            "broken": {"command": 7}
        }}).to_string());
        write(&home.join("Library/Application Support/Code/User/mcp.json"), &json!({"servers": {
            "search": {"type": "stdio", "command": "npx", "args": ["-y", "search-server"], "env": {"KEY": "code-key"}}
        }}).to_string());
        write(&home.join(".gemini/settings.json"), &json!({"theme": "dark", "mcpServers": {
            "docs": {"httpUrl": "https://docs.example.com/mcp"}
        }}).to_string());
        write(&home.join(".claude.json"), &json!({
            "mcpServers": {"docs": {"type": "http", "url": "https://docs.example.com/mcp"}},
            "projects": {
                shop.to_str().unwrap(): {"mcpServers": {"framework": {"command": "php", "args": ["artisan", "mcp"]}}},
                blog.to_str().unwrap(): {},
                home.join("code/gone").to_str().unwrap(): {"mcpServers": {"lost": {"command": "lost-server"}}}
            }
        }).to_string());
        write(&shop.join(".mcp.json"), &json!({"mcpServers": {"framework": {"command": "php", "args": ["artisan", "mcp"]}}}).to_string());
        write(&blog.join(".mcp.json"), &json!({"mcpServers": {"framework": {"command": "php", "args": ["artisan", "mcp"]}}}).to_string());

        let found = found_in(&home, &home.join(".codex")).await;
        let names: Vec<&str> = found.iter().map(|found| found.name.as_str()).collect();
        assert_eq!(names, ["browser", "docs", "framework (blog)", "framework (shop)", "search", "tracker"]);
        let named = |name: &str| found.iter().find(|found| found.name == name).unwrap();

        let browser = named("browser");
        assert_eq!(browser.places, ["Codex", "Cursor"], "one definition in two apps is one server");
        assert_eq!(program(browser).line(), "/Applications/Browser.app/Contents/MacOS/browser mcp");
        assert_eq!(program(browser).env["MODE"], "quiet");

        let tracker = named("tracker");
        assert_eq!(tracker.places, ["Codex", "Cursor"], "addresses match however they are written");
        assert_eq!(tracker.source, Source::Address("https://mcp.example.com/mcp".into()));
        assert_eq!(named("docs").places, ["Gemini CLI", "Claude Code"]);

        let search = named("search");
        assert_eq!(search.places, ["Cursor", "VS Code"], "one name is one server, however each app runs it");
        assert_eq!(program(search).env["KEY"], "cursor-key", "the first found says how it runs");
        assert!(!search.source.detail().contains("cursor-key"), "variables stay out of what is shown");

        let shop_framework = named("framework (shop)");
        assert_eq!(shop_framework.places, ["Claude Code (shop)"], "found twice for one folder, named once");
        assert_eq!(program(shop_framework).cwd.as_deref(), shop.to_str(), "a folder's server runs in that folder");
        assert_eq!(program(named("framework (blog)")).cwd.as_deref(), blog.to_str());

        let again = found_in(&home, &home.join(".codex")).await;
        assert_eq!(again.iter().map(|found| &found.id).collect::<Vec<_>>(), found.iter().map(|found| &found.id).collect::<Vec<_>>());
        let mut ids: Vec<&String> = found.iter().map(|found| &found.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), found.len(), "every server has its own ID");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[tokio::test]
    async fn files_that_are_missing_or_unreadable_find_nothing() {
        let home = std::env::temp_dir().join(format!("chatgsd-mcp-discover-{}", uuid::Uuid::new_v4()));
        assert!(found_in(&home, &home.join(".codex")).await.is_empty());
        write(&home.join(".codex/config.toml"), "not toml [");
        write(&home.join(".cursor/mcp.json"), "{ not json");
        write(&home.join(".claude.json"), r#"{"mcpServers": ["not", "by", "name"], "projects": 3}"#);
        assert!(found_in(&home, &home.join(".codex")).await.is_empty());
        std::fs::remove_dir_all(home).unwrap();
    }
}

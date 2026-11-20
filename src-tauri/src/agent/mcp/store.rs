//! Where MCP servers are kept: `servers.json` holds what the settings page
//! shows, `credentials.json` holds tokens and never leaves the backend, and
//! `mcp.json` defines the servers that run on this Mac. All three live in app
//! data, so they apply in every notes folder and are never synced with one.
use super::{config, oauth, ServerConfig};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::Manager;

const SERVERS_FILE: &str = "servers.json";
const CREDENTIALS_FILE: &str = "credentials.json";

static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// What ChatGSD holds to reach one server as the user.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Credentials {
    /// An access token the user pasted, for servers without OAuth.
    #[serde(default)]
    pub token: Option<String>,
    /// This app's OAuth registration with the server's authorization server.
    #[serde(default)]
    pub client: Option<oauth::Client>,
    #[serde(default)]
    pub oauth: Option<oauth::Tokens>,
}

#[derive(Default)]
pub struct Store {
    pub servers: Vec<ServerConfig>,
    pub credentials: HashMap<String, Credentials>,
    /// What is wrong with `mcp.json`, when it can't be followed as written.
    pub problem: Option<String>,
}

impl Store {
    pub fn server(&self, id: &str) -> Result<&ServerConfig, String> {
        self.servers.iter().find(|server| server.id == id).ok_or_else(|| "This server was removed".to_owned())
    }

    pub fn server_mut(&mut self, id: &str) -> Result<&mut ServerConfig, String> {
        self.servers.iter_mut().find(|server| server.id == id).ok_or_else(|| "This server was removed".to_owned())
    }
}

pub fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|error| error.to_string())?.join("agent").join("mcp"))
}

async fn load<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| format!("Couldn't read the saved MCP servers: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(format!("Couldn't read the saved MCP servers: {error}")),
    }
}

/// Writes beside the file and renames over it, readable by this user only.
pub(super) async fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let failed = |error: std::io::Error| format!("Couldn't save the MCP servers: {error}");
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&temporary).await.map_err(failed)?;
    tokio::io::AsyncWriteExt::write_all(&mut file, &bytes).await.map_err(failed)?;
    tokio::io::AsyncWriteExt::flush(&mut file).await.map_err(failed)?;
    drop(file);
    tokio::fs::rename(&temporary, path).await.map_err(failed)
}

/// The saved servers, with the programs as `mcp.json` has them now. A program
/// keeps what was saved about it (on or off, its tools, the user's choices
/// for them) for as long as the file names it.
fn with_programs(saved: Vec<ServerConfig>, programs: Vec<config::Program>) -> Vec<ServerConfig> {
    let (mut known, mut servers): (Vec<_>, Vec<_>) = saved.into_iter().partition(ServerConfig::is_program);
    for config::Program { name, launch, hint } in programs {
        if servers.len() >= super::MAX_SERVERS {
            break;
        }
        let id = super::program_id(&name);
        let mut server = match known.iter().position(|server| server.id == id) {
            Some(index) => known.swap_remove(index),
            None => ServerConfig::program(id),
        };
        server.name = super::unique_name(&servers, &name, None);
        server.launch = Some(launch);
        server.hint = hint;
        servers.push(server);
    }
    servers
}

async fn read_in(root: &Path) -> Result<Store, String> {
    let saved = load(&root.join(SERVERS_FILE)).await?;
    let credentials = load(&root.join(CREDENTIALS_FILE)).await?;
    Ok(match config::read(root).await {
        Ok(config) => Store {
            servers: with_programs(saved, config.servers),
            credentials,
            problem: (!config.skipped.is_empty()).then(|| format!(
                "{} lists servers ChatGSD can't start because they have no command: {}. Add a remote server by its address instead.",
                config::FILE, config.skipped.join(", ")
            )),
        },
        // The programs stay listed, with nothing to start them by, until the
        // file can be read again.
        Err(problem) => Store { servers: saved, credentials, problem: Some(problem) },
    })
}

pub async fn read(root: &Path) -> Result<Store, String> {
    let _guard = LOCK.lock().await;
    read_in(root).await
}

/// Loads both files, applies `change`, and saves them, as one step. A change
/// that fails saves nothing.
pub async fn update<T>(root: &Path, change: impl FnOnce(&mut Store) -> Result<T, String>) -> Result<T, String> {
    let _guard = LOCK.lock().await;
    let mut store = read_in(root).await?;
    let result = change(&mut store)?;
    tokio::fs::create_dir_all(root).await.map_err(|error| format!("Couldn't save the MCP servers: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).await.map_err(|error| error.to_string())?;
    }
    store.credentials.retain(|id, _| store.servers.iter().any(|server| &server.id == id));
    save(&root.join(CREDENTIALS_FILE), &store.credentials).await?;
    save(&root.join(SERVERS_FILE), &store.servers).await?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(id: &str) -> ServerConfig {
        ServerConfig {
            id: id.into(), name: "Tracker".into(), url: "https://mcp.example.com/mcp".into(), enabled: true,
            local: false, auto_name: false, client_id: None, launch: None, hint: None, tools: Vec::new(), policies: HashMap::new(), added_at: 1,
        }
    }

    #[tokio::test]
    async fn saves_privately_and_drops_credentials_with_their_server() {
        let root = std::env::temp_dir().join(format!("chatgsd-mcp-store-{}", uuid::Uuid::new_v4()));
        update(&root, |store| {
            store.servers.push(server("kept"));
            store.servers.push(server("removed"));
            for id in ["kept", "removed"] {
                store.credentials.insert(id.into(), Credentials { token: Some(format!("{id}-token")), ..Default::default() });
            }
            Ok(())
        }).await.unwrap();
        let failed: Result<(), String> = update(&root, |store| {
            store.servers.clear();
            Err("refused".into())
        }).await;
        assert!(failed.is_err());
        assert_eq!(read(&root).await.unwrap().servers.len(), 2, "a failed change saves nothing");

        update(&root, |store| { store.servers.retain(|server| server.id != "removed"); Ok(()) }).await.unwrap();
        let store = read(&root).await.unwrap();
        assert_eq!(store.credentials.keys().collect::<Vec<_>>(), ["kept"]);
        assert_eq!(store.credentials["kept"].token.as_deref(), Some("kept-token"));
        assert!(!std::fs::read_to_string(root.join(SERVERS_FILE)).unwrap().contains("kept-token"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(root.join(CREDENTIALS_FILE)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn programs_follow_the_file_and_keep_what_the_user_chose() {
        let root = std::env::temp_dir().join(format!("chatgsd-mcp-store-{}", uuid::Uuid::new_v4()));
        let write = |text: &str| std::fs::write(config::path(&root), text).unwrap();
        update(&root, |store| { store.servers.push(server("remote")); Ok(()) }).await.unwrap();
        write(r#"{"mcpServers":{"Tracker":{"command":"tracker-server"},"files":{"command":"npx","args":["files"],"env":{"KEY":"secret"}}}}"#);

        let store = read(&root).await.unwrap();
        let names: Vec<&str> = store.servers.iter().map(|server| server.name.as_str()).collect();
        assert_eq!(names, ["Tracker", "Tracker 2", "files"], "a program can't take a name the agent already uses");
        let files = store.servers.iter().find(|server| server.name == "files").unwrap().id.clone();
        assert!(store.server(&files).unwrap().enabled, "a program in the file is on until the user turns it off");

        update(&root, |store| {
            let server = store.server_mut(&files)?;
            server.enabled = false;
            server.policies.insert("write".into(), crate::agent::mcp::Policy::Allow);
            Ok(())
        }).await.unwrap();
        assert!(!std::fs::read_to_string(root.join(SERVERS_FILE)).unwrap().contains("secret"), "the file stays the only place a program is defined");

        write(r#"{"mcpServers":{"files":{"command":"uvx","args":["files"],"hint":"Show a file as a card."}}}"#);
        let store = read(&root).await.unwrap();
        assert_eq!(store.servers.len(), 2, "a program the file no longer names is gone");
        let server = store.server(&files).unwrap();
        assert_eq!(server.launch.as_ref().unwrap().line(), "uvx files");
        assert_eq!(server.hint.as_deref(), Some("Show a file as a card."), "a program's hint is the file's");
        assert!(!server.enabled);
        assert_eq!(server.policies.len(), 1);

        write("{ mid-edit");
        let store = read(&root).await.unwrap();
        assert!(store.problem.as_deref().unwrap().contains("isn't valid JSON"));
        assert!(store.server(&files).unwrap().launch.is_none(), "nothing to start it by until the file reads again");
        update(&root, |_| Ok(())).await.unwrap();
        write(r#"{"mcpServers":{"files":{"command":"uvx"},"tracker":{"url":"https://mcp.example.com/mcp"}}}"#);
        let store = read(&root).await.unwrap();
        assert!(!store.server(&files).unwrap().enabled, "an unreadable file loses nothing that was saved");
        assert_eq!(store.server(&files).unwrap().hint, None, "a hint taken out of the file is gone");
        assert!(store.problem.as_deref().unwrap().contains("tracker"));
        std::fs::remove_dir_all(root).unwrap();
    }
}

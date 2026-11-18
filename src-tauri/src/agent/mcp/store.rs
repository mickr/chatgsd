//! Where MCP servers are kept: `servers.json` holds what the settings page
//! shows, `credentials.json` holds tokens and never leaves the backend. Both
//! live in app data, so they apply in every notes folder and are never synced
//! with one.
use super::{oauth, ServerConfig};
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
async fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
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

async fn read_in(root: &Path) -> Result<Store, String> {
    Ok(Store {
        servers: load(&root.join(SERVERS_FILE)).await?,
        credentials: load(&root.join(CREDENTIALS_FILE)).await?,
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
            local: false, auto_name: false, client_id: None, tools: Vec::new(), policies: HashMap::new(), added_at: 1,
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
}

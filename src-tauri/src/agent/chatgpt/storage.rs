use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::Manager;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use super::{ChatGptAccount, PLAN_SCOPE};

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Credentials {
    pub email: String,
    pub issuer: String,
    pub subject: String,
    pub client_id: String,
    pub ext_agent_host_id: String,
    pub id_token: String,
    pub access_token: String,
    pub refresh_token: String,
    pub token_type: String,
    pub expires_in: u64,
    pub scopes: Vec<String>,
    pub saved_at: String,
    #[serde(default)]
    pub plan_notice_seen: bool,
}

impl Credentials {
    pub fn account(&self) -> ChatGptAccount {
        ChatGptAccount {
            email: self.email.clone(),
            plan_usage: self.scopes.iter().any(|scope| scope == PLAN_SCOPE),
            plan_notice_seen: self.plan_notice_seen,
        }
    }

    pub fn expires_soon(&self) -> bool {
        chrono::DateTime::parse_from_rfc3339(&self.saved_at)
            .map(|saved| {
                saved
                    .timestamp()
                    .saturating_add(self.expires_in.min(i64::MAX as u64) as i64)
                    <= chrono::Utc::now().timestamp().saturating_add(60)
            })
            .unwrap_or(true)
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Registration {
    pub client_id: String,
    pub email: String,
    #[serde(default)]
    pub plan_notice_seen: bool,
}

#[derive(Default, Deserialize, Serialize)]
pub(super) struct Registrations {
    pub last_subject: Option<String>,
    pub accounts: HashMap<String, Registration>,
}

pub(super) struct Storage(PathBuf);

impl Storage {
    pub fn new(app: &tauri::AppHandle) -> Result<Self, String> {
        Ok(Self(
            app.path()
                .app_data_dir()
                .map_err(|e| e.to_string())?
                .join("chatgpt"),
        ))
    }

    pub async fn credentials(&self) -> Result<Option<Credentials>, String> {
        read_json(&self.0.join("credentials.json")).await
    }

    pub async fn registrations(&self) -> Result<Registrations, String> {
        Ok(read_json(&self.0.join("registrations.json"))
            .await?
            .unwrap_or_default())
    }

    pub async fn save_credentials(&self, credentials: &Credentials) -> Result<(), String> {
        self.save("credentials.json", credentials).await
    }

    pub async fn save_registrations(&self, registrations: &Registrations) -> Result<(), String> {
        self.save("registrations.json", registrations).await
    }

    pub async fn clear_credentials(&self) -> Result<(), String> {
        match tokio::fs::remove_file(self.0.join("credentials.json")).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Could not clear ChatGPT credentials: {error}")),
        }
    }

    pub async fn host_id(&self) -> Result<String, String> {
        #[derive(Deserialize, Serialize)]
        struct Host {
            ext_agent_host_id: String,
        }
        if let Some(host) = read_json::<Host>(&self.0.join("host.json")).await? {
            return Ok(host.ext_agent_host_id);
        }
        let host = Host {
            ext_agent_host_id: format!("urn:uuid:{}", Uuid::new_v4()),
        };
        self.save("host.json", &host).await?;
        Ok(host.ext_agent_host_id)
    }

    async fn save(&self, name: &str, value: &impl Serialize) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
        tokio::fs::create_dir_all(&self.0)
            .await
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o700))
                .await
                .map_err(|e| e.to_string())?;
        }
        let temporary = self.0.join(format!(".{name}.{}", Uuid::new_v4()));
        let result = async {
            let mut options = tokio::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            let mut file = options.open(&temporary).await?;
            file.write_all(&bytes).await?;
            file.sync_all().await?;
            drop(file);
            tokio::fs::rename(&temporary, self.0.join(name)).await
        }
        .await;
        if let Err(error) = result {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(format!("Could not save ChatGPT credentials: {error}"));
        }
        Ok(())
    }
}

async fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "Could not read saved ChatGPT account data".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read ChatGPT account data: {error}")),
    }
}

//! What the writer says about themselves, for every agent role. Kept in
//! `{APP_DATA}/agent/profile.json`: it applies in every notes folder and is
//! never synced with one. Only the user writes it, in settings.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

const MAX_NAME_CHARS: usize = 80;
const MAX_ABOUT_CHARS: usize = 2_000;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Profile {
    pub name: String,
    pub about: String,
}

impl Profile {
    fn checked(self) -> Result<Self, String> {
        let name = self.name.split_whitespace().collect::<Vec<_>>().join(" ");
        let about = self.about.trim().to_owned();
        if name.chars().count() > MAX_NAME_CHARS { return Err(format!("A name can be at most {MAX_NAME_CHARS} characters.")); }
        if about.chars().count() > MAX_ABOUT_CHARS { return Err(format!("About you can be at most {MAX_ABOUT_CHARS} characters.")); }
        Ok(Self { name, about })
    }

    /// The block sent ahead of a request; empty when nothing is filled in.
    pub fn context(&self) -> String {
        if self.name.is_empty() && self.about.is_empty() { return String::new(); }
        let mut text = String::from("About the writer, as they describe themselves in settings:\n");
        if !self.name.is_empty() {
            text.push_str(&format!("Name: {}. A mention of this name in a note means the writer, as do \"I\" and \"me\".\n", self.name));
        }
        if !self.about.is_empty() {
            text.push_str(&self.about);
            text.push('\n');
        }
        text.push_str("Follow the preferences stated here unless the request says otherwise.\n\n");
        text
    }
}

fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|error| error.to_string())?.join("agent").join("profile.json"))
}

async fn load(app: &tauri::AppHandle) -> Result<Profile, String> {
    match tokio::fs::read(path(app)?).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| format!("Couldn't read what you saved about yourself: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Profile::default()),
        Err(error) => Err(format!("Couldn't read what you saved about yourself: {error}")),
    }
}

/// The context block for a run. An unreadable profile never blocks a message.
pub async fn context(app: &tauri::AppHandle) -> String {
    load(app).await.unwrap_or_default().context()
}

#[tauri::command]
pub async fn agent_profile(app: tauri::AppHandle) -> Result<Profile, String> {
    load(&app).await
}

#[tauri::command]
pub async fn agent_set_profile(app: tauri::AppHandle, profile: Profile) -> Result<Profile, String> {
    let profile = profile.checked()?;
    let path = path(&app)?;
    let failed = |error: std::io::Error| format!("Couldn't save what you wrote about yourself: {error}");
    if let Some(parent) = path.parent() { tokio::fs::create_dir_all(parent).await.map_err(failed)?; }
    let bytes = serde_json::to_vec_pretty(&profile).map_err(|error| error.to_string())?;
    // Write beside the file and rename over it.
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(&temporary, bytes).await.map_err(failed)?;
    tokio::fs::rename(&temporary, &path).await.map_err(failed)?;
    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_profile_adds_nothing_and_a_filled_one_names_the_writer() {
        assert_eq!(Profile::default().context(), "");
        let context = Profile { name: "Mick Ryan".into(), about: "I run a consultancy. British spelling.".into() }.context();
        assert!(context.contains("Name: Mick Ryan. A mention of this name in a note means the writer"));
        assert!(context.contains("British spelling.\nFollow the preferences"));
        assert!(context.ends_with("\n\n"));
        let about_only = Profile { name: String::new(), about: "Short sentences.".into() }.context();
        assert!(!about_only.contains("Name:") && about_only.contains("Short sentences."));
    }

    #[test]
    fn saving_trims_keeps_the_name_on_one_line_and_refuses_overlong_text() {
        let saved = Profile { name: "  Mick\n Ryan ".into(), about: "\n About me \n".into() }.checked().unwrap();
        assert_eq!(saved, Profile { name: "Mick Ryan".into(), about: "About me".into() });
        assert!(Profile { name: "n".repeat(81), about: String::new() }.checked().is_err());
        assert!(Profile { name: String::new(), about: "a".repeat(2_001) }.checked().is_err());
        assert!(Profile { name: String::new(), about: "é".repeat(2_000) }.checked().is_ok());
    }
}

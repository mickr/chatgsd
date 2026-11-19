//! On-demand installer for the official Antigravity CLI (`agy`) binary.
//!
//! Fetches the platform manifest from Google's official Antigravity release
//! endpoint, streams the archive with progress updates, verifies the SHA-512
//! digest before extraction, and installs atomically into `~/.local/bin/agy`
//! (falling back to `{app_data_dir}/antigravity/bin/agy`).

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

const MANIFEST_BASE_URL: &str =
    "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

static INSTALL_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub stage: String,
    pub detail: String,
    pub percent: Option<u8>,
}

#[derive(Deserialize)]
struct Manifest {
    version: String,
    url: String,
    sha512: String,
}

fn emit_progress(app: &tauri::AppHandle, stage: &str, detail: impl Into<String>, percent: Option<u8>) {
    let _ = app.emit(
        "antigravity:install-progress",
        InstallProgress {
            stage: stage.to_owned(),
            detail: detail.into(),
            percent,
        },
    );
}

fn platform_id() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("darwin_arm64"),
        ("macos", "x86_64") => Ok("darwin_amd64"),
        ("linux", "aarch64") => Ok("linux_arm64"),
        ("linux", "x86_64") => Ok("linux_amd64"),
        (os, arch) => Err(format!(
            "Automatic Antigravity CLI install is not supported on {os}/{arch}."
        )),
    }
}

fn validate_download_url(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw)
        .map_err(|_| "Antigravity release manifest returned an invalid download URL.".to_owned())?;
    if parsed.scheme() != "https" {
        return Err("Antigravity download URL must use HTTPS.".into());
    }
    let host = parsed.host_str().unwrap_or_default();
    let allowed = host == "storage.googleapis.com"
        || host == "antigravity.google"
        || host.ends_with(".googleapis.com");
    if !allowed {
        return Err(format!(
            "Refusing to download Antigravity CLI from unexpected host `{host}`."
        ));
    }
    Ok(parsed)
}

pub(super) fn app_managed_binary(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("antigravity").join("bin").join("agy"))
}

fn target_install_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let local_bin = home.join(".local").join("bin");
        if std::fs::create_dir_all(&local_bin).is_ok() {
            let probe = local_bin.join(format!(".chatgsd-probe-{}", uuid::Uuid::new_v4()));
            if std::fs::write(&probe, b"").is_ok() {
                let _ = std::fs::remove_file(&probe);
                return Ok(local_bin);
            }
        }
    }
    let fallback = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot locate app data directory: {error}"))?
        .join("antigravity")
        .join("bin");
    std::fs::create_dir_all(&fallback)
        .map_err(|error| format!("Cannot prepare Antigravity install directory: {error}"))?;
    Ok(fallback)
}

fn extract_binary(archive_path: &Path, is_tar_gz: bool, dest_path: &Path) -> Result<(), String> {
    if !is_tar_gz {
        std::fs::copy(archive_path, dest_path)
            .map_err(|error| format!("Cannot copy Antigravity binary: {error}"))?;
        return Ok(());
    }
    let file = std::fs::File::open(archive_path)
        .map_err(|error| format!("Cannot open downloaded Antigravity archive: {error}"))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("Cannot read Antigravity archive entries: {error}"))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|error| format!("Corrupt Antigravity archive entry: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("Invalid Antigravity archive path: {error}"))?;
        let file_name = path.file_name().and_then(|name| name.to_str());
        if matches!(file_name, Some("antigravity" | "agy")) && entry.header().entry_type().is_file()
        {
            let mut out = std::fs::File::create(dest_path)
                .map_err(|error| format!("Cannot create Antigravity binary: {error}"))?;
            let mut buf = [0u8; 64 * 1024];
            loop {
                let n = entry
                    .read(&mut buf)
                    .map_err(|error| format!("Cannot extract Antigravity binary: {error}"))?;
                if n == 0 {
                    break;
                }
                std::io::Write::write_all(&mut out, &buf[..n])
                    .map_err(|error| format!("Cannot write Antigravity binary: {error}"))?;
            }
            return Ok(());
        }
    }
    Err("Antigravity archive did not contain the `antigravity` executable.".into())
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

pub(super) async fn install_cli(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let _guard = INSTALL_LOCK.lock().await;
    let platform = platform_id()?;
    emit_progress(app, "checking", "Checking latest Antigravity CLI version…", None);

    let client = reqwest::Client::builder()
        .user_agent(format!("ChatGSD/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("Cannot initialize HTTP client: {error}"))?;

    let manifest_url = format!("{MANIFEST_BASE_URL}/{platform}.json");
    let manifest: Manifest = client
        .get(&manifest_url)
        .send()
        .await
        .map_err(|error| format!("Cannot reach Antigravity release server: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Antigravity release manifest error: {error}"))?
        .json()
        .await
        .map_err(|error| format!("Cannot parse Antigravity release manifest: {error}"))?;

    let download_url = validate_download_url(&manifest.url)?;
    let expected_sha512 = manifest.sha512.trim().to_ascii_lowercase();
    if expected_sha512.len() != 128 || !expected_sha512.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Antigravity release manifest contained an invalid SHA-512 checksum.".into());
    }

    let install_dir = target_install_dir(app)?;
    let staging_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot find app data directory: {error}"))?
        .join("antigravity")
        .join("staging");
    tokio::fs::create_dir_all(&staging_dir)
        .await
        .map_err(|error| format!("Cannot create Antigravity staging directory: {error}"))?;

    let is_tar_gz = download_url.path().ends_with(".tar.gz");
    let payload_path = staging_dir.join(format!(
        "agy-{}.{}",
        uuid::Uuid::new_v4().simple(),
        if is_tar_gz { "tar.gz" } else { "bin" }
    ));

    let label = format!("Downloading Antigravity {}…", manifest.version);
    emit_progress(app, "downloading", &label, Some(0));

    let response = client
        .get(download_url)
        .send()
        .await
        .map_err(|error| format!("Cannot download Antigravity CLI: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Antigravity CLI download failed: {error}"))?;

    let total_bytes = response.content_length();
    let mut downloaded: u64 = 0;
    let mut last_percent: Option<u8> = Some(0);
    let mut hasher = Sha512::new();

    let download_result = async {
        let mut file = tokio::fs::File::create(&payload_path)
            .await
            .map_err(|error| format!("Cannot create staging file: {error}"))?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("Download interrupted: {error}"))?;
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("Cannot write downloaded archive: {error}"))?;
            downloaded += chunk.len() as u64;
            if let Some(total) = total_bytes.filter(|&t| t > 0) {
                let pct = ((downloaded.saturating_mul(100)) / total).min(100) as u8;
                if last_percent != Some(pct) {
                    last_percent = Some(pct);
                    emit_progress(
                        app,
                        "downloading",
                        format!("Downloading Antigravity {} ({pct}%)…", manifest.version),
                        Some(pct),
                    );
                }
            }
        }
        file.flush()
            .await
            .map_err(|error| format!("Cannot finish writing archive: {error}"))?;
        Ok::<(), String>(())
    }
    .await;

    if let Err(error) = download_result {
        let _ = tokio::fs::remove_file(&payload_path).await;
        return Err(error);
    }

    emit_progress(app, "verifying", "Verifying SHA-512 checksum…", Some(100));
    let actual_sha512 = hex_lower(&hasher.finalize());
    if actual_sha512 != expected_sha512 {
        let _ = tokio::fs::remove_file(&payload_path).await;
        return Err(
            "Downloaded Antigravity CLI failed SHA-512 checksum verification. Installation aborted."
                .into(),
        );
    }

    emit_progress(app, "extracting", "Installing Antigravity CLI…", None);
    let temp_binary = install_dir.join(format!(".agy-{}.tmp", uuid::Uuid::new_v4().simple()));
    let payload_clone = payload_path.clone();
    let temp_clone = temp_binary.clone();
    let extract_result =
        tokio::task::spawn_blocking(move || extract_binary(&payload_clone, is_tar_gz, &temp_clone))
            .await
            .map_err(|error| format!("Extraction task failed: {error}"))?;
    let _ = tokio::fs::remove_file(&payload_path).await;

    if let Err(error) = extract_result {
        let _ = tokio::fs::remove_file(&temp_binary).await;
        return Err(error);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&temp_binary, std::fs::Permissions::from_mode(0o755))
            .await
            .map_err(|error| format!("Cannot mark Antigravity binary executable: {error}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        let _ = tokio::process::Command::new("/usr/bin/xattr")
            .args(["-d", "com.apple.quarantine"])
            .arg(&temp_binary)
            .output()
            .await;
    }

    let final_path = install_dir.join("agy");
    tokio::fs::rename(&temp_binary, &final_path)
        .await
        .map_err(|error| {
            let _ = std::fs::remove_file(&temp_binary);
            format!("Cannot place Antigravity CLI at {}: {error}", final_path.display())
        })?;

    emit_progress(app, "ready", "Antigravity CLI installed.", Some(100));
    Ok(final_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_download_url_allows_only_official_https_hosts() {
        assert!(validate_download_url(
            "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.12/cli_mac_arm64.tar.gz"
        )
        .is_ok());
        assert!(validate_download_url("http://storage.googleapis.com/cli.tar.gz").is_err());
        assert!(validate_download_url("https://example.com/cli.tar.gz").is_err());
    }

    #[test]
    fn extract_binary_unpacks_antigravity_from_tar_gz() {
        let dir = std::env::temp_dir().join(format!("chatgsd-agy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let archive_path = dir.join("cli.tar.gz");
        {
            let file = std::fs::File::create(&archive_path).unwrap();
            let enc = flate2::write::GzEncoder::new(file, flate2::Compression::fast());
            let mut builder = tar::Builder::new(enc);
            let payload = b"#!/bin/sh\necho agy\n";
            let mut header = tar::Header::new_gnu();
            header.set_size(payload.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder
                .append_data(&mut header, "antigravity", &payload[..])
                .unwrap();
            builder.finish().unwrap();
        }
        let dest = dir.join("agy");
        extract_binary(&archive_path, true, &dest).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"#!/bin/sh\necho agy\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

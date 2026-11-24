//! WebDAV synced project folders: mirrors a remote WebDAV Markdown tree
//! (such as Engine Room's `/dav/docs`) into a local folder managed by ChatGSD,
//! signing in through OAuth 2.1 PKCE (`agent::mcp::oauth`) and pushing saves
//! back with `If-Match` ETag conflict detection.

use super::mcp::oauth;
use super::web::{self, Fetcher};
use regex::Regex;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::Manager;
use url::{Host, Url};

const WEBDAV_DIR: &str = "agent/webdav";
const CREDENTIALS_FILE: &str = "credentials.json";
const MANIFESTS_DIR: &str = "manifests";
const MIRRORS_DIR: &str = "mirrors";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_secs(30);

static CREDENTIALS_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static MANIFEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static STATUSES: LazyLock<Mutex<HashMap<String, RemoteStatus>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Persisted on a linked Project folder when it is backed by a WebDAV server.
#[derive(Clone, Serialize, Deserialize)]
pub struct RemoteConfig {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub local: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    /// One of `idle`, `syncing`, `synced`, `needs_auth`, `conflict`, `error`.
    pub status: String,
    pub detail: Option<String>,
    pub last_synced: Option<i64>,
}

impl Default for RemoteStatus {
    fn default() -> Self {
        Self {
            status: "idle".to_owned(),
            detail: None,
            last_synced: None,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFolderView {
    pub id: String,
    pub url: String,
    pub status: String,
    pub detail: Option<String>,
    pub last_synced: Option<i64>,
}

#[derive(Default, Clone, Serialize, Deserialize)]
struct StoredCredential {
    #[serde(default)]
    client: Option<oauth::Client>,
    #[serde(default)]
    tokens: Option<oauth::Tokens>,
}

#[derive(Default, Serialize, Deserialize)]
struct CredentialsStore {
    #[serde(default)]
    entries: HashMap<String, StoredCredential>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ManifestEntry {
    etag: String,
    sha256: String,
}

#[derive(Default, Serialize, Deserialize)]
struct SyncManifest {
    #[serde(default)]
    files: BTreeMap<String, ManifestEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DavEntry {
    pub rel_path: String,
    pub is_collection: bool,
    pub etag: Option<String>,
}

enum DavError {
    Unauthorized(Option<String>),
    Other(String),
}

enum PutOutcome {
    Saved(Option<String>),
    Conflict,
    Unauthorized,
}

pub fn view_for(remote: &RemoteConfig) -> RemoteFolderView {
    let current = STATUSES
        .lock()
        .expect("webdav status lock")
        .get(&remote.id)
        .cloned()
        .unwrap_or_default();

    RemoteFolderView {
        id: remote.id.clone(),
        url: remote.url.clone(),
        status: current.status,
        detail: current.detail,
        last_synced: current.last_synced,
    }
}

fn set_status(id: &str, status: &str, detail: Option<String>, last_synced: Option<i64>) {
    let mut map = STATUSES.lock().expect("webdav status lock");
    let previous_synced = map.get(id).and_then(|s| s.last_synced);
    map.insert(
        id.to_owned(),
        RemoteStatus {
            status: status.to_owned(),
            detail,
            last_synced: last_synced.or(previous_synced),
        },
    );
}

fn fetcher_for(local: bool) -> Fetcher {
    if local {
        web::ANY
    } else {
        web::PUBLIC
    }
}

pub async fn normalize_url(input: &str) -> Result<(Url, bool), String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("Enter the WebDAV folder's web address".into());
    }
    let on_this_mac = ["localhost", "127.0.0.1", "[::1]"]
        .iter()
        .any(|host| text.starts_with(host));
    let with_scheme = if text.contains("://") {
        text.to_owned()
    } else {
        format!("{}://{text}", if on_this_mac { "http" } else { "https" })
    };
    let mut url = web::http_url(&with_scheme)?;
    let local = is_local(&url).await?;
    if url.scheme() == "http" && !local {
        return Err("Remote WebDAV servers must use https".into());
    }
    let trimmed_path = url.path().trim_end_matches('/').to_owned();
    url.set_path(if trimmed_path.is_empty() { "/" } else { &trimmed_path });
    Ok((url, local))
}

async fn is_local(url: &Url) -> Result<bool, String> {
    match url.host() {
        Some(Host::Ipv4(ip)) => Ok(!web::is_public(ip.into())),
        Some(Host::Ipv6(ip)) => Ok(!web::is_public(ip.into())),
        Some(Host::Domain(domain)) => {
            let port = url.port_or_known_default().unwrap_or(443);
            let addresses: Vec<_> = tokio::net::lookup_host((domain, port))
                .await
                .map_err(|_| format!("Couldn't find {domain}"))?
                .collect();
            if addresses.is_empty() {
                return Err(format!("Couldn't find {domain}"));
            }
            Ok(!addresses.iter().all(|address| web::is_public(address.ip())))
        }
        None => Err("Enter the WebDAV folder's web address".into()),
    }
}

pub fn default_label_for(url: &Url) -> String {
    let host = url.host_str().unwrap_or("WebDAV");
    let leaf = url
        .path_segments()
        .and_then(|mut segments| segments.rfind(|s| !s.is_empty()));
    match leaf {
        Some(segment) if segment != "dav" => format!("{host} ({segment})"),
        _ => host.to_owned(),
    }
}

fn root_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(WEBDAV_DIR))
}

pub async fn create_mirror_dir(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    let dir = root_dir(app)?.join(MIRRORS_DIR).join(id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| format!("Couldn't create mirror folder: {error}"))?;
    tokio::fs::canonicalize(&dir)
        .await
        .map_err(|error| format!("Couldn't resolve mirror folder: {error}"))
}

pub async fn cleanup_remote(app: &tauri::AppHandle, id: &str) {
    STATUSES.lock().expect("webdav status lock").remove(id);
    if let Ok(base) = root_dir(app) {
        let _ = remove_credentials(&base, id).await;
        let _ = tokio::fs::remove_file(base.join(MANIFESTS_DIR).join(format!("{id}.json"))).await;
    }
}

async fn load_credentials(base: &Path) -> Result<CredentialsStore, String> {
    let path = base.join(CREDENTIALS_FILE);
    match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Couldn't read WebDAV credentials: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(CredentialsStore::default())
        }
        Err(error) => Err(format!("Couldn't read WebDAV credentials: {error}")),
    }
}

async fn save_credentials(base: &Path, store: &CredentialsStore) -> Result<(), String> {
    tokio::fs::create_dir_all(base)
        .await
        .map_err(|error| format!("Couldn't save WebDAV credentials: {error}"))?;
    let path = base.join(CREDENTIALS_FILE);
    let bytes = serde_json::to_vec_pretty(store).map_err(|error| error.to_string())?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(&temp, bytes)
        .await
        .map_err(|error| format!("Couldn't save WebDAV credentials: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600)).await;
    }
    tokio::fs::rename(&temp, &path)
        .await
        .map_err(|error| format!("Couldn't save WebDAV credentials: {error}"))
}

async fn remove_credentials(base: &Path, id: &str) -> Result<(), String> {
    let _guard = CREDENTIALS_LOCK.lock().await;
    let mut store = load_credentials(base).await?;
    store.entries.remove(id);
    save_credentials(base, &store).await
}

async fn load_manifest(base: &Path, id: &str) -> SyncManifest {
    let path = base.join(MANIFESTS_DIR).join(format!("{id}.json"));
    match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => SyncManifest::default(),
    }
}

async fn save_manifest(base: &Path, id: &str, manifest: &SyncManifest) -> Result<(), String> {
    let dir = base.join(MANIFESTS_DIR);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| format!("Couldn't save sync manifest: {error}"))?;
    let path = dir.join(format!("{id}.json"));
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|error| error.to_string())?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(&temp, bytes)
        .await
        .map_err(|error| format!("Couldn't save sync manifest: {error}"))?;
    tokio::fs::rename(&temp, &path)
        .await
        .map_err(|error| format!("Couldn't save sync manifest: {error}"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

fn entry_url(base_url: &str, rel_path: &str) -> Result<Url, String> {
    let mut url = Url::parse(base_url).map_err(|error| error.to_string())?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "WebDAV URL cannot be a base".to_owned())?;
        segments.pop_if_empty();
        for segment in rel_path.split('/').filter(|s| !s.is_empty()) {
            segments.push(segment);
        }
    }
    Ok(url)
}

async fn propfind(
    fetcher: Fetcher,
    url: &Url,
    token: Option<&str>,
    depth: &str,
) -> Result<Vec<DavEntry>, DavError> {
    let client = fetcher
        .client(url, REQUEST_TIMEOUT)
        .await
        .map_err(|error| DavError::Other(error.to_string()))?;
    let method = Method::from_bytes(b"PROPFIND").expect("PROPFIND method");
    let mut request = client
        .request(method, url.clone())
        .header("Depth", depth)
        .header(reqwest::header::ACCEPT, "application/xml, text/xml");
    if let Some(bearer) = token {
        request = request.bearer_auth(bearer);
    }

    let response = request
        .send()
        .await
        .map_err(|error| DavError::Other(format!("Couldn't reach WebDAV server: {error}")))?;
    let status = response.status();

    if status == reqwest::StatusCode::UNAUTHORIZED {
        let header = response
            .headers()
            .get(reqwest::header::WWW_AUTHENTICATE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        return Err(DavError::Unauthorized(header));
    }

    if !status.is_success() && status.as_u16() != 207 {
        return Err(DavError::Other(format!(
            "WebDAV server returned HTTP {}",
            status.as_u16()
        )));
    }

    let body = response
        .text()
        .await
        .map_err(|error| DavError::Other(format!("Couldn't read WebDAV response: {error}")))?;

    Ok(parse_multistatus_xml(&body, url.path()))
}

async fn get_file(
    fetcher: Fetcher,
    url: &Url,
    token: Option<&str>,
) -> Result<(Vec<u8>, Option<String>), DavError> {
    let client = fetcher
        .client(url, REQUEST_TIMEOUT)
        .await
        .map_err(|error| DavError::Other(error.to_string()))?;
    let mut request = client.get(url.clone());
    if let Some(bearer) = token {
        request = request.bearer_auth(bearer);
    }

    let response = request
        .send()
        .await
        .map_err(|error| DavError::Other(format!("Couldn't download file: {error}")))?;
    let status = response.status();

    if status == reqwest::StatusCode::UNAUTHORIZED {
        let header = response
            .headers()
            .get(reqwest::header::WWW_AUTHENTICATE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        return Err(DavError::Unauthorized(header));
    }

    if !status.is_success() {
        return Err(DavError::Other(format!(
            "Download failed with HTTP {}",
            status.as_u16()
        )));
    }

    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let bytes = response
        .bytes()
        .await
        .map_err(|error| DavError::Other(format!("Couldn't read downloaded file: {error}")))?;

    Ok((bytes.to_vec(), etag))
}

async fn put_file(
    fetcher: Fetcher,
    url: &Url,
    token: Option<&str>,
    content: Vec<u8>,
    if_match: Option<&str>,
) -> Result<PutOutcome, String> {
    let client = fetcher
        .client(url, REQUEST_TIMEOUT)
        .await
        .map_err(|error| error.to_string())?;
    let mut request = client
        .put(url.clone())
        .header(reqwest::header::CONTENT_TYPE, "text/markdown; charset=utf-8")
        .body(content);
    if let Some(bearer) = token {
        request = request.bearer_auth(bearer);
    }
    if let Some(etag) = if_match {
        request = request.header(reqwest::header::IF_MATCH, etag);
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("Couldn't upload file: {error}"))?;
    let status = response.status();

    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(PutOutcome::Unauthorized);
    }

    if status == reqwest::StatusCode::PRECONDITION_FAILED {
        return Ok(PutOutcome::Conflict);
    }

    if !status.is_success() {
        return Err(format!("Upload failed with HTTP {}", status.as_u16()));
    }

    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    Ok(PutOutcome::Saved(etag))
}

static RESPONSE_BLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<(?:[A-Za-z0-9_-]+:)?response\b[^>]*>(.*?)</(?:[A-Za-z0-9_-]+:)?response>")
        .expect("response regex")
});
static HREF_TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<(?:[A-Za-z0-9_-]+:)?href\b[^>]*>(.*?)</(?:[A-Za-z0-9_-]+:)?href>")
        .expect("href regex")
});
static ETAG_TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<(?:[A-Za-z0-9_-]+:)?getetag\b[^>]*>(.*?)</(?:[A-Za-z0-9_-]+:)?getetag>")
        .expect("etag regex")
});
static COLLECTION_TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<(?:[A-Za-z0-9_-]+:)?collection\b[^>]*/?>").expect("collection regex")
});

fn xml_unescape(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// Parses an RFC 4918 `207 Multi-Status` XML body into entries relative to `base_path`.
pub fn parse_multistatus_xml(xml: &str, base_path: &str) -> Vec<DavEntry> {
    let normalized_base = base_path.trim_end_matches('/');
    let mut entries = Vec::new();

    for cap in RESPONSE_BLOCK.captures_iter(xml) {
        let block = &cap[1];
        let Some(href_raw) = HREF_TAG.captures(block).map(|c| xml_unescape(c[1].trim())) else {
            continue;
        };
        let href_path = if href_raw.starts_with("http://") || href_raw.starts_with("https://") {
            Url::parse(&href_raw)
                .map(|u| u.path().to_owned())
                .unwrap_or(href_raw)
        } else {
            href_raw
        };

        let trimmed = href_path.trim_end_matches('/');
        let relative = if let Some(rest) = trimmed.strip_prefix(normalized_base) {
            rest.trim_start_matches('/')
        } else {
            continue;
        };

        if relative.is_empty() {
            continue;
        }

        let mut decoded_segments = Vec::new();
        let mut valid = true;
        for part in relative.split('/') {
            let decoded = urlencoding::decode(part)
                .map(|cow| cow.into_owned())
                .unwrap_or_else(|_| part.to_owned());
            if decoded.is_empty()
                || decoded == "."
                || decoded == ".."
                || decoded.contains('/')
                || decoded.contains('\\')
                || decoded.contains('\0')
            {
                valid = false;
                break;
            }
            decoded_segments.push(decoded);
        }
        if !valid || decoded_segments.is_empty() {
            continue;
        }

        let is_collection = COLLECTION_TAG.is_match(block) || href_path.ends_with('/');
        let etag = ETAG_TAG
            .captures(block)
            .map(|c| xml_unescape(c[1].trim()))
            .filter(|v| !v.is_empty());

        entries.push(DavEntry {
            rel_path: decoded_segments.join("/"),
            is_collection,
            etag,
        });
    }

    entries
}

fn is_markdown_path(rel_path: &str) -> bool {
    let lower = rel_path.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

/// Resolves `rel_path` strictly inside `mirror_dir`, rejecting any non-normal
/// path component (`..`, root, prefix) and refusing to traverse or overwrite
/// any symlink inside the mirror.
async fn safe_mirror_path(mirror_dir: &Path, rel_path: &str) -> Result<PathBuf, String> {
    let mut joined = mirror_dir.to_path_buf();
    let mut count = 0usize;

    for component in Path::new(rel_path).components() {
        match component {
            std::path::Component::Normal(segment) => {
                let text = segment.to_string_lossy();
                if text.is_empty()
                    || text == "."
                    || text == ".."
                    || text.contains('/')
                    || text.contains('\\')
                    || text.contains('\0')
                {
                    return Err("Rejected unsafe WebDAV path segment".into());
                }
                joined.push(segment);
                count += 1;
            }
            _ => return Err("Rejected non-normal WebDAV path component".into()),
        }
    }

    if count == 0 {
        return Err("Rejected empty WebDAV path".into());
    }

    let canonical_mirror = tokio::fs::canonicalize(mirror_dir)
        .await
        .map_err(|error| format!("Couldn't resolve mirror folder: {error}"))?;

    let mut current = canonical_mirror.clone();
    for component in Path::new(rel_path).components() {
        if let std::path::Component::Normal(segment) = component {
            current.push(segment);
            match tokio::fs::symlink_metadata(&current).await {
                Ok(meta) => {
                    if meta.file_type().is_symlink() {
                        return Err("Refused to write through a symlink inside the mirror folder".into());
                    }
                    let resolved = tokio::fs::canonicalize(&current)
                        .await
                        .map_err(|error| format!("Couldn't verify mirror path: {error}"))?;
                    if !resolved.starts_with(&canonical_mirror) {
                        return Err("Rejected path escaping the mirror folder".into());
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    // Remaining components do not exist yet; parent has been verified.
                    break;
                }
                Err(error) => {
                    return Err(format!("Couldn't inspect mirror path: {error}"));
                }
            }
        }
    }

    Ok(canonical_mirror.join(rel_path))
}

async fn access_token_for(app: &tauri::AppHandle, remote: &RemoteConfig) -> Result<Option<String>, String> {
    let base = root_dir(app)?;
    let saved = {
        let _guard = CREDENTIALS_LOCK.lock().await;
        load_credentials(&base)
            .await?
            .entries
            .get(&remote.id)
            .cloned()
    };

    let Some(mut cred) = saved else {
        return Ok(None);
    };
    let Some(tokens) = cred.tokens.clone() else {
        return Ok(None);
    };

    if !tokens.expired() {
        return Ok(Some(tokens.access_token));
    }

    let fetcher = fetcher_for(remote.local);
    match oauth::refresh(fetcher, remote.local, &tokens).await {
        Ok(renewed) => {
            let token = renewed.access_token.clone();
            cred.tokens = Some(renewed);
            let _guard = CREDENTIALS_LOCK.lock().await;
            let mut store = load_credentials(&base).await?;
            store.entries.insert(remote.id.clone(), cred);
            save_credentials(&base, &store).await?;
            Ok(Some(token))
        }
        Err(oauth::TokenError::Rejected(_)) => {
            cred.tokens = None;
            let _guard = CREDENTIALS_LOCK.lock().await;
            let mut store = load_credentials(&base).await?;
            store.entries.insert(remote.id.clone(), cred);
            save_credentials(&base, &store).await?;
            set_status(
                &remote.id,
                "needs_auth",
                Some("Sign-in expired. Sign in again.".into()),
                None,
            );
            Ok(None)
        }
        Err(oauth::TokenError::Other(message)) => Err(message),
    }
}

/// Runs OAuth 2.1 PKCE authorization for a WebDAV folder, then syncs it.
pub async fn authorize_and_sync(
    app: &tauri::AppHandle,
    remote: &RemoteConfig,
    mirror_dir: &Path,
) -> Result<(), String> {
    let base = root_dir(app)?;
    let url = Url::parse(&remote.url).map_err(|error| error.to_string())?;
    let fetcher = fetcher_for(remote.local);

    set_status(&remote.id, "syncing", Some("Waiting for sign-in…".into()), None);
    super::projects::emit_changed(app).await;

    let challenge = match propfind(fetcher, &url, None, "0").await {
        Ok(_) => {
            // Server does not require auth; sync directly.
            return sync_remote(app, remote, mirror_dir).await;
        }
        Err(DavError::Unauthorized(header)) => oauth::challenge(header.as_deref()),
        Err(DavError::Other(message)) => {
            set_status(&remote.id, "error", Some(message.clone()), None);
            super::projects::emit_changed(app).await;
            return Err(message);
        }
    };

    let saved_client = {
        let _guard = CREDENTIALS_LOCK.lock().await;
        load_credentials(&base)
            .await?
            .entries
            .get(&remote.id)
            .and_then(|c| c.client.clone())
    };

    let grant = oauth::authorize(
        oauth::Request {
            fetcher,
            local: remote.local,
            server: &url,
            challenge,
            preset: None,
            saved: saved_client,
        },
        |page| open::that(page).map_err(|error| format!("Couldn't open browser: {error}")),
    )
    .await;

    match grant {
        Ok(grant) => {
            let _guard = CREDENTIALS_LOCK.lock().await;
            let mut store = load_credentials(&base).await?;
            store.entries.insert(
                remote.id.clone(),
                StoredCredential {
                    client: Some(grant.client),
                    tokens: Some(grant.tokens),
                },
            );
            save_credentials(&base, &store).await?;
        }
        Err(message) => {
            set_status(&remote.id, "needs_auth", Some(message.clone()), None);
            super::projects::emit_changed(app).await;
            return Err(message);
        }
    }

    sync_remote(app, remote, mirror_dir).await
}

async fn write_conflict_sidecar(mirror_dir: &Path, rel_path: &str, remote_bytes: &[u8]) -> Result<PathBuf, String> {
    let rel = Path::new(rel_path);
    let stem = rel
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("note");
    let ext = rel.extension().and_then(|s| s.to_str()).unwrap_or("md");
    let sidecar_rel = match rel.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => {
            format!("{}/{stem}.remote.{ext}", parent.to_string_lossy())
        }
        _ => format!("{stem}.remote.{ext}"),
    };
    let sidecar = safe_mirror_path(mirror_dir, &sidecar_rel).await?;
    tokio::fs::write(&sidecar, remote_bytes)
        .await
        .map_err(|error| format!("Couldn't write conflict copy: {error}"))?;
    Ok(sidecar)
}

/// Pulls the latest Markdown files from a WebDAV folder into `mirror_dir`.
pub async fn sync_remote(
    app: &tauri::AppHandle,
    remote: &RemoteConfig,
    mirror_dir: &Path,
) -> Result<(), String> {
    let base = root_dir(app)?;
    let url = Url::parse(&remote.url).map_err(|error| error.to_string())?;
    let fetcher = fetcher_for(remote.local);

    set_status(&remote.id, "syncing", None, None);
    super::projects::emit_changed(app).await;

    let token = access_token_for(app, remote).await?;
    let entries = match propfind(fetcher, &url, token.as_deref(), "infinity").await {
        Ok(entries) => entries,
        Err(DavError::Unauthorized(_)) => {
            set_status(
                &remote.id,
                "needs_auth",
                Some("Sign-in required".into()),
                None,
            );
            super::projects::emit_changed(app).await;
            return Err("Sign-in required for this WebDAV folder".into());
        }
        Err(DavError::Other(message)) => {
            set_status(&remote.id, "error", Some(message.clone()), None);
            super::projects::emit_changed(app).await;
            return Err(message);
        }
    };

    tokio::fs::create_dir_all(mirror_dir)
        .await
        .map_err(|error| format!("Couldn't access mirror folder: {error}"))?;

    let _manifest_guard = MANIFEST_LOCK.lock().await;
    let mut manifest = load_manifest(&base, &remote.id).await;
    let mut seen_paths = HashSet::new();
    let mut conflicts = 0usize;

    for entry in entries {
        if entry.is_collection || !is_markdown_path(&entry.rel_path) {
            continue;
        }
        let abs_path = match safe_mirror_path(mirror_dir, &entry.rel_path).await {
            Ok(path) => path,
            Err(_) => continue,
        };
        seen_paths.insert(entry.rel_path.clone());
        let remote_etag = entry.etag.clone().unwrap_or_default();
        let previous = manifest.files.get(&entry.rel_path).cloned();

        if let Some(prev) = &previous {
            if !remote_etag.is_empty() && prev.etag == remote_etag && abs_path.is_file() {
                continue;
            }
        }

        let file_url = entry_url(&remote.url, &entry.rel_path)?;
        let (remote_bytes, fetched_etag) = match get_file(fetcher, &file_url, token.as_deref()).await
        {
            Ok(res) => res,
            Err(DavError::Unauthorized(_)) => {
                set_status(
                    &remote.id,
                    "needs_auth",
                    Some("Sign-in required".into()),
                    None,
                );
                super::projects::emit_changed(app).await;
                return Err("Sign-in required for this WebDAV folder".into());
            }
            Err(DavError::Other(message)) => {
                set_status(&remote.id, "error", Some(message.clone()), None);
                super::projects::emit_changed(app).await;
                return Err(message);
            }
        };

        let remote_sha = sha256_hex(&remote_bytes);
        let effective_etag = fetched_etag.unwrap_or(remote_etag);

        if let Some(prev) = &previous {
            if let Ok(local_bytes) = tokio::fs::read(&abs_path).await {
                let local_sha = sha256_hex(&local_bytes);
                if local_sha != prev.sha256 && local_sha != remote_sha {
                    let _ = write_conflict_sidecar(mirror_dir, &entry.rel_path, &remote_bytes).await;
                    conflicts += 1;
                    continue;
                }
            }
        }

        if let Some(parent) = abs_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("Couldn't create folder: {error}"))?;
        }
        tokio::fs::write(&abs_path, &remote_bytes)
            .await
            .map_err(|error| format!("Couldn't write synced file: {error}"))?;

        manifest.files.insert(
            entry.rel_path,
            ManifestEntry {
                etag: effective_etag,
                sha256: remote_sha,
            },
        );
    }

    // Remove local files that disappeared remotely only if unmodified locally.
    let stale_paths: Vec<String> = manifest
        .files
        .keys()
        .filter(|path| !seen_paths.contains(*path))
        .cloned()
        .collect();
    for stale in stale_paths {
        let Ok(abs_path) = safe_mirror_path(mirror_dir, &stale).await else {
            manifest.files.remove(&stale);
            continue;
        };
        if let Some(prev) = manifest.files.get(&stale) {
            let unmodified = tokio::fs::read(&abs_path)
                .await
                .map(|bytes| sha256_hex(&bytes) == prev.sha256)
                .unwrap_or(true);
            if unmodified {
                let _ = tokio::fs::remove_file(&abs_path).await;
                manifest.files.remove(&stale);
            }
        }
    }

    save_manifest(&base, &remote.id, &manifest).await?;

    let now = chrono::Utc::now().timestamp();
    if conflicts > 0 {
        set_status(
            &remote.id,
            "conflict",
            Some(format!("{conflicts} file(s) had conflicts; saved .remote.md copies")),
            Some(now),
        );
    } else {
        set_status(&remote.id, "synced", None, Some(now));
    }
    super::projects::emit_changed(app).await;
    Ok(())
}

/// Called after `save_file_direct` writes a file; if the file lives inside a
/// WebDAV-synced project folder, pushes the new content back via HTTP `PUT`.
pub async fn push_saved_file(app: tauri::AppHandle, canonical_path: PathBuf) {
    let Some((remote, mirror_dir)) = super::projects::find_webdav_for_path(&app, &canonical_path).await
    else {
        return;
    };

    let Ok(relative) = canonical_path.strip_prefix(&mirror_dir) else {
        return;
    };
    let rel_path = relative
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/");
    if !is_markdown_path(&rel_path) || rel_path.contains(".remote.") {
        return;
    }

    let Ok(bytes) = tokio::fs::read(&canonical_path).await else {
        return;
    };
    let local_sha = sha256_hex(&bytes);

    let Ok(base) = root_dir(&app) else {
        return;
    };

    let if_match = {
        let _guard = MANIFEST_LOCK.lock().await;
        let manifest = load_manifest(&base, &remote.id).await;
        match manifest.files.get(&rel_path) {
            Some(entry) if entry.sha256 == local_sha => return,
            Some(entry) if !entry.etag.is_empty() => Some(entry.etag.clone()),
            _ => None,
        }
    };

    let Ok(token) = access_token_for(&app, &remote).await else {
        return;
    };
    let Ok(file_url) = entry_url(&remote.url, &rel_path) else {
        return;
    };
    let fetcher = fetcher_for(remote.local);

    set_status(&remote.id, "syncing", None, None);
    super::projects::emit_changed(&app).await;

    match put_file(fetcher, &file_url, token.as_deref(), bytes, if_match.as_deref()).await {
        Ok(PutOutcome::Saved(new_etag)) => {
            let _guard = MANIFEST_LOCK.lock().await;
            let mut manifest = load_manifest(&base, &remote.id).await;
            manifest.files.insert(
                rel_path,
                ManifestEntry {
                    etag: new_etag.unwrap_or_default(),
                    sha256: local_sha,
                },
            );
            let _ = save_manifest(&base, &remote.id, &manifest).await;
            set_status(&remote.id, "synced", None, Some(chrono::Utc::now().timestamp()));
        }
        Ok(PutOutcome::Conflict) => {
            if let Ok((remote_bytes, _)) = get_file(fetcher, &file_url, token.as_deref()).await {
                let _ = write_conflict_sidecar(&mirror_dir, &rel_path, &remote_bytes).await;
            }
            set_status(
                &remote.id,
                "conflict",
                Some("Changed remotely; saved .remote.md copy".into()),
                None,
            );
        }
        Ok(PutOutcome::Unauthorized) => {
            set_status(
                &remote.id,
                "needs_auth",
                Some("Sign-in required to upload changes".into()),
                None,
            );
        }
        Err(message) => {
            set_status(&remote.id, "error", Some(message), None);
        }
    }

    super::projects::emit_changed(&app).await;
}

/// Spawns a lightweight background loop that periodically pulls all configured
/// WebDAV folders so remote edits show up in ChatGSD automatically.
pub fn start_background_sync(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(POLL_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let folders = super::projects::all_webdav_folders(&app).await;
            for (remote, mirror_dir) in folders {
                // Skip folders that are already waiting on user sign-in.
                let waiting_auth = STATUSES
                    .lock()
                    .expect("webdav status lock")
                    .get(&remote.id)
                    .is_some_and(|s| s.status == "needs_auth");
                if waiting_auth {
                    continue;
                }
                let _ = sync_remote(&app, &remote, &mirror_dir).await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rfc4918_multistatus_with_namespaces_and_encoding() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/docs/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/docs/Acme%20Corp/Website%20Rebuild/Discovery%20Scope.md</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>
        <D:getetag>&quot;42-1763612400&quot;</D:getetag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/docs/Acme%20Corp/../secret.md</D:href>
    <D:propstat>
      <D:prop><D:resourcetype/></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

        let entries = parse_multistatus_xml(xml, "/dav/docs");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].rel_path, "Acme Corp/Website Rebuild/Discovery Scope.md");
        assert!(!entries[0].is_collection);
        assert_eq!(entries[0].etag.as_deref(), Some("\"42-1763612400\""));
    }

    #[test]
    fn parses_default_namespace_and_absolute_hrefs() {
        let xml = r#"<multistatus xmlns="DAV:">
  <response>
    <href>https://example.com/dav/docs/Client/Notes.md</href>
    <propstat>
      <prop><getetag>"7-100"</getetag></prop>
    </propstat>
  </response>
</multistatus>"#;

        let entries = parse_multistatus_xml(xml, "/dav/docs/");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].rel_path, "Client/Notes.md");
        assert_eq!(entries[0].etag.as_deref(), Some("\"7-100\""));
    }

    #[test]
    fn rejects_percent_encoded_path_traversal_segments() {
        let xml = r#"<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/docs/..%2F..%2Fetc/passwd.md</D:href>
    <D:propstat><D:prop><D:resourcetype/></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/docs/..%5C..%5Cescape.md</D:href>
    <D:propstat><D:prop><D:resourcetype/></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/docs/Safe%20Client/Valid.md</D:href>
    <D:propstat><D:prop><D:resourcetype/></D:prop></D:propstat>
  </D:response>
</D:multistatus>"#;

        let entries = parse_multistatus_xml(xml, "/dav/docs");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].rel_path, "Safe Client/Valid.md");
    }

    #[tokio::test]
    async fn safe_mirror_path_rejects_traversal_and_symlinks() {
        let root = std::env::temp_dir().join(format!("chatgsd-webdav-test-{}", uuid::Uuid::new_v4()));
        let mirror = root.join("mirror");
        let outside = root.join("outside");
        tokio::fs::create_dir_all(&mirror).await.unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();

        assert!(safe_mirror_path(&mirror, "Client/Note.md").await.is_ok());
        assert!(safe_mirror_path(&mirror, "../outside/escape.md").await.is_err());
        assert!(safe_mirror_path(&mirror, "/etc/passwd.md").await.is_err());
        assert!(safe_mirror_path(&mirror, "Client/..\\escape.md").await.is_err());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, mirror.join("linked")).unwrap();
            assert!(safe_mirror_path(&mirror, "linked/escape.md").await.is_err());
        }

        let _ = tokio::fs::remove_dir_all(&root).await;
    }
}

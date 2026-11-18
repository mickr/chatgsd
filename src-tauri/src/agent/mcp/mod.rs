//! MCP servers the user connects in settings, and the agent's access to them.
//!
//! ChatGSD is the MCP client: Codex never talks to a server itself. The agent
//! reaches a server's tools through two fixed dynamic tools, `mcp_tools` and
//! `mcp_call`, so adding or removing a server never changes a saved thread's
//! tool catalog. A tool that may change something outside ChatGSD asks the
//! user first, unless they chose otherwise for that tool.
//!
//! A remote server (Streamable HTTP) is added by its address alone: its name,
//! its tools and its OAuth sign-in are all read from the server. A server
//! that runs on this Mac is a program defined in `mcp.json`, which ChatGSD
//! starts and talks to over stdio.
mod client;
mod config;
mod oauth;
mod stdio;
mod store;
#[cfg(test)]
mod tests;

use super::{tools::ToolOutput, web, AgentState};
use client::Endpoint;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::sync::Notify;
use url::{Host, Url};

const MAX_SERVERS: usize = 30;
const MAX_NAME_CHARS: usize = 60;
const MAX_TOKEN_CHARS: usize = 4_000;
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
/// The most of a tool result the model is shown.
const MAX_RESULT_CHARS: usize = 30_000;
/// A server's tools are described with their schemas up to this size.
const MAX_CATALOG_CHARS: usize = 20_000;
const MAX_OVERVIEW_TOOLS: usize = 40;
const ALLOW_ONCE: &str = "Allow once";
const ALWAYS_ALLOW: &str = "Always allow";
const DENY: &str = "Don't allow";
const SETTINGS: &str = "Settings → MCP Servers";
const PROGRAM_ID: &str = "program-";

/// Whether the agent may call a tool: freely, after asking the user, or never.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Policy {
    Allow,
    Ask,
    Off,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub name: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: String,
    pub input_schema: Value,
    /// The server's own claim that the tool changes nothing.
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub id: String,
    pub name: String,
    pub url: String,
    pub enabled: bool,
    /// On this Mac or its network, decided when the address was saved. A
    /// server on the internet is never allowed to lead requests back inside.
    pub local: bool,
    /// The name is a placeholder until the server gives its own.
    #[serde(default)]
    pub auto_name: bool,
    /// An OAuth client the user registered, for services without dynamic registration.
    #[serde(default)]
    pub client_id: Option<String>,
    /// How a server that runs on this Mac is started. Read from `mcp.json`
    /// each time and never saved with the rest.
    #[serde(skip)]
    pub launch: Option<config::Launch>,
    /// The server's tools as of the last connection.
    #[serde(default)]
    pub tools: Vec<Tool>,
    /// The user's choices, by tool name, where they differ from the default.
    #[serde(default)]
    pub policies: HashMap<String, Policy>,
    /// Unix milliseconds.
    #[serde(default)]
    pub added_at: i64,
}

impl ServerConfig {
    /// Read-only tools run freely; anything else asks first.
    fn policy(&self, tool: &Tool) -> Policy {
        self.policies.get(&tool.name).copied()
            .unwrap_or(if tool.read_only { Policy::Allow } else { Policy::Ask })
    }

    /// The name the agent addresses this server by.
    fn key(&self) -> String {
        slug(&self.name)
    }

    fn fetcher(&self) -> web::Fetcher {
        if self.local { web::ANY } else { web::PUBLIC }
    }

    /// A program `mcp.json` defines, as first seen: on, with nothing known about it yet.
    fn program(id: String) -> Self {
        Self {
            id, name: String::new(), url: String::new(), enabled: true, local: true, auto_name: false, client_id: None,
            launch: None, tools: Vec::new(), policies: HashMap::new(), added_at: chrono::Utc::now().timestamp_millis(),
        }
    }

    fn is_program(&self) -> bool {
        self.id.starts_with(PROGRAM_ID)
    }

    /// How to start this server when it is a program; `None` for a remote one.
    fn launch(&self) -> Result<Option<&config::Launch>, Failure> {
        match &self.launch {
            None if self.is_program() => Err(Failure::Other(format!("Fix {} to start this server again", config::FILE))),
            launch => Ok(launch.as_ref()),
        }
    }
}

/// A program is known by its name in `mcp.json`, so what is saved about it
/// outlives edits to the file.
fn program_id(name: &str) -> String {
    let digest: String = Sha256::digest(name.as_bytes()).iter().take(8).map(|byte| format!("{byte:02x}")).collect();
    format!("{PROGRAM_ID}{digest}")
}

fn slug(name: &str) -> String {
    let mut key = String::new();
    for character in name.chars() {
        if character.is_ascii_alphanumeric() {
            key.push(character.to_ascii_lowercase());
        } else if !key.is_empty() && !key.ends_with('-') {
            key.push('-');
        }
    }
    let key = key.trim_end_matches('-');
    if key.is_empty() { "server".into() } else { key.into() }
}

/// `wanted`, numbered if another server already answers to it.
fn unique_name(servers: &[ServerConfig], wanted: &str, except: Option<&str>) -> String {
    let wanted: String = wanted.trim().chars().take(MAX_NAME_CHARS).collect();
    let taken = |name: &str| servers.iter().any(|server| Some(server.id.as_str()) != except && server.key() == slug(name));
    if !taken(&wanted) {
        return wanted;
    }
    (2..).map(|number| format!("{wanted} {number}")).find(|name| !taken(name)).unwrap_or(wanted)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Connection {
    Disconnected,
    Connecting,
    Connected,
    NeedsAuth,
    Authorizing,
    Error,
}

#[derive(Clone)]
struct Status {
    connection: Connection,
    detail: Option<String>,
}

#[derive(Default)]
pub struct McpState {
    sessions: tokio::sync::Mutex<HashMap<String, client::Session>>,
    /// The programs running for servers on this Mac. Dropping one stops it.
    processes: tokio::sync::Mutex<HashMap<String, Arc<stdio::Process>>>,
    /// How each program was last started, to tell when `mcp.json` has changed.
    tried: Mutex<HashMap<String, config::Launch>>,
    status: Mutex<HashMap<String, Status>>,
    /// Sign-ins in progress, by server, so a new one or Cancel can end them.
    logins: Mutex<HashMap<String, Arc<Notify>>>,
}

impl McpState {
    fn set(&self, id: &str, connection: Connection, detail: Option<String>) {
        self.status.lock().expect("mcp status mutex").insert(id.to_owned(), Status { connection, detail });
    }

    fn status(&self, id: &str) -> Status {
        self.status.lock().expect("mcp status mutex").get(id).cloned()
            .unwrap_or(Status { connection: Connection::Disconnected, detail: None })
    }

    async fn forget(&self, id: &str) {
        self.sessions.lock().await.remove(id);
        self.processes.lock().await.remove(id);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolView {
    name: String,
    title: Option<String>,
    description: String,
    read_only: bool,
    policy: Policy,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerView {
    id: String,
    name: String,
    /// What the agent calls the server.
    key: String,
    url: String,
    /// The command a server on this Mac runs as, without its variables.
    command: Option<String>,
    /// `stdio` for a program on this Mac, `http` for a server at an address.
    transport: &'static str,
    enabled: bool,
    local: bool,
    client_id: Option<String>,
    /// How ChatGSD signs in: `oauth`, `token` (pasted by the user) or `none`.
    auth: &'static str,
    status: Connection,
    detail: Option<String>,
    tools: Vec<ToolView>,
}

fn view(server: &ServerConfig, credentials: Option<&store::Credentials>, status: Status) -> ServerView {
    let auth = match credentials {
        Some(credentials) if credentials.oauth.is_some() => "oauth",
        Some(credentials) if credentials.token.is_some() => "token",
        _ => "none",
    };
    let status = match server.launch() {
        Err(Failure::Other(message)) => Status { connection: Connection::Error, detail: Some(message) },
        _ => status,
    };
    ServerView {
        id: server.id.clone(),
        name: server.name.clone(),
        key: server.key(),
        url: server.url.clone(),
        command: server.launch.as_ref().map(config::Launch::line),
        transport: if server.is_program() { "stdio" } else { "http" },
        enabled: server.enabled,
        local: server.local,
        client_id: server.client_id.clone(),
        auth,
        status: if server.enabled { status.connection } else { Connection::Disconnected },
        detail: status.detail.filter(|_| server.enabled),
        tools: server.tools.iter().map(|tool| ToolView {
            name: tool.name.clone(),
            title: tool.title.clone(),
            description: tool.description.clone(),
            read_only: tool.read_only,
            policy: server.policy(tool),
        }).collect(),
    }
}

async fn views(app: &tauri::AppHandle) -> Result<Vec<ServerView>, String> {
    let store = store::read(&store::root(app)?).await?;
    let state = app.state::<McpState>();
    Ok(store.servers.iter().map(|server| view(server, store.credentials.get(&server.id), state.status(&server.id))).collect())
}

/// Tells the settings page and the panel that servers changed.
async fn announce(app: &tauri::AppHandle) {
    if let Ok(servers) = views(app).await {
        let _ = app.emit("mcp:changed", servers);
    }
}

async fn is_local(url: &Url) -> Result<bool, String> {
    match url.host() {
        Some(Host::Ipv4(ip)) => Ok(!web::is_public(ip.into())),
        Some(Host::Ipv6(ip)) => Ok(!web::is_public(ip.into())),
        Some(Host::Domain(domain)) => {
            let port = url.port_or_known_default().unwrap_or(443);
            let addresses: Vec<_> = tokio::net::lookup_host((domain, port)).await
                .map_err(|_| format!("Couldn't find {domain}"))?.collect();
            if addresses.is_empty() {
                return Err(format!("Couldn't find {domain}"));
            }
            Ok(!addresses.iter().all(|address| web::is_public(address.ip())))
        }
        None => Err("Enter the server's web address".into()),
    }
}

/// The address as it is saved, and whether it is on this Mac or its network.
async fn server_address(input: &str) -> Result<(Url, bool), String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("Enter the server's web address".into());
    }
    let on_this_mac = ["localhost", "127.0.0.1", "[::1]"].iter().any(|host| text.starts_with(host));
    let text = match text.contains("://") {
        true => text.to_owned(),
        false => format!("{}://{text}", if on_this_mac { "http" } else { "https" }),
    };
    let mut url = web::http_url(&text)?;
    url.set_fragment(None);
    let local = is_local(&url).await?;
    if url.scheme() == "http" && !local {
        return Err("Use an https address for a server on the internet".into());
    }
    Ok((url, local))
}

#[derive(Debug)]
enum Failure {
    NeedsAuth,
    Other(String),
}

static AUTH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The token to send, renewing an OAuth token that has run out or, with
/// `force`, one the server just refused.
async fn bearer(root: &Path, server: &ServerConfig, force: bool) -> Result<Option<String>, String> {
    let credentials = |store: store::Store| store.credentials.get(&server.id).cloned().unwrap_or_default();
    let saved = credentials(store::read(root).await?);
    let Some(tokens) = saved.oauth else { return Ok(saved.token) };
    if !force && !tokens.expired() {
        return Ok(Some(tokens.access_token));
    }
    if tokens.refresh_token.is_none() {
        return Ok((!force).then_some(tokens.access_token));
    }
    let _guard = AUTH_LOCK.lock().await;
    // Another request may have renewed it while this one waited; a refresh
    // token is often good only once.
    match credentials(store::read(root).await?).oauth {
        Some(current) if current.access_token != tokens.access_token => return Ok(Some(current.access_token)),
        None => return Ok(None),
        Some(_) => {}
    }
    let renewed = match oauth::refresh(server.fetcher(), server.local, &tokens).await {
        Ok(renewed) => Some(renewed),
        Err(oauth::TokenError::Rejected(_)) => None,
        Err(oauth::TokenError::Other(message)) => return Err(message),
    };
    let token = renewed.as_ref().map(|tokens| tokens.access_token.clone());
    store::update(root, |store| {
        if store.server(&server.id).is_ok() {
            store.credentials.entry(server.id.clone()).or_default().oauth = renewed;
        }
        Ok(())
    }).await?;
    Ok(token)
}

async fn endpoint(root: &Path, server: &ServerConfig, force: bool) -> Result<Endpoint, Failure> {
    let url = Url::parse(&server.url).map_err(|_| Failure::Other("This server's address is no longer valid".into()))?;
    let bearer = bearer(root, server, force).await.map_err(Failure::Other)?;
    Ok(Endpoint { url, fetcher: server.fetcher(), bearer })
}

/// Starts a session, renewing the sign-in once if the server refuses it.
async fn open(root: &Path, server: &ServerConfig) -> Result<(Endpoint, client::Hello), Failure> {
    let mut force = false;
    loop {
        let endpoint = endpoint(root, server, force).await?;
        match endpoint.initialize().await {
            Ok(hello) => return Ok((endpoint, hello)),
            Err(client::Error::Unauthorized(_)) if !force && endpoint.bearer.is_some() => force = true,
            Err(client::Error::Unauthorized(_)) => return Err(Failure::NeedsAuth),
            Err(error) => return Err(Failure::Other(error.to_string())),
        }
    }
}

/// The server's program, started if it isn't running or `mcp.json` now
/// starts it differently.
async fn running(state: &McpState, server: &ServerConfig, launch: &config::Launch) -> Result<Arc<stdio::Process>, Failure> {
    let current = state.processes.lock().await.get(&server.id)
        .filter(|process| process.alive() && &process.launch == launch).cloned();
    if let Some(process) = current {
        return Ok(process);
    }
    let process = Arc::new(stdio::Process::start(launch).await.map_err(|error| Failure::Other(error.to_string()))?);
    state.processes.lock().await.insert(server.id.clone(), process.clone());
    Ok(process)
}

/// Connects and saves what the server says about itself: its tools, and its
/// name while the user hasn't chosen one.
async fn connect_in(state: &McpState, root: &Path, id: &str) -> Result<(), Failure> {
    let server = store::read(root).await.map_err(Failure::Other)?.server(id).map_err(Failure::Other)?.clone();
    state.forget(id).await;
    let (named, tools, session) = match server.launch()? {
        Some(launch) => {
            state.tried.lock().expect("mcp tried mutex").insert(id.to_owned(), launch.clone());
            let process = running(state, &server, launch).await?;
            let tools = client::list_tools(&*process).await.map_err(|error| Failure::Other(error.to_string()))?;
            (None, tools, None)
        }
        None => {
            let (endpoint, hello) = open(root, &server).await?;
            let tools = match endpoint.list_tools(&hello.session).await {
                Ok(tools) => tools,
                Err(client::Error::Unauthorized(_)) => return Err(Failure::NeedsAuth),
                Err(error) => return Err(Failure::Other(error.to_string())),
            };
            (hello.name, tools, Some(hello.session))
        }
    };
    store::update(root, |store| {
        let named = named.as_deref().map(|name| unique_name(&store.servers, name, Some(id)));
        let server = store.server_mut(id)?;
        server.policies.retain(|name, _| tools.iter().any(|tool| &tool.name == name));
        server.tools = tools;
        if let Some(name) = named.filter(|_| server.auto_name) {
            server.name = name;
            server.auto_name = false;
        }
        Ok(())
    }).await.map_err(Failure::Other)?;
    if let Some(session) = session {
        state.sessions.lock().await.insert(id.to_owned(), session);
    }
    Ok(())
}

async fn connect(app: &tauri::AppHandle, id: &str) {
    let state = app.state::<McpState>();
    let Ok(root) = store::root(app) else { return };
    state.set(id, Connection::Connecting, None);
    announce(app).await;
    match connect_in(&state, &root, id).await {
        Ok(()) => state.set(id, Connection::Connected, None),
        Err(Failure::NeedsAuth) => state.set(id, Connection::NeedsAuth, None),
        Err(Failure::Other(message)) => state.set(id, Connection::Error, Some(message)),
    }
    announce(app).await;
}

/// Brings the running programs in line with `mcp.json` after it may have
/// changed: stops those it no longer has, and starts what is new or is now
/// started differently.
async fn sync(app: &tauri::AppHandle, root: &Path) {
    let Ok(store) = store::read(root).await else { return };
    let state = app.state::<McpState>();
    state.processes.lock().await
        .retain(|id, _| store.servers.iter().any(|server| &server.id == id && server.enabled));
    let changed: Vec<&ServerConfig> = {
        let tried = state.tried.lock().expect("mcp tried mutex");
        store.servers.iter()
            .filter(|server| server.enabled && server.launch.is_some() && tried.get(&server.id) != server.launch.as_ref())
            .collect()
    };
    futures_util::future::join_all(changed.iter().map(|server| connect(app, &server.id))).await;
    announce(app).await;
}

/// Connects every enabled server, so the panel shows what's reachable.
pub fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(root) = store::root(&app) else { return };
        let Ok(store) = store::read(&root).await else { return };
        let enabled = store.servers.iter().filter(|server| server.enabled);
        futures_util::future::join_all(enabled.map(|server| connect(&app, &server.id))).await;
    });
}

/// Calls a tool, starting a session if there is none. A call the server never
/// ran (its session or sign-in had lapsed) is retried once; nothing else is.
async fn invoke(state: &McpState, root: &Path, server: &ServerConfig, tool: &str, arguments: &Value) -> Result<Value, Failure> {
    if let Some(launch) = server.launch()? {
        let process = running(state, server, launch).await?;
        return client::call_tool(&*process, tool, arguments).await.map_err(|error| Failure::Other(error.to_string()));
    }
    let mut retried = false;
    loop {
        let existing = state.sessions.lock().await.get(&server.id).cloned();
        let (endpoint, session) = match existing {
            Some(session) => (endpoint(root, server, false).await?, session),
            None => {
                let (endpoint, hello) = open(root, server).await?;
                state.sessions.lock().await.insert(server.id.clone(), hello.session.clone());
                (endpoint, hello.session)
            }
        };
        match endpoint.call_tool(&session, tool, arguments).await {
            Ok(result) => return Ok(result),
            Err(client::Error::SessionExpired | client::Error::Unauthorized(_)) if !retried => {
                retried = true;
                state.forget(&server.id).await;
            }
            Err(client::Error::Unauthorized(_)) => return Err(Failure::NeedsAuth),
            Err(error) => return Err(Failure::Other(error.to_string())),
        }
    }
}

/// Signs in through the browser and saves the grant. A server that answers
/// without credentials needs no sign-in, which is also success.
async fn authorize_in(root: &Path, id: &str, open_page: impl FnOnce(&str) -> Result<(), String>) -> Result<(), String> {
    let store = store::read(root).await?;
    let server = store.server(id)?.clone();
    let url = Url::parse(&server.url).map_err(|_| "This server's address is no longer valid".to_owned())?;
    // Asking without credentials makes the server say where to sign in.
    let probe = Endpoint { url: url.clone(), fetcher: server.fetcher(), bearer: None };
    let challenge = match probe.initialize().await {
        Ok(hello) => {
            probe.close(&hello.session).await;
            return Ok(());
        }
        Err(client::Error::Unauthorized(header)) => oauth::challenge(header.as_deref()),
        Err(error) => return Err(error.to_string()),
    };
    let grant = oauth::authorize(oauth::Request {
        fetcher: server.fetcher(),
        local: server.local,
        server: &url,
        challenge,
        client_id: server.client_id.as_deref(),
        saved: store.credentials.get(id).and_then(|credentials| credentials.client.clone()),
    }, open_page).await?;
    store::update(root, |store| {
        store.server(id)?;
        let credentials = store.credentials.entry(id.to_owned()).or_default();
        credentials.client = Some(grant.client);
        credentials.oauth = Some(grant.tokens);
        Ok(())
    }).await
}

fn clean(value: Option<String>, limit: usize) -> Option<String> {
    value.map(|value| value.trim().chars().take(limit).collect::<String>()).filter(|value| !value.is_empty())
}

fn full() -> String {
    format!("ChatGSD keeps up to {MAX_SERVERS} servers. Remove one first.")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInput {
    url: String,
    /// Left out, the server's own name is used.
    name: Option<String>,
    /// An access token to send instead of signing in with OAuth. When
    /// updating: left out keeps the saved one, empty removes it.
    token: Option<String>,
    client_id: Option<String>,
}

async fn one_view(app: &tauri::AppHandle, id: &str) -> Result<ServerView, String> {
    views(app).await?.into_iter().find(|server| server.id == id).ok_or_else(|| "This server was removed".into())
}

#[tauri::command]
pub async fn mcp_list_servers(app: tauri::AppHandle) -> Result<Vec<ServerView>, String> {
    views(&app).await
}

/// The loopback address to register for a hand-made OAuth client.
#[tauri::command]
pub fn mcp_redirect_uri() -> String {
    oauth::redirect_uri(oauth::PRESET_PORT)
}

#[tauri::command]
pub async fn mcp_add_server(app: tauri::AppHandle, request: ServerInput) -> Result<ServerView, String> {
    let (url, local) = server_address(&request.url).await?;
    let host = url.host_str().unwrap_or("server").to_owned();
    let name = clean(request.name, MAX_NAME_CHARS);
    let token = clean(request.token, MAX_TOKEN_CHARS);
    let id = uuid::Uuid::new_v4().to_string();
    store::update(&store::root(&app)?, |store| {
        if store.servers.iter().any(|server| server.url == url.as_str()) {
            return Err("This server is already added".into());
        }
        if store.servers.len() >= MAX_SERVERS {
            return Err(full());
        }
        store.servers.push(ServerConfig {
            id: id.clone(),
            name: unique_name(&store.servers, name.as_deref().unwrap_or(&host), None),
            url: url.to_string(),
            enabled: true,
            local,
            auto_name: name.is_none(),
            client_id: clean(request.client_id, 400),
            launch: None,
            tools: Vec::new(),
            policies: HashMap::new(),
            added_at: chrono::Utc::now().timestamp_millis(),
        });
        if token.is_some() {
            store.credentials.insert(id.clone(), store::Credentials { token, ..Default::default() });
        }
        Ok(())
    }).await?;
    connect(&app, &id).await;
    one_view(&app, &id).await
}

/// Writes a program into `mcp.json` and starts it.
async fn add_program(app: &tauri::AppHandle, name: String, launch: config::Launch) -> Result<ServerView, String> {
    let root = store::root(app)?;
    let store = store::read(&root).await?;
    if store.servers.len() >= MAX_SERVERS {
        return Err(full());
    }
    if store.servers.iter().any(|server| server.key() == slug(&name)) {
        return Err(format!("Another server is already called {name}"));
    }
    let entry = serde_json::to_value(&launch).map_err(|error| error.to_string())?;
    config::change(&root, |servers| {
        if servers.contains_key(&name) {
            return Err(format!("{} already has a server called {name}", config::FILE));
        }
        servers.insert(name.clone(), entry);
        Ok(())
    }).await?;
    let id = program_id(&name);
    connect(app, &id).await;
    one_view(app, &id).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerInput {
    name: String,
    /// The command line that starts the server.
    command: String,
    /// `NAME=value` lines.
    env: Option<String>,
}

#[tauri::command]
pub async fn mcp_add_local_server(app: tauri::AppHandle, request: LocalServerInput) -> Result<ServerView, String> {
    let name = clean(Some(request.name), MAX_NAME_CHARS).ok_or("Give the server a name")?;
    let launch = config::Launch::parse(&request.command, request.env.as_deref().unwrap_or_default())?;
    add_program(&app, name, launch).await
}

/// A server found in another app's configuration, not yet added here.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundView {
    name: String,
    /// The command it runs, or its address.
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    /// What is wrong with `mcp.json`, in words for the user.
    problem: Option<String>,
    /// Servers Codex is set up with that ChatGSD doesn't have.
    found: Vec<FoundView>,
}

fn known(store: &store::Store, found: &config::Found) -> bool {
    store.servers.iter().any(|server| match &found.source {
        config::Source::Program(launch) => server.launch.as_ref() == Some(launch) || server.id == program_id(&found.name),
        config::Source::Address(address) => Url::parse(address).is_ok_and(|url| server.url == url.as_str()),
    })
}

/// Follows `mcp.json` as it is now, and says what else could be added.
/// Settings calls this when it opens and when the window is returned to.
#[tauri::command]
pub async fn mcp_load_config(app: tauri::AppHandle) -> Result<ConfigView, String> {
    let root = store::root(&app)?;
    sync(&app, &root).await;
    let store = store::read(&root).await?;
    let found = config::codex().await.into_iter().filter(|found| !known(&store, found)).map(|found| FoundView {
        name: found.name,
        detail: match found.source {
            config::Source::Program(launch) => launch.line(),
            config::Source::Address(address) => address,
        },
    }).collect();
    Ok(ConfigView { problem: store.problem, found })
}

/// Adds a server Codex is set up with. It is read again from Codex's
/// configuration here, so its variables never pass through the window.
#[tauri::command]
pub async fn mcp_add_found_server(app: tauri::AppHandle, name: String) -> Result<ServerView, String> {
    let found = config::codex().await.into_iter().find(|found| found.name == name)
        .ok_or("Codex no longer has this server")?;
    match found.source {
        config::Source::Program(launch) => add_program(&app, found.name, launch).await,
        config::Source::Address(url) => {
            mcp_add_server(app, ServerInput { url, name: Some(found.name), token: None, client_id: None }).await
        }
    }
}

/// Shows `mcp.json` in Finder, creating it if there is none to edit yet.
#[tauri::command]
pub async fn mcp_reveal_config(app: tauri::AppHandle) -> Result<(), String> {
    let root = store::root(&app)?;
    let path = config::path(&root);
    if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
        config::change(&root, |_| Ok(())).await?;
    }
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|error| format!("Couldn't show {}: {error}", config::FILE))
}

#[tauri::command]
pub async fn mcp_update_server(app: tauri::AppHandle, id: String, request: ServerInput) -> Result<ServerView, String> {
    if id.starts_with(PROGRAM_ID) {
        return Err(format!("This server is defined in {}. Edit it there.", config::FILE));
    }
    let (url, local) = server_address(&request.url).await?;
    let name = clean(request.name, MAX_NAME_CHARS);
    let client_id = clean(request.client_id, 400);
    let token = request.token.map(|token| clean(Some(token), MAX_TOKEN_CHARS));
    let reconnect = store::update(&store::root(&app)?, |store| {
        if store.servers.iter().any(|server| server.id != id && server.url == url.as_str()) {
            return Err("Another server already uses this address".into());
        }
        let renamed = name.as_deref().map(|name| unique_name(&store.servers, name, Some(&id)));
        let server = store.server_mut(&id)?;
        let moved = server.url != url.as_str();
        let sign_in_changed = moved || server.client_id != client_id;
        if let Some(name) = renamed.filter(|name| name != &server.name) {
            server.name = name;
            server.auto_name = false;
        }
        server.url = url.to_string();
        server.local = local;
        server.client_id = client_id;
        if moved {
            server.tools.clear();
            server.policies.clear();
        }
        let enabled = server.enabled;
        let credentials = store.credentials.entry(id.clone()).or_default();
        // A sign-in belongs to the address and client it was granted to.
        if sign_in_changed {
            credentials.client = None;
            credentials.oauth = None;
        }
        let token_changed = token.as_ref().is_some_and(|token| token != &credentials.token);
        if let Some(token) = token {
            credentials.token = token;
        }
        Ok(enabled && (sign_in_changed || token_changed))
    }).await?;
    if reconnect {
        connect(&app, &id).await;
    } else {
        announce(&app).await;
    }
    one_view(&app, &id).await
}

fn end_login(state: &McpState, id: &str) {
    if let Some(login) = state.logins.lock().expect("mcp logins mutex").remove(id) {
        login.notify_one();
    }
}

#[tauri::command]
pub async fn mcp_remove_server(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let root = store::root(&app)?;
    let state = app.state::<McpState>();
    end_login(&state, &id);
    let server = store::read(&root).await?.servers.into_iter().find(|server| server.id == id);
    if server.as_ref().is_some_and(ServerConfig::is_program) {
        config::change(&root, |servers| {
            servers.retain(|name, _| program_id(name) != id);
            Ok(())
        }).await?;
    }
    state.processes.lock().await.remove(&id);
    state.tried.lock().expect("mcp tried mutex").remove(&id);
    let session = state.sessions.lock().await.remove(&id);
    if let (Some(server), Some(session)) = (server, session) {
        if let Ok(endpoint) = endpoint(&root, &server, false).await {
            endpoint.close(&session).await;
        }
    }
    store::update(&root, |store| {
        store.servers.retain(|server| server.id != id);
        Ok(())
    }).await?;
    state.status.lock().expect("mcp status mutex").remove(&id);
    announce(&app).await;
    Ok(())
}

#[tauri::command]
pub async fn mcp_set_server_enabled(app: tauri::AppHandle, id: String, enabled: bool) -> Result<(), String> {
    store::update(&store::root(&app)?, |store| {
        store.server_mut(&id)?.enabled = enabled;
        Ok(())
    }).await?;
    if enabled {
        connect(&app, &id).await;
    } else {
        let state = app.state::<McpState>();
        end_login(&state, &id);
        state.forget(&id).await;
        state.set(&id, Connection::Disconnected, None);
        announce(&app).await;
    }
    Ok(())
}

/// Drops the session and connects again, re-reading the server's tools.
#[tauri::command]
pub async fn mcp_connect_server(app: tauri::AppHandle, id: String) -> Result<(), String> {
    store::read(&store::root(&app)?).await?.server(&id)?;
    connect(&app, &id).await;
    Ok(())
}

/// Opens the server's sign-in in the browser and waits for it to finish.
/// Starting again, or Cancel, ends a sign-in that is still waiting.
#[tauri::command]
pub async fn mcp_authorize_server(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let root = store::root(&app)?;
    let state = app.state::<McpState>();
    let cancel = Arc::new(Notify::new());
    if let Some(previous) = state.logins.lock().expect("mcp logins mutex").insert(id.clone(), cancel.clone()) {
        previous.notify_one();
    }
    state.set(&id, Connection::Authorizing, None);
    announce(&app).await;
    let open_page = |page: &str| open::that(page).map_err(|error| format!("Couldn't open your browser: {error}"));
    let outcome = tokio::select! {
        result = authorize_in(&root, &id, open_page) => Some(result),
        _ = cancel.notified() => None,
        _ = tokio::time::sleep(LOGIN_TIMEOUT) => Some(Err("Sign-in wasn't finished in time. Try again.".into())),
    };
    {
        let mut logins = state.logins.lock().expect("mcp logins mutex");
        if logins.get(&id).is_some_and(|current| Arc::ptr_eq(current, &cancel)) {
            logins.remove(&id);
        } else if logins.contains_key(&id) {
            // A newer sign-in took over; its outcome is the one that counts.
            return Ok(());
        }
    }
    match outcome {
        Some(Ok(())) => {
            connect(&app, &id).await;
            Ok(())
        }
        Some(Err(message)) => {
            state.set(&id, Connection::NeedsAuth, Some(message.clone()));
            announce(&app).await;
            Err(message)
        }
        None => {
            if state.status(&id).connection == Connection::Authorizing {
                state.set(&id, Connection::NeedsAuth, None);
            }
            announce(&app).await;
            Ok(())
        }
    }
}

#[tauri::command]
pub fn mcp_cancel_authorize(app: tauri::AppHandle, id: String) {
    end_login(&app.state::<McpState>(), &id);
}

/// Forgets the OAuth sign-in. The app's registration is kept for next time.
#[tauri::command]
pub async fn mcp_sign_out_server(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let enabled = store::update(&store::root(&app)?, |store| {
        let enabled = store.server(&id)?.enabled;
        if let Some(credentials) = store.credentials.get_mut(&id) {
            credentials.oauth = None;
        }
        Ok(enabled)
    }).await?;
    if enabled {
        connect(&app, &id).await;
    } else {
        announce(&app).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_set_tool_policy(app: tauri::AppHandle, id: String, tool: String, policy: Policy) -> Result<(), String> {
    store::update(&store::root(&app)?, |store| {
        let server = store.server_mut(&id)?;
        if !server.tools.iter().any(|known| known.name == tool) {
            return Err("This server no longer has that tool".into());
        }
        server.policies.insert(tool, policy);
        Ok(())
    }).await?;
    announce(&app).await;
    Ok(())
}

fn access_note(policy: Policy) -> &'static str {
    match policy {
        Policy::Ask => " [asks the user first]",
        _ => "",
    }
}

fn overview_line(server: &ServerConfig, status: Connection) -> String {
    let key = server.key();
    let label = if key == server.name { key } else { format!("{key} ({})", server.name) };
    if status == Connection::NeedsAuth || status == Connection::Authorizing {
        return format!("- {label}: unavailable until the user signs in under {SETTINGS}");
    }
    let tools: Vec<&Tool> = server.tools.iter().filter(|tool| server.policy(tool) != Policy::Off).collect();
    if tools.is_empty() {
        return format!("- {label}: no tools listed yet; mcp_tools connects and lists them");
    }
    let mut names: Vec<&str> = tools.iter().take(MAX_OVERVIEW_TOOLS).map(|tool| tool.name.as_str()).collect();
    if tools.len() > names.len() {
        names.push("…");
    }
    format!("- {label}: {}", names.join(", "))
}

/// The services available for this message, for the agent. `None` when the
/// user has none turned on.
pub async fn overview(app: &tauri::AppHandle) -> Option<String> {
    let store = store::read(&store::root(app).ok()?).await.ok()?;
    let state = app.state::<McpState>();
    let lines: Vec<String> = store.servers.iter().filter(|server| server.enabled)
        .map(|server| overview_line(server, state.status(&server.id).connection)).collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

fn find_server<'a>(store: &'a store::Store, wanted: &str) -> Result<&'a ServerConfig, ToolOutput> {
    let wanted = wanted.trim();
    let enabled: Vec<&ServerConfig> = store.servers.iter().filter(|server| server.enabled).collect();
    enabled.iter().copied()
        .find(|server| server.key() == slug(wanted) || server.name.eq_ignore_ascii_case(wanted))
        .ok_or_else(|| ToolOutput::error(match enabled.is_empty() {
            true => format!("The user has no services connected. They can add one under {SETTINGS}."),
            false => format!("No connected service is called {wanted:?}. Available: {}.",
                enabled.iter().map(|server| server.key()).collect::<Vec<_>>().join(", ")),
        }))
}

fn needs_sign_in(server: &ServerConfig) -> ToolOutput {
    ToolOutput::error(format!(
        "{} needs the user to sign in again under {SETTINGS}. Tell them; don't retry until they have.",
        server.name
    ))
}

fn describe_tools(server: &ServerConfig, only: Option<&str>) -> ToolOutput {
    let tools: Vec<&Tool> = server.tools.iter()
        .filter(|tool| server.policy(tool) != Policy::Off && only.is_none_or(|name| tool.name == name)).collect();
    if let (Some(name), true) = (only, tools.is_empty()) {
        return ToolOutput::error(format!("{} has no tool called {name:?}. Call mcp_tools with tool null to list them.", server.name));
    }
    if tools.is_empty() {
        return ToolOutput::ok(format!("{} offers no tools the user has left on.", server.name));
    }
    let entry = |tool: &Tool, schema: bool| {
        let mut text = format!("## {}{}\n{}", tool.name, access_note(server.policy(tool)), tool.description);
        if schema {
            text.push_str(&format!("\nInput schema: {}", tool.input_schema));
        }
        text
    };
    let header = format!("{} (server {:?}), {} tools. Call one with mcp_call.", server.name, server.key(), tools.len());
    let full: Vec<String> = tools.iter().map(|tool| entry(tool, true)).collect();
    if only.is_some() || full.iter().map(String::len).sum::<usize>() <= MAX_CATALOG_CHARS {
        return ToolOutput::ok(format!("{header}\n\n{}", full.join("\n\n")));
    }
    let brief: Vec<String> = tools.iter().map(|tool| entry(tool, false)).collect();
    ToolOutput::ok(format!(
        "{header} Input schemas are left out for length: call mcp_tools again with tool set to see one before calling it.\n\n{}",
        brief.join("\n\n")
    ))
}

/// `mcp_tools`: what one connected service can do.
pub async fn describe(app: &tauri::AppHandle, args: &Value) -> ToolOutput {
    let Some(wanted) = args.get("server").and_then(Value::as_str) else {
        return ToolOutput::error("server must be a string");
    };
    let only = args.get("tool").and_then(Value::as_str).filter(|tool| !tool.is_empty());
    let root = match store::root(app) {
        Ok(root) => root,
        Err(error) => return ToolOutput::error(error),
    };
    let read = || async { store::read(&root).await.map_err(ToolOutput::error) };
    let id = match read().await.and_then(|store| find_server(&store, wanted).map(|server| server.id.clone())) {
        Ok(id) => id,
        Err(error) => return error,
    };
    let state = app.state::<McpState>();
    // The saved list may be stale or empty; a connection refreshes it. A
    // sign-in in progress is left to finish.
    if matches!(state.status(&id).connection, Connection::Disconnected | Connection::Error) {
        connect(app, &id).await;
    }
    let store = match read().await {
        Ok(store) => store,
        Err(error) => return error,
    };
    let Ok(server) = store.server(&id) else {
        return ToolOutput::error("The user removed this service");
    };
    match state.status(&id) {
        Status { connection: Connection::NeedsAuth | Connection::Authorizing, .. } => needs_sign_in(server),
        Status { connection: Connection::Error, detail } if server.tools.is_empty() => ToolOutput::error(format!(
            "Couldn't connect to {}: {}", server.name, detail.unwrap_or_else(|| "unknown error".into())
        )),
        _ => describe_tools(server, only),
    }
}

fn clip(text: String, limit: usize, note: &str) -> String {
    match text.char_indices().nth(limit) {
        Some((end, _)) => format!("{}{note}", &text[..end]),
        None => text,
    }
}

/// A tool result as text for the model. Images and audio are named, not sent.
fn render(result: &Value) -> ToolOutput {
    let mut parts: Vec<String> = Vec::new();
    for block in result["content"].as_array().into_iter().flatten() {
        match block["type"].as_str() {
            Some("text") => parts.extend(block["text"].as_str().map(str::to_owned)),
            Some("resource") => {
                let resource = &block["resource"];
                parts.push(resource["text"].as_str().map(str::to_owned)
                    .unwrap_or_else(|| format!("[Attached resource: {}]", resource["uri"].as_str().unwrap_or("unnamed"))));
            }
            Some("resource_link") => parts.push(format!(
                "[Link: {} {}]", block["name"].as_str().unwrap_or_default(), block["uri"].as_str().unwrap_or_default()
            )),
            Some(kind @ ("image" | "audio")) => parts.push(format!("[{kind} not shown]")),
            _ => {}
        }
    }
    if parts.is_empty() {
        parts.extend(result.get("structuredContent").filter(|content| !content.is_null()).map(Value::to_string));
    }
    let text = if parts.is_empty() { "The tool returned nothing.".to_owned() } else { parts.join("\n") };
    ToolOutput {
        ok: result["isError"] != true,
        text: clip(text, MAX_RESULT_CHARS, "\n[Cut here for length. Ask the tool for less at a time.]"),
    }
}

/// Asks the user whether this call may run. "Always allow" also saves that
/// choice for the tool.
async fn approved(app: &tauri::AppHandle, run_id: &str, server: &ServerConfig, tool: &Tool, arguments: &Value) -> Result<(), ToolOutput> {
    let shown = serde_json::to_string_pretty(arguments).unwrap_or_default();
    // The tool's own name, not the title the server chose for it: the name
    // is what the user's standing choices are kept by.
    let question = format!("Allow {} to run {}?\n{}", server.name, tool.name, clip(shown, 600, "\n…"));
    let answer = app.state::<AgentState>().bridge.execute(app, run_id, "mcp_approval", json!({
        "question": question, "options": [ALLOW_ONCE, ALWAYS_ALLOW, DENY], "form": null,
    }), None).await;
    if !answer.ok {
        return Err(answer);
    }
    let choice = answer.text.strip_prefix("The user answered: ").unwrap_or(&answer.text).trim();
    match choice {
        ALLOW_ONCE => Ok(()),
        ALWAYS_ALLOW => {
            let saved = match store::root(app) {
                Ok(root) => store::update(&root, |store| {
                    store.server_mut(&server.id)?.policies.insert(tool.name.clone(), Policy::Allow);
                    Ok(())
                }).await,
                Err(error) => Err(error),
            };
            // The call was approved either way; only the standing choice is lost.
            if saved.is_ok() {
                announce(app).await;
            }
            Ok(())
        }
        DENY => Err(ToolOutput::error("The user didn't allow this call. Don't retry it; continue without it or ask what they'd prefer.")),
        other => Err(ToolOutput::error(format!(
            "The user didn't allow this call and answered: {other}\nDon't retry it unchanged."
        ))),
    }
}

/// `mcp_call`: runs one tool on a connected service.
pub async fn call(app: &tauri::AppHandle, run_id: &str, args: &Value) -> ToolOutput {
    let (Some(wanted), Some(name)) = (args.get("server").and_then(Value::as_str), args.get("tool").and_then(Value::as_str)) else {
        return ToolOutput::error("server and tool must be strings");
    };
    let arguments = match args.get("arguments") {
        Some(arguments) if arguments.is_object() => arguments.clone(),
        None | Some(Value::Null) => json!({}),
        Some(_) => return ToolOutput::error("arguments must be an object"),
    };
    let root = match store::root(app) {
        Ok(root) => root,
        Err(error) => return ToolOutput::error(error),
    };
    let store = match store::read(&root).await {
        Ok(store) => store,
        Err(error) => return ToolOutput::error(error),
    };
    let server = match find_server(&store, wanted) {
        Ok(server) => server,
        Err(error) => return error,
    };
    let Some(tool) = server.tools.iter().find(|tool| tool.name == name) else {
        return ToolOutput::error(format!(
            "{} has no tool called {name:?}. Call mcp_tools with server {:?} to see its tools.", server.name, server.key()
        ));
    };
    match server.policy(tool) {
        Policy::Off => return ToolOutput::error(format!("The user turned {name} off for {}.", server.name)),
        Policy::Ask => if let Err(refusal) = approved(app, run_id, server, tool, &arguments).await {
            return refusal;
        },
        Policy::Allow => {}
    }
    let state = app.state::<McpState>();
    let before = state.status(&server.id).connection;
    let (after, output) = match invoke(&state, &root, server, name, &arguments).await {
        Ok(result) => (Connection::Connected, render(&result)),
        Err(Failure::NeedsAuth) => (Connection::NeedsAuth, needs_sign_in(server)),
        // One failed call says little about the connection; leave its status.
        Err(Failure::Other(message)) => (before, ToolOutput::error(message)),
    };
    if after != before && before != Connection::Authorizing {
        state.set(&server.id, after, None);
        announce(app).await;
    }
    output
}

#[cfg(test)]
mod unit {
    use super::*;

    fn tool(name: &str, read_only: bool) -> Tool {
        Tool { name: name.into(), title: None, description: format!("Does {name}"), input_schema: json!({"type":"object"}), read_only }
    }

    fn server(name: &str, tools: Vec<Tool>) -> ServerConfig {
        ServerConfig {
            id: format!("id-{name}"), name: name.into(), url: format!("https://{}.example.com/mcp", slug(name)),
            enabled: true, local: false, auto_name: false, client_id: None, launch: None, tools, policies: HashMap::new(), added_at: 0,
        }
    }

    #[test]
    fn tools_that_may_change_things_ask_until_the_user_decides() {
        let mut tracker = server("Tracker", vec![tool("search", true), tool("create", false)]);
        assert_eq!(tracker.policy(&tracker.tools[0]), Policy::Allow);
        assert_eq!(tracker.policy(&tracker.tools[1]), Policy::Ask);
        tracker.policies.insert("create".into(), Policy::Allow);
        tracker.policies.insert("search".into(), Policy::Off);
        assert_eq!(tracker.policy(&tracker.tools[1]), Policy::Allow);
        assert_eq!(tracker.policy(&tracker.tools[0]), Policy::Off);
    }

    #[test]
    fn servers_answer_to_a_unique_plain_name() {
        assert_eq!(slug("Linear (Work)"), "linear-work");
        assert_eq!(slug("  mcp.example.com "), "mcp-example-com");
        assert_eq!(slug("日本"), "server");
        let servers = vec![server("Linear", vec![]), server("linear 2", vec![])];
        assert_eq!(unique_name(&servers, "LINEAR", None), "LINEAR 3");
        assert_eq!(unique_name(&servers, "Linear", Some("id-Linear")), "Linear", "a server keeps its own name");
        assert_eq!(unique_name(&servers, "Notion", None), "Notion");
    }

    #[test]
    fn the_agent_sees_usable_tools_and_who_needs_sign_in() {
        let mut tracker = server("Issue Tracker", vec![tool("search", true), tool("create", false), tool("purge", false)]);
        tracker.policies.insert("purge".into(), Policy::Off);
        assert_eq!(overview_line(&tracker, Connection::Connected), "- issue-tracker (Issue Tracker): search, create");
        assert!(overview_line(&tracker, Connection::NeedsAuth).contains("signs in"));
        assert!(overview_line(&server("wiki", vec![]), Connection::Disconnected).starts_with("- wiki: no tools listed yet"));

        let described = describe_tools(&tracker, None);
        assert!(described.ok);
        assert!(described.text.contains("## create [asks the user first]"));
        assert!(described.text.contains("## search\nDoes search\nInput schema: {\"type\":\"object\"}"));
        assert!(!described.text.contains("purge"), "a tool the user turned off isn't offered");
        assert!(!describe_tools(&tracker, Some("purge")).ok);
        assert!(describe_tools(&tracker, Some("create")).text.contains("Input schema"));
    }

    #[test]
    fn long_catalogs_list_tools_without_schemas() {
        let mut large = tool("search", true);
        large.input_schema = json!({"type":"object","description":"x".repeat(MAX_CATALOG_CHARS)});
        let described = describe_tools(&server("Wiki", vec![large, tool("read", true)]), None);
        assert!(described.text.contains("## read\nDoes read"));
        assert!(!described.text.contains("Input schema:"));
        assert!(described.text.contains("tool set to see one"));
    }

    #[test]
    fn finds_enabled_servers_by_key_or_name() {
        let mut off = server("Wiki", vec![]);
        off.enabled = false;
        let store = store::Store { servers: vec![server("Issue Tracker", vec![]), off], ..Default::default() };
        assert_eq!(find_server(&store, "issue-tracker").map(|server| server.name.clone()).ok().as_deref(), Some("Issue Tracker"));
        assert!(find_server(&store, " Issue Tracker ").is_ok());
        let missing = find_server(&store, "wiki").err().unwrap();
        assert!(missing.text.contains("Available: issue-tracker"), "{}", missing.text);
        let none = find_server(&store::Store::default(), "wiki").err().unwrap();
        assert!(none.text.contains("no services connected"));
    }

    #[test]
    fn results_become_text_with_errors_flagged_and_length_capped() {
        let result = render(&json!({"content":[
            {"type":"text","text":"Found 2 issues"},
            {"type":"image","data":"AAAA","mimeType":"image/png"},
            {"type":"resource","resource":{"uri":"file:///a.md","text":"# A"}},
            {"type":"resource_link","name":"Spec","uri":"https://example.com/spec"},
        ]}));
        assert!(result.ok);
        assert_eq!(result.text, "Found 2 issues\n[image not shown]\n# A\n[Link: Spec https://example.com/spec]");

        let failed = render(&json!({"isError":true,"content":[{"type":"text","text":"No such project"}]}));
        assert!(!failed.ok);
        assert_eq!(render(&json!({"content":[],"structuredContent":{"count":2}})).text, "{\"count\":2}");
        assert_eq!(render(&json!({})).text, "The tool returned nothing.");

        let long = render(&json!({"content":[{"type":"text","text":"é".repeat(MAX_RESULT_CHARS + 5)}]}));
        assert!(long.text.starts_with(&"é".repeat(MAX_RESULT_CHARS)));
        assert!(long.text.ends_with("less at a time.]"));
    }

    #[tokio::test]
    async fn addresses_default_to_https_and_local_ones_may_use_http() {
        let (url, local) = server_address("127.0.0.1:8123/mcp#top").await.unwrap();
        assert_eq!(url.as_str(), "http://127.0.0.1:8123/mcp");
        assert!(local);
        let (url, local) = server_address("https://93.184.216.34/mcp").await.unwrap();
        assert_eq!(url.as_str(), "https://93.184.216.34/mcp");
        assert!(!local);
        assert!(server_address("http://93.184.216.34/mcp").await.is_err(), "plain http stays on this network");
        assert!(server_address("ftp://93.184.216.34/mcp").await.is_err());
        assert!(server_address("   ").await.is_err());
    }
}

//! Signing in to an MCP server with OAuth 2.1, configured from the server
//! itself: its 401 names protected-resource metadata (RFC 9728), which names
//! the authorization server, whose metadata (RFC 8414 or OpenID Connect
//! discovery) gives the endpoints. ChatGSD registers itself there (RFC 7591)
//! as a public client and signs in through the user's browser with PKCE,
//! receiving the code on a loopback port (RFC 8252). Tokens are bound to the
//! server with a resource indicator (RFC 8707).
//!
//! Every address here comes from the server, so each is fetched under the
//! server's own network policy and must be https unless the server is local.
use super::super::web::{self, FetchError, Fetcher};
use base64::Engine;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use url::Url;

const METADATA_BYTES: usize = 200_000;
const TOKEN_BYTES: usize = 100_000;
const TOKEN_TIMEOUT: Duration = Duration::from_secs(20);
const CALLBACK_PATH: &str = "/callback";
/// The loopback port for a client ID the user registered by hand, so its
/// redirect address can be known in advance.
pub const PRESET_PORT: u16 = 47823;
/// Refresh this long before a token runs out.
const EXPIRY_MARGIN_SECS: i64 = 60;

pub fn redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}{CALLBACK_PATH}")
}

/// What a server's `WWW-Authenticate: Bearer …` header asks for.
#[derive(Default)]
pub struct Challenge {
    pub resource_metadata: Option<String>,
    pub scope: Option<String>,
}

static PARAMETER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"([A-Za-z_]+)\s*=\s*"([^"]*)""#).expect("challenge pattern"));

pub fn challenge(header: Option<&str>) -> Challenge {
    let mut challenge = Challenge::default();
    for parameter in PARAMETER.captures_iter(header.unwrap_or_default()) {
        let value = Some(parameter[2].to_owned()).filter(|value| !value.is_empty());
        match parameter[1].to_ascii_lowercase().as_str() {
            "resource_metadata" => challenge.resource_metadata = value,
            "scope" => challenge.scope = value,
            _ => {}
        }
    }
    challenge
}

/// This app's registration with an authorization server.
#[derive(Clone, Serialize, Deserialize)]
pub struct Client {
    pub issuer: String,
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    pub redirect_port: u16,
    /// Registered by ChatGSD itself, not an ID the user entered.
    pub registered: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Unix seconds; `None` when the server didn't say.
    #[serde(default)]
    pub expires_at: Option<i64>,
    pub token_endpoint: String,
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    pub resource: String,
    #[serde(default)]
    pub scope: Option<String>,
}

impl Tokens {
    pub fn expired(&self) -> bool {
        self.expires_at.is_some_and(|at| at <= chrono::Utc::now().timestamp() + EXPIRY_MARGIN_SECS)
    }
}

pub enum TokenError {
    /// The authorization server refused the grant: the user must sign in again.
    Rejected(String),
    Other(String),
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected(message) | Self::Other(message) => f.write_str(message),
        }
    }
}

struct AuthorizationServer {
    issuer: String,
    authorization_endpoint: Url,
    token_endpoint: Url,
    registration_endpoint: Option<Url>,
}

struct Discovery {
    server: AuthorizationServer,
    resource: String,
    scope: Option<String>,
}

/// An endpoint named by the server's metadata: https, or http for a local server.
fn endpoint(address: &str, local: bool) -> Result<Url, String> {
    let url = web::http_url(address)?;
    if url.scheme() == "http" && !local {
        return Err(format!("{} must use https for sign-in", url.host_str().unwrap_or("The service")));
    }
    Ok(url)
}

/// `/.well-known/<name>` addresses for `base`: with its path, then at its root.
fn well_known(base: &Url, name: &str) -> Vec<String> {
    let origin = base.origin().ascii_serialization();
    let path = base.path().trim_end_matches('/');
    let mut addresses = Vec::new();
    if !path.is_empty() {
        addresses.push(format!("{origin}/.well-known/{name}{path}"));
    }
    addresses.push(format!("{origin}/.well-known/{name}"));
    addresses
}

/// The JSON object at `address`, or `None` when the site has nothing there.
async fn metadata(fetcher: Fetcher, address: &str) -> Result<Option<Value>, String> {
    match fetcher.get(address, "application/json", METADATA_BYTES).await {
        Ok(fetched) => Ok(serde_json::from_slice::<Value>(&fetched.bytes).ok().filter(Value::is_object)),
        Err(FetchError::Status(..)) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

async fn first_metadata(fetcher: Fetcher, addresses: Vec<String>, usable: impl Fn(&Value) -> bool) -> Result<Option<Value>, String> {
    let mut tried: Vec<String> = Vec::new();
    for address in addresses {
        if tried.contains(&address) {
            continue;
        }
        if let Some(found) = metadata(fetcher, &address).await?.filter(&usable) {
            return Ok(Some(found));
        }
        tried.push(address);
    }
    Ok(None)
}

async fn discover(fetcher: Fetcher, local: bool, server: &Url, challenge: &Challenge) -> Result<Discovery, String> {
    let mut addresses: Vec<String> = challenge.resource_metadata.iter()
        .filter(|address| endpoint(address, local).is_ok()).cloned().collect();
    addresses.extend(well_known(server, "oauth-protected-resource"));
    let resource_metadata = first_metadata(fetcher, addresses, |_| true).await?.unwrap_or_default();
    // Servers older than protected-resource metadata are their own authorization server.
    let issuer = match resource_metadata["authorization_servers"][0].as_str() {
        Some(issuer) => endpoint(issuer, local)?,
        None => Url::parse(&server.origin().ascii_serialization()).map_err(|error| error.to_string())?,
    };
    let resource = resource_metadata["resource"].as_str()
        .filter(|resource| Url::parse(resource).is_ok_and(|resource| resource.origin() == server.origin()))
        .map_or_else(|| server.to_string(), str::to_owned);
    let scope = challenge.scope.clone().or_else(|| {
        let scopes: Vec<&str> = resource_metadata["scopes_supported"].as_array()?.iter().filter_map(Value::as_str).collect();
        (!scopes.is_empty()).then(|| scopes.join(" "))
    });

    let mut addresses = well_known(&issuer, "oauth-authorization-server");
    addresses.extend(well_known(&issuer, "openid-configuration"));
    addresses.push(format!("{}/.well-known/openid-configuration", issuer.as_str().trim_end_matches('/')));
    let found = first_metadata(fetcher, addresses, |metadata| {
        metadata["authorization_endpoint"].is_string() && metadata["token_endpoint"].is_string()
    }).await?;
    let origin = issuer.origin().ascii_serialization();
    let field = |name: &str, fallback: &str| -> Result<Url, String> {
        match &found {
            Some(metadata) => endpoint(metadata[name].as_str().unwrap_or_default(), local),
            None => endpoint(&format!("{origin}{fallback}"), local),
        }
    };
    if let Some(methods) = found.as_ref().and_then(|metadata| metadata["code_challenge_methods_supported"].as_array()) {
        if !methods.iter().any(|method| method == "S256") {
            return Err("This service's sign-in doesn't support PKCE, which ChatGSD requires".into());
        }
    }
    let registration_endpoint = match &found {
        Some(metadata) => metadata["registration_endpoint"].as_str().map(|address| endpoint(address, local)).transpose()?,
        None => Some(field("registration_endpoint", "/register")?),
    };
    Ok(Discovery {
        server: AuthorizationServer {
            issuer: issuer.to_string(),
            authorization_endpoint: field("authorization_endpoint", "/authorize")?,
            token_endpoint: field("token_endpoint", "/token")?,
            registration_endpoint,
        },
        resource,
        scope,
    })
}

/// Where a server sends its users to sign in, without registering or signing in.
#[cfg(test)]
pub async fn sign_in_page(fetcher: Fetcher, local: bool, server: &Url, challenge: &Challenge) -> Result<String, String> {
    discover(fetcher, local, server, challenge).await.map(|found| found.server.authorization_endpoint.to_string())
}

async fn read_capped(mut response: reqwest::Response, limit: usize) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > limit {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    Some(bytes)
}

async fn register(fetcher: Fetcher, endpoint: &Url, redirect: &str) -> Result<(String, Option<String>), String> {
    let host = endpoint.host_str().unwrap_or("the service").to_owned();
    let failed = || format!("{host} didn't register ChatGSD. If it gave you a client ID, add it to this server.");
    let client = fetcher.client(endpoint, TOKEN_TIMEOUT).await.map_err(|error| error.to_string())?;
    let response = client.post(endpoint.clone())
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&json!({
            "client_name": "ChatGSD",
            "client_uri": "https://github.com/mickr/chatgsd",
            "redirect_uris": [redirect],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "application_type": "native",
        }))
        .send().await.map_err(|_| format!("Couldn't reach {host}"))?;
    if !response.status().is_success() {
        return Err(failed());
    }
    let registration: Value = read_capped(response, TOKEN_BYTES).await
        .and_then(|bytes| serde_json::from_slice(&bytes).ok()).ok_or_else(failed)?;
    let id = registration["client_id"].as_str().filter(|id| !id.is_empty()).ok_or_else(failed)?;
    Ok((id.to_owned(), registration["client_secret"].as_str().filter(|secret| !secret.is_empty()).map(str::to_owned)))
}

async fn bind(port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await
}

/// The registration to sign in with, and the loopback listener its redirect
/// address points at.
async fn client_for(fetcher: Fetcher, discovery: &Discovery, preset: Option<&str>, saved: Option<Client>) -> Result<(TcpListener, Client), String> {
    let issuer = discovery.server.issuer.clone();
    if let Some(client_id) = preset {
        let listener = bind(PRESET_PORT).await
            .map_err(|_| format!("Port {PRESET_PORT} is in use, so sign-in can't finish. Close what's using it and try again."))?;
        return Ok((listener, Client { issuer, client_id: client_id.to_owned(), client_secret: None, redirect_port: PRESET_PORT, registered: false }));
    }
    // A redirect address is registered with its port, so reuse it while the port is free.
    if let Some(saved) = saved.filter(|saved| saved.registered && saved.issuer == issuer) {
        if let Ok(listener) = bind(saved.redirect_port).await {
            return Ok((listener, saved));
        }
    }
    let Some(registration) = &discovery.server.registration_endpoint else {
        return Err("This service doesn't register apps on its own. Create an OAuth client for ChatGSD there and add its client ID to this server.".into());
    };
    let listener = bind(0).await.map_err(|error| format!("Couldn't listen for the sign-in: {error}"))?;
    let redirect_port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let (client_id, client_secret) = register(fetcher, registration, &redirect_uri(redirect_port)).await?;
    Ok((listener, Client { issuer, client_id, client_secret, redirect_port, registered: true }))
}

/// The request target of an HTTP request, read from its first line.
async fn request_target(stream: &mut TcpStream) -> Option<String> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 1024];
    while !bytes.contains(&b'\n') && bytes.len() < 8192 {
        let count = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk)).await.ok()?.ok()?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut parts = text.lines().next()?.split(' ');
    (parts.next()? == "GET").then(|| parts.next().map(str::to_owned))?
}

async fn respond(stream: &mut TcpStream, status: &str, heading: &str, detail: &str) {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>ChatGSD</title>\
<body style=\"font:16px -apple-system,system-ui,sans-serif;max-width:32em;margin:18vh auto;padding:0 1.5em;color:#222\">\
<h1 style=\"font-size:1.25em\">{heading}</h1><p style=\"color:#666\">{detail}</p></body>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Waits for the browser to come back with this sign-in's code. Requests
/// without its `state` are someone else's and are turned away.
async fn wait_for_code(listener: &TcpListener, state: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|error| format!("Couldn't listen for the sign-in: {error}"))?;
        let Some(target) = request_target(&mut stream).await else { continue };
        let (path, query) = target.split_once('?').unwrap_or((&target, ""));
        let parameters: HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();
        if path != CALLBACK_PATH || parameters.get("state").map(String::as_str) != Some(state) {
            respond(&mut stream, "400 Bad Request", "This isn't the sign-in ChatGSD is waiting for", "Start again from ChatGSD's settings.").await;
            continue;
        }
        if let Some(error) = parameters.get("error") {
            respond(&mut stream, "200 OK", "Sign-in didn't finish", "You can close this tab and try again from ChatGSD.").await;
            let detail = parameters.get("error_description").unwrap_or(error);
            return Err(format!("The service didn't grant access: {}", detail.chars().take(300).collect::<String>()));
        }
        match parameters.get("code").filter(|code| !code.is_empty()) {
            Some(code) => {
                respond(&mut stream, "200 OK", "You're signed in", "You can close this tab and return to ChatGSD.").await;
                return Ok(code.clone());
            }
            None => respond(&mut stream, "400 Bad Request", "Sign-in didn't finish", "The service sent no authorization code.").await,
        }
    }
}

async fn token_request(fetcher: Fetcher, endpoint: &Url, form: &[(&str, &str)]) -> Result<Value, TokenError> {
    let host = endpoint.host_str().unwrap_or("the service").to_owned();
    let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(form).finish();
    let client = fetcher.client(endpoint, TOKEN_TIMEOUT).await.map_err(|error| TokenError::Other(error.to_string()))?;
    let response = client.post(endpoint.clone())
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(body)
        .send().await.map_err(|_| TokenError::Other(format!("Couldn't reach {host}")))?;
    let status = response.status();
    let reply: Value = read_capped(response, TOKEN_BYTES).await
        .and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
    if status.is_success() && reply["access_token"].as_str().is_some_and(|token| !token.is_empty()) {
        return Ok(reply);
    }
    let detail = reply["error_description"].as_str().or(reply["error"].as_str())
        .map(|detail| detail.chars().take(300).collect::<String>())
        .unwrap_or_else(|| format!("{host} answered {}", status.as_u16()));
    // 4xx is the server's verdict on the grant; anything else may pass.
    Err(if status.is_client_error() { TokenError::Rejected(detail) } else { TokenError::Other(detail) })
}

fn tokens(reply: &Value, endpoint: &Url, client_id: &str, client_secret: Option<&str>, resource: &str, previous: Option<&Tokens>) -> Tokens {
    let text = |name: &str| reply[name].as_str().filter(|value| !value.is_empty()).map(str::to_owned);
    Tokens {
        access_token: text("access_token").unwrap_or_default(),
        // A server that doesn't rotate refresh tokens leaves the old one in force.
        refresh_token: text("refresh_token").or_else(|| previous.and_then(|previous| previous.refresh_token.clone())),
        expires_at: reply["expires_in"].as_i64().filter(|seconds| *seconds > 0)
            .map(|seconds| chrono::Utc::now().timestamp() + seconds),
        token_endpoint: endpoint.to_string(),
        client_id: client_id.to_owned(),
        client_secret: client_secret.map(str::to_owned),
        resource: resource.to_owned(),
        scope: text("scope").or_else(|| previous.and_then(|previous| previous.scope.clone())),
    }
}

pub async fn refresh(fetcher: Fetcher, local: bool, current: &Tokens) -> Result<Tokens, TokenError> {
    let Some(refresh_token) = current.refresh_token.as_deref() else {
        return Err(TokenError::Rejected("The sign-in can't be renewed".into()));
    };
    let endpoint = endpoint(&current.token_endpoint, local).map_err(TokenError::Other)?;
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", current.client_id.as_str()),
        ("resource", current.resource.as_str()),
    ];
    if let Some(secret) = current.client_secret.as_deref() {
        form.push(("client_secret", secret));
    }
    let reply = token_request(fetcher, &endpoint, &form).await?;
    Ok(tokens(&reply, &endpoint, &current.client_id, current.client_secret.as_deref(), &current.resource, Some(current)))
}

pub struct Request<'a> {
    pub fetcher: Fetcher,
    pub local: bool,
    pub server: &'a Url,
    pub challenge: Challenge,
    /// A client ID the user registered by hand, for services without
    /// dynamic registration.
    pub client_id: Option<&'a str>,
    pub saved: Option<Client>,
}

pub struct Grant {
    pub client: Client,
    pub tokens: Tokens,
}

/// Runs the whole sign-in. `open` shows the authorization page to the user;
/// this returns once their browser comes back with a code and it is exchanged.
pub async fn authorize(request: Request<'_>, open: impl FnOnce(&str) -> Result<(), String>) -> Result<Grant, String> {
    let Request { fetcher, local, server, challenge, client_id, saved } = request;
    let discovery = discover(fetcher, local, server, &challenge).await?;
    let (listener, client) = client_for(fetcher, &discovery, client_id, saved).await?;
    let redirect = redirect_uri(client.redirect_port);
    let random = || uuid::Uuid::new_v4().simple().to_string();
    let verifier = format!("{}{}", random(), random());
    let code_challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random();
    let mut page = discovery.server.authorization_endpoint.clone();
    {
        let mut query = page.query_pairs_mut();
        query.append_pair("response_type", "code")
            .append_pair("client_id", &client.client_id)
            .append_pair("redirect_uri", &redirect)
            .append_pair("state", &state)
            .append_pair("code_challenge", &code_challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("resource", &discovery.resource);
        if let Some(scope) = &discovery.scope {
            query.append_pair("scope", scope);
        }
    }
    open(page.as_str())?;
    let code = wait_for_code(&listener, &state).await?;
    drop(listener);
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("client_id", client.client_id.as_str()),
        ("code_verifier", verifier.as_str()),
        ("resource", discovery.resource.as_str()),
    ];
    if let Some(secret) = client.client_secret.as_deref() {
        form.push(("client_secret", secret));
    }
    let endpoint = &discovery.server.token_endpoint;
    let reply = token_request(fetcher, endpoint, &form).await.map_err(|error| format!("Sign-in didn't finish: {error}"))?;
    let tokens = tokens(&reply, endpoint, &client.client_id, client.client_secret.as_deref(), &discovery.resource, None);
    Ok(Grant { client, tokens })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_reads_quoted_parameters_in_any_case() {
        let parsed = challenge(Some(r#"Bearer realm="mcp", Resource_Metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="read write", error="""#));
        assert_eq!(parsed.resource_metadata.as_deref(), Some("https://mcp.example.com/.well-known/oauth-protected-resource"));
        assert_eq!(parsed.scope.as_deref(), Some("read write"));
        let bare = challenge(Some("Bearer"));
        assert!(bare.resource_metadata.is_none() && bare.scope.is_none());
        assert!(challenge(None).resource_metadata.is_none());
    }

    #[test]
    fn well_known_addresses_try_the_path_before_the_root() {
        let with_path = Url::parse("https://mcp.example.com/team/mcp/").unwrap();
        assert_eq!(well_known(&with_path, "oauth-protected-resource"), [
            "https://mcp.example.com/.well-known/oauth-protected-resource/team/mcp",
            "https://mcp.example.com/.well-known/oauth-protected-resource",
        ]);
        let root = Url::parse("https://auth.example.com").unwrap();
        assert_eq!(well_known(&root, "oauth-authorization-server"), ["https://auth.example.com/.well-known/oauth-authorization-server"]);
    }

    #[test]
    fn sign_in_endpoints_need_https_unless_the_server_is_local() {
        assert!(endpoint("https://auth.example.com/token", false).is_ok());
        assert!(endpoint("http://auth.example.com/token", false).is_err());
        assert!(endpoint("http://127.0.0.1:9000/token", true).is_ok());
        assert!(endpoint("javascript:alert(1)", true).is_err());
        assert!(endpoint("https://user:secret@auth.example.com/token", false).is_err());
    }

    #[test]
    fn refreshed_tokens_keep_what_the_server_left_out() {
        let endpoint = Url::parse("https://auth.example.com/token").unwrap();
        let first = tokens(&json!({"access_token":"a1","refresh_token":"r1","expires_in":3600,"scope":"read"}), &endpoint, "client", None, "https://mcp.example.com/mcp", None);
        assert!(!first.expired());
        let second = tokens(&json!({"access_token":"a2","expires_in":1}), &endpoint, "client", None, "https://mcp.example.com/mcp", Some(&first));
        assert_eq!(second.access_token, "a2");
        assert_eq!(second.refresh_token.as_deref(), Some("r1"));
        assert_eq!(second.scope.as_deref(), Some("read"));
        assert!(second.expired(), "a token about to run out is renewed before use");
        let unknown = tokens(&json!({"access_token":"a3"}), &endpoint, "client", None, "https://mcp.example.com/mcp", None);
        assert!(!unknown.expired(), "without an expiry the server decides");
    }
}

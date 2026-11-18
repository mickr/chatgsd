//! The MCP client: the handshake, the tool catalog and tool calls, and the
//! Streamable HTTP transport that carries them to a remote server (one POST
//! per JSON-RPC message, answered with JSON or a short event stream). A
//! program on this Mac is reached through `stdio` instead.
//!
//! Requests go through `web::Fetcher`, so a server on the internet is held to
//! public addresses with the connection pinned to the address that was
//! checked. Redirects are never followed: a bearer token must not travel to an
//! address the user didn't add.
use super::super::web::Fetcher;
use super::Tool;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use url::Url;

/// The newest protocol revision this client speaks, offered on initialize.
const PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_VERSIONS: [&str; 3] = [PROTOCOL_VERSION, "2025-03-26", "2024-11-05"];
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_RESPONSE_BYTES: usize = 8_000_000;
const MAX_TOOLS: usize = 200;
const MAX_TOOL_PAGES: usize = 20;
const MAX_NAME_CHARS: usize = 128;
const MAX_DESCRIPTION_CHARS: usize = 2_000;
const MAX_SCHEMA_BYTES: usize = 20_000;

static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

pub fn next_id() -> u64 {
    REQUEST_ID.fetch_add(1, Ordering::Relaxed)
}

#[derive(Debug)]
pub enum Error {
    /// The server wants authorization; carries its `WWW-Authenticate` header.
    Unauthorized(Option<String>),
    /// The server no longer knows this session. Nothing was executed.
    SessionExpired,
    Other(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unauthorized(_) => f.write_str("The server asked for sign-in"),
            Self::SessionExpired => f.write_str("The server ended this session"),
            Self::Other(message) => f.write_str(message),
        }
    }
}

/// What a server returned from `initialize`, kept for later requests.
#[derive(Clone, Debug)]
pub struct Session {
    pub id: Option<String>,
    pub version: String,
}

pub struct Hello {
    pub session: Session,
    /// The server's own display name, when it gave one.
    pub name: Option<String>,
}

/// A connection that answers JSON-RPC requests, whatever carries them.
pub(super) trait Rpc {
    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, Error>;
}

pub struct Endpoint {
    pub url: Url,
    pub fetcher: Fetcher,
    pub bearer: Option<String>,
}

struct Reply {
    session: Option<String>,
    message: Option<Value>,
}

/// Splits a `text/event-stream` body into the data of each event.
#[derive(Default)]
struct EventStream {
    line: Vec<u8>,
    data: Vec<String>,
}

impl EventStream {
    fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut events = Vec::new();
        for &byte in chunk {
            if byte != b'\n' {
                self.line.push(byte);
                continue;
            }
            let bytes = std::mem::take(&mut self.line);
            let line = String::from_utf8_lossy(&bytes);
            let line = line.strip_suffix('\r').unwrap_or(&line);
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(self.data.join("\n"));
                    self.data.clear();
                }
            } else if let Some(value) = line.strip_prefix("data:") {
                self.data.push(value.strip_prefix(' ').unwrap_or(value).to_owned());
            }
        }
        events
    }
}

/// The response to request `id` in a JSON-RPC message or batch.
fn response_for(message: Value, id: u64) -> Option<Value> {
    let is_ours = |value: &Value| value.get("method").is_none() && value.get("id").and_then(Value::as_u64) == Some(id);
    match message {
        Value::Array(batch) => batch.into_iter().find(is_ours),
        single if is_ours(&single) => Some(single),
        _ => None,
    }
}

fn clip(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

fn parse_tool(tool: &Value) -> Option<Tool> {
    let name = tool.get("name")?.as_str()?.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return None;
    }
    let annotations = &tool["annotations"];
    let title = tool["title"].as_str().or(annotations["title"].as_str());
    let schema = tool.get("inputSchema").filter(|schema| schema.is_object()).cloned();
    Some(Tool {
        name: name.to_owned(),
        title: title.map(|title| clip(title.trim(), MAX_NAME_CHARS)).filter(|title| !title.is_empty()),
        description: clip(tool["description"].as_str().unwrap_or_default().trim(), MAX_DESCRIPTION_CHARS),
        // A schema too large to show the model is replaced; the server still validates.
        input_schema: schema
            .filter(|schema| schema.to_string().len() <= MAX_SCHEMA_BYTES)
            .unwrap_or_else(|| json!({"type":"object"})),
        read_only: annotations["readOnlyHint"] == true,
    })
}

pub fn initialize_params() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": {"name":"chatgsd","title":"ChatGSD","version":env!("CARGO_PKG_VERSION")},
    })
}

/// The protocol version a server chose on `initialize`, and its display name
/// when it gave one.
pub fn welcome(result: &Value, who: &str) -> Result<(String, Option<String>), Error> {
    let version = result["protocolVersion"].as_str().unwrap_or_default();
    if !SUPPORTED_VERSIONS.contains(&version) {
        return Err(Error::Other(format!("{who} speaks a version of MCP that ChatGSD doesn't")));
    }
    let info = &result["serverInfo"];
    let name = info["title"].as_str().or(info["name"].as_str())
        .map(|name| clip(name.trim(), 60)).filter(|name| !name.is_empty());
    Ok((version.to_owned(), name))
}

/// The result in a JSON-RPC response, or the error it carries instead.
pub fn result_of(mut message: Value, who: &str) -> Result<Value, Error> {
    if let Some(error) = message.get("error").filter(|error| !error.is_null()) {
        let detail = error["message"].as_str().unwrap_or("the request failed");
        return Err(Error::Other(format!("{who} answered: {}", clip(detail, 500))));
    }
    match message.get_mut("result") {
        Some(result) => Ok(result.take()),
        None => Err(Error::Other(format!("{who} didn't answer as an MCP server"))),
    }
}

pub(super) async fn list_tools(server: &impl Rpc) -> Result<Vec<Tool>, Error> {
    let mut tools: Vec<Tool> = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_TOOL_PAGES {
        let params = cursor.as_ref().map_or_else(|| json!({}), |cursor| json!({"cursor":cursor}));
        let page = server.request("tools/list", params, CONNECT_TIMEOUT).await?;
        for tool in page["tools"].as_array().into_iter().flatten().filter_map(parse_tool) {
            if tools.len() < MAX_TOOLS && !tools.iter().any(|known| known.name == tool.name) {
                tools.push(tool);
            }
        }
        let next = page["nextCursor"].as_str().map(str::to_owned);
        if next.is_none() || next == cursor || tools.len() >= MAX_TOOLS {
            break;
        }
        cursor = next;
    }
    Ok(tools)
}

pub(super) async fn call_tool(server: &impl Rpc, name: &str, arguments: &Value) -> Result<Value, Error> {
    server.request("tools/call", json!({"name":name,"arguments":arguments}), CALL_TIMEOUT).await
}

/// An endpoint with the session its requests belong to.
struct Open<'a> {
    endpoint: &'a Endpoint,
    session: &'a Session,
}

impl Rpc for Open<'_> {
    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, Error> {
        self.endpoint.request(Some(self.session), method, params, timeout).await.map(|(result, _)| result)
    }
}

impl Endpoint {
    fn host(&self) -> &str {
        self.url.host_str().unwrap_or("the server")
    }

    async fn post(&self, session: Option<&Session>, message: &Value, timeout: Duration) -> Result<Reply, Error> {
        let host = self.host();
        let client = self.fetcher.client(&self.url, timeout).await.map_err(|error| Error::Other(error.to_string()))?;
        let mut request = client
            .post(self.url.clone())
            .header(reqwest::header::ACCEPT, "application/json, text/event-stream")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(message.to_string());
        if let Some(session) = session {
            request = request.header("MCP-Protocol-Version", &session.version);
            if let Some(id) = &session.id {
                request = request.header("Mcp-Session-Id", id);
            }
        }
        if let Some(bearer) = &self.bearer {
            request = request.bearer_auth(bearer);
        }
        let failed = |error: reqwest::Error| {
            Error::Other(if error.is_timeout() {
                format!("{host} took too long to answer")
            } else {
                format!("Couldn't reach {host}")
            })
        };
        let mut response = request.send().await.map_err(failed)?;
        let status = response.status();
        let header = |name: &str| response.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_owned);
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(Error::Unauthorized(header("www-authenticate")));
        }
        if status == reqwest::StatusCode::NOT_FOUND && session.is_some_and(|session| session.id.is_some()) {
            return Err(Error::SessionExpired);
        }
        if status.is_redirection() {
            return Err(Error::Other(format!("{host} redirects elsewhere. Add the address it redirects to instead.")));
        }
        if !status.is_success() {
            return Err(Error::Other(match status.as_u16() {
                403 => format!("{host} refused this request"),
                404 | 405 => format!("{host} has no MCP server at this address"),
                code => format!("{host} answered {code}"),
            }));
        }
        let session_id = header("mcp-session-id");
        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            return Ok(Reply { session: session_id, message: None });
        };
        let event_stream = header("content-type").is_some_and(|kind| kind.to_ascii_lowercase().starts_with("text/event-stream"));
        let too_large = || Error::Other(format!("{host} sent more than ChatGSD reads in one response"));
        let invalid = || Error::Other(format!("{host} didn't answer as an MCP server"));
        let mut events = EventStream::default();
        let mut body = Vec::new();
        let mut read = 0;
        while let Some(chunk) = response.chunk().await.map_err(failed)? {
            read += chunk.len();
            if read > MAX_RESPONSE_BYTES {
                return Err(too_large());
            }
            if !event_stream {
                body.extend_from_slice(&chunk);
                continue;
            }
            // Requests and notifications from the server share the stream; this
            // client declares no capabilities for them and reads past.
            for data in events.push(&chunk) {
                let found = serde_json::from_str(&data).ok().and_then(|message| response_for(message, id));
                if found.is_some() {
                    return Ok(Reply { session: session_id, message: found });
                }
            }
        }
        if event_stream {
            return Err(Error::Other(format!("{host} closed the connection before answering")));
        }
        let message = serde_json::from_slice(&body).ok().and_then(|message| response_for(message, id)).ok_or_else(invalid)?;
        Ok(Reply { session: session_id, message: Some(message) })
    }

    async fn request(&self, session: Option<&Session>, method: &str, params: Value, timeout: Duration) -> Result<(Value, Option<String>), Error> {
        let id = next_id();
        let reply = self.post(session, &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}), timeout).await?;
        Ok((result_of(reply.message.unwrap_or_default(), self.host())?, reply.session))
    }

    /// Opens a session and tells the server this client is ready.
    pub async fn initialize(&self) -> Result<Hello, Error> {
        let (result, id) = self.request(None, "initialize", initialize_params(), CONNECT_TIMEOUT).await?;
        let (version, name) = welcome(&result, self.host())?;
        let session = Session { id, version };
        self.post(Some(&session), &json!({"jsonrpc":"2.0","method":"notifications/initialized"}), CONNECT_TIMEOUT).await?;
        Ok(Hello { session, name })
    }

    pub async fn list_tools(&self, session: &Session) -> Result<Vec<Tool>, Error> {
        list_tools(&Open { endpoint: self, session }).await
    }

    pub async fn call_tool(&self, session: &Session, name: &str, arguments: &Value) -> Result<Value, Error> {
        call_tool(&Open { endpoint: self, session }, name, arguments).await
    }

    /// Tells the server the session is over. Servers may refuse; that's fine.
    pub async fn close(&self, session: &Session) {
        let Some(id) = &session.id else { return };
        let Ok(client) = self.fetcher.client(&self.url, Duration::from_secs(5)).await else { return };
        let mut request = client.delete(self.url.clone())
            .header("Mcp-Session-Id", id)
            .header("MCP-Protocol-Version", &session.version);
        if let Some(bearer) = &self.bearer {
            request = request.bearer_auth(bearer);
        }
        let _ = request.send().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_stream_joins_data_lines_across_chunks_and_skips_other_fields() {
        let mut stream = EventStream::default();
        assert!(stream.push(b": keep-alive\n\nevent: message\r\ndata: {\"a\":").is_empty());
        assert_eq!(stream.push(b"1}\r\n\r\ndata:first\ndata: second\n\n"), ["{\"a\":1}", "first\nsecond"]);
        assert!(stream.push(b"id: 7\n\n").is_empty(), "an event without data carries no message");
    }

    #[test]
    fn only_the_response_to_this_request_is_taken() {
        let ours = json!({"jsonrpc":"2.0","id":4,"result":{"ok":true}});
        assert_eq!(response_for(ours.clone(), 4), Some(ours.clone()));
        assert_eq!(response_for(ours.clone(), 5), None);
        assert_eq!(response_for(json!({"jsonrpc":"2.0","id":4,"method":"ping"}), 4), None, "a server request is not a response");
        assert_eq!(response_for(json!([{"jsonrpc":"2.0","method":"notifications/progress"}, ours.clone()]), 4), Some(ours));
    }

    #[test]
    fn tools_keep_their_read_only_hint_and_lose_oversized_schemas() {
        let tool = parse_tool(&json!({
            "name":"search_issues", "description":"  Find issues  ",
            "inputSchema":{"type":"object","properties":{"query":{"type":"string"}}},
            "annotations":{"readOnlyHint":true,"title":"Search issues"},
        })).unwrap();
        assert!(tool.read_only);
        assert_eq!(tool.title.as_deref(), Some("Search issues"));
        assert_eq!(tool.description, "Find issues");
        assert_eq!(tool.input_schema["properties"]["query"]["type"], "string");

        let writes = parse_tool(&json!({"name":"create_issue","inputSchema":{"type":"object","description":"x".repeat(MAX_SCHEMA_BYTES)}})).unwrap();
        assert!(!writes.read_only, "a tool without the hint may change things");
        assert_eq!(writes.input_schema, json!({"type":"object"}));
        assert!(parse_tool(&json!({"name":"  "})).is_none());
        assert!(parse_tool(&json!({"description":"nameless"})).is_none());
    }
}

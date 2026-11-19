//! Localhost HTTP MCP server bridging Antigravity ACP tool calls to ChatGSD's
//! tracked TipTap editor and workspace tools.

use crate::agent::{
    events::{self, AgentEvent},
    tools, RunContext,
};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::RwLock;

const MAX_HTTP_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_HEADER_LINES: usize = 64;

#[derive(Clone)]
pub(super) struct ActiveMcpRun {
    pub app: tauri::AppHandle,
    pub ctx: RunContext,
    pub session_id: String,
    pub account: String,
    pub permitted: HashSet<String>,
    pub tools: Vec<Value>,
}

pub(super) struct McpServer {
    pub url: String,
    pub token: String,
    active: Arc<RwLock<Option<ActiveMcpRun>>>,
    task: tokio::task::JoinHandle<()>,
}

impl McpServer {
    pub async fn start() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| format!("Cannot start Antigravity MCP bridge: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("Cannot read Antigravity MCP port: {error}"))?
            .port();
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let active = Arc::new(RwLock::new(None));
        let task_active = Arc::clone(&active);
        let expected_auth = format!("Bearer {token}");
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let state = Arc::clone(&task_active);
                let auth = expected_auth.clone();
                tokio::spawn(async move {
                    let _ = handle_connection(stream, state, &auth).await;
                });
            }
        });
        Ok(Self {
            url: format!("http://127.0.0.1:{port}/mcp"),
            token,
            active,
            task,
        })
    }

    pub async fn set_active(&self, run: Option<ActiveMcpRun>) {
        *self.active.write().await = run;
    }

    pub fn mcp_server_config(&self) -> Value {
        json!({
            "type": "http",
            "name": "scratch",
            "url": self.url,
            "headers": [{
                "name": "Authorization",
                "value": format!("Bearer {}", self.token),
            }],
        })
    }
}

impl Drop for McpServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub(super) fn mcp_tool_list(read_only: bool) -> (Vec<Value>, HashSet<String>) {
    let specs = tools::catalog(false, read_only);
    let mut permitted = HashSet::with_capacity(specs.len());
    let mut list = Vec::with_capacity(specs.len());
    for spec in specs {
        permitted.insert(spec.name.to_owned());
        list.push(json!({
            "name": spec.name,
            "description": spec.description,
            "inputSchema": spec.parameters,
        }));
    }
    (list, permitted)
}

/// Antigravity injects `toolSummary` into MCP call arguments; strip it before
/// handing arguments to ChatGSD's strict tool deserializers.
fn clean_tool_args(mut args: Value) -> Value {
    if let Some(map) = args.as_object_mut() {
        map.remove("toolSummary");
    }
    args
}

async fn handle_connection<S>(
    stream: S,
    active: Arc<RwLock<Option<ActiveMcpRun>>>,
    expected_auth: &str,
) -> std::io::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).await? == 0 {
        return Ok(());
    }
    let method = request_line.split_whitespace().next().unwrap_or_default();
    let mut content_length = 0usize;
    let mut authorized = false;
    for _ in 0..MAX_HEADER_LINES {
        let mut line = String::new();
        if reader.read_line(&mut line).await? == 0 {
            return Ok(());
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            let value = value.trim();
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.parse().unwrap_or(0);
            } else if name.eq_ignore_ascii_case("authorization") {
                authorized = value == expected_auth;
            }
        }
    }
    if !authorized {
        return write_http(reader.get_mut(), 401, "Unauthorized", None).await;
    }
    if method != "POST" {
        return write_http(reader.get_mut(), 405, "Method Not Allowed", None).await;
    }
    if content_length > MAX_HTTP_BODY_BYTES {
        return write_http(reader.get_mut(), 413, "Payload Too Large", None).await;
    }
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body).await?;
    let Ok(request) = serde_json::from_slice::<Value>(&body) else {
        return write_http(reader.get_mut(), 400, "Bad Request", None).await;
    };
    let Some(response) = dispatch_rpc(request, &active).await else {
        return write_http(reader.get_mut(), 202, "Accepted", None).await;
    };
    let bytes = serde_json::to_vec(&response).unwrap_or_else(|_| b"{}".to_vec());
    write_http(reader.get_mut(), 200, "OK", Some(&bytes)).await
}

async fn write_http<S>(
    stream: &mut S,
    status: u16,
    reason: &str,
    body: Option<&[u8]>,
) -> std::io::Result<()>
where
    S: tokio::io::AsyncWrite + Unpin,
{
    let payload = body.unwrap_or(&[]);
    let content_type = if body.is_some() {
        "Content-Type: application/json\r\n"
    } else {
        ""
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\n{content_type}Content-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    stream.write_all(header.as_bytes()).await?;
    if !payload.is_empty() {
        stream.write_all(payload).await?;
    }
    stream.flush().await
}

async fn dispatch_rpc(
    request: Value,
    active: &Arc<RwLock<Option<ActiveMcpRun>>>,
) -> Option<Value> {
    let method = request["method"].as_str().unwrap_or_default();
    let id = request.get("id").cloned();
    if method.starts_with("notifications/") || id.is_none() {
        return None;
    }
    let id = id.unwrap();
    let result = match method {
        "initialize" => {
            let version = request["params"]["protocolVersion"]
                .as_str()
                .unwrap_or("2025-03-26");
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "scratch", "version": "1.0.0" },
            })
        }
        "ping" | "server/discover" => json!({}),
        "tools/list" => {
            let tools = {
                let guard = active.read().await;
                match guard.as_ref() {
                    Some(run) => run.tools.clone(),
                    None => mcp_tool_list(false).0,
                }
            };
            json!({ "tools": tools })
        }
        "tools/call" => {
            let raw_name = request["params"]["name"].as_str().unwrap_or_default();
            let name = events::canonical_tool_name(raw_name);
            let args = clean_tool_args(
                request["params"]
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            );
            let run = active.read().await.clone();
            let Some(run) = run else {
                return Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": "No active ChatGSD note run." }],
                        "isError": true,
                    },
                }));
            };
            let call_id = format!("agy-{}", uuid::Uuid::new_v4().simple());
            events::emit(
                &run.app,
                &run.ctx.run_id,
                AgentEvent::ToolCall {
                    call_id: call_id.clone(),
                    name: name.to_owned(),
                    input: args.clone(),
                },
            );
            let (ok, text) = if !run.permitted.contains(name) {
                (false, "This tool is not available in ChatGSD.".to_owned())
            } else if name == "remember_work" {
                match tools::remember_work(&run.app, &run.ctx, &run.session_id, &run.account, args)
                    .await
                {
                    Ok(text) => (true, text),
                    Err(error) => (false, error),
                }
            } else {
                let out = tools::execute(&run.app, &run.ctx.run_id, name, args).await;
                (out.ok, out.text)
            };
            events::emit(
                &run.app,
                &run.ctx.run_id,
                AgentEvent::ToolResult {
                    call_id,
                    ok,
                    output: text.chars().take(2000).collect(),
                },
            );
            json!({
                "content": [{ "type": "text", "text": text }],
                "isError": !ok,
            })
        }
        _ => json!({}),
    };
    Some(json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_tool_args_strips_injected_summary_without_touching_payload() {
        let cleaned = clean_tool_args(json!({
            "toolSummary": "Edit paragraph",
            "new_text": "Crisper prose.",
        }));
        assert_eq!(cleaned, json!({ "new_text": "Crisper prose." }));
    }

    #[tokio::test]
    async fn mcp_handler_enforces_bearer_auth_and_lists_tools() {
        let active = Arc::new(RwLock::new(None));
        let send = |headers: &str, body: &str| {
            let active = Arc::clone(&active);
            let req = format!(
                "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n{headers}Content-Length: {}\r\n\r\n{body}",
                body.len()
            );
            async move {
                let (mut client, server) = tokio::io::duplex(64 * 1024);
                let task = tokio::spawn(async move {
                    handle_connection(server, active, "Bearer secret").await
                });
                client.write_all(req.as_bytes()).await.unwrap();
                client.shutdown().await.unwrap();
                let mut raw = Vec::new();
                client.read_to_end(&mut raw).await.unwrap();
                task.await.unwrap().unwrap();
                String::from_utf8(raw).unwrap()
            }
        };

        let unauth = send("", r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#).await;
        assert!(unauth.starts_with("HTTP/1.1 401 Unauthorized\r\n"));

        let ok = send(
            "Authorization: Bearer secret\r\n",
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
        )
        .await;
        assert!(ok.starts_with("HTTP/1.1 200 OK\r\n"));
        let (_, json_body) = ok.split_once("\r\n\r\n").unwrap();
        let body: Value = serde_json::from_str(json_body).unwrap();
        let names: Vec<&str> = body["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert!(names.contains(&"read_document"));
        assert!(names.contains(&"edit_document"));
        assert!(names.contains(&"offer_writing_help"));
    }
}

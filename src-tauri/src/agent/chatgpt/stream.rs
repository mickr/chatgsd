use futures_util::StreamExt;
use serde_json::Value;
use tauri::AppHandle;

use super::{
    super::{
        events::{self, AgentEvent},
        AgentError,
    },
    errors::{api_error, other},
};

// Keep raw bytes until a complete SSE line arrives, including split UTF-8 code points.
#[derive(Default)]
struct SseParser {
    buffer: Vec<u8>,
    data: String,
    event: String,
}

impl SseParser {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, AgentError> {
        self.buffer.extend_from_slice(bytes);
        let mut parsed = Vec::new();
        let mut consumed = 0;
        while let Some(offset) = self.buffer[consumed..]
            .iter()
            .position(|byte| *byte == b'\n')
        {
            let end = consumed + offset;
            let line = std::str::from_utf8(&self.buffer[consumed..end])
                .map_err(|_| other("ChatGPT returned invalid UTF-8 in its event stream"))?
                .trim_end_matches('\r');
            if line.is_empty() {
                if !self.data.is_empty() && self.data.trim() != "[DONE]" {
                    let mut value: Value =
                        serde_json::from_str(self.data.trim_end_matches('\n'))
                            .map_err(|_| other("ChatGPT returned an invalid streaming event"))?;
                    if !value.is_object() {
                        return Err(other(
                            "ChatGPT returned a streaming event that was not an object",
                        ));
                    }
                    if value.get("type").is_none() && !self.event.is_empty() {
                        value["type"] = Value::String(self.event.clone());
                    }
                    parsed.push(value);
                }
                self.data.clear();
                self.event.clear();
            } else if let Some(data) = line.strip_prefix("data:") {
                self.data.push_str(data.strip_prefix(' ').unwrap_or(data));
                self.data.push('\n');
            } else if let Some(event) = line.strip_prefix("event:") {
                self.event = event.trim_start().to_owned();
            }
            consumed = end + 1;
        }
        self.buffer.drain(..consumed);
        Ok(parsed)
    }
}

pub(super) async fn consume(
    app: &AppHandle,
    run_id: &str,
    response: reqwest::Response,
) -> Result<Vec<Value>, AgentError> {
    let request_id = response
        .headers()
        .get("x-request-id")
        .and_then(|h| h.to_str().ok())
        .map(str::to_owned);
    let mut stream = response.bytes_stream();
    let mut parser = SseParser::default();
    let mut items = Vec::new();
    loop {
        let chunk = tokio::time::timeout(std::time::Duration::from_secs(120), stream.next())
            .await
            .map_err(|_| {
                with_request_id(
                    other("ChatGPT stopped sending streaming events"),
                    request_id.as_deref(),
                )
            })?;
        let Some(chunk) = chunk else { break };
        let chunk = chunk.map_err(|_| {
            with_request_id(
                other("ChatGPT's response stream was interrupted"),
                request_id.as_deref(),
            )
        })?;
        for event in parser
            .push(&chunk)
            .map_err(|e| with_request_id(e, request_id.as_deref()))?
        {
            match event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
            {
                "response.output_text.delta" => {
                    if let Some(text) = event.get("delta").and_then(Value::as_str) {
                        events::emit(
                            app,
                            run_id,
                            AgentEvent::TextDelta {
                                text: text.to_owned(),
                            },
                        );
                    }
                }
                "response.output_item.done" => {
                    if let Some(item) = event.get("item") {
                        if matches!(
                            item.get("type").and_then(Value::as_str),
                            Some("reasoning" | "message" | "function_call")
                        ) {
                            items.push(item.clone());
                        }
                    }
                }
                "response.completed" => return Ok(items),
                "response.failed" => {
                    return Err(api_error(
                        None,
                        event.get("response").unwrap_or(&event),
                        request_id.as_deref(),
                    ))
                }
                "response.incomplete" => {
                    let reason = event
                        .pointer("/response/incomplete_details/reason")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown reason");
                    return Err(with_request_id(
                        other(format!("ChatGPT's response was incomplete: {reason}")),
                        request_id.as_deref(),
                    ));
                }
                "error" => return Err(api_error(None, &event, request_id.as_deref())),
                _ => {}
            }
        }
    }
    Err(with_request_id(
        other("ChatGPT's stream ended without response.completed"),
        request_id.as_deref(),
    ))
}

fn with_request_id(mut error: AgentError, request_id: Option<&str>) -> AgentError {
    if let Some(id) = request_id {
        error.message.push_str(&format!(" [request ID: {id}]"));
    }
    error
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fragmented_recorded_sse_with_utf8_and_crlf() {
        let sample = concat!(
            ": keepalive\r\n\r\n",
            "event: response.output_text.delta\r\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Café\"}\r\n\r\n",
            "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"namespace\":\"scratch\",\"name\":\"read_document\",\"call_id\":\"call_1\",\"arguments\":\"{}\"}}\n\n",
            "event: response.completed\ndata: {\"response\":{\"status\":\"completed\"}}\n\n",
            "data: [DONE]\n\n"
        );
        let mut parser = SseParser::default();
        let events: Vec<_> = sample
            .as_bytes()
            .chunks(1)
            .flat_map(|chunk| parser.push(chunk).unwrap())
            .collect();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["delta"], "Café");
        assert_eq!(events[1]["item"]["namespace"], "scratch");
        assert_eq!(events[2]["type"], "response.completed");
        assert!(parser.buffer.is_empty());
    }

    #[test]
    fn rejects_malformed_sse_json_but_not_comments_or_partial_frames() {
        let mut parser = SseParser::default();
        assert!(parser
            .push(b": comment\n\ndata: {\"type\":")
            .unwrap()
            .is_empty());
        assert!(parser.push(b"invalid}\n\n").is_err());
        let mut parser = SseParser::default();
        let events = parser
            .push(b"event: error\ndata: {\n data ignored\ndata: \"code\":\"invalid_token\"}\n\n")
            .unwrap();
        assert_eq!(events[0]["type"], "error");
        assert_eq!(events[0]["code"], "invalid_token");
    }
}

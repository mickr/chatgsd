use serde_json::Value;

use super::super::{AgentError, AgentErrorKind};

pub(super) fn other(message: impl Into<String>) -> AgentError {
    AgentError {
        kind: AgentErrorKind::Other,
        message: message.into(),
    }
}

pub(super) fn auth(message: impl Into<String>) -> AgentError {
    AgentError {
        kind: AgentErrorKind::Auth,
        message: message.into(),
    }
}

pub(super) fn error_code(body: &Value) -> Option<&str> {
    body.pointer("/error/code")
        .and_then(Value::as_str)
        .or_else(|| body.get("error").and_then(Value::as_str))
        .or_else(|| body.get("code").and_then(Value::as_str))
}

pub(super) fn unusable_refresh(body: &Value) -> bool {
    matches!(
        error_code(body),
        Some(
            "invalid_grant"
                | "invalid_refresh_token"
                | "token_expired"
                | "refresh_token_expired"
                | "refresh_token_invalidated"
                | "refresh_token_reused"
        )
    )
}

pub(super) fn api_error(status: Option<u16>, body: &Value, request_id: Option<&str>) -> AgentError {
    let code = error_code(body);
    let kind = match code {
        Some("subscription_sharing_usage_limit_exceeded") => AgentErrorKind::UsageLimit,
        Some("subscription_sharing_user_not_eligible") => AgentErrorKind::NotEligible,
        Some(
            "subscription_sharing_invalid_user"
            | "chatpass_v2_scope_not_authorized"
            | "chatpass_v2_invalid_authorization_context"
            | "invalid_api_key"
            | "invalid_token"
            | "invalid_client"
            | "authentication_error"
            | "invalid_grant"
            | "invalid_refresh_token"
            | "token_expired"
            | "refresh_token_expired"
            | "refresh_token_invalidated"
            | "refresh_token_reused",
        ) => AgentErrorKind::Auth,
        _ if status == Some(401) => AgentErrorKind::Auth,
        _ => AgentErrorKind::Other,
    };
    let detail = body
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| body.get("detail").and_then(Value::as_str))
        .or_else(|| body.get("error_description").and_then(Value::as_str))
        .or_else(|| body.get("message").and_then(Value::as_str))
        .unwrap_or("ChatGPT could not complete this request");
    let mut message = String::from(detail);
    if let Some(code) = code {
        message.push_str(&format!(" ({code})"));
    }
    if let Some(param) = body
        .pointer("/error/param")
        .or_else(|| body.get("param"))
        .and_then(Value::as_str)
    {
        message.push_str(&format!(" [parameter: {param}]"));
    }
    if let Some(status) = status {
        message.push_str(&format!(" [HTTP {status}]"));
    }
    if let Some(id) = request_id.or_else(|| body.get("request_id").and_then(Value::as_str)) {
        message.push_str(&format!(" [request ID: {id}]"));
    }
    AgentError { kind, message }
}

pub(super) async fn response_error(response: reqwest::Response) -> AgentError {
    let status = response.status().as_u16();
    let request_id = response
        .headers()
        .get("x-request-id")
        .and_then(|h| h.to_str().ok())
        .map(str::to_owned);
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    api_error(Some(status), &body, request_id.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_recorded_response_errors_and_keeps_diagnostics() {
        let error = api_error(
            Some(429),
            &json!({"error": {
                "code":"subscription_sharing_usage_limit_exceeded", "message":"Usage limit reached", "param":null
            }}),
            Some("req_limit"),
        );
        assert!(matches!(error.kind, AgentErrorKind::UsageLimit));
        assert!(error.message.contains("req_limit"));
        assert!(error.message.contains("HTTP 429"));
        let error = api_error(
            Some(403),
            &json!({"error": {
                "code":"subscription_sharing_user_not_eligible", "message":"Unavailable for this workspace"
            }}),
            None,
        );
        assert!(matches!(error.kind, AgentErrorKind::NotEligible));
        let error = api_error(
            Some(401),
            &json!({"detail":"Signed identity not accepted"}),
            Some("req_auth"),
        );
        assert!(matches!(error.kind, AgentErrorKind::Auth));
        assert!(error.message.contains("Signed identity not accepted"));
        let error = api_error(
            Some(400),
            &json!({"error": {
                "code":"subscription_sharing_unsupported_capability", "message":"Unsupported field", "param":"temperature"
            }}),
            None,
        );
        assert!(matches!(error.kind, AgentErrorKind::Other));
        assert!(error.message.contains("temperature"));
        assert!(unusable_refresh(&json!({"error":"refresh_token_reused"})));
        assert!(!unusable_refresh(
            &json!({"error":"temporarily_unavailable"})
        ));
        assert!(matches!(
            api_error(Some(503), &json!({"detail":"Routing unavailable"}), None).kind,
            AgentErrorKind::Other
        ));
    }
}

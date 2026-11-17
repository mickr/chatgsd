//! The research role: a second model loop the co-editing agent calls through
//! its `research` tool. It searches with OpenAI's hosted `web_search`, reads
//! pages in full with `web_fetch`, and hands back a report. Pages stay in this
//! loop's input and are dropped when it ends, so only the findings reach the
//! conversation. It runs on its own model and brief, both set in settings.
//!
//! Each search and page read is shown in the panel as it happens. Afterwards
//! the sites the report drew on are checked for published skills, and any the
//! user doesn't have are listed for the co-editing agent to offer.
use serde_json::{json, Value};
use url::Url;

use super::super::{
    events::{self, AgentEvent},
    prompt, skills,
    tools::ToolOutput,
    web, AgentError, RunContext,
};
use super::{authorized_request, context, parse_tool_call, stream, ResponseRequest, CLIENT};

/// Search and read rounds per question.
const MAX_ROUNDS: usize = 12;
/// Sites checked for published skills after a report.
const MAX_SITES: usize = 6;

/// Web addresses an output item shows the model opened or cited.
fn consulted(item: &Value) -> Vec<&str> {
    match item.get("type").and_then(Value::as_str) {
        Some("web_search_call") => item
            .pointer("/action/url")
            .and_then(Value::as_str)
            .into_iter()
            .collect(),
        Some("message") => item
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|part| part.get("annotations").and_then(Value::as_array))
            .flatten()
            .filter(|annotation| annotation.get("type").and_then(Value::as_str) == Some("url_citation"))
            .filter_map(|annotation| annotation.get("url").and_then(Value::as_str))
            .collect(),
        _ => Vec::new(),
    }
}

fn message_text(item: &Value) -> String {
    item.get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect()
}

/// One line for the panel about a hosted search step.
fn describe_search(action: &Value) -> String {
    let url = action.get("url").and_then(Value::as_str).unwrap_or_default();
    match action.get("type").and_then(Value::as_str) {
        Some("open_page") => format!("Opened {url}"),
        Some("find_in_page") => format!(
            "Looked for {:?} in {url}",
            action.get("pattern").and_then(Value::as_str).unwrap_or_default()
        ),
        _ => {
            let queries: Vec<&str> = action
                .get("queries")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            if queries.is_empty() {
                "Searched the web".into()
            } else {
                format!("Searched for: {}", queries.join("; "))
            }
        }
    }
}

/// Where a consulted page's site would list its skills: the first path
/// segment for a page inside one (`/docs/guide`), else the site's root.
fn skills_base(url: &Url) -> Option<Url> {
    let mut segments = url.path_segments()?;
    let first = segments.next().filter(|first| !first.is_empty());
    match first {
        Some(first) if segments.next().is_some() => url.join(&format!("/{first}/")),
        _ => url.join("/"),
    }
    .ok()
}

/// Remembers a place to look for skills once, up to the number that get checked.
fn note_site(sites: &mut Vec<Url>, address: &str) {
    let Some(base) = web::http_url(address).ok().and_then(|url| skills_base(&url)) else {
        return;
    };
    if sites.len() < MAX_SITES && !sites.contains(&base) {
        sites.push(base);
    }
}

/// Cited addresses the report doesn't spell out, as a closing list. Hosted
/// search may carry a citation only as an annotation on the text.
fn unlisted_sources(report: &str, cited: &[String]) -> String {
    let mut missing: Vec<&str> = Vec::new();
    for url in cited {
        if !report.contains(url.as_str()) && !missing.contains(&url.as_str()) {
            missing.push(url);
        }
    }
    if missing.is_empty() {
        return String::new();
    }
    format!("\n\nSources:\n{}", missing.iter().map(|url| format!("- {url}")).collect::<Vec<_>>().join("\n"))
}

/// Skills the consulted sites publish that the user doesn't have, as a note
/// for the co-editing agent. Empty when there are none.
async fn published_skills(app: &tauri::AppHandle, sites: &[Url]) -> String {
    let indexes =
        futures_util::future::join_all(sites.iter().map(|site| web::discover(web::PUBLIC, site))).await;
    let installed = skills::installed_names(app).await;
    // A page under a path gets its site's root index as well as its own.
    let mut listed: Vec<&str> = Vec::new();
    let mut lines = Vec::new();
    for entry in indexes.iter().flat_map(|entries| entries.iter()) {
        if !installed.contains(&entry.name) && !listed.contains(&entry.url.as_str()) {
            listed.push(&entry.url);
            lines.push(format!("- {}: {}\n  {}", entry.name, entry.description, entry.url));
        }
    }
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "\n\nSkills published by the sites consulted. If one fits what the user is working on, call offer_skill with its URL; otherwise ignore them:\n{}",
        lines.join("\n")
    )
}

pub(super) async fn run(
    app: &tauri::AppHandle,
    ctx: &RunContext,
    model: &str,
    call_id: &str,
    args: &Value,
) -> Result<ToolOutput, AgentError> {
    if !ctx.web_access {
        return Ok(ToolOutput::error("Internet access is off for this message"));
    }
    let Some(question) = args
        .get("question")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|question| !question.is_empty())
    else {
        return Ok(ToolOutput::error("question must be a nonempty string"));
    };
    let instructions = prompt::research_instructions(ctx.research_brief.as_deref());
    let tools = [
        json!({"type":"namespace", "name":"scratch", "description":"Read web pages in full.", "tools":[{
            "type":"function", "name":"web_fetch",
            "description":"Read one web page as markdown, by URL. Short pages come back whole; a long page comes back as an outline with line numbers and its opening, so pass start_line and end_line (1-based, inclusive, up to 400 lines) to read further. Pass null for both to start.",
            "parameters":{"type":"object","properties":{"url":{"type":"string"},"start_line":{"type":["integer","null"]},"end_line":{"type":["integer","null"]}},"required":["url","start_line","end_line"],"additionalProperties":false},
            "strict":true,
        }]}),
        json!({"type":"web_search"}),
    ];
    let mut input = vec![json!({"role": "user", "content": question})];
    let mut sites = Vec::new();
    let mut pages = web::Pages::default();
    let mut report = String::new();
    let mut finished = false;
    let mut step = 0;
    let mut show = |name: &str, input: Value, ok: bool, output: &str| {
        step += 1;
        let step_id = format!("{call_id}.{step}");
        events::emit(
            app,
            &ctx.run_id,
            AgentEvent::ToolCall { call_id: step_id.clone(), name: name.to_owned(), input },
        );
        events::emit(
            app,
            &ctx.run_id,
            AgentEvent::ToolResult { call_id: step_id, ok, output: output.chars().take(2000).collect() },
        );
    };
    for _ in 0..MAX_ROUNDS {
        context::fit(&mut input, context::MAX_INPUT_BYTES);
        let body = ResponseRequest {
            model,
            instructions: &instructions,
            input: &input,
            tools: &tools,
            store: false,
            stream: true,
            include: ["reasoning.encrypted_content"],
            parallel_tool_calls: false,
        };
        let response = authorized_request(app, |token| {
            CLIENT
                .post("https://api.openai.com/v1/responses")
                .bearer_auth(token)
                .json(&body)
        })
        .await?;
        // The report goes back to the co-editing agent, so nothing streams to the panel.
        let items = stream::consume(response, |_| {}).await?;
        let mut said = String::new();
        let mut cited = Vec::new();
        for item in &items {
            let is_message = item.get("type").and_then(Value::as_str) == Some("message");
            for address in consulted(item) {
                note_site(&mut sites, address);
                if is_message {
                    cited.push(address.to_owned());
                }
            }
            match item.get("type").and_then(Value::as_str) {
                Some("web_search_call") => {
                    let action = item.get("action").cloned().unwrap_or(Value::Null);
                    let summary = describe_search(&action);
                    show("web_search", action, true, &summary);
                }
                Some("message") => said.push_str(&message_text(item)),
                _ => {}
            }
        }
        let calls: Vec<_> = items
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
            .map(parse_tool_call)
            .collect::<Result<_, _>>()?;
        input.extend(items);
        for call in &calls {
            let name = events::canonical_tool_name(&call.name);
            let (output, read) = if name == "web_fetch" {
                web::fetch_tool(web::PUBLIC, &mut pages, &call.args).await
            } else {
                (ToolOutput::error(format!("Unknown tool: {name}")), None)
            };
            if let Some(url) = read {
                note_site(&mut sites, url.as_str());
            }
            show(name, call.args.clone(), output.ok, &output.text);
            input.push(json!({"type":"function_call_output", "call_id":call.id, "output":output.text}));
        }
        if !said.trim().is_empty() {
            said.push_str(&unlisted_sources(&said, &cited));
            report = said;
        }
        if calls.is_empty() {
            finished = true;
            break;
        }
    }
    if report.trim().is_empty() {
        return Ok(ToolOutput::error(
            "The research assistant had nothing to report. Ask a narrower question.",
        ));
    }
    if !finished {
        report.push_str("\n\n[Research stopped at its round limit; this report may be incomplete.]");
    }
    report.push_str(&published_skills(app, &sites).await);
    Ok(ToolOutput::ok(report))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consulted_pages_give_places_to_look_for_skills_and_the_reports_sources() {
        // Shapes as the Responses API returns them for hosted web search.
        let items = [
            json!({"type": "web_search_call", "status": "completed", "action": {
                "type": "search", "queries": ["agent skills discovery"], "query": "agent skills discovery"}}),
            json!({"type": "web_search_call", "status": "completed", "action": {
                "type": "open_page", "url": "https://docs.example.com/guide"}}),
            json!({"type": "message", "role": "assistant", "content": [{
                "type": "output_text",
                "text": "The index lives at a well-known path. ([docs](https://docs.example.com/rfc?utm_source=openai))",
                "annotations": [
                    {"type": "url_citation", "start_index": 0, "end_index": 10, "title": "RFC", "url": "https://docs.example.com/rfc?utm_source=openai"},
                    {"type": "url_citation", "start_index": 0, "end_index": 10, "title": "Blog", "url": "https://blog.example.org/post"},
                    {"type": "file_citation", "file_id": "file_1"},
                ]}]}),
            json!({"type": "reasoning", "encrypted_content": "opaque"}),
        ];
        let mut sites = Vec::new();
        for item in &items {
            for address in consulted(item) {
                note_site(&mut sites, address);
            }
        }
        note_site(&mut sites, "file:///etc/passwd");
        // A page under a path adds that path: its docs may publish their own index there.
        note_site(&mut sites, "https://docs.example.com/docs/guide");
        assert_eq!(
            sites.iter().map(Url::as_str).collect::<Vec<_>>(),
            ["https://docs.example.com/", "https://blog.example.org/", "https://docs.example.com/docs/"]
        );
        let text = message_text(&items[2]);
        assert!(text.starts_with("The index lives"));
        let cited: Vec<String> = consulted(&items[2]).into_iter().map(str::to_owned).collect();
        assert_eq!(
            unlisted_sources(&text, &cited),
            "\n\nSources:\n- https://blog.example.org/post",
            "a citation carried only as an annotation still reaches the report"
        );
        assert_eq!(describe_search(&items[0]["action"]), "Searched for: agent skills discovery");
        assert_eq!(describe_search(&items[1]["action"]), "Opened https://docs.example.com/guide");

        for n in 0..MAX_SITES + 3 {
            note_site(&mut sites, &format!("https://site{n}.example.net/"));
        }
        assert_eq!(sites.len(), MAX_SITES);
    }
}

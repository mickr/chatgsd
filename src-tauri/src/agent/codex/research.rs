//! Research has its own ephemeral Codex thread and only hosted search plus the
//! application's public-URL page reader. No editor, filesystem or computer tools.
use serde_json::{json, Value};
use url::Url;
use super::{account, dynamic_tool, other, turn_result, transport::Server};
use super::super::{events::{self, AgentEvent}, prompt, skills, tools::ToolOutput, web, AgentError, RunContext};

const MAX_SITES: usize = 6;
const MAX_STEPS: usize = 80;

fn note_site(sites: &mut Vec<Url>, address: &str) {
    let Some(url) = web::http_url(address).ok() else { return; };
    let Some(mut segments) = url.path_segments() else { return; };
    let first = segments.next().filter(|segment| !segment.is_empty());
    let base = match first {
        Some(first) if segments.next().is_some() => url.join(&format!("/{first}/")),
        _ => url.join("/"),
    };
    if let Ok(base) = base {
        if sites.len() < MAX_SITES && !sites.contains(&base) { sites.push(base); }
    }
}

async fn published_skills(app: &tauri::AppHandle, sites: &[Url]) -> String {
    let indexes = futures_util::future::join_all(sites.iter().map(|site| web::discover(web::PUBLIC, site))).await;
    let installed = skills::installed_names(app).await;
    let mut listed = Vec::new();
    let mut lines = Vec::new();
    for entry in indexes.iter().flat_map(|entries| entries.iter()) {
        if !installed.contains(&entry.name) && !listed.contains(&entry.url.as_str()) {
            listed.push(entry.url.as_str());
            lines.push(format!("- {}: {}\n  {}", entry.name, entry.description, entry.url));
        }
    }
    if lines.is_empty() { return String::new(); }
    format!("\n\nSkills published by consulted sites. If relevant, call offer_skill with the URL; the user decides whether to install:\n{}", lines.join("\n"))
}

pub(super) async fn run(app: &tauri::AppHandle, ctx: &RunContext, model: Option<&str>, call_id: &str, args: &Value) -> Result<ToolOutput, AgentError> {
    if !ctx.web_access { return Ok(ToolOutput::error("Internet access is off for this message")); }
    let Some(question) = args["question"].as_str().map(str::trim).filter(|question| !question.is_empty()) else {
        return Ok(ToolOutput::error("question must be a nonempty string"));
    };
    let mut server = Server::start(app).await.map_err(other)?;
    if account::read(&mut server).await.map_err(other)?.is_none() { return Err(super::auth("Sign in with ChatGPT to research")); }
    let fetch = dynamic_tool("web_fetch", "Read a public web page as markdown. Pass url and nullable 1-based start_line/end_line (at most 400 lines) for long pages.", json!({"type":"object","properties":{"url":{"type":"string"},"start_line":{"type":["integer","null"]},"end_line":{"type":["integer","null"]}},"required":["url","start_line","end_line"],"additionalProperties":false}));
    let started = server.rpc("thread/start", json!({"model":model,"cwd":server.cwd,"ephemeral":true,"sandbox":"read-only","approvalPolicy":"on-request","environments":[],"baseInstructions":prompt::research_instructions(ctx.research_brief.as_deref()),"config":{"web_search":"live"},"dynamicTools":[fetch]})).await.map_err(other)?;
    let thread = started["thread"]["id"].as_str().ok_or_else(|| other("Codex returned no research thread ID"))?.to_owned();
    let started = server.rpc("turn/start", json!({"threadId":thread,"input":[{"type":"text","text":question,"text_elements":[]}],"sandboxPolicy":{"type":"readOnly","networkAccess":false},"approvalPolicy":"on-request"})).await.map_err(other)?;
    let turn = started["turn"]["id"].as_str().ok_or_else(|| other("Codex returned no research turn ID"))?.to_owned();
    let mut pages = web::Pages::default();
    let mut sites = Vec::new();
    let mut report = String::new();
    let mut steps = 0;
    let mut calls = std::collections::HashSet::new();
    loop {
        let message = server.next().await.map_err(other)?;
        let params = &message["params"];
        if message.get("id").is_some() {
            if message["method"] != "item/tool/call" || params["threadId"] != thread || params["turnId"] != turn || params["tool"] != "web_fetch" {
                server.reject(&message).await.map_err(other)?;
                continue;
            }
            let id = params["callId"].as_str().ok_or_else(|| other("Codex returned no research call ID"))?;
            if !calls.insert(id.to_owned()) { return Err(other("Codex repeated a page-read call; it was not replayed")); }
            steps += 1;
            if steps > MAX_STEPS { return Err(other("Research reached its search and page-read limit. Ask a narrower question.")); }
            let event_id = format!("{call_id}.{id}");
            events::emit(app, &ctx.run_id, AgentEvent::ToolCall { call_id: event_id.clone(), name: "web_fetch".into(), input: params["arguments"].clone() });
            let (result, read) = web::fetch_tool(web::PUBLIC, &mut pages, &params["arguments"]).await;
            if let Some(url) = read { note_site(&mut sites, url.as_str()); }
            events::emit(app, &ctx.run_id, AgentEvent::ToolResult { call_id: event_id, ok: result.ok, output: result.text.chars().take(2000).collect() });
            server.send(json!({"id":message["id"],"result":{"success":result.ok,"contentItems":[{"type":"inputText","text":result.text}]}})).await.map_err(other)?;
            continue;
        }
        if params["threadId"] != thread { continue; }
        if message["method"] == "item/completed" && params["turnId"] == turn {
            let item = &params["item"];
            if item["type"] == "agentMessage" {
                let text = item["text"].as_str().ok_or_else(|| other("Codex returned an invalid research report"))?;
                if !report.is_empty() { report.push_str("\n\n"); }
                report.push_str(text);
            }
            if item["type"] == "webSearch" {
                steps += 1;
                if steps > MAX_STEPS { return Err(other("Research reached its search and page-read limit. Ask a narrower question.")); }
                let action = &item["action"];
                if let Some(address) = action["url"].as_str() { note_site(&mut sites, address); }
                let id = format!("{call_id}.{}", item["id"].as_str().unwrap_or("search"));
                events::emit(app, &ctx.run_id, AgentEvent::ToolCall { call_id: id.clone(), name: "web_search".into(), input: action.clone() });
                events::emit(app, &ctx.run_id, AgentEvent::ToolResult { call_id: id, ok: true, output: action.to_string().chars().take(2000).collect() });
            }
        }
        if message["method"] == "turn/completed" && params["turn"]["id"] == turn {
            turn_result(&params["turn"])?;
            if report.trim().is_empty() { return Ok(ToolOutput::error("The research assistant had nothing to report. Ask a narrower question.")); }
            // Citations are ordinary Markdown URLs in Codex assistant messages;
            // include them in skill-discovery sites as well as explicit opens.
            for word in report.split_whitespace() {
                let address = word.trim_matches(|character: char| matches!(character, '(' | ')' | '[' | ']' | '<' | '>' | ',' | '.'));
                if let Some(index) = address.find("https://").or_else(|| address.find("http://")) { note_site(&mut sites, &address[index..]); }
            }
            report.push_str(&published_skills(app, &sites).await);
            return Ok(ToolOutput::ok(report));
        }
    }
}

//! The whole path against a loopback MCP server that requires OAuth: the 401
//! challenge, discovery, registration, PKCE sign-in, the tool catalog, calls,
//! and recovery from an expired session or sign-in.
use super::*;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[derive(Default)]
struct Fixture {
    /// Bearer tokens the server accepts.
    valid: Vec<String>,
    refresh_tokens: Vec<String>,
    session: u32,
    registrations: u32,
    code_challenge: String,
    redirect_uri: String,
    issued: u32,
    /// Set, the service registers no apps itself (like Box and Slack): it knows
    /// only this client ID and secret, made there by the user.
    preset: Option<(&'static str, &'static str)>,
    /// The port that client was registered with for another app, as
    /// `http://localhost:<port>/callback`.
    callback_port: Option<u16>,
}

struct Server {
    base: String,
    fixture: Arc<Mutex<Fixture>>,
}

fn header(name: &str, value: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(name, value).unwrap()
}

fn respond_json(request: tiny_http::Request, status: u16, body: Value, headers: Vec<tiny_http::Header>) {
    let mut response = tiny_http::Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json"));
    for extra in headers {
        response.add_header(extra);
    }
    let _ = request.respond(response);
}

fn rpc(base: &str, fixture: &Mutex<Fixture>, mut request: tiny_http::Request) {
    let find = |name: &str| request.headers().iter()
        .find(|header| header.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|header| header.value.as_str().to_owned());
    let authorized = find("Authorization").and_then(|value| value.strip_prefix("Bearer ").map(str::to_owned))
        .is_some_and(|token| fixture.lock().unwrap().valid.contains(&token));
    if !authorized {
        let challenge = format!(r#"Bearer resource_metadata="{base}/.well-known/oauth-protected-resource/mcp""#);
        let _ = request.respond(tiny_http::Response::empty(401).with_header(header("WWW-Authenticate", &challenge)));
        return;
    }
    let session = find("Mcp-Session-Id");
    let mut body = String::new();
    request.as_reader().read_to_string(&mut body).unwrap();
    let message: Value = serde_json::from_str(&body).unwrap();
    let id = message["id"].clone();
    let current = format!("session-{}", fixture.lock().unwrap().session);
    let method = message["method"].as_str().unwrap_or_default();
    if method != "initialize" && session.as_deref() != Some(current.as_str()) {
        let _ = request.respond(tiny_http::Response::empty(404));
        return;
    }
    match method {
        "initialize" => {
            let opened = {
                let mut fixture = fixture.lock().unwrap();
                fixture.session += 1;
                format!("session-{}", fixture.session)
            };
            respond_json(request, 200, json!({"jsonrpc":"2.0","id":id,"result":{
                "protocolVersion":"2025-06-18","capabilities":{"tools":{}},
                "serverInfo":{"name":"fixture","title":"Fixture Tracker","version":"1"},
            }}), vec![header("Mcp-Session-Id", &opened)]);
        }
        "notifications/initialized" => {
            let _ = request.respond(tiny_http::Response::empty(202));
        }
        "tools/list" => {
            // Answered as an event stream, with a notification ahead of the result.
            let result = json!({"jsonrpc":"2.0","id":id,"result":{"tools":[
                {"name":"search_issues","description":"Find issues","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}},"annotations":{"readOnlyHint":true}},
                {"name":"create_issue","description":"Open an issue","inputSchema":{"type":"object"}},
            ]}});
            let stream = format!(
                "event: message\ndata: {}\n\nevent: message\ndata: {result}\n\n",
                json!({"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"listing"}})
            );
            let _ = request.respond(tiny_http::Response::from_string(stream).with_header(header("Content-Type", "text/event-stream")));
        }
        "tools/call" => respond_json(request, 200, json!({"jsonrpc":"2.0","id":id,"result":{
            "content":[{"type":"text","text":format!("{} saw {}", message["params"]["name"], message["params"]["arguments"]["text"])}],
        }}), Vec::new()),
        _ => respond_json(request, 200, json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}}), Vec::new()),
    }
}

fn token(fixture: &Mutex<Fixture>, mut request: tiny_http::Request) {
    let mut body = String::new();
    request.as_reader().read_to_string(&mut body).unwrap();
    let form: HashMap<String, String> = url::form_urlencoded::parse(body.as_bytes()).into_owned().collect();
    let field = |name: &str| form.get(name).map(String::as_str).unwrap_or_default();
    let mut fixture = fixture.lock().unwrap();
    let granted = match field("grant_type") {
        "authorization_code" => {
            let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(field("code_verifier").as_bytes()));
            field("code") == "code-1" && challenge == fixture.code_challenge && field("redirect_uri") == fixture.redirect_uri
        }
        "refresh_token" => {
            let known = fixture.refresh_tokens.iter().any(|token| token == field("refresh_token"));
            // Refresh tokens rotate: each is good once.
            fixture.refresh_tokens.clear();
            known
        }
        _ => false,
    };
    let authenticated = fixture.preset.is_none_or(|(id, secret)| field("client_id") == id && field("client_secret") == secret);
    if !granted || !authenticated || !field("resource").ends_with("/mcp") {
        drop(fixture);
        respond_json(request, 400, json!({"error":"invalid_grant","error_description":"The grant is no longer valid"}), Vec::new());
        return;
    }
    fixture.issued += 1;
    let (access, refresh) = (format!("access-{}", fixture.issued), format!("refresh-{}", fixture.issued));
    fixture.valid = vec![access.clone()];
    fixture.refresh_tokens = vec![refresh.clone()];
    drop(fixture);
    respond_json(request, 200, json!({"access_token":access,"refresh_token":refresh,"token_type":"Bearer","expires_in":3600}), Vec::new());
}

fn serve() -> Server {
    let listener = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.server_addr().to_ip().unwrap());
    let fixture = Arc::new(Mutex::new(Fixture::default()));
    let server = Server { base: base.clone(), fixture: fixture.clone() };
    std::thread::spawn(move || {
        for mut request in listener.incoming_requests() {
            let target = request.url().to_owned();
            let (path, query) = target.split_once('?').unwrap_or((&target, ""));
            match (request.method().as_str(), path) {
                ("POST", "/mcp") => rpc(&base, &fixture, request),
                ("DELETE", "/mcp") => { let _ = request.respond(tiny_http::Response::empty(200)); }
                ("GET", "/.well-known/oauth-protected-resource/mcp") => respond_json(request, 200, json!({
                    "resource": format!("{base}/mcp"), "authorization_servers": [base], "scopes_supported": ["issues.read", "issues.write"],
                }), Vec::new()),
                ("GET", "/.well-known/oauth-authorization-server") => {
                    let mut metadata = json!({
                        "issuer": base, "authorization_endpoint": format!("{base}/authorize"), "token_endpoint": format!("{base}/token"),
                        "code_challenge_methods_supported": ["S256"],
                    });
                    if fixture.lock().unwrap().preset.is_some() {
                        metadata["token_endpoint_auth_methods_supported"] = json!(["client_secret_post"]);
                    } else {
                        metadata["registration_endpoint"] = json!(format!("{base}/register"));
                    }
                    respond_json(request, 200, metadata, Vec::new());
                }
                ("POST", "/register") => {
                    let mut body = String::new();
                    request.as_reader().read_to_string(&mut body).unwrap();
                    let registration: Value = serde_json::from_str(&body).unwrap();
                    let mut state = fixture.lock().unwrap();
                    state.registrations += 1;
                    state.redirect_uri = registration["redirect_uris"][0].as_str().unwrap().to_owned();
                    let id = format!("client-{}", state.registrations);
                    drop(state);
                    respond_json(request, 201, json!({"client_id": id}), Vec::new());
                }
                ("GET", "/authorize") => {
                    let query: HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();
                    let mut state = fixture.lock().unwrap();
                    if let Some((id, _)) = state.preset {
                        state.registrations = 1;
                        state.redirect_uri = match state.callback_port {
                            Some(port) => format!("http://localhost:{port}/callback"),
                            None => oauth::redirect_uri(oauth::PRESET_PORT),
                        };
                        assert_eq!(query["client_id"], id);
                    }
                    let expected = (state.preset.is_some() || query["client_id"] == format!("client-{}", state.registrations))
                        && query["response_type"] == "code" && query["code_challenge_method"] == "S256"
                        && query["redirect_uri"] == state.redirect_uri && query["resource"] == format!("{base}/mcp")
                        && query["scope"] == "issues.read issues.write";
                    state.code_challenge = query["code_challenge"].clone();
                    drop(state);
                    let location = match expected {
                        true => format!("{}?code=code-1&state={}", query["redirect_uri"], query["state"]),
                        false => format!("{}?error=invalid_request&state={}", query["redirect_uri"], query["state"]),
                    };
                    let _ = request.respond(tiny_http::Response::empty(302).with_header(header("Location", &location)));
                }
                ("POST", "/token") => token(&fixture, request),
                _ => { let _ = request.respond(tiny_http::Response::empty(404)); }
            }
        }
    });
    server
}

struct Home(std::path::PathBuf);

impl Home {
    async fn with_server(url: &str, local: bool) -> (Self, String) {
        let root = std::env::temp_dir().join(format!("chatgsd-mcp-{}", uuid::Uuid::new_v4()));
        let id = "server-1".to_owned();
        store::update(&root, |store| {
            store.servers.push(ServerConfig {
                id: id.clone(), name: "127.0.0.1".into(), url: url.into(), enabled: true, local, auto_name: true,
                client_id: None, callback_port: None, launch: None, hint: None, tools: Vec::new(), policies: HashMap::new(), added_at: 0,
            });
            Ok(())
        }).await.unwrap();
        (Self(root), id)
    }

    async fn server(&self, id: &str) -> ServerConfig {
        store::read(&self.0).await.unwrap().server(id).unwrap().clone()
    }

    async fn access_token(&self, id: &str) -> Option<String> {
        store::read(&self.0).await.unwrap().credentials.get(id)?.oauth.as_ref().map(|tokens| tokens.access_token.clone())
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Stands in for the user's browser: follows the sign-in page's redirect back
/// to ChatGSD's loopback listener.
fn browser(page: &str) -> Result<(), String> {
    let page = page.to_owned();
    tokio::spawn(async move {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        client.get(page).send().await.unwrap();
    });
    Ok(())
}

fn text(result: &Value) -> &str {
    result["content"][0]["text"].as_str().unwrap()
}

#[tokio::test]
async fn signs_in_from_the_address_alone_then_survives_lapsed_sessions_and_tokens() {
    let fixture = serve();
    let (home, id) = Home::with_server(&format!("{}/mcp", fixture.base), true).await;
    let state = McpState::default();

    assert!(matches!(connect_in(&state, &home.0, &id).await, Err(Failure::NeedsAuth)));
    authorize_in(&home.0, &id, browser).await.unwrap();
    assert_eq!(home.access_token(&id).await.as_deref(), Some("access-1"));

    connect_in(&state, &home.0, &id).await.unwrap();
    let server = home.server(&id).await;
    assert_eq!(server.name, "Fixture Tracker", "the placeholder name gives way to the server's own");
    assert_eq!(server.tools.iter().map(|tool| (tool.name.as_str(), tool.read_only)).collect::<Vec<_>>(),
        [("search_issues", true), ("create_issue", false)]);

    let arguments = json!({"text":"launch plan"});
    let found = invoke(&state, &home.0, &server, "search_issues", &arguments).await.unwrap();
    assert_eq!(text(&found), "\"search_issues\" saw \"launch plan\"");

    // The server forgets the session: the call starts a new one and runs once.
    fixture.fixture.lock().unwrap().session += 10;
    let found = invoke(&state, &home.0, &server, "search_issues", &arguments).await.unwrap();
    assert_eq!(text(&found), "\"search_issues\" saw \"launch plan\"");

    // The access token is revoked early: it is renewed without the user.
    fixture.fixture.lock().unwrap().valid.clear();
    invoke(&state, &home.0, &server, "search_issues", &arguments).await.unwrap();
    assert_eq!(home.access_token(&id).await.as_deref(), Some("access-2"));

    // Nothing left to renew with: the user has to sign in again.
    {
        let mut fixture = fixture.fixture.lock().unwrap();
        fixture.valid.clear();
        fixture.refresh_tokens.clear();
    }
    assert!(matches!(invoke(&state, &home.0, &server, "search_issues", &arguments).await, Err(Failure::NeedsAuth)));
    assert_eq!(home.access_token(&id).await, None);

    authorize_in(&home.0, &id, browser).await.unwrap();
    connect_in(&state, &home.0, &id).await.unwrap();
    assert_eq!(fixture.fixture.lock().unwrap().registrations, 1, "signing in again reuses the app's registration");
}

/// Box and Slack: no registration endpoint, and a token endpoint that wants a
/// client secret. Sign-in says what's missing, then works once the user's own
/// client is entered.
#[tokio::test]
async fn a_service_that_registers_no_apps_signs_in_with_the_users_client_and_secret() {
    let fixture = serve();
    fixture.fixture.lock().unwrap().preset = Some(("made-by-hand", "s3cret"));
    let (home, id) = Home::with_server(&format!("{}/mcp", fixture.base), true).await;
    let never_opened = |_: &str| -> Result<(), String> { panic!("the browser opened for a sign-in that can't finish") };

    assert_eq!(authorize_in(&home.0, &id, never_opened).await.unwrap_err(), oauth::NEEDS_CLIENT);

    // The ID alone is tried, since some services take clients without a secret.
    // This one refuses the code, and the refusal asks for the secret.
    store::update(&home.0, |store| { store.server_mut("server-1")?.client_id = Some("made-by-hand".into()); Ok(()) }).await.unwrap();
    assert_eq!(authorize_in(&home.0, &id, browser).await.unwrap_err(), oauth::NEEDS_CLIENT);
    assert_eq!(home.access_token(&id).await, None);

    store::update(&home.0, |store| {
        store.credentials.entry("server-1".into()).or_default().client_secret = Some("s3cret".into());
        Ok(())
    }).await.unwrap();
    authorize_in(&home.0, &id, browser).await.unwrap();
    assert_eq!(home.access_token(&id).await.as_deref(), Some("access-1"));

    // Renewing sends the secret too.
    let state = McpState::default();
    connect_in(&state, &home.0, &id).await.unwrap();
    fixture.fixture.lock().unwrap().valid.clear();
    let server = home.server(&id).await;
    invoke(&state, &home.0, &server, "search_issues", &json!({"text":"x"})).await.unwrap();
    assert_eq!(home.access_token(&id).await.as_deref(), Some("access-2"));
}

/// A client made for another app is registered with that app's port. Signing
/// in with it has to listen there and name the same redirect address.
#[tokio::test]
async fn a_client_registered_for_another_app_signs_in_on_its_callback_port() {
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let fixture = serve();
    {
        let mut fixture = fixture.fixture.lock().unwrap();
        fixture.preset = Some(("made-for-another-app", ""));
        fixture.callback_port = Some(port);
    }
    let (home, id) = Home::with_server(&format!("{}/mcp", fixture.base), true).await;
    store::update(&home.0, |store| {
        let server = store.server_mut("server-1")?;
        server.client_id = Some("made-for-another-app".into());
        server.callback_port = Some(port);
        Ok(())
    }).await.unwrap();

    authorize_in(&home.0, &id, browser).await.unwrap();
    assert_eq!(home.access_token(&id).await.as_deref(), Some("access-1"));
    assert_eq!(callback_port(Some(80), true).unwrap_err(), "The callback port must be 1024 or higher");
    assert_eq!(callback_port(Some(port), false).unwrap(), None, "a port means nothing without a client");
}

#[tokio::test]
async fn a_pasted_token_is_sent_as_is_and_a_wrong_one_asks_for_sign_in() {
    let fixture = serve();
    fixture.fixture.lock().unwrap().valid.push("pasted-token".into());
    let (home, id) = Home::with_server(&format!("{}/mcp", fixture.base), true).await;
    let state = McpState::default();
    let set_token = |token: &'static str| store::update(&home.0, move |store| {
        store.credentials.entry("server-1".into()).or_default().token = Some(token.into());
        Ok(())
    });

    set_token("pasted-token").await.unwrap();
    connect_in(&state, &home.0, &id).await.unwrap();
    assert_eq!(home.server(&id).await.tools.len(), 2);

    set_token("wrong-token").await.unwrap();
    assert!(matches!(connect_in(&state, &home.0, &id).await, Err(Failure::NeedsAuth)));
}

#[tokio::test]
async fn a_server_saved_as_public_cannot_reach_this_machine() {
    let fixture = serve();
    fixture.fixture.lock().unwrap().valid.push("pasted-token".into());
    let (home, id) = Home::with_server(&format!("{}/mcp", fixture.base), false).await;
    match connect_in(&McpState::default(), &home.0, &id).await {
        Err(Failure::Other(message)) => assert!(message.contains("public web addresses"), "{message}"),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert_eq!(fixture.fixture.lock().unwrap().session, 0, "no request reached the server");
}

#[cfg(unix)]
#[tokio::test]
async fn a_program_in_mcp_json_is_started_listed_called_and_restarted_when_the_file_changes() {
    let root = std::env::temp_dir().join(format!("chatgsd-mcp-{}", uuid::Uuid::new_v4()));
    let home = Home(root.clone());
    let define = |target: &'static str| {
        let entry = serde_json::to_value(stdio::tests::launch(target)).unwrap();
        config::change(&home.0, move |servers| { servers.insert("greeter".into(), entry); Ok(()) })
    };
    define("world").await.unwrap();
    let id = program_id("greeter");
    let state = McpState::default();

    connect_in(&state, &root, &id).await.unwrap();
    let server = home.server(&id).await;
    assert_eq!(server.name, "greeter", "a program is called what the file calls it");
    assert_eq!(server.tools.iter().map(|tool| (tool.name.as_str(), tool.read_only)).collect::<Vec<_>>(), [("greet", true)]);
    let greeted = invoke(&state, &root, &server, "greet", &json!({})).await.unwrap();
    assert_eq!(text(&greeted), "hello world, refused");

    // The program stops: the next call starts it again. The call it stopped in is not repeated.
    assert!(matches!(invoke(&state, &root, &server, "crash", &json!({})).await, Err(Failure::Other(message)) if message.contains("out of memory")));
    assert_eq!(text(&invoke(&state, &root, &server, "greet", &json!({})).await.unwrap()), "hello world, refused");

    // The file now starts it differently: the next call runs what the file says.
    define("moon").await.unwrap();
    let server = home.server(&id).await;
    assert_eq!(text(&invoke(&state, &root, &server, "greet", &json!({})).await.unwrap()), "hello moon, refused");

    std::fs::write(config::path(&root), "{ mid-edit").unwrap();
    let server = home.server(&id).await;
    assert!(matches!(invoke(&state, &root, &server, "greet", &json!({})).await, Err(Failure::Other(message)) if message.contains("mcp.json")));
    assert!(matches!(connect_in(&state, &root, &id).await, Err(Failure::Other(_))));
}

/// Explicitly opt in: CHATGSD_MCP_URL=https://mcp.example.com/mcp cargo test live_server -- --ignored --nocapture
/// Sends the handshake only: no sign-in, no registration, no tool calls.
#[tokio::test]
#[ignore = "requires network access to an explicitly selected MCP server"]
async fn live_server_answers_the_handshake_or_says_where_to_sign_in() {
    let address = std::env::var("CHATGSD_MCP_URL").expect("select a server with CHATGSD_MCP_URL");
    let (url, local) = server_address(&address).await.unwrap();
    let fetcher = if local { web::ANY } else { web::PUBLIC };
    let endpoint = Endpoint { url: url.clone(), fetcher, bearer: None };
    match endpoint.initialize().await {
        Ok(hello) => {
            let tools = endpoint.list_tools(&hello.session).await.unwrap();
            println!("{:?} speaks MCP {} and lists {} tools", hello.name, hello.session.version, tools.len());
            endpoint.close(&hello.session).await;
        }
        Err(client::Error::Unauthorized(header)) => {
            let page = oauth::sign_in_page(fetcher, local, &url, &oauth::challenge(header.as_deref())).await.unwrap();
            println!("asks for sign-in at {page}");
        }
        Err(error) => panic!("{error}"),
    }
}

/// Explicitly opt in: CHATGSD_MCP_COMMAND="npx -y a-server" cargo test live_program -- --ignored --nocapture
/// Starts the program and lists its tools: no tool is called.
#[tokio::test]
#[ignore = "runs an explicitly selected program"]
async fn live_program_answers_the_handshake_and_lists_its_tools() {
    let command = std::env::var("CHATGSD_MCP_COMMAND").expect("select a program with CHATGSD_MCP_COMMAND");
    let launch = config::Launch::parse(&command, "").unwrap();
    let process = stdio::Process::start(&launch).await.unwrap_or_else(|error| panic!("{error}"));
    let tools = client::list_tools(&process).await.unwrap();
    println!("{} lists {} tools: {:?}", launch.line(), tools.len(), tools.iter().map(|tool| &tool.name).collect::<Vec<_>>());
}

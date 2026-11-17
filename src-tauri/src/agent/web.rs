//! Reading the public web for the research role, and finding the Agent Skills
//! a site publishes.
//!
//! Every request is made by this module, never the webview: http(s) only, to
//! public addresses only (checked again on each redirect, with the connection
//! pinned to the address that was checked), with a size cap. Pages come back
//! as markdown so they page like long notes.
//!
//! Skill discovery follows the Agent Skills Discovery RFC
//! (https://github.com/cloudflare/agent-skills-discovery-rfc): a site lists its
//! skills at `/.well-known/agent-skills/index.json` (v0.2.0, with a digest per
//! skill) or the earlier `/.well-known/skills/index.json` (v0.1.0).
//! Documentation served under a path (`example.com/docs`) publishes its index
//! under that path, so the first path segment is tried after the root.
use super::{reading, skills, tools::ToolOutput};
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use url::{Host, Url};

const TIMEOUT: Duration = Duration::from_secs(20);
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_REDIRECTS: usize = 5;
const MAX_PAGE_BYTES: usize = 2_000_000;
const MAX_INDEX_BYTES: usize = 500_000;
const MAX_INDEX_SKILLS: usize = 50;
/// Lines longer than this are folded, so one line of minified text can't
/// defeat paging by line.
const MAX_LINE_CHARS: usize = 2_000;
const USER_AGENT: &str = concat!(
    "ChatGSD/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/mickr/chatgsd)"
);
/// Many documentation sites serve markdown when asked, which reads cleaner
/// than converted HTML.
const PAGE_ACCEPT: &str = "text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.1";
const SCHEMA_0_2: &str = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
const INDEX_PATHS: [&str; 2] = [
    ".well-known/agent-skills/index.json",
    ".well-known/skills/index.json",
];

#[derive(Debug)]
pub enum FetchError {
    /// The site answered, with an error status.
    Status(String, u16),
    Other(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Status(host, status) => write!(f, "{host} answered {status}"),
            Self::Other(message) => f.write_str(message),
        }
    }
}

pub struct Fetched {
    /// Where the content came from, after redirects.
    pub url: Url,
    pub content_type: String,
    pub bytes: Vec<u8>,
    /// The body was longer than the cap and was cut there.
    pub truncated: bool,
}

/// An http(s) address with a host and no embedded credentials.
pub fn http_url(address: &str) -> Result<Url, String> {
    let url = Url::parse(address.trim()).map_err(|_| format!("{address:?} isn't a web address"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only http and https addresses can be read".into());
    }
    if url.host().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err(format!("{address:?} isn't a plain web address"));
    }
    Ok(url)
}

/// Whether an address is on the public internet, not this machine or its network.
fn is_public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => {
            let [a, b, ..] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
                || ip.is_multicast()
                || a == 0
                || a >= 240
                || (a == 100 && (64..128).contains(&b))
                || (a == 192 && b == 0 && ip.octets()[2] == 0)
                || (a == 198 && (18..20).contains(&b)))
        }
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return is_public(IpAddr::V4(mapped));
            }
            let segments = ip.segments();
            // NAT64 carries an IPv4 destination in its last 32 bits; on an
            // IPv6-only network every IPv4 site is reached this way.
            if segments[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
                let [a, b] = segments[6].to_be_bytes();
                let [c, d] = segments[7].to_be_bytes();
                return is_public(IpAddr::V4(std::net::Ipv4Addr::new(a, b, c, d)));
            }
            // Otherwise global unicast (2000::/3) only, which leaves out loopback,
            // unique-local, link-local, site-local and multicast. Documentation
            // space and the 6to4 and Teredo tunnels, which wrap other addresses,
            // are inside that range and refused too.
            segments[0] & 0xe000 == 0x2000
                && segments[0] != 0x2002
                && !(segments[0] == 0x2001 && (segments[1] == 0 || segments[1] == 0x0db8))
        }
    }
}

#[derive(Clone, Copy)]
pub struct Fetcher {
    /// Tests serve from loopback; the app never sets this.
    allow_local: bool,
}

pub const PUBLIC: Fetcher = Fetcher { allow_local: false };

impl Fetcher {
    /// Resolves the host once and refuses anything off the public internet.
    /// Returns the address to pin the connection to, so a second DNS answer
    /// can't send the request somewhere that wasn't checked.
    async fn checked_address(&self, url: &Url) -> Result<Option<(String, SocketAddr)>, FetchError> {
        let refused = || FetchError::Other("ChatGSD only reads public web addresses".into());
        let port = url.port_or_known_default().unwrap_or(443);
        match url.host() {
            Some(Host::Domain(domain)) => {
                let addresses: Vec<SocketAddr> = tokio::net::lookup_host((domain, port))
                    .await
                    .map_err(|_| FetchError::Other(format!("Couldn't find {domain}")))?
                    .collect();
                if !self.allow_local && !addresses.iter().all(|address| is_public(address.ip())) {
                    return Err(refused());
                }
                match addresses.first() {
                    Some(address) => Ok(Some((domain.to_owned(), *address))),
                    None => Err(FetchError::Other(format!("Couldn't find {domain}"))),
                }
            }
            Some(Host::Ipv4(ip)) if self.allow_local || is_public(IpAddr::V4(ip)) => Ok(None),
            Some(Host::Ipv6(ip)) if self.allow_local || is_public(IpAddr::V6(ip)) => Ok(None),
            _ => Err(refused()),
        }
    }

    /// GETs `address`, following up to five redirects, and reads at most
    /// `max_bytes` of the body.
    pub async fn get(&self, address: &str, accept: &str, max_bytes: usize) -> Result<Fetched, FetchError> {
        let mut url = http_url(address).map_err(FetchError::Other)?;
        for _ in 0..=MAX_REDIRECTS {
            let host = url.host_str().unwrap_or_default().to_owned();
            let unreachable = || FetchError::Other(format!("Couldn't reach {host}"));
            // No proxy: one would resolve the host itself, past the address pinned below.
            let mut client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(TIMEOUT)
                .user_agent(USER_AGENT);
            if let Some((domain, pinned)) = self.checked_address(&url).await? {
                client = client.resolve(&domain, pinned);
            }
            let mut response = client
                .build()
                .map_err(|_| unreachable())?
                .get(url.clone())
                .header(reqwest::header::ACCEPT, accept)
                .send()
                .await
                .map_err(|_| unreachable())?;
            let status = response.status();
            if status.is_redirection() {
                let next = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|location| location.to_str().ok())
                    .and_then(|location| url.join(location).ok())
                    .ok_or_else(|| FetchError::Other(format!("{host} sent a redirect to nowhere")))?;
                url = http_url(next.as_str()).map_err(FetchError::Other)?;
                continue;
            }
            if !status.is_success() {
                return Err(FetchError::Status(host, status.as_u16()));
            }
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(';').next())
                .map(|value| value.trim().to_ascii_lowercase())
                .unwrap_or_default();
            let mut bytes = Vec::new();
            let mut truncated = false;
            while let Some(chunk) = response.chunk().await.map_err(|_| unreachable())? {
                let room = max_bytes - bytes.len();
                if chunk.len() > room {
                    bytes.extend_from_slice(&chunk[..room]);
                    truncated = true;
                    break;
                }
                bytes.extend_from_slice(&chunk);
            }
            return Ok(Fetched { url, content_type, bytes, truncated });
        }
        Err(FetchError::Other("That address redirects too many times".into()))
    }
}

pub struct Page {
    pub url: Url,
    pub title: Option<String>,
    pub markdown: String,
    pub truncated: bool,
}

/// The pages one research call has read. Paging through a long page reads the
/// copy kept here, so its line numbers hold still between reads. Each call
/// starts with none: a page read for an earlier question is never passed off
/// as current.
#[derive(Default)]
pub struct Pages(Vec<(String, Page)>);

static TITLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<title[^>]*>(.*?)</title>").expect("title pattern"));
static BLANK_RUNS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n{3,}").expect("blank line pattern"));

/// The page's readable content as markdown, without scripts, styles and site chrome.
fn html_to_markdown(html: &str) -> Result<(Option<String>, String), String> {
    let title = TITLE
        .captures(html)
        .map(|found| found[1].split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|title| !title.is_empty());
    let markdown = htmd::HtmlToMarkdown::builder()
        .skip_tags(vec![
            "head", "script", "style", "noscript", "template", "svg", "iframe", "nav", "footer",
        ])
        .build()
        .convert(html)
        .map_err(|_| "That page couldn't be read as HTML".to_owned())?;
    Ok((title, BLANK_RUNS.replace_all(markdown.trim(), "\n\n").into_owned()))
}

fn fold_long_lines(text: String) -> String {
    if text.lines().all(|line| line.len() <= MAX_LINE_CHARS) {
        return text;
    }
    let mut folded = String::with_capacity(text.len() + text.len() / MAX_LINE_CHARS);
    for line in text.lines() {
        let mut count = 0;
        for character in line.chars() {
            if count == MAX_LINE_CHARS {
                folded.push('\n');
                count = 0;
            }
            folded.push(character);
            count += 1;
        }
        folded.push('\n');
    }
    folded
}

impl Pages {
    async fn read(&mut self, fetcher: Fetcher, address: &str) -> Result<&Page, String> {
        let key = http_url(address)?.to_string();
        if let Some(index) = self.0.iter().position(|(read, _)| *read == key) {
            return Ok(&self.0[index].1);
        }
        let page = fetch_page(fetcher, &key).await?;
        self.0.push((key, page));
        Ok(&self.0[self.0.len() - 1].1)
    }
}

async fn fetch_page(fetcher: Fetcher, key: &str) -> Result<Page, String> {
    let fetched = fetcher
        .get(key, PAGE_ACCEPT, MAX_PAGE_BYTES)
        .await
        .map_err(|error| error.to_string())?;
    let text = String::from_utf8_lossy(&fetched.bytes).into_owned();
    let opening: String = text.trim_start().chars().take(15).collect::<String>().to_ascii_lowercase();
    let is_html = matches!(fetched.content_type.as_str(), "text/html" | "application/xhtml+xml")
        || (fetched.content_type.is_empty()
            && (opening.starts_with("<!doctype html") || opening.starts_with("<html")));
    let readable = fetched.content_type.is_empty()
        || fetched.content_type.starts_with("text/")
        || fetched.content_type.ends_with("json")
        || fetched.content_type.ends_with("xml");
    let (title, markdown) = if is_html {
        // html5ever's tree isn't Send; convert on a blocking thread.
        tauri::async_runtime::spawn_blocking(move || html_to_markdown(&text))
            .await
            .map_err(|_| "That page couldn't be read".to_owned())??
    } else if readable {
        (None, text)
    } else {
        return Err(format!(
            "That address is a {} file, which can't be read as text",
            fetched.content_type
        ));
    };
    Ok(Page {
        url: fetched.url,
        title,
        markdown: fold_long_lines(markdown),
        truncated: fetched.truncated,
    })
}

/// The researcher's `web_fetch`: one page as markdown, whole when short and
/// otherwise paged by line. Also returns the address read, after redirects.
pub async fn fetch_tool(fetcher: Fetcher, pages: &mut Pages, args: &Value) -> (ToolOutput, Option<Url>) {
    let Some(address) = args.get("url").and_then(Value::as_str) else {
        return (ToolOutput::error("url must be a string"), None);
    };
    let line = |key: &str| {
        args.get(key)
            .and_then(Value::as_u64)
            .filter(|line| *line > 0)
            .map(|line| line as usize)
    };
    match pages.read(fetcher, address).await {
        Ok(page) => {
            let title = page
                .title
                .as_deref()
                .map(|title| format!("Title: {title}\n"))
                .unwrap_or_default();
            let cut = if page.truncated {
                "\n\n[The page was longer than ChatGSD reads; the rest is missing.]"
            } else {
                ""
            };
            let view = reading::view_of(&reading::PAGE, &page.markdown, line("start_line"), line("end_line"));
            (
                ToolOutput::ok(format!("URL: {}\n{title}---\n{view}{cut}", page.url)),
                Some(page.url.clone()),
            )
        }
        Err(error) => (ToolOutput::error(error), None),
    }
}

/// One skill a site lists in its discovery index.
#[derive(Clone, Debug, PartialEq)]
pub struct SkillEntry {
    pub name: String,
    pub description: String,
    /// Absolute address of its `SKILL.md`, or of the archive that holds it.
    pub url: String,
    /// `sha256:<hex>` of that download, when the index gives one (v0.2.0 always does).
    pub digest: Option<String>,
}

/// Each site's index, by the address it was looked for under, for the life of
/// the app; skills change rarely. Emptied when full rather than left to grow.
static INDEXES: LazyLock<Mutex<HashMap<String, Arc<Vec<SkillEntry>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const MAX_CACHED_INDEXES: usize = 200;
/// The spec's limit for a description; longer ones are cut, not trusted.
const MAX_DESCRIPTION_CHARS: usize = 1024;

fn valid_digest(digest: &str) -> bool {
    digest.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64 && hex.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// The skills in an index. An index with a schema this version doesn't know
/// is not processed, as the RFC asks, and neither is an entry of unknown type.
fn parse_index(index_url: &Url, json: &str) -> Vec<SkillEntry> {
    let Ok(index) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    let versioned = match index.get("$schema") {
        Some(schema) if schema == SCHEMA_0_2 => true,
        Some(_) => return Vec::new(),
        None => false,
    };
    let text = |entry: &Value, key: &str| {
        entry.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_owned()
    };
    index
        .get("skills")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| {
            let name = text(entry, "name");
            let description: String =
                text(entry, "description").chars().take(MAX_DESCRIPTION_CHARS).collect();
            if !skills::valid_name(&name) || description.is_empty() {
                return None;
            }
            let (address, digest) = if versioned {
                // Some publishers leave the required digest out. Such a skill is
                // offered unverified, like a v0.1.0 one; a malformed digest is not.
                let digest = match entry.get("digest") {
                    None | Some(Value::Null) => None,
                    Some(digest) => Some(digest.as_str().filter(|digest| valid_digest(digest))?.to_owned()),
                };
                if !matches!(text(entry, "type").as_str(), "skill-md" | "archive") {
                    return None;
                }
                (text(entry, "url"), digest)
            } else {
                let has_skill = entry
                    .get("files")
                    .and_then(Value::as_array)
                    .is_some_and(|files| files.iter().any(|file| file == "SKILL.md"));
                if !has_skill {
                    return None;
                }
                (format!("{name}/SKILL.md"), None)
            };
            let url = http_url(index_url.join(&address).ok()?.as_str()).ok()?;
            Some(SkillEntry { name, description, url: url.into(), digest })
        })
        .take(MAX_INDEX_SKILLS)
        .collect()
}

/// Where a site's index may live: its root, as the RFC says, then the first
/// path segment when that looks like a directory. A page's last base is the
/// most specific place its site's skills could be listed.
pub fn index_bases(url: &Url) -> Vec<Url> {
    let Ok(root) = url.join("/") else {
        return Vec::new();
    };
    let mut segments = url.path_segments().into_iter().flatten();
    let first = segments.next().unwrap_or_default();
    let is_directory = segments.next().is_some() || !first.contains('.');
    let under_path = (!first.is_empty() && is_directory)
        .then(|| root.join(&format!("{first}/")).ok())
        .flatten();
    std::iter::once(root).chain(under_path).collect()
}

/// The skills published by the site `url` belongs to; empty when it has none.
pub async fn discover(fetcher: Fetcher, url: &Url) -> Arc<Vec<SkillEntry>> {
    for base in index_bases(url) {
        let cached = INDEXES
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(base.as_str())
            .cloned();
        let entries = match cached {
            Some(entries) => entries,
            None => {
                let mut entries = Vec::new();
                // A site that answers is settled; one that couldn't be reached is asked again later.
                let mut settled = true;
                for path in INDEX_PATHS {
                    let Ok(index_url) = base.join(path) else { continue };
                    let fetched = tokio::time::timeout(
                        DISCOVERY_TIMEOUT,
                        fetcher.get(index_url.as_str(), "application/json", MAX_INDEX_BYTES),
                    )
                    .await;
                    match fetched {
                        Ok(Ok(index)) if !index.truncated => {
                            entries = parse_index(&index.url, &String::from_utf8_lossy(&index.bytes));
                            if !entries.is_empty() {
                                break;
                            }
                        }
                        Ok(Ok(_)) | Ok(Err(FetchError::Status(..))) => {}
                        Ok(Err(FetchError::Other(_))) | Err(_) => settled = false,
                    }
                }
                let entries = Arc::new(entries);
                if settled || !entries.is_empty() {
                    let mut indexes = INDEXES.lock().unwrap_or_else(|error| error.into_inner());
                    if indexes.len() >= MAX_CACHED_INDEXES {
                        indexes.clear();
                    }
                    indexes.insert(base.into(), entries.clone());
                }
                entries
            }
        };
        if !entries.is_empty() {
            return entries;
        }
    }
    Arc::default()
}

/// Every digest a discovered index gave for the skill at `address`, for when
/// only the address is known (the agent offering a listed skill). The download
/// must match one of them, so a second site listing the same address with a
/// different digest can't make a correctly published skill fail.
pub fn listed_digests(address: &str) -> Vec<String> {
    let indexes = INDEXES.lock().unwrap_or_else(|error| error.into_inner());
    let mut digests: Vec<String> = indexes
        .values()
        .flat_map(|entries| entries.iter())
        .filter(|entry| entry.url == address)
        .filter_map(|entry| entry.digest.clone())
        .collect();
    digests.sort();
    digests.dedup();
    digests
}

#[cfg(test)]
pub mod testing {
    use super::Fetcher;

    pub const LOCAL: Fetcher = Fetcher { allow_local: true };

    pub struct Route {
        pub path: &'static str,
        pub status: u16,
        pub content_type: &'static str,
        pub location: Option<&'static str>,
        pub body: Vec<u8>,
    }

    pub fn page(path: &'static str, content_type: &'static str, body: impl Into<Vec<u8>>) -> Route {
        Route { path, status: 200, content_type, location: None, body: body.into() }
    }

    /// Serves `routes` from loopback for the rest of the test process and
    /// returns the site's base address. Unknown paths answer 404. A body's
    /// `{visit}` becomes the number of times its path has been requested, for
    /// pages that change between reads.
    pub fn serve(routes: Vec<Route>) -> String {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr().to_ip().unwrap());
        std::thread::spawn(move || {
            let mut visits = std::collections::HashMap::new();
            for request in server.incoming_requests() {
                let path = request.url().split('?').next().unwrap_or_default().to_owned();
                let Some(route) = routes.iter().find(|route| route.path == path) else {
                    let _ = request.respond(tiny_http::Response::empty(404));
                    continue;
                };
                let visit: &mut usize = visits.entry(route.path).or_default();
                *visit += 1;
                let body = match std::str::from_utf8(&route.body) {
                    Ok(text) if text.contains("{visit}") => text.replace("{visit}", &visit.to_string()).into_bytes(),
                    _ => route.body.clone(),
                };
                let mut response = tiny_http::Response::from_data(body)
                    .with_status_code(route.status)
                    .with_header(
                        tiny_http::Header::from_bytes("Content-Type", route.content_type).unwrap(),
                    );
                if let Some(location) = route.location {
                    response.add_header(tiny_http::Header::from_bytes("Location", location).unwrap());
                }
                let _ = request.respond(response);
            }
        });
        base
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{page, serve, Route, LOCAL};
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};

    const SKILL: &str = "---\nname: trip-planning\ndescription: Plan trips day by day.\n---\n\n# Trip planning\n";

    #[tokio::test]
    async fn only_public_http_addresses_are_requested() {
        for address in [
            "http://127.0.0.1:9/",
            "http://localhost:9/",
            "http://[::1]:9/",
            "http://169.254.169.254/latest/meta-data/",
            "http://192.168.1.1/",
            "http://[::ffff:10.0.0.1]/",
            "file:///etc/passwd",
            "ftp://example.com/",
            "https://user:secret@example.com/",
        ] {
            assert!(
                PUBLIC.get(address, "*/*", 1000).await.is_err(),
                "{address} must be refused"
            );
        }
        assert!(is_public("93.184.216.34".parse().unwrap()));
        assert!(is_public("2606:2800:220:1:248:1893:25c8:1946".parse().unwrap()));
        assert!(!is_public("100.64.0.1".parse().unwrap()));
        for inside in [
            "fd00::1",              // unique-local
            "fe80::1",              // link-local
            "fec0::1",              // site-local
            "64:ff9b::a00:1",       // NAT64 for 10.0.0.1
            "64:ff9b:1::a00:1",     // local-use NAT64
            "2002:a00:1::1",        // 6to4 for 10.0.0.1
            "2001:0:4136:e378::1",  // Teredo
            "2001:db8::1",          // documentation
            "::a00:1",              // IPv4-compatible
        ] {
            assert!(!is_public(inside.parse().unwrap()), "{inside} is not a public address");
        }
        assert!(
            is_public("64:ff9b::5db8:d822".parse().unwrap()),
            "NAT64 for a public IPv4 address is how IPv6-only networks reach it"
        );
    }

    #[tokio::test]
    async fn pages_become_markdown_without_site_chrome_and_follow_redirects() {
        let html = "<html><head><title>Rail  passes</title><style>p{}</style></head><body>\
            <nav><a href=\"/home\">Home</a></nav><h1>Rail passes</h1>\
            <p>Buy a <a href=\"/passes/day\">day pass</a>.</p><script>track()</script>\
            <footer>Legal</footer></body></html>";
        let base = serve(vec![
            Route { path: "/old", status: 302, content_type: "text/plain", location: Some("/passes"), body: vec![] },
            page("/passes", "text/html; charset=utf-8", html),
            Route { path: "/away", status: 302, content_type: "text/plain", location: Some("file:///etc/passwd"), body: vec![] },
            page("/photo", "image/png", vec![0x89, b'P', b'N', b'G']),
            page("/big", "text/plain", "x".repeat(MAX_PAGE_BYTES + 10)),
        ]);
        let mut pages = Pages::default();
        let (output, url) = fetch_tool(LOCAL, &mut pages, &json!({"url": format!("{base}/old")})).await;
        assert!(output.ok, "{}", output.text);
        assert_eq!(url.unwrap().path(), "/passes", "the address read is the redirect's target");
        assert!(output.text.contains("Title: Rail passes\n"));
        assert!(output.text.contains("# Rail passes"));
        assert!(output.text.contains("[day pass](/passes/day)"));
        for chrome in ["track()", "Home", "Legal", "p{}"] {
            assert!(!output.text.contains(chrome), "{chrome} should be dropped");
        }

        assert!(!fetch_tool(LOCAL, &mut pages, &json!({"url": format!("{base}/away")})).await.0.ok);
        assert!(!fetch_tool(LOCAL, &mut pages, &json!({"url": format!("{base}/missing")})).await.0.ok);
        let photo = fetch_tool(LOCAL, &mut pages, &json!({"url": format!("{base}/photo")})).await.0;
        assert!(!photo.ok && photo.text.contains("image/png"));
        let big = fetch_tool(LOCAL, &mut pages, &json!({"url": format!("{base}/big")})).await.0;
        assert!(big.ok && big.text.contains("the rest is missing"));
    }

    #[tokio::test]
    async fn a_later_research_reads_a_changed_page_afresh() {
        let base = serve(vec![page("/rates", "text/plain", "Rate as of visit {visit}")]);
        let rates = json!({"url": format!("{base}/rates")});
        let mut first_call = Pages::default();
        let first = fetch_tool(LOCAL, &mut first_call, &rates).await.0.text;
        assert!(first.ends_with("Rate as of visit 1"), "{first}");
        let paged = json!({"url": format!("{base}/rates"), "start_line": 1, "end_line": 1});
        let again = fetch_tool(LOCAL, &mut first_call, &paged).await.0.text;
        assert!(again.ends_with("Rate as of visit 1"), "paging within a call reads the same copy: {again}");

        let later = fetch_tool(LOCAL, &mut Pages::default(), &rates).await.0.text;
        assert!(later.ends_with("Rate as of visit 2"), "{later}");
    }

    #[test]
    fn an_index_yields_only_verifiable_skills_of_known_types() {
        let index_url = Url::parse("https://docs.example.com/.well-known/agent-skills/index.json").unwrap();
        let digest = format!("sha256:{}", "a".repeat(64));
        let index = json!({
            "$schema": SCHEMA_0_2,
            "skills": [
                {"name": "trip-planning", "type": "skill-md", "description": "Plan trips.", "url": "trip-planning/SKILL.md", "digest": digest},
                {"name": "cdn-hosted", "type": "skill-md", "description": "Elsewhere.", "url": "https://cdn.example.com/s/SKILL.md", "digest": digest},
                {"name": "bundled", "type": "archive", "description": "Has references.", "url": "/bundled.tar.gz", "digest": digest},
                {"name": "newer-kind", "type": "plugin", "description": "Unknown type.", "url": "/z/plugin.bin", "digest": digest},
                {"name": "no-digest", "type": "skill-md", "description": "Nothing to verify against.", "url": "/x/SKILL.md", "digest": null},
                {"name": "bad-digest", "type": "skill-md", "description": "Unverifiable.", "url": "/w/SKILL.md", "digest": "sha256:abc"},
                {"name": "Bad Name", "type": "skill-md", "description": "Invalid.", "url": "/y/SKILL.md", "digest": digest},
                {"name": "local-file", "type": "skill-md", "description": "Not http.", "url": "file:///etc/passwd", "digest": digest},
            ]
        });
        let entries = parse_index(&index_url, &index.to_string());
        assert_eq!(
            entries.iter().map(|entry| entry.url.as_str()).collect::<Vec<_>>(),
            [
                "https://docs.example.com/.well-known/agent-skills/trip-planning/SKILL.md",
                "https://cdn.example.com/s/SKILL.md",
                "https://docs.example.com/bundled.tar.gz",
                "https://docs.example.com/x/SKILL.md",
            ]
        );

        let unknown = json!({"$schema": "https://schemas.agentskills.io/discovery/9.0.0/schema.json", "skills": index["skills"]});
        assert!(parse_index(&index_url, &unknown.to_string()).is_empty());

        let legacy_url = Url::parse("https://docs.example.com/.well-known/skills/index.json").unwrap();
        let legacy = json!({"skills": [
            {"name": "trip-planning", "description": "Plan trips.", "files": ["SKILL.md", "references/a.md"]},
            {"name": "no-files", "description": "Nothing to fetch."},
        ]});
        let entries = parse_index(&legacy_url, &legacy.to_string());
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].url, "https://docs.example.com/.well-known/skills/trip-planning/SKILL.md");
        assert_eq!(entries[0].digest, None);
    }

    #[tokio::test]
    async fn a_sites_skills_are_offered_only_when_they_match_its_digest() {
        let digest = |content: &str| format!("sha256:{:x}", Sha256::digest(content));
        let index = json!({"$schema": SCHEMA_0_2, "skills": [
            {"name": "trip-planning", "type": "skill-md", "description": "Plan trips.", "url": "/.well-known/agent-skills/trip-planning/SKILL.md", "digest": digest(SKILL)},
            {"name": "tampered", "type": "skill-md", "description": "Changed after publishing.", "url": "/.well-known/agent-skills/tampered/SKILL.md", "digest": digest("what was published")},
        ]});
        let base = serve(vec![
            page("/.well-known/agent-skills/index.json", "application/json", index.to_string()),
            page("/.well-known/agent-skills/trip-planning/SKILL.md", "text/markdown", SKILL),
            page("/.well-known/agent-skills/tampered/SKILL.md", "text/markdown", SKILL.replace("trip-planning", "tampered")),
            page("/docs", "text/html", "<h1>Docs</h1>"),
        ]);
        let docs = Url::parse(&format!("{base}/docs")).unwrap();
        let entries = discover(LOCAL, &docs).await;
        assert_eq!(entries.len(), 2);

        let offers = skills::find_offers(LOCAL, docs.as_str()).await.unwrap();
        assert_eq!(offers.len(), 1, "the tampered skill is not offered");
        assert_eq!(offers[0].name, "trip-planning");
        assert_eq!(offers[0].content, SKILL);
        let published = entries[1].digest.as_slice();
        let tampered = skills::fetch_offer(LOCAL, &entries[1].url, published).await.err().unwrap();
        assert!(tampered.contains("digest"), "{tampered}");

        // Another site listing the first one's skill under a wrong digest
        // doesn't stop that skill being offered, by its site or by address.
        let skill_url = entries[0].url.clone();
        let wrong = json!({"$schema": SCHEMA_0_2, "skills": [
            {"name": "trip-planning", "type": "skill-md", "description": "Not ours.", "url": skill_url, "digest": digest("something else")},
        ]});
        let rival = serve(vec![page("/.well-known/agent-skills/index.json", "application/json", wrong.to_string())]);
        let rival_entries = discover(LOCAL, &Url::parse(&rival).unwrap()).await;
        assert_eq!(rival_entries.len(), 1);
        assert_eq!(skills::find_offers(LOCAL, docs.as_str()).await.unwrap().len(), 1);
        let listed = listed_digests(&skill_url);
        assert_eq!(listed.len(), 2);
        assert!(skills::fetch_offer(LOCAL, &skill_url, &listed).await.is_ok());
        assert!(skills::find_offers(LOCAL, &rival).await.is_err(), "the rival's own listing still fails its digest");

        let bare = serve(vec![page("/docs", "text/html", "<h1>Docs</h1>")]);
        let bare_docs = Url::parse(&format!("{bare}/docs")).unwrap();
        assert!(discover(LOCAL, &bare_docs).await.is_empty());
        assert!(skills::find_offers(LOCAL, bare_docs.as_str()).await.is_err());

        // Documentation served under a path keeps its index there, in the older format.
        let legacy = json!({"skills": [{"name": "trip-planning", "description": "Plan trips.", "files": ["SKILL.md"]}]});
        let hosted = serve(vec![
            page("/docs/.well-known/skills/index.json", "application/json", legacy.to_string()),
            page("/docs/.well-known/skills/trip-planning/SKILL.md", "text/markdown", SKILL),
        ]);
        let quickstart = Url::parse(&format!("{hosted}/docs/quickstart")).unwrap();
        let offers = skills::find_offers(LOCAL, quickstart.as_str()).await.unwrap();
        assert_eq!(offers[0].source, format!("{hosted}/docs/.well-known/skills/trip-planning/SKILL.md"));
        let page_url = Url::parse("https://example.com/index.html").unwrap();
        assert_eq!(index_bases(&page_url).len(), 1, "a file at the root is not a directory");
    }
}

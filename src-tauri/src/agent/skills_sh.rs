//! skills.sh, the public directory of Agent Skills, browsed from the settings page.
//!
//! Three of its endpoints are read, all through `web::Fetcher`:
//! - `/api/skills/{all-time|trending|hot}/{page}`: a leaderboard, a page at a time.
//! - `/api/search?q=…&limit=…`: the skills matching a query.
//! - `/api/download/{owner}/{repo}/{skill}`: the text files of one skill kept
//!   in a GitHub repository.
//!
//! What it lists is as untrusted as any other page. An entry is shown only
//! when its fields have the expected shape, and a skill from it goes through
//! the same checks and the same review card as one found anywhere else.
use super::web;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

pub const SITE: &str = "https://skills.sh";
const HOSTS: [&str; 2] = ["skills.sh", "www.skills.sh"];
/// The path its pages for a site's own skills sit under: `/site/<domain>/<skill>`.
const SITE_PAGES: &str = "site";
const MAX_LISTING_BYTES: usize = 1_000_000;
const MAX_SNAPSHOT_BYTES: usize = 5_000_000;
const MIN_QUERY_CHARS: usize = 2;
const SEARCH_LIMIT: &str = "100";
const MAX_FIELD_CHARS: usize = 200;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum View {
    AllTime,
    Trending,
    Hot,
}

impl View {
    fn slug(self) -> &'static str {
        match self {
            Self::AllTime => "all-time",
            Self::Trending => "trending",
            Self::Hot => "hot",
        }
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    /// `owner/repo` on GitHub, or the domain of a site that publishes its own skills.
    pub source: String,
    pub installs: u64,
    pub official: bool,
    /// Its page on skills.sh, which is also the address it is added by.
    pub url: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub skills: Vec<Entry>,
    pub has_more: bool,
}

/// Where the skill on a skills.sh page is kept.
#[derive(Debug, PartialEq)]
pub enum Home {
    /// In a GitHub repository; skills.sh serves its files from this address.
    Snapshot(Url),
    /// On a site that lists it in its own discovery index.
    Site { domain: String, name: String },
}

/// One segment of a source: a GitHub owner or repository, or a domain.
fn valid_part(part: &str) -> bool {
    !part.is_empty()
        && part.len() <= MAX_FIELD_CHARS
        && !part.starts_with('.')
        && part
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

/// The address of a skill's page. `None` for a source of a shape skills.sh
/// isn't known to use, which is then left out of a listing.
fn page(site: &Url, source: &str, skill: &str) -> Option<Url> {
    let parts: Vec<&str> = source.split('/').collect();
    let known = match parts.as_slice() {
        [domain] => domain.contains('.'),
        [_, _] => true,
        _ => false,
    };
    if !known || !parts.iter().all(|part| valid_part(part)) || skill.is_empty() {
        return None;
    }
    let mut url = site.clone();
    {
        let mut segments = url.path_segments_mut().ok()?;
        segments.clear();
        if parts.len() == 1 {
            segments.push(SITE_PAGES);
        }
        segments.extend(&parts).push(skill);
    }
    Some(url)
}

/// Where the skill on `page` is kept; `None` when it isn't a skills.sh skill page.
pub fn home(page: &Url) -> Option<Home> {
    if !page.host_str().is_some_and(|host| HOSTS.contains(&host)) {
        return None;
    }
    let decoded: Vec<String> = page
        .path_segments()?
        .filter(|segment| !segment.is_empty())
        .map(|segment| urlencoding::decode(segment).map(|text| text.into_owned()))
        .collect::<Result<_, _>>()
        .ok()?;
    match decoded.as_slice() {
        [pages, domain, name] if pages == SITE_PAGES && valid_part(domain) => Some(Home::Site {
            domain: domain.clone(),
            name: name.clone(),
        }),
        [owner, repo, skill] if valid_part(owner) && valid_part(repo) => {
            let mut download = page.clone();
            download.set_query(None);
            download.set_fragment(None);
            download
                .path_segments_mut()
                .ok()?
                .clear()
                .extend(["api", "download", owner.as_str(), repo.as_str(), skill.as_str()]);
            Some(Home::Snapshot(download))
        }
        _ => None,
    }
}

fn parse_listing(site: &Url, json: &str) -> Result<Listing, String> {
    let listing: Value = serde_json::from_str(json)
        .map_err(|_| "skills.sh sent a list ChatGSD couldn't read".to_owned())?;
    let text = |entry: &Value, key: &str| -> String {
        entry
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .chars()
            .take(MAX_FIELD_CHARS)
            .collect()
    };
    let skills = listing
        .get("skills")
        .and_then(Value::as_array)
        .ok_or("skills.sh sent a list ChatGSD couldn't read")?
        .iter()
        .filter_map(|entry| {
            let source = text(entry, "source");
            let name = text(entry, "name");
            let url = page(site, &source, &text(entry, "skillId"))?;
            Some(Entry {
                name: if name.is_empty() { text(entry, "skillId") } else { name },
                source,
                installs: entry.get("installs").and_then(Value::as_u64).unwrap_or_default(),
                official: entry.get("isOfficial").and_then(Value::as_bool).unwrap_or_default(),
                url: url.into(),
            })
        })
        .collect();
    Ok(Listing {
        skills,
        has_more: listing.get("hasMore").and_then(Value::as_bool).unwrap_or_default(),
    })
}

/// One page of a leaderboard, or the skills matching `query` when it is long
/// enough to search for. A search comes back whole, so it never has more.
pub async fn browse(
    fetcher: web::Fetcher,
    site: &str,
    query: &str,
    view: View,
    page: u32,
) -> Result<Listing, String> {
    let site = web::http_url(site)?;
    let mut url = site.clone();
    let query = query.trim();
    if query.chars().count() >= MIN_QUERY_CHARS {
        url.set_path("/api/search");
        url.query_pairs_mut().append_pair("q", query).append_pair("limit", SEARCH_LIMIT);
    } else {
        url.set_path(&format!("/api/skills/{}/{page}", view.slug()));
    }
    let fetched = fetcher
        .get(url.as_str(), "application/json", MAX_LISTING_BYTES)
        .await
        .map_err(|error| error.to_string())?;
    if fetched.truncated {
        return Err("skills.sh sent a longer list than ChatGSD reads".into());
    }
    parse_listing(&site, &String::from_utf8_lossy(&fetched.bytes))
}

/// A skill's text files as skills.sh serves them, each by its path within the skill.
pub async fn snapshot(fetcher: web::Fetcher, download: &Url) -> Result<Vec<(String, String)>, String> {
    let fetched = fetcher
        .get(download.as_str(), "application/json", MAX_SNAPSHOT_BYTES)
        .await
        .map_err(|error| match error {
            web::FetchError::Status(_, 404) => "skills.sh has no copy of this skill to add".to_owned(),
            other => other.to_string(),
        })?;
    if fetched.truncated {
        return Err(format!(
            "This skill is larger than {} MB",
            MAX_SNAPSHOT_BYTES / 1_000_000
        ));
    }
    #[derive(Deserialize)]
    struct File {
        path: String,
        contents: String,
    }
    #[derive(Deserialize)]
    struct Snapshot {
        files: Vec<File>,
    }
    let snapshot: Snapshot = serde_json::from_slice(&fetched.bytes)
        .map_err(|_| "skills.sh sent something that isn't a skill".to_owned())?;
    Ok(snapshot.files.into_iter().map(|file| (file.path, file.contents)).collect())
}

#[tauri::command]
pub async fn agent_browse_skills(query: String, view: View, page: u32) -> Result<Listing, String> {
    browse(web::PUBLIC, SITE, &query, view, page).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::web::testing::{page as route, serve, LOCAL};
    use serde_json::json;

    fn site() -> Url {
        Url::parse(SITE).unwrap()
    }

    #[test]
    fn a_listing_keeps_only_entries_that_lead_to_a_skill_page() {
        let listing = json!({"hasMore": true, "skills": [
            {"source": "acme/skills", "skillId": "trip-planning", "name": "trip-planning", "installs": 1200, "isOfficial": true},
            {"source": "docs.example.com", "skillId": "rail", "name": "rail", "installs": 7},
            {"source": "acme/skills", "skillId": "odd::name", "name": "odd::name"},
            {"source": "../../etc", "skillId": "escape", "name": "escape"},
            {"source": "a/b/c", "skillId": "deep", "name": "deep"},
            {"source": "no-dot", "skillId": "bare", "name": "bare"},
            {"source": "acme/skills", "name": "no-id"},
            "not an entry",
        ]});
        let parsed = parse_listing(&site(), &listing.to_string()).unwrap();
        assert!(parsed.has_more);
        assert_eq!(
            parsed.skills.iter().map(|entry| entry.url.as_str()).collect::<Vec<_>>(),
            [
                "https://skills.sh/acme/skills/trip-planning",
                "https://skills.sh/site/docs.example.com/rail",
                "https://skills.sh/acme/skills/odd::name",
            ]
        );
        assert_eq!((parsed.skills[0].installs, parsed.skills[0].official), (1200, true));
        assert_eq!((parsed.skills[1].installs, parsed.skills[1].official), (7, false));
        assert!(parse_listing(&site(), "<html>").is_err());
        assert!(parse_listing(&site(), "{}").is_err());
    }

    #[test]
    fn a_skill_page_resolves_to_where_the_skill_is_kept() {
        let at = |address: &str| home(&Url::parse(address).unwrap());
        let download = |address: &str| Some(Home::Snapshot(Url::parse(address).unwrap()));
        assert_eq!(
            at("https://www.skills.sh/acme/skills/trip-planning?ref=x#top"),
            download("https://www.skills.sh/api/download/acme/skills/trip-planning")
        );
        // Every listed page leads back to a home, odd names included.
        let odd = page(&site(), "acme/skills", "odd::name").unwrap();
        assert_eq!(home(&odd), download("https://skills.sh/api/download/acme/skills/odd::name"));
        assert_eq!(
            at("https://skills.sh/site/docs.example.com/rail"),
            Some(Home::Site { domain: "docs.example.com".into(), name: "rail".into() })
        );
        for other in [
            "https://skills.sh/",
            "https://skills.sh/acme/skills",
            "https://skills.sh/acme/skills/trip/extra",
            "https://skills.sh/acme/%2e%2e/trip",
            "https://example.com/acme/skills/trip-planning",
        ] {
            assert_eq!(at(other), None, "{other}");
        }
    }

    #[tokio::test]
    async fn a_short_query_browses_the_leaderboard_and_a_longer_one_searches() {
        let board = json!({"hasMore": true, "skills": [{"source": "acme/skills", "skillId": "top", "name": "top", "installs": 9}]});
        let hits = json!({"skills": [{"source": "acme/skills", "skillId": "found", "name": "found", "installs": 1}]});
        let base = serve(vec![
            route("/api/skills/trending/2", "application/json", board.to_string()),
            route("/api/search", "application/json", hits.to_string()),
        ]);
        let listed = browse(LOCAL, &base, " a ", View::Trending, 2).await.unwrap();
        assert_eq!(listed.skills[0].name, "top");
        assert!(listed.has_more);
        let searched = browse(LOCAL, &base, "trip", View::Trending, 0).await.unwrap();
        assert_eq!(searched.skills[0].name, "found");
        assert!(!searched.has_more);
        assert!(browse(LOCAL, &base, "", View::Hot, 0).await.is_err(), "a missing board is an error, not an empty list");
    }

    #[tokio::test]
    async fn a_snapshot_is_the_skills_files_or_a_plain_reason() {
        let files = json!({"hash": "x", "files": [{"path": "SKILL.md", "contents": "text"}, {"path": "references/a.md", "contents": "a"}]});
        let base = serve(vec![
            route("/api/download/acme/skills/trip", "application/json", files.to_string()),
            route("/api/download/acme/skills/broken", "application/json", "{}"),
        ]);
        let at = |path: &str| Url::parse(&format!("{base}{path}")).unwrap();
        assert_eq!(
            snapshot(LOCAL, &at("/api/download/acme/skills/trip")).await.unwrap(),
            [("SKILL.md".to_owned(), "text".to_owned()), ("references/a.md".to_owned(), "a".to_owned())]
        );
        assert!(snapshot(LOCAL, &at("/api/download/acme/skills/broken")).await.is_err());
        let missing = snapshot(LOCAL, &at("/api/download/acme/skills/gone")).await.unwrap_err();
        assert!(missing.contains("no copy"), "{missing}");
    }
}

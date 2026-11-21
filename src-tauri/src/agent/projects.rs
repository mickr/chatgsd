//! Projects: named sets of folders linked from anywhere on this Mac. The
//! folders stay where they are; `projects.json` in app data holds only their
//! paths, so projects apply in every notes folder and are never synced with
//! one. The sidebar browses them, and the agent reads their markdown through
//! `list_projects`, `search_projects`, `read_notes` and `find_in_note`.
//! Nothing here writes to a linked folder.

use super::{tools::ToolOutput, webdav, workspace};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};

const FILE: &str = "projects.json";
/// Starts every project file ID: `project:<name>/<folder label>/<path>`.
pub const ID_PREFIX: &str = "project:";
const MAX_NAME_CHARS: usize = 60;
const MAX_FILES_PER_FOLDER: usize = 5_000;
const MAX_DEPTH: usize = 12;
const MAX_SEARCHED_BYTES: u64 = 1_000_000;
const SEARCH_RESULT_LIMIT: usize = 8;
const MAX_LISTED_NOTES: usize = 100;
const MAX_OUTLINE_FOLDERS: usize = 80;
const MAX_OUTLINE_DEPTH: usize = 3;
const SNIPPET_CHARS: usize = 160;

static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A folder linked into a project. `label` names it in file IDs and stays
/// fixed for as long as the folder is linked.
#[derive(Clone, Serialize, Deserialize)]
pub struct Folder {
    pub label: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<webdav::RemoteConfig>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub folders: Vec<Folder>,
}

#[derive(Clone, Serialize)]
pub struct FolderView {
    label: String,
    path: String,
    /// The folder was moved, deleted, or is on a disconnected drive.
    missing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    remote: Option<webdav::RemoteFolderView>,
}

#[derive(Clone, Serialize)]
pub struct ProjectView {
    id: String,
    name: String,
    folders: Vec<FolderView>,
}

fn views(projects: &[Project]) -> Vec<ProjectView> {
    projects
        .iter()
        .map(|project| ProjectView {
            id: project.id.clone(),
            name: project.name.clone(),
            folders: project
                .folders
                .iter()
                .map(|folder| FolderView {
                    label: folder.label.clone(),
                    path: folder.path.clone(),
                    missing: !Path::new(&folder.path).is_dir(),
                    remote: folder.remote.as_ref().map(webdav::view_for),
                })
                .collect(),
        })
        .collect()
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|error| error.to_string())?.join(FILE))
}

async fn load(path: &Path) -> Result<Vec<Project>, String> {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| format!("Couldn't read the saved projects: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("Couldn't read the saved projects: {error}")),
    }
}

/// Writes beside the file and renames over it.
async fn save(path: &Path, projects: &[Project]) -> Result<(), String> {
    let failed = |error: std::io::Error| format!("Couldn't save the projects: {error}");
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(failed)?;
    }
    let bytes = serde_json::to_vec_pretty(projects).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(&temporary, bytes).await.map_err(failed)?;
    tokio::fs::rename(&temporary, path).await.map_err(failed)
}

async fn read(app: &tauri::AppHandle) -> Result<Vec<Project>, String> {
    let path = store_path(app)?;
    let _guard = LOCK.lock().await;
    load(&path).await
}

/// Loads the projects, applies `change`, saves them and tells the sidebar, as
/// one step. A change that fails saves nothing.
async fn update(
    app: &tauri::AppHandle,
    change: impl FnOnce(&mut Vec<Project>) -> Result<(), String>,
) -> Result<(), String> {
    let path = store_path(app)?;
    let projects = {
        let _guard = LOCK.lock().await;
        let mut projects = load(&path).await?;
        change(&mut projects)?;
        save(&path, &projects).await?;
        projects
    };
    let _ = app.emit("projects:changed", views(&projects));
    Ok(())
}

/// A trimmed name that fits in a file ID and that no other project has.
fn valid_name(projects: &[Project], name: &str, renaming: Option<&str>) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the project a name".into());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("Keep the name under {MAX_NAME_CHARS} characters"));
    }
    if name.chars().any(|c| c == '/' || c == '\\' || c.is_control()) {
        return Err("A project name can't contain slashes".into());
    }
    let taken = projects
        .iter()
        .any(|project| Some(project.id.as_str()) != renaming && project.name.to_lowercase() == name.to_lowercase());
    if taken {
        return Err(format!("There is already a project called {name:?}"));
    }
    Ok(name.to_owned())
}

/// The folder's own name, numbered when the project already has one like it.
fn unique_label(folders: &[Folder], path: &Path) -> String {
    let base = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "folder".to_owned());
    let taken = |label: &str| folders.iter().any(|folder| folder.label.to_lowercase() == label.to_lowercase());
    if !taken(&base) {
        return base;
    }
    (2..)
        .map(|number| format!("{base}-{number}"))
        .find(|label| !taken(label))
        .expect("an unused number exists")
}

fn project_mut<'a>(projects: &'a mut [Project], id: &str) -> Result<&'a mut Project, String> {
    projects
        .iter_mut()
        .find(|project| project.id == id)
        .ok_or_else(|| "This project was removed".to_owned())
}

#[tauri::command]
pub async fn projects_list(app: tauri::AppHandle) -> Result<Vec<ProjectView>, String> {
    Ok(views(&read(&app).await?))
}

#[tauri::command]
pub async fn projects_create(app: tauri::AppHandle, name: String) -> Result<(), String> {
    update(&app, |projects| {
        let name = valid_name(projects, &name, None)?;
        projects.push(Project {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            folders: Vec::new(),
        });
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn projects_rename(app: tauri::AppHandle, id: String, name: String) -> Result<(), String> {
    update(&app, |projects| {
        let name = valid_name(projects, &name, Some(&id))?;
        project_mut(projects, &id)?.name = name;
        Ok(())
    })
    .await
}

/// Forgets the project. Its folders and their files are left as they are.
#[tauri::command]
pub async fn projects_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut removed_remotes = Vec::new();
    update(&app, |projects| {
        if let Some(project) = projects.iter().find(|project| project.id == id) {
            for folder in &project.folders {
                if let Some(remote) = &folder.remote {
                    removed_remotes.push(remote.id.clone());
                }
            }
        }
        projects.retain(|project| project.id != id);
        Ok(())
    })
    .await?;
    for remote_id in removed_remotes {
        webdav::cleanup_remote(&app, &remote_id).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn projects_add_folder(app: tauri::AppHandle, id: String, path: String) -> Result<(), String> {
    let canonical = tokio::fs::canonicalize(&path)
        .await
        .map_err(|_| "This folder can't be found".to_owned())?;
    if !canonical.is_dir() {
        return Err("Choose a folder, not a file".into());
    }
    update(&app, |projects| {
        let project = project_mut(projects, &id)?;
        let path = canonical.to_string_lossy().into_owned();
        if project.folders.iter().any(|folder| folder.path == path) {
            return Err("This folder is already in the project".into());
        }
        let label = unique_label(&project.folders, &canonical);
        project.folders.push(Folder {
            label,
            path,
            remote: None,
        });
        Ok(())
    })
    .await
}

fn unique_label_from_name(folders: &[Folder], raw_base: &str) -> String {
    let base = raw_base
        .trim()
        .replace(['/', '\\'], "-")
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>();
    let base = if base.is_empty() {
        "WebDAV".to_owned()
    } else {
        base
    };
    let taken = |label: &str| {
        folders
            .iter()
            .any(|folder| folder.label.to_lowercase() == label.to_lowercase())
    };
    if !taken(&base) {
        return base;
    }
    (2..)
        .map(|number| format!("{base}-{number}"))
        .find(|label| !taken(label))
        .expect("an unused number exists")
}

/// Connects a WebDAV folder (e.g. Engine Room's `/dav/docs`), mirrors it into
/// a managed local folder inside the project, signs in via OAuth if required,
/// and runs the initial pull.
#[tauri::command]
pub async fn projects_add_webdav_folder(
    app: tauri::AppHandle,
    id: String,
    url: String,
    label: Option<String>,
) -> Result<(), String> {
    let (normalized_url, local) = webdav::normalize_url(&url).await?;
    let remote_id = uuid::Uuid::new_v4().to_string();
    let mirror_dir = webdav::create_mirror_dir(&app, &remote_id).await?;
    let mirror_path = mirror_dir.to_string_lossy().into_owned();

    let remote = webdav::RemoteConfig {
        id: remote_id,
        url: normalized_url.to_string(),
        local,
    };
    let desired_label = label
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| webdav::default_label_for(&normalized_url));

    update(&app, |projects| {
        let project = project_mut(projects, &id)?;
        if project
            .folders
            .iter()
            .any(|f| f.remote.as_ref().is_some_and(|r| r.url == remote.url))
        {
            return Err("This WebDAV folder is already in the project".into());
        }
        let unique = unique_label_from_name(&project.folders, &desired_label);
        project.folders.push(Folder {
            label: unique,
            path: mirror_path,
            remote: Some(remote.clone()),
        });
        Ok(())
    })
    .await?;

    webdav::authorize_and_sync(&app, &remote, &mirror_dir).await
}

#[tauri::command]
pub async fn projects_sync_webdav_folder(
    app: tauri::AppHandle,
    id: String,
    label: String,
) -> Result<(), String> {
    let folder = load_project_folder(&app, &id, &label).await?;
    let remote = folder
        .remote
        .ok_or_else(|| "This folder is not synced via WebDAV".to_owned())?;
    webdav::sync_remote(&app, &remote, Path::new(&folder.path)).await
}

#[tauri::command]
pub async fn projects_authorize_webdav_folder(
    app: tauri::AppHandle,
    id: String,
    label: String,
) -> Result<(), String> {
    let folder = load_project_folder(&app, &id, &label).await?;
    let remote = folder
        .remote
        .ok_or_else(|| "This folder is not synced via WebDAV".to_owned())?;
    webdav::authorize_and_sync(&app, &remote, Path::new(&folder.path)).await
}

async fn load_project_folder(app: &tauri::AppHandle, id: &str, label: &str) -> Result<Folder, String> {
    let projects = read(app).await?;
    projects
        .iter()
        .find(|project| project.id == id)
        .and_then(|project| project.folders.iter().find(|folder| folder.label == label))
        .cloned()
        .ok_or_else(|| "This folder is no longer in the project".to_owned())
}

pub(crate) async fn emit_changed(app: &tauri::AppHandle) {
    if let Ok(projects) = read(app).await {
        let _ = app.emit("projects:changed", views(&projects));
    }
}

pub(crate) async fn find_webdav_for_path(
    app: &tauri::AppHandle,
    canonical: &Path,
) -> Option<(webdav::RemoteConfig, PathBuf)> {
    let projects = read(app).await.ok()?;
    for project in projects {
        for folder in project.folders {
            let Some(remote) = folder.remote else {
                continue;
            };
            let folder_path = PathBuf::from(&folder.path);
            if canonical.starts_with(&folder_path) {
                return Some((remote, folder_path));
            }
        }
    }
    None
}

pub(crate) async fn all_webdav_folders(
    app: &tauri::AppHandle,
) -> Vec<(webdav::RemoteConfig, PathBuf)> {
    let Ok(projects) = read(app).await else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for project in projects {
        for folder in project.folders {
            if let Some(remote) = folder.remote {
                out.push((remote, PathBuf::from(folder.path)));
            }
        }
    }
    out
}

/// Unlinks the folder. The folder and its files are left as they are.
#[tauri::command]
pub async fn projects_remove_folder(app: tauri::AppHandle, id: String, label: String) -> Result<(), String> {
    let mut removed_remote_id = None;
    update(&app, |projects| {
        let project = project_mut(projects, &id)?;
        if let Some(folder) = project.folders.iter().find(|f| f.label == label) {
            removed_remote_id = folder.remote.as_ref().map(|r| r.id.clone());
        }
        project.folders.retain(|folder| folder.label != label);
        Ok(())
    })
    .await?;
    if let Some(remote_id) = removed_remote_id {
        webdav::cleanup_remote(&app, &remote_id).await;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct FileView {
    /// Path relative to the linked folder, without `.md`.
    id: String,
    /// Seconds since the Unix epoch.
    modified: i64,
}

/// The markdown files in one linked folder, for the sidebar's tree and the
/// folder's details.
#[tauri::command]
pub async fn projects_folder_files(app: tauri::AppHandle, id: String, label: String) -> Result<Vec<FileView>, String> {
    let projects = read(&app).await?;
    let folder = projects
        .iter()
        .find(|project| project.id == id)
        .and_then(|project| project.folders.iter().find(|folder| folder.label == label))
        .cloned()
        .ok_or_else(|| "This folder was removed from the project".to_owned())?;
    let ignored = ignored_dirs(&app);
    blocking(move || {
        let files = walk(&root_of(&folder)?, &ignored);
        Ok(files.into_iter().map(|file| FileView { id: file.id, modified: file.modified }).collect())
    })
    .await
}

/// Opens a project file, by its `project:` ID, in its own window, where the
/// agent co-edits it under that ID.
#[tauri::command]
pub async fn projects_open_file(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = note_path(&app, &id).await?;
    crate::open_project_file(&app, &path, &id)
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("Cannot read the project: {error}"))?
}

fn ignored_dirs(app: &tauri::AppHandle) -> Vec<String> {
    let state = app.state::<crate::AppState>();
    let settings = state.settings.read().expect("settings read lock");
    crate::get_effective_ignored_dirs(&settings)
}

fn root_of(folder: &Folder) -> Result<PathBuf, String> {
    std::fs::canonicalize(&folder.path).map_err(|_| {
        format!(
            "The folder {} can't be found. It may have been moved or deleted, or its drive is disconnected.",
            folder.path
        )
    })
}

struct Found {
    /// Path relative to the linked folder, without `.md`.
    id: String,
    path: PathBuf,
    modified: i64,
}

/// A linked folder can be a whole code repository, so hidden directories are
/// skipped along with the ones notes folders already ignore.
fn visible(entry: &walkdir::DirEntry, ignored: &[String]) -> bool {
    let hidden = entry.depth() > 0
        && entry.file_type().is_dir()
        && entry.file_name().to_str().is_some_and(|name| name.starts_with('.'));
    !hidden && crate::is_visible_notes_entry(entry, ignored)
}

/// The markdown files under `root`, which must be canonical, ordered by ID.
fn walk(root: &Path, ignored: &[String]) -> Vec<Found> {
    let mut files: Vec<Found> = walkdir::WalkDir::new(root)
        .max_depth(MAX_DEPTH)
        .into_iter()
        .filter_entry(|entry| visible(entry, ignored))
        .flatten()
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| {
            let id = crate::id_from_abs_path(root, entry.path(), ignored)?;
            let modified = entry.metadata().map(|metadata| workspace::modified_secs(&metadata)).unwrap_or(0);
            Some(Found {
                id,
                path: entry.into_path(),
                modified,
            })
        })
        .take(MAX_FILES_PER_FOLDER)
        .collect();
    files.sort_by(|a, b| a.id.cmp(&b.id));
    files
}

/// A project, one of its folders, or something inside that folder.
#[derive(Debug, PartialEq)]
struct Address<'a> {
    project: &'a str,
    label: Option<&'a str>,
    /// Path inside the folder; empty for the folder itself.
    rest: &'a str,
}

/// `None` for an empty address, which means every project.
fn parse(text: &str) -> Option<Address<'_>> {
    let text = text.trim();
    let text = text.strip_prefix(ID_PREFIX).unwrap_or(text).trim_matches('/');
    if text.is_empty() {
        return None;
    }
    let mut parts = text.splitn(3, '/');
    Some(Address {
        project: parts.next()?,
        label: parts.next(),
        rest: parts.next().unwrap_or("").trim_matches('/'),
    })
}

fn address(project: &Project, folder: &Folder) -> String {
    format!("{ID_PREFIX}{}/{}", project.name, folder.label)
}

fn find_project<'a>(projects: &'a [Project], name: &str) -> Result<&'a Project, String> {
    projects
        .iter()
        .find(|project| project.name.to_lowercase() == name.to_lowercase())
        .ok_or_else(|| {
            let names: Vec<String> = projects.iter().map(|project| format!("{:?}", project.name)).collect();
            format!("There is no project called {name:?}. Projects: {}.", names.join(", "))
        })
}

fn find_folder<'a>(project: &'a Project, label: &str) -> Result<&'a Folder, String> {
    project
        .folders
        .iter()
        .find(|folder| folder.label.to_lowercase() == label.to_lowercase())
        .ok_or_else(|| {
            let labels: Vec<&str> = project.folders.iter().map(|folder| folder.label.as_str()).collect();
            format!("The project {:?} has no folder {label:?}. Its folders: {}.", project.name, labels.join(", "))
        })
}

/// Resolves a project file ID to its file, refusing anything outside the
/// linked folder (including through symlinks).
fn resolve(projects: &[Project], id: &str) -> Result<PathBuf, String> {
    let not_a_file = || "This is not a project file ID. Use list_projects or search_projects to find IDs.".to_owned();
    let target = parse(id).ok_or_else(not_a_file)?;
    let label = target.label.filter(|_| !target.rest.is_empty()).ok_or_else(not_a_file)?;
    let folder = find_folder(find_project(projects, target.project)?, label)?;
    let root = root_of(folder)?;
    let path = crate::abs_path_from_id(&root, target.rest)?;
    let canonical = std::fs::canonicalize(&path)
        .map_err(|_| "No project file has this ID. Use list_projects or search_projects to find IDs.".to_owned())?;
    if canonical.starts_with(&root) {
        Ok(canonical)
    } else {
        Err("This file is outside the project's folder".into())
    }
}

/// The file behind a `project:` ID, for `read_notes` and `find_in_note`.
pub async fn note_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    let projects = read(app).await?;
    let id = id.to_owned();
    blocking(move || resolve(&projects, &id)).await
}

/// The projects available for one message, or `None` when no project has a folder.
pub async fn overview(app: &tauri::AppHandle) -> Option<String> {
    let projects = read(app).await.ok()?;
    let lines: Vec<String> = projects
        .iter()
        .filter(|project| !project.folders.is_empty())
        .map(|project| {
            let folders: Vec<String> = project.folders.iter().map(|folder| address(project, folder)).collect();
            format!("- {}: {}", project.name, folders.join(", "))
        })
        .collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

fn count_label(count: usize) -> String {
    if count == 1 {
        "1 markdown file".to_owned()
    } else {
        format!("{count} markdown files")
    }
}

/// How many files sit under each folder, counting its subfolders.
fn folder_counts<'a>(ids: impl Iterator<Item = &'a str>) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for id in ids {
        for (index, _) in id.match_indices('/') {
            *counts.entry(id[..index].to_owned()).or_insert(0) += 1;
        }
    }
    counts
}

/// One project's folders, each with its subfolder structure.
fn outline(project: &Project, ignored: &[String]) -> String {
    let mut lines = vec![format!("Project {:?}", project.name)];
    if project.folders.is_empty() {
        lines.push("- no folders linked yet".to_owned());
    }
    for folder in &project.folders {
        let place = address(project, folder);
        let files = match root_of(folder) {
            Ok(root) => walk(&root, ignored),
            Err(error) => {
                lines.push(format!("- {place}: {error}"));
                continue;
            }
        };
        let changed = files
            .iter()
            .map(|file| file.modified)
            .max()
            .map(|latest| format!(", last changed {}", workspace::modified_label(latest)))
            .unwrap_or_default();
        lines.push(format!("- {place} — {}{changed} (linked from {})", count_label(files.len()), folder.path));
        let counts = folder_counts(files.iter().map(|file| file.id.as_str()));
        let shown: Vec<(&String, &usize)> = counts
            .iter()
            .filter(|(path, _)| path.matches('/').count() < MAX_OUTLINE_DEPTH)
            .collect();
        for (path, count) in shown.iter().take(MAX_OUTLINE_FOLDERS) {
            let indent = "  ".repeat(path.matches('/').count() + 1);
            lines.push(format!("{indent}- {path}/ — {count}"));
        }
        let hidden = counts.len() - shown.len().min(MAX_OUTLINE_FOLDERS);
        if hidden > 0 {
            lines.push(format!("  - and {hidden} more folders further down"));
        }
    }
    lines.join("\n")
}

/// What sits directly inside a linked folder or one of its subfolders.
fn listing(project: &Project, label: &str, rest: &str, ignored: &[String]) -> Result<String, String> {
    let folder = find_folder(project, label)?;
    let files = walk(&root_of(folder)?, ignored);
    let place = if rest.is_empty() {
        address(project, folder)
    } else {
        format!("{}/{rest}", address(project, folder))
    };
    let prefix = if rest.is_empty() { String::new() } else { format!("{rest}/") };
    let inside: Vec<&Found> = files.iter().filter(|file| file.id.starts_with(&prefix)).collect();
    if inside.is_empty() {
        return Ok(format!("No markdown files in {place}."));
    }
    let mut lines = vec![format!("{place} — {}", count_label(inside.len()))];
    let counts = folder_counts(inside.iter().map(|file| &file.id[prefix.len()..]));
    let subfolders: Vec<String> = counts
        .iter()
        .filter(|(path, _)| !path.contains('/'))
        .map(|(path, count)| format!("- {place}/{path} — {count}"))
        .collect();
    if !subfolders.is_empty() {
        lines.push("Folders:".to_owned());
        lines.extend(subfolders);
    }
    let direct: Vec<&&Found> = inside.iter().filter(|file| !file.id[prefix.len()..].contains('/')).collect();
    if !direct.is_empty() {
        lines.push(format!("Files ({} of {}):", direct.len().min(MAX_LISTED_NOTES), direct.len()));
        for file in direct.iter().take(MAX_LISTED_NOTES) {
            let title = std::fs::read_to_string(&file.path)
                .map(|content| crate::extract_title(&content))
                .unwrap_or_else(|_| "unreadable".to_owned());
            lines.push(format!(
                "- {}/{} — {title} (modified {})",
                address(project, folder),
                file.id,
                workspace::modified_label(file.modified)
            ));
        }
    }
    Ok(lines.join("\n"))
}

const NO_PROJECTS: &str = "The user has no projects. They can add one in the sidebar under Projects.";

fn describe(projects: &[Project], path: &str, ignored: &[String]) -> Result<String, String> {
    if projects.is_empty() {
        return Ok(NO_PROJECTS.to_owned());
    }
    let Some(target) = parse(path) else {
        let outlines: Vec<String> = projects.iter().map(|project| outline(project, ignored)).collect();
        return Ok(format!(
            "{}\n\nCounts are markdown files, subfolders included. Pass a folder's address as path to list what is inside it, adding a subfolder as needed (project:Name/folder/sub).",
            outlines.join("\n\n")
        ));
    };
    let project = find_project(projects, target.project)?;
    match target.label {
        Some(label) => listing(project, label, target.rest, ignored),
        None => Ok(outline(project, ignored)),
    }
}

fn output(result: Result<String, String>) -> ToolOutput {
    match result {
        Ok(text) => ToolOutput::ok(text),
        Err(error) => ToolOutput::error(error),
    }
}

/// `list_projects`: every project's structure, or what one folder holds.
pub async fn list(app: &tauri::AppHandle, args: &Value) -> ToolOutput {
    let path = args.get("path").and_then(Value::as_str).unwrap_or("").to_owned();
    let ignored = ignored_dirs(app);
    output(match read(app).await {
        Ok(projects) => blocking(move || describe(&projects, &path, &ignored)).await,
        Err(error) => Err(error),
    })
}

/// Every word must appear in the file; the title and path count for more than the body.
fn score(terms: &[String], phrase: &str, id: &str, title: &str, content: &str) -> Option<u32> {
    let (id, title) = (id.to_lowercase(), title.to_lowercase());
    let mut total = 0;
    for term in terms {
        let mentions = content.matches(term.as_str()).count().min(10) as u32;
        let named = if title.contains(term.as_str()) { 8 } else { 0 } + if id.contains(term.as_str()) { 4 } else { 0 };
        if mentions + named == 0 {
            return None;
        }
        total += mentions + named;
    }
    if terms.len() > 1 && content.contains(phrase) {
        total += 10;
    }
    Some(total)
}

/// The first line that holds the whole query, or failing that one of its words.
fn snippet(content: &str, terms: &[String], phrase: &str) -> String {
    let holds = |line: &&str, needle: &str| line.to_lowercase().contains(needle);
    let line = content
        .lines()
        .find(|line| holds(line, phrase))
        .or_else(|| content.lines().find(|line| terms.iter().any(|term| holds(line, term))))
        .unwrap_or("");
    line.trim().chars().take(SNIPPET_CHARS).collect()
}

struct Hit {
    score: u32,
    modified: i64,
    line: String,
}

fn search_text(projects: &[Project], query: &str, only: Option<&str>, ignored: &[String]) -> Result<String, String> {
    if projects.is_empty() {
        return Ok(NO_PROJECTS.to_owned());
    }
    let phrase = query.trim().to_lowercase();
    let terms: Vec<String> = phrase.split_whitespace().map(str::to_owned).collect();
    if terms.is_empty() {
        return Err("query must not be empty".into());
    }
    let searched: Vec<&Project> = match only {
        Some(name) => vec![find_project(projects, name)?],
        None => projects.iter().collect(),
    };
    let mut hits = Vec::new();
    for project in searched {
        for folder in &project.folders {
            let Ok(root) = root_of(folder) else { continue };
            for file in walk(&root, ignored) {
                let small = std::fs::metadata(&file.path).is_ok_and(|metadata| metadata.len() <= MAX_SEARCHED_BYTES);
                let Some(content) = small.then(|| std::fs::read_to_string(&file.path).ok()).flatten() else {
                    continue;
                };
                let title = crate::extract_title(&content);
                let Some(score) = score(&terms, &phrase, &file.id, &title, &content.to_lowercase()) else {
                    continue;
                };
                hits.push(Hit {
                    score,
                    modified: file.modified,
                    line: format!(
                        "- {}/{} — {title} (modified {}): {}",
                        address(project, folder),
                        file.id,
                        workspace::modified_label(file.modified),
                        snippet(&content, &terms, &phrase)
                    ),
                });
            }
        }
    }
    if hits.is_empty() {
        return Ok(format!("No project files match {query:?}."));
    }
    hits.sort_by(|a, b| b.score.cmp(&a.score).then(b.modified.cmp(&a.modified)));
    let lines: Vec<&str> = hits.iter().take(SEARCH_RESULT_LIMIT).map(|hit| hit.line.as_str()).collect();
    Ok(format!("Showing {} of {} matches.\n{}", lines.len(), hits.len(), lines.join("\n")))
}

/// `search_projects`: full-text search across linked folders, read fresh each time.
pub async fn search(app: &tauri::AppHandle, args: &Value) -> ToolOutput {
    let Some(query) = args.get("query").and_then(Value::as_str).map(str::to_owned) else {
        return ToolOutput::error("query must be a string");
    };
    let only = args
        .get("project")
        .and_then(Value::as_str)
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty());
    let ignored = ignored_dirs(app);
    output(match read(app).await {
        Ok(projects) => blocking(move || search_text(&projects, &query, only.as_deref(), &ignored)).await,
        Err(error) => Err(error),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(label: &str, path: &Path) -> Folder {
        Folder {
            label: label.into(),
            path: path.to_string_lossy().into_owned(),
            remote: None,
        }
    }

    fn project(name: &str, folders: Vec<Folder>) -> Project {
        Project {
            id: name.to_lowercase(),
            name: name.into(),
            folders,
        }
    }

    /// A linked folder with notes at two levels, plus places that must be skipped.
    fn linked_folder() -> PathBuf {
        let base = std::env::temp_dir().join(format!("chatgsd-projects-{}", uuid::Uuid::new_v4()));
        let root = base.join("handbook");
        for dir in ["guides/setup", ".hidden", "node_modules/pkg"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        for (file, content) in [
            ("readme.md", "# Handbook\n\nStart here for the release checklist."),
            ("guides/style.md", "# Style guide\n\nWrite plainly."),
            ("guides/setup/install.md", "# Install\n\nRun the release script, then the checklist."),
            ("guides/notes.txt", "release checklist"),
            (".hidden/secret.md", "# Secret\n\nrelease checklist"),
            ("node_modules/pkg/readme.md", "# Package\n\nrelease checklist"),
        ] {
            std::fs::write(root.join(file), content).unwrap();
        }
        std::fs::write(base.join("outside.md"), "# Outside").unwrap();
        std::fs::canonicalize(root).unwrap()
    }

    fn ignored() -> Vec<String> {
        vec!["node_modules".into()]
    }

    #[test]
    fn addresses_split_into_project_folder_and_path() {
        assert_eq!(parse("  "), None);
        assert_eq!(parse("project:"), None);
        assert_eq!(parse("project:Client Work"), Some(Address { project: "Client Work", label: None, rest: "" }));
        assert_eq!(parse("Client Work/docs/"), Some(Address { project: "Client Work", label: Some("docs"), rest: "" }));
        assert_eq!(
            parse("project:Client Work/docs/api/v2/auth"),
            Some(Address { project: "Client Work", label: Some("docs"), rest: "api/v2/auth" })
        );
    }

    #[test]
    fn names_are_trimmed_unique_and_fit_in_an_id() {
        let projects = vec![project("Research", vec![])];
        assert_eq!(valid_name(&projects, "  Client Work ", None).unwrap(), "Client Work");
        assert!(valid_name(&projects, "   ", None).is_err());
        assert!(valid_name(&projects, "a/b", None).is_err());
        assert!(valid_name(&projects, "research", None).is_err(), "names differ by more than case");
        assert!(valid_name(&projects, "research", Some("research")).is_ok(), "a project may keep its own name");
        assert!(valid_name(&projects, &"x".repeat(MAX_NAME_CHARS + 1), None).is_err());
    }

    #[test]
    fn folder_labels_are_numbered_when_the_name_repeats() {
        let folders = vec![folder("docs", Path::new("/a/docs")), folder("Docs-2", Path::new("/b/docs"))];
        assert_eq!(unique_label(&folders, Path::new("/c/notes")), "notes");
        assert_eq!(unique_label(&folders, Path::new("/c/docs")), "docs-3");
        assert_eq!(unique_label(&folders, Path::new("/")), "folder");
    }

    #[test]
    fn folder_counts_include_subfolders() {
        let counts = folder_counts(["top", "a/one", "a/b/two", "a/b/three"].into_iter());
        assert_eq!(counts.get("a"), Some(&3));
        assert_eq!(counts.get("a/b"), Some(&2));
        assert_eq!(counts.len(), 2);
    }

    #[test]
    fn scoring_needs_every_word_and_favours_titles() {
        let terms = vec!["release".to_owned(), "checklist".to_owned()];
        let phrase = "release checklist";
        let body = score(&terms, phrase, "notes/misc", "Misc", "the release has a checklist").unwrap();
        let titled = score(&terms, phrase, "notes/misc", "Release checklist", "steps").unwrap();
        let exact = score(&terms, phrase, "notes/misc", "Misc", "the release checklist").unwrap();
        assert!(titled > body);
        assert!(exact > body);
        assert_eq!(score(&terms, phrase, "notes/misc", "Misc", "only the release"), None);
    }

    #[test]
    fn walks_markdown_and_skips_hidden_and_ignored_folders() {
        let root = linked_folder();
        let ids: Vec<String> = walk(&root, &ignored()).into_iter().map(|file| file.id).collect();
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
        assert_eq!(ids, ["guides/setup/install", "guides/style", "readme"]);
    }

    #[test]
    fn outlines_the_structure_and_lists_a_folder() {
        let root = linked_folder();
        let projects = vec![project("Docs", vec![folder("handbook", &root)]), project("Empty", vec![])];
        let all = describe(&projects, "", &ignored()).unwrap();
        let guides = describe(&projects, "project:docs/Handbook/guides", &ignored()).unwrap();
        let missing = describe(&projects, "project:Nope", &ignored());
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();

        assert!(all.contains("- project:Docs/handbook — 3 markdown files"), "{all}");
        assert!(all.contains("  - guides/ — 2"), "{all}");
        assert!(all.contains("    - guides/setup/ — 1"), "{all}");
        assert!(all.contains("Project \"Empty\"\n- no folders linked yet"), "{all}");
        assert!(guides.contains("- project:Docs/handbook/guides/setup — 1"), "{guides}");
        assert!(guides.contains("- project:Docs/handbook/guides/style — Style guide (modified "), "{guides}");
        assert!(!guides.contains("install —"), "files in subfolders are not listed: {guides}");
        assert!(missing.unwrap_err().contains("\"Docs\""));
    }

    #[test]
    fn resolves_ids_inside_the_folder_only() {
        let root = linked_folder();
        let projects = vec![project("Docs", vec![folder("handbook", &root)])];
        let found = resolve(&projects, "project:Docs/handbook/guides/style");
        let escaped = resolve(&projects, "project:Docs/handbook/../outside");
        let folder_only = resolve(&projects, "project:Docs/handbook");
        let absent = resolve(&projects, "project:Docs/handbook/guides/nope");
        #[cfg(unix)]
        let linked_out = {
            std::os::unix::fs::symlink(root.parent().unwrap().join("outside.md"), root.join("link.md")).unwrap();
            resolve(&projects, "project:Docs/handbook/link")
        };
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();

        assert_eq!(found.unwrap(), root.join("guides/style.md"));
        assert!(escaped.is_err());
        assert!(folder_only.is_err());
        assert!(absent.is_err());
        #[cfg(unix)]
        assert!(linked_out.unwrap_err().contains("outside"));
    }

    #[test]
    fn searches_across_projects_or_within_one() {
        let root = linked_folder();
        let projects = vec![project("Docs", vec![folder("handbook", &root)]), project("Empty", vec![])];
        let all = search_text(&projects, "Release Checklist", None, &ignored()).unwrap();
        let elsewhere = search_text(&projects, "release checklist", Some("empty"), &ignored()).unwrap();
        let none = search_text(&projects, "kubernetes", None, &ignored()).unwrap();
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();

        let lines: Vec<&str> = all.lines().collect();
        assert_eq!(lines[0], "Showing 2 of 2 matches.");
        assert!(lines[1].starts_with("- project:Docs/handbook/readme — Handbook"), "the exact phrase ranks first: {all}");
        assert!(lines[1].ends_with("Start here for the release checklist."), "{all}");
        assert!(lines[2].starts_with("- project:Docs/handbook/guides/setup/install — Install"), "{all}");
        assert!(elsewhere.starts_with("No project files match"));
        assert!(none.starts_with("No project files match"));
    }
}

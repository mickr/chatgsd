//! One-time copy of app data saved under the bundle ID the app had as Scratch.
//! Copied rather than moved, because upstream Scratch still uses that folder.

use std::fs;
use std::io;
use std::path::Path;

const LEGACY_IDENTIFIER: &str = "com.scratch.app";

/// Copies the legacy data folder that sits next to `data_dir` into `data_dir`,
/// unless `data_dir` already exists. Returns whether anything was copied.
pub fn migrate(data_dir: &Path) -> io::Result<bool> {
    let (Some(parent), Some(name)) = (data_dir.parent(), data_dir.file_name()) else {
        return Ok(false);
    };
    let legacy = parent.join(LEGACY_IDENTIFIER);
    if data_dir.exists() || !legacy.is_dir() {
        return Ok(false);
    }
    // Copy into a sibling and rename it into place, so an interrupted copy is
    // redone on the next launch instead of leaving a partial data folder.
    let mut staging_name = name.to_os_string();
    staging_name.push(".migrating");
    let staging = parent.join(staging_name);
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    copy_dir(&legacy, &staging)?;
    fs::rename(&staging, data_dir)?;
    Ok(true)
}

/// Copies directories and regular files, keeping their permissions (the
/// ChatGPT credentials are owner-only). Anything else is skipped.
fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target)?;
        }
    }
    // Last, so a read-only source folder doesn't block copying into it.
    fs::set_permissions(to, fs::metadata(from)?.permissions())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch_space(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("legacy-data-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[cfg(unix)]
    #[test]
    fn copies_the_legacy_folder_with_its_permissions_and_keeps_the_original() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch_space("copy");
        let legacy = root.join(LEGACY_IDENTIFIER);
        fs::create_dir_all(legacy.join("chatgpt")).unwrap();
        fs::write(legacy.join("config.json"), "{}").unwrap();
        fs::write(legacy.join("chatgpt/account.json"), "token").unwrap();
        fs::set_permissions(legacy.join("chatgpt/account.json"), fs::Permissions::from_mode(0o600)).unwrap();
        fs::set_permissions(legacy.join("chatgpt"), fs::Permissions::from_mode(0o700)).unwrap();
        // Left behind by an interrupted copy; it must not leak into the result.
        fs::create_dir_all(root.join("ai.chatgsd.desktop.migrating/partial")).unwrap();
        let data_dir = root.join("ai.chatgsd.desktop");

        assert!(migrate(&data_dir).unwrap());

        assert_eq!(fs::read_to_string(data_dir.join("config.json")).unwrap(), "{}");
        assert_eq!(fs::read_to_string(data_dir.join("chatgpt/account.json")).unwrap(), "token");
        assert_eq!(mode(&data_dir.join("chatgpt")), 0o700);
        assert_eq!(mode(&data_dir.join("chatgpt/account.json")), 0o600);
        assert!(!data_dir.join("partial").exists());
        assert!(!root.join("ai.chatgsd.desktop.migrating").exists());
        assert!(legacy.join("chatgpt/account.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn never_touches_an_existing_data_folder() {
        let root = scratch_space("existing");
        fs::create_dir_all(root.join(LEGACY_IDENTIFIER)).unwrap();
        fs::write(root.join(LEGACY_IDENTIFIER).join("config.json"), "old").unwrap();
        let data_dir = root.join("ai.chatgsd.desktop");
        fs::create_dir_all(&data_dir).unwrap();
        fs::write(data_dir.join("config.json"), "new").unwrap();

        assert!(!migrate(&data_dir).unwrap());

        assert_eq!(fs::read_to_string(data_dir.join("config.json")).unwrap(), "new");
        fs::remove_dir_all(root).unwrap();
    }
}

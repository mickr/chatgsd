use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ComputerPermission {
    Accessibility,
    ScreenRecording,
}

impl ComputerPermission {
    #[cfg(any(target_os = "macos", test))]
    fn settings_url(self) -> &'static str {
        match self {
            Self::Accessibility => "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            Self::ScreenRecording => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        }
    }
}

#[derive(Debug)]
pub struct ComputerUnavailable {
    pub message: String,
    pub permissions: Vec<ComputerPermission>,
}

impl From<String> for ComputerUnavailable {
    fn from(message: String) -> Self { Self { message, permissions: Vec::new() } }
}
impl From<&str> for ComputerUnavailable {
    fn from(message: &str) -> Self { message.to_owned().into() }
}

/// Called only by the user's explicit setup button, never by an agent tool.
#[tauri::command]
pub fn agent_computer_permissions(permission: ComputerPermission) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        macos::request(permission)?;
        open::that(permission.settings_url()).map_err(|error| format!("Could not open System Settings: {error}"))?;
        Ok("Enable ChatGSD in this permission pane. If macOS asks you to quit and reopen ChatGSD, do so to apply the change. Chat and note editing remain available without computer access.".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = permission;
        Ok("Install Cua Driver 0.38 or later and run ChatGSD in your interactive desktop session. Computer use only supports background interactions.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_actions_accept_only_known_permission_panes() {
        let accessibility: ComputerPermission = serde_json::from_str("\"accessibility\"").unwrap();
        let recording: ComputerPermission = serde_json::from_str("\"screen_recording\"").unwrap();
        assert!(accessibility.settings_url().ends_with("?Privacy_Accessibility"));
        assert!(recording.settings_url().ends_with("?Privacy_ScreenCapture"));
        assert!(serde_json::from_str::<ComputerPermission>("\"file:///tmp/other\"").is_err());
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::ComputerPermission;
    use std::ffi::c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        static kAXTrustedCheckOptionPrompt: *const c_void;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGRequestScreenCaptureAccess() -> bool;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: *const c_void;
        fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            count: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *const c_void;
        fn CFRelease(value: *const c_void);
    }

    pub fn request(permission: ComputerPermission) -> Result<(), String> {
        // The dictionary borrows process-lifetime CF constants. Null callbacks
        // avoid retaining them; the dictionary stays alive through the AX call.
        unsafe {
            if permission == ComputerPermission::ScreenRecording {
                CGRequestScreenCaptureAccess();
                return Ok(());
            }
            let options = CFDictionaryCreate(
                std::ptr::null(),
                &kAXTrustedCheckOptionPrompt,
                &kCFBooleanTrue,
                1,
                std::ptr::null(),
                std::ptr::null(),
            );
            if options.is_null() {
                return Err("Could not request Accessibility permission".into());
            }
            AXIsProcessTrustedWithOptions(options);
            CFRelease(options);
        }
        Ok(())
    }
}

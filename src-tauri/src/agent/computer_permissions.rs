/// Called only by the user's explicit setup button, never by an agent tool.
#[tauri::command]
pub fn agent_computer_permissions() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        macos::request()?;
        Ok("Allow Scratch in System Settings → Privacy & Security → Accessibility and Screen Recording, then fully quit and reopen Scratch. Cua Driver 0.38 or later must be installed.".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok("Install Cua Driver 0.38 or later and run Scratch in your interactive desktop session. Computer use only supports background interactions.".into())
    }
}

#[cfg(target_os = "macos")]
mod macos {
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

    pub fn request() -> Result<(), String> {
        // The dictionary borrows process-lifetime CF constants. Null callbacks
        // avoid retaining them; the dictionary stays alive through the AX call.
        unsafe {
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
            CGRequestScreenCaptureAccess();
        }
        Ok(())
    }
}

use tauri::{menu::{Menu, MenuItem}, AppHandle, Emitter, Manager, Runtime};

const CHECK_FOR_UPDATES: &str = "check-for-updates";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let check = MenuItem::with_id(app, CHECK_FOR_UPDATES, "Check for Updates…", true, None::<&str>)?;
    #[cfg(target_os = "macos")]
    {
        // Tauri's default macOS menu starts with the app menu and About item.
        if let Some(app_menu) = menu.items()?.first().and_then(|item| item.as_submenu()) {
            app_menu.insert(&check, 1)?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(help) = menu.get(tauri::menu::HELP_SUBMENU_ID).and_then(|item| item.as_submenu().cloned()) {
        help.append(&check)?;
    }
    Ok(menu)
}

pub fn handle_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    if event.id().as_ref() != CHECK_FOR_UPDATES {
        return;
    }
    // Only the active window should check and show the result, including previews.
    let window = app.webview_windows().into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"));
    if let Some(window) = window {
        if let Err(error) = window.emit_to(window.label(), CHECK_FOR_UPDATES, ()) {
            eprintln!("Couldn't request an update check: {error}");
        }
    }
}

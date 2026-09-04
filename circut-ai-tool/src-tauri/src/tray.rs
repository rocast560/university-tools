use crate::config::TITLE;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", format!("Open {TITLE}"), true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(app, "autostart", "Start at login", true, enabled, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &sep1, &autostart, &sep2, &quit])?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("icon"))
        .tooltip(TITLE)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => crate::window::open(app),
            "autostart" => {
                let al = app.autolaunch();
                if al.is_enabled().unwrap_or(false) {
                    let _ = al.disable();
                } else {
                    let _ = al.enable();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

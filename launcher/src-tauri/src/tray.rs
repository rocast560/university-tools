use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;
use crate::apps::APPS;

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = Vec::new();
    for spec in APPS {
        items.push(Box::new(MenuItem::with_id(app, format!("open:{}", spec.id), format!("Open {}", spec.title), true, None::<&str>)?));
    }
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    let enabled = app.autolaunch().is_enabled().unwrap_or(false);
    items.push(Box::new(CheckMenuItem::with_id(app, "autostart", "Start at login", true, enabled, None::<&str>)?));
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(MenuItem::with_id(app, "quit", "Quit University Tools", true, None::<&str>)?));
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = items.iter().map(|b| b.as_ref()).collect();
    let menu = Menu::with_items(app, &refs)?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("icon"))
        .tooltip("University Tools")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some(app_id) = id.strip_prefix("open:") { crate::windows::open(app, app_id); }
            else if id == "autostart" {
                let al = app.autolaunch();
                if al.is_enabled().unwrap_or(false) { let _ = al.disable(); } else { let _ = al.enable(); }
            } else if id == "quit" { app.exit(0); }
        })
        .build(app)?;
    Ok(())
}

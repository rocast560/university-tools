#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod apps;
mod backends;
mod health;
mod tray;
mod windows;

use std::sync::Arc;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use crate::apps::{paths, APPS};
use crate::backends::Backends;

/// `--open <id>` from an argv; None when absent.
fn open_arg(argv: &[String]) -> Option<String> {
    argv.iter().position(|a| a == "--open").and_then(|i| argv.get(i + 1).cloned())
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let minimized = argv.iter().any(|a| a == "--minimized");
    let initial = open_arg(&argv);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let id = open_arg(&argv).unwrap_or_else(|| APPS[0].id.to_string());
            windows::open(app, &id);
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .setup(move |app| {
            let backends = Arc::new(Backends::new().map_err(|e| std::io::Error::other(e))?);
            let p = paths(app.handle());
            for spec in APPS {
                if let Err(e) = backends.spawn(app.handle(), spec, &p) { eprintln!("[launcher] {}: {e}", spec.id); }
            }
            app.manage(backends);
            tray::build(app.handle())?;
            if !minimized {
                let id = initial.clone().unwrap_or_else(|| APPS[0].id.to_string());
                windows::open(app.handle(), &id);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); let _ = window.hide(); }
        })
        .build(tauri::generate_context!())
        .expect("failed to build launcher")
        .run(|app, event| match event {
            RunEvent::ExitRequested { api, code, .. } => { if code.is_none() { api.prevent_exit(); } }
            RunEvent::Exit => { if let Some(b) = app.try_state::<Arc<Backends>>() { b.kill_all(); } }
            _ => {}
        });
}

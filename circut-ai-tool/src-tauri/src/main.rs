#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod config;
mod health;
mod tray;
mod window;

use crate::backend::Backend;
use crate::config::paths;
use std::sync::Arc;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let minimized = argv.iter().any(|a| a == "--minimized");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            window::open(app);
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .setup(move |app| {
            let backend = Arc::new(Backend::new().map_err(|e| std::io::Error::other(e))?);
            let p = paths(app.handle());
            if let Err(e) = backend.spawn(&p) {
                eprintln!("[circuit-ai-tool] {e}");
            }
            app.manage(backend);
            tray::build(app.handle())?;
            if !minimized {
                window::open(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build shell")
        .run(|app, event| match event {
            RunEvent::ExitRequested { api, code, .. } => {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            RunEvent::Exit => {
                if let Some(b) = app.try_state::<Arc<Backend>>() {
                    b.kill();
                }
            }
            _ => {}
        });
}

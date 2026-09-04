use crate::backend::Backend;
use crate::config::{paths, HEALTH_PATH, PORT, TITLE, WINDOW};
use crate::health::wait_healthy;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "main";

/// Show the main window, creating it after the backend is healthy. Runs the wait off the main thread.
pub fn open(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        let ok = wait_healthy(PORT, HEALTH_PATH, Duration::from_secs(20));
        let _ = handle.clone().run_on_main_thread(move || create(&handle, ok));
    });
}

fn create(app: &AppHandle, healthy: bool) {
    let url = if healthy {
        WebviewUrl::External(format!("http://127.0.0.1:{PORT}/").parse().unwrap())
    } else {
        let log = Backend::log_path(&paths(app));
        WebviewUrl::App(format!("index.html?app={}&log={}", TITLE, urlencoding(&log)).into())
    };
    let _ = WebviewWindowBuilder::new(app, LABEL, url).title(TITLE).inner_size(WINDOW.0, WINDOW.1).build();
}

fn urlencoding(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

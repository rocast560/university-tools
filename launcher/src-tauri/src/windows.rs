use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use crate::apps::{app_by_id, paths, AppSpec};
use crate::backends::Backends;
use crate::health::wait_healthy;

/// Show the app's window, creating it after the backend is healthy. Runs the wait off the main thread.
pub fn open(app: &AppHandle, id: &str) {
    let Some(spec) = app_by_id(id) else { return };
    if let Some(w) = app.get_webview_window(spec.id) { let _ = w.show(); let _ = w.unminimize(); let _ = w.set_focus(); return; }
    let handle = app.clone();
    std::thread::spawn(move || {
        let ok = wait_healthy(spec.port, spec.health, Duration::from_secs(20));
        let _ = handle.clone().run_on_main_thread(move || create(&handle, spec, ok));
    });
}

fn create(app: &AppHandle, spec: &'static AppSpec, healthy: bool) {
    let url = if healthy {
        WebviewUrl::External(format!("http://127.0.0.1:{}/", spec.port).parse().unwrap())
    } else {
        let log = Backends::log_path(&paths(app), spec);
        WebviewUrl::App(format!("index.html?app={}&log={}", spec.title, urlencoding(&log)).into())
    };
    let _ = WebviewWindowBuilder::new(app, spec.id, url)
        .title(spec.title)
        .inner_size(spec.window.0, spec.window.1)
        .build();
}

fn urlencoding(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub struct AppSpec {
    pub id: &'static str,
    pub title: &'static str,
    pub port: u16,
    pub health: &'static str,
    /// Sidecar base name (bundled next to the launcher exe as `<sidecar>.exe`).
    pub sidecar: &'static str,
    pub window: (f64, f64),
    pub env: fn(&AppHandle, &Paths) -> Vec<(String, String)>,
}

pub struct Paths {
    /// Directory holding the sidecar executables.
    pub bin_dir: PathBuf,
    /// `%LOCALAPPDATA%\UniversityTools`
    pub data_root: PathBuf,
    /// Bundled resources root (dev: src-tauri/resources).
    pub resources: PathBuf,
}

pub const APPS: &[AppSpec] = &[AppSpec {
    id: "typst",
    title: "Typst Studio",
    port: 8090,
    health: "/api/health",
    sidecar: "tfs-server",
    window: (1400.0, 900.0),
    env: typst_env,
}];

pub fn app_by_id(id: &str) -> Option<&'static AppSpec> { APPS.iter().find(|a| a.id == id) }

fn typst_env(_app: &AppHandle, p: &Paths) -> Vec<(String, String)> {
    let data = p.data_root.join("typst");
    vec![
        ("PORT".into(), "8090".into()),
        ("HOST".into(), "127.0.0.1".into()),
        ("DATA_DIR".into(), data.to_string_lossy().into_owned()),
        ("STATIC_DIR".into(), p.resources.join("typst").join("dist").to_string_lossy().into_owned()),
        ("TYPST_CLI".into(), p.bin_dir.join("typst.exe").to_string_lossy().into_owned()),
    ]
}

/// Where things are, in a bundle and under `tauri dev`.
pub fn paths(app: &AppHandle) -> Paths {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())).unwrap_or_default();
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let bin_dir = if exe_dir.join("tfs-server.exe").exists() { exe_dir.clone() } else { manifest.join("binaries") };
    let resources = app.path().resource_dir().ok().map(|r| r.join("resources")).filter(|r| r.join("typst").join("dist").join("index.html").exists())
        .unwrap_or_else(|| manifest.join("resources"));
    let data_root = app.path().local_data_dir().unwrap_or_else(|_| exe_dir.clone()).join("UniversityTools");
    Paths { bin_dir, data_root, resources }
}

/// Sidecar executable path: bundled name, else the dev name with the target triple.
pub fn sidecar_path(p: &Paths, base: &str) -> PathBuf {
    let bundled = p.bin_dir.join(format!("{base}.exe"));
    if bundled.exists() { bundled } else { p.bin_dir.join(format!("{base}-x86_64-pc-windows-msvc.exe")) }
}

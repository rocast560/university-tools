use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub const PORT: u16 = 8765;
pub const HOST: &str = "127.0.0.1";
pub const HEALTH_PATH: &str = "/api/health";
pub const TITLE: &str = "Circuit AI Tool";
pub const SIDECAR: &str = "circuit-server";
pub const WINDOW: (f64, f64) = (1500.0, 950.0);

pub struct Paths {
    /// Directory holding the sidecar executable.
    pub bin_dir: PathBuf,
    /// `%LOCALAPPDATA%\UniversityTools\circuit`
    pub data_dir: PathBuf,
    /// Bundled resources root (dev: src-tauri/resources).
    pub resources: PathBuf,
}

/// Where things are, in a bundle and under `tauri dev`.
pub fn paths(app: &AppHandle) -> Paths {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())).unwrap_or_default();
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let bin_dir = if exe_dir.join(format!("{SIDECAR}.exe")).exists() { exe_dir.clone() } else { manifest.join("binaries") };
    let resources = app
        .path()
        .resource_dir()
        .ok()
        .map(|r| r.join("resources"))
        .filter(|r| r.join("dist").join("index.html").exists())
        .unwrap_or_else(|| manifest.join("resources"));
    let data_dir = app.path().local_data_dir().unwrap_or_else(|_| exe_dir.clone()).join("UniversityTools").join("circuit");
    Paths { bin_dir, data_dir, resources }
}

/// Sidecar executable path: bundled name, else the dev name with the target triple.
pub fn sidecar_path(p: &Paths) -> PathBuf {
    let bundled = p.bin_dir.join(format!("{SIDECAR}.exe"));
    if bundled.exists() { bundled } else { p.bin_dir.join(format!("{SIDECAR}-x86_64-pc-windows-msvc.exe")) }
}

/// KiCad 9 install roots to probe, in priority order.
fn kicad_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("Programs").join("KiCad").join("9.0"));
    }
    roots.push(PathBuf::from(r"C:\Program Files\KiCad\9.0"));
    roots
}

/// A real `kicad-cli.exe` + symbols dir under one of the candidate roots.
/// `None` if neither root has both — the server falls back to its own
/// default and reports the problem via `/api/health`.
fn find_kicad() -> Option<(PathBuf, PathBuf)> {
    for root in kicad_roots() {
        let cli = root.join("bin").join("kicad-cli.exe");
        let symbols = root.join("share").join("kicad").join("symbols");
        if cli.exists() && symbols.exists() {
            return Some((cli, symbols));
        }
    }
    None
}

/// Environment passed to the sidecar. Matches the contract read in server/config.ts.
pub fn sidecar_env(p: &Paths) -> Vec<(String, String)> {
    let projects_dir = p.data_dir.join("projects");
    let mut vars = vec![
        ("CIRCUIT_PORT".into(), PORT.to_string()),
        ("CIRCUIT_HOST".into(), HOST.into()),
        ("DATA_DIR".into(), p.data_dir.to_string_lossy().into_owned()),
        ("PROJECTS_DIR".into(), projects_dir.to_string_lossy().into_owned()),
        ("STATIC_DIR".into(), p.resources.join("dist").to_string_lossy().into_owned()),
        ("CIRCUIT_EXE".into(), sidecar_path(p).to_string_lossy().into_owned()),
    ];
    // Absolute paths only: the server checks with access(), so a bare command
    // name (e.g. "kicad-cli") would falsely report NOT FOUND. Set nothing if
    // KiCad isn't found at a known location; the server has its own fallback.
    if let Some((cli, symbols)) = find_kicad() {
        vars.push(("KICAD_CLI".into(), cli.to_string_lossy().into_owned()));
        vars.push(("KICAD_SYMBOL_DIR".into(), symbols.to_string_lossy().into_owned()));
    }
    vars
}

# Desktop packaging plan: university-tools on Windows

Date: 2026-09-03. Goal: launch typst-editor, Chemistry Tool and circuit-designer
from desktop icons on a Windows 11 laptop, with every feature intact (web UI,
REST API, MCP endpoints for Claude Code) and a launch that feels instant.

Decision in one line: **Tauri 2 as the shell, each existing backend bundled as a
sidecar, one tray-resident launcher that keeps the backends warm.** Wails is not
the right fit because none of the backends are Go and Wails has no sidecar
mechanism. Details, measurements and the rejected alternatives follow.

## 1. What the three apps are

| App | UI | Backend | Port | Where the heavy work runs |
|---|---|---|---|---|
| typst-editor | React, CodeMirror, Tailwind | Bun, TypeScript, no npm runtime deps | 8090 | Browser: typst.ts WASM compiler + renderer in a Web Worker |
| Chemistry Tool | Vanilla TS, 3Dmol.js (WebGL) | Node 22+, Hono, OpenChemLib, resvg-js (native addon). Server not written yet | 8140 | Browser: WebGL, OpenChemLib; PubChem over HTTP |
| circuit-designer | Vanilla JS | Python 3.13, FastAPI, uvicorn, mcp, anthropic | 8765 | External: kicad-cli.exe, Claude API |

All three already serve their built frontend from the backend, and all three
expose `/mcp` (or `/mcp-server/mcp`) and `/api/*`. Claude Code is registered
against those localhost URLs, so the ports must stay the same and the
backends must keep running even when no window is open.

## 2. Why the shell is not the bottleneck

Measured on this laptop (Ryzen AI 9 HX 370, NVMe) on 2026-09-03:

| Component | Cold start to ready |
|---|---|
| WebView2 shell (Tauri or Wails, published benchmarks) | 200 to 400 ms |
| typst-editor: `bun server/index.ts` to first 200 on `/api/health` | 683 to 727 ms (3 runs) |
| circuit-designer: `uvicorn app.main:app` to first 200 | 1.5 to 2.6 s (2 runs) |
| Bare `node -e 0` / `bun -e 0` / `python -c 0`, best of 5 | 116 / 123 / 94 ms |

The circuit-designer figure is almost all imports. `python -X importtime` shows
`app.main` at 2.1 s cumulative: the `mcp` package (fastmcp) 0.4 to 0.6 s,
`fastapi` 0.34 s, the app's own modules 0.8 s. No shell technology fixes that.
The only way a click feels instant for that app is if the backend is already
running when you click. That drives the architecture below.

On Windows, Tauri, Wails, pywebview, Electrobun and Edge's "install as app"
all render in the same WebView2 engine (Edge 152 is installed here). UI speed
is identical across them; they differ only in how they manage the backend.

## 3. Recommended architecture

One Tauri 2 application, "University Tools", that:

1. Starts at login (optional) and lives in the system tray.
2. Spawns the three backends as child processes at startup and keeps them alive.
3. Opens one WebView2 window per app, each pointing at `http://127.0.0.1:<port>`.
   The frontends need no changes: they already load from their own server.
4. Hides a window on close instead of exiting, so the backends and the MCP
   endpoints survive. Quit lives in the tray menu.
5. Has three desktop shortcuts, all pointing at the same executable with a
   different argument (`--open typst`, `--open chem`, `--open circuit`) and a
   different icon. The single-instance plugin forwards the argument to the
   running process, which shows the matching window.

Opening a window then costs only the WebView2 shell, roughly a quarter second,
regardless of how slow the Python backend was to warm up in the background.

### Tauri pieces

| Need | Tauri 2 piece |
|---|---|
| Bundle and spawn backends | `bundle.externalBin` + `tauri-plugin-shell` (`app.shell().sidecar(...)`), or `bundle.resources` + `std::process::Command` for folder-shaped builds |
| Tray icon and menu | `tauri` crate feature `tray-icon` |
| Second launch reuses the running app | `tauri-plugin-single-instance` (callback receives the new argv) |
| Run at login | `tauri-plugin-autostart` (launch with `--minimized`) |
| Keep running with no windows | handle `RunEvent::ExitRequested` and call `api.prevent_exit()` |
| Installer with Start menu and desktop shortcut | Tauri bundler, NSIS target |

Key details to get right:

- **Wait for health before showing a window.** Create each window from Rust
  only after `GET /api/health` returns 200, or show a tiny bundled splash page
  that polls and then navigates. typst-editor already has `/api/health`; add
  the same route to the other two servers.
- **Kill children on quit.** Windows does not kill child processes when the
  parent exits. Keep the `Child` handles and kill them in `RunEvent::Exit`.
  For crash safety, put the children in a Job Object with kill-on-close
  (crate `win32job`), so a launcher crash cannot leave orphaned servers
  holding the ports.
- **Environment, not code changes.** Every server is configured by env vars.
  The launcher sets `PORT`, `HOST=127.0.0.1`, `DATA_DIR`, `STATIC_DIR`,
  `INBOX_DIR`, `KICAD_CLI` and so on, with data under
  `%LOCALAPPDATA%\UniversityTools\<app>\`.
- **Keep the existing ports** (8090, 8140, 8765) so the `claude mcp add`
  registrations and the connection snippets in the UIs keep working.

### Minimal config sketch

`src-tauri/tauri.conf.json`:

```json
{
  "productName": "University Tools",
  "identifier": "dev.rober.university-tools",
  "app": {
    "windows": [],
    "trayIcon": { "iconPath": "icons/icon.png" }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "externalBin": ["binaries/tfs-server", "binaries/chem-server"],
    "resources": ["resources/circuit-server/**"]
  }
}
```

Sidecar files must be named with the target triple:
`src-tauri/binaries/tfs-server-x86_64-pc-windows-msvc.exe`.

`src-tauri/src/main.rs`, the shape of it:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        // parse --open <name> from argv, show or create that window
    }))
    .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
    .setup(|app| {
        // spawn the three backends with their env vars, keep the Child handles
        // build the tray menu: Open Typst / Open Chemistry / Open Circuit / Quit
        // poll each /api/health, then open the window asked for on the command line
        Ok(())
    })
    .on_window_event(|window, event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window.hide();
        }
    })
    .build(tauri::generate_context!())?
    .run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => api.prevent_exit(),
        tauri::RunEvent::Exit => { /* kill the children */ }
        _ => {}
    });
```

Windows are created from Rust with
`WebviewWindowBuilder::new(app, "typst", WebviewUrl::External("http://127.0.0.1:8090".parse()?))`.

## 4. Per-app packaging and optimisations

### typst-editor (Bun)

The server touches exactly one Bun API (`Bun.serve`), everything else is
`node:*`. Compile it to a single executable:

```sh
cd typst-editor
bun run fonts          # once; puts the 17 default fonts in public/fonts
bun run build          # dist/ with the WASM compiler, renderer and fonts
bun build --compile --minify --bytecode --target=bun-windows-x64 \
  server/index.ts \
  --outfile ../launcher/src-tauri/binaries/tfs-server-x86_64-pc-windows-msvc.exe
```

- `--bytecode` skips parsing on every start. In February 2026 Evan You measured
  Bun 1.3.9 with bytecode starting 25% faster than a Node SEA with code cache.
  If the build rejects the flag for this ESM entry, drop it and measure; the
  transpile step still disappears because the bundle is plain JS.
- Expect the 700 ms measured today to fall well below that: today's number
  includes Bun transpiling the TypeScript server sources on every launch.
- Ship `dist/` as a Tauri resource and pass its path as `STATIC_DIR`.
- Do **not** run the Dockerfile's gzip precompression step for the desktop
  build. On loopback the 28 MB WASM reads from NVMe in a few milliseconds; the
  gzip step only makes the browser spend CPU inflating it.
- Keep the immutable cache headers the static handler already sends, so
  WebView2 can keep the compiled WASM module in its code cache between
  launches.
- Stop the Docker container (`docker compose down` in typst-editor). It has
  `restart: unless-stopped` and would fight the sidecar for port 8090. Copy
  the documents out of the `typst-editor_tfs-data` volume into the new
  `DATA_DIR` first.
- A compiled Bun executable is roughly 100 MB because it embeds the Bun
  runtime. If that bothers you, ship `bun.exe` once as the sidecar and pass
  each app's bundled `server.js` as an argument instead; startup is the same.

### Chemistry Tool (Node or Bun)

The `server/` directory is still empty, so the packaging choice can be made
before the code exists:

- Write the Hono server so it runs under Bun as well as Node (Hono supports
  both; use `@hono/node-server` only under Node). Then package it exactly like
  typst-editor with `bun build --compile`. Bun embeds `.node` native addons,
  which covers `@resvg/resvg-js`. If you stay on Node, use `@yao-pkg/pkg`
  rather than Node SEA, because SEA cannot embed native addons on its own.
- Add `GET /api/health`.
- Read `PORT`, `DATA_DIR` (for `cache/` and `data/`) and `STATIC_DIR` from the
  environment like the other two.
- The 3Dmol WebGL viewer needs nothing special: WebView2 is Chromium with
  hardware acceleration on by default. Keep the existing split that loads
  3Dmol only after the first result, so the first paint stays fast.
- Consider doing name and formula resolution in the browser as well
  (OpenChemLib is pure JS). Then the window works the moment the shell is up,
  and the server is only needed for MCP, REST, PubChem and PNG rendering.

### circuit-designer (Python)

This is the slow one, and the launcher hides it by keeping it resident. Still
worth doing:

- Bundle with **PyInstaller in `--onedir` mode**. `--onefile` re-extracts on
  every launch (about 1.5 s extra) and is known to break uvicorn. Create a
  small `run_server.py` that calls `uvicorn.run(app, host="127.0.0.1",
  port=8765)` and build it:

  ```bat
  cd circuit-designer
  .venv\Scripts\pip install pyinstaller
  .venv\Scripts\pyinstaller --onedir --noconsole --name circuit-server ^
    --collect-all mcp --collect-all fastapi --collect-all anthropic ^
    --add-data "app/static;app/static" --add-data "examples;examples" ^
    run_server.py
  ```

  A onedir build is a folder, not a single file, so include it through
  `bundle.resources` and spawn `circuit-server.exe` from the resource path
  with `std::process::Command` rather than the sidecar API.
- **Lazy imports.** Import `anthropic` inside the function that calls Claude,
  not at module top. Mounting the MCP app can also be deferred behind a small
  ASGI shim that imports `app.mcp_server` on the first request to
  `/mcp-server/*`. Together those remove most of the 2.1 s import cost.
- Point `KICAD_CLI` at the native install:
  `%LOCALAPPDATA%\Programs\KiCad\9.0\bin\kicad-cli.exe`. The Docker image
  only existed to provide kicad-cli, so Docker is not needed on this laptop.
- Nuitka would start faster still (tens of milliseconds for the interpreter)
  but has a long history of packaging issues with uvicorn, pydantic and
  websockets. Not worth it while the launcher keeps the process warm.
- Set `DATA_DIR` and `INBOX_DIR` under `%LOCALAPPDATA%\UniversityTools\circuit\`.

## 5. Tooling to install

Already present: Rust 1.90 with the MSVC toolchain, Visual Studio 2022, Node 24,
Bun 1.3, Python 3.13, Go 1.26, Wails v2.15, KiCad 9, WebView2 runtime 152,
Docker Desktop.

Still needed:

```sh
cargo install tauri-cli --version "^2"      # tauri CLI
cargo add tauri --features tray-icon         # inside src-tauri
cargo add tauri-plugin-shell tauri-plugin-single-instance tauri-plugin-autostart win32job
pip install pyinstaller                      # inside circuit-designer/.venv
```

The Tauri bundler downloads NSIS itself on first `cargo tauri build`. WebView2
is already installed, so leave `bundle.windows.webviewInstallMode` at its
default; the bootstrapper will simply find the runtime.

Desktop shortcuts with per-app icons can be created by a short PowerShell
script after install (WScript.Shell `CreateShortcut` with `Arguments` set to
`--open typst` and so on), or added as an NSIS installer hook.

## 6. Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Wails v2 / v3 (Go)** | No | Assumes a Go backend. No sidecar feature (open discussion #3021); you would embed, extract and exec binaries by hand. v3 still beta. Only sensible if the backends were rewritten in Go. |
| **Rewrite backends in Rust or Go** | No | The heavy work is in the browser (typst WASM, WebGL) or in external processes (kicad-cli, Claude API). A rewrite saves about 100 ms of runtime startup for weeks of work. |
| **Electron** | No | Bundles Chromium, 150 MB plus, about 1.4 s cold start, no gain when WebView2 is already on the machine. |
| **Electrobun** | Not yet | Attractive for the two TypeScript apps (backend stays in Bun, system webview), but it bundles about 60 MB of Bun, Windows support only stabilised in May 2026 (v1.18), and it is pre-1.0. Revisit after 1.0. |
| **pywebview** | Only for Python alone | Same WebView2 engine, but does not unify three apps and still pays the Python import cost. |
| **Neutralinojs** | No | Small, but no process management and a thin native API. |
| **Node SEA for the TS servers** | No | Cannot embed native addons (resvg); Bun compile is faster to start per current benchmarks. |
| **Edge "Install this site as an app"** | Yes, as a stopgap | Zero code. Same engine, own window, taskbar and desktop icon. Needs the servers started some other way. |

## 7. Stopgap you can do today

1. Start the three servers at login with a Task Scheduler entry that runs a
   `start-backends.ps1` (bun for typst-editor, node for chemistry once it
   exists, the venv's uvicorn for circuit-designer with `KICAD_CLI` set).
2. In Edge, open each `http://localhost:<port>` and use the menu item
   **Apps, Install this site as an app**. Edge creates a desktop and Start
   menu shortcut and opens the page in its own window.

This gives icons and instant windows immediately and is replaced wholesale by
the Tauri launcher later. Nothing built for it is wasted: the env vars and
the per-app health routes are the same.

## 8. Verification checklist

Measure, do not assume:

- Time from launching the compiled `tfs-server` exe to the first 200 on
  `/api/health` (target: well under 300 ms; today 700 ms under `bun server/index.ts`).
- Time from a desktop shortcut click to the window showing content while the
  launcher is already resident (target: about 250 ms).
- After **Quit** from the tray, `Get-Process | Where-Object Name -match 'server'`
  shows no leftover backends and the three ports are free.
- Claude Code's MCP connection to each app survives closing its window.
- typst-editor: paste a report with images, confirm compile, PDF export and
  the backup folder picker still work with the new `DATA_DIR`.
- circuit-designer: import a `.kicad_sch` and run Design with the native
  `kicad-cli`.

## Sources

- Tauri: Embedding External Binaries, https://v2.tauri.app/develop/sidecar/
- Tauri: Node.js as a sidecar, https://v2.tauri.app/learn/sidecar-nodejs/
- Wails discussion: External Binaries (Tauri Sidecar equivalent), https://github.com/wailsapp/wails/discussions/3021
- Wails v3 Beta announcement, https://v3.wails.io/blog/wails-v3-beta/
- Tauri vs Electron 2026 benchmarks, https://tech-insider.org/tauri-vs-electron-2026/
- Cross-platform desktop apps 2026 deep dive, https://www.youngju.dev/blog/culture/2026-05-16-cross-platform-desktop-apps-2026-tauri-2-electron-wails-neutralinojs-flutter-desktop-sciter-deep-dive.en
- Tauri v2 + FastAPI sidecar template, https://github.com/AlanSynn/vue-tauri-fastapi-sidecar-template
- PyInstaller: onefile breaks uvicorn, https://github.com/pyinstaller/pyinstaller/issues/8817
- Nuitka vs PyInstaller vs cx_Freeze 2026, https://blog.thoughtparameters.com/post/nuitka_vs_pyinstaller_python_packaging/
- Bun vs Node SEA startup benchmark (Evan You), https://github.com/yyx990803/bun-vs-node-sea-startup
- Bun single-file executables (embedding .node addons), https://bun.sh/docs/bundler/executables.md
- Electrobun v1.18.0 changelog, https://docs.electrobunny.ai/electrobun/guides/changelog/v1-18-0/
- Top 5 Electron alternatives in 2026, https://teamdev.com/mobrowser/blog/top-5-electron-alternatives-in-2026/
- Edge: install a website as an app, https://www.itechguides.com/how-to-install-a-website-as-an-app-on-your-desktop-with-microsoft-edge/

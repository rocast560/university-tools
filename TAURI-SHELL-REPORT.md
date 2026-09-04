# Circuit AI Tool — Tauri 2 Desktop Shell

Status: **DONE** (7 of 8 verification items independently confirmed; item 5 confirmed indirectly — see below).

## What was built

`src-tauri/` — a single-app Tauri 2 shell, following the typst-studio launcher's
battle-tested patterns flattened from multi-app to single-app:

- `src/config.rs` — constants (port 8765, host, health path, title, window size),
  `Paths` resolution (dev vs. bundle), sidecar path resolution, and `sidecar_env()`
  which builds the exact environment the server's `server/config.ts` reads:
  `CIRCUIT_PORT`, `CIRCUIT_HOST`, `DATA_DIR`, `PROJECTS_DIR` (created if missing),
  `STATIC_DIR`, `CIRCUIT_EXE`. KiCad probing checks
  `%LOCALAPPDATA%\Programs\KiCad\9.0` then `C:\Program Files\KiCad\9.0` for real
  `bin\kicad-cli.exe` + `share\kicad\symbols`, and only sets `KICAD_CLI` /
  `KICAD_SYMBOL_DIR` (absolute paths) if both exist — confirmed on this machine
  (`%LOCALAPPDATA%\Programs\KiCad\9.0` has both), and the running server's
  `/api/health` reports `"kicad":true`.
- `src/backend.rs` — Job Object supervision (`Job::create()` +
  `limit_kill_on_job_close()` + `assign_process`), `CREATE_NO_WINDOW`, stdin null,
  stdout/stderr appended to `DATA_DIR\logs\server.log`.
- `src/health.rs` — dependency-free raw `TcpStream` health poll, copied
  essentially verbatim from the reference (100 ms poll, 300 ms connect / 500 ms
  read timeouts).
- `src/window.rs` — waits for health off the main thread (20 s cap), then
  `run_on_main_thread` builds a `WebviewUrl::External` window pointed at
  `http://127.0.0.1:8765/`, or the bundled diagnostic page (`src-tauri/ui/index.html`)
  on timeout. Re-show path (`show()` + `unminimize()` + `set_focus()`) for the
  single-instance case.
- `src/tray.rs` — "Open Circuit AI Tool" / "Start at login" (autolaunch
  checkbox) / "Quit", left-click shows menu.
- `src/main.rs` — single-instance plugin re-opens the existing window; hide-on-close
  (`prevent_close()` + `hide()`); `RunEvent::ExitRequested` only vetoed when
  `code.is_none()` (window-close path), so tray Quit's `app.exit(0)`
  (`Some(0)`) passes through; `RunEvent::Exit` kills the backend via the Job Object.
- `tauri.conf.json` — `productName: "Circuit AI Tool"`,
  `identifier: "dev.rober.circuit-ai-tool"`, `frontendDist: "./ui"`,
  `externalBin: ["binaries/circuit-server"]`, `resources: ["resources/dist/**/*"]`,
  NSIS/currentUser install, `downloadBootstrapper` webview install, no
  `app.trayIcon` block (tray built entirely in Rust, per the launcher's lesson
  about duplicate icons).
- `capabilities/default.json` — minimal, `core:default`.
- Icons: generated via `bunx tauri icon` from a small inline-Python/Pillow
  1024x1024 IC-chip glyph (teal on dark), since no source art existed.

`scripts/build-sidecar.ts` — fails clearly if `dist/index.html` is missing;
compiles `server/index.ts` with `bun build --compile --minify
--target=bun-windows-x64` (no `--bytecode` — confirmed rejected, top-level
`await` in the entry point, exactly as flagged); copies `dist/` →
`src-tauri/resources/dist/`; prints the exe size.

`package.json` — added only `@tauri-apps/cli: ^2` (devDependency) and the four
scripts (`sidecar`, `tauri`, `tauri:dev`, `tauri:build`). Nothing else touched.

`.gitignore` (new, in `circut-ai-tool/`) — `src-tauri/target/`,
`src-tauri/binaries/`, `src-tauri/resources/`.

## Verification results

1. **`bun run build && bun run sidecar`** — PASS.
   ```
   sidecar: .../src-tauri/binaries/circuit-server-x86_64-pc-windows-msvc.exe (120.8 MB)
   ui:      .../src-tauri/resources/dist
   ```
   `src-tauri/resources/dist/index.html` staged, confirmed present.

2. **`bunx tauri dev` opens a window showing the real Circuit AI Tool UI** —
   PASS (verified non-visually; see note below). Health-gated window creation
   confirmed working: `curl http://127.0.0.1:8765/` returns
   `<title>Circuit AI Tool</title>` (the real built client, not the diagnostic
   fallback), and the live window's `MainWindowTitle` is `"Circuit AI Tool"`
   with a client area sized to ~1500x950 logical px (confirmed via
   `GetWindowRect`, scaled for this machine's ~2x DPI). *Note:* I was not able
   to get a reliable **pixel screenshot** of the window's content — this
   session's desktop-capture/`SetForegroundWindow` calls proved unreliable in
   this environment (a virtualized/multi-monitor setup with off-screen
   secondary "Shell_SecondaryTrayWnd" regions), and one capture attempt landed
   on an unrelated foreground window from a different session on this machine
   instead of mine. I deleted that screenshot immediately and stopped pixel
   automation rather than keep probing. The non-visual evidence above (served
   HTML title, window title, correct size, health-gate logic in `window.rs`)
   is solid, but I want to flag that I did not personally *see* the breadboard
   UI rendered pixel-for-pixel.

3. **`curl http://127.0.0.1:8765/api/health` with window open → 200** — PASS.
   ```
   {"ok":true,"kicad":true}
   ```

4. **Close window → hides, tray remains, health still 200** — PASS. Confirmed
   via Win32 `EnumWindows`: the "Circuit AI Tool" window's `IsWindowVisible`
   flips to `false` after `CloseMainWindow()` while the process stays alive
   (`Responding: True`); `/api/health` continued returning 200 the entire time.

5. **Tray → Quit → process and sidecar gone, port free** — PARTIALLY VERIFIED.
   I could not reliably drive a literal click on the tray icon in this
   environment: Windows 11's notification-area icons are hosted in
   Explorer's XAML-island process, and both `mouse_event`/`SendInput`
   synthetic clicks and UI-Automation `Invoke` calls on the icons and taskbar
   elements had no effect (very likely UIPI / input-isolation between this
   automation's process and Explorer, or the icon living in a scrollable
   overflow surface I couldn't fully enumerate). What I *did* confirm:
   - `HKCU\Control Panel\NotifyIconSettings` has a live entry for our exe
     (`ExecutablePath` = our `circuit-ai-tool.exe`, `InitialTooltip` = "Circuit
     AI Tool", with an `IconSnapshot`), proving `TrayIconBuilder::build()`
     succeeded (a failure there would `?`-propagate out of `setup()` and the
     app wouldn't have started at all — but it did, repeatedly, cleanly).
   - `tray.rs`'s `"quit"` branch calls `app.exit(0)`, and `main.rs`'s
     `RunEvent::ExitRequested` handler only calls `prevent_exit()` when
     `code.is_none()` — this is a verbatim copy of the reference
     implementation's tested gate, so `Some(0)` from Quit passes through
     un-vetoed, and `RunEvent::Exit` then calls `Backend::kill()`.
   I'd recommend a human (or a session with real desktop input access) click
   Quit once to close the loop; I'm confident in the code but didn't watch it
   happen.

6. **Relaunch, then `Stop-Process -Force` on the shell → sidecar also dies** —
   PASS, cleanly, and this is the one I'd weight most heavily (explicit
   crash-safety property):
   ```
   Before kill:
      Id ProcessName
      -- -----------
   46516 circuit-ai-tool
   44592 circuit-server

   Stop-Process -Id 46516 -Force

   After kill:
   circuit-server.exe: GONE (Job Object worked)
   port 8765: not listening (free)
   ```

7. **Second instance focuses the existing window instead of starting a new
   one** — PASS. Running `circuit-ai-tool.exe` a second time while the first
   was live did not persist as a second process; the existing window's
   visibility round-tripped hidden → visible (`MainWindowTitle` went from the
   internal single-instance helper window's title back to `"Circuit AI Tool"`),
   confirming the single-instance plugin's callback correctly invoked
   `window::open()`'s re-show path.

8. **Measured launch-to-content time**:
   - **Cold-launching the compiled debug exe directly** (process spawn →
     `/api/health` 200, the best proxy for a packaged app's real startup):
     **1.82 s**. Window creation itself adds negligible time after that
     (`run_on_main_thread` + `WebviewWindowBuilder`, sub-200 ms typically).
   - Via `bunx tauri dev` end-to-end (includes `bunx`/`cargo` incremental-build
     orchestration, not representative of the packaged app): ~8.7 s, of which
     ~8.8 s was the incremental `cargo build` itself.
   - One-time first-ever `cargo build` (crate compilation, not a steady-state
     cost): 1 m 38 s.

## A real blocker I hit and how it resolved

Partway through, port 8765 was already held by another `bun.exe` process
(`bun run start` → `server/index.ts`, PID 41332) — almost certainly the
teammate working on `server/`. My sidecar's first bind attempt hit
`EADDRINUSE` and exited (visible in `server.log`); the window still opened
and showed real content because the *other* process was answering
`/api/health`, which would have made items 5/6 (Quit, Job-Object kill) test
nothing real, since my own sidecar was never actually running. I flagged this
to team-lead and paused those two checks. The port freed itself a few minutes
later (I didn't touch anything in `server/` or kill anyone else's process); I
did a clean restart and all the numbers above are from that clean run.

## Not done

Per the instructions, I did not run `bunx tauri build` (the full NSIS
installer) — I judged item 5's caveat (not independently GUI-verified, even
though I'm confident in the code) as reason enough to hold off and let you
decide, rather than assume "everything above passes." Happy to run it on
request; the config (`bundle.active: true`, `targets: ["nsis"]`) is in place
and ready.

## Files

- `circut-ai-tool/src-tauri/**` (Cargo.toml, build.rs, tauri.conf.json,
  capabilities/default.json, src/{main,config,backend,health,window,tray}.rs,
  ui/index.html, icons/)
- `circut-ai-tool/scripts/build-sidecar.ts`
- `circut-ai-tool/package.json` (scripts + `@tauri-apps/cli` devDependency only)
- `circut-ai-tool/bun.lock`
- `circut-ai-tool/.gitignore` (new — excludes `src-tauri/target|binaries|resources`)

# Circuit AI Tool Docker Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Circuit AI Tool as a Docker image and compose service on host port 8765 that behaves like `bun start` on Windows, including reload-on-save, PNG export, the tunnel button, and the existing Claude Code MCP registration.

**Architecture:** One image built on KiCad's official `kicad/kicad:9.0.9` (kicad-cli plus symbol libraries) with the `bun` binary copied in from `oven/bun:1.3`; the web client is built in a separate stage. Eight small, platform-neutral server changes make the same code run on Windows and in the container: platform-aware config defaults, PATH-aware kicad-cli detection, a polling file watcher (Docker Desktop never forwards inotify for Windows bind mounts), host-to-container path mapping for MCP clients on the host, a Linux PNG font, PATH lookup for cloudflared, and Docker-aware connect snippets. A compose file mounts the KiCad projects folder at `/projects` and keeps `/data` in a named volume.

**Tech Stack:** Bun 1.3, Hono, `@modelcontextprotocol/sdk`, `@resvg/resvg-js`, KiCad 9.0.9 kicad-cli, Docker 28 / Compose 2.40 (Docker Desktop, WSL2 backend), `bun test`.

**Spec:** `circut-ai-tool/docs/superpowers/specs/2026-09-06-docker-design.md`

## Global Constraints

- All paths below are relative to `circut-ai-tool/` (note the repo's spelling). Run every command from that folder.
- Windows behaviour must not change: every default that exists today for `win32` stays byte-identical; new behaviour is reached only through new environment variables or the `linux` platform.
- Base images are pinned: `kicad/kicad:9.0.9`, `oven/bun:1.3`. Bump deliberately, never with `latest`.
- Host port 8765 is bound to loopback only (`127.0.0.1:8765:8765`).
- The container runs as the base image's `kicad` user (uid 1000), never root.
- `bun test` (132 tests today) and `bun run typecheck` must pass on Windows after every task. Run both before each commit.
- New environment variables and their meanings, copied from the spec: `KICAD_SYM_LIB_TABLE` (path of the global sym-lib-table), `CIRCUIT_WATCH_POLL_MS` (poll interval; 0 means use `fs.watch`), `CIRCUIT_PATH_MAP` (`hostPrefix=containerPrefix;...`), `CIRCUIT_PNG_FONT` (font family for PNG export), `CIRCUIT_CONTAINER` (container name; switches snippets to `docker exec`).
- Tests use `bun:test`, temp folders from `mkdtempSync(path.join(tmpdir(), ...))`, and the existing `fakeKicad` double; never the real kicad-cli unless guarded by `skipIf` as the existing tests do.
- Do not touch `src-tauri/` or `scripts/build-sidecar.ts`.
- Removing the old `circuit-designer-circuit-designer-1` container (Task 7, step 1) is destructive and needs the user's explicit yes in chat first.

---

### Task 1: Platform-aware configuration

**Files:**
- Modify: `server/config.ts` (whole file)
- Modify: `server/libraries.ts:44` (default table path)
- Modify: `server/png.ts:27` (font family)
- Create: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `platformDefaults(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): Defaults` and new exports from `server/config.ts`: `KICAD_SYM_LIB_TABLE: string`, `PNG_FONT: string`, `WATCH_POLL_MS: number`, `PATH_MAP: string`, `CONTAINER: string | null`. Every existing export keeps its name and type.

- [ ] **Step 1: Write the failing test**

Create `test/config.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { platformDefaults } from '../server/config.ts';

describe('platformDefaults', () => {
  test('windows: KiCad under LOCALAPPDATA, table under APPDATA, Consolas', () => {
    const d = platformDefaults('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me');
    expect(d.kicadCli).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\KiCad\\9.0\\bin\\kicad-cli.exe');
    expect(d.kicadSymbolDir).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\KiCad\\9.0\\share\\kicad\\symbols');
    expect(d.symLibTable).toBe('C:\\Users\\me\\AppData\\Roaming\\kicad\\9.0\\sym-lib-table');
    expect(d.dataDir).toBe('C:\\Users\\me\\AppData\\Local\\UniversityTools\\circuit');
    expect(d.projectsDir).toBe('C:\\Users\\me\\Documents\\KiCad\\9.0\\projects');
    expect(d.pngFont).toBe('Consolas');
  });

  test('windows without LOCALAPPDATA and APPDATA derives them from home', () => {
    const d = platformDefaults('win32', {}, 'C:\\Users\\me');
    expect(d.kicadCli).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\KiCad\\9.0\\bin\\kicad-cli.exe');
    expect(d.symLibTable).toBe('C:\\Users\\me\\AppData\\Roaming\\kicad\\9.0\\sym-lib-table');
  });

  test('linux: kicad-cli on PATH, /usr/share/kicad, XDG folders, DejaVu Sans Mono', () => {
    const d = platformDefaults('linux', {}, '/home/kicad');
    expect(d.kicadCli).toBe('kicad-cli');
    expect(d.kicadSymbolDir).toBe('/usr/share/kicad/symbols');
    expect(d.symLibTable).toBe('/home/kicad/.config/kicad/9.0/sym-lib-table');
    expect(d.dataDir).toBe('/home/kicad/.local/share/university-tools/circuit');
    expect(d.projectsDir).toBe('/home/kicad/KiCad/9.0/projects');
    expect(d.pngFont).toBe('DejaVu Sans Mono');
  });

  test('linux honours XDG_CONFIG_HOME and XDG_DATA_HOME', () => {
    const d = platformDefaults('linux', { XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/dat' }, '/home/kicad');
    expect(d.symLibTable).toBe('/cfg/kicad/9.0/sym-lib-table');
    expect(d.dataDir).toBe('/dat/university-tools/circuit');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/config.test.ts`
Expected: FAIL, `platformDefaults` is not exported from `../server/config.ts`.

- [ ] **Step 3: Rewrite `server/config.ts`**

Replace the whole file with:

```ts
// Runtime settings. Environment variables override the defaults; the defaults
// depend on the platform (Windows laptop or Linux container), see platformDefaults.

import os from 'node:os';
import path from 'node:path';

export interface Defaults {
  kicadCli: string;
  kicadSymbolDir: string;
  symLibTable: string;
  dataDir: string;
  projectsDir: string;
  pngFont: string;
}

/**
 * Pure so a test can check both platforms on one machine; joins with the
 * platform's own path module for the same reason.
 */
export function platformDefaults(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): Defaults {
  if (platform === 'win32') {
    const j = path.win32.join;
    const localAppData = env.LOCALAPPDATA ?? j(home, 'AppData', 'Local');
    const appData = env.APPDATA ?? j(home, 'AppData', 'Roaming');
    const kicadRoot = j(localAppData, 'Programs', 'KiCad', '9.0');
    return {
      kicadCli: j(kicadRoot, 'bin', 'kicad-cli.exe'),
      kicadSymbolDir: j(kicadRoot, 'share', 'kicad', 'symbols'),
      symLibTable: j(appData, 'kicad', '9.0', 'sym-lib-table'),
      dataDir: j(localAppData, 'UniversityTools', 'circuit'),
      projectsDir: j(home, 'Documents', 'KiCad', '9.0', 'projects'),
      pngFont: 'Consolas',
    };
  }
  const j = path.posix.join;
  const configHome = env.XDG_CONFIG_HOME ?? j(home, '.config');
  const dataHome = env.XDG_DATA_HOME ?? j(home, '.local', 'share');
  return {
    kicadCli: 'kicad-cli',
    kicadSymbolDir: '/usr/share/kicad/symbols',
    symLibTable: j(configHome, 'kicad', '9.0', 'sym-lib-table'),
    dataDir: j(dataHome, 'university-tools', 'circuit'),
    projectsDir: j(home, 'KiCad', '9.0', 'projects'),
    pngFont: 'DejaVu Sans Mono',
  };
}

const d = platformDefaults(process.platform, process.env, os.homedir());

export const PORT = Number(process.env.CIRCUIT_PORT ?? 8765);
export const HOST = process.env.CIRCUIT_HOST ?? '127.0.0.1';
export const PUBLIC_URL = process.env.CIRCUIT_PUBLIC_URL ?? `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
export const APP_NAME = 'circuit-ai-tool';
export const APP_VERSION = '0.1.0';

export const KICAD_CLI = process.env.KICAD_CLI ?? d.kicadCli;
export const KICAD_SYMBOL_DIR = process.env.KICAD_SYMBOL_DIR ?? d.kicadSymbolDir;
export const KICAD_SYM_LIB_TABLE = process.env.KICAD_SYM_LIB_TABLE ?? d.symLibTable;
export const DATA_DIR = process.env.DATA_DIR ?? d.dataDir;
export const PROJECTS_DIR = process.env.PROJECTS_DIR ?? d.projectsDir;
export const PNG_FONT = process.env.CIRCUIT_PNG_FONT ?? d.pngFont;

/** Poll the open schematic every N ms instead of relying on inotify (0 = fs.watch). Docker Desktop bind mounts of Windows folders need this. */
export const WATCH_POLL_MS = Math.max(0, Number(process.env.CIRCUIT_WATCH_POLL_MS ?? 0) || 0);
/** "hostPrefix=containerPrefix;..." rewrites paths sent by clients on the host (see projects.ts parsePathMap). */
export const PATH_MAP = process.env.CIRCUIT_PATH_MAP ?? '';
/** Container name when running under Docker; switches the connect snippets to `docker exec`. */
export const CONTAINER = process.env.CIRCUIT_CONTAINER || null;

// Both must be overridable by environment: under `bun build --compile`,
// import.meta.dir resolves inside Bun's virtual filesystem (B:\~BUN\...), so a
// packaged build would serve nothing. The desktop shell passes STATIC_DIR.
export const PROJECT_ROOT = process.env.PROJECT_ROOT ?? path.resolve(import.meta.dir, '..');
export const DIST_DIR = process.env.STATIC_DIR ?? path.join(PROJECT_ROOT, 'dist');

/** Set by the desktop shell to its own sidecar path, for the stdio MCP snippet. */
export const PACKAGED_EXE = process.env.CIRCUIT_EXE ?? null;
```

- [ ] **Step 4: Use the new defaults in `libraries.ts` and `png.ts`**

In `server/libraries.ts`, add the import and change the default table path:

```ts
import { KICAD_SYM_LIB_TABLE } from './config.ts';
```

and in `findLibraryFile` replace

```ts
  const table = opts.tableFile ?? path.join(process.env.APPDATA ?? '', 'kicad', '9.0', 'sym-lib-table');
```

with

```ts
  const table = opts.tableFile ?? KICAD_SYM_LIB_TABLE;
```

In `server/png.ts`, add `import { PNG_FONT } from './config.ts';` at the top and change the render options line to:

```ts
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: width }, background: '#F6F4EE', font: { loadSystemFonts: true, defaultFontFamily: PNG_FONT, monospaceFamily: PNG_FONT } });
```

(`monospaceFamily` is what resvg uses for the generic `monospace` at the end of the SVG's `ui-monospace, Consolas, monospace` stack.)

- [ ] **Step 5: Run the tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: 136 pass (132 + 4 new), typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/config.ts server/libraries.ts server/png.ts test/config.test.ts
git commit -m "feat(circuit): platform-aware config defaults for Linux containers"
```

---

### Task 2: PATH-aware kicad-cli detection

**Files:**
- Modify: `server/kicad-cli.ts:61-68` (`available()`)
- Test: `test/kicad-cli.test.ts`

**Interfaces:**
- Consumes: `createKicadCli({ exe, cacheDir })` as it exists.
- Produces: `available()` returns true for a bare command name that is on PATH (Linux default `kicad-cli`).

- [ ] **Step 1: Write the failing test**

Add inside the `describe('createKicadCli', ...)` block of `test/kicad-cli.test.ts`, after the first test:

```ts
  test('a bare command name is resolved through PATH', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'kc-'));
    // `bun` is always on PATH while the tests run under bun.
    expect(await createKicadCli({ exe: 'bun', cacheDir }).available()).toBe(true);
    expect(await createKicadCli({ exe: 'no-such-command-for-circuit-tests', cacheDir }).available()).toBe(false);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/kicad-cli.test.ts`
Expected: FAIL on the first expectation (`access('bun')` fails because it is not a path).

- [ ] **Step 3: Resolve bare names with `Bun.which`**

In `server/kicad-cli.ts` replace the `available()` method:

```ts
    async available() {
      // A bare command name (the Linux default) is looked up on PATH the way execFile will.
      const resolved = path.basename(exe) === exe ? Bun.which(exe) : exe;
      if (!resolved) return false;
      try {
        await access(resolved);
        return true;
      } catch {
        return false;
      }
    },
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: 137 pass, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/kicad-cli.ts test/kicad-cli.test.ts
git commit -m "fix(circuit): detect kicad-cli on PATH, not only by absolute path"
```

---

### Task 3: Polling file watcher

**Files:**
- Modify: `server/watch.ts:27-43` (`watchFile`)
- Modify: `server/service.ts:48-55` (`ServiceDeps`) and `server/service.ts:130-142` (`startWatch`)
- Modify: `server/boot.ts`
- Test: `test/projects.test.ts`, `test/service.test.ts`

**Interfaces:**
- Consumes: `WATCH_POLL_MS` from Task 1.
- Produces: `watchFile(file: string, onChange: () => void, opts?: number | { debounceMs?: number; pollMs?: number }): () => void`. The numeric form keeps meaning `debounceMs` for existing callers. `ServiceDeps.watchPollMs?: number`.

- [ ] **Step 1: Write the failing watcher test**

Append to the `describe('Events and watchFile', ...)` block in `test/projects.test.ts`:

```ts
  test('polling mode notices a change without inotify and stops cleanly', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'poll-'));
    const file = path.join(dir, 'x.kicad_sch');
    writeFileSync(file, '(kicad_sch)');
    let hits = 0;
    const stop = watchFile(file, () => hits++, { debounceMs: 50, pollMs: 100 });
    await new Promise((r) => setTimeout(r, 250));
    writeFileSync(file, '(kicad_sch changed)');
    await new Promise((r) => setTimeout(r, 600));
    expect(hits).toBe(1);
    stop();
    writeFileSync(file, '(kicad_sch changed again)');
    await new Promise((r) => setTimeout(r, 400));
    expect(hits).toBe(1);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run typecheck`
Expected: FAIL with `TS2345` in `test/projects.test.ts`: an object is not assignable to the `debounceMs: number` parameter. (Do not use `bun test` as the red step here: it does not typecheck, and on Windows `fs.watch` fires for the temp folder, so the test could pass before polling exists.)

- [ ] **Step 3: Implement polling in `watch.ts`**

Replace the import line and the `watchFile` function in `server/watch.ts`:

```ts
import { statSync, watch } from 'node:fs';
import path from 'node:path';
```

```ts
export interface WatchOptions {
  /** Quiet time after the last change before onChange fires. */
  debounceMs?: number;
  /**
   * When > 0, poll the file's mtime and size every pollMs instead of using
   * fs.watch. Needed where inotify never fires, such as Docker Desktop bind
   * mounts of Windows folders.
   */
  pollMs?: number;
}

export function watchFile(file: string, onChange: () => void, opts: number | WatchOptions = {}): () => void {
  const { debounceMs = 300, pollMs = 0 } = typeof opts === 'number' ? { debounceMs: opts } : opts;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  };
  const stopTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  if (pollMs > 0) {
    // One stat per interval; "missing" is a state too, so a delete-and-recreate
    // (KiCad's save strategy) counts as a change on both transitions.
    const snapshot = (): string => {
      try {
        const s = statSync(file);
        return `${s.mtimeMs}:${s.size}`;
      } catch {
        return 'missing';
      }
    };
    let last = snapshot();
    const poll = setInterval(() => {
      const now = snapshot();
      if (now !== last) fire();
      last = now;
    }, pollMs);
    poll.unref?.(); // like persistent: false above: never keep the process alive
    return () => {
      stopTimer();
      clearInterval(poll);
    };
  }

  const dir = path.dirname(file);
  const base = path.basename(file);
  const watcher = watch(dir, { persistent: false }, (_event, filename) => {
    if (filename && String(filename) !== base) return;
    fire();
  });
  return () => {
    stopTimer();
    watcher.close();
  };
}
```

Keep the `Events` class and the file header comment as they are; extend the header's second sentence with: "With `pollMs` it polls instead, for mounts that never emit inotify events."

- [ ] **Step 4: Run the watcher test**

Run: `bun test test/projects.test.ts`
Expected: PASS (both watcher tests).

- [ ] **Step 5: Write the failing service test**

In `test/service.test.ts` change `makeService` to accept the poll interval:

```ts
export async function makeService(opts: { watch?: boolean; watchPollMs?: number } = {}) {
```

and pass it into the constructor call, after `watch: opts.watch ?? false,`:

```ts
watchPollMs: opts.watchPollMs,
```

Then add a test inside `describe('Service', ...)`:

```ts
  test('reloads through the polling watcher when asked', async () => {
    const { service, sch, events } = await makeService({ watch: true, watchPollMs: 100 });
    const p = await service.open(sch);
    const got = new Promise<ProjectEvent>((resolve) => events.subscribe((e) => e.projectId === p.info.id && resolve(e)));
    await new Promise((r) => setTimeout(r, 250));
    writeFileSync(sch, `${readFileSync(sch, 'utf8')}\n`);
    const ev = await Promise.race([got, new Promise<ProjectEvent>((_, reject) => setTimeout(() => reject(new Error('no event within 3 s')), 3000))]);
    expect(ev.type).toBe('changed');
    service.close(p.info.id);
  });
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `bun run typecheck`
Expected: FAIL with `TS2353` in `test/service.test.ts`: `watchPollMs` does not exist in type `ServiceDeps`. (Again the typecheck is the red step: `bun test` would ignore the unknown property and `fs.watch` may deliver the event on Windows anyway.)

- [ ] **Step 7: Thread `watchPollMs` through `Service` and `boot.ts`**

In `server/service.ts` add to `ServiceDeps`:

```ts
  /** Poll interval for the schematic watcher; 0 or undefined uses fs.watch. */
  watchPollMs?: number;
```

and in `startWatch` change the `watchFile(...)` call to pass the option:

```ts
      watchFile(
        file,
        () => {
          this.refresh(id)
            .then(() => this.deps.events.emit({ projectId: id, type: 'changed' }))
            .catch((e) => this.deps.events.emit({ projectId: id, type: 'error', message: (e as Error).message }));
        },
        { pollMs: this.deps.watchPollMs ?? 0 },
      ),
```

In `server/boot.ts` import `WATCH_POLL_MS` from `./config.ts` and add `watchPollMs: WATCH_POLL_MS` to the `new Service({...})` call.

- [ ] **Step 8: Run the tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: 139 pass, typecheck exit 0.

- [ ] **Step 9: Commit**

```bash
git add server/watch.ts server/service.ts server/boot.ts test/projects.test.ts test/service.test.ts
git commit -m "feat(circuit): optional polling file watcher for Docker bind mounts"
```

---

### Task 4: Host-to-container path mapping

**Files:**
- Modify: `server/projects.ts` (add two functions after `normalizePath`)
- Modify: `server/service.ts:48-55` (`ServiceDeps`), `server/service.ts:98-109` (`open`), `server/service.ts:111-118` (`load` 404)
- Modify: `server/boot.ts`
- Modify: `server/mcp.ts:22` and `server/mcp.ts:68` (wording only)
- Test: `test/projects.test.ts`, `test/service.test.ts`

**Interfaces:**
- Consumes: `PATH_MAP` from Task 1.
- Produces: `interface PathMapping { host: string; container: string }`, `parsePathMap(spec: string): PathMapping[]`, `mapHostPath(p: string, map: PathMapping[]): string`, `ServiceDeps.pathMap?: PathMapping[]`.

- [ ] **Step 1: Write the failing mapping tests**

Add to the imports of `test/projects.test.ts`: `mapHostPath, parsePathMap` (from `../server/projects.ts`). Append a new describe block:

```ts
describe('path mapping', () => {
  const map = parsePathMap('C:\\Users\\me\\Documents\\KiCad\\9.0\\projects=/projects; D:/labs/=/labs ;bad;=/x;C:/Users/me/Documents=/docs');

  test('parses, normalises and sorts longest host prefix first', () => {
    expect(map).toEqual([
      { host: 'C:/Users/me/Documents/KiCad/9.0/projects', container: '/projects' },
      { host: 'C:/Users/me/Documents', container: '/docs' },
      { host: 'D:/labs', container: '/labs' },
    ]);
  });

  test('rewrites matching prefixes case-insensitively, with either slash', () => {
    expect(mapHostPath('c:\\users\\ME\\documents\\kicad\\9.0\\projects\\PL1_1\\PL1_1.kicad_sch', map)).toBe('/projects/PL1_1/PL1_1.kicad_sch');
    expect(mapHostPath('C:/Users/me/Documents/other/x.kicad_sch', map)).toBe('/docs/other/x.kicad_sch');
    expect(mapHostPath('D:/labs/a.kicad_sch', map)).toBe('/labs/a.kicad_sch');
    expect(mapHostPath('C:/Users/me/Documents/KiCad/9.0/projects', map)).toBe('/projects');
  });

  test('leaves ids, container paths and unmapped paths alone', () => {
    expect(mapHostPath('365480e020', map)).toBe('365480e020');
    expect(mapHostPath('/projects/PL1_1/PL1_1.kicad_sch', map)).toBe('/projects/PL1_1/PL1_1.kicad_sch');
    expect(mapHostPath('C:/Users/me/Documents2/x.kicad_sch', map)).toBe('C:/Users/me/Documents2/x.kicad_sch');
    expect(mapHostPath('E:/x.kicad_sch', [])).toBe('E:/x.kicad_sch');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/projects.test.ts`
Expected: FAIL, `parsePathMap`/`mapHostPath` are not exported.

- [ ] **Step 3: Implement the two functions in `projects.ts`**

Add after `export const normalizePath = ...` in `server/projects.ts`:

```ts
export interface PathMapping {
  host: string;
  container: string;
}

/**
 * Parse CIRCUIT_PATH_MAP: "hostPrefix=containerPrefix;hostPrefix2=...". Host
 * prefixes are normalised to forward slashes, trailing slashes are dropped on
 * both sides, malformed entries are ignored. Sorted longest host prefix first
 * so the most specific mapping wins in mapHostPath.
 */
export function parsePathMap(spec: string): PathMapping[] {
  const out: PathMapping[] = [];
  for (const entry of spec.split(';')) {
    const i = entry.indexOf('=');
    if (i <= 0) continue;
    const host = entry.slice(0, i).trim().replace(/\\/g, '/').replace(/\/+$/, '');
    const container = entry.slice(i + 1).trim().replace(/\/+$/, '');
    if (host && container) out.push({ host, container });
  }
  return out.sort((a, b) => b.host.length - a.host.length);
}

/**
 * Rewrite a path sent by a client on the host (drive letter, backslashes) into
 * the container path. Case-insensitive on the host side. Unchanged when no
 * prefix matches, so ids and container paths pass through.
 */
export function mapHostPath(p: string, map: PathMapping[]): string {
  if (map.length === 0) return p;
  const norm = p.replace(/\\/g, '/');
  const lower = norm.toLowerCase();
  for (const m of map) {
    const h = m.host.toLowerCase();
    if (lower === h) return m.container;
    if (lower.startsWith(`${h}/`)) return m.container + norm.slice(m.host.length);
  }
  return p;
}
```

- [ ] **Step 4: Run the mapping tests**

Run: `bun test test/projects.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing service test**

In `test/service.test.ts` extend `makeService` once more:

```ts
export async function makeService(opts: { watch?: boolean; watchPollMs?: number; pathMap?: PathMapping[] } = {}) {
```

import `type PathMapping, normalizePath` from `../server/projects.ts` (the file already imports `ProjectRegistry, sidecarPath` from there), and pass `pathMap: opts.pathMap,` into the `new Service({...})` call. Add a test:

```ts
  test('maps host paths into the projects folder when a path map is set', async () => {
    const { service, work } = await makeService({ pathMap: [{ host: 'Z:/host/projects', container: work.replace(/\\/g, '/') }] });
    const p = await service.open('Z:\\host\\projects\\PL1_1.kicad_sch');
    expect(p.info.name).toBe('PL1_1');
    expect(p.info.path).toBe(normalizePath(path.join(work, 'PL1_1.kicad_sch')));
    await expect(service.open('Z:/elsewhere/PL1_1.kicad_sch')).rejects.toThrow(/host paths are mapped: Z:\/host\/projects -> /);
  });
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `bun test test/service.test.ts`
Expected: FAIL: `service.open` rejects with `schematic not found: Z:/host/projects/PL1_1.kicad_sch` because nothing maps the path yet.

- [ ] **Step 7: Apply the map in `Service` and wire `boot.ts`**

In `server/service.ts`:

Import: change the `./projects.ts` import to also bring `mapHostPath` and `type PathMapping`:

```ts
import { importSchematic, mapHostPath, normalizePath, projectId, readSidecar, scanProjects, writeSidecar, type PathMapping, type ProjectInfo, type ProjectRegistry } from './projects.ts';
```

`ServiceDeps` gains:

```ts
  /** Host-to-container prefixes applied to paths clients send (CIRCUIT_PATH_MAP). */
  pathMap?: PathMapping[];
```

In `open()` replace

```ts
    const file = normalizePath(remembered ? remembered.path : pathOrId);
```

with

```ts
    const file = normalizePath(remembered ? remembered.path : mapHostPath(pathOrId, this.deps.pathMap ?? []));
```

In `load()` replace the catch of the `stat` call:

```ts
    } catch {
      const map = this.deps.pathMap ?? [];
      const hint = map.length ? ` (host paths are mapped: ${map.map((m) => `${m.host} -> ${m.container}`).join(', ')})` : '';
      throw new ServiceError(`schematic not found: ${file}${hint}`, 404);
    }
```

In `server/boot.ts` import `PATH_MAP` from `./config.ts` and `parsePathMap` from `./projects.ts`, and add `pathMap: parsePathMap(PATH_MAP)` to the `new Service({...})` call.

In `server/mcp.ts` change the two descriptions so Claude knows Windows paths are fine:

- line 22: `'Project id from open_schematic, or the absolute path of the .kicad_sch (a Windows path is accepted when the server runs in Docker with CIRCUIT_PATH_MAP).'`
- line 68, the `path` input: `'Absolute path to the .kicad_sch (a Windows path is accepted when the server runs in Docker with CIRCUIT_PATH_MAP), or a project id'`

- [ ] **Step 8: Run the tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: 143 pass, typecheck exit 0.

- [ ] **Step 9: Commit**

```bash
git add server/projects.ts server/service.ts server/boot.ts server/mcp.ts test/projects.test.ts test/service.test.ts
git commit -m "feat(circuit): map host paths to container paths via CIRCUIT_PATH_MAP"
```

---

### Task 5: cloudflared from PATH

**Files:**
- Modify: `server/tunnel.ts:44-63` (`ensureBinary`)
- Create: `test/tunnel.test.ts`

**Interfaces:**
- Produces: `findCloudflared(dir: string, which?: (name: string) => string | null): Promise<string | null>`; `ensureBinary` behaviour: downloaded copy, then PATH, then download (Windows only), else a clear error.

- [ ] **Step 1: Write the failing test**

Create `test/tunnel.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findCloudflared } from '../server/tunnel.ts';

const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';

describe('findCloudflared', () => {
  test('prefers the downloaded copy, then PATH, else null', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cf-'));
    expect(await findCloudflared(dir, () => null)).toBeNull();
    expect(await findCloudflared(dir, () => '/usr/local/bin/cloudflared')).toBe('/usr/local/bin/cloudflared');
    writeFileSync(path.join(dir, exe), '');
    expect(await findCloudflared(dir, () => '/usr/local/bin/cloudflared')).toBe(path.join(dir, exe));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/tunnel.test.ts`
Expected: FAIL, `findCloudflared` is not exported.

- [ ] **Step 3: Implement the lookup**

In `server/tunnel.ts` replace the start of `ensureBinary` with a new exported helper plus the changed guard:

```ts
/** The cloudflared to run: a copy downloaded earlier into DATA_DIR/bin, else one on PATH, else null. */
export async function findCloudflared(dir: string, which: (name: string) => string | null = (n) => Bun.which(n)): Promise<string | null> {
  const exe = path.join(dir, exeName);
  if (await exists(exe)) return exe;
  return which(exeName);
}

/** Download cloudflared to `dir` if it is neither there nor on PATH. Returns its path. */
async function ensureBinary(dir: string): Promise<string> {
  const found = await findCloudflared(dir);
  if (found) return found;
  if (process.platform !== 'win32') throw new Error('cloudflared is not installed; put it on PATH (the Docker image ships it at /usr/local/bin/cloudflared)');
  const exe = path.join(dir, exeName);
  await mkdir(dir, { recursive: true });
  const res = await fetch(DOWNLOAD_URL, { redirect: 'follow' });
```

The rest of `ensureBinary` (temp-file write, rename, error cleanup, `return exe`) stays as it is.

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: 144 pass, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/tunnel.ts test/tunnel.test.ts
git commit -m "feat(circuit): use cloudflared from PATH when present"
```

---

### Task 6: Docker-aware connect snippets and projects folder hint

**Files:**
- Modify: `server/connect.ts` (whole `buildConnectInfo`)
- Modify: `server/service.ts:83-85` (`list()`)
- Modify: `client/api.ts:38-41` (`ProjectLists`)
- Modify: `client/main.ts:46` and `client/main.ts:87-90` (placeholder)
- Create: `test/connect.test.ts`
- Test: `test/service.test.ts`

**Interfaces:**
- Consumes: `CONTAINER`, `PROJECTS_DIR` from Task 1.
- Produces: `buildConnectInfo(publicUrl?: string, ctx?: { container: string | null; projectsDir: string })`; the return object gains `container` and `projectsDir`. `Service.list()` returns `{ recent, found, projectsDir }`.

- [ ] **Step 1: Write the failing connect test**

Create `test/connect.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { buildConnectInfo } from '../server/connect.ts';

const find = (info: ReturnType<typeof buildConnectInfo>, id: string) => info.snippets.find((s) => s.id === id)!;

describe('buildConnectInfo', () => {
  test('inside Docker the stdio snippets go through docker exec and the example path is the mounted folder', () => {
    const info = buildConnectInfo('http://localhost:8765', { container: 'circuit-ai-tool', projectsDir: '/projects' });
    expect(info.container).toBe('circuit-ai-tool');
    expect(info.stdioCommand).toBe('"docker" "exec" "-i" "circuit-ai-tool" "bun" "server/index.ts" "--stdio"');
    const desktop = JSON.parse(find(info, 'claude-desktop').code) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(desktop.mcpServers['circuit-ai-tool']).toEqual({ command: 'docker', args: ['exec', '-i', 'circuit-ai-tool', 'bun', 'server/index.ts', '--stdio'] });
    expect(find(info, 'claude-code').code).toContain('"docker" "exec" "-i" "circuit-ai-tool"');
    expect(find(info, 'chatgpt').code.startsWith('docker compose up -d')).toBe(true);
    expect(find(info, 'api').code).toContain('/projects/lab1/lab1.kicad_sch');
    expect(info.mcpAliasUrl).toBe('http://localhost:8765/mcp-server/mcp');
  });

  test('outside Docker nothing mentions docker and the example path is the local projects folder', () => {
    const info = buildConnectInfo('http://localhost:8765', { container: null, projectsDir: 'C:\\Users\\me\\Documents\\KiCad\\9.0\\projects' });
    expect(info.container).toBeNull();
    expect(info.stdioCommand).not.toContain('docker');
    expect(find(info, 'chatgpt').code.startsWith('bun start')).toBe(true);
    expect(find(info, 'api').code).toContain('C:/Users/me/Documents/KiCad/9.0/projects/lab1/lab1.kicad_sch');
    expect(find(info, 'claude-desktop').title).toContain('works even when this server is closed');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/connect.test.ts`
Expected: FAIL (`container` undefined; stdio command is bun plus a script path).

- [ ] **Step 3: Rewrite `buildConnectInfo`**

Replace the import and the function in `server/connect.ts` (keep `ConnectSnippet` and `TOOL_NAMES`):

```ts
import path from 'node:path';
import { APP_NAME, CONTAINER, PACKAGED_EXE, PROJECT_ROOT, PROJECTS_DIR, PUBLIC_URL } from './config.ts';
```

```ts
export interface ConnectContext {
  /** Docker container name when the server runs in a container; snippets then launch through `docker exec`. */
  container: string | null;
  /** Folder scanned for schematics; used for the example path. */
  projectsDir: string;
}

export function buildConnectInfo(publicUrl: string = PUBLIC_URL, ctx: ConnectContext = { container: CONTAINER, projectsDir: PROJECTS_DIR }) {
  // Docker: Claude Desktop on the host launches bun inside the running container.
  // Packaged: one executable that speaks stdio with --stdio. Dev: bun + the script.
  // PROJECT_ROOT/process.execPath are both meaningless inside a compiled binary.
  const stdioCommand = ctx.container ? 'docker' : (PACKAGED_EXE ?? process.execPath);
  const stdioArgs = ctx.container ? ['exec', '-i', ctx.container, 'bun', 'server/index.ts', '--stdio'] : PACKAGED_EXE ? ['--stdio'] : [path.join(PROJECT_ROOT, 'server', 'mcp-stdio.ts')];
  const stdioLine = `"${stdioCommand}" "${stdioArgs.join('" "')}"`;
  const startLine = ctx.container ? 'docker compose up -d' : 'bun start';
  const examplePath = `${ctx.projectsDir.replace(/\\/g, '/')}/lab1/lab1.kicad_sch`;
  const PUBLIC_URL = publicUrl;
  const mcpUrl = `${PUBLIC_URL}/mcp`;
  const openapiUrl = `${PUBLIC_URL}/openapi.json`;
  const snippets: ConnectSnippet[] = [
    { id: 'claude-desktop', title: ctx.container ? 'Claude Desktop (stdio through docker exec; the container must be running)' : 'Claude Desktop (stdio, works even when this server is closed)', how: 'Claude Desktop: Settings, Developer, Edit Config. Merge this into claude_desktop_config.json, save, then fully quit and reopen Claude Desktop.', language: 'json', code: JSON.stringify({ mcpServers: { [APP_NAME]: { command: stdioCommand, args: stdioArgs } } }, null, 2) },
    { id: 'claude-connector', title: 'Claude Desktop or claude.ai (custom connector over HTTP)', how: `Settings, Connectors, Add custom connector, paste this URL. Needs the server running (${startLine}). If only https is accepted, expose it with a tunnel (see ChatGPT) and paste the tunnel URL plus /mcp.`, language: 'text', code: mcpUrl },
    { id: 'claude-code', title: 'Claude Code', how: 'Run once in any terminal. The existing "circuit-designer" registration keeps working because /mcp-server/mcp is an alias of /mcp.', language: 'bash', code: [`claude mcp add --transport http ${APP_NAME} ${mcpUrl}`, `# or, without the web server running:`, `claude mcp add ${APP_NAME} -- ${stdioLine}`].join('\n') },
    { id: 'chatgpt', title: 'ChatGPT (desktop or web)', how: 'ChatGPT reaches MCP servers over the internet only. Expose the local server with a tunnel, then Settings, Connectors (Developer mode under Advanced), Create, paste the tunnel URL plus /mcp. The tunnel URL plus /openapi.json also works as a Custom GPT Action.', language: 'bash', code: [startLine, `# second terminal, either:`, `npx cloudflared tunnel --url ${PUBLIC_URL}`, `# or:`, `ngrok http ${PUBLIC_URL.replace(/^https?:\/\//, '')}`, `# then paste  https://<tunnel-host>/mcp  into ChatGPT`].join('\n') },
    { id: 'codex', title: 'Codex CLI', how: 'Register the running server.', language: 'bash', code: `codex mcp add ${APP_NAME} --url ${mcpUrl}` },
    { id: 'api', title: 'Plain HTTP', how: 'Open a schematic, then read the layout or the picture.', language: 'bash', code: [`curl -X POST ${PUBLIC_URL}/api/projects/open -H "content-type: application/json" -d "{\\"path\\": \\"${examplePath}\\"}"`, `curl ${PUBLIC_URL}/api/projects/<id>/layout`, `curl ${PUBLIC_URL}/api/projects/<id>/board.png -o board.png`, `curl ${openapiUrl}`].join('\n') },
  ];
  return { appUrl: PUBLIC_URL, mcpUrl, mcpAliasUrl: `${PUBLIC_URL}/mcp-server/mcp`, openapiUrl, stdioCommand: stdioLine, projectDir: PROJECT_ROOT, projectsDir: ctx.projectsDir, container: ctx.container, tools: TOOL_NAMES, snippets };
}
```

The Claude Code stdio line in Docker mode reads `claude mcp add circuit-ai-tool -- "docker" "exec" "-i" "circuit-ai-tool" "bun" "server/index.ts" "--stdio"`, which is what the test asserts.

- [ ] **Step 4: Run the connect test**

Run: `bun test test/connect.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing `list()` test**

In `test/service.test.ts`, in the test `'opens a schematic by path, then by id, and lists it'`, add after the `found` expectation:

```ts
    expect(list.projectsDir).toBe(work);
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `bun test test/service.test.ts`
Expected: FAIL, `projectsDir` is undefined.

- [ ] **Step 7: Return `projectsDir` from `list()` and use it in the client**

`server/service.ts` `list()`:

```ts
  async list() {
    return { recent: this.deps.registry.list(), found: await scanProjects(this.deps.projectsDir, 2), projectsDir: this.deps.projectsDir };
  }
```

`client/api.ts`, `ProjectLists`:

```ts
export interface ProjectLists {
  recent: { id: string; name: string; path: string; lastOpened: string }[];
  found: { path: string; name: string }[];
  /** Folder the server scans; shown as the example in the "open in place" field. */
  projectsDir: string;
}
```

`client/main.ts` line 46: change the static placeholder to `placeholder="absolute path to a .kicad_sch"`. Then, right after `const lists = await api.list();` (line 88), add:

```ts
    const sep = lists.projectsDir.includes('\\') ? '\\' : '/';
    form.querySelector<HTMLInputElement>('input[name=path]')!.placeholder = `${lists.projectsDir}${sep}lab1${sep}lab1.kicad_sch`;
```

- [ ] **Step 8: Run the tests, typecheck and the client build**

Run: `bun test && bun run typecheck && bun run build`
Expected: 146 pass, typecheck exit 0, Vite writes `dist/`.

- [ ] **Step 9: Check the UI by hand**

Run: `bun start`, open `http://127.0.0.1:8765/`. The "open in place" field shows `C:\Users\rober\Documents\KiCad\9.0\projects\lab1\lab1.kicad_sch` as its placeholder. Open `#/connect`: the Claude Desktop snippet still shows the bun command (no docker). Stop the server.

- [ ] **Step 10: Commit**

```bash
git add server/connect.ts server/service.ts client/api.ts client/main.ts test/connect.test.ts test/service.test.ts
git commit -m "feat(circuit): docker-aware connect snippets and projects folder hint"
```

---

### Task 7: Dockerfile, compose file, first container start

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `docker-compose.yml`
- Create: `.env.example`

**Interfaces:**
- Consumes: every env var from Task 1 and the behaviour from Tasks 2 to 6.
- Produces: image `circuit-ai-tool:latest`, container `circuit-ai-tool`, `http://localhost:8765` on the host.

- [ ] **Step 1: Retire the old container (needs the user's explicit yes)**

Ask in chat before running anything: "The old `circuit-designer-circuit-designer-1` container is crash-looping and holds host port 8765. OK to remove it (and its 2.49 GB image)? Its Desktop bind-mount folders are empty." Only after a yes:

```bash
docker rm -f circuit-designer-circuit-designer-1
docker rmi circuit-designer-circuit-designer
```

Also make sure no dev server holds the port: `netstat -ano | grep ':8765.*LISTENING'` must print nothing (stop any `bun start` first).

- [ ] **Step 2: Write `.dockerignore`**

```
node_modules
dist
src-tauri
docs
.data
.git
.vite
*.md
```

- [ ] **Step 3: Write `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
# Circuit AI Tool: bun server + kicad-cli in one image.
# Design: docs/superpowers/specs/2026-09-06-docker-design.md

# ---- client: build the web UI ------------------------------------------------
FROM oven/bun:1.3 AS client
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ---- runtime: KiCad's own image (kicad-cli + symbol libraries) plus bun -------
FROM kicad/kicad:9.0.9 AS runtime
USER root
COPY --from=oven/bun:1.3 /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# cloudflared for the Tunnel button. The base image has no curl; bun fetches it.
RUN bun -e "fetch('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64').then(r => { if (!r.ok) throw new Error('cloudflared download failed: ' + r.status); return Bun.write('/usr/local/bin/cloudflared', r); })" \
 && chmod 755 /usr/local/bin/cloudflared \
 && /usr/local/bin/cloudflared --version
# The base image gives its user passwordless sudo; a web server does not need it.
# Both steps are conditional so a future base image without sudo still builds.
RUN if id -nG kicad | grep -qw sudo; then gpasswd -d kicad sudo; fi \
 && if [ -f /etc/sudoers ]; then sed -i '/NOPASSWD/d' /etc/sudoers; fi
RUN mkdir -p /app /data /projects && chown kicad:kicad /app /data /projects
USER kicad
WORKDIR /app
COPY --chown=kicad:kicad package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --chown=kicad:kicad tsconfig.json ./
COPY --chown=kicad:kicad server ./server
COPY --chown=kicad:kicad src ./src
COPY --chown=kicad:kicad --from=client /app/dist ./dist
ENV NODE_ENV=production \
    CIRCUIT_HOST=0.0.0.0 \
    CIRCUIT_PORT=8765 \
    CIRCUIT_PUBLIC_URL=http://localhost:8765 \
    KICAD_CLI=/usr/bin/kicad-cli \
    KICAD_SYMBOL_DIR=/usr/share/kicad/symbols \
    KICAD_SYM_LIB_TABLE=/home/kicad/.config/kicad/9.0/sym-lib-table \
    DATA_DIR=/data \
    PROJECTS_DIR=/projects \
    STATIC_DIR=/app/dist \
    CIRCUIT_WATCH_POLL_MS=1000 \
    CIRCUIT_CONTAINER=circuit-ai-tool
VOLUME /data
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8765/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["bun", "server/index.ts"]

# ---- test: typecheck + full suite against the real kicad-cli ------------------
# Not part of the default build:  docker build --target test -t circuit-ai-tool:test .
FROM runtime AS test
COPY --chown=kicad:kicad --from=client /app/node_modules ./node_modules
COPY --chown=kicad:kicad client ./client
COPY --chown=kicad:kicad scripts ./scripts
COPY --chown=kicad:kicad test ./test
COPY --chown=kicad:kicad index.html vite.config.ts ./
RUN bun run typecheck && bun test
```

- [ ] **Step 4: Write `docker-compose.yml` and `.env.example`**

`docker-compose.yml`:

```yaml
services:
  circuit-ai-tool:
    build: .
    image: circuit-ai-tool:latest
    container_name: circuit-ai-tool
    ports:
      - "127.0.0.1:${CIRCUIT_HOST_PORT:-8765}:8765"
    volumes:
      - circuit-data:/data
      - "${KICAD_PROJECTS:-C:/Users/rober/Documents/KiCad/9.0/projects}:/projects"
    environment:
      - CIRCUIT_PATH_MAP=${KICAD_PROJECTS:-C:/Users/rober/Documents/KiCad/9.0/projects}=/projects
    restart: unless-stopped

volumes:
  circuit-data:
```

`.env.example` (compose reads a real `.env` next to the file; `.env` is git-ignored):

```
# Folder KiCad saves projects in; mounted at /projects and used for path mapping.
KICAD_PROJECTS=C:/Users/rober/Documents/KiCad/9.0/projects
# Host port. Use 8766 to run the container beside a `bun start` dev server.
CIRCUIT_HOST_PORT=8765
```

- [ ] **Step 5: Build the image**

Run: `docker compose build`
Expected: pulls `oven/bun:1.3` and `kicad/kicad:9.0.9` (about 0.5 GB compressed) on the first run, `bun run build` writes `dist/`, `cloudflared --version` prints a version, the build ends with the `runtime` stage. Then:

```bash
docker image ls circuit-ai-tool --format '{{.Repository}}:{{.Tag}} {{.Size}}'
```

Expected: one image, roughly 1.5 GB. If the size is above 2 GB, check that `.dockerignore` excluded `node_modules` and `src-tauri`.

- [ ] **Step 6: Start it and check health**

```bash
docker compose up -d
for i in $(seq 1 30); do s=$(docker inspect -f '{{.State.Health.Status}}' circuit-ai-tool); echo "$s"; [ "$s" = healthy ] && break; sleep 2; done
docker compose logs --tail 10
curl -s http://localhost:8765/api/health
```

Expected: `healthy` within about 30 s; the log shows `Circuit AI Tool: http://localhost:8765` and `kicad-cli found at /usr/bin/kicad-cli`; health prints `{"ok":true,"kicad":true}`.

- [ ] **Step 7: Confirm the container is non-root and has its tools**

```bash
docker exec circuit-ai-tool sh -c 'id; sudo -n true 2>&1 | head -1; which cloudflared; fc-list | grep -c DejaVu'
```

Expected: `uid=1000(kicad) gid=1000(kicad) groups=1000(kicad)` with no `27(sudo)`, sudo refused or not found, `/usr/local/bin/cloudflared`, a DejaVu count above 0.

- [ ] **Step 8: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml .env.example
git commit -m "feat(circuit): Docker image and compose service"
```

---

### Task 8: Smoke test against the running container

**Files:**
- Create: `scripts/docker-smoke.ts`
- Modify: `package.json` (add a script)

**Interfaces:**
- Consumes: the running container from Task 7; `KICAD_PROJECTS` env (same default as compose).
- Produces: `bun run docker:smoke` exits 0 only when the bind mount, path map, kicad-cli, PNG export and both MCP URLs work.

- [ ] **Step 1: Write the smoke script**

Create `scripts/docker-smoke.ts`:

```ts
// Smoke test for the Docker image: run from the host against a running
// container. Proves the bind mount, the host->container path map, kicad-cli,
// PNG rendering and both MCP URLs.
//
//   bun scripts/docker-smoke.ts [http://localhost:8765]
//
// KICAD_PROJECTS (default C:/Users/rober/Documents/KiCad/9.0/projects) must be
// the folder docker-compose.yml mounts at /projects. A temporary
// circuit-smoke/ folder is created inside it and removed afterwards.

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const base = (process.argv[2] ?? 'http://localhost:8765').replace(/\/$/, '');
const projects = process.env.KICAD_PROJECTS ?? 'C:/Users/rober/Documents/KiCad/9.0/projects';
const fixture = path.resolve(import.meta.dir, '..', 'test', 'fixtures', 'PL1_1.kicad_sch');
const smokeDir = path.join(projects, 'circuit-smoke');
const hostPath = path.join(smokeDir, 'PL1_1.kicad_sch');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

async function waitForHealth(ms: number): Promise<{ ok: boolean; kicad: boolean | null } | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return (await r.json()) as { ok: boolean; kicad: boolean | null };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

const health = await waitForHealth(60_000);
check('server answers /api/health', health !== null);
check('kicad-cli is available in the container', health?.kicad === true, JSON.stringify(health));
if (!health) process.exit(1);

mkdirSync(smokeDir, { recursive: true });
cpSync(fixture, hostPath);
let id: string | null = null;
try {
  const open = await fetch(`${base}/api/projects/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: hostPath }) });
  const summary = (await open.json()) as { id?: string; path?: string; components?: unknown[]; errors?: number; error?: string };
  check('open by host path', open.ok, summary.error ?? '');
  check('path was mapped into the container', summary.path === '/projects/circuit-smoke/PL1_1.kicad_sch', String(summary.path));
  check('components parsed', (summary.components?.length ?? 0) > 0, `${summary.components?.length ?? 0} parts`);
  check('no layout errors', summary.errors === 0, String(summary.errors));
  id = summary.id ?? null;
  if (id) {
    const svg = await fetch(`${base}/api/projects/${id}/board.svg`);
    check('board.svg', svg.ok && (await svg.text()).includes('<svg'));
    const png = await fetch(`${base}/api/projects/${id}/board.png`);
    const bytes = png.ok ? (await png.arrayBuffer()).byteLength : 0;
    check('board.png renders (>20 KB)', png.ok && bytes > 20_000, `${bytes} bytes`);
    const checks = (await (await fetch(`${base}/api/projects/${id}/checks`)).json()) as { level: string }[];
    check('checks: no errors', checks.every((c) => c.level !== 'error'));
  }
  for (const url of ['/mcp', '/mcp-server/mcp']) {
    const r = await fetch(`${base}${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } }),
    });
    const text = await r.text();
    check(`MCP initialize on ${url}`, r.ok && text.includes('"name":"circuit-ai-tool"'));
  }
} finally {
  if (id) await fetch(`${base}/api/projects/${id}`, { method: 'DELETE' }).catch(() => {});
  rmSync(smokeDir, { recursive: true, force: true });
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
```

Add to `package.json` `scripts`: `"docker:smoke": "bun scripts/docker-smoke.ts"`.

- [ ] **Step 2: Run it against the container from Task 7**

Run: `bun run docker:smoke`
Expected output, every line `PASS`, ending with `all checks passed` and exit code 0:

```
PASS server answers /api/health
PASS kicad-cli is available in the container  ({"ok":true,"kicad":true})
PASS open by host path
PASS path was mapped into the container  (/projects/circuit-smoke/PL1_1.kicad_sch)
PASS components parsed  (12 parts)
PASS no layout errors  (0)
PASS board.svg
PASS board.png renders (>20 KB)  (... bytes)
PASS checks: no errors
PASS MCP initialize on /mcp
PASS MCP initialize on /mcp-server/mcp
all checks passed
```

If `open by host path` fails with "schematic not found ... host paths are mapped", the `KICAD_PROJECTS` used by the script differs from the one compose mounted; align them. If `board.png` is under 20 KB, run `docker exec circuit-ai-tool fc-list | grep DejaVu` to confirm the font landed.

Note: the container's recent list keeps a `/projects/circuit-smoke/...` entry after the folder is removed; it opens with a 404 and is harmless.

- [ ] **Step 3: Run the typecheck on the host (the script is inside `tsconfig` `include`)**

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/docker-smoke.ts package.json
git commit -m "test(circuit): Docker smoke script"
```

---

### Task 9: Test image, reload-on-save, Claude Code, docs, memory

**Files:**
- Modify: `README.md` (new "Run in Docker" section, environment list)
- Modify: `C:\Users\rober\.claude\projects\C--Users-rober-Desktop-university-tools\memory\circuit-ai-tool-project.md`

- [ ] **Step 1: Run the full suite inside the image, against the real kicad-cli**

Run: `docker build --target test -t circuit-ai-tool:test .`
Expected: the `RUN bun run typecheck && bun test` layer passes. Because `KICAD_CLI` and `KICAD_SYMBOL_DIR` point at real files in the image, the `skipIf` tests in `kicad-cli.test.ts`, `libsymbol.test.ts` and `edit-integration.test.ts` run too, so the count is above the 146 seen on Windows. Then free the space: `docker rmi circuit-ai-tool:test`.

- [ ] **Step 2: Prove reload-on-save through the bind mount**

With the container from Task 7 still running:

```bash
cp test/fixtures/PL1_1.kicad_sch "C:/Users/rober/Documents/KiCad/9.0/projects/PL1_1/PL1_1-reload-test.kicad_sch"
id=$(curl -s -X POST http://localhost:8765/api/projects/open -H 'content-type: application/json' -d '{"path":"C:/Users/rober/Documents/KiCad/9.0/projects/PL1_1/PL1_1-reload-test.kicad_sch"}' | sed -E 's/.*"id":"([^"]+)".*/\1/')
(timeout 10 curl -s -N http://localhost:8765/api/events > /tmp/events.txt &) ; sleep 1
printf '\n' >> "C:/Users/rober/Documents/KiCad/9.0/projects/PL1_1/PL1_1-reload-test.kicad_sch"
sleep 5; cat /tmp/events.txt
curl -s -X DELETE http://localhost:8765/api/projects/$id
rm "C:/Users/rober/Documents/KiCad/9.0/projects/PL1_1/PL1_1-reload-test.kicad_sch"
```

Expected: `/tmp/events.txt` contains an SSE event with `"type":"changed"` for that id within a few seconds of the append. If nothing arrives, check `docker compose exec circuit-ai-tool env | grep WATCH` prints `CIRCUIT_WATCH_POLL_MS=1000`.

- [ ] **Step 3: Check the browser and Claude Code**

- Open `http://localhost:8765/`: the placeholder reads `/projects/lab1/lab1.kicad_sch`, the Library list shows `PL1_1` at `/projects/PL1_1/PL1_1.kicad_sch`; open it, the board renders with `0 errors`; click `PNG`, a PNG downloads with readable labels.
- Open `#/connect`: the Claude Desktop snippet shows `docker exec -i circuit-ai-tool bun server/index.ts --stdio`; press the Tunnel button, a `https://....trycloudflare.com` URL appears within 30 s (then stop it).
- Run `claude mcp list`: `circuit-designer: http://localhost:8765/mcp-server/mcp (HTTP) - Connected`.
- In a Claude Code session ask it to call `open_schematic` with `C:/Users/rober/Documents/KiCad/9.0/projects/PL1_1/PL1_1.kicad_sch`; the reply names the project `PL1_1` and a container path starting with `/projects/`.

- [ ] **Step 4: Document it in the README**

Add after the "Run" section of `README.md`:

```markdown
## Run in Docker

    docker compose up --build -d      # http://localhost:8765, restarts with Docker Desktop
    bun run docker:smoke              # optional: end-to-end check against the container
    docker compose down               # stop; `docker compose down -v` also drops the cache volume

The image is `kicad/kicad:9.0.9` (kicad-cli plus the stock symbol libraries)
with bun added. Your KiCad projects folder is mounted at `/projects`; set
`KICAD_PROJECTS` in a `.env` file (see `.env.example`) to use another folder.
Windows paths sent by Claude Code or the API are translated into `/projects/...`
automatically. The recent list, the kicad-cli cache and cloudflared live in the
`circuit-data` volume. Port 8765 is bound to localhost only; set
`CIRCUIT_HOST_PORT=8766` in `.env` to run it beside `bun start`.

The old `circuit-designer` container used the same port and the same Claude
Code registration (`/mcp-server/mcp`), so nothing needs re-registering.
```

Extend the "Environment" section's list with: `KICAD_SYM_LIB_TABLE`, `CIRCUIT_WATCH_POLL_MS` (poll the open schematic instead of inotify; the container sets 1000), `CIRCUIT_PATH_MAP` (`hostPrefix=containerPrefix;...`), `CIRCUIT_PNG_FONT`, `CIRCUIT_CONTAINER`.

- [ ] **Step 5: Update the project memory**

Edit the memory file `circuit-ai-tool-project.md` (keep its frontmatter) so the body says: Docker packaging done on the date of completion, image `circuit-ai-tool:latest` from `kicad/kicad:9.0.9` plus bun, `docker compose up -d` in `circut-ai-tool/`, `/projects` is the KiCad projects folder, `/data` is the `circuit-data` volume, old `circuit-designer` container removed, `bun run docker:smoke` verifies it. Update the matching line in `MEMORY.md`.

- [ ] **Step 6: Final verification and commit**

Run: `bun test && bun run typecheck && docker compose ps`
Expected: all tests pass, typecheck exit 0, `circuit-ai-tool` is `Up ... (healthy)`.

```bash
git add README.md
git commit -m "docs(circuit): running in Docker"
```

---

## Self-review

**Spec coverage.** 3.1 image: Task 7 (all nine points, including sudo removal, fonts, cloudflared, env table, health check, `test` target). 3.2 compose: Task 7 step 4 (plus the `CIRCUIT_HOST_PORT` knob so the container can run beside a dev server). 3.3 server changes 1 to 8: Tasks 1 (defaults, table, PNG font), 2 (PATH-aware `available`), 3 (polling watcher), 4 (path map, 404 hint, MCP wording), 5 (cloudflared on PATH), 6 (snippets, `projectsDir`, placeholder). 3.4 data flow: exercised end to end by Task 8 and Task 9 step 2. 3.5 cutover: Task 7 step 1 with the confirmation gate. Section 5 testing: every listed unit test has a task; the smoke script is Task 8; the manual list is Task 9 steps 2 and 3. Section 6 out-of-scope items are not touched.

**Placeholders.** None; every code step carries the code, every run step carries the command and the expected outcome.

**Type consistency.** `platformDefaults(platform, env, home): Defaults` is defined in Task 1 and used only there. `watchFile(file, onChange, opts: number | WatchOptions)` in Task 3 matches the calls in Task 3's service change and the existing numeric call in `test/projects.test.ts`. `PathMapping`, `parsePathMap`, `mapHostPath` in Task 4 match `boot.ts` and `service.ts` usage and the test imports. `findCloudflared(dir, which?)` in Task 5 matches its test. `buildConnectInfo(publicUrl, ctx)` in Task 6 matches `api.ts`'s existing zero-argument call (both parameters default) and the test's two-argument calls. `makeService` gains `watchPollMs` in Task 3 and `pathMap` in Task 4; Task 4 shows the final signature.

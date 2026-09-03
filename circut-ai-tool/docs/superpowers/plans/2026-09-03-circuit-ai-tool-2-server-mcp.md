# Circuit AI Tool Implementation Plan, part 2: server, REST API and MCP

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Bun server on port 8765 that opens real `.kicad_sch` files in place, keeps them live through a file watcher, serves the layout as JSON, SVG and PNG over REST, and exposes the same capabilities as MCP tools over Streamable HTTP and stdio for Claude Code, Claude Desktop and ChatGPT.

**Architecture:** `server/service.ts` owns open projects (schematic, design, sidecar, doc) and is the single place that calls the pure pipeline. `server/kicad-cli.ts` wraps `kicad-cli` with a content-hash cache. `server/api.ts` (Hono) and `server/mcp.ts` (MCP SDK) are thin adapters over the service. `server/watch.ts` turns file changes into rebuilds and server-sent events. Tests inject a fake `KicadCli` that returns the PL1_1 fixture netlist, so they run without KiCad; one integration test runs against the real CLI when it is installed.

**Tech Stack:** Bun 1.3, Hono 4.13, `@modelcontextprotocol/sdk` 1.30, zod 4.5, `@resvg/resvg-js` 2.6. Depends on parts 1a to 1c.

**Spec:** `circut-ai-tool/docs/superpowers/specs/2026-09-03-circuit-ai-tool-design.md` (sections "Server", "API and MCP", "Error handling")

## Global Constraints

- Port `8765`, host `127.0.0.1`, MCP at `/mcp` and the alias `/mcp-server/mcp` (the existing Claude Code registration `circuit-designer` points there).
- Environment: `CIRCUIT_PORT`, `CIRCUIT_HOST`, `CIRCUIT_PUBLIC_URL`, `KICAD_CLI`, `KICAD_SYMBOL_DIR`, `DATA_DIR`, `PROJECTS_DIR`. Defaults as in the spec.
- Only `server/`, `scripts/` and `test/` touch the filesystem or spawn processes.
- Edits to the schematic file are part 4. This part never writes a `.kicad_sch`; it writes only the sidecar and the recent-projects list.
- Same commit and tooling rules as part 1a.

---

### Task 13: Config and the kicad-cli wrapper

**Files:**
- Modify: `circut-ai-tool/package.json` (add dependencies)
- Create: `circut-ai-tool/server/config.ts`
- Create: `circut-ai-tool/server/kicad-cli.ts`
- Test: `circut-ai-tool/test/kicad-cli.test.ts`

**Interfaces:**
- Produces (config.ts): `PORT`, `HOST`, `PUBLIC_URL`, `APP_NAME = 'circuit-ai-tool'`, `APP_VERSION`, `KICAD_CLI`, `KICAD_SYMBOL_DIR`, `DATA_DIR`, `PROJECTS_DIR`, `PROJECT_ROOT`, `DIST_DIR`
- Produces (kicad-cli.ts): `interface KicadCli { netlist(sch: string): Promise<string>; svg(sch: string): Promise<string>; erc(sch: string): Promise<unknown>; available(): Promise<boolean> }`, `class KicadError extends Error`, `createKicadCli(opts: { exe: string; cacheDir: string }): KicadCli`, `fileHash(path: string): Promise<string>`

- [ ] **Step 1: Add dependencies**

Run: `cd circut-ai-tool && bun add hono@^4.13.5 @modelcontextprotocol/sdk@^1.30.0 zod@^4.5.4 @resvg/resvg-js@^2.6.2`
Expected: `package.json` lists the four dependencies; `bun.lock` updated. Add `"start": "bun server/index.ts"` and `"mcp:stdio": "bun server/mcp-stdio.ts"` to `scripts`.

- [ ] **Step 2: Write the failing test**

`test/kicad-cli.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KICAD_CLI } from '../server/config.ts';
import { createKicadCli, KicadError } from '../server/kicad-cli.ts';
import { FIXTURES } from './smoke.test.ts';

const sch = path.join(FIXTURES, 'PL1_1.kicad_sch');

describe('createKicadCli', () => {
  test('a missing executable fails with a message naming KICAD_CLI', async () => {
    const cli = createKicadCli({ exe: 'C:/definitely/missing/kicad-cli.exe', cacheDir: mkdtempSync(path.join(tmpdir(), 'kc-')) });
    expect(await cli.available()).toBe(false);
    await expect(cli.netlist(sch)).rejects.toBeInstanceOf(KicadError);
    await expect(cli.netlist(sch)).rejects.toThrow(/KICAD_CLI/);
  });

  const have = existsSync(KICAD_CLI);
  test.skipIf(!have)('exports a netlist through the real kicad-cli and caches it by content hash', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'kc-'));
    const cli = createKicadCli({ exe: KICAD_CLI, cacheDir });
    expect(await cli.available()).toBe(true);
    const t0 = performance.now();
    const text = await cli.netlist(sch);
    const first = performance.now() - t0;
    expect(text.startsWith('(export')).toBe(true);
    expect(readdirSync(cacheDir).some((f) => f.endsWith('.net'))).toBe(true);
    const t1 = performance.now();
    await cli.netlist(sch);
    expect(performance.now() - t1).toBeLessThan(first / 4);
    const svg = await cli.svg(sch);
    expect(svg).toContain('<svg');
    const erc = (await cli.erc(sch)) as { violations?: unknown[]; sheets?: unknown[] };
    expect(typeof erc).toBe('object');
  }, 60000);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd circut-ai-tool && bun test test/kicad-cli.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 4: Write server/config.ts**

```ts
// Runtime settings. Environment variables override the defaults.

import os from 'node:os';
import path from 'node:path';

export const PORT = Number(process.env.CIRCUIT_PORT ?? 8765);
export const HOST = process.env.CIRCUIT_HOST ?? '127.0.0.1';
export const PUBLIC_URL = process.env.CIRCUIT_PUBLIC_URL ?? `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
export const APP_NAME = 'circuit-ai-tool';
export const APP_VERSION = '0.1.0';

const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
const kicadRoot = path.join(localAppData, 'Programs', 'KiCad', '9.0');

export const KICAD_CLI = process.env.KICAD_CLI ?? path.join(kicadRoot, 'bin', 'kicad-cli.exe');
export const KICAD_SYMBOL_DIR = process.env.KICAD_SYMBOL_DIR ?? path.join(kicadRoot, 'share', 'kicad', 'symbols');
export const DATA_DIR = process.env.DATA_DIR ?? path.join(localAppData, 'UniversityTools', 'circuit');
export const PROJECTS_DIR = process.env.PROJECTS_DIR ?? path.join(os.homedir(), 'Documents', 'KiCad', '9.0', 'projects');

export const PROJECT_ROOT = path.resolve(import.meta.dir, '..');
export const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
```

- [ ] **Step 5: Write server/kicad-cli.ts**

```ts
// kicad-cli wrapper. Every export is cached under cacheDir by the SHA-256 of
// the schematic's content, so reopening an unchanged file costs nothing and
// a changed file always re-exports.

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export class KicadError extends Error {}

export interface KicadCli {
  netlist(sch: string): Promise<string>;
  svg(sch: string): Promise<string>;
  erc(sch: string): Promise<unknown>;
  available(): Promise<boolean>;
}

export async function fileHash(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

export function createKicadCli(opts: { exe: string; cacheDir: string }): KicadCli {
  const { exe, cacheDir } = opts;

  async function exec(args: string[]): Promise<string> {
    try {
      const { stdout } = await run(exe, args, { timeout: 60_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      if (err.code === 'ENOENT') throw new KicadError(`kicad-cli not found at "${exe}". Install KiCad 9 or set KICAD_CLI to the path of kicad-cli.exe.`);
      throw new KicadError(`kicad-cli ${args.slice(0, 3).join(' ')} failed: ${(err.stderr || err.stdout || err.message).trim()}`);
    }
  }

  async function cached(sch: string, ext: string, produce: (out: string) => Promise<void>): Promise<string> {
    await mkdir(cacheDir, { recursive: true });
    const key = path.join(cacheDir, `${await fileHash(sch)}${ext}`);
    try {
      return await readFile(key, 'utf8');
    } catch {
      /* not cached */
    }
    const tmp = path.join(tmpdir(), `circuit-${process.pid}-${randomUUID()}${ext}`);
    try {
      await produce(tmp);
      const text = await readFile(tmp, 'utf8');
      await writeFile(key, text);
      return text;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  return {
    async available() {
      try {
        await access(exe);
        return true;
      } catch {
        return false;
      }
    },
    netlist: (sch) => cached(sch, '.net', async (out) => void (await exec(['sch', 'export', 'netlist', '--format', 'kicadsexpr', '-o', out, sch]))),
    svg: (sch) =>
      cached(sch, '.svg', async (out) => {
        const dir = `${out}-dir`;
        await mkdir(dir, { recursive: true });
        try {
          await exec(['sch', 'export', 'svg', '--no-background-color', '-o', dir, sch]);
          const produced = path.join(dir, `${path.basename(sch, '.kicad_sch')}.svg`);
          await writeFile(out, await readFile(produced));
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
    erc: async (sch) => JSON.parse(await cached(sch, '.erc.json', async (out) => void (await exec(['sch', 'erc', '--format', 'json', '--units', 'mm', '--severity-all', '-o', out, sch])))),
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd circut-ai-tool && bun test test/kicad-cli.test.ts`
Expected: both tests pass (the second runs because KiCad 9 is installed on this laptop). If `erc` fails with a non-zero exit while writing a valid JSON file, catch that case in `exec` by checking whether the output file exists before throwing.

- [ ] **Step 7: Commit**

```bash
git add circut-ai-tool/package.json circut-ai-tool/bun.lock circut-ai-tool/server/config.ts circut-ai-tool/server/kicad-cli.ts circut-ai-tool/test/kicad-cli.test.ts
git commit -m "feat(circuit): config and cached kicad-cli wrapper"
```

---

### Task 14: Project registry, sidecar files and the watcher

**Files:**
- Create: `circut-ai-tool/server/projects.ts`
- Create: `circut-ai-tool/server/watch.ts`
- Test: `circut-ai-tool/test/projects.test.ts`

**Interfaces:**
- Produces (projects.ts):
  - `interface ProjectInfo { id: string; path: string; name: string; dir: string; lastOpened: string }`
  - `projectId(absPath: string): string` (first 10 hex chars of sha256 of the lower-cased, forward-slash path)
  - `class ProjectRegistry { constructor(dataDir: string); load(): Promise<void>; list(): ProjectInfo[]; get(id: string): ProjectInfo | undefined; remember(absPath: string): Promise<ProjectInfo>; forget(id: string): Promise<void> }`
  - `scanProjects(dir: string, depth?: number): Promise<{ path: string; name: string }[]>`
  - `sidecarPath(schPath: string): string`, `readSidecar(schPath: string): Promise<Sidecar>`, `writeSidecar(schPath: string, sidecar: Sidecar): Promise<void>`
- Produces (watch.ts):
  - `class Events<T> { subscribe(fn: (ev: T) => void): () => void; emit(ev: T): void }`
  - `watchFile(file: string, onChange: () => void, debounceMs?: number): () => void` (watches the directory, filters by basename, debounced)

- [ ] **Step 1: Write the failing tests**

`test/projects.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emptySidecar } from '../src/layout/types.ts';
import { ProjectRegistry, projectId, readSidecar, scanProjects, sidecarPath, writeSidecar } from '../server/projects.ts';
import { Events, watchFile } from '../server/watch.ts';

describe('projectId', () => {
  test('is stable and case-insensitive', () => {
    expect(projectId('C:\\Users\\x\\a.kicad_sch')).toBe(projectId('c:/users/x/A.kicad_sch'));
    expect(projectId('C:/a.kicad_sch')).toHaveLength(10);
  });
});

describe('ProjectRegistry', () => {
  test('remembers, lists newest first, forgets, persists', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'reg-'));
    const reg = new ProjectRegistry(dir);
    await reg.load();
    const a = await reg.remember('C:/p/a.kicad_sch');
    await new Promise((r) => setTimeout(r, 5));
    const b = await reg.remember('C:/p/b.kicad_sch');
    expect(reg.list().map((p) => p.name)).toEqual(['b', 'a']);
    expect(reg.get(a.id)!.dir).toBe('C:/p');
    await reg.remember('C:/p/a.kicad_sch');
    expect(reg.list().map((p) => p.name)).toEqual(['a', 'b']);
    await reg.forget(b.id);
    const reg2 = new ProjectRegistry(dir);
    await reg2.load();
    expect(reg2.list().map((p) => p.id)).toEqual([a.id]);
  });
});

describe('scanProjects and sidecar', () => {
  test('finds schematics two levels deep and round-trips the sidecar', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'scan-'));
    mkdirSync(path.join(root, 'p1'));
    mkdirSync(path.join(root, 'p2', 'sub'), { recursive: true });
    writeFileSync(path.join(root, 'p1', 'p1.kicad_sch'), '(kicad_sch)');
    writeFileSync(path.join(root, 'p2', 'sub', 'deep.kicad_sch'), '(kicad_sch)');
    writeFileSync(path.join(root, 'p2', 'sub', 'deep-backups.kicad_sch.bak'), 'x');
    const found = await scanProjects(root, 2);
    expect(found.map((f) => f.name).sort()).toEqual(['deep', 'p1']);
    const sch = path.join(root, 'p1', 'p1.kicad_sch');
    expect(sidecarPath(sch)).toBe(path.join(root, 'p1', 'p1.breadboard.json'));
    expect(await readSidecar(sch)).toEqual(emptySidecar());
    const s = emptySidecar();
    s.pinned.R1 = { '1': { col: 3, row: 'a' }, '2': { col: 3, row: 'T+' } };
    await writeSidecar(sch, s);
    expect(existsSync(sidecarPath(sch))).toBe(true);
    expect((await readSidecar(sch)).pinned.R1['1']).toEqual({ col: 3, row: 'a' });
  });
});

describe('Events and watchFile', () => {
  test('emits once per debounced burst of changes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'watch-'));
    const file = path.join(dir, 'x.kicad_sch');
    writeFileSync(file, '(kicad_sch)');
    let hits = 0;
    const stop = watchFile(file, () => hits++, 150);
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(file, '(kicad_sch 1)');
    writeFileSync(file, '(kicad_sch 2)');
    writeFileSync(path.join(dir, 'other.txt'), 'ignored');
    await new Promise((r) => setTimeout(r, 600));
    stop();
    expect(hits).toBe(1);
    const ev = new Events<{ n: number }>();
    const got: number[] = [];
    const unsub = ev.subscribe((e) => got.push(e.n));
    ev.emit({ n: 1 });
    unsub();
    ev.emit({ n: 2 });
    expect(got).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd circut-ai-tool && bun test test/projects.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write server/projects.ts**

```ts
// Recent-projects list under DATA_DIR, folder scanning, and the sidecar file
// that lives next to each schematic (NAME.breadboard.json).

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeSidecar, type Sidecar } from '../src/layout/types.ts';

export interface ProjectInfo {
  id: string;
  path: string;
  name: string;
  dir: string;
  lastOpened: string;
}

export const normalizePath = (p: string) => path.resolve(p).replace(/\\/g, '/');

export function projectId(absPath: string): string {
  return createHash('sha256').update(normalizePath(absPath).toLowerCase()).digest('hex').slice(0, 10);
}

export class ProjectRegistry {
  private items = new Map<string, ProjectInfo>();
  private file: string;

  constructor(private dataDir: string) {
    this.file = path.join(dataDir, 'projects.json');
  }

  async load() {
    try {
      const list = JSON.parse(await readFile(this.file, 'utf8')) as ProjectInfo[];
      for (const p of list) if (p && typeof p.path === 'string') this.items.set(p.id, p);
    } catch {
      /* first run */
    }
  }

  private async save() {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.file, JSON.stringify(this.list(), null, 2));
  }

  list(): ProjectInfo[] {
    return [...this.items.values()].sort((a, b) => b.lastOpened.localeCompare(a.lastOpened));
  }

  get(id: string): ProjectInfo | undefined {
    return this.items.get(id);
  }

  async remember(absPath: string): Promise<ProjectInfo> {
    const p = normalizePath(absPath);
    const info: ProjectInfo = { id: projectId(p), path: p, name: path.basename(p, '.kicad_sch'), dir: path.posix.dirname(p), lastOpened: new Date().toISOString() };
    this.items.set(info.id, info);
    await this.save();
    return info;
  }

  async forget(id: string) {
    this.items.delete(id);
    await this.save();
  }
}

export async function scanProjects(dir: string, depth = 2): Promise<{ path: string; name: string }[]> {
  const out: { path: string; name: string }[] = [];
  async function walk(d: string, level: number) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && level < depth && !e.name.endsWith('-backups')) await walk(full, level + 1);
      else if (e.isFile() && e.name.endsWith('.kicad_sch')) out.push({ path: normalizePath(full), name: path.basename(e.name, '.kicad_sch') });
    }
  }
  await walk(dir, 0);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function sidecarPath(schPath: string): string {
  return path.join(path.dirname(schPath), `${path.basename(schPath, '.kicad_sch')}.breadboard.json`);
}

export async function readSidecar(schPath: string): Promise<Sidecar> {
  try {
    return normalizeSidecar(JSON.parse(await readFile(sidecarPath(schPath), 'utf8')));
  } catch {
    return normalizeSidecar({});
  }
}

export async function writeSidecar(schPath: string, sidecar: Sidecar): Promise<void> {
  await writeFile(sidecarPath(schPath), JSON.stringify(sidecar, null, 2));
}
```

- [ ] **Step 4: Write server/watch.ts**

```ts
// A tiny event bus and a debounced file watcher. The watcher observes the
// directory (KiCad may replace the file rather than rewrite it) and only
// reports changes to the named file.

import { watch } from 'node:fs';
import path from 'node:path';

export class Events<T> {
  private subs = new Set<(ev: T) => void>();

  subscribe(fn: (ev: T) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  emit(ev: T) {
    for (const fn of [...this.subs]) {
      try {
        fn(ev);
      } catch {
        /* a bad subscriber must not break the others */
      }
    }
  }
}

export function watchFile(file: string, onChange: () => void, debounceMs = 300): () => void {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const watcher = watch(dir, { persistent: false }, (_event, filename) => {
    if (filename && String(filename) !== base) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  });
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd circut-ai-tool && bun test test/projects.test.ts`
Expected: all pass. If the watcher test sees 0 hits on Windows, `fs.watch` delivered a `rename` for the temp file's parent; make sure the watcher is created before the writes and the debounce window (150 ms) is shorter than the wait (600 ms).

- [ ] **Step 6: Commit**

```bash
git add circut-ai-tool/server/projects.ts circut-ai-tool/server/watch.ts circut-ai-tool/test/projects.test.ts
git commit -m "feat(circuit): project registry, sidecar files and debounced watcher"
```

---

### Task 15: The service

**Files:**
- Create: `circut-ai-tool/server/service.ts`
- Test: `circut-ai-tool/test/service.test.ts`
- Create: `circut-ai-tool/test/fake-kicad.ts`

**Interfaces:**
- Produces:
  - `class ServiceError extends Error { status: number }`
  - `interface OpenProject { info: ProjectInfo; schematic: Schematic; design: Design; sidecar: Sidecar; doc: LayoutDoc; netlistText: string; mtimeMs: number; size: number }`
  - `interface ProjectEvent { projectId: string; type: 'changed' | 'error' | 'closed'; message?: string }`
  - `class Service { constructor(deps: { kicad: KicadCli; registry: ProjectRegistry; events: Events<ProjectEvent>; watch: boolean; projectsDir: string }); open(pathOrId: string): Promise<OpenProject>; get(id: string): OpenProject; has(id: string): boolean; refresh(id: string): Promise<OpenProject>; close(id: string): void; list(): Promise<{ recent: ProjectInfo[]; found: { path: string; name: string }[] }>; setOptions(id, patch: Partial<Options>): Promise<OpenProject>; movePart(id, ref, holes: Record<string, Hole>): Promise<OpenProject>; setColor(id, net, color: string | null): Promise<OpenProject>; resetLayout(id): Promise<OpenProject>; simulate(id, levels: Record<string, 0 | 1>): SimResult; schematicSvg(id): Promise<string>; erc(id): Promise<unknown>; saveSidecar(id): Promise<void> }`
- Test helper (`test/fake-kicad.ts`): `fakeKicad(netText: string): KicadCli`

- [ ] **Step 1: Write the fake and the failing tests**

`test/fake-kicad.ts`:

```ts
import type { KicadCli } from '../server/kicad-cli.ts';

export function fakeKicad(netText: string): KicadCli {
  return {
    available: async () => true,
    netlist: async () => netText,
    svg: async () => '<svg xmlns="http://www.w3.org/2000/svg"><text>fake schematic</text></svg>',
    erc: async () => ({ violations: [], sheets: [] }),
  };
}
```

`test/service.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectRegistry, sidecarPath } from '../server/projects.ts';
import { Service, ServiceError, type ProjectEvent } from '../server/service.ts';
import { Events } from '../server/watch.ts';
import { fakeKicad } from './fake-kicad.ts';
import { FIXTURES, readFixture } from './smoke.test.ts';

export async function makeService(opts: { watch?: boolean } = {}) {
  const work = mkdtempSync(path.join(tmpdir(), 'svc-'));
  const sch = path.join(work, 'PL1_1.kicad_sch');
  copyFileSync(path.join(FIXTURES, 'PL1_1.kicad_sch'), sch);
  const registry = new ProjectRegistry(path.join(work, 'data'));
  await registry.load();
  const events = new Events<ProjectEvent>();
  const service = new Service({ kicad: fakeKicad(readFixture('PL1_1.net')), registry, events, watch: opts.watch ?? false, projectsDir: work });
  return { service, sch, events, work };
}

describe('Service', () => {
  test('opens a schematic by path, then by id, and lists it', async () => {
    const { service, sch } = await makeService();
    const p = await service.open(sch);
    expect(p.info.name).toBe('PL1_1');
    expect(p.doc.error).toBeNull();
    expect(p.doc.checks.filter((c) => c.level === 'error')).toEqual([]);
    expect(service.get(p.info.id).info.id).toBe(p.info.id);
    const again = await service.open(p.info.id);
    expect(again.info.id).toBe(p.info.id);
    const list = await service.list();
    expect(list.recent[0].id).toBe(p.info.id);
    expect(list.found.map((f) => f.name)).toEqual(['PL1_1']);
  });

  test('rejects missing files, wrong extensions, sheets and buses', async () => {
    const { service, work } = await makeService();
    await expect(service.open(path.join(work, 'nope.kicad_sch'))).rejects.toThrow(/not found/);
    writeFileSync(path.join(work, 'x.txt'), 'x');
    await expect(service.open(path.join(work, 'x.txt'))).rejects.toThrow(/\.kicad_sch/);
    const withSheet = path.join(work, 'sheet.kicad_sch');
    writeFileSync(withSheet, '(kicad_sch (version 20250114) (generator "eeschema") (uuid "u") (paper "A4") (lib_symbols) (sheet (at 0 0) (size 10 10) (uuid "s")))');
    await expect(service.open(withSheet)).rejects.toThrow(/hierarchical sheets/);
    const withBus = path.join(work, 'bus.kicad_sch');
    writeFileSync(withBus, '(kicad_sch (version 20250114) (generator "eeschema") (uuid "u") (paper "A4") (lib_symbols) (bus (pts (xy 0 0) (xy 1 1)) (uuid "b")))');
    await expect(service.open(withBus)).rejects.toThrow(/buses/);
    expect(() => service.get('nope')).toThrow(ServiceError);
  });

  test('movePart persists to the sidecar and the layout follows', async () => {
    const { service, sch } = await makeService();
    const p = await service.open(sch);
    const d2 = p.doc.pinHoles.D2;
    const target = { '1': { col: d2['1'].col + 3, row: d2['1'].row }, '2': { col: d2['2'].col + 3, row: d2['2'].row } };
    const moved = await service.movePart(p.info.id, 'D2', target);
    expect(moved.doc.pinHoles.D2).toEqual(target);
    expect(JSON.parse(readFileSync(sidecarPath(sch), 'utf8')).pinned.D2).toEqual(target);
    await expect(service.movePart(p.info.id, 'D2', { '1': { col: 1, row: 'a' } })).rejects.toThrow(/pin 2/);
    await expect(service.movePart(p.info.id, 'D2', { '1': p.doc.pinHoles.U1['1'], '2': p.doc.pinHoles.U1['2'] })).rejects.toThrow(/dropped|taken/);
    const reset = await service.resetLayout(p.info.id);
    expect(reset.sidecar.pinned).toEqual({});
  });

  test('options, colours and simulation', async () => {
    const { service, sch } = await makeService();
    const p = await service.open(sch);
    const withDip = await service.setOptions(p.info.id, { dipSwitchPositions: 4 });
    expect(withDip.doc.packages[0].kind).toBe('dipswitch');
    const coloured = await service.setColor(p.info.id, '/A', '#123456');
    expect(coloured.doc.nets['/A'].color).toBe('#123456');
    await expect(service.setColor(p.info.id, '/A', 'red')).rejects.toThrow(/#rrggbb/);
    const back = await service.setColor(p.info.id, '/A', null);
    expect(back.doc.nets['/A'].color).not.toBe('#123456');
    const sim = service.simulate(p.info.id, { '/A': 1, '/B': 0 });
    expect(sim.nets['/Y1']).toBe(1);
    expect(await service.schematicSvg(p.info.id)).toContain('<svg');
  });

  test('refresh re-reads the file and the watcher emits events', async () => {
    const { service, sch, events } = await makeService({ watch: true });
    const p = await service.open(sch);
    const got: ProjectEvent[] = [];
    events.subscribe((e) => got.push(e));
    const text = readFileSync(sch, 'utf8');
    writeFileSync(sch, text);
    const t = new Date(Date.now() + 2000);
    utimesSync(sch, t, t);
    await new Promise((r) => setTimeout(r, 900));
    expect(got.some((e) => e.projectId === p.info.id && e.type === 'changed')).toBe(true);
    const r = await service.refresh(p.info.id);
    expect(r.mtimeMs).toBeGreaterThan(0);
    service.close(p.info.id);
    expect(service.has(p.info.id)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd circut-ai-tool && bun test test/service.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write server/service.ts**

```ts
// Open projects and everything that can be done to them. The only module
// that calls the pure pipeline on the server. Layout edits change the
// sidecar; schematic edits (part 4) change the .kicad_sch through this
// class as well so that mtime checks, backups and rebuilds live in one place.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseSchematic, type Schematic } from '../src/kicad/schematic.ts';
import type { Hole, Options, Sidecar } from '../src/layout/types.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { parseNetlist, type Design } from '../src/netlist.ts';
import { buildLayoutDoc, type LayoutDoc } from '../src/pipeline.ts';
import { simulate, type SimResult } from '../src/sim/index.ts';
import type { KicadCli } from './kicad-cli.ts';
import { normalizePath, projectId, readSidecar, scanProjects, writeSidecar, type ProjectInfo, type ProjectRegistry } from './projects.ts';
import { watchFile, type Events } from './watch.ts';

export class ServiceError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface OpenProject {
  info: ProjectInfo;
  schematic: Schematic;
  design: Design;
  sidecar: Sidecar;
  doc: LayoutDoc;
  netlistText: string;
  mtimeMs: number;
  size: number;
}

export interface ProjectEvent {
  projectId: string;
  type: 'changed' | 'error' | 'closed';
  message?: string;
}

export interface ServiceDeps {
  kicad: KicadCli;
  registry: ProjectRegistry;
  events: Events<ProjectEvent>;
  watch: boolean;
  projectsDir: string;
}

export class Service {
  private open_ = new Map<string, OpenProject>();
  private stops = new Map<string, () => void>();

  constructor(private deps: ServiceDeps) {}

  has(id: string): boolean {
    return this.open_.has(id);
  }

  get(id: string): OpenProject {
    const p = this.open_.get(id);
    if (!p) throw new ServiceError(`project "${id}" is not open; call open_schematic with its path first`, 404);
    return p;
  }

  async list() {
    return { recent: this.deps.registry.list(), found: await scanProjects(this.deps.projectsDir, 2) };
  }

  async open(pathOrId: string): Promise<OpenProject> {
    const known = this.open_.get(pathOrId) ?? (this.deps.registry.get(pathOrId) ? this.open_.get(this.deps.registry.get(pathOrId)!.id) : undefined);
    if (known) return known;
    const remembered = this.deps.registry.get(pathOrId);
    const file = normalizePath(remembered ? remembered.path : pathOrId);
    if (!file.toLowerCase().endsWith('.kicad_sch')) throw new ServiceError(`"${pathOrId}" is not a .kicad_sch file`);
    const id = projectId(file);
    const project = await this.load(file, id);
    project.info = await this.deps.registry.remember(file);
    this.open_.set(id, project);
    if (this.deps.watch) this.startWatch(id, file);
    return project;
  }

  private async load(file: string, id: string): Promise<OpenProject> {
    let s;
    try {
      s = await stat(file);
    } catch {
      throw new ServiceError(`schematic not found: ${file}`, 404);
    }
    const text = await readFile(file, 'utf8');
    const schematic = parseSchematic(text, path.basename(file, '.kicad_sch'));
    if (schematic.sheets) throw new ServiceError(`hierarchical sheets are not supported (found ${schematic.sheets}); flatten the design first`);
    if (schematic.buses) throw new ServiceError(`buses are not supported (found ${schematic.buses} bus segments); use labels instead`);
    const netlistText = await this.deps.kicad.netlist(file);
    const design = parseNetlist(netlistText);
    const sidecar = await readSidecar(file);
    const doc = buildLayoutDoc(design, sidecar);
    const info: ProjectInfo = this.deps.registry.get(id) ?? { id, path: file, name: path.basename(file, '.kicad_sch'), dir: path.posix.dirname(file), lastOpened: new Date().toISOString() };
    return { info, schematic, design, sidecar, doc, netlistText, mtimeMs: s.mtimeMs, size: s.size };
  }

  private startWatch(id: string, file: string) {
    this.stops.get(id)?.();
    this.stops.set(
      id,
      watchFile(file, () => {
        this.refresh(id)
          .then(() => this.deps.events.emit({ projectId: id, type: 'changed' }))
          .catch((e) => this.deps.events.emit({ projectId: id, type: 'error', message: (e as Error).message }));
      }),
    );
  }

  async refresh(id: string): Promise<OpenProject> {
    const current = this.get(id);
    const fresh = await this.load(current.info.path, id);
    fresh.info = current.info;
    this.open_.set(id, fresh);
    return fresh;
  }

  close(id: string) {
    this.stops.get(id)?.();
    this.stops.delete(id);
    this.open_.delete(id);
    this.deps.events.emit({ projectId: id, type: 'closed' });
  }

  /** Rebuild the doc from the current design and sidecar, persist the sidecar. */
  private async rebuild(p: OpenProject): Promise<OpenProject> {
    p.doc = buildLayoutDoc(p.design, p.sidecar);
    await writeSidecar(p.info.path, p.sidecar);
    return p;
  }

  async saveSidecar(id: string) {
    await writeSidecar(this.get(id).info.path, this.get(id).sidecar);
  }

  async setOptions(id: string, patch: Partial<Options>): Promise<OpenProject> {
    const p = this.get(id);
    const o = p.sidecar.options;
    if (patch.board !== undefined) {
      if (!['auto', 'half', 'full'].includes(patch.board)) throw new ServiceError('board must be auto, half or full');
      o.board = patch.board;
    }
    if (patch.railSplit !== undefined) o.railSplit = patch.railSplit === null ? null : !!patch.railSplit;
    if (patch.dipSwitchPositions !== undefined) {
      if (!Number.isInteger(patch.dipSwitchPositions) || patch.dipSwitchPositions < 0 || patch.dipSwitchPositions > 16) throw new ServiceError('dipSwitchPositions must be 0 to 16');
      o.dipSwitchPositions = patch.dipSwitchPositions;
    }
    if (patch.packageOrder !== undefined) o.packageOrder = patch.packageOrder.filter((r) => p.design.components.has(r));
    if (patch.substitutions !== undefined) o.substitutions = { ...o.substitutions, ...patch.substitutions };
    return this.rebuild(p);
  }

  async movePart(id: string, ref: string, holes: Record<string, Hole>): Promise<OpenProject> {
    const p = this.get(id);
    const comp = p.design.components.get(ref);
    if (!comp) throw new ServiceError(`no component ${ref} in the schematic`, 404);
    const expected = Object.keys(p.doc.pinHoles[ref] ?? {});
    if (!expected.length) throw new ServiceError(`${ref} is not placed on the board, so it cannot be moved`);
    const missing = expected.filter((pin) => !holes[pin]);
    if (missing.length) throw new ServiceError(`move_part needs a hole for every pin of ${ref}; missing pin ${missing.join(', pin ')}`);
    const before = { ...p.sidecar.pinned };
    p.sidecar.pinned[ref] = Object.fromEntries(expected.map((pin) => [pin, { col: holes[pin].col, row: holes[pin].row }]));
    const doc = buildLayoutDoc(p.design, p.sidecar);
    const dropped = doc.warnings.find((w) => w.startsWith(`pinned placement for ${ref} dropped`));
    if (dropped) {
      p.sidecar.pinned = before;
      throw new ServiceError(dropped.replace('pinned placement for', 'cannot move'));
    }
    return this.rebuild(p);
  }

  async setColor(id: string, net: string, color: string | null): Promise<OpenProject> {
    const p = this.get(id);
    if (!p.design.nets.has(net)) throw new ServiceError(`no net ${net} in the schematic (names are exact, for example "/A" or "+5V")`, 404);
    if (color === null) delete p.sidecar.colors[net];
    else if (/^#[0-9a-fA-F]{6}$/.test(color)) p.sidecar.colors[net] = color;
    else throw new ServiceError('color must be #rrggbb');
    return this.rebuild(p);
  }

  async resetLayout(id: string): Promise<OpenProject> {
    const p = this.get(id);
    const keep = p.sidecar.placed;
    p.sidecar = { ...emptySidecar(), placed: keep };
    return this.rebuild(p);
  }

  simulate(id: string, levels: Record<string, 0 | 1>): SimResult {
    const p = this.get(id);
    for (const net of Object.keys(levels)) if (!p.design.nets.has(net)) throw new ServiceError(`no net ${net}`, 404);
    return simulate(p.doc.sim.model, levels);
  }

  schematicSvg(id: string): Promise<string> {
    return this.deps.kicad.svg(this.get(id).info.path);
  }

  erc(id: string): Promise<unknown> {
    return this.deps.kicad.erc(this.get(id).info.path);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd circut-ai-tool && bun test test/service.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add circut-ai-tool/server/service.ts circut-ai-tool/test/service.test.ts circut-ai-tool/test/fake-kicad.ts
git commit -m "feat(circuit): project service with live reload and layout edits"
```

---

### Task 16: REST API, PNG rendering, events and OpenAPI

**Files:**
- Create: `circut-ai-tool/server/png.ts`
- Create: `circut-ai-tool/server/api.ts`
- Create: `circut-ai-tool/server/openapi.ts`
- Create: `circut-ai-tool/server/app.ts`
- Test: `circut-ai-tool/test/api.test.ts`

**Interfaces:**
- Produces (png.ts): `renderPng(svg: string, width?: number): Uint8Array` (throws `PngError` if resvg cannot load), `pngAvailable(): boolean`
- Produces (api.ts): `createApi(service: Service, events: Events<ProjectEvent>): Hono`, `parseHighlight(q: string | undefined): Highlight | null` (`net:/A`, `ref:R1`, `wire:3`)
- Produces (openapi.ts): `openapiDocument(): object`
- Produces (app.ts): `createApp(deps: { service: Service; events: Events<ProjectEvent>; mcp: () => McpServer }): Hono` (the `mcp` factory is wired in Task 17; until then pass a stub)

- [ ] **Step 1: Write the failing tests**

`test/api.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createApp } from '../server/app.ts';
import { pngAvailable } from '../server/png.ts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { makeService } from './service.test.ts';

async function setup() {
  const { service, sch, events } = await makeService();
  const app = createApp({ service, events, mcp: () => new McpServer({ name: 'stub', version: '0' }) });
  const json = (path: string, body?: unknown) => app.request(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { app, sch, json, service, events };
}

describe('REST API', () => {
  test('open, summary, layout, steps, checks, truth table, pinouts', async () => {
    const { json, sch } = await setup();
    const opened = await (await json('/api/projects/open', { path: sch })).json();
    expect(opened.id).toHaveLength(10);
    const id = opened.id;
    expect((await (await json(`/api/projects/${id}`)).json()).name).toBe('PL1_1');
    const layout = await (await json(`/api/projects/${id}/layout`)).json();
    expect(layout.packages).toHaveLength(3);
    expect((await (await json(`/api/projects/${id}/steps`)).json()).length).toBeGreaterThan(10);
    expect((await (await json(`/api/projects/${id}/checks`)).json()).some((c: { level: string }) => c.level === 'error')).toBe(false);
    expect((await (await json(`/api/projects/${id}/truth-table`)).json()).rows).toHaveLength(4);
    expect((await (await json(`/api/projects/${id}/pinouts`)).json())).toHaveLength(3);
    const list = await (await json('/api/projects')).json();
    expect(list.recent[0].id).toBe(id);
  });

  test('images', async () => {
    const { json, sch } = await setup();
    const { id } = await (await json('/api/projects/open', { path: sch })).json();
    const svg = await json(`/api/projects/${id}/board.svg?highlight=net:/A&theme=dark`);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    expect(await svg.text()).toContain('opacity="0.18"');
    const sch2 = await json(`/api/projects/${id}/schematic.svg`);
    expect(await sch2.text()).toContain('<svg');
    const png = await json(`/api/projects/${id}/board.png`);
    if (pngAvailable()) {
      expect(png.status).toBe(200);
      expect(png.headers.get('content-type')).toBe('image/png');
      const bytes = new Uint8Array(await png.arrayBuffer());
      expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    } else expect(png.status).toBe(501);
  });

  test('layout edits and simulation', async () => {
    const { json, sch } = await setup();
    const { id } = await (await json('/api/projects/open', { path: sch })).json();
    const before = await (await json(`/api/projects/${id}/layout`)).json();
    const r1 = before.pinHoles.R1;
    const holes = { '1': { col: r1['1'].col + 3, row: r1['1'].row }, '2': { col: r1['2'].col + 3, row: r1['2'].row } };
    const moved = await (await json(`/api/projects/${id}/layout/move`, { ref: 'R1', holes })).json();
    expect(moved.pinHoles.R1).toEqual(holes);
    const bad = await json(`/api/projects/${id}/layout/move`, { ref: 'R1', holes: { '1': { col: 1, row: 'a' } } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/pin 2/);
    const opts = await (await json(`/api/projects/${id}/layout/options`, { dipSwitchPositions: 4 })).json();
    expect(opts.packages[0].kind).toBe('dipswitch');
    const col = await (await json(`/api/projects/${id}/layout/colors`, { net: '/A', color: '#abcdef' })).json();
    expect(col.nets['/A'].color).toBe('#abcdef');
    const reset = await (await json(`/api/projects/${id}/layout/reset`, {})).json();
    expect(reset.packages[0].kind).toBe('dip');
    const sim = await (await json(`/api/projects/${id}/sim`, { levels: { '/A': 1, '/B': 1 } })).json();
    expect(sim.nets['/Y1']).toBe(0);
    expect((await json(`/api/projects/zzz/layout`)).status).toBe(404);
  });

  test('openapi, connect, parts and events', async () => {
    const { json, app } = await setup();
    const doc = await (await json('/openapi.json')).json();
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(Object.keys(doc.paths)).toContain('/api/projects/{id}/layout');
    const connect = await (await json('/api/connect')).json();
    expect(connect.snippets.length).toBeGreaterThan(3);
    expect(connect.mcpUrl).toMatch(/\/mcp$/);
    const parts = await (await json('/api/parts')).json();
    expect(parts.some((p: { alias: string }) => p.alias === '74LS00')).toBe(true);
    const res = await app.request('/api/events');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd circut-ai-tool && bun test test/api.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write src/parts/aliases.ts** (pure; the catalog the edit tools and `/api/parts` expose)

```ts
// Human names -> KiCad lib_ids for the parts the tool knows how to place.

export interface PartAlias {
  alias: string;
  libId: string;
  description: string;
  defaultValue?: string;
}

export const PART_ALIASES: PartAlias[] = [
  { alias: 'resistor', libId: 'Device:R', description: 'resistor, 2 leads', defaultValue: '1k' },
  { alias: 'capacitor', libId: 'Device:C', description: 'ceramic or film capacitor, 2 leads', defaultValue: '100n' },
  { alias: 'electrolytic capacitor', libId: 'Device:C_Polarized', description: 'polarised capacitor, + lead on pin 1', defaultValue: '10u' },
  { alias: 'inductor', libId: 'Device:L', description: 'inductor, 2 leads', defaultValue: '1m' },
  { alias: 'diode', libId: 'Diode:1N4148', description: 'small-signal diode, K on pin 1', defaultValue: '1N4148' },
  { alias: '1N4001', libId: 'Diode:1N4001', description: 'rectifier diode', defaultValue: '1N4001' },
  { alias: 'zener', libId: 'Device:D_Zener', description: 'Zener diode, K on pin 1', defaultValue: '5V1' },
  { alias: 'LED', libId: 'Device:LED', description: 'LED, K on pin 1, A on pin 2', defaultValue: 'LED' },
  { alias: 'switch', libId: 'Switch:SW_SPST', description: 'SPST switch', defaultValue: 'SW_SPST' },
  { alias: 'pushbutton', libId: 'Switch:SW_Push', description: 'momentary pushbutton', defaultValue: 'SW_Push' },
  { alias: 'DIP switch 4', libId: 'Switch:SW_DIP_x04', description: '4-position DIP switch', defaultValue: 'SW_DIP_x04' },
  { alias: 'DIP switch 8', libId: 'Switch:SW_DIP_x08', description: '8-position DIP switch', defaultValue: 'SW_DIP_x08' },
  { alias: 'potentiometer', libId: 'Device:R_Potentiometer', description: 'potentiometer, wiper on pin 2', defaultValue: '10k' },
  { alias: 'NPN', libId: 'Transistor_BJT:2N3904', description: 'NPN transistor TO-92 (E B C)', defaultValue: '2N3904' },
  { alias: 'PNP', libId: 'Transistor_BJT:2N3906', description: 'PNP transistor TO-92 (E B C)', defaultValue: '2N3906' },
  { alias: 'NMOS', libId: 'Transistor_FET:2N7000', description: 'N-channel MOSFET TO-92 (S G D)', defaultValue: '2N7000' },
  { alias: 'LM741', libId: 'Amplifier_Operational:LM741', description: 'single op-amp, DIP-8, split supply', defaultValue: 'LM741' },
  { alias: 'LM358', libId: 'Amplifier_Operational:LM358', description: 'dual op-amp, DIP-8', defaultValue: 'LM358' },
  { alias: 'LM324', libId: 'Amplifier_Operational:LM324', description: 'quad op-amp, DIP-14', defaultValue: 'LM324' },
  { alias: '555', libId: 'Timer:NE555P', description: '555 timer, DIP-8', defaultValue: 'NE555P' },
  { alias: '7-segment display', libId: 'Display_Character:D168K', description: '7-segment display, common cathode, 10 pins', defaultValue: 'D168K' },
  ...['00', '02', '04', '08', '10', '11', '20', '21', '27', '30', '32', '86', '47', '48', '74', '76', '90', '93', '138', '139', '151', '153', '157', '161', '164', '165', '174', '175', '193', '283'].map((code) => ({ alias: `74LS${code}`, libId: `74xx:74LS${code}`, description: `74LS${code} logic IC`, defaultValue: `74LS${code}` })),
  { alias: '+5V', libId: 'power:+5V', description: 'power symbol, connects to the +5V net' },
  { alias: '+12V', libId: 'power:+12V', description: 'power symbol' },
  { alias: '-12V', libId: 'power:-12V', description: 'power symbol' },
  { alias: 'GND', libId: 'power:GND', description: 'ground symbol' },
];

export function resolveAlias(name: string): PartAlias | undefined {
  const n = name.trim().toLowerCase();
  return PART_ALIASES.find((p) => p.alias.toLowerCase() === n || p.libId.toLowerCase() === n || p.libId.split(':')[1].toLowerCase() === n);
}
```

- [ ] **Step 4: Write server/png.ts**

```ts
// SVG -> PNG through resvg. Loaded lazily so a broken native addon only
// disables PNG output instead of the whole server.

export class PngError extends Error {}

type ResvgCtor = new (svg: string, opts: unknown) => { render(): { asPng(): Uint8Array } };
let ctor: ResvgCtor | null | undefined;

function load(): ResvgCtor | null {
  if (ctor !== undefined) return ctor;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ctor = (require('@resvg/resvg-js') as { Resvg: ResvgCtor }).Resvg;
  } catch {
    ctor = null;
  }
  return ctor;
}

export function pngAvailable(): boolean {
  return load() !== null;
}

export function renderPng(svg: string, width = 1600): Uint8Array {
  const Resvg = load();
  if (!Resvg) throw new PngError('PNG rendering is unavailable: @resvg/resvg-js failed to load. SVG output still works.');
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: width }, background: '#F6F4EE', font: { loadSystemFonts: true, defaultFontFamily: 'Consolas' } });
  return r.render().asPng();
}
```

- [ ] **Step 5: Write server/api.ts**

```ts
// REST routes. Every route is a thin call into the Service; errors map to
// JSON {error} with the ServiceError status.

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { PART_ALIASES } from '../src/parts/aliases.ts';
import { renderSvg, type Highlight } from '../src/render/index.ts';
import { DARK, LIGHT } from '../src/render/theme.ts';
import { summarize } from '../src/pipeline.ts';
import { buildConnectInfo } from './connect.ts';
import { pngAvailable, renderPng } from './png.ts';
import { ServiceError, type ProjectEvent, type Service } from './service.ts';
import type { Events } from './watch.ts';

export function parseHighlight(q: string | undefined): Highlight | null {
  if (!q) return null;
  const [kind, ...rest] = q.split(':');
  const v = rest.join(':');
  if (kind === 'net' && v) return { net: v };
  if (kind === 'ref' && v) return { ref: v };
  if (kind === 'wire' && /^\d+$/.test(v)) return { wire: Number(v) };
  return null;
}

export function summaryOf(p: ReturnType<Service['get']>) {
  return {
    id: p.info.id,
    name: p.info.name,
    path: p.info.path,
    components: [...p.design.components.values()].map((c) => ({ ref: c.ref, value: p.doc.values[c.ref] ?? c.value, lib: c.lib, part: c.part, pins: c.pins.size, footprint: p.doc.footprints[c.ref]?.kind ?? 'unknown' })),
    nets: [...p.design.nets.keys()].filter((n) => !n.startsWith('unconnected-')),
    board: p.doc.board,
    options: p.sidecar.options,
    errors: p.doc.checks.filter((c) => c.level === 'error').length,
    warnings: p.doc.checks.filter((c) => c.level === 'warning').length,
    unplaced: p.doc.unplaced,
    summary: summarize(p.doc),
  };
}

export function createApi(service: Service, events: Events<ProjectEvent>): Hono {
  const api = new Hono();

  api.onError((err, c) => {
    if (err instanceof ServiceError) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  api.get('/projects', async (c) => c.json(await service.list()));
  api.post('/projects/open', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { path?: string };
    if (!body.path) throw new ServiceError('body must be {"path": "<absolute path to a .kicad_sch>"}');
    const p = await service.open(body.path);
    return c.json(summaryOf(p));
  });
  api.get('/projects/:id', (c) => c.json(summaryOf(service.get(c.req.param('id')))));
  api.post('/projects/:id/refresh', async (c) => c.json(summaryOf(await service.refresh(c.req.param('id')))));
  api.delete('/projects/:id', (c) => {
    service.close(c.req.param('id'));
    return c.json({ ok: true });
  });
  api.get('/projects/:id/layout', (c) => c.json(service.get(c.req.param('id')).doc));
  api.get('/projects/:id/steps', (c) => c.json(service.get(c.req.param('id')).doc.steps));
  api.get('/projects/:id/checks', (c) => c.json(service.get(c.req.param('id')).doc.checks));
  api.get('/projects/:id/truth-table', (c) => {
    const s = service.get(c.req.param('id')).doc.sim;
    return c.json(s.truthTable ?? { rows: [], note: s.note });
  });
  api.get('/projects/:id/pinouts', (c) => c.json(service.get(c.req.param('id')).doc.pinouts));
  api.get('/projects/:id/board.svg', (c) => {
    const p = service.get(c.req.param('id'));
    const svg = renderSvg(p.doc, { highlight: parseHighlight(c.req.query('highlight')), theme: c.req.query('theme') === 'dark' ? DARK : LIGHT });
    return c.body(svg, 200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-cache' });
  });
  api.get('/projects/:id/board.png', (c) => {
    const p = service.get(c.req.param('id'));
    if (!pngAvailable()) return c.json({ error: 'PNG rendering unavailable; use board.svg' }, 501);
    const png = renderPng(renderSvg(p.doc, { highlight: parseHighlight(c.req.query('highlight')) }));
    return c.body(png, 200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
  });
  api.get('/projects/:id/schematic.svg', async (c) => c.body(await service.schematicSvg(c.req.param('id')), 200, { 'content-type': 'image/svg+xml; charset=utf-8' }));
  api.post('/projects/:id/sim', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { levels?: Record<string, 0 | 1> };
    return c.json(service.simulate(c.req.param('id'), body.levels ?? {}));
  });
  api.post('/projects/:id/layout/options', async (c) => c.json((await service.setOptions(c.req.param('id'), await c.req.json())).doc));
  api.post('/projects/:id/layout/move', async (c) => {
    const body = (await c.req.json()) as { ref?: string; holes?: Record<string, { col: number; row: string }> };
    if (!body.ref || !body.holes) throw new ServiceError('body must be {"ref": "R1", "holes": {"1": {"col": 3, "row": "a"}, ...}}');
    return c.json((await service.movePart(c.req.param('id'), body.ref, body.holes as never)).doc);
  });
  api.post('/projects/:id/layout/colors', async (c) => {
    const body = (await c.req.json()) as { net?: string; color?: string | null };
    if (!body.net) throw new ServiceError('body must be {"net": "/A", "color": "#rrggbb" | null}');
    return c.json((await service.setColor(c.req.param('id'), body.net, body.color ?? null)).doc);
  });
  api.post('/projects/:id/layout/reset', async (c) => c.json((await service.resetLayout(c.req.param('id'))).doc));
  api.post('/projects/:id/erc', async (c) => c.json(await service.erc(c.req.param('id'))));
  api.get('/connect', (c) => c.json(buildConnectInfo()));
  api.get('/parts', (c) => c.json(PART_ALIASES));
  api.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const unsub = events.subscribe((ev) => void stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) }));
      let alive = true;
      stream.onAbort(() => {
        alive = false;
        unsub();
      });
      await stream.writeSSE({ event: 'hello', data: '{}' });
      while (alive) {
        await stream.sleep(25_000);
        if (alive) await stream.writeSSE({ event: 'ping', data: '{}' });
      }
    }),
  );
  return api;
}
```

- [ ] **Step 6: Write server/connect.ts**

```ts
// Copy and paste snippets for connecting chat clients to this server.

import path from 'node:path';
import { APP_NAME, PROJECT_ROOT, PUBLIC_URL } from './config.ts';

export interface ConnectSnippet {
  id: string;
  title: string;
  how: string;
  language: 'json' | 'bash' | 'text';
  code: string;
}

export const TOOL_NAMES = ['list_projects', 'open_schematic', 'refresh', 'get_summary', 'get_layout', 'render_breadboard', 'render_schematic', 'get_build_steps', 'get_checks', 'get_truth_table', 'get_pinout', 'explain_net', 'simulate', 'list_supported_parts', 'set_layout_options', 'move_part', 'set_net_color', 'reset_layout', 'run_erc', 'add_component', 'connect', 'disconnect', 'remove_component', 'set_value'];

export function buildConnectInfo() {
  const stdioScript = path.join(PROJECT_ROOT, 'server', 'mcp-stdio.ts');
  const bunExe = process.execPath;
  const mcpUrl = `${PUBLIC_URL}/mcp`;
  const openapiUrl = `${PUBLIC_URL}/openapi.json`;
  const snippets: ConnectSnippet[] = [
    { id: 'claude-desktop', title: 'Claude Desktop (stdio, works even when this server is closed)', how: 'Claude Desktop: Settings, Developer, Edit Config. Merge this into claude_desktop_config.json, save, then fully quit and reopen Claude Desktop.', language: 'json', code: JSON.stringify({ mcpServers: { [APP_NAME]: { command: bunExe, args: [stdioScript] } } }, null, 2) },
    { id: 'claude-connector', title: 'Claude Desktop or claude.ai (custom connector over HTTP)', how: 'Settings, Connectors, Add custom connector, paste this URL. Needs the server running (bun start). If only https is accepted, expose it with a tunnel (see ChatGPT) and paste the tunnel URL plus /mcp.', language: 'text', code: mcpUrl },
    { id: 'claude-code', title: 'Claude Code', how: 'Run once in any terminal. The existing "circuit-designer" registration keeps working because /mcp-server/mcp is an alias of /mcp.', language: 'bash', code: [`claude mcp add --transport http ${APP_NAME} ${mcpUrl}`, `# or, without the web server running:`, `claude mcp add ${APP_NAME} -- "${bunExe}" "${stdioScript}"`].join('\n') },
    { id: 'chatgpt', title: 'ChatGPT (desktop or web)', how: 'ChatGPT reaches MCP servers over the internet only. Expose the local server with a tunnel, then Settings, Connectors (Developer mode under Advanced), Create, paste the tunnel URL plus /mcp. The tunnel URL plus /openapi.json also works as a Custom GPT Action.', language: 'bash', code: [`bun start`, `# second terminal, either:`, `npx cloudflared tunnel --url ${PUBLIC_URL}`, `# or:`, `ngrok http ${PUBLIC_URL.replace(/^https?:\/\//, '')}`, `# then paste  https://<tunnel-host>/mcp  into ChatGPT`].join('\n') },
    { id: 'codex', title: 'Codex CLI', how: 'Register the running server.', language: 'bash', code: `codex mcp add ${APP_NAME} --url ${mcpUrl}` },
    { id: 'api', title: 'Plain HTTP', how: 'Open a schematic, then read the layout or the picture.', language: 'bash', code: [`curl -X POST ${PUBLIC_URL}/api/projects/open -H "content-type: application/json" -d "{\\"path\\": \\"C:/Users/you/Documents/KiCad/9.0/projects/PL1_1/PL1_1.kicad_sch\\"}"`, `curl ${PUBLIC_URL}/api/projects/<id>/layout`, `curl ${PUBLIC_URL}/api/projects/<id>/board.png -o board.png`, `curl ${openapiUrl}`].join('\n') },
  ];
  return { appUrl: PUBLIC_URL, mcpUrl, mcpAliasUrl: `${PUBLIC_URL}/mcp-server/mcp`, openapiUrl, stdioCommand: `"${bunExe}" "${stdioScript}"`, projectDir: PROJECT_ROOT, tools: TOOL_NAMES, snippets };
}
```

- [ ] **Step 7: Write server/openapi.ts**

```ts
// OpenAPI 3.1 description of the REST routes (also usable as a ChatGPT Action).

import { APP_NAME, APP_VERSION, PUBLIC_URL } from './config.ts';

const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'project id from /api/projects/open' };
const json = (description: string) => ({ description, content: { 'application/json': { schema: { type: 'object' } } } });
const op = (summary: string, extra: Record<string, unknown> = {}) => ({ summary, parameters: [id], responses: { '200': json('OK'), '400': json('bad request'), '404': json('not open') }, ...extra });
const body = (schema: Record<string, unknown>) => ({ required: true, content: { 'application/json': { schema } } });

export function openapiDocument() {
  return {
    openapi: '3.1.0',
    info: { title: APP_NAME, version: APP_VERSION, description: 'KiCad schematic to breadboard layout, build guide, checks, logic simulation and schematic edits.' },
    servers: [{ url: PUBLIC_URL }],
    paths: {
      '/api/projects': { get: { summary: 'Recent and discovered schematics', responses: { '200': json('lists') } } },
      '/api/projects/open': { post: { summary: 'Open a .kicad_sch by absolute path', requestBody: body({ type: 'object', required: ['path'], properties: { path: { type: 'string' } } }), responses: { '200': json('summary') } } },
      '/api/projects/{id}': { get: op('Summary of an open project'), delete: op('Close a project') },
      '/api/projects/{id}/refresh': { post: op('Re-read the schematic from disk') },
      '/api/projects/{id}/layout': { get: op('Full layout document') },
      '/api/projects/{id}/steps': { get: op('Build steps') },
      '/api/projects/{id}/checks': { get: op('Checks') },
      '/api/projects/{id}/truth-table': { get: op('Truth table') },
      '/api/projects/{id}/pinouts': { get: op('Chip pinouts with holes') },
      '/api/projects/{id}/board.svg': { get: op('Breadboard picture as SVG', { parameters: [id, { name: 'highlight', in: 'query', schema: { type: 'string' }, description: 'net:/A, ref:R1 or wire:3' }, { name: 'theme', in: 'query', schema: { type: 'string', enum: ['light', 'dark'] } }] }) },
      '/api/projects/{id}/board.png': { get: op('Breadboard picture as PNG') },
      '/api/projects/{id}/schematic.svg': { get: op('KiCad schematic as SVG') },
      '/api/projects/{id}/sim': { post: op('Simulate with explicit input levels', { requestBody: body({ type: 'object', properties: { levels: { type: 'object', additionalProperties: { type: 'integer', enum: [0, 1] } } } }) }) },
      '/api/projects/{id}/layout/options': { post: op('Set layout options', { requestBody: body({ type: 'object', properties: { board: { type: 'string', enum: ['auto', 'half', 'full'] }, railSplit: { type: ['boolean', 'null'] }, dipSwitchPositions: { type: 'integer' }, packageOrder: { type: 'array', items: { type: 'string' } }, substitutions: { type: 'object' } } }) }) },
      '/api/projects/{id}/layout/move': { post: op('Move a part to given holes', { requestBody: body({ type: 'object', required: ['ref', 'holes'], properties: { ref: { type: 'string' }, holes: { type: 'object' } } }) }) },
      '/api/projects/{id}/layout/colors': { post: op('Set a net colour', { requestBody: body({ type: 'object', required: ['net'], properties: { net: { type: 'string' }, color: { type: ['string', 'null'] } } }) }) },
      '/api/projects/{id}/layout/reset': { post: op('Forget pinned placements, options and colours') },
      '/api/projects/{id}/erc': { post: op('Run KiCad ERC') },
      '/api/parts': { get: { summary: 'Supported parts and aliases', responses: { '200': json('list') } } },
      '/api/connect': { get: { summary: 'Connection snippets', responses: { '200': json('snippets') } } },
    },
  };
}
```

- [ ] **Step 8: Write server/app.ts**

```ts
// The Hono application: /api, /openapi.json, /mcp (+ alias) and the built
// client from dist/. Exported without listening so tests use app.request().

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createApi } from './api.ts';
import { DIST_DIR } from './config.ts';
import { openapiDocument } from './openapi.ts';
import type { ProjectEvent, Service } from './service.ts';
import type { Events } from './watch.ts';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.map': 'application/json' };

export function createApp(deps: { service: Service; events: Events<ProjectEvent>; mcp: () => McpServer }): Hono {
  const app = new Hono();
  app.use('*', cors({ origin: '*', allowHeaders: ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'authorization'], exposeHeaders: ['mcp-session-id'] }));
  app.route('/api', createApi(deps.service, deps.events));
  app.get('/openapi.json', (c) => c.json(openapiDocument()));
  app.get('/api/health', (c) => c.json({ ok: true }));

  const mcpHandler = async (c: { req: { raw: Request } }) => {
    const server = deps.mcp();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      c.req.raw.signal.addEventListener('abort', () => void server.close().catch(() => {}));
    }
  };
  app.all('/mcp', mcpHandler);
  app.all('/mcp-server/mcp', mcpHandler);

  const cache = new Map<string, { body: Uint8Array; type: string }>();
  app.get('*', async (c) => {
    let rel = decodeURIComponent(new URL(c.req.url).pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(DIST_DIR, rel));
    if (!file.startsWith(DIST_DIR)) return c.text('Not found', 404);
    const immutable = rel.startsWith('/assets/');
    try {
      let hit = immutable ? cache.get(file) : undefined;
      if (!hit) {
        if (!(await stat(file)).isFile()) throw new Error('not a file');
        hit = { body: new Uint8Array(await readFile(file)), type: MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' };
        if (immutable) cache.set(file, hit);
      }
      return new Response(hit.body, { headers: { 'content-type': hit.type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' } });
    } catch {
      if (rel === '/index.html') return c.html('<!doctype html><meta charset="utf-8"><title>Circuit AI Tool</title><body style="font-family:system-ui;padding:2rem"><h1>Circuit AI Tool</h1><p>The web client is not built yet. Run <code>bun run build</code> in the project folder and reload.</p><p>The API is up: <a href="/api/projects">/api/projects</a>, <a href="/openapi.json">/openapi.json</a>, MCP at <code>/mcp</code>.</p></body>', 503);
      return c.text('Not found', 404);
    }
  });
  return app;
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd circut-ai-tool && bun test test/api.test.ts`
Expected: all pass. If the PNG test reports 501, `@resvg/resvg-js` did not load under Bun on Windows: run `bun -e "console.log(require('@resvg/resvg-js').Resvg)"` and read the error; the usual fix is `bun add @resvg/resvg-js-win32-x64-msvc` to pull the platform package explicitly.

- [ ] **Step 10: Commit**

```bash
git add circut-ai-tool/src/parts/aliases.ts circut-ai-tool/server/png.ts circut-ai-tool/server/api.ts circut-ai-tool/server/connect.ts circut-ai-tool/server/openapi.ts circut-ai-tool/server/app.ts circut-ai-tool/test/api.test.ts
git commit -m "feat(circuit): REST API, PNG output, SSE events, OpenAPI and connect snippets"
```

---

### Task 17: MCP server, stdio entry and the HTTP entry point

**Files:**
- Create: `circut-ai-tool/server/mcp.ts`
- Create: `circut-ai-tool/server/mcp-stdio.ts`
- Create: `circut-ai-tool/server/boot.ts`
- Create: `circut-ai-tool/server/index.ts`
- Test: `circut-ai-tool/test/mcp.test.ts`

**Interfaces:**
- Produces (mcp.ts): `createMcpServer(service: Service): McpServer` with the 19 read/layout tools (the five edit tools are registered by part 4 in the same file)
- Produces (boot.ts): `bootService(opts?: { watch?: boolean }): Promise<{ service: Service; events: Events<ProjectEvent> }>` (wires real config, registry, kicad-cli)
- Produces (index.ts): starts `Bun.serve` on `HOST:PORT`
- Produces (mcp-stdio.ts): the same tools over stdio; logs to stderr only

- [ ] **Step 1: Write the failing test**

`test/mcp.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../server/mcp.ts';
import { makeService } from './service.test.ts';

async function connect() {
  const { service, sch } = await makeService();
  const server = createMcpServer(service);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return { client, sch };
}

type Result = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

describe('MCP tools', () => {
  test('lists the tools and opens a schematic', async () => {
    const { client, sch } = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ['list_projects', 'open_schematic', 'get_summary', 'render_breadboard', 'explain_net', 'simulate', 'move_part', 'run_erc']) expect(tools).toContain(t);
    const opened = (await client.callTool({ name: 'open_schematic', arguments: { path: sch } })) as Result;
    expect(opened.isError).toBeFalsy();
    const id = opened.structuredContent!.id as string;
    expect(id).toHaveLength(10);
    const summary = (await client.callTool({ name: 'get_summary', arguments: { project: id } })) as Result;
    expect(summary.content[0].text).toMatch(/3 chips/);
    const listed = (await client.callTool({ name: 'list_projects', arguments: {} })) as Result;
    expect(listed.content[0].text).toContain('PL1_1');
  });

  test('questions: explain_net, get_pinout, truth table, steps, checks', async () => {
    const { client, sch } = await connect();
    const id = ((await client.callTool({ name: 'open_schematic', arguments: { path: sch } })) as Result).structuredContent!.id as string;
    const net = (await client.callTool({ name: 'explain_net', arguments: { project: id, net: 'A' } })) as Result;
    expect(net.content[0].text).toMatch(/U3 pin 1/);
    expect(net.content[0].text).toMatch(/wire/);
    const pin = (await client.callTool({ name: 'get_pinout', arguments: { project: id, ref: 'U3' } })) as Result;
    expect(pin.content[0].text).toMatch(/pin 14 VCC/);
    const tt = (await client.callTool({ name: 'get_truth_table', arguments: { project: id } })) as Result;
    expect(tt.content[0].text).toMatch(/A\s+B\s+\|\s+Y1\s+Y2/);
    const steps = (await client.callTool({ name: 'get_build_steps', arguments: { project: id } })) as Result;
    expect(steps.content[0].text).toMatch(/^1\. /m);
    const checks = (await client.callTool({ name: 'get_checks', arguments: { project: id } })) as Result;
    expect(checks.structuredContent!.errors).toBe(0);
    const sim = (await client.callTool({ name: 'simulate', arguments: { project: id, levels: { A: 1, B: 0 } } })) as Result;
    expect(sim.content[0].text).toMatch(/Y1 = 1/);
  });

  test('render returns an image (or SVG text when PNG is unavailable)', async () => {
    const { client, sch } = await connect();
    const id = ((await client.callTool({ name: 'open_schematic', arguments: { path: sch } })) as Result).structuredContent!.id as string;
    const r = (await client.callTool({ name: 'render_breadboard', arguments: { project: id, highlight_net: 'A' } })) as Result;
    const img = r.content.find((c) => c.type === 'image');
    if (img) expect(img.mimeType).toBe('image/png');
    else expect(r.content.some((c) => c.text?.includes('<svg'))).toBe(true);
    expect(r.content.some((c) => c.type === 'text')).toBe(true);
  });

  test('layout edits and bad input', async () => {
    const { client, sch } = await connect();
    const id = ((await client.callTool({ name: 'open_schematic', arguments: { path: sch } })) as Result).structuredContent!.id as string;
    const moved = (await client.callTool({ name: 'move_part', arguments: { project: id, ref: 'R1', holes: { '1': 'a20', '2': 'b20' } } })) as Result;
    expect(moved.isError).toBeFalsy();
    expect(moved.content[0].text).toMatch(/R1 now at a20 and b20/);
    const bad = (await client.callTool({ name: 'move_part', arguments: { project: id, ref: 'R1', holes: { '1': 'zz9' } } })) as Result;
    expect(bad.isError).toBe(true);
    const opts = (await client.callTool({ name: 'set_layout_options', arguments: { project: id, dipSwitchPositions: 4 } })) as Result;
    expect(opts.content[0].text).toMatch(/DIP switch/);
    const parts = (await client.callTool({ name: 'list_supported_parts', arguments: {} })) as Result;
    expect(parts.content[0].text).toContain('74LS00');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd circut-ai-tool && bun test test/mcp.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write server/mcp.ts**

```ts
// MCP tools over the Service. One McpServer per HTTP request (stateless) and
// one for the stdio entry point. Text content is written for a reader; the
// same facts go into structuredContent for programs.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { holeName, parseHole } from '../src/layout/board.ts';
import type { Hole } from '../src/layout/types.ts';
import { displayName, isUnconnected } from '../src/netlist.ts';
import { PART_ALIASES } from '../src/parts/aliases.ts';
import { summarize } from '../src/pipeline.ts';
import { renderSvg } from '../src/render/index.ts';
import { summaryOf } from './api.ts';
import { APP_NAME, APP_VERSION, PUBLIC_URL } from './config.ts';
import { pngAvailable, renderPng } from './png.ts';
import { ServiceError, type OpenProject, type Service } from './service.ts';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
const text = (t: string): Content => ({ type: 'text', text: t });
const fail = (message: string) => ({ isError: true as const, content: [text(message)], structuredContent: { ok: false, error: message } });
const project = z.string().describe('Project id from open_schematic, or the absolute path of the .kicad_sch.');

/** Accept "A" or "/A" or "+5V" and return the exact net name in the design. */
export function resolveNet(p: OpenProject, name: string): string {
  if (p.design.nets.has(name)) return name;
  const hit = [...p.design.nets.keys()].find((n) => displayName(n) === name || displayName(n).toLowerCase() === name.toLowerCase());
  if (!hit) throw new ServiceError(`no net "${name}". Nets: ${[...p.design.nets.keys()].filter((n) => !isUnconnected(n)).map(displayName).join(', ')}`, 404);
  return hit;
}

export function checksText(p: OpenProject): string {
  const lines = p.doc.checks.map((c) => `${c.level.toUpperCase()}: ${c.message}`);
  return lines.length ? lines.join('\n') : 'no checks';
}

export function reminder(): string {
  return `Web view: ${PUBLIC_URL}/#/p/<id>. Hole names: rows a-e top half, f-j bottom half, columns from 1; rails T+ T- B+ B-.`;
}

export function createMcpServer(service: Service): McpServer {
  const server = new McpServer(
    { name: APP_NAME, version: APP_VERSION },
    {
      instructions:
        'Circuit AI Tool turns a KiCad schematic into a breadboard wiring diagram with a build guide, wiring checks and a logic simulator, and can edit the schematic. ' +
        'Start with open_schematic (absolute path) or list_projects. Layout tools (move_part, set_layout_options, set_net_color, reset_layout) change only where parts sit on the board, never the circuit. ' +
        'Schematic tools (add_component, connect, disconnect, remove_component, set_value) change the .kicad_sch itself after making a backup. ' +
        reminder(),
    },
  );

  const open = async (idOrPath: string) => (service.has(idOrPath) ? service.get(idOrPath) : service.open(idOrPath));
  const guard = <T,>(fn: () => Promise<T> | T) => async () => {
    try {
      return await fn();
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  };

  server.registerTool('list_projects', { title: 'List schematics', description: 'Recently opened schematics and every .kicad_sch found in the KiCad projects folder, with ids and paths.', inputSchema: {}, annotations: { readOnlyHint: true } }, guard(async () => {
    const { recent, found } = await service.list();
    const lines = ['Recent:', ...recent.map((p) => `  ${p.id}  ${p.name}  ${p.path}`), 'Found in the projects folder:', ...found.map((f) => `  ${f.name}  ${f.path}`)];
    return { content: [text(lines.join('\n'))], structuredContent: { recent, found } };
  }));

  server.registerTool('open_schematic', { title: 'Open a schematic', description: 'Open a .kicad_sch by absolute path (or a known id), export its netlist through kicad-cli, lay it out on a breadboard and run the checks. Returns the id used by every other tool.', inputSchema: { path: z.string().describe('Absolute path to the .kicad_sch, or a project id') } }, ({ path }) => guard(async () => {
    const p = await service.open(path);
    const s = summaryOf(p);
    return { content: [text(`Opened ${p.info.name} (id ${p.info.id}).\n${s.summary}\n${reminder()}`)], structuredContent: { ...s, ok: true } };
  })());

  server.registerTool('refresh', { title: 'Re-read the schematic', description: 'Re-read the file from disk after it changed in KiCad and rebuild the layout.', inputSchema: { project } }, ({ project: id }) => guard(async () => {
    const p = await service.refresh((await open(id)).info.id);
    return { content: [text(summarize(p.doc))], structuredContent: summaryOf(p) };
  })());

  server.registerTool('get_summary', { title: 'Summary', description: 'Components, nets, board size, check counts and unplaced parts of an open project.', inputSchema: { project }, annotations: { readOnlyHint: true } }, ({ project: id }) => guard(async () => {
    const p = await open(id);
    const s = summaryOf(p);
    const comps = s.components.map((c) => `${c.ref} ${c.value} (${c.lib}:${c.part}, ${c.footprint})`).join('; ');
    return { content: [text(`${s.summary}\nComponents: ${comps}\nNets: ${s.nets.map(displayName).join(', ')}`)], structuredContent: s };
  })());

  server.registerTool('get_layout', { title: 'Full layout JSON', description: 'The whole layout document: board, packages, parts, wires, pin holes, nets, steps, pinouts, checks, simulation model.', inputSchema: { project }, annotations: { readOnlyHint: true } }, ({ project: id }) => guard(async () => {
    const p = await open(id);
    return { content: [text(JSON.stringify(p.doc))], structuredContent: p.doc as unknown as Record<string, unknown> };
  })());

  server.registerTool('render_breadboard', { title: 'Picture of the breadboard', description: 'PNG of the wired breadboard. Optionally highlight one net, one part, or one build step (everything else is dimmed).', inputSchema: { project, highlight_net: z.string().optional().describe('Net name, e.g. "A" or "+5V"'), highlight_ref: z.string().optional().describe('Part reference, e.g. "U1"'), highlight_step: z.number().int().optional().describe('Build step number') }, annotations: { readOnlyHint: true } }, ({ project: id, highlight_net, highlight_ref, highlight_step }) => guard(async () => {
    const p = await open(id);
    let highlight = null;
    if (highlight_net) highlight = { net: resolveNet(p, highlight_net) };
    else if (highlight_ref) highlight = { ref: highlight_ref };
    else if (highlight_step) {
      const step = p.doc.steps.find((s) => s.n === highlight_step);
      if (!step) return fail(`no step ${highlight_step}; there are ${p.doc.steps.length}`);
      highlight = step.wire !== undefined ? { wire: step.wire } : step.ref ? { ref: step.ref } : null;
    }
    const svg = renderSvg(p.doc, { highlight });
    const caption = `${p.info.name}: ${summarize(p.doc).split('\n')[0]}${highlight ? ` Highlighted: ${JSON.stringify(highlight)}.` : ''}`;
    if (!pngAvailable()) return { content: [text(caption), text(svg)] };
    return { content: [{ type: 'image', data: Buffer.from(renderPng(svg)).toString('base64'), mimeType: 'image/png' }, text(caption)] };
  })());

  server.registerTool('render_schematic', { title: 'Picture of the schematic', description: 'PNG of the KiCad schematic itself, exported through kicad-cli.', inputSchema: { project }, annotations: { readOnlyHint: true } }, ({ project: id }) => guard(async () => {
    const p = await open(id);
    const svg = await service.schematicSvg(p.info.id);
    if (!pngAvailable()) return { content: [text(svg)] };
    return { content: [{ type: 'image', data: Buffer.from(renderPng(svg, 2000)).toString('base64'), mimeType: 'image/png' }, text(`Schematic of ${p.info.name}`)] };
  })());

  server.registerTool('get_build_steps', { title: 'Build steps', description: 'Numbered wiring steps grouped by phase, naming every hole.', inputSchema: { project }, annotations: { readOnlyHint: true } }, ({ project: id }) => guard(async () => {
    const p = await open(id);
    return { content: [text(p.doc.steps.map((s) => `${s.n}. [${s.phase}] ${s.label}`).join('\n'))], structuredContent: { steps: p.doc.steps } };
  })());

  server.registerTool('get_checks', { title: 'Checks', description: 'Wiring, power, polarity and DC checks with severity.', inputSchema: { project }, annotations: { readOnlyHint: true } }, ({ project: id }) => guard(async () => {
    const p = await open(id);
    return { content: [text(checksText(p))], structuredContent: { checks: p.doc.checks, errors: p.doc.checks.filter((c) => c.level === 'error').length } };
  })());

  server.registerTool('get_truth_table', { title: 'Truth table', description: 'Truth table over the switch-controlled inputs, with LED states, when the wiring passes the checks.', inputSchema: { project }, annotations: { readOnlyHint: true } }, ({ project: id }) => guard(async () => {
    const p = await open(id);
    const t = p.doc.sim.truthTable;
    if (!t) return { content: [text(`No truth table: ${p.doc.sim.note ?? 'unknown reason'}`)], structuredContent: { note: p.doc.sim.note } };
    const header = `${t.inputs.join('  ')}  |  ${t.outputs.join('  ')}  |  ${t.leds.join('  ')}`;
    const rows = t.rows.map((r) => `${r.inputs.join('  ')}  |  ${r.outputs.join('  ')}  |  ${r.leds.map((l) => (l ? 'on' : 'off')).join(' ')}`);
    return { content: [text([header, '-'.repeat(header.length), ...rows, p.doc.sim.note ? `Note: ${p.doc.sim.note}` : ''].join('\n'))], structuredContent: t as unknown as Record<string, unknown> };
  })());

  server.registerTool('get_pinout', { title: 'Chip pinout', description: 'Every pin of a chip: function, net and the breadboard hole it sits in.', inputSchema: { project, ref: z.string().describe('Chip reference, e.g. "U1"') }, annotations: { readOnlyHint: true } }, ({ project: id, ref }) => guard(async () => {
    const p = await open(id);
    const po = p.doc.pinouts.find((x) => x.ref === ref);
    if (!po) return fail(`no chip ${ref}; chips: ${p.doc.pinouts.map((x) => x.ref).join(', ') || 'none'}`);
    return { content: [text(`${po.ref} ${po.name}\n` + po.pins.map((x) => `pin ${x.num} ${x.function}${x.net ? ` = ${x.net}` : ' (unused)'}${x.hole ? `, hole ${x.hole}` : ''}`).join('\n'))], structuredContent: po as unknown as Record<string, unknown> };
  })());

  server.registerTool('explain_net', { title: 'Explain a net', description: 'Which pins, holes and jumper wires carry a net on the board.', inputSchema: { project, net: z.string().describe('Net name, e.g. "A", "Y1", "+5V"') }, annotations: { readOnlyHint: true } }, ({ project: id, net }) => guard(async () => {
    const p = await open(id);
    const name = resolveNet(p, net);
    const pins = (p.design.nets.get(name) ?? []).map((m) => {
      const h = p.doc.pinHoles[m.ref]?.[m.pin];
      return `${m.ref} pin ${m.pin}${h ? ` in ${holeName(h)}` : ' (not placed)'}`;
    });
    const wires = p.doc.wires.map((w, i) => ({ w, i })).filter(({ w }) => w.net === name).map(({ w, i }) => `wire ${i + 1}: ${holeName(w.a)} to ${holeName(w.b)} (${w.role})`);
    const info = p.doc.nets[name];
    return { content: [text(`Net ${displayName(name)}${info ? ` (colour ${info.color}${info.power ? `, ${info.power === 'gnd' ? 'ground' : 'supply'}` : ''})` : ''}\nPins: ${pins.join('; ')}\n${wires.length ? wires.join('\n') : 'No jumper wires (all pins share a strip or a rail).'}`)], structuredContent: { net: name, pins, wires } };
  })());

  server.registerTool('simulate', { title: 'Simulate', description: 'Logic levels of every net and the LED states for the given input levels (nets not given keep their idle level: switches open).', inputSchema: { project, levels: z.record(z.string(), z.union([z.literal(0), z.literal(1)])).describe('Net name -> 0 or 1, e.g. {"A": 1, "B": 0}') }, annotations: { readOnlyHint: true } }, ({ project: id, levels }) => guard(async () => {
    const p = await open(id);
    const mapped: Record<string, 0 | 1> = {};
    for (const [k, v] of Object.entries(levels)) mapped[resolveNet(p, k)] = v;
    const r = service.simulate(p.info.id, mapped);
    const outs = Object.entries(r.nets).filter(([n]) => !isUnconnected(n) && !n.startsWith('Net-(')).map(([n, v]) => `${displayName(n)} = ${v}`);
    const leds = Object.entries(r.leds).map(([ref, on]) => `${ref} ${on ? 'on' : 'off'}`);
    return { content: [text(`${outs.join(', ')}\nLEDs: ${leds.join(', ') || 'none'}`)], structuredContent: r as unknown as Record<string, unknown> };
  })());

  server.registerTool('list_supported_parts', { title: 'Supported parts', description: 'Part names and KiCad lib_ids that add_component accepts and the layout engine can place.', inputSchema: {}, annotations: { readOnlyHint: true } }, guard(async () => ({ content: [text(PART_ALIASES.map((a) => `${a.alias}  (${a.libId})  ${a.description}`).join('\n'))], structuredContent: { parts: PART_ALIASES } })));

  server.registerTool('set_layout_options', { title: 'Layout options', description: 'Board size, rail split, folding separate switches into one DIP switch, chip order, value substitutions. Layout only; the circuit is unchanged.', inputSchema: { project, board: z.enum(['auto', 'half', 'full']).optional(), railSplit: z.boolean().nullable().optional(), dipSwitchPositions: z.number().int().min(0).max(16).optional().describe('0 = separate switches; N = fold them into an N-position DIP switch'), packageOrder: z.array(z.string()).optional(), substitutions: z.record(z.string(), z.string()).optional().describe('ref -> value shown on the board') } }, ({ project: id, ...patch }) => guard(async () => {
    const p = await service.setOptions((await open(id)).info.id, patch);
    return { content: [text(`Options now ${JSON.stringify(p.sidecar.options)}. ${p.doc.packages.some((x) => x.kind === 'dipswitch') ? 'The board uses a DIP switch. ' : ''}${summarize(p.doc)}`)], structuredContent: { options: p.sidecar.options, checks: p.doc.checks } };
  })());

  server.registerTool('move_part', { title: 'Move a part', description: 'Pin every leg of a part to given holes ("a12", "T+3"). Wires re-route. Fails if a hole is taken or off the board.', inputSchema: { project, ref: z.string(), holes: z.record(z.string(), z.string()).describe('pin number -> hole name, e.g. {"1": "a12", "2": "a15"}') } }, ({ project: id, ref, holes }) => guard(async () => {
    const parsed: Record<string, Hole> = {};
    for (const [pin, h] of Object.entries(holes)) parsed[pin] = parseHole(h);
    const p = await service.movePart((await open(id)).info.id, ref, parsed);
    const now = Object.values(p.doc.pinHoles[ref]).map(holeName).join(' and ');
    return { content: [text(`${ref} now at ${now}.\n${checksText(p)}`)], structuredContent: { pinHoles: p.doc.pinHoles[ref], checks: p.doc.checks } };
  })());

  server.registerTool('set_net_color', { title: 'Net colour', description: 'Colour of the jumper wires of a net (#rrggbb), or null to go back to the default.', inputSchema: { project, net: z.string(), color: z.string().nullable() } }, ({ project: id, net, color }) => guard(async () => {
    const p0 = await open(id);
    const p = await service.setColor(p0.info.id, resolveNet(p0, net), color);
    return { content: [text(`${displayName(net)} wires are now ${p.doc.nets[resolveNet(p, net)].color}.`)], structuredContent: { colors: p.sidecar.colors } };
  })());

  server.registerTool('reset_layout', { title: 'Reset layout', description: 'Forget pinned placements, options and colours; lay the board out automatically again.', inputSchema: { project } }, ({ project: id }) => guard(async () => {
    const p = await service.resetLayout((await open(id)).info.id);
    return { content: [text(summarize(p.doc))], structuredContent: { checks: p.doc.checks } };
  })());

  server.registerTool('run_erc', { title: 'KiCad ERC', description: 'Run KiCad electrical rules check on the schematic and return the violations.', inputSchema: { project } }, ({ project: id }) => guard(async () => {
    const p = await open(id);
    const erc = (await service.erc(p.info.id)) as { sheets?: { violations?: { severity: string; description: string }[] }[] };
    const violations = (erc.sheets ?? []).flatMap((s) => s.violations ?? []);
    return { content: [text(violations.length ? violations.map((v) => `${v.severity}: ${v.description}`).join('\n') : 'ERC: no violations')], structuredContent: erc as Record<string, unknown> };
  })());

  return server;
}
```

- [ ] **Step 4: Write server/boot.ts, server/index.ts and server/mcp-stdio.ts**

`server/boot.ts`:

```ts
// Wire the real dependencies together (used by the HTTP and stdio entries).

import path from 'node:path';
import { DATA_DIR, KICAD_CLI, PROJECTS_DIR } from './config.ts';
import { createKicadCli } from './kicad-cli.ts';
import { ProjectRegistry } from './projects.ts';
import { Service, type ProjectEvent } from './service.ts';
import { Events } from './watch.ts';

export async function bootService(opts: { watch?: boolean } = {}) {
  const registry = new ProjectRegistry(DATA_DIR);
  await registry.load();
  const events = new Events<ProjectEvent>();
  const kicad = createKicadCli({ exe: KICAD_CLI, cacheDir: path.join(DATA_DIR, 'cache') });
  const service = new Service({ kicad, registry, events, watch: opts.watch ?? true, projectsDir: PROJECTS_DIR });
  return { service, events, kicad };
}
```

`server/index.ts`:

```ts
// HTTP entry point: `bun start`.

import { createApp } from './app.ts';
import { bootService } from './boot.ts';
import { HOST, KICAD_CLI, PORT, PUBLIC_URL } from './config.ts';
import { createMcpServer } from './mcp.ts';

const { service, events, kicad } = await bootService({ watch: true });
const app = createApp({ service, events, mcp: () => createMcpServer(service) });

Bun.serve({ hostname: HOST, port: PORT, fetch: app.fetch, idleTimeout: 255 });
console.log(`Circuit AI Tool: ${PUBLIC_URL}`);
console.log(`  API      ${PUBLIC_URL}/api/projects`);
console.log(`  OpenAPI  ${PUBLIC_URL}/openapi.json`);
console.log(`  MCP      ${PUBLIC_URL}/mcp  (alias ${PUBLIC_URL}/mcp-server/mcp)`);
console.log(`  kicad-cli ${(await kicad.available()) ? 'found' : 'NOT FOUND'} at ${KICAD_CLI}`);
```

`server/mcp-stdio.ts`:

```ts
// stdio MCP entry point for clients that launch a command (Claude Desktop).
// stdout carries the protocol; diagnostics go to stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { bootService } from './boot.ts';
import { createMcpServer } from './mcp.ts';

console.log = (...args: unknown[]) => console.error(...args);
const { service } = await bootService({ watch: true });
const server = createMcpServer(service);
await server.connect(new StdioServerTransport());
console.error('[circuit-ai-tool] stdio MCP server ready');
```

- [ ] **Step 5: Run the tests, then start the server for real**

Run: `cd circut-ai-tool && bun test && bun run typecheck`
Expected: all green.

Run in a second terminal: `cd circut-ai-tool && bun start`, then:

```powershell
curl.exe -s -X POST http://localhost:8765/api/projects/open -H "content-type: application/json" -d "{\"path\": \"C:/Users/rober/Documents/KiCad/9.0/projects/PL1_1/PL1_1.kicad_sch\"}"
curl.exe -s http://localhost:8765/api/projects/<id>/board.png -o board.png
```

Expected: JSON summary with `"errors": 0`; `board.png` opens and shows the wired board. Then in Claude Code run `/mcp` and confirm `circuit-designer` (the old registration) connects to this server, and call `get_summary`. Stop the server.

- [ ] **Step 6: Commit**

```bash
git add circut-ai-tool/server circut-ai-tool/test/mcp.test.ts
git commit -m "feat(circuit): MCP tools over HTTP and stdio, server entry points"
```

---

## Self-review (part 2)

- Spec coverage: config vars, kicad-cli wrapper with a content-hash cache (netlist, svg, erc), registry with ids and recent list, folder scan depth 2, sidecar next to the schematic, watcher with 300 ms debounce and SSE `/api/events`, service open/rebuild/move/options/colors/reset/simulate, sheets and buses refused with a message, every REST route in the spec table, OpenAPI 3.1, MCP tools (19 of the 24; the five edit tools come in part 4 and are already listed in `TOOL_NAMES` so the connect page is complete), stdio entry, connect snippets for Claude Desktop, connector, Claude Code, ChatGPT tunnel, Codex and curl, PNG through resvg with an SVG fallback.
- Placeholder scan: none. `createApp` takes an `mcp` factory so Task 16's tests run before Task 17 exists.
- Type consistency: `summaryOf` lives in `api.ts` and is imported by `mcp.ts`; `resolveNet`, `checksText`, `reminder` are exported from `mcp.ts` for part 4; `Service.movePart` takes `Record<string, Hole>` and the MCP tool parses hole names with `parseHole`; `ProjectEvent` type shared by service, api and watch.

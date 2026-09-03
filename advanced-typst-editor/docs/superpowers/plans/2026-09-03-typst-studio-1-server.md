# Typst Studio, plan 1 of 3: server (Bun) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `tfs-server` Bun process: plain-folder workspaces, REST API, SSE change bus, file watcher, typst CLI compile with server-side redaction baking, mirror + snapshot backups to any folder, MCP over Streamable HTTP, and the one-time legacy import.

**Architecture:** Every module is plain `node:*` TypeScript so Vitest runs it under Node; only `server/index.ts` touches `Bun.serve`. A `WorkspaceService` is the single write path shared by REST and MCP; every write emits on an in-process bus that feeds SSE, the mirror scheduler, and the watcher's echo suppression. Data is files on disk (section 3 of the spec); the only JSON records are `settings.json` (registry) and per-workspace `workspace.json` (framing metadata).

**Tech Stack:** Bun 1.3.11 (runtime, `bun build --compile`), TypeScript ^6.0.3, Vitest ^4.1, `@modelcontextprotocol/sdk` ^1.30.0 with `zod` ^4.5, `jimp` ^1.6.1 (pure-JS image baking), `fflate` ^0.8.3 (zip). Pure libraries ported from BTCT (`src/lib/*`) are shared with the browser.

**Spec:** `advanced-typst-editor/docs/superpowers/specs/2026-09-03-typst-studio-design.md` (read it first; this plan argues from it).

## Global Constraints

- Repo root is `C:\Users\rober\Desktop\university-tools`. The app lives in `advanced-typst-editor/`. All paths below are relative to `advanced-typst-editor/` unless they start with `C:\`.
- **Commit with explicit pathspecs only**: `git add advanced-typst-editor && git commit -m "..." -- advanced-typst-editor` (run from the repo root). The repo's index holds 45 staged `Chemistry Tool/*` entries whose files are gone from disk; a bare `git commit` or `git commit -a` would sweep them in or drop them. Never run `git reset`, `git restore --staged`, or `git checkout -- "Chemistry Tool"`.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015BwHHAqzcL1iAWQccDX1q9
  ```
- Source material is read-only: BTCT at `C:\Users\rober\Desktop\cptc-2026\BeenThereConqueredThat` (call it `$BTCT`), the recovered old server at `C:\Users\rober\Desktop\typst-editor\recovered-from-docker` (call it `$OLD`; `$OLD/server/*.ts`, `$OLD/src/*`, `$OLD/data` = the legacy documents and blobs, `$OLD/fonts` = the 17 default typst fonts). Copy from them; never modify them.
- Server modules import only `node:*`, npm packages, `./` siblings and `../src/lib/*` pure modules (`typst-placeholders`, `typst-geometry`, `crop-math`, `blur-math`, `image-format`) and `../src/types`. Never import anything that touches the DOM.
- No top-level `await` anywhere under `server/` (the compiled sidecar is built with `--bytecode`, which forces CommonJS output).
- Server binds `127.0.0.1` only. Port default 8090. Env vars exactly: `PORT`, `HOST`, `DATA_DIR`, `STATIC_DIR`, `TYPST_CLI`, `APP_TOKEN`.
- Relative paths inside a workspace are always forward-slash, never start with `/`, never contain `..`; `server/paths.ts` is the only place that validates them.
- The app never unlinks user content except an explicit asset/file delete from the UI or MCP. Workspace removal moves to `DATA_DIR/trash/<stamp>/`; mirror reconcile moves to `_trash/`.
- Tests: `bunx vitest run --project server` for server tests, `bunx vitest run --project ui` for ported library tests. Every server test uses a fresh temp dir from `fs.mkdtempSync(path.join(os.tmpdir(), 'tfs-'))` and removes it in `afterEach`.
- Type check: `bun run typecheck` (both tsconfigs) must pass before every commit.
- Windows: the typst CLI for tests is `C:\Users\rober\AppData\Local\Microsoft\WinGet\Packages\Typst.Typst_Microsoft.Winget.Source_8wekyb3d8bbwe\typst-x86_64-pc-windows-msvc\typst.exe` (0.14.2). Tests that need it read `process.env.TYPST_CLI` and fall back to that path; they `it.skip` only if neither exists.

## File structure

```
advanced-typst-editor/
  package.json  tsconfig.json  tsconfig.server.json  vite.config.ts  .gitignore
  src/types.ts                shared types (no DOM, no Node)
  src/template.ts             starter document
  src/lib/*.ts                pure libraries ported from BTCT (Task 2)
  src/test/*.test.ts          their tests (ui project, jsdom)
  server/config.ts            env -> Config
  server/fsx.ts               atomic write, readJson, dir helpers
  server/paths.ts             relative-path validation
  server/http.ts              HttpError, json(), readJsonObject()
  server/settings.ts          settings.json registry store
  server/assets.ts            filename/mime/crop/blur validation (from $OLD)
  server/workspace.ts         one workspace folder: files, meta, assets, folders, reference rewriting
  server/events.ts            event bus
  server/watcher.ts           fs.watch per workspace with echo suppression
  server/service.ts           WorkspaceService: the single write path
  server/static.ts            static hosting (from $OLD)
  server/fonts.ts             font family from the `name` table
  server/bake.ts              crop + blur with jimp
  server/compile.ts           typst CLI driver
  server/backup/mirror.ts     mirror plan + reconcile
  server/backup/snapshot.ts   zip snapshots, list, prune, restore
  server/backup/index.ts      destinations, scheduling, state
  server/fs-browse.ts         drive/dir listing
  server/mcp.ts               tools + Streamable HTTP transport + sessions
  server/mcp-stdio.ts         stdio bridge (from $OLD)
  server/router.ts            REST routes + SSE
  server/index.ts             wiring + Bun.serve
  server/cli.ts               import-legacy
  server/*.test.ts            server tests (server project, node)
  server/test-util.ts         tmp dir + fixtures helpers
```

---

### Task 1: Package scaffold, shared types, starter template

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.server.json`, `vite.config.ts`, `.gitignore`, `src/types.ts`, `src/template.ts`, `src/test/setup.ts`, `src/test/template.test.ts`, `vite-env.d.ts`

**Interfaces:**
- Produces: every type in `src/types.ts` (used by all later tasks), `DEFAULT_TEMPLATE`, `DEFAULT_WORKSPACE_NAME`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "typst-studio",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev:server": "bun --watch server/index.ts",
    "test": "vitest run",
    "test:server": "vitest run --project server",
    "test:ui": "vitest run --project ui",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.server.json --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "fflate": "^0.8.3",
    "jimp": "^1.6.1",
    "zod": "^4.5.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "jsdom": "^30.0.0",
    "typescript": "^6.0.3",
    "vite": "^8.2.0",
    "vitest": "^4.1.0"
  }
}
```

- [ ] **Step 2: Create the two tsconfigs and `vite-env.d.ts`**

`tsconfig.json` (browser side, same options as BTCT):

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "ignoreDeprecations": "6.0",
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "vite-env.d.ts"]
}
```

`tsconfig.server.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "types": ["node"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "skipLibCheck": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noUncheckedIndexedAccess": true,
    "ignoreDeprecations": "6.0"
  },
  "include": ["server/**/*.ts"]
}
```

`vite-env.d.ts`:

```ts
/// <reference types="vite/client" />
```

- [ ] **Step 3: Create `vite.config.ts` with the two Vitest projects**

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'ui',
          environment: 'jsdom',
          globals: true,
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          setupFiles: ['./src/test/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'server',
          environment: 'node',
          globals: true,
          include: ['server/**/*.test.ts'],
          testTimeout: 20000,
        },
      },
    ],
  },
});
```

`src/test/setup.ts` is an empty file for now (plan 2 adds jest-dom).

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
data/
*.tsbuildinfo
.vite/
```

- [ ] **Step 5: Create `src/types.ts`**

```ts
// Shared by the browser (src/) and the server (server/): no DOM, no Node.
export type ID = string;
export type TypstAssetKind = 'image' | 'font';

/** Normalised crop rect relative to the original image; may extend outside 0..1. */
export interface CropRect { x: number; y: number; w: number; h: number }
export type BlurStyle = 'gaussian' | 'pixelate';
/** Redaction region inside the unit square of the original image. */
export interface BlurRegion { x: number; y: number; w: number; h: number; style?: BlurStyle; strength?: number }

/** Per-image framing stored in workspace.json under the asset id. */
export interface AssetMeta {
  crop?: CropRect | null;
  blurs?: BlurRegion[] | null;
  width?: number | null;
  height?: number | null;
}
export interface FontMeta { family: string | null }
export interface WorkspaceJson {
  version: 1;
  /** keyed by asset id (workspace-relative path, e.g. "assets/findings/login.png") */
  assets: Record<string, AssetMeta>;
  /** keyed by asset id, e.g. "fonts/Inter-Regular.ttf" */
  fonts: Record<string, FontMeta>;
}

/**
 * One image or font in a workspace. `id` is the workspace-relative path
 * ("assets/findings/login.png", "fonts/Inter.ttf"); the Typst path is "/" + id.
 * `folderId` is the directory relative to assets/ ("findings", "findings/auth")
 * or null at the root. `etag` changes whenever the bytes change.
 */
export interface TypstAsset {
  id: ID;
  kind: TypstAssetKind;
  filename: string;
  mime: string;
  size: number;
  etag: string;
  width?: number | null;
  height?: number | null;
  crop?: CropRect | null;
  blurs?: BlurRegion[] | null;
  fontFamily?: string | null;
  folderId: ID | null;
  createdAt: number;
  updatedAt: number;
}

/** A subdirectory of assets/. `id` is its path relative to assets/. */
export interface AssetFolder { id: ID; name: string; parentId: ID | null; createdAt: number; updatedAt: number }

export interface WorkspaceEntry {
  id: ID;
  path: string;
  name: string;
  group: string | null;
  library: boolean;
  createdAt: number;
  openedAt: number;
}
export interface WorkspaceStatus extends WorkspaceEntry { status: 'ok' | 'missing' }
export interface FileEntry { path: string; size: number; mtime: number }
export interface WorkspaceDetail {
  entry: WorkspaceEntry;
  files: FileEntry[];
  meta: WorkspaceJson;
  assets: TypstAsset[];
  folders: AssetFolder[];
}

export interface BackupDestination { id: ID; path: string; mirror: boolean; snapshots: boolean }
export interface BackupSettings { destinations: BackupDestination[]; snapshotIntervalMin: number; keepSnapshots: number }
export interface BackupState extends BackupSettings {
  running: boolean;
  lastRunAt: number | null;
  lastMirrorFiles: number | null;
  lastSnapshotAt: number | null;
  lastError: string | null;
}
export interface SnapshotInfo { destinationId: ID; name: string; createdAt: number; bytes: number; workspaces: number }

export interface RedactionDefaults { style: BlurStyle; strength: number }
export interface Settings {
  version: 1;
  workspaces: WorkspaceEntry[];
  backup: BackupSettings;
  typstCli: string | null;
  redaction: RedactionDefaults;
}

export interface DirEntry { name: string; path: string; isEmpty: boolean; isBackupRoot: boolean }
export interface DirListing { path: string; parent: string | null; entries: DirEntry[] }

export interface McpClientStatus { name: string; version: string | null; connected: boolean; lastSeenAt: number; sessions: number }
export interface McpStatus { endpoint: string; authRequired: boolean; clients: McpClientStatus[] }

export interface Diagnostic { severity: 'error' | 'warning'; message: string; file: string | null; line: number | null; col: number | null }
export interface CompileResult { ok: boolean; diagnostics: Diagnostic[] }

export type ServerEvent =
  | { type: 'workspace.changed'; id: ID; paths: string[]; origin: string | null }
  | { type: 'workspaces.changed' }
  | { type: 'backup.state'; state: BackupState }
  | { type: 'mcp.clients'; clients: McpClientStatus[] };
```

- [ ] **Step 6: Create `src/template.ts`**

Copy `$OLD/src/template.ts` verbatim, then make exactly these edits: rename `DEFAULT_DOCUMENT_NAME` to `DEFAULT_WORKSPACE_NAME` with value `'Untitled report'`; replace the line `#text(size: 11pt)[Typst Figure Studio]` with `#text(size: 11pt)[Typst Studio]`. Keep the `#let image-placeholder(...)` block byte-for-byte (the placeholder parser in `src/lib/typst-placeholders.ts` recognises it).

- [ ] **Step 7: Write the failing test `src/test/template.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_TEMPLATE, DEFAULT_WORKSPACE_NAME } from '@/template';

describe('starter template', () => {
  it('defines the figure helper and two slots', () => {
    expect(DEFAULT_WORKSPACE_NAME).toBe('Untitled report');
    expect(DEFAULT_TEMPLATE).toContain('#let image-placeholder(caption, path: none, height: 2.2in)');
    expect(DEFAULT_TEMPLATE.match(/#image-placeholder\(/g)?.length).toBe(2);
    expect(DEFAULT_TEMPLATE).toContain('Typst Studio');
  });
});
```

- [ ] **Step 8: Install and run**

Run: `cd advanced-typst-editor && bun install && bunx vitest run --project ui`
Expected: 1 test passes. Then `bun run typecheck` passes.

- [ ] **Step 9: Commit**

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(typst-studio): package scaffold, shared types, starter template" -- advanced-typst-editor
```

---

### Task 2: Port the pure libraries and their tests from BTCT

**Files:**
- Create (copy from `$BTCT/src/lib/`): `src/lib/typst-placeholders.ts`, `typst-geometry.ts`, `typst-search.ts`, `typst-source-map.ts`, `typst-pages.ts`, `crop-math.ts`, `blur-math.ts`, `image-format.ts`, `asset-folders.ts`, `pane-resize.ts`
- Create (copy from `$BTCT/src/test/`): the matching `*.test.ts` for each of the ten

**Interfaces:**
- Produces (used by the server): `findScreenshotSlots(source)`, `setSlotPath(source, slot, path|null)`, `setSlotHeight(source, slot, heightPt|null)`, `ensureHelper(source) -> {source, changed}`, `newSlotSnippet(caption)`, `retargetAssetPath(source, oldPath, newPath)`, `countAssetReferences(source, path)`, `PLACEHOLDER_HELPER`, `ScreenshotSlot` (all in `typst-placeholders`); `parseLength(text) -> pt|null` (`typst-geometry`); `normalizeCrop`, `cropToPixels`, `outputSize`, `isFullFrame` (`crop-math`); `blurParams`, `pixelParams`, `effectiveStyle`, `hasBlurs` (`blur-math`); `sniffImageFormat`, `extensionForFormat`, `formatFromFilename`, `ENCODABLE_FORMATS` (`image-format`).

- [ ] **Step 1: Copy the twenty files**

```bash
cd advanced-typst-editor
for f in typst-placeholders typst-geometry typst-search typst-source-map typst-pages crop-math blur-math image-format asset-folders pane-resize; do
  cp "$BTCT/src/lib/$f.ts" src/lib/$f.ts
  cp "$BTCT/src/test/$f.test.ts" src/test/$f.test.ts
done
```

- [ ] **Step 2: Remove the BTCT-only field from fixtures**

The new `AssetFolder`/`TypstAsset` types have no `workspaceId`. In `src/test/asset-folders.test.ts` and any other copied test, delete every `workspaceId: 'ws',` (or similar) property from object literals. Grep to confirm: `grep -rn workspaceId src/` prints nothing.

- [ ] **Step 3: Run the ported tests**

Run: `bunx vitest run --project ui`
Expected: all ten suites pass unchanged (they are pure; `pane-resize` uses jsdom's `localStorage`, `typst-pages` uses jsdom's `DOMParser`). If a suite fails only on a type import that no longer exists, fix the import to `@/types`; do not change assertions.

- [ ] **Step 4: Typecheck and commit**

Run: `bun run typecheck` (must pass).

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(typst-studio): port pure Typst libraries and tests from BTCT" -- advanced-typst-editor
```

---

### Task 3: config, fs helpers, paths, http helpers, settings registry

**Files:**
- Create: `server/config.ts`, `server/fsx.ts`, `server/paths.ts`, `server/http.ts`, `server/settings.ts`, `server/test-util.ts`, `server/paths.test.ts`, `server/settings.test.ts`

**Interfaces:**
- Produces: `loadConfig(env) -> Config`; `writeAtomic(file, data)`, `readJson<T>(file, fallback)`, `isDir(p)`, `isFile(p)`, `ensureDir(p)`, `safeDirName(name)`, `uniqueDirName(parent, base)`; `normalizeRel(rel) -> string|null`, `resolveInside(root, rel) -> string|null`; `HttpError`, `json(status, body, headers?)`, `readJsonObject(req)`; `createSettingsStore(dataDir, {now?}) -> SettingsStore`; `tmpDir()`.

- [ ] **Step 1: Write `server/config.ts`**

```ts
import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  workspacesDir: string;
  staticDir: string | null;
  typstCli: string | null;
  token: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.DATA_DIR ?? './data');
  return {
    port: Number(env.PORT ?? 8090),
    host: env.HOST ?? '127.0.0.1',
    dataDir,
    workspacesDir: path.join(dataDir, 'workspaces'),
    staticDir: env.STATIC_DIR ? path.resolve(env.STATIC_DIR) : null,
    typstCli: env.TYPST_CLI ? path.resolve(env.TYPST_CLI) : null,
    token: env.APP_TOKEN || null,
  };
}
```

- [ ] **Step 2: Write `server/fsx.ts`**

```ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Write-then-rename so readers only ever see a complete file. */
export function writeAtomic(file: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

export function readJson<T>(file: string, fallback: T): T {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return fallback; }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback;
  } catch { return fallback; }
}

export function isDir(p: string): boolean { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
export function isFile(p: string): boolean { try { return fs.statSync(p).isFile(); } catch { return false; } }
export function ensureDir(p: string): void { fs.mkdirSync(p, { recursive: true }); }

/** A workspace/group name as a folder name safe on every filesystem. */
export function safeDirName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().replace(/\.+$/, '').slice(0, 80);
  return safe || 'report';
}

/** `base`, or `base (2)`, `base (3)`, ... whichever does not yet exist under `parent`. */
export function uniqueDirName(parent: string, base: string): string {
  let candidate = base;
  for (let n = 2; fs.existsSync(path.join(parent, candidate)); n++) candidate = `${base} (${n})`;
  return candidate;
}

/** Timestamp usable in a folder name: 2026-09-03T01-02-03-456Z */
export function stamp(now: number = Date.now()): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}
```

- [ ] **Step 3: Write `server/paths.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';

/**
 * Normalise a client-supplied workspace-relative path to forward slashes.
 * Returns null for anything that could escape: absolute paths, drive
 * letters, `..`, NUL. The empty string (the root) normalises to ''.
 */
export function normalizeRel(rel: unknown): string | null {
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  if (/^[\\/]/.test(rel) || /^[a-zA-Z]:/.test(rel)) return null;
  const segs = rel.replace(/\\/g, '/').split('/').filter((s) => s.length > 0 && s !== '.');
  if (segs.some((s) => s === '..')) return null;
  return segs.join('/');
}

/** Absolute path of `rel` under `root`, or null when it escapes (symlinks included, when it exists). */
export function resolveInside(root: string, rel: unknown): string | null {
  const n = normalizeRel(rel);
  if (n === null) return null;
  const rootAbs = path.resolve(root);
  const target = n === '' ? rootAbs : path.resolve(rootAbs, ...n.split('/'));
  const inside = (p: string) => p === rootAbs || p.startsWith(rootAbs + path.sep);
  if (!inside(target)) return null;
  try {
    const real = fs.realpathSync(target);
    const realRoot = fs.realpathSync(rootAbs);
    if (!(real === realRoot || real.startsWith(realRoot + path.sep))) return null;
  } catch { /* does not exist yet */ }
  return target;
}

export function isAbsoluteWindowsOrPosix(p: string): boolean {
  return path.isAbsolute(p) && !p.includes('\0');
}
```

- [ ] **Step 4: Write `server/http.ts`**

```ts
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new HttpError(400, 'invalid JSON body'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'body must be a JSON object');
  return parsed as Record<string, unknown>;
}

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  if (!(key in body)) return undefined;
  const v = body[key];
  if (typeof v !== 'string') throw new HttpError(400, `${key} must be a string`);
  return v;
}

export function requireString(body: Record<string, unknown>, key: string): string {
  const v = optionalString(body, key);
  if (v === undefined) throw new HttpError(400, `${key} is required`);
  return v;
}
```

- [ ] **Step 5: Write `server/test-util.ts`**

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tfs-'));
}
export function rmDir(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}
/** Write a file, creating parents. */
export function put(root: string, rel: string, data: string | Uint8Array): string {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  return abs;
}
export const OLD = 'C:/Users/rober/Desktop/typst-editor/recovered-from-docker';
export const TYPST_CLI =
  process.env.TYPST_CLI ??
  'C:/Users/rober/AppData/Local/Microsoft/WinGet/Packages/Typst.Typst_Microsoft.Winget.Source_8wekyb3d8bbwe/typst-x86_64-pc-windows-msvc/typst.exe';
```

- [ ] **Step 6: Write the failing tests `server/paths.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { normalizeRel, resolveInside } from './paths';

describe('normalizeRel', () => {
  it('normalises slashes and dots', () => {
    expect(normalizeRel('assets\\a\\./b.png')).toBe('assets/a/b.png');
    expect(normalizeRel('')).toBe('');
    expect(normalizeRel('/x')).toBeNull();
    expect(normalizeRel('C:\\x')).toBeNull();
    expect(normalizeRel('a/../b')).toBeNull();
    expect(normalizeRel('a\0b')).toBeNull();
    expect(normalizeRel(42)).toBeNull();
  });
});

describe('resolveInside', () => {
  it('stays under the root', () => {
    const root = path.resolve('C:/tmp/ws');
    expect(resolveInside(root, 'main.typ')).toBe(path.join(root, 'main.typ'));
    expect(resolveInside(root, '')).toBe(root);
    expect(resolveInside(root, '../x')).toBeNull();
  });
});
```

- [ ] **Step 7: Write `server/settings.ts`**

```ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Settings, WorkspaceEntry } from '../src/types';
import { isDir, readJson, writeAtomic } from './fsx';

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  workspaces: [],
  backup: { destinations: [], snapshotIntervalMin: 60, keepSnapshots: 30 },
  typstCli: null,
  redaction: { style: 'gaussian', strength: 1 },
};

export interface SettingsStore {
  get(): Settings;
  update(fn: (s: Settings) => Settings): Settings;
  listWorkspaces(): WorkspaceEntry[];
  getWorkspace(id: string): WorkspaceEntry | null;
  findByPath(p: string): WorkspaceEntry | null;
  addWorkspace(input: { path: string; name: string; group: string | null; library: boolean }): WorkspaceEntry;
  patchWorkspace(id: string, patch: Partial<Pick<WorkspaceEntry, 'name' | 'group' | 'path' | 'openedAt'>>): WorkspaceEntry | null;
  removeWorkspace(id: string): boolean;
  /** Register every folder under workspacesDir that is not yet known. Returns the new entries. */
  scanLibrary(workspacesDir: string): WorkspaceEntry[];
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function normalise(raw: Partial<Settings>): Settings {
  const b = raw.backup ?? DEFAULT_SETTINGS.backup;
  return {
    version: 1,
    workspaces: Array.isArray(raw.workspaces)
      ? raw.workspaces.filter((w): w is WorkspaceEntry => !!w && typeof w.id === 'string' && typeof w.path === 'string')
      : [],
    backup: {
      destinations: Array.isArray(b.destinations) ? b.destinations.filter((d) => d && typeof d.path === 'string' && typeof d.id === 'string') : [],
      snapshotIntervalMin: Number.isFinite(b.snapshotIntervalMin) && b.snapshotIntervalMin >= 1 ? Math.round(b.snapshotIntervalMin) : 60,
      keepSnapshots: Number.isFinite(b.keepSnapshots) && b.keepSnapshots >= 1 ? Math.round(b.keepSnapshots) : 30,
    },
    typstCli: typeof raw.typstCli === 'string' && raw.typstCli ? raw.typstCli : null,
    redaction: {
      style: raw.redaction?.style === 'pixelate' ? 'pixelate' : 'gaussian',
      strength: Number.isFinite(raw.redaction?.strength) ? Math.min(3, Math.max(0.25, raw.redaction!.strength)) : 1,
    },
  };
}

export function createSettingsStore(dataDir: string, opts: { now?: () => number } = {}): SettingsStore {
  const now = opts.now ?? (() => Date.now());
  const file = path.join(dataDir, 'settings.json');
  fs.mkdirSync(dataDir, { recursive: true });

  const get = (): Settings => normalise(readJson<Partial<Settings>>(file, {}));
  const write = (s: Settings): Settings => { writeAtomic(file, JSON.stringify(s, null, 2)); return s; };
  const update = (fn: (s: Settings) => Settings): Settings => write(fn(get()));

  const store: SettingsStore = {
    get,
    update,
    listWorkspaces: () => get().workspaces,
    getWorkspace: (id) => get().workspaces.find((w) => w.id === id) ?? null,
    findByPath: (p) => get().workspaces.find((w) => samePath(w.path, p)) ?? null,
    addWorkspace(input) {
      const t = now();
      const entry: WorkspaceEntry = { id: crypto.randomUUID(), path: path.resolve(input.path), name: input.name, group: input.group, library: input.library, createdAt: t, openedAt: t };
      update((s) => ({ ...s, workspaces: [...s.workspaces, entry] }));
      return entry;
    },
    patchWorkspace(id, patch) {
      let out: WorkspaceEntry | null = null;
      update((s) => ({
        ...s,
        workspaces: s.workspaces.map((w) => {
          if (w.id !== id) return w;
          out = { ...w, ...patch };
          return out;
        }),
      }));
      return out;
    },
    removeWorkspace(id) {
      let removed = false;
      update((s) => ({ ...s, workspaces: s.workspaces.filter((w) => { if (w.id === id) { removed = true; return false; } return true; }) }));
      return removed;
    },
    scanLibrary(workspacesDir) {
      if (!isDir(workspacesDir)) return [];
      const known = get().workspaces;
      const added: WorkspaceEntry[] = [];
      for (const entry of fs.readdirSync(workspacesDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('restored-')) continue;
        const abs = path.join(workspacesDir, entry.name);
        if (known.some((w) => samePath(w.path, abs))) continue;
        added.push(store.addWorkspace({ path: abs, name: entry.name, group: null, library: true }));
      }
      return added;
    },
  };
  return store;
}
```

Note: `restored-<stamp>` folders (from a snapshot restore) hold sub-workspaces and are registered explicitly by the restore code (Task 11), so the scan skips them.

- [ ] **Step 8: Write the failing tests `server/settings.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createSettingsStore, DEFAULT_SETTINGS } from './settings';
import { tmpDir, rmDir } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

describe('settings store', () => {
  it('returns defaults when the file is missing or corrupt', () => {
    const d = tmpDir(); dirs.push(d);
    const s = createSettingsStore(d);
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    fs.writeFileSync(path.join(d, 'settings.json'), '{not json');
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('registers, patches and removes workspaces', () => {
    const d = tmpDir(); dirs.push(d);
    const s = createSettingsStore(d, { now: () => 5 });
    const w = s.addWorkspace({ path: path.join(d, 'ws', 'A'), name: 'A', group: null, library: true });
    expect(w.createdAt).toBe(5);
    expect(s.getWorkspace(w.id)?.name).toBe('A');
    expect(s.findByPath(path.join(d, 'WS', 'a'))?.id).toBe(w.id); // case-insensitive on Windows
    expect(s.patchWorkspace(w.id, { name: 'B', group: 'G' })).toMatchObject({ name: 'B', group: 'G' });
    expect(s.removeWorkspace(w.id)).toBe(true);
    expect(s.listWorkspaces()).toEqual([]);
  });

  it('scans the library for unknown folders', () => {
    const d = tmpDir(); dirs.push(d);
    const lib = path.join(d, 'workspaces');
    fs.mkdirSync(path.join(lib, 'Report One'), { recursive: true });
    fs.mkdirSync(path.join(lib, '.hidden'), { recursive: true });
    fs.mkdirSync(path.join(lib, 'restored-2026'), { recursive: true });
    const s = createSettingsStore(d);
    const added = s.scanLibrary(lib);
    expect(added.map((w) => w.name)).toEqual(['Report One']);
    expect(added[0]?.library).toBe(true);
    expect(s.scanLibrary(lib)).toEqual([]);
  });

  it('clamps backup and redaction settings', () => {
    const d = tmpDir(); dirs.push(d);
    const s = createSettingsStore(d);
    const out = s.update((cur) => ({ ...cur, backup: { ...cur.backup, keepSnapshots: 0, snapshotIntervalMin: 0.2 }, redaction: { style: 'pixelate', strength: 99 } }));
    expect(out.backup.keepSnapshots).toBe(30);
    expect(out.backup.snapshotIntervalMin).toBe(60);
    expect(out.redaction).toEqual({ style: 'pixelate', strength: 3 });
  });
});
```

- [ ] **Step 9: Run, typecheck, commit**

Run: `bunx vitest run --project server` → all pass. `bun run typecheck` passes.

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(server): config, path safety, settings registry" -- advanced-typst-editor
```

---

### Task 4: Workspace folder: file tree, read/write, workspace.json, asset listing

**Files:**
- Create: `server/assets.ts`, `server/workspace.ts`, `server/workspace.test.ts`

**Interfaces:**
- Consumes: `normalizeRel`, `resolveInside` (Task 3); `sniffImageFormat`, `extensionForFormat` (Task 2).
- Produces: `openWorkspace(root, {now?}) -> WorkspaceFs` with `listFiles()`, `readFile(rel)`, `writeFile(rel, bytes)`, `deleteFile(rel)`, `readMeta()`, `writeMeta(meta)`, `listAssets()`, `listFolders()`, `typFiles()`; `server/assets.ts` exports copied from `$OLD` (`MAX_ASSET_BYTES`, `ALLOWED_EXTENSIONS`, `extensionOf`, `sanitizeStem`, `sanitizeFilename`, `mimeFor`, `reconcileImageName`, `uniqueFilename`, `validateCrop`, `validateBlurs`). Asset mutation methods are added in Task 5.

- [ ] **Step 1: Copy `server/assets.ts` from `$OLD/server/assets.ts`**

Change only its imports to:

```ts
import type { BlurRegion, BlurStyle, CropRect, TypstAssetKind } from '../src/types';
import { extensionForFormat, sniffImageFormat } from '../src/lib/image-format';
```

and keep every exported function as-is (they are documented in the file).

- [ ] **Step 2: Write the failing tests `server/workspace.test.ts` (listing, files, meta)**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openWorkspace } from './workspace';
import { tmpDir, rmDir, put } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function fixture(): string {
  const d = tmpDir(); dirs.push(d);
  put(d, 'main.typ', '= Hi\n#image("/assets/findings/login.png")\n');
  put(d, 'chapters/intro.typ', 'intro');
  put(d, 'refs.bib', '');
  put(d, 'assets/findings/login.png', PNG_1x1);
  put(d, 'assets/cover.png', PNG_1x1);
  put(d, 'fonts/Poppins-Regular.ttf', Buffer.alloc(4));
  put(d, '.git/HEAD', 'ref');
  put(d, 'node_modules/x/index.js', '');
  put(d, 'workspace.json', JSON.stringify({ version: 1, assets: { 'assets/cover.png': { crop: { x: 0, y: 0, w: 1, h: 0.5 } } }, fonts: { 'fonts/Poppins-Regular.ttf': { family: 'Poppins' } } }));
  return d;
}

describe('workspace files', () => {
  it('lists every file except hidden, node_modules and workspace.json', () => {
    const ws = openWorkspace(fixture());
    const paths = ws.listFiles().map((f) => f.path).sort();
    expect(paths).toEqual(['assets/cover.png', 'assets/findings/login.png', 'chapters/intro.typ', 'fonts/Poppins-Regular.ttf', 'main.typ', 'refs.bib']);
    expect(ws.typFiles()).toEqual(['chapters/intro.typ', 'main.typ']);
  });

  it('reads with an etag and writes atomically', () => {
    const ws = openWorkspace(fixture());
    const r = ws.readFile('main.typ')!;
    expect(Buffer.from(r.bytes).toString()).toContain('= Hi');
    expect(r.etag).toMatch(/^\d+-\d+$/);
    const e = ws.writeFile('main.typ', Buffer.from('= Changed'));
    expect(e.path).toBe('main.typ');
    expect(Buffer.from(ws.readFile('main.typ')!.bytes).toString()).toBe('= Changed');
    expect(ws.readFile('nope.typ')).toBeNull();
    expect(ws.readFile('../x')).toBeNull();
    expect(() => ws.writeFile('../x', Buffer.alloc(1))).toThrow();
    expect(() => ws.writeFile('workspace.json', Buffer.alloc(1))).toThrow();
    expect(ws.deleteFile('refs.bib')).toBe(true);
    expect(ws.deleteFile('refs.bib')).toBe(false);
  });

  it('reads and writes workspace.json, tolerating a missing file', () => {
    const d = tmpDir(); dirs.push(d);
    const ws = openWorkspace(d);
    expect(ws.readMeta()).toEqual({ version: 1, assets: {}, fonts: {} });
    ws.writeMeta({ version: 1, assets: { 'assets/a.png': { blurs: [{ x: 0, y: 0, w: 1, h: 1 }] } }, fonts: {} });
    expect(JSON.parse(fs.readFileSync(path.join(d, 'workspace.json'), 'utf8')).assets['assets/a.png'].blurs).toHaveLength(1);
  });

  it('lists assets with folders and framing from workspace.json', () => {
    const ws = openWorkspace(fixture());
    const assets = ws.listAssets();
    const ids = assets.map((a) => a.id).sort();
    expect(ids).toEqual(['assets/cover.png', 'assets/findings/login.png', 'fonts/Poppins-Regular.ttf']);
    const login = assets.find((a) => a.id === 'assets/findings/login.png')!;
    expect(login).toMatchObject({ kind: 'image', filename: 'login.png', mime: 'image/png', folderId: 'findings', size: PNG_1x1.length });
    const cover = assets.find((a) => a.id === 'assets/cover.png')!;
    expect(cover.folderId).toBeNull();
    expect(cover.crop).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    const font = assets.find((a) => a.kind === 'font')!;
    expect(font).toMatchObject({ fontFamily: 'Poppins', filename: 'Poppins-Regular.ttf', folderId: null });
    expect(ws.listFolders()).toEqual([{ id: 'findings', name: 'findings', parentId: null, createdAt: expect.any(Number), updatedAt: expect.any(Number) }]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bunx vitest run --project server server/workspace.test.ts`
Expected: FAIL, `./workspace` not found.

- [ ] **Step 4: Write `server/workspace.ts` (part 1)**

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { AssetFolder, FileEntry, TypstAsset, WorkspaceJson } from '../src/types';
import { ALLOWED_EXTENSIONS, extensionOf, mimeFor } from './assets';
import { readJson, writeAtomic } from './fsx';
import { HttpError } from './http';
import { normalizeRel, resolveInside } from './paths';

export const META_FILE = 'workspace.json';
export const ASSETS_DIR = 'assets';
export const FONTS_DIR = 'fonts';
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', '__pycache__']);

export const EMPTY_META: WorkspaceJson = { version: 1, assets: {}, fonts: {} };

export function etagOf(st: fs.Stats): string {
  return `${Math.round(st.mtimeMs)}-${st.size}`;
}

export interface WorkspaceFs {
  readonly root: string;
  listFiles(): FileEntry[];
  typFiles(): string[];
  readFile(rel: string): { bytes: Uint8Array; etag: string } | null;
  /** Throws HttpError(400) on a bad path; never writes workspace.json (use writeMeta). */
  writeFile(rel: string, bytes: Uint8Array): FileEntry;
  deleteFile(rel: string): boolean;
  readMeta(): WorkspaceJson;
  writeMeta(meta: WorkspaceJson): void;
  listAssets(): TypstAsset[];
  listFolders(): AssetFolder[];
  /** Absolute path for a validated relative path, or throws HttpError(400). */
  abs(rel: string): string;
  // Task 5 adds the mutation methods below this line.
}

function walk(root: string, rel: string, out: FileEntry[]): void {
  const dir = rel ? path.join(root, ...rel.split('/')) : root;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    if (e.name.endsWith('.tmp')) continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, child, out);
    else if (e.isFile()) {
      if (child === META_FILE) continue;
      try {
        const st = fs.statSync(path.join(dir, e.name));
        out.push({ path: child, size: st.size, mtime: Math.round(st.mtimeMs) });
      } catch { /* vanished mid-walk */ }
    }
  }
}

function normaliseMeta(raw: Partial<WorkspaceJson>): WorkspaceJson {
  return {
    version: 1,
    assets: raw.assets && typeof raw.assets === 'object' ? raw.assets : {},
    fonts: raw.fonts && typeof raw.fonts === 'object' ? raw.fonts : {},
  };
}

export function openWorkspace(root: string, opts: { now?: () => number } = {}): WorkspaceFs {
  const now = opts.now ?? (() => Date.now());
  const rootAbs = path.resolve(root);

  const abs = (rel: string): string => {
    const n = normalizeRel(rel);
    if (n === null || n === '') throw new HttpError(400, `invalid path: ${rel}`);
    const a = resolveInside(rootAbs, n);
    if (!a) throw new HttpError(400, `path escapes the workspace: ${rel}`);
    return a;
  };

  const readMeta = (): WorkspaceJson => normaliseMeta(readJson<Partial<WorkspaceJson>>(path.join(rootAbs, META_FILE), {}));

  const listFiles = (): FileEntry[] => { const out: FileEntry[] = []; walk(rootAbs, '', out); return out; };

  const listAssets = (): TypstAsset[] => {
    const meta = readMeta();
    const out: TypstAsset[] = [];
    for (const f of listFiles()) {
      const top = f.path.split('/')[0];
      const kind = top === ASSETS_DIR ? 'image' : top === FONTS_DIR ? 'font' : null;
      if (!kind) continue;
      const ext = extensionOf(f.path);
      if (!ALLOWED_EXTENSIONS[kind].includes(ext)) continue;
      const filename = path.posix.basename(f.path);
      const dirRel = path.posix.dirname(f.path);
      const folderId = kind === 'image' && dirRel !== ASSETS_DIR ? dirRel.slice(ASSETS_DIR.length + 1) : null;
      let createdAt = f.mtime;
      try { createdAt = Math.round(fs.statSync(path.join(rootAbs, ...f.path.split('/'))).birthtimeMs) || f.mtime; } catch { /* keep mtime */ }
      const m = kind === 'image' ? meta.assets[f.path] : undefined;
      const fm = kind === 'font' ? meta.fonts[f.path] : undefined;
      out.push({
        id: f.path,
        kind,
        filename,
        mime: mimeFor(kind, filename) ?? 'application/octet-stream',
        size: f.size,
        etag: `${f.mtime}-${f.size}`,
        width: m?.width ?? null,
        height: m?.height ?? null,
        crop: m?.crop ?? null,
        blurs: m?.blurs ?? null,
        fontFamily: fm?.family ?? null,
        folderId,
        createdAt,
        updatedAt: f.mtime,
      });
    }
    return out;
  };

  const listFolders = (): AssetFolder[] => {
    const out: AssetFolder[] = [];
    const base = path.join(rootAbs, ASSETS_DIR);
    const visit = (rel: string) => {
      const dir = rel ? path.join(base, ...rel.split('/')) : base;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const id = rel ? `${rel}/${e.name}` : e.name;
        let t = now();
        try { t = Math.round(fs.statSync(path.join(dir, e.name)).mtimeMs); } catch { /* keep now */ }
        out.push({ id, name: e.name, parentId: rel || null, createdAt: t, updatedAt: t });
        visit(id);
      }
    };
    visit('');
    return out;
  };

  return {
    root: rootAbs,
    abs,
    listFiles,
    typFiles: () => listFiles().map((f) => f.path).filter((p) => p.endsWith('.typ')).sort(),
    readFile(rel) {
      const n = normalizeRel(rel);
      if (n === null || n === '') return null;
      const a = resolveInside(rootAbs, n);
      if (!a) return null;
      try {
        const st = fs.statSync(a);
        if (!st.isFile()) return null;
        return { bytes: new Uint8Array(fs.readFileSync(a)), etag: etagOf(st) };
      } catch { return null; }
    },
    writeFile(rel, bytes) {
      const n = normalizeRel(rel);
      if (n === META_FILE) throw new HttpError(400, 'workspace.json is managed by the app');
      const a = abs(rel);
      writeAtomic(a, bytes);
      const st = fs.statSync(a);
      return { path: n as string, size: st.size, mtime: Math.round(st.mtimeMs) };
    },
    deleteFile(rel) {
      const a = abs(rel);
      try { fs.unlinkSync(a); return true; } catch { return false; }
    },
    readMeta,
    writeMeta(meta) { writeAtomic(path.join(rootAbs, META_FILE), JSON.stringify(normaliseMeta(meta), null, 2)); },
    listAssets,
    listFolders,
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `bunx vitest run --project server server/workspace.test.ts`
Expected: 4 tests pass. `bun run typecheck` passes.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(server): workspace folder reads, writes, meta and asset listing" -- advanced-typst-editor
```

---

### Task 5: Asset mutations with reference rewriting

**Files:**
- Modify: `server/workspace.ts` (add methods to `WorkspaceFs`), `server/workspace.test.ts`

**Interfaces:**
- Consumes: `retargetAssetPath`, `countAssetReferences` (Task 2); `sanitizeFilename`, `sanitizeStem`, `reconcileImageName`, `uniqueFilename`, `mimeFor`, `validateCrop`, `validateBlurs`, `MAX_ASSET_BYTES` (Task 4).
- Produces on `WorkspaceFs`: `addAsset(input) -> TypstAsset`, `patchAsset(id, patch) -> TypstAsset`, `renameAsset(id, stem) -> {asset, references}`, `moveAsset(id, folder) -> {asset, references}`, `deleteAsset(id) -> void`, `createFolder(rel) -> AssetFolder`, `renameFolder(rel, newRel) -> {references}`, `deleteFolder(rel) -> {references, moved}`, `rewriteReferences(oldTypstPath, newTypstPath) -> number`, `getAsset(id) -> TypstAsset` (throws 404).

- [ ] **Step 1: Add the failing tests to `server/workspace.test.ts`**

```ts
describe('workspace assets', () => {
  it('uploads with sanitised, extension-corrected, de-duplicated names', () => {
    const ws = openWorkspace(fixture());
    const a = ws.addAsset({ kind: 'image', filename: '../we ird?.jpg', bytes: PNG_1x1, folder: null });
    expect(a.id).toBe('assets/we_ird_.png'); // PNG bytes => .png, spaces/? => _
    const b = ws.addAsset({ kind: 'image', filename: 'we_ird_.png', bytes: PNG_1x1, folder: null });
    expect(b.id).toBe('assets/we_ird_-2.png');
    const c = ws.addAsset({ kind: 'image', filename: 'shot.png', bytes: PNG_1x1, folder: 'new/deep' });
    expect(c.id).toBe('assets/new/deep/shot.png');
    expect(c.folderId).toBe('new/deep');
    const f = ws.addAsset({ kind: 'font', filename: 'X.ttf', bytes: Buffer.alloc(8), folder: null, family: 'X Sans' });
    expect(f.id).toBe('fonts/X.ttf');
    expect(ws.readMeta().fonts['fonts/X.ttf']).toEqual({ family: 'X Sans' });
    expect(() => ws.addAsset({ kind: 'image', filename: 'x.exe', bytes: PNG_1x1, folder: null })).toThrow(/not allowed/);
    expect(() => ws.addAsset({ kind: 'image', filename: 'x.png', bytes: PNG_1x1, folder: '../out' })).toThrow();
  });

  it('patches framing and validates it', () => {
    const ws = openWorkspace(fixture());
    const a = ws.patchAsset('assets/findings/login.png', { crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, blurs: [{ x: 0, y: 0, w: 0.2, h: 0.2, style: 'pixelate' }], width: 1920, height: 1080 });
    expect(a.crop).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    expect(a.blurs?.[0]?.style).toBe('pixelate');
    expect(ws.readMeta().assets['assets/findings/login.png']).toMatchObject({ width: 1920, height: 1080 });
    expect(() => ws.patchAsset('assets/findings/login.png', { crop: { x: 0, y: 0, w: 0, h: 1 } })).toThrow(/crop/);
    expect(() => ws.patchAsset('assets/findings/login.png', { blurs: [{ x: 0.9, y: 0, w: 0.5, h: 0.5 }] })).toThrow(/blur/);
    expect(ws.patchAsset('assets/findings/login.png', { crop: null }).crop).toBeNull();
    expect(() => ws.patchAsset('assets/nope.png', { crop: null })).toThrow(/not found/);
  });

  it('renames an asset, keeps the extension, and rewrites every .typ reference', () => {
    const d = fixture();
    put(d, 'chapters/intro.typ', '#image("/assets/findings/login.png", width: 50%)\n#image-placeholder("x", path: "/assets/findings/login.png")');
    const ws = openWorkspace(d);
    const { asset, references } = ws.renameAsset('assets/findings/login.png', 'Login Bypass.jpg');
    expect(asset.id).toBe('assets/findings/Login_Bypass.png');
    expect(references).toBe(3);
    expect(fs.readFileSync(path.join(d, 'main.typ'), 'utf8')).toContain('"/assets/findings/Login_Bypass.png"');
    expect(fs.readFileSync(path.join(d, 'chapters/intro.typ'), 'utf8')).not.toContain('login.png');
    expect(fs.existsSync(path.join(d, 'assets/findings/login.png'))).toBe(false);
  });

  it('moves an asset between folders and keeps its framing', () => {
    const d = fixture();
    const ws = openWorkspace(d);
    ws.patchAsset('assets/cover.png', { crop: { x: 0, y: 0, w: 1, h: 0.5 } });
    const { asset, references } = ws.moveAsset('assets/cover.png', 'findings');
    expect(asset.id).toBe('assets/findings/cover.png');
    expect(asset.crop).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(references).toBe(0);
    expect(ws.readMeta().assets['assets/cover.png']).toBeUndefined();
    expect(ws.moveAsset('assets/findings/cover.png', null).asset.id).toBe('assets/cover.png');
  });

  it('creates, renames and deletes folders; deleting moves contents up a level', () => {
    const d = fixture();
    const ws = openWorkspace(d);
    expect(ws.createFolder('findings/auth')).toMatchObject({ id: 'findings/auth', name: 'auth', parentId: 'findings' });
    ws.addAsset({ kind: 'image', filename: 'token.png', bytes: PNG_1x1, folder: 'findings/auth' });
    put(d, 'main.typ', '#image("/assets/findings/auth/token.png")\n#image("/assets/findings/login.png")');
    expect(ws.renameFolder('findings', 'Findings 2026').references).toBe(2);
    expect(fs.readFileSync(path.join(d, 'main.typ'), 'utf8')).toContain('"/assets/Findings 2026/auth/token.png"');
    const r = ws.deleteFolder('Findings 2026/auth');
    expect(r.moved).toBe(1);
    expect(fs.existsSync(path.join(d, 'assets/Findings 2026/token.png'))).toBe(true);
    expect(fs.readFileSync(path.join(d, 'main.typ'), 'utf8')).toContain('"/assets/Findings 2026/token.png"');
    expect(ws.listFolders().map((f) => f.id)).toEqual(['Findings 2026']);
    expect(() => ws.createFolder('../x')).toThrow();
  });

  it('deletes an asset and its meta', () => {
    const d = fixture();
    const ws = openWorkspace(d);
    ws.deleteAsset('assets/cover.png');
    expect(fs.existsSync(path.join(d, 'assets/cover.png'))).toBe(false);
    expect(ws.readMeta().assets['assets/cover.png']).toBeUndefined();
    expect(() => ws.deleteAsset('assets/cover.png')).toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run --project server server/workspace.test.ts`
Expected: the six new tests fail (`addAsset is not a function`, ...).

- [ ] **Step 3: Extend `server/workspace.ts`**

Add to the `WorkspaceFs` interface:

```ts
  getAsset(id: string): TypstAsset;
  addAsset(input: { kind: TypstAssetKind; filename: string; bytes: Uint8Array; folder: string | null; family?: string | null }): TypstAsset;
  patchAsset(id: string, patch: { crop?: unknown; blurs?: unknown; width?: unknown; height?: unknown; family?: unknown }): TypstAsset;
  renameAsset(id: string, stem: string): { asset: TypstAsset; references: number };
  moveAsset(id: string, folder: string | null): { asset: TypstAsset; references: number };
  deleteAsset(id: string): void;
  createFolder(rel: string): AssetFolder;
  renameFolder(rel: string, newRel: string): { references: number };
  deleteFolder(rel: string): { references: number; moved: number };
  /** Rewrite `"<oldTypstPath>"` to `"<newTypstPath>"` in every .typ file; returns how many references changed. */
  rewriteReferences(oldTypstPath: string, newTypstPath: string): number;
```

Add these imports at the top:

```ts
import type { TypstAssetKind } from '../src/types';
import { countAssetReferences, retargetAssetPath } from '../src/lib/typst-placeholders';
import { MAX_ASSET_BYTES, reconcileImageName, sanitizeFilename, sanitizeStem, uniqueFilename, validateBlurs, validateCrop } from './assets';
```

Inside `openWorkspace`, before the `return`, add:

```ts
  const getAsset = (id: string): TypstAsset => {
    const hit = listAssets().find((a) => a.id === id);
    if (!hit) throw new HttpError(404, `asset not found: ${id}`);
    return hit;
  };

  /** Directory (relative to assets/) => absolute, creating it. '' or null = assets/ itself. */
  const assetDir = (folder: string | null): { abs: string; rel: string } => {
    const n = folder ? normalizeRel(folder) : '';
    if (n === null) throw new HttpError(400, `invalid folder: ${folder}`);
    const rel = n ? `${ASSETS_DIR}/${n}` : ASSETS_DIR;
    const a = resolveInside(rootAbs, rel);
    if (!a) throw new HttpError(400, `folder escapes the workspace: ${folder}`);
    fs.mkdirSync(a, { recursive: true });
    return { abs: a, rel };
  };

  const namesIn = (dirAbs: string): string[] => { try { return fs.readdirSync(dirAbs); } catch { return []; } };

  const rewriteReferences = (oldTypstPath: string, newTypstPath: string): number => {
    let total = 0;
    for (const rel of listFiles().map((f) => f.path).filter((p) => p.endsWith('.typ'))) {
      const a = path.join(rootAbs, ...rel.split('/'));
      const src = fs.readFileSync(a, 'utf8');
      const n = countAssetReferences(src, oldTypstPath);
      if (n === 0) continue;
      writeAtomic(a, retargetAssetPath(src, oldTypstPath, newTypstPath));
      total += n;
    }
    return total;
  };

  /** Move a meta record from one id to another (no-op when absent). */
  const moveMeta = (kind: TypstAssetKind, from: string, to: string): void => {
    const meta = readMeta();
    const table = kind === 'image' ? meta.assets : meta.fonts;
    const rec = (table as Record<string, unknown>)[from];
    if (rec === undefined) return;
    delete (table as Record<string, unknown>)[from];
    (table as Record<string, unknown>)[to] = rec;
    writeMetaRaw(meta);
  };
  const writeMetaRaw = (meta: WorkspaceJson) => writeAtomic(path.join(rootAbs, META_FILE), JSON.stringify(normaliseMeta(meta), null, 2));

  /** Rename/move one asset file to a new directory + filename, rewriting references and meta. */
  const relocate = (asset: TypstAsset, dirRel: string, filename: string): { asset: TypstAsset; references: number } => {
    const newId = `${dirRel}/${filename}`;
    if (newId === asset.id) return { asset, references: 0 };
    const from = path.join(rootAbs, ...asset.id.split('/'));
    const to = path.join(rootAbs, ...newId.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    moveMeta(asset.kind, asset.id, newId);
    const references = rewriteReferences(`/${asset.id}`, `/${newId}`);
    return { asset: getAsset(newId), references };
  };

  const addAsset: WorkspaceFs['addAsset'] = ({ kind, filename, bytes, folder, family }) => {
    if (bytes.length === 0) throw new HttpError(400, 'empty upload');
    if (bytes.length > MAX_ASSET_BYTES) throw new HttpError(413, `file exceeds ${MAX_ASSET_BYTES} bytes`);
    let name = sanitizeFilename(filename);
    if (kind === 'image') name = reconcileImageName(name, bytes).filename;
    if (!mimeFor(kind, name)) throw new HttpError(400, `file type not allowed for ${kind}: ${name}`);
    const dir = kind === 'image' ? assetDir(folder) : { abs: path.join(rootAbs, FONTS_DIR), rel: FONTS_DIR };
    fs.mkdirSync(dir.abs, { recursive: true });
    name = uniqueFilename(namesIn(dir.abs), name);
    writeAtomic(path.join(dir.abs, name), bytes);
    const id = `${dir.rel}/${name}`;
    if (kind === 'font') {
      const meta = readMeta();
      meta.fonts[id] = { family: family ?? null };
      writeMetaRaw(meta);
    }
    return getAsset(id);
  };

  const patchAsset: WorkspaceFs['patchAsset'] = (id, patch) => {
    const asset = getAsset(id);
    const meta = readMeta();
    if (asset.kind === 'font') {
      if ('family' in patch) {
        if (patch.family !== null && typeof patch.family !== 'string') throw new HttpError(400, 'family must be a string or null');
        meta.fonts[id] = { family: (patch.family as string | null) ?? null };
      }
    } else {
      const rec = { ...(meta.assets[id] ?? {}) };
      if ('crop' in patch) {
        const crop = validateCrop(patch.crop);
        if (crop === undefined) throw new HttpError(400, 'crop must be {x, y, w, h} with positive w and h, or null');
        rec.crop = crop;
      }
      if ('blurs' in patch) {
        const blurs = validateBlurs(patch.blurs);
        if (blurs === undefined) throw new HttpError(400, 'blurs must be regions inside 0..1 with positive size, or null');
        rec.blurs = blurs;
      }
      for (const key of ['width', 'height'] as const) {
        if (!(key in patch)) continue;
        const v = patch[key];
        if (v === null) { rec[key] = null; continue; }
        if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new HttpError(400, `${key} must be a positive integer`);
        rec[key] = v;
      }
      meta.assets[id] = rec;
    }
    writeMetaRaw(meta);
    return getAsset(id);
  };

  const renameAsset: WorkspaceFs['renameAsset'] = (id, stem) => {
    const asset = getAsset(id);
    const ext = extensionOf(asset.filename);
    const safe = sanitizeStem(stem.replace(/\.[A-Za-z0-9]+$/, ''));
    if (!safe) throw new HttpError(400, 'name cannot be empty');
    const dirRel = path.posix.dirname(asset.id);
    const dirAbs = path.join(rootAbs, ...dirRel.split('/'));
    const filename = uniqueFilename(namesIn(dirAbs).filter((n) => n.toLowerCase() !== asset.filename.toLowerCase()), safe + ext);
    return relocate(asset, dirRel, filename);
  };

  const moveAsset: WorkspaceFs['moveAsset'] = (id, folder) => {
    const asset = getAsset(id);
    if (asset.kind !== 'image') throw new HttpError(400, 'only images live in folders');
    const dir = assetDir(folder);
    const filename = uniqueFilename(namesIn(dir.abs), asset.filename);
    return relocate(asset, dir.rel, filename);
  };

  const deleteAsset: WorkspaceFs['deleteAsset'] = (id) => {
    const asset = getAsset(id);
    fs.unlinkSync(path.join(rootAbs, ...asset.id.split('/')));
    const meta = readMeta();
    delete meta.assets[id];
    delete meta.fonts[id];
    writeMetaRaw(meta);
  };

  const createFolder: WorkspaceFs['createFolder'] = (rel) => {
    const n = normalizeRel(rel);
    if (!n) throw new HttpError(400, `invalid folder: ${rel}`);
    assetDir(n);
    const hit = listFolders().find((f) => f.id === n);
    if (!hit) throw new HttpError(500, 'folder was not created');
    return hit;
  };

  /** Every image asset whose id starts with assets/<folderRel>/ */
  const assetsUnder = (folderRel: string): TypstAsset[] =>
    listAssets().filter((a) => a.kind === 'image' && a.id.startsWith(`${ASSETS_DIR}/${folderRel}/`));

  const renameFolder: WorkspaceFs['renameFolder'] = (rel, newRel) => {
    const from = normalizeRel(rel);
    const to = normalizeRel(newRel);
    if (!from || !to) throw new HttpError(400, 'invalid folder path');
    const fromAbs = resolveInside(rootAbs, `${ASSETS_DIR}/${from}`);
    const toAbs = resolveInside(rootAbs, `${ASSETS_DIR}/${to}`);
    if (!fromAbs || !toAbs || !fs.existsSync(fromAbs)) throw new HttpError(404, `folder not found: ${rel}`);
    if (fs.existsSync(toAbs)) throw new HttpError(409, `a folder named ${to} already exists`);
    const before = assetsUnder(from);
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    fs.renameSync(fromAbs, toAbs);
    let references = 0;
    for (const a of before) {
      const newId = `${ASSETS_DIR}/${to}/${a.id.slice(`${ASSETS_DIR}/${from}/`.length)}`;
      moveMeta('image', a.id, newId);
      references += rewriteReferences(`/${a.id}`, `/${newId}`);
    }
    return { references };
  };

  const deleteFolder: WorkspaceFs['deleteFolder'] = (rel) => {
    const n = normalizeRel(rel);
    if (!n) throw new HttpError(400, `invalid folder: ${rel}`);
    const dirAbs = resolveInside(rootAbs, `${ASSETS_DIR}/${n}`);
    if (!dirAbs || !fs.existsSync(dirAbs)) throw new HttpError(404, `folder not found: ${rel}`);
    const parentRel = n.includes('/') ? n.slice(0, n.lastIndexOf('/')) : null;
    const parent = assetDir(parentRel);
    let references = 0;
    let moved = 0;
    for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
      const target = uniqueFilename(namesIn(parent.abs), entry.name);
      const fromId = `${ASSETS_DIR}/${n}/${entry.name}`;
      const toId = `${parent.rel}/${target}`;
      const under = entry.isDirectory() ? assetsUnder(`${n}/${entry.name}`) : [];
      fs.renameSync(path.join(dirAbs, entry.name), path.join(parent.abs, target));
      moved += 1;
      if (entry.isDirectory()) {
        for (const a of under) {
          const newId = toId + a.id.slice(fromId.length);
          moveMeta('image', a.id, newId);
          references += rewriteReferences(`/${a.id}`, `/${newId}`);
        }
      } else {
        moveMeta('image', fromId, toId);
        references += rewriteReferences(`/${fromId}`, `/${toId}`);
      }
    }
    fs.rmdirSync(dirAbs);
    return { references, moved };
  };
```

Then add `getAsset, addAsset, patchAsset, renameAsset, moveAsset, deleteAsset, createFolder, renameFolder, deleteFolder, rewriteReferences` to the returned object.

- [ ] **Step 4: Run all workspace tests**

Run: `bunx vitest run --project server server/workspace.test.ts`
Expected: 10 tests pass. `bun run typecheck` passes.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(server): asset upload, framing, rename, move, folders with reference rewriting" -- advanced-typst-editor
```

---

### Task 6: Event bus and file watcher with echo suppression

**Files:**
- Create: `server/events.ts`, `server/watcher.ts`, `server/events.test.ts`, `server/watcher.test.ts`

**Interfaces:**
- Produces: `createEventBus() -> EventBus { emit(ev), subscribe(fn) -> unsubscribe, size }`; `createWatcher({bus, now?, debounceMs?}) -> Watcher { watch(id, root), unwatch(id), markOwnWrite(id, rel), close() }`. `ServerEvent` from `src/types.ts`.

- [ ] **Step 1: Write `server/events.ts`**

```ts
import type { ServerEvent } from '../src/types';

export type Listener = (event: ServerEvent) => void;
export interface EventBus {
  emit(event: ServerEvent): void;
  subscribe(listener: Listener): () => void;
  readonly size: number;
}

export function createEventBus(): EventBus {
  const listeners = new Set<Listener>();
  return {
    emit(event) {
      for (const l of [...listeners]) {
        try { l(event); } catch (err) { listeners.delete(l); console.error('[events] listener dropped', err); }
      }
    },
    subscribe(l) { listeners.add(l); return () => { listeners.delete(l); }; },
    get size() { return listeners.size; },
  };
}
```

- [ ] **Step 2: Write `server/events.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { createEventBus } from './events';

describe('event bus', () => {
  it('delivers to every subscriber and drops throwing ones', () => {
    const bus = createEventBus();
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.type));
    bus.subscribe(() => { throw new Error('boom'); });
    bus.emit({ type: 'workspaces.changed' });
    bus.emit({ type: 'workspaces.changed' });
    expect(seen).toEqual(['workspaces.changed', 'workspaces.changed']);
    expect(bus.size).toBe(1);
  });
});
```

- [ ] **Step 3: Write the failing test `server/watcher.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerEvent } from '../src/types';
import { createEventBus } from './events';
import { createWatcher } from './watcher';
import { tmpDir, rmDir, put } from './test-util';

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => { for (const c of closers.splice(0)) c(); for (const d of dirs.splice(0)) rmDir(d); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timeout'); await sleep(25); }
}

describe('watcher', () => {
  it('reports external edits, coalesced, and suppresses its own writes', async () => {
    const d = tmpDir(); dirs.push(d);
    put(d, 'main.typ', 'a');
    const bus = createEventBus();
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const w = createWatcher({ bus, debounceMs: 100 });
    closers.push(() => w.close());
    w.watch('ws1', d);
    await sleep(200);

    // Own write: marked first, then written => no event.
    w.markOwnWrite('ws1', 'main.typ');
    fs.writeFileSync(path.join(d, 'main.typ'), 'own');
    await sleep(400);
    expect(events).toEqual([]);

    // External edits to two files inside the debounce window => one event.
    fs.writeFileSync(path.join(d, 'main.typ'), 'ext');
    put(d, 'assets/x.png', 'img');
    await until(() => events.length >= 1);
    await sleep(200);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('workspace.changed');
    if (ev.type === 'workspace.changed') {
      expect(ev.id).toBe('ws1');
      expect(ev.origin).toBe('disk');
      expect(ev.paths.sort()).toEqual(['assets/x.png', 'main.typ']);
    }

    w.unwatch('ws1');
    fs.writeFileSync(path.join(d, 'main.typ'), 'after');
    await sleep(300);
    expect(events).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `bunx vitest run --project server server/watcher.test.ts` → FAIL (module not found).

- [ ] **Step 5: Write `server/watcher.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { EventBus } from './events';

export interface Watcher {
  watch(id: string, root: string): void;
  unwatch(id: string): void;
  /** Call right before the server writes `rel` itself, so the resulting fs event is ignored. */
  markOwnWrite(id: string, rel: string): void;
  close(): void;
}

interface Entry { root: string; handle: fs.FSWatcher | null; pending: Set<string>; timer: ReturnType<typeof setTimeout> | null }

const IGNORED = /(^|\/)(\.git|node_modules|\.[^/]*|.*\.tmp)(\/|$)/;

export function createWatcher(deps: { bus: EventBus; now?: () => number; debounceMs?: number; ownWriteWindowMs?: number }): Watcher {
  const now = deps.now ?? (() => Date.now());
  const debounceMs = deps.debounceMs ?? 200;
  const windowMs = deps.ownWriteWindowMs ?? 1500;
  const entries = new Map<string, Entry>();
  const own = new Map<string, number>(); // `${id}\0${rel}` -> marked at

  const flush = (id: string) => {
    const e = entries.get(id);
    if (!e) return;
    e.timer = null;
    const paths = [...e.pending];
    e.pending.clear();
    if (paths.length) deps.bus.emit({ type: 'workspace.changed', id, paths, origin: 'disk' });
  };

  const onChange = (id: string, filename: string | Buffer | null) => {
    const e = entries.get(id);
    if (!e || !filename) return;
    const rel = String(filename).replace(/\\/g, '/');
    if (IGNORED.test(rel)) return;
    const key = `${id}\0${rel}`;
    const at = own.get(key);
    if (at !== undefined && now() - at < windowMs) return; // our own write echoing back
    e.pending.add(rel);
    if (e.timer) clearTimeout(e.timer);
    e.timer = setTimeout(() => flush(id), debounceMs);
  };

  return {
    watch(id, root) {
      if (entries.has(id)) return;
      const e: Entry = { root: path.resolve(root), handle: null, pending: new Set(), timer: null };
      try {
        e.handle = fs.watch(e.root, { recursive: true }, (_ev, filename) => onChange(id, filename));
        e.handle.on('error', () => { /* folder vanished; the registry reports it as missing */ });
      } catch {
        e.handle = null;
      }
      entries.set(id, e);
    },
    unwatch(id) {
      const e = entries.get(id);
      if (!e) return;
      if (e.timer) clearTimeout(e.timer);
      e.handle?.close();
      entries.delete(id);
    },
    markOwnWrite(id, rel) {
      own.set(`${id}\0${rel.replace(/\\/g, '/')}`, now());
      // Also cover the temp file writeAtomic creates next to it.
      if (own.size > 5000) for (const [k, t] of own) if (now() - t > windowMs) own.delete(k);
    },
    close() { for (const id of [...entries.keys()]) this.unwatch(id); },
  };
}
```

Note: `writeAtomic` writes `<file>.<pid>.<hex>.tmp` then renames; the `.tmp` pattern is in `IGNORED`, and the rename shows up as an event on the final name, which `markOwnWrite` covers.

- [ ] **Step 6: Run, typecheck, commit**

Run: `bunx vitest run --project server` → all pass (the watcher test takes ~1.5 s).

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(server): event bus and workspace file watcher" -- advanced-typst-editor
```

---

### Task 7: WorkspaceService, REST router, static hosting, entry point

**Files:**
- Create: `server/service.ts`, `server/static.ts` (copy of `$OLD/server/static.ts`, unchanged), `server/router.ts`, `server/index.ts`, `server/service.test.ts`, `server/router.test.ts`

**Interfaces:**
- Consumes: Tasks 3 to 6.
- Produces: `createWorkspaceService(deps) -> WorkspaceService` (methods listed in Step 3); `createHandler(deps: HandlerDeps) -> (req: Request) => Promise<Response>`; `HandlerDeps` has optional slots `backup`, `compile`, `mcp`, `browse` that later tasks fill (they are `null` until then and their routes return 503 `{ error: 'not available' }`).

- [ ] **Step 1: Write the failing test `server/service.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerEvent } from '../src/types';
import { createEventBus } from './events';
import { createSettingsStore } from './settings';
import { createWorkspaceService } from './service';
import { tmpDir, rmDir, put } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

function setup() {
  const dataDir = tmpDir(); dirs.push(dataDir);
  const bus = createEventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const settings = createSettingsStore(dataDir, { now: () => 1000 });
  const svc = createWorkspaceService({ settings, bus, watcher: null, dataDir, workspacesDir: path.join(dataDir, 'workspaces'), template: '= Template\n', now: () => 1000 });
  return { dataDir, bus, events, settings, svc };
}

describe('workspace service', () => {
  it('creates a library workspace from the template and lists it', () => {
    const { svc, dataDir, events } = setup();
    const w = svc.create({ name: 'My: Report?', group: 'CPTC', source: undefined });
    expect(w.library).toBe(true);
    expect(w.path).toBe(path.join(dataDir, 'workspaces', 'My_ Report_'));
    expect(fs.readFileSync(path.join(w.path, 'main.typ'), 'utf8')).toBe('= Template\n');
    expect(svc.list()).toEqual([{ ...w, status: 'ok' }]);
    expect(events.some((e) => e.type === 'workspaces.changed')).toBe(true);
    const w2 = svc.create({ name: 'My: Report?', group: null, source: '= Two' });
    expect(path.basename(w2.path)).toBe('My_ Report_ (2)');
  });

  it('opens an external folder once, refuses roots and the data dir', () => {
    const { svc, dataDir } = setup();
    const ext = tmpDir(); dirs.push(ext);
    put(ext, 'main.typ', '= Ext');
    const w = svc.openFolder(ext, undefined);
    expect(w.library).toBe(false);
    expect(w.name).toBe(path.basename(ext));
    expect(svc.openFolder(ext, 'x').id).toBe(w.id);
    expect(() => svc.openFolder('C:\\', undefined)).toThrow(/drive root/);
    expect(() => svc.openFolder(dataDir, undefined)).toThrow(/data folder/);
    expect(() => svc.openFolder(path.join(ext, 'missing'), undefined)).toThrow(/not a folder/);
  });

  it('renames (folder too, for library), regroups, and removes to trash', () => {
    const { svc, dataDir } = setup();
    const w = svc.create({ name: 'A', group: null, source: undefined });
    const r = svc.rename(w.id, 'B');
    expect(r.name).toBe('B');
    expect(fs.existsSync(path.join(dataDir, 'workspaces', 'B', 'main.typ'))).toBe(true);
    expect(svc.setGroup(w.id, 'G').group).toBe('G');
    svc.remove(w.id);
    expect(svc.list()).toEqual([]);
    const trash = fs.readdirSync(path.join(dataDir, 'trash'));
    expect(trash).toHaveLength(1);
    expect(fs.existsSync(path.join(dataDir, 'trash', trash[0]!, 'B', 'main.typ'))).toBe(true);
  });

  it('reports a missing external workspace instead of dropping it', () => {
    const { svc } = setup();
    const ext = tmpDir();
    put(ext, 'main.typ', '');
    const w = svc.openFolder(ext, undefined);
    rmDir(ext);
    expect(svc.list()[0]).toMatchObject({ id: w.id, status: 'missing' });
    expect(() => svc.detail(w.id)).toThrow(/missing/);
  });

  it('writes go through the service and emit with the origin', () => {
    const { svc, events } = setup();
    const w = svc.create({ name: 'A', group: null, source: undefined });
    events.length = 0;
    svc.writeFile(w.id, 'main.typ', Buffer.from('= X'), 'client-1');
    expect(events.at(-1)).toEqual({ type: 'workspace.changed', id: w.id, paths: ['main.typ'], origin: 'client-1' });
    const a = svc.addAsset(w.id, { kind: 'image', filename: 'x.png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), folder: 'shots' }, 'mcp');
    expect(events.at(-1)).toMatchObject({ type: 'workspace.changed', id: w.id, paths: ['assets/shots/x.png'], origin: 'mcp' });
    const d = svc.detail(w.id);
    expect(d.assets.map((x) => x.id)).toEqual([a.id]);
    expect(d.folders.map((f) => f.id)).toEqual(['shots']);
    expect(d.files.map((f) => f.path).sort()).toEqual(['assets/shots/x.png', 'main.typ']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run --project server server/service.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write `server/service.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { AssetFolder, TypstAsset, TypstAssetKind, WorkspaceDetail, WorkspaceEntry, WorkspaceStatus } from '../src/types';
import type { EventBus } from './events';
import { ensureDir, isDir, safeDirName, stamp, uniqueDirName } from './fsx';
import { HttpError } from './http';
import type { SettingsStore } from './settings';
import type { Watcher } from './watcher';
import { openWorkspace, type WorkspaceFs } from './workspace';

export interface ServiceDeps {
  settings: SettingsStore;
  bus: EventBus;
  watcher: Watcher | null;
  dataDir: string;
  workspacesDir: string;
  /** Source of a new workspace's main.typ when none is given. */
  template: string;
  now?: () => number;
}

const MAX_ENTRIES = 5000;

export interface WorkspaceService {
  list(): WorkspaceStatus[];
  entry(id: string): WorkspaceEntry;
  fs(id: string): WorkspaceFs;
  detail(id: string): WorkspaceDetail;
  create(input: { name: string; group: string | null; source: string | undefined }): WorkspaceEntry;
  openFolder(absPath: string, name: string | undefined): WorkspaceEntry;
  rename(id: string, name: string): WorkspaceEntry;
  setGroup(id: string, group: string | null): WorkspaceEntry;
  remove(id: string): void;
  /** Register every library folder not yet known and start watching everything that exists. */
  boot(): void;
  // writes: all emit workspace.changed with `origin`
  writeFile(id: string, rel: string, bytes: Uint8Array, origin: string | null): void;
  deleteFile(id: string, rel: string, origin: string | null): boolean;
  addAsset(id: string, input: { kind: TypstAssetKind; filename: string; bytes: Uint8Array; folder: string | null; family?: string | null }, origin: string | null): TypstAsset;
  patchAsset(id: string, assetId: string, patch: Record<string, unknown>, origin: string | null): TypstAsset;
  renameAsset(id: string, assetId: string, stem: string, origin: string | null): { asset: TypstAsset; references: number };
  moveAsset(id: string, assetId: string, folder: string | null, origin: string | null): { asset: TypstAsset; references: number };
  deleteAsset(id: string, assetId: string, origin: string | null): void;
  createFolder(id: string, rel: string, origin: string | null): AssetFolder;
  renameFolder(id: string, rel: string, newRel: string, origin: string | null): { references: number };
  deleteFolder(id: string, rel: string, origin: string | null): { references: number; moved: number };
}

export function createWorkspaceService(deps: ServiceDeps): WorkspaceService {
  const now = deps.now ?? (() => Date.now());
  const { settings, bus, watcher } = deps;

  const entry = (id: string): WorkspaceEntry => {
    const e = settings.getWorkspace(id);
    if (!e) throw new HttpError(404, `workspace not found: ${id}`);
    return e;
  };
  const liveFs = (id: string): WorkspaceFs => {
    const e = entry(id);
    if (!isDir(e.path)) throw new HttpError(409, `workspace folder is missing: ${e.path}`);
    return openWorkspace(e.path, { now });
  };
  const status = (e: WorkspaceEntry): WorkspaceStatus => ({ ...e, status: isDir(e.path) ? 'ok' : 'missing' });
  const registryChanged = () => bus.emit({ type: 'workspaces.changed' });
  const changed = (id: string, paths: string[], origin: string | null) => {
    for (const p of paths) watcher?.markOwnWrite(id, p);
    watcher?.markOwnWrite(id, 'workspace.json');
    bus.emit({ type: 'workspace.changed', id, paths, origin });
  };
  /** Paths whose bytes changed because of a rename/move: the .typ files plus the two asset paths. */
  const touched = (ws: WorkspaceFs, extra: string[]): string[] => [...new Set([...ws.typFiles(), ...extra])];

  const register = (input: { path: string; name: string; group: string | null; library: boolean }): WorkspaceEntry => {
    const e = settings.addWorkspace(input);
    watcher?.watch(e.id, e.path);
    registryChanged();
    return e;
  };

  return {
    list: () => settings.listWorkspaces().map(status),
    entry,
    fs: liveFs,
    detail(id) {
      const e = entry(id);
      if (!isDir(e.path)) throw new HttpError(409, `workspace folder is missing: ${e.path}`);
      const ws = openWorkspace(e.path, { now });
      settings.patchWorkspace(id, { openedAt: now() });
      return { entry: e, files: ws.listFiles(), meta: ws.readMeta(), assets: ws.listAssets(), folders: ws.listFolders() };
    },
    create({ name, group, source }) {
      const clean = name.trim() || 'Untitled report';
      ensureDir(deps.workspacesDir);
      const dir = path.join(deps.workspacesDir, uniqueDirName(deps.workspacesDir, safeDirName(clean)));
      ensureDir(dir);
      fs.writeFileSync(path.join(dir, 'main.typ'), source ?? deps.template);
      return register({ path: dir, name: clean, group: group?.trim() || null, library: true });
    },
    openFolder(absPath, name) {
      const p = path.resolve(absPath);
      if (!isDir(p)) throw new HttpError(400, `not a folder: ${absPath}`);
      if (path.parse(p).root === p) throw new HttpError(400, 'a drive root cannot be a workspace');
      const rd = path.resolve(deps.dataDir);
      if (p === rd || rd.startsWith(p + path.sep)) throw new HttpError(400, 'the app data folder cannot be a workspace');
      let count = 0;
      const stack = [p];
      while (stack.length && count <= MAX_ENTRIES) {
        const d = stack.pop()!;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          count += 1;
          if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') stack.push(path.join(d, e.name));
          if (count > MAX_ENTRIES) break;
        }
      }
      if (count > MAX_ENTRIES) throw new HttpError(400, `that folder holds more than ${MAX_ENTRIES} entries; pick the report's own folder`);
      const existing = settings.findByPath(p);
      if (existing) return existing;
      const inLibrary = p.startsWith(path.resolve(deps.workspacesDir) + path.sep);
      return register({ path: p, name: name?.trim() || path.basename(p), group: null, library: inLibrary });
    },
    rename(id, name) {
      const e = entry(id);
      const clean = name.trim();
      if (!clean) throw new HttpError(400, 'name cannot be empty');
      let newPath = e.path;
      if (e.library && isDir(e.path)) {
        const parent = path.dirname(e.path);
        const target = path.join(parent, uniqueDirName(parent, safeDirName(clean)));
        if (target !== e.path) {
          watcher?.unwatch(id);
          fs.renameSync(e.path, target);
          newPath = target;
          watcher?.watch(id, target);
        }
      }
      const out = settings.patchWorkspace(id, { name: clean, path: newPath })!;
      registryChanged();
      return out;
    },
    setGroup(id, group) {
      entry(id);
      const out = settings.patchWorkspace(id, { group: group?.trim() || null })!;
      registryChanged();
      return out;
    },
    remove(id) {
      const e = entry(id);
      watcher?.unwatch(id);
      if (e.library && isDir(e.path)) {
        const trash = path.join(deps.dataDir, 'trash', stamp(now()));
        ensureDir(trash);
        fs.renameSync(e.path, path.join(trash, path.basename(e.path)));
      }
      settings.removeWorkspace(id);
      registryChanged();
    },
    boot() {
      ensureDir(deps.workspacesDir);
      settings.scanLibrary(deps.workspacesDir);
      for (const e of settings.listWorkspaces()) if (isDir(e.path)) watcher?.watch(e.id, e.path);
    },
    writeFile(id, rel, bytes, origin) {
      const ws = liveFs(id);
      const f = ws.writeFile(rel, bytes);
      changed(id, [f.path], origin);
    },
    deleteFile(id, rel, origin) {
      const ws = liveFs(id);
      const ok = ws.deleteFile(rel);
      if (ok) changed(id, [rel], origin);
      return ok;
    },
    addAsset(id, input, origin) {
      const a = liveFs(id).addAsset(input);
      changed(id, [a.id], origin);
      return a;
    },
    patchAsset(id, assetId, patch, origin) {
      const a = liveFs(id).patchAsset(assetId, patch);
      changed(id, ['workspace.json'], origin);
      return a;
    },
    renameAsset(id, assetId, stem, origin) {
      const ws = liveFs(id);
      const r = ws.renameAsset(assetId, stem);
      changed(id, touched(ws, [assetId, r.asset.id]), origin);
      return r;
    },
    moveAsset(id, assetId, folder, origin) {
      const ws = liveFs(id);
      const r = ws.moveAsset(assetId, folder);
      changed(id, touched(ws, [assetId, r.asset.id]), origin);
      return r;
    },
    deleteAsset(id, assetId, origin) {
      liveFs(id).deleteAsset(assetId);
      changed(id, [assetId], origin);
    },
    createFolder(id, rel, origin) {
      const f = liveFs(id).createFolder(rel);
      changed(id, [`assets/${f.id}`], origin);
      return f;
    },
    renameFolder(id, rel, newRel, origin) {
      const ws = liveFs(id);
      const r = ws.renameFolder(rel, newRel);
      changed(id, touched(ws, [`assets/${rel}`, `assets/${newRel}`]), origin);
      return r;
    },
    deleteFolder(id, rel, origin) {
      const ws = liveFs(id);
      const r = ws.deleteFolder(rel);
      changed(id, touched(ws, [`assets/${rel}`]), origin);
      return r;
    },
  };
}
```

- [ ] **Step 4: Run the service tests**

Run: `bunx vitest run --project server server/service.test.ts` → 5 pass.

- [ ] **Step 5: Copy `server/static.ts` from `$OLD/server/static.ts`** (no changes).

- [ ] **Step 6: Write the failing test `server/router.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { createEventBus } from './events';
import { createSettingsStore } from './settings';
import { createWorkspaceService } from './service';
import { createHandler } from './router';
import { tmpDir, rmDir } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function app(token: string | null = null) {
  const dataDir = tmpDir(); dirs.push(dataDir);
  const bus = createEventBus();
  const settings = createSettingsStore(dataDir);
  const service = createWorkspaceService({ settings, bus, watcher: null, dataDir, workspacesDir: path.join(dataDir, 'workspaces'), template: '= T\n' });
  const handler = createHandler({ settings, service, bus, token, staticDir: null, dataDir, backup: null, compile: null, mcp: null, browse: null });
  const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    handler(new Request(`http://127.0.0.1:8090${url}`, {
      method,
      headers: { ...(body instanceof Uint8Array ? { 'content-type': 'application/octet-stream' } : body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body instanceof Uint8Array ? body : body !== undefined ? JSON.stringify(body) : undefined,
    }));
  return { call, service, bus };
}

describe('router', () => {
  it('health, create, detail, file round trip, asset upload and patch', async () => {
    const { call } = app();
    expect((await call('GET', '/api/health')).status).toBe(200);
    const created = await (await call('POST', '/api/workspaces', { name: 'R', group: 'G' })).json() as { workspace: { id: string } };
    const id = created.workspace.id;
    const list = await (await call('GET', '/api/workspaces')).json() as { workspaces: Array<{ id: string; status: string }> };
    expect(list.workspaces[0]).toMatchObject({ id, status: 'ok' });

    const put = await call('PUT', `/api/workspaces/${id}/files/main.typ`, new TextEncoder().encode('= New'), { 'x-client-id': 'c1' });
    expect(put.status).toBe(200);
    const got = await call('GET', `/api/workspaces/${id}/files/main.typ`);
    expect(await got.text()).toBe('= New');
    expect(got.headers.get('etag')).toMatch(/^"\d+-\d+"$/);
    expect((await call('GET', `/api/workspaces/${id}/files/../x`)).status).toBe(400);

    const up = await call('POST', `/api/workspaces/${id}/assets?filename=shot.png&folder=f1&kind=image`, new Uint8Array(PNG));
    expect(up.status).toBe(201);
    const { asset } = await up.json() as { asset: { id: string } };
    expect(asset.id).toBe('assets/f1/shot.png');
    const patched = await call('PATCH', `/api/workspaces/${id}/assets/assets/f1/shot.png`, { crop: { x: 0, y: 0, w: 1, h: 0.5 } });
    expect(((await patched.json()) as { asset: { crop: unknown } }).asset.crop).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    const renamed = await call('PATCH', `/api/workspaces/${id}/assets/assets/f1/shot.png`, { stem: 'better' });
    expect(((await renamed.json()) as { asset: { id: string } }).asset.id).toBe('assets/f1/better.png');
    const detail = await (await call('GET', `/api/workspaces/${id}`)).json() as { assets: unknown[]; folders: Array<{ id: string }>; meta: unknown };
    expect(detail.assets).toHaveLength(1);
    expect(detail.folders.map((f) => f.id)).toEqual(['f1']);
    expect((await call('DELETE', `/api/workspaces/${id}/asset-folders?path=f1`)).status).toBe(200);
    expect((await call('DELETE', `/api/workspaces/${id}/assets/assets/better.png`)).status).toBe(200);
    expect((await call('GET', '/api/workspaces/nope')).status).toBe(404);
    expect((await call('GET', '/api/backup')).status).toBe(503);
  });

  it('requires the bearer token when one is set, except for health', async () => {
    const { call } = app('secret');
    expect((await call('GET', '/api/health')).status).toBe(200);
    expect((await call('GET', '/api/workspaces')).status).toBe(401);
    expect((await call('GET', '/api/workspaces', undefined, { authorization: 'Bearer secret' })).status).toBe(200);
  });

  it('streams events over SSE', async () => {
    const { call, service } = app();
    const res = await call('GET', '/api/events');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('event: hello');
    service.create({ name: 'A', group: null, source: undefined });
    const next = new TextDecoder().decode((await reader.read()).value);
    expect(next).toContain('workspaces.changed');
    await reader.cancel();
  });
});
```

- [ ] **Step 7: Run to verify failure** → `./router` not found.

- [ ] **Step 8: Write `server/router.ts`**

```ts
import crypto from 'node:crypto';
import type { BackupState, DirListing, McpStatus, SnapshotInfo, CompileResult } from '../src/types';
import type { EventBus } from './events';
import { HttpError, json, optionalString, readJsonObject, requireString } from './http';
import type { SettingsStore } from './settings';
import type { WorkspaceService } from './service';
import { serveStatic } from './static';
import { MAX_ASSET_BYTES } from './assets';

/** Filled in by later tasks; null => the route answers 503. */
export interface BackupApi {
  state(): BackupState;
  configure(patch: Record<string, unknown>): BackupState;
  run(): Promise<BackupState>;
  listSnapshots(destinationId: string): SnapshotInfo[];
  restore(destinationId: string, name: string): Promise<{ restored: number }>;
}
export interface CompileApi {
  available(): string | null;
  compile(workspaceId: string, file: string | undefined): Promise<CompileResult>;
  exportPdf(workspaceId: string, file: string | undefined, to: string | undefined): Promise<{ path: string | null; bytes: Uint8Array | null; baked: number }>;
}
export interface McpApi {
  handle(req: Request): Promise<Response>;
  status(): McpStatus;
}
export type BrowseApi = (p: string) => DirListing;

export interface HandlerDeps {
  settings: SettingsStore;
  service: WorkspaceService;
  bus: EventBus;
  token: string | null;
  staticDir: string | null;
  dataDir: string;
  backup: BackupApi | null;
  compile: CompileApi | null;
  mcp: McpApi | null;
  browse: BrowseApi | null;
}

const KEEPALIVE_MS = 25_000;

function authorised(req: Request, token: string | null): boolean {
  if (!token) return true;
  const h = req.headers.get('authorization') ?? '';
  const provided = h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
  if (!provided || provided.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(token));
}

function openEventStream(bus: EventBus): Response {
  const enc = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ }
      };
      send('hello', { at: Date.now() });
      unsubscribe = bus.subscribe((ev) => send(ev.type, ev));
      timer = setInterval(() => { try { controller.enqueue(enc.encode(': keepalive\n\n')); } catch { /* closed */ } }, KEEPALIVE_MS);
    },
    cancel() { unsubscribe?.(); if (timer) clearInterval(timer); },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
}

async function readBody(req: Request): Promise<Uint8Array> {
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > MAX_ASSET_BYTES + 1024) throw new HttpError(413, 'body too large');
  return buf;
}

export function createHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const { service } = deps;
  const need = <T>(v: T | null, what: string): T => { if (!v) throw new HttpError(503, `${what} not available`); return v; };

  async function route(req: Request, url: URL): Promise<Response> {
    const method = req.method.toUpperCase();
    const seg = url.pathname.split('/').filter(Boolean); // ['api', 'workspaces', id, ...]
    const origin = req.headers.get('x-client-id');

    if (seg[1] === 'health' && seg.length === 2) return json(200, { ok: true, version: '0.1.0' });
    if (seg[1] === 'events' && seg.length === 2 && method === 'GET') return openEventStream(deps.bus);

    if (seg[1] === 'workspaces') {
      if (seg.length === 2) {
        if (method === 'GET') return json(200, { workspaces: service.list() });
        if (method === 'POST') {
          const body = await readJsonObject(req);
          return json(201, { workspace: service.create({ name: optionalString(body, 'name') ?? '', group: optionalString(body, 'group') ?? null, source: optionalString(body, 'source') }) });
        }
      }
      if (seg.length === 3 && seg[2] === 'open' && method === 'POST') {
        const body = await readJsonObject(req);
        return json(201, { workspace: service.openFolder(requireString(body, 'path'), optionalString(body, 'name')) });
      }
      const id = seg[2]!;
      if (seg.length === 3) {
        if (method === 'GET') return json(200, service.detail(id));
        if (method === 'PATCH') {
          const body = await readJsonObject(req);
          let entry = service.entry(id);
          const name = optionalString(body, 'name');
          if (name !== undefined) entry = service.rename(id, name);
          if ('group' in body) {
            const g = body.group;
            if (g !== null && typeof g !== 'string') throw new HttpError(400, 'group must be a string or null');
            entry = service.setGroup(id, g as string | null);
          }
          return json(200, { workspace: entry });
        }
        if (method === 'DELETE') { service.remove(id); return json(200, { ok: true }); }
      }
      const rest = seg.slice(4).join('/');
      if (seg[3] === 'files' && rest) {
        if (method === 'GET' || method === 'HEAD') {
          const f = service.fs(id).readFile(rest);
          if (!f) return json(404, { error: 'file not found' });
          const etag = `"${f.etag}"`;
          if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
          return new Response(method === 'HEAD' ? null : f.bytes, { status: 200, headers: { etag, 'cache-control': 'no-cache', 'content-type': 'application/octet-stream' } });
        }
        if (method === 'PUT') { service.writeFile(id, rest, await readBody(req), origin); return json(200, { ok: true }); }
        if (method === 'DELETE') return json(service.deleteFile(id, rest, origin) ? 200 : 404, { ok: true });
      }
      if (seg[3] === 'assets') {
        if (seg.length === 4 && method === 'POST') {
          const kind = url.searchParams.get('kind') === 'font' ? 'font' : 'image';
          const asset = service.addAsset(id, { kind, filename: url.searchParams.get('filename') ?? 'asset', bytes: await readBody(req), folder: url.searchParams.get('folder') || null, family: url.searchParams.get('family') }, origin);
          return json(201, { asset });
        }
        if (rest && method === 'PATCH') {
          const body = await readJsonObject(req);
          const stem = optionalString(body, 'stem');
          if (stem !== undefined) return json(200, service.renameAsset(id, rest, stem, origin));
          if ('folder' in body) {
            const folder = body.folder;
            if (folder !== null && typeof folder !== 'string') throw new HttpError(400, 'folder must be a string or null');
            return json(200, service.moveAsset(id, rest, folder as string | null, origin));
          }
          return json(200, { asset: service.patchAsset(id, rest, body, origin) });
        }
        if (rest && method === 'DELETE') { service.deleteAsset(id, rest, origin); return json(200, { ok: true }); }
      }
      if (seg[3] === 'asset-folders' && seg.length === 4) {
        if (method === 'POST') { const b = await readJsonObject(req); return json(201, { folder: service.createFolder(id, requireString(b, 'path'), origin) }); }
        if (method === 'PATCH') { const b = await readJsonObject(req); return json(200, service.renameFolder(id, requireString(b, 'path'), requireString(b, 'newPath'), origin)); }
        if (method === 'DELETE') return json(200, service.deleteFolder(id, url.searchParams.get('path') ?? '', origin));
      }
      if (seg[3] === 'compile' && seg.length === 4 && method === 'POST') {
        const b = await readJsonObject(req);
        return json(200, await need(deps.compile, 'typst CLI').compile(id, optionalString(b, 'file')));
      }
      if (seg[3] === 'export-pdf' && seg.length === 4 && method === 'POST') {
        const b = await readJsonObject(req);
        const out = await need(deps.compile, 'typst CLI').exportPdf(id, optionalString(b, 'file'), optionalString(b, 'to'));
        if (out.bytes) return new Response(out.bytes, { status: 200, headers: { 'content-type': 'application/pdf', 'x-baked': String(out.baked) } });
        return json(200, { path: out.path, baked: out.baked });
      }
    }

    if (seg[1] === 'settings' && seg.length === 2) {
      if (method === 'GET') { const s = deps.settings.get(); return json(200, { typstCli: s.typstCli, redaction: s.redaction }); }
      if (method === 'PATCH') {
        const b = await readJsonObject(req);
        const s = deps.settings.update((cur) => ({
          ...cur,
          typstCli: 'typstCli' in b ? (typeof b.typstCli === 'string' && b.typstCli ? b.typstCli : null) : cur.typstCli,
          redaction: b.redaction && typeof b.redaction === 'object' ? { ...cur.redaction, ...(b.redaction as object) } : cur.redaction,
        }));
        return json(200, { typstCli: s.typstCli, redaction: s.redaction });
      }
    }
    if (seg[1] === 'backup') {
      const backup = need(deps.backup, 'backup');
      if (seg.length === 2 && method === 'GET') return json(200, { backup: backup.state() });
      if (seg.length === 2 && method === 'PATCH') return json(200, { backup: backup.configure(await readJsonObject(req)) });
      if (seg.length === 3 && seg[2] === 'run' && method === 'POST') return json(200, { backup: await backup.run() });
      if (seg.length === 3 && seg[2] === 'snapshots' && method === 'GET') return json(200, { snapshots: backup.listSnapshots(url.searchParams.get('destination') ?? '') });
      if (seg.length === 3 && seg[2] === 'restore' && method === 'POST') { const b = await readJsonObject(req); return json(200, await backup.restore(requireString(b, 'destination'), requireString(b, 'snapshot'))); }
    }
    if (seg[1] === 'fs' && seg[2] === 'browse' && seg.length === 3 && method === 'GET') return json(200, need(deps.browse, 'folder browser')(url.searchParams.get('path') ?? ''));
    if (seg[1] === 'mcp' && seg[2] === 'status' && seg.length === 3 && method === 'GET') return json(200, need(deps.mcp, 'MCP').status());
    return json(404, { error: `no route: ${method} ${url.pathname}` });
  }

  return async (req) => {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        if (!url.pathname.startsWith('/api/health') && !authorised(req, deps.token)) return json(401, { error: 'unauthorised' });
        return await route(req, url);
      }
      if (url.pathname === '/mcp') {
        if (!authorised(req, deps.token)) return json(401, { error: 'unauthorised' });
        return await need(deps.mcp, 'MCP').handle(req);
      }
      if (deps.staticDir && (req.method === 'GET' || req.method === 'HEAD')) {
        const res = serveStatic(deps.staticDir, url.pathname, req.headers.get('accept-encoding'));
        if (res) return res;
      }
      return json(404, { error: 'not found' });
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      console.error('[router]', err);
      return json(500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}
```

- [ ] **Step 9: Write `server/index.ts`**

```ts
declare const Bun: { serve(options: Record<string, unknown>): { hostname: string; port: number } };

import { DEFAULT_TEMPLATE } from '../src/template';
import { loadConfig } from './config';
import { createEventBus } from './events';
import { createHandler } from './router';
import { createWorkspaceService } from './service';
import { createSettingsStore } from './settings';
import { createWatcher } from './watcher';

const config = loadConfig();
const bus = createEventBus();
const settings = createSettingsStore(config.dataDir);
const watcher = createWatcher({ bus });
const service = createWorkspaceService({ settings, bus, watcher, dataDir: config.dataDir, workspacesDir: config.workspacesDir, template: DEFAULT_TEMPLATE });
service.boot();

// Later tasks replace these nulls: backup (Task 12), compile (Task 9), mcp (Task 13), browse (Task 12).
const handler = createHandler({ settings, service, bus, token: config.token, staticDir: config.staticDir, dataDir: config.dataDir, backup: null, compile: null, mcp: null, browse: null });

Bun.serve({ hostname: config.host, port: config.port, maxRequestBodySize: 32 * 1024 * 1024, idleTimeout: 120, fetch: handler });
console.log(`[tfs] listening on http://${config.host}:${config.port}  data=${config.dataDir}  static=${config.staticDir ?? '(api only)'}  auth=${config.token ? 'token' : 'open'}`);
```

- [ ] **Step 10: Run everything, smoke the real server, commit**

Run: `bunx vitest run --project server` → all pass. `bun run typecheck` passes.
Smoke: `DATA_DIR=./data bun server/index.ts` in one terminal; `curl -s http://127.0.0.1:8090/api/health` prints `{"ok":true,...}`; stop it.

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(server): workspace service, REST router with SSE, static hosting, entry point" -- advanced-typst-editor
```

---

### Task 8: Font family from the `name` table

**Files:**
- Create: `server/fonts.ts`, `server/fonts.test.ts`

**Interfaces:**
- Produces: `fontFamily(bytes: Uint8Array) -> string | null` (ttf/otf/ttc; null for woff/woff2 or anything unparsable).

- [ ] **Step 1: Write the failing test `server/fonts.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fontFamily } from './fonts';
import { OLD } from './test-util';

describe('fontFamily', () => {
  it('reads the family from OTF and TTF name tables', () => {
    expect(fontFamily(fs.readFileSync(path.join(OLD, 'fonts', 'NewCM10-Regular.otf')))).toBe('New Computer Modern');
    expect(fontFamily(fs.readFileSync(path.join(OLD, 'fonts', 'DejaVuSansMono.ttf')))).toBe('DejaVu Sans Mono');
    expect(fontFamily(fs.readFileSync(path.join(OLD, 'fonts', 'LibertinusSerif-Semibold.otf')))).toBe('Libertinus Serif');
  });
  it('returns null for garbage and truncated input', () => {
    expect(fontFamily(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(fontFamily(fs.readFileSync(path.join(OLD, 'fonts', 'DejaVuSansMono.ttf')).subarray(0, 64))).toBeNull();
  });
});
```

The Libertinus assertion expects the *typographic* family (name ID 16), which is what Typst matches for a semibold face; if the file lacks ID 16 the code falls back to ID 1. Run the test; if Libertinus reports `Libertinus Serif Semibold` under ID 1 only, keep the assertion and fix the parser to prefer ID 16.

- [ ] **Step 2: Write `server/fonts.ts`**

```ts
/**
 * Family name from an SFNT (ttf/otf/ttc) `name` table. Prefers the
 * typographic family (nameID 16) over the legacy family (nameID 1), and
 * Windows Unicode (platform 3) over Macintosh (platform 1). This is what
 * Typst matches in `#set text(font: "...")`.
 */
export function fontFamily(bytes: Uint8Array): string | null {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (o: number) => dv.getUint16(o);
    const u32 = (o: number) => dv.getUint32(o);
    const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
    let base = 0;
    if (tag(0) === 'ttcf') base = u32(12); // first face of a collection
    const magic = u32(base);
    if (magic !== 0x00010000 && tag(base) !== 'OTTO' && tag(base) !== 'true') return null;
    const numTables = u16(base + 4);
    let nameOff = -1;
    let nameLen = 0;
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + i * 16;
      if (tag(rec) === 'name') { nameOff = u32(rec + 8); nameLen = u32(rec + 12); break; }
    }
    if (nameOff < 0 || nameOff + nameLen > bytes.length) return null;
    const count = u16(nameOff + 2);
    const stringsOff = nameOff + u16(nameOff + 4);
    const candidates: Array<{ score: number; value: string }> = [];
    for (let i = 0; i < count; i++) {
      const rec = nameOff + 6 + i * 12;
      const platform = u16(rec), encoding = u16(rec + 2), language = u16(rec + 4), nameId = u16(rec + 6), length = u16(rec + 8), offset = u16(rec + 10);
      if (nameId !== 1 && nameId !== 16) continue;
      const start = stringsOff + offset;
      if (start + length > bytes.length) continue;
      const raw = bytes.subarray(start, start + length);
      let value: string;
      if (platform === 3 || (platform === 0)) {
        value = Buffer.from(raw).swap16().toString('utf16le'); // UTF-16BE
      } else if (platform === 1) {
        value = Buffer.from(raw).toString('latin1');
      } else continue;
      value = value.replace(/\0/g, '').trim();
      if (!value) continue;
      // Prefer: nameID 16, then platform 3 English (0x0409), then anything.
      const score = (nameId === 16 ? 100 : 0) + (platform === 3 ? 10 : platform === 0 ? 5 : 0) + (language === 0x0409 || language === 0 ? 1 : 0) + (encoding === 1 ? 0 : 0);
      candidates.push({ score, value });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.value ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Run, typecheck, commit**

Run: `bunx vitest run --project server server/fonts.test.ts` → pass.

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(server): font family parser" -- advanced-typst-editor
```

Then wire it in: in `server/router.ts` the upload route passes `family: url.searchParams.get('family') ?? (kind === 'font' ? fontFamily(bytes) : null)` (import `fontFamily`); in `server/workspace.ts` nothing changes. Add one assertion to `router.test.ts`: uploading `$OLD/fonts/DejaVuSansMono.ttf` with `kind=font` and no `family` yields `asset.fontFamily === 'DejaVu Sans Mono'`. Run, commit as `feat(server): parse font family on upload`.

---

### Task 9: Server-side crop/blur baking and the typst CLI driver

**Files:**
- Create: `server/bake.ts`, `server/compile.ts`, `server/bake.test.ts`, `server/compile.test.ts`
- Modify: `server/index.ts` (pass `compile`)

**Interfaces:**
- Consumes: `blurParams`, `pixelParams`, `effectiveStyle`, `hasBlurs` (`src/lib/blur-math`); `normalizeCrop`, `cropToPixels`, `outputSize`, `isFullFrame` (`src/lib/crop-math`); `formatFromFilename` (`src/lib/image-format`).
- Produces: `bakeImage(bytes, meta: AssetMeta, filename) -> Promise<Uint8Array | null>` (null = nothing to bake or unbakeable format); `createCompiler({settings, service, typstCli}) -> CompileApi` (the `CompileApi` shape from `server/router.ts`) plus `resolveTypstCli(configured, settingsValue) -> string | null` and `parseDiagnostics(stderr, root) -> Diagnostic[]`.

- [ ] **Step 1: Write the failing test `server/bake.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { Jimp } from 'jimp';
import { bakeImage } from './bake';

/** 200x100 white PNG with a 1px black/white stripe pattern in the middle 100x40 region. */
async function stripes(): Promise<Uint8Array> {
  const img = new Jimp({ width: 200, height: 100, color: 0xffffffff });
  for (let y = 30; y < 70; y++) for (let x = 50; x < 150; x++) if (x % 2 === 0) img.setPixelColor(0x000000ff, x, y);
  return new Uint8Array(await img.getBuffer('image/png'));
}
async function stats(png: Uint8Array, x0: number, y0: number, w: number, h: number) {
  const img = await Jimp.read(Buffer.from(png));
  let min = 255, max = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const v = (img.getPixelColor(x, y) >>> 24) & 0xff; // red channel
    min = Math.min(min, v); max = Math.max(max, v);
  }
  return { min, max, width: img.bitmap.width, height: img.bitmap.height };
}

describe('bakeImage', () => {
  it('returns null when there is nothing to bake', async () => {
    expect(await bakeImage(await stripes(), {}, 'a.png')).toBeNull();
    expect(await bakeImage(await stripes(), { crop: { x: 0, y: 0, w: 1, h: 1 } }, 'a.png')).toBeNull();
  });
  it('destroys detail inside a gaussian region and leaves the outside alone', async () => {
    const out = await bakeImage(await stripes(), { blurs: [{ x: 0.25, y: 0.3, w: 0.5, h: 0.4 }] }, 'a.png');
    const inside = await stats(out!, 60, 35, 80, 30);
    expect(inside.max - inside.min).toBeLessThan(60); // stripes averaged to grey
    const outside = await stats(out!, 0, 0, 40, 20);
    expect(outside.min).toBe(255);
  });
  it('pixelates into flat blocks', async () => {
    const out = await bakeImage(await stripes(), { blurs: [{ x: 0.25, y: 0.3, w: 0.5, h: 0.4, style: 'pixelate' }] }, 'a.png');
    const inside = await stats(out!, 60, 35, 6, 6);
    expect(inside.max - inside.min).toBeLessThan(8); // one block is one colour
  });
  it('crops to the output size with the placeholder grey where the image runs out', async () => {
    const out = await bakeImage(await stripes(), { crop: { x: 0.5, y: 0, w: 1, h: 0.5 } }, 'a.png');
    const s = await stats(out!, 150, 0, 40, 40); // right half of the crop is past the image edge
    expect(s.width).toBe(200); expect(s.height).toBe(50);
    expect(s.min).toBe(0xf5); expect(s.max).toBe(0xf5);
  });
  it('refuses formats jimp cannot re-encode', async () => {
    await expect(bakeImage(new Uint8Array([0]), { crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }, 'a.svg')).rejects.toThrow(/cannot be baked/);
  });
});
```

- [ ] **Step 2: Run to verify failure** → module not found.

- [ ] **Step 3: Write `server/bake.ts`**

```ts
import { Jimp, ResizeStrategy } from 'jimp';
import type { AssetMeta, BlurRegion } from '../src/types';
import { blurParams, effectiveStyle, hasBlurs, pixelParams } from '../src/lib/blur-math';
import { cropToPixels, isFullFrame, normalizeCrop, outputSize } from '../src/lib/crop-math';
import { formatFromFilename } from '../src/lib/image-format';

const GAP_FILL = 0xf5f5f5ff; // luma(245), the placeholder grey, same as the browser
const BAKEABLE = new Set(['png', 'jpeg']);

type JimpImage = Awaited<ReturnType<typeof Jimp.read>>;

function bakeBlurs(img: JimpImage, blurs: BlurRegion[]): void {
  const natW = img.bitmap.width, natH = img.bitmap.height;
  for (const region of blurs) {
    const sx = Math.round(region.x * natW), sy = Math.round(region.y * natH);
    const sw = Math.max(1, Math.min(natW - sx, Math.round(region.w * natW)));
    const sh = Math.max(1, Math.min(natH - sy, Math.round(region.h * natH)));
    if (sw <= 0 || sh <= 0) continue;
    const piece = img.clone().crop({ x: sx, y: sy, w: sw, h: sh });
    if (effectiveStyle(region) === 'pixelate') {
      const { blockPx } = pixelParams(region, natW, natH);
      const smallW = Math.max(1, Math.round(sw / blockPx)), smallH = Math.max(1, Math.round(sh / blockPx));
      piece.resize({ w: smallW, h: smallH, mode: ResizeStrategy.BILINEAR });
      piece.resize({ w: sw, h: sh, mode: ResizeStrategy.NEAREST_NEIGHBOR });
    } else {
      const { radiusPx, downscale } = blurParams(region, natW, natH);
      const smallW = Math.max(1, Math.round(sw * downscale)), smallH = Math.max(1, Math.round(sh * downscale));
      piece.resize({ w: smallW, h: smallH, mode: ResizeStrategy.BILINEAR });
      piece.resize({ w: sw, h: sh, mode: ResizeStrategy.BILINEAR });
      piece.blur(Math.max(1, Math.round(radiusPx / 2)));
    }
    img.composite(piece, sx, sy);
  }
}

/**
 * Apply the framing in `meta` to `bytes`. Returns null when there is nothing
 * to apply (no crop, no blurs). Throws for a format that cannot be re-encoded
 * (gif/webp/svg), because writing an unredacted original would be worse.
 */
export async function bakeImage(bytes: Uint8Array, meta: AssetMeta, filename: string): Promise<Uint8Array | null> {
  const wantsCrop = !!meta.crop && !isFullFrame(meta.crop);
  const wantsBlur = hasBlurs(meta.blurs);
  if (!wantsCrop && !wantsBlur) return null;
  const fmt = formatFromFilename(filename);
  if (!fmt || !BAKEABLE.has(fmt)) throw new Error(`${filename}: ${fmt ?? 'unknown'} images with crop or blur cannot be baked server-side; export from the app instead`);
  const img = await Jimp.read(Buffer.from(bytes));
  if (wantsBlur) bakeBlurs(img, meta.blurs as BlurRegion[]);
  let out = img;
  if (wantsCrop) {
    const natW = img.bitmap.width, natH = img.bitmap.height;
    const rect = normalizeCrop(meta.crop!);
    const { sx, sy, sw, sh } = cropToPixels(rect, natW, natH);
    const size = outputSize(rect, natW, natH);
    const canvas = new Jimp({ width: size.width, height: size.height, color: GAP_FILL });
    // Intersect the source rect with the image; scale the visible part into place.
    const ix0 = Math.max(0, sx), iy0 = Math.max(0, sy), ix1 = Math.min(natW, sx + sw), iy1 = Math.min(natH, sy + sh);
    if (ix1 > ix0 && iy1 > iy0) {
      const scaleX = size.width / sw, scaleY = size.height / sh;
      const visible = img.clone().crop({ x: ix0, y: iy0, w: ix1 - ix0, h: iy1 - iy0 });
      visible.resize({ w: Math.max(1, Math.round((ix1 - ix0) * scaleX)), h: Math.max(1, Math.round((iy1 - iy0) * scaleY)), mode: ResizeStrategy.BILINEAR });
      canvas.composite(visible, Math.round((ix0 - sx) * scaleX), Math.round((iy0 - sy) * scaleY));
    }
    out = canvas;
  }
  const mime = fmt === 'jpeg' ? 'image/jpeg' : 'image/png';
  return new Uint8Array(await out.getBuffer(mime));
}
```

If jimp's exported names differ from the above in the installed 1.6.x (`ResizeStrategy` lives in `jimp`; `getBuffer` takes the mime string), read `node_modules/jimp/dist/esm/index.d.ts` and adjust the calls, not the behaviour.

- [ ] **Step 4: Run the bake tests** → 5 pass. Adjust the tolerance numbers only if the stripes fixture is genuinely averaged (print `inside` once to see); never loosen below `< 100`.

- [ ] **Step 5: Write the failing test `server/compile.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createEventBus } from './events';
import { createSettingsStore } from './settings';
import { createWorkspaceService } from './service';
import { createCompiler, parseDiagnostics, resolveTypstCli } from './compile';
import { tmpDir, rmDir, put, TYPST_CLI } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });
const have = fs.existsSync(TYPST_CLI);

describe('parseDiagnostics', () => {
  it('parses the short format and relativises the path', () => {
    const root = 'C:\\ws';
    const out = parseDiagnostics('\\\\?\\C:\\ws\\main.typ:3:7: error: file not found (searched at x)\nwarning: unused\n', root);
    expect(out).toEqual([
      { severity: 'error', message: 'file not found (searched at x)', file: 'main.typ', line: 3, col: 7 },
      { severity: 'warning', message: 'unused', file: null, line: null, col: null },
    ]);
  });
});

describe('resolveTypstCli', () => {
  it('prefers the configured path, then settings, then PATH', () => {
    expect(resolveTypstCli('C:\\nope\\typst.exe', null)).not.toBe('C:\\nope\\typst.exe');
    if (have) expect(resolveTypstCli(TYPST_CLI, null)).toBe(TYPST_CLI);
  });
});

describe.skipIf(!have)('createCompiler', () => {
  function setup() {
    const dataDir = tmpDir(); dirs.push(dataDir);
    const settings = createSettingsStore(dataDir);
    const service = createWorkspaceService({ settings, bus: createEventBus(), watcher: null, dataDir, workspacesDir: path.join(dataDir, 'workspaces'), template: '' });
    const compile = createCompiler({ settings, service, typstCli: TYPST_CLI });
    return { service, compile, dataDir };
  }
  it('reports diagnostics and compiles a good document', async () => {
    const { service, compile } = setup();
    const w = service.create({ name: 'A', group: null, source: '#set page(width: 8cm)\n= Hi\n#image("/assets/missing.png")\n' });
    const bad = await compile.compile(w.id, undefined);
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics[0]).toMatchObject({ severity: 'error', file: 'main.typ', line: 3 });
    fs.writeFileSync(path.join(w.path, 'main.typ'), '= Hi\nHello');
    expect((await compile.compile(w.id, undefined)).ok).toBe(true);
  });
  it('exports a PDF with redactions baked, to bytes or to a path', async () => {
    const { service, compile, dataDir } = setup();
    const w = service.create({ name: 'B', group: null, source: '#image("/assets/shot.png", width: 5cm)' });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    put(w.path, 'assets/shot.png', png);
    service.patchAsset(w.id, 'assets/shot.png', { blurs: [{ x: 0, y: 0, w: 1, h: 1 }] }, null);
    const out = await compile.exportPdf(w.id, undefined, undefined);
    expect(out.baked).toBe(1);
    expect(Buffer.from(out.bytes!.subarray(0, 4)).toString()).toBe('%PDF');
    expect(fs.existsSync(path.join(w.path, 'assets', 'shot.png'))).toBe(true); // original untouched
    const to = path.join(dataDir, 'out.pdf');
    const saved = await compile.exportPdf(w.id, undefined, to);
    expect(saved.path).toBe(to);
    expect(fs.statSync(to).size).toBeGreaterThan(100);
  });
});
```

- [ ] **Step 6: Write `server/compile.ts`**

```ts
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CompileResult, Diagnostic } from '../src/types';
import { bakeImage } from './bake';
import { HttpError } from './http';
import { normalizeRel } from './paths';
import type { WorkspaceService } from './service';
import type { SettingsStore } from './settings';
import type { CompileApi } from './router';

const IS_WIN = process.platform === 'win32';

function onPath(name: string): string | null {
  const exts = IS_WIN ? ['.exe', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
  }
  return null;
}

/** Configured path (env) > settings.typstCli > sidecar next to this executable > PATH. */
export function resolveTypstCli(configured: string | null, fromSettings: string | null): string | null {
  const exists = (p: string | null) => (p && fs.existsSync(p) ? p : null);
  const sidecar = path.join(path.dirname(process.execPath), IS_WIN ? 'typst.exe' : 'typst');
  return exists(configured) ?? exists(fromSettings) ?? exists(sidecar) ?? onPath('typst');
}

const LINE = /^(?:\\\\\?\\)?(.+?):(\d+):(\d+): (error|warning): (.*)$/;

export function parseDiagnostics(stderr: string, root: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const rootAbs = path.resolve(root).replace(/^\\\\\?\\/, '');
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = LINE.exec(line);
    if (m) {
      const abs = m[1]!.replace(/^\\\\\?\\/, '');
      const rel = path.isAbsolute(abs) ? path.relative(rootAbs, abs).split(path.sep).join('/') : abs.replace(/\\/g, '/');
      out.push({ severity: m[4] as Diagnostic['severity'], message: m[5]!, file: rel.startsWith('..') ? abs : rel, line: Number(m[2]), col: Number(m[3]) });
      continue;
    }
    const plain = /^(error|warning): (.*)$/.exec(line);
    if (plain) out.push({ severity: plain[1] as Diagnostic['severity'], message: plain[2]!, file: null, line: null, col: null });
  }
  return out;
}

function run(cli: string, args: string[], cwd: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cli, args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stderr: String(stderr ?? '') });
    });
  });
}

export function createCompiler(deps: { settings: SettingsStore; service: WorkspaceService; typstCli: string | null }): CompileApi {
  const cli = () => resolveTypstCli(deps.typstCli, deps.settings.get().typstCli);
  const require = () => { const c = cli(); if (!c) throw new HttpError(409, 'typst CLI not found: set TYPST_CLI or Settings > Typst CLI'); return c; };

  const compileAt = async (root: string, file: string, outPdf: string): Promise<CompileResult> => {
    const fontDir = path.join(root, 'fonts');
    const args = ['compile', '--root', root, '--ignore-system-fonts', '--diagnostic-format', 'short'];
    if (fs.existsSync(fontDir)) args.push('--font-path', fontDir);
    args.push(path.join(root, ...file.split('/')), outPdf);
    const { code, stderr } = await run(require(), args, root);
    const diagnostics = parseDiagnostics(stderr, root);
    return { ok: code === 0 && !diagnostics.some((d) => d.severity === 'error'), diagnostics };
  };

  const entryFile = (file: string | undefined): string => {
    const f = normalizeRel(file ?? 'main.typ');
    if (!f || !f.endsWith('.typ')) throw new HttpError(400, 'file must be a .typ path inside the workspace');
    return f;
  };

  return {
    available: cli,
    async compile(workspaceId, file) {
      const ws = deps.service.fs(workspaceId);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tfs-compile-'));
      try { return await compileAt(ws.root, entryFile(file), path.join(tmp, 'out.pdf')); }
      finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    },
    async exportPdf(workspaceId, file, to) {
      const ws = deps.service.fs(workspaceId);
      const f = entryFile(file);
      const meta = ws.readMeta();
      const framed = Object.entries(meta.assets).filter(([, m]) => (m.crop && !(m.crop.x === 0 && m.crop.y === 0 && m.crop.w === 1 && m.crop.h === 1)) || (m.blurs && m.blurs.length > 0));
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tfs-export-'));
      try {
        let root = ws.root;
        let baked = 0;
        if (framed.length > 0) {
          root = path.join(tmp, 'ws');
          fs.cpSync(ws.root, root, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(src) });
          for (const [id, m] of framed) {
            const abs = path.join(root, ...id.split('/'));
            if (!fs.existsSync(abs)) continue;
            const out = await bakeImage(new Uint8Array(fs.readFileSync(abs)), m, id);
            if (out) { fs.writeFileSync(abs, out); baked += 1; }
          }
        }
        const outPdf = path.join(tmp, 'out.pdf');
        const res = await compileAt(root, f, outPdf);
        if (!res.ok) {
          const first = res.diagnostics.find((d) => d.severity === 'error');
          throw new HttpError(422, first ? `Typst error at ${first.file ?? '?'}:${first.line ?? '?'}: ${first.message}` : 'document has errors');
        }
        const bytes = new Uint8Array(fs.readFileSync(outPdf));
        if (to) {
          if (!path.isAbsolute(to) || !fs.existsSync(path.dirname(to))) throw new HttpError(400, 'to must be an absolute path in an existing folder');
          fs.writeFileSync(to, bytes);
          return { path: to, bytes: null, baked };
        }
        return { path: null, bytes, baked };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
}
```

- [ ] **Step 7: Wire into `server/index.ts`**

```ts
import { createCompiler } from './compile';
// ...
const compile = createCompiler({ settings, service, typstCli: config.typstCli });
// pass `compile` instead of null to createHandler
```

- [ ] **Step 8: Run, typecheck, commit**

Run: `bunx vitest run --project server` → all pass (compile tests take a few seconds).

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(server): typst CLI compile and PDF export with server-side redaction baking" -- advanced-typst-editor
```

---

### Task 10: Mirror backup: plan and reconcile

**Files:**
- Create: `server/backup/mirror.ts`, `server/backup/mirror.test.ts`

**Interfaces:**
- Consumes: `safeDirName`, `stamp` (Task 3), `FileEntry`, `WorkspaceEntry`.
- Produces: `MARKER_FILE`, `MirrorItem { entry: WorkspaceEntry; files: FileEntry[] }`, `planMirror(items) -> MirrorPlan { dirs: string[]; files: MirrorFile[]; dirOf: Map<string /*workspace id*/, string> }`, `MirrorFile { path: string; source: { root: string; rel: string } | { text: string } }`, `claimable(dir) -> boolean`, `runMirror(dest, plan, {now?, log?}) -> { written: number; trashed: number }`.

- [ ] **Step 1: Write the failing test `server/backup/mirror.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { WorkspaceEntry } from '../../src/types';
import { openWorkspace } from '../workspace';
import { tmpDir, rmDir, put } from '../test-util';
import { MARKER_FILE, claimable, planMirror, runMirror, type MirrorItem } from './mirror';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

function entry(name: string, group: string | null, root: string, id = name): WorkspaceEntry {
  return { id, name, group, path: root, library: true, createdAt: 1, openedAt: 1 };
}
function item(name: string, group: string | null, files: Record<string, string>, id = name): MirrorItem {
  const root = tmpDir(); dirs.push(root);
  for (const [rel, text] of Object.entries(files)) put(root, rel, text);
  return { entry: entry(name, group, root, id), files: openWorkspace(root).listFiles() };
}

describe('planMirror', () => {
  it('lays out groups, loose workspaces, and unique names', () => {
    const plan = planMirror([
      item('Report', 'CPTC', { 'main.typ': 'a', 'assets/x.png': 'b', 'workspace.json': '{}' }),
      item('Report', 'CPTC', { 'main.typ': 'c' }, 'second'),
      item('Loose: one?', null, { 'main.typ': 'd' }),
      item('_trash', null, { 'main.typ': 'e' }, 'reserved'),
    ]);
    const paths = plan.files.map((f) => f.path).sort();
    expect(paths).toEqual(['CPTC/Report (2)/main.typ', 'CPTC/Report/assets/x.png', 'CPTC/Report/main.typ', 'CPTC/Report/workspace.json', 'Loose_ one_/main.typ', 'README.txt', '_trash (2)/main.typ']);
    expect(plan.dirOf.get('second')).toBe('CPTC/Report (2)');
    expect(plan.dirs).toContain('CPTC');
  });
});

describe('runMirror', () => {
  it('refuses a folder with foreign files, accepts empty or marked ones', () => {
    const dest = tmpDir(); dirs.push(dest);
    expect(claimable(dest)).toBe(true);
    put(dest, 'notes.txt', 'mine');
    expect(claimable(dest)).toBe(false);
    fs.unlinkSync(path.join(dest, 'notes.txt'));
    put(dest, MARKER_FILE, '{}');
    put(dest, 'anything.txt', 'x');
    expect(claimable(dest)).toBe(true);
  });

  it('writes, skips identical bytes, trashes stale files, keeps snapshots/', () => {
    const dest = tmpDir(); dirs.push(dest);
    const a = item('A', null, { 'main.typ': 'one', 'assets/p.png': 'img' });
    let plan = planMirror([a]);
    const first = runMirror(dest, plan, { now: () => 1000 });
    expect(first.written).toBe(3); // main.typ, assets/p.png, README.txt
    expect(fs.existsSync(path.join(dest, MARKER_FILE))).toBe(true);
    expect(runMirror(dest, plan, { now: () => 2000 }).written).toBe(0);

    put(dest, 'snapshots/keep.zip', 'zip');
    put(dest, 'A/stale.txt', 'old');
    fs.writeFileSync(path.join(a.entry.path, 'main.typ'), 'two');
    a.files = openWorkspace(a.entry.path).listFiles();
    plan = planMirror([a]);
    const second = runMirror(dest, plan, { now: () => 3000 });
    expect(second.written).toBe(1);
    expect(second.trashed).toBe(1);
    expect(fs.readFileSync(path.join(dest, 'A', 'main.typ'), 'utf8')).toBe('two');
    expect(fs.existsSync(path.join(dest, 'snapshots', 'keep.zip'))).toBe(true);
    const trash = fs.readdirSync(path.join(dest, '_trash'));
    expect(fs.existsSync(path.join(dest, '_trash', trash[0]!, 'A', 'stale.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'A', 'stale.txt'))).toBe(false);
  });

  it('throws on an unclaimable destination', () => {
    const dest = tmpDir(); dirs.push(dest);
    put(dest, 'photo.jpg', 'x');
    expect(() => runMirror(dest, planMirror([]), {})).toThrow(/already has files/);
  });
});
```

- [ ] **Step 2: Run to verify failure** → module not found.

- [ ] **Step 3: Write `server/backup/mirror.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { FileEntry, WorkspaceEntry } from '../../src/types';
import { safeDirName, stamp } from '../fsx';
import { HttpError } from '../http';

export const MARKER_FILE = '.typst-studio-backup.json';
export const TRASH_DIR = '_trash';
export const SNAPSHOTS_DIR = 'snapshots';
const RESERVED = new Set([TRASH_DIR.toLowerCase(), SNAPSHOTS_DIR.toLowerCase(), MARKER_FILE.toLowerCase(), 'readme.txt']);

export interface MirrorItem { entry: WorkspaceEntry; files: FileEntry[] }
export interface MirrorFile { path: string; source: { root: string; rel: string } | { text: string } }
export interface MirrorPlan { dirs: string[]; files: MirrorFile[]; dirOf: Map<string, string> }

function uniqueNames<T>(items: T[], nameOf: (t: T) => string, taken: Set<string>): Map<T, string> {
  const out = new Map<T, string>();
  for (const it of items) {
    const base = safeDirName(nameOf(it));
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})`;
    taken.add(candidate.toLowerCase());
    out.set(it, candidate);
  }
  return out;
}

function readme(groups: number, workspaces: number): string {
  return [
    'Typst Studio backup (mirror).',
    '',
    'This folder is rewritten automatically whenever a workspace changes. Every',
    'workspace is a folder holding main.typ, assets/, fonts/ and workspace.json,',
    'grouped by the groups you made in the app. Loose workspaces sit at the top level.',
    '',
    `${groups} group${groups === 1 ? '' : 's'}, ${workspaces} workspace${workspaces === 1 ? '' : 's'}.`,
    '',
    'Images here are the ORIGINAL uploads. Crop and blur are applied by the app when',
    'it renders, so redactions are NOT baked into these files; workspace.json records',
    'them. Treat this folder as sensitive, or export a PDF from the app.',
    '',
    `Nothing here is ever deleted. Stale files move to ${TRASH_DIR}/<timestamp>/.`,
    `Timed snapshots live in ${SNAPSHOTS_DIR}/.`,
    '',
    'Compile any workspace with the Typst CLI from its folder:',
    '    typst compile --root . --font-path fonts main.typ',
    '',
  ].join('\n');
}

export function planMirror(items: MirrorItem[]): MirrorPlan {
  const taken = new Set<string>(RESERVED);
  const sorted = [...items].sort((a, b) => a.entry.createdAt - b.entry.createdAt || a.entry.id.localeCompare(b.entry.id));
  const groups = [...new Set(sorted.map((i) => i.entry.group).filter((g): g is string => !!g))].sort();
  const groupDirs = uniqueNames(groups, (g) => g, taken);
  const loose = sorted.filter((i) => !i.entry.group);
  const looseDirs = uniqueNames(loose, (i) => i.entry.name, taken);
  const dirs: string[] = [...groupDirs.values()];
  const files: MirrorFile[] = [];
  const dirOf = new Map<string, string>();
  const emit = (it: MirrorItem, dir: string) => {
    dirs.push(dir);
    dirOf.set(it.entry.id, dir);
    for (const f of it.files) files.push({ path: `${dir}/${f.path}`, source: { root: it.entry.path, rel: f.path } });
    if (fs.existsSync(path.join(it.entry.path, 'workspace.json'))) files.push({ path: `${dir}/workspace.json`, source: { root: it.entry.path, rel: 'workspace.json' } });
  };
  for (const it of loose) emit(it, looseDirs.get(it)!);
  for (const g of groups) {
    const members = sorted.filter((i) => i.entry.group === g);
    const memberDirs = uniqueNames(members, (i) => i.entry.name, new Set());
    for (const it of members) emit(it, `${groupDirs.get(g)!}/${memberDirs.get(it)!}`);
  }
  files.push({ path: 'README.txt', source: { text: readme(groups.length, items.length) } });
  return { dirs, files, dirOf };
}

/** Ours to reconcile: missing, empty, or carrying the marker. */
export function claimable(dir: string): boolean {
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return true; }
  return entries.length === 0 || entries.includes(MARKER_FILE);
}

export function runMirror(dest: string, plan: MirrorPlan, opts: { now?: () => number; log?: (...a: unknown[]) => void } = {}): { written: number; trashed: number } {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? ((...a: unknown[]) => console.error('[mirror]', ...a));
  if (!claimable(dest)) throw new HttpError(409, `${dest} already has files this app did not write; pick an empty folder or one used for a previous backup`);
  fs.mkdirSync(dest, { recursive: true });

  const expectedFiles = new Set(plan.files.map((f) => f.path));
  const expectedDirs = new Set(plan.dirs);
  const keepAtRoot = new Set([TRASH_DIR, SNAPSHOTS_DIR, MARKER_FILE]);
  const trashStamp = stamp(now());
  let trashed = 0;
  const moveToTrash = (rel: string) => {
    const from = path.join(dest, ...rel.split('/'));
    const to = path.join(dest, TRASH_DIR, trashStamp, ...rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try { fs.renameSync(from, to); trashed += 1; } catch (err) { log(`could not move ${rel} to ${TRASH_DIR}:`, err instanceof Error ? err.message : err); }
  };
  const walk = (rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(rel ? path.join(dest, ...rel.split('/')) : dest, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && keepAtRoot.has(e.name)) continue;
      if (e.isDirectory()) {
        if (expectedDirs.has(child) || plan.files.some((f) => f.path.startsWith(`${child}/`))) walk(child);
        else moveToTrash(child);
      } else if (!expectedFiles.has(child)) moveToTrash(child);
    }
  };
  walk('');

  let written = 0;
  for (const f of plan.files) {
    const target = path.join(dest, ...f.path.split('/'));
    let bytes: Buffer;
    if ('text' in f.source) bytes = Buffer.from(f.source.text, 'utf8');
    else { try { bytes = fs.readFileSync(path.join(f.source.root, ...f.source.rel.split('/'))); } catch { continue; } }
    try { const existing = fs.readFileSync(target); if (existing.equals(bytes)) continue; } catch { /* new */ }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    written += 1;
  }
  fs.writeFileSync(path.join(dest, MARKER_FILE), `${JSON.stringify({ app: 'typst-studio', writtenAt: now(), workspaces: plan.dirOf.size }, null, 2)}\n`);
  return { written, trashed };
}
```

- [ ] **Step 4: Run, typecheck, commit**

Run: `bunx vitest run --project server server/backup/mirror.test.ts` → 4 pass.

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(server): mirror backup plan and reconcile" -- advanced-typst-editor
```

---

### Task 11: Snapshots: write, list, prune, digest, restore

**Files:**
- Create: `server/backup/snapshot.ts`, `server/backup/snapshot.test.ts`

**Interfaces:**
- Consumes: `planMirror` (Task 10, for the zip layout), `fflate` (`zipSync`, `unzipSync`), `SettingsStore`.
- Produces: `snapshotName(now) -> 'typst-snapshot-YYYYMMDD-HHMMSS.zip'`, `stateDigest(items) -> string`, `buildSnapshot(items, {now, version}) -> { zip: Uint8Array; manifest: Manifest }`, `writeSnapshot(dest, items, opts) -> SnapshotInfo`, `listSnapshots(dest, destinationId) -> SnapshotInfo[]`, `pruneSnapshots(dest, keep) -> number`, `restoreSnapshot({ zipPath, dataDir, workspacesDir, settings, now }) -> { restored: number }`.

- [ ] **Step 1: Write the failing test `server/backup/snapshot.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { WorkspaceEntry } from '../../src/types';
import { createSettingsStore } from '../settings';
import { openWorkspace } from '../workspace';
import { tmpDir, rmDir, put } from '../test-util';
import { buildSnapshot, listSnapshots, pruneSnapshots, restoreSnapshot, snapshotName, stateDigest, writeSnapshot, type MirrorItem } from './snapshot';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

function item(name: string, group: string | null, files: Record<string, string>, library = true): MirrorItem {
  const root = tmpDir(); dirs.push(root);
  for (const [rel, text] of Object.entries(files)) put(root, rel, text);
  const entry: WorkspaceEntry = { id: name, name, group, path: root, library, createdAt: 1, openedAt: 1 };
  return { entry, files: openWorkspace(root).listFiles() };
}

describe('snapshots', () => {
  it('names by timestamp and digests state', () => {
    expect(snapshotName(Date.UTC(2026, 8, 3, 1, 2, 3))).toBe('typst-snapshot-20260903-010203.zip');
    const a = item('A', null, { 'main.typ': 'x' });
    const d1 = stateDigest([a]);
    fs.writeFileSync(path.join(a.entry.path, 'main.typ'), 'xy');
    a.files = openWorkspace(a.entry.path).listFiles();
    expect(stateDigest([a])).not.toBe(d1);
  });

  it('builds a zip with a manifest and checksums', () => {
    const { zip, manifest } = buildSnapshot([item('A', 'G', { 'main.typ': 'hello', 'workspace.json': '{}' })], { now: 5, version: '0.1.0' });
    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual(['G/A/main.typ', 'G/A/workspace.json', 'manifest.json']);
    expect(manifest.workspaces[0]).toMatchObject({ name: 'A', group: 'G', dir: 'G/A', library: true });
    expect(manifest.workspaces[0]!.files.find((f) => f.path === 'main.typ')!.sha256).toHaveLength(64);
  });

  it('writes, lists newest first, prunes', () => {
    const dest = tmpDir(); dirs.push(dest);
    const a = item('A', null, { 'main.typ': 'x' });
    for (let i = 0; i < 3; i++) writeSnapshot(dest, [a], { now: Date.UTC(2026, 0, 1, 0, 0, i), version: '0.1.0', destinationId: 'd1' });
    const list = listSnapshots(dest, 'd1');
    expect(list.map((s) => s.name)).toEqual(['typst-snapshot-20260101-000002.zip', 'typst-snapshot-20260101-000001.zip', 'typst-snapshot-20260101-000000.zip']);
    expect(list[0]).toMatchObject({ destinationId: 'd1', workspaces: 1 });
    expect(pruneSnapshots(dest, 2)).toBe(1);
    expect(listSnapshots(dest, 'd1')).toHaveLength(2);
  });

  it('restores library workspaces in place and external ones beside them, keeping a pre-restore copy', async () => {
    const dest = tmpDir(); dirs.push(dest);
    const dataDir = tmpDir(); dirs.push(dataDir);
    const workspacesDir = path.join(dataDir, 'workspaces');
    const settings = createSettingsStore(dataDir);
    const lib = item('Lib', null, { 'main.typ': 'from snapshot' });
    const ext = item('Ext', 'G', { 'main.typ': 'ext' }, false);
    const info = writeSnapshot(dest, [lib, ext], { now: 1000, version: '0.1.0', destinationId: 'd1' });
    // current state differs from the snapshot
    put(workspacesDir, 'Lib/main.typ', 'current');
    settings.addWorkspace({ path: path.join(workspacesDir, 'Lib'), name: 'Lib', group: null, library: true });
    const r = await restoreSnapshot({ zipPath: path.join(dest, 'snapshots', info.name), dataDir, workspacesDir, settings, now: () => 2000 });
    expect(r.restored).toBe(2);
    expect(fs.readFileSync(path.join(workspacesDir, 'Lib', 'main.typ'), 'utf8')).toBe('from snapshot');
    const pre = fs.readdirSync(dataDir).find((n) => n.startsWith('pre-restore-'))!;
    expect(fs.readFileSync(path.join(dataDir, pre, 'Lib', 'main.typ'), 'utf8')).toBe('current');
    const restoredDir = fs.readdirSync(workspacesDir).find((n) => n.startsWith('restored-'))!;
    expect(fs.readFileSync(path.join(workspacesDir, restoredDir, 'Ext', 'main.typ'), 'utf8')).toBe('ext');
    expect(settings.listWorkspaces().map((w) => w.name).sort()).toEqual(['Ext', 'Lib']);
    expect(settings.listWorkspaces().find((w) => w.name === 'Ext')).toMatchObject({ group: 'G', library: true });
  });

  it('refuses a zip whose checksums do not match', async () => {
    const dest = tmpDir(); dirs.push(dest);
    const dataDir = tmpDir(); dirs.push(dataDir);
    const info = writeSnapshot(dest, [item('A', null, { 'main.typ': 'x' })], { now: 1, version: '0.1.0', destinationId: 'd1' });
    const zipPath = path.join(dest, 'snapshots', info.name);
    const raw = unzipSync(fs.readFileSync(zipPath));
    raw['A/main.typ'] = new TextEncoder().encode('tampered');
    const { zipSync } = await import('fflate');
    fs.writeFileSync(zipPath, zipSync(raw));
    await expect(restoreSnapshot({ zipPath, dataDir, workspacesDir: path.join(dataDir, 'workspaces'), settings: createSettingsStore(dataDir), now: () => 1 })).rejects.toThrow(/checksum/);
  });
});
```

- [ ] **Step 2: Run to verify failure** → module not found.

- [ ] **Step 3: Write `server/backup/snapshot.ts`**

```ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import type { SnapshotInfo, WorkspaceEntry } from '../../src/types';
import { ensureDir, safeDirName, stamp, uniqueDirName } from '../fsx';
import { HttpError } from '../http';
import type { SettingsStore } from '../settings';
import { planMirror, SNAPSHOTS_DIR, type MirrorItem } from './mirror';

export type { MirrorItem };

export interface ManifestFile { path: string; size: number; sha256: string }
export interface ManifestWorkspace { id: string; name: string; group: string | null; library: boolean; dir: string; files: ManifestFile[] }
export interface Manifest { app: 'typst-studio'; version: string; createdAt: number; workspaces: ManifestWorkspace[] }

const NAME_RE = /^typst-snapshot-(\d{8})-(\d{6})\.zip$/;

export function snapshotName(now: number): string {
  const d = new Date(now);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `typst-snapshot-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.zip`;
}

/** Cheap fingerprint of every workspace's file list (path, size, mtime): changes whenever anything changed. */
export function stateDigest(items: MirrorItem[]): string {
  const h = crypto.createHash('sha256');
  for (const it of [...items].sort((a, b) => a.entry.id.localeCompare(b.entry.id))) {
    h.update(`${it.entry.id}|${it.entry.name}|${it.entry.group ?? ''}\n`);
    for (const f of [...it.files].sort((a, b) => a.path.localeCompare(b.path))) h.update(`${f.path}|${f.size}|${f.mtime}\n`);
    try { const st = fs.statSync(path.join(it.entry.path, 'workspace.json')); h.update(`workspace.json|${st.size}|${Math.round(st.mtimeMs)}\n`); } catch { /* none */ }
  }
  return h.digest('hex');
}

const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const STORE_ONLY = /\.(png|jpe?g|gif|webp|woff2?|ttf|otf|ttc|zip|pdf)$/i;

export function buildSnapshot(items: MirrorItem[], opts: { now: number; version: string }): { zip: Uint8Array; manifest: Manifest } {
  const plan = planMirror(items);
  const zippable: Zippable = {};
  const manifest: Manifest = { app: 'typst-studio', version: opts.version, createdAt: opts.now, workspaces: [] };
  for (const it of items) {
    const dir = plan.dirOf.get(it.entry.id);
    if (!dir) continue;
    const files: ManifestFile[] = [];
    const rels = it.files.map((f) => f.path);
    if (fs.existsSync(path.join(it.entry.path, 'workspace.json'))) rels.push('workspace.json');
    for (const rel of rels) {
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(fs.readFileSync(path.join(it.entry.path, ...rel.split('/')))); } catch { continue; }
      zippable[`${dir}/${rel}`] = [bytes, { level: STORE_ONLY.test(rel) ? 0 : 6 }];
      files.push({ path: rel, size: bytes.length, sha256: sha256(bytes) });
    }
    manifest.workspaces.push({ id: it.entry.id, name: it.entry.name, group: it.entry.group, library: it.entry.library, dir, files });
  }
  zippable['manifest.json'] = [new TextEncoder().encode(JSON.stringify(manifest, null, 2)), { level: 6 }];
  return { zip: zipSync(zippable), manifest };
}

export function writeSnapshot(dest: string, items: MirrorItem[], opts: { now: number; version: string; destinationId: string }): SnapshotInfo {
  const dir = path.join(dest, SNAPSHOTS_DIR);
  ensureDir(dir);
  const name = snapshotName(opts.now);
  const { zip, manifest } = buildSnapshot(items, opts);
  const tmp = path.join(dir, `${name}.tmp`);
  fs.writeFileSync(tmp, zip);
  fs.renameSync(tmp, path.join(dir, name));
  return { destinationId: opts.destinationId, name, createdAt: opts.now, bytes: zip.length, workspaces: manifest.workspaces.length };
}

export function listSnapshots(dest: string, destinationId: string): SnapshotInfo[] {
  const dir = path.join(dest, SNAPSHOTS_DIR);
  let names: string[];
  try { names = fs.readdirSync(dir).filter((n) => NAME_RE.test(n)); } catch { return []; }
  const out: SnapshotInfo[] = [];
  for (const name of names) {
    const m = NAME_RE.exec(name)!;
    const d = m[1]!, t = m[2]!;
    const createdAt = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6));
    let bytes = 0, workspaces = 0;
    try {
      const st = fs.statSync(path.join(dir, name)); bytes = st.size;
      const entries = unzipSync(fs.readFileSync(path.join(dir, name)), { filter: (f) => f.name === 'manifest.json' });
      const man = entries['manifest.json'];
      if (man) workspaces = (JSON.parse(new TextDecoder().decode(man)) as Manifest).workspaces.length;
    } catch { /* unreadable: still listed */ }
    out.push({ destinationId, name, createdAt, bytes, workspaces });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function pruneSnapshots(dest: string, keep: number): number {
  const list = listSnapshots(dest, '');
  let removed = 0;
  for (const s of list.slice(Math.max(1, keep))) {
    try { fs.unlinkSync(path.join(dest, SNAPSHOTS_DIR, s.name)); removed += 1; } catch { /* ignore */ }
  }
  return removed;
}

export async function restoreSnapshot(deps: { zipPath: string; dataDir: string; workspacesDir: string; settings: SettingsStore; now: () => number }): Promise<{ restored: number }> {
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(fs.readFileSync(deps.zipPath)); } catch { throw new HttpError(400, 'snapshot is not a readable zip'); }
  const manRaw = entries['manifest.json'];
  if (!manRaw) throw new HttpError(400, 'snapshot has no manifest.json');
  const manifest = JSON.parse(new TextDecoder().decode(manRaw)) as Manifest;
  if (manifest.app !== 'typst-studio') throw new HttpError(400, 'not a Typst Studio snapshot');
  for (const w of manifest.workspaces) for (const f of w.files) {
    const bytes = entries[`${w.dir}/${f.path}`];
    if (!bytes || sha256(bytes) !== f.sha256) throw new HttpError(400, `checksum mismatch for ${w.dir}/${f.path}; the snapshot is damaged`);
  }
  const t = stamp(deps.now());
  ensureDir(deps.workspacesDir);
  const pre = path.join(deps.dataDir, `pre-restore-${t}`);
  fs.cpSync(deps.workspacesDir, pre, { recursive: true });
  let restoredRoot: string | null = null;
  let restored = 0;
  for (const w of manifest.workspaces) {
    const base = safeDirName(w.name);
    let target: string;
    if (w.library) {
      const existing = deps.settings.listWorkspaces().find((e) => e.library && e.name === w.name);
      target = existing?.path ?? path.join(deps.workspacesDir, uniqueDirName(deps.workspacesDir, base));
    } else {
      restoredRoot ??= path.join(deps.workspacesDir, `restored-${t}`);
      target = path.join(restoredRoot, uniqueDirName(restoredRoot, base));
    }
    ensureDir(target);
    for (const f of w.files) {
      const abs = path.join(target, ...f.path.split('/'));
      ensureDir(path.dirname(abs));
      fs.writeFileSync(abs, entries[`${w.dir}/${f.path}`]!);
    }
    if (!deps.settings.findByPath(target)) deps.settings.addWorkspace({ path: target, name: w.name, group: w.group, library: true });
    restored += 1;
  }
  return { restored };
}
```

- [ ] **Step 4: Run, typecheck, commit**

Run: `bunx vitest run --project server server/backup/snapshot.test.ts` → 5 pass.

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(server): zip snapshots with manifest, prune and verified restore" -- advanced-typst-editor
```

---

### Task 12: Backup destinations, scheduling, folder browser, wiring

**Files:**
- Create: `server/backup/index.ts`, `server/fs-browse.ts`, `server/backup/index.test.ts`, `server/fs-browse.test.ts`
- Modify: `server/index.ts` (pass `backup` and `browse`), `server/router.test.ts` (backup routes)

**Interfaces:**
- Consumes: Tasks 10 and 11, `WorkspaceService`, `EventBus`, `SettingsStore`.
- Produces: `createBackup(deps) -> Backup` implementing `BackupApi` from `server/router.ts` plus `start()`, `stop()`, `schedule()`; `browse(p: string) -> DirListing`.

- [ ] **Step 1: Write the failing test `server/fs-browse.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { browse } from './fs-browse';
import { MARKER_FILE } from './backup/mirror';
import { tmpDir, rmDir, put } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

describe('browse', () => {
  it('lists drives at the root', () => {
    const root = browse('');
    expect(root.path).toBe('');
    expect(root.parent).toBeNull();
    expect(root.entries.some((e) => /^[A-Z]:\\$/.test(e.path))).toBe(true);
  });
  it('lists subdirectories with emptiness and marker flags, skipping hidden', () => {
    const d = tmpDir(); dirs.push(d);
    fs.mkdirSync(path.join(d, 'empty'));
    put(d, 'used/x.txt', 'x');
    put(d, `ours/${MARKER_FILE}`, '{}');
    fs.mkdirSync(path.join(d, '.hidden'));
    put(d, 'file.txt', 'not a dir');
    const l = browse(d);
    expect(l.parent).toBe(path.dirname(d));
    expect(l.entries.map((e) => [e.name, e.isEmpty, e.isBackupRoot])).toEqual([['empty', true, false], ['ours', false, true], ['used', false, false]]);
    expect(() => browse('relative/path')).toThrow(/absolute/);
    expect(() => browse(path.join(d, 'nope'))).toThrow(/no such folder/);
  });
});
```

- [ ] **Step 2: Write `server/fs-browse.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { DirEntry, DirListing } from '../src/types';
import { MARKER_FILE } from './backup/mirror';
import { HttpError } from './http';

function drives(): DirEntry[] {
  if (process.platform !== 'win32') return [{ name: '/', path: '/', isEmpty: false, isBackupRoot: false }];
  const out: DirEntry[] = [];
  for (let c = 65; c <= 90; c++) {
    const p = `${String.fromCharCode(c)}:\\`;
    try { if (fs.statSync(p).isDirectory()) out.push({ name: p.slice(0, 2), path: p, isEmpty: false, isBackupRoot: false }); } catch { /* no such drive */ }
  }
  return out;
}

export function browse(p: string): DirListing {
  if (!p) return { path: '', parent: null, entries: drives() };
  if (!path.isAbsolute(p) || p.includes('\0')) throw new HttpError(400, 'path must be absolute');
  const abs = path.resolve(p);
  let dirents: fs.Dirent[];
  try { dirents = fs.readdirSync(abs, { withFileTypes: true }); } catch { throw new HttpError(404, 'no such folder'); }
  const entries: DirEntry[] = [];
  for (const d of dirents) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name.startsWith('$')) continue;
    const child = path.join(abs, d.name);
    let children: string[];
    try { children = fs.readdirSync(child); } catch { continue; }
    entries.push({ name: d.name, path: child, isEmpty: children.length === 0, isBackupRoot: children.includes(MARKER_FILE) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? '' : parent, entries };
}
```

Note: at a drive root (`C:\`) `path.dirname` returns itself, so `parent` becomes `''` (the drives list).

- [ ] **Step 3: Write the failing test `server/backup/index.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerEvent } from '../../src/types';
import { createEventBus } from '../events';
import { createSettingsStore } from '../settings';
import { createWorkspaceService } from '../service';
import { tmpDir, rmDir, put } from '../test-util';
import { createBackup } from './index';
import { MARKER_FILE } from './mirror';

const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => { for (const s of stops.splice(0)) s(); for (const d of dirs.splice(0)) rmDir(d); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(clock = { t: 1_000_000 }) {
  const dataDir = tmpDir(); dirs.push(dataDir);
  const bus = createEventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const settings = createSettingsStore(dataDir);
  const now = () => clock.t;
  const service = createWorkspaceService({ settings, bus, watcher: null, dataDir, workspacesDir: path.join(dataDir, 'workspaces'), template: '= T', now });
  const backup = createBackup({ settings, service, bus, dataDir, workspacesDir: path.join(dataDir, 'workspaces'), now, version: '0.1.0', quietMs: 50, maxWaitMs: 200 });
  stops.push(() => backup.stop());
  return { dataDir, bus, events, settings, service, backup, clock };
}

describe('backup', () => {
  it('validates destinations: absolute, claimable', () => {
    const { backup } = setup();
    const dest = tmpDir(); dirs.push(dest);
    expect(() => backup.configure({ destinations: [{ path: 'relative', mirror: true, snapshots: true }] })).toThrow(/absolute/);
    put(dest, 'photo.jpg', 'x');
    expect(() => backup.configure({ destinations: [{ path: dest, mirror: true, snapshots: true }] })).toThrow(/already has files/);
    fs.unlinkSync(path.join(dest, 'photo.jpg'));
    const s = backup.configure({ destinations: [{ path: dest, mirror: true, snapshots: false }], snapshotIntervalMin: 5, keepSnapshots: 3 });
    expect(s.destinations[0]).toMatchObject({ path: path.resolve(dest), mirror: true, snapshots: false });
    expect(s.destinations[0]!.id).toBeTruthy();
    expect(s.snapshotIntervalMin).toBe(5);
    expect(fs.existsSync(path.join(dest, MARKER_FILE))).toBe(false); // nothing runs until scheduled
  });

  it('mirrors after writes settle and snapshots on run()', async () => {
    const { backup, service, events } = setup();
    const dest = tmpDir(); dirs.push(dest);
    backup.configure({ destinations: [{ path: dest, mirror: true, snapshots: true }] });
    backup.start();
    const w = service.create({ name: 'Rep', group: 'G', source: '= one' });
    service.writeFile(w.id, 'main.typ', Buffer.from('= two'), 'c');
    await sleep(400);
    expect(fs.readFileSync(path.join(dest, 'G', 'Rep', 'main.typ'), 'utf8')).toBe('= two');
    expect(backup.state().lastMirrorFiles).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dest, 'snapshots'))).toBe(false); // interval not due yet
    const s = await backup.run();
    expect(s.lastSnapshotAt).not.toBeNull();
    expect(backup.listSnapshots(s.destinations[0]!.id)).toHaveLength(1);
    expect(events.some((e) => e.type === 'backup.state')).toBe(true);
  });

  it('takes a timed snapshot only when the state changed', async () => {
    const { backup, service, clock } = setup();
    const dest = tmpDir(); dirs.push(dest);
    backup.configure({ destinations: [{ path: dest, mirror: false, snapshots: true }], snapshotIntervalMin: 1 });
    backup.start();
    service.create({ name: 'A', group: null, source: '= a' });
    await sleep(300);
    const id = backup.state().destinations[0]!.id;
    expect(backup.listSnapshots(id)).toHaveLength(1); // first ever snapshot is immediate
    clock.t += 61_000;
    await backup.tick();
    expect(backup.listSnapshots(id)).toHaveLength(1); // nothing changed
    fs.writeFileSync(path.join(service.list()[0]!.path, 'main.typ'), '= b');
    clock.t += 61_000;
    await backup.tick();
    expect(backup.listSnapshots(id)).toHaveLength(2);
  });

  it('restores through a destination and reports the count', async () => {
    const { backup, service, dataDir } = setup();
    const dest = tmpDir(); dirs.push(dest);
    backup.configure({ destinations: [{ path: dest, mirror: false, snapshots: true }] });
    const w = service.create({ name: 'A', group: null, source: '= snap' });
    const s = await backup.run();
    fs.writeFileSync(path.join(w.path, 'main.typ'), '= later');
    const r = await backup.restore(s.destinations[0]!.id, backup.listSnapshots(s.destinations[0]!.id)[0]!.name);
    expect(r.restored).toBe(1);
    expect(fs.readFileSync(path.join(w.path, 'main.typ'), 'utf8')).toBe('= snap');
    expect(fs.readdirSync(dataDir).some((n) => n.startsWith('pre-restore-'))).toBe(true);
  });
});
```

- [ ] **Step 4: Write `server/backup/index.ts`**

```ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BackupDestination, BackupState, SnapshotInfo } from '../../src/types';
import type { EventBus } from '../events';
import { HttpError } from '../http';
import type { BackupApi } from '../router';
import type { WorkspaceService } from '../service';
import type { SettingsStore } from '../settings';
import { openWorkspace } from '../workspace';
import { claimable, planMirror, runMirror, type MirrorItem } from './mirror';
import { listSnapshots, pruneSnapshots, restoreSnapshot, stateDigest, writeSnapshot } from './snapshot';

export interface BackupDeps {
  settings: SettingsStore;
  service: WorkspaceService;
  bus: EventBus;
  dataDir: string;
  workspacesDir: string;
  now?: () => number;
  version: string;
  quietMs?: number;
  maxWaitMs?: number;
  log?: (...a: unknown[]) => void;
}

export interface Backup extends BackupApi {
  schedule(): void;
  start(): void;
  stop(): void;
  /** Run the snapshot-interval check once (the timer calls this every 60 s). */
  tick(): Promise<void>;
}

export function createBackup(deps: BackupDeps): Backup {
  const now = deps.now ?? (() => Date.now());
  const quietMs = deps.quietMs ?? 1500;
  const maxWaitMs = deps.maxWaitMs ?? 10_000;
  const log = deps.log ?? ((...a: unknown[]) => console.error('[backup]', ...a));

  let running = false;
  let rerun = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let deadline: number | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let lastRunAt: number | null = null;
  let lastMirrorFiles: number | null = null;
  let lastSnapshotAt: number | null = null;
  let lastSnapshotDigest: string | null = null;
  let lastError: string | null = null;

  const cfg = () => deps.settings.get().backup;
  const state = (): BackupState => ({ ...cfg(), running: running || quietTimer !== null, lastRunAt, lastMirrorFiles, lastSnapshotAt, lastError });
  const publish = () => deps.bus.emit({ type: 'backup.state', state: state() });

  const items = (): MirrorItem[] =>
    deps.service.list().filter((w) => w.status === 'ok').map((w) => ({ entry: w, files: openWorkspace(w.path).listFiles() }));

  const dest = (id: string): BackupDestination => {
    const d = cfg().destinations.find((x) => x.id === id);
    if (!d) throw new HttpError(404, `no backup destination ${id}`);
    return d;
  };

  const doMirror = (its: MirrorItem[]) => {
    const plan = planMirror(its);
    let files = 0;
    for (const d of cfg().destinations) {
      if (!d.mirror) continue;
      files += runMirror(d.path, plan, { now, log }).written;
    }
    lastMirrorFiles = files;
  };
  const doSnapshot = (its: MirrorItem[]) => {
    const c = cfg();
    let any = false;
    for (const d of c.destinations) {
      if (!d.snapshots) continue;
      writeSnapshot(d.path, its, { now: now(), version: deps.version, destinationId: d.id });
      pruneSnapshots(d.path, c.keepSnapshots);
      any = true;
    }
    if (any) { lastSnapshotAt = now(); lastSnapshotDigest = stateDigest(its); }
  };

  const runOnce = async (opts: { snapshot: boolean }) => {
    if (running) { rerun = true; return; }
    running = true;
    try {
      do {
        rerun = false;
        const its = items();
        doMirror(its);
        const due = lastSnapshotAt === null || now() - lastSnapshotAt >= cfg().snapshotIntervalMin * 60_000;
        if (opts.snapshot || (due && stateDigest(its) !== lastSnapshotDigest)) doSnapshot(its);
        lastRunAt = now();
        lastError = null;
      } while (rerun);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log('run failed:', lastError);
    } finally {
      running = false;
      publish();
    }
  };

  const schedule = () => {
    if (cfg().destinations.length === 0) return;
    const t = now();
    if (deadline === null) deadline = t + maxWaitMs;
    if (quietTimer) clearTimeout(quietTimer);
    const wait = Math.max(0, Math.min(quietMs, deadline - t));
    quietTimer = setTimeout(() => { quietTimer = null; deadline = null; void runOnce({ snapshot: false }); }, wait);
    (quietTimer as unknown as { unref?: () => void }).unref?.();
  };

  return {
    state,
    schedule,
    configure(patch) {
      const cur = cfg();
      let destinations = cur.destinations;
      if ('destinations' in patch) {
        if (!Array.isArray(patch.destinations)) throw new HttpError(400, 'destinations must be an array');
        destinations = patch.destinations.map((raw) => {
          const r = raw as Partial<BackupDestination>;
          if (typeof r.path !== 'string' || !path.isAbsolute(r.path)) throw new HttpError(400, 'each destination needs an absolute path');
          const p = path.resolve(r.path);
          const known = cur.destinations.find((d) => d.id === r.id || path.resolve(d.path).toLowerCase() === p.toLowerCase());
          try { fs.mkdirSync(p, { recursive: true }); } catch (err) { throw new HttpError(400, `cannot create ${p}: ${err instanceof Error ? err.message : String(err)}`); }
          if (!claimable(p)) throw new HttpError(409, `${p} already has files this app did not write; pick an empty folder or one used for a previous backup`);
          return { id: known?.id ?? crypto.randomUUID(), path: p, mirror: r.mirror !== false, snapshots: r.snapshots !== false };
        });
      }
      const next = deps.settings.update((s) => ({
        ...s,
        backup: {
          destinations,
          snapshotIntervalMin: typeof patch.snapshotIntervalMin === 'number' ? patch.snapshotIntervalMin : cur.snapshotIntervalMin,
          keepSnapshots: typeof patch.keepSnapshots === 'number' ? patch.keepSnapshots : cur.keepSnapshots,
        },
      })).backup;
      lastError = null;
      publish();
      return { ...next, ...state(), ...next };
    },
    async run() { await runOnce({ snapshot: true }); return state(); },
    listSnapshots: (destinationId) => listSnapshots(dest(destinationId).path, destinationId),
    async restore(destinationId, name) {
      if (!/^typst-snapshot-\d{8}-\d{6}\.zip$/.test(name)) throw new HttpError(400, 'bad snapshot name');
      const zipPath = path.join(dest(destinationId).path, 'snapshots', name);
      const out = await restoreSnapshot({ zipPath, dataDir: deps.dataDir, workspacesDir: deps.workspacesDir, settings: deps.settings, now });
      deps.service.boot();
      deps.bus.emit({ type: 'workspaces.changed' });
      return out;
    },
    async tick() { if (cfg().destinations.some((d) => d.snapshots)) await runOnce({ snapshot: false }); },
    start() {
      unsubscribe ??= deps.bus.subscribe((ev) => { if (ev.type === 'workspace.changed' || ev.type === 'workspaces.changed') schedule(); });
      tickTimer ??= setInterval(() => void this.tick(), 60_000);
      (tickTimer as unknown as { unref?: () => void }).unref?.();
      if (cfg().destinations.length) schedule();
    },
    stop() {
      unsubscribe?.(); unsubscribe = null;
      if (tickTimer) clearInterval(tickTimer); tickTimer = null;
      if (quietTimer) clearTimeout(quietTimer); quietTimer = null; deadline = null;
    },
  };
}

export type { SnapshotInfo };
```

`configure` returns `state()` merged with the freshly written settings; simplify the last line to `return state();` once the tests pass (the spread is only there to make the intent obvious).

- [ ] **Step 5: Wire into `server/index.ts`**

```ts
import { createBackup } from './backup/index';
import { browse } from './fs-browse';
// ...
const backup = createBackup({ settings, service, bus, dataDir: config.dataDir, workspacesDir: config.workspacesDir, version: '0.1.0' });
backup.start();
// pass `backup` and `browse` to createHandler
```

- [ ] **Step 6: Add backup route tests to `server/router.test.ts`**

Change `app()` to build a real `createBackup` (with `quietMs: 50`) and pass `browse`; add:

```ts
  it('configures, runs, lists and browses backups', async () => {
    const { call } = app();
    const dest = tmpDir(); dirs.push(dest);
    const cfg = await call('PATCH', '/api/backup', { destinations: [{ path: dest, mirror: true, snapshots: true }] });
    expect(cfg.status).toBe(200);
    await call('POST', '/api/workspaces', { name: 'R' });
    const ran = await (await call('POST', '/api/backup/run')).json() as { backup: { destinations: Array<{ id: string }>; lastSnapshotAt: number } };
    expect(ran.backup.lastSnapshotAt).toBeTruthy();
    const snaps = await (await call('GET', `/api/backup/snapshots?destination=${ran.backup.destinations[0]!.id}`)).json() as { snapshots: unknown[] };
    expect(snaps.snapshots).toHaveLength(1);
    const browse = await (await call('GET', `/api/fs/browse?path=${encodeURIComponent(dest)}`)).json() as { entries: Array<{ name: string }> };
    expect(browse.entries.map((e) => e.name)).toContain('snapshots');
  });
```

- [ ] **Step 7: Run everything, typecheck, commit**

Run: `bunx vitest run --project server` → all pass.

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(server): backup destinations, mirror scheduling, timed snapshots, restore, folder browser" -- advanced-typst-editor
```

---

### Task 13: MCP server (27 tools), sessions, stdio bridge

**Files:**
- Create: `server/mcp-tools.ts`, `server/mcp.ts`, `server/mcp-stdio.ts` (from `$OLD/server/mcp-stdio.ts`), `server/mcp-tools.test.ts`, `server/mcp.test.ts`
- Modify: `server/index.ts` (pass `mcp`)

**Interfaces:**
- Consumes: `WorkspaceService`, `Backup`, `CompileApi`, `SettingsStore`, `EventBus`; `findScreenshotSlots`, `ensureHelper`, `newSlotSnippet`, `setSlotPath`, `setSlotHeight`, `parseLength`, `fontFamily`.
- Produces: `TOOLS: ToolDef[]` and `callTool(name, args, deps) -> Promise<unknown>` (throws `HttpError`), `createMcp(deps) -> McpApi & { close() }`.

- [ ] **Step 1: Write the failing test `server/mcp-tools.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createEventBus } from './events';
import { createSettingsStore } from './settings';
import { createWorkspaceService } from './service';
import { createCompiler } from './compile';
import { createBackup } from './backup/index';
import { TOOLS, callTool, type ToolDeps } from './mcp-tools';
import { tmpDir, rmDir, put, TYPST_CLI } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function setup(): ToolDeps & { dataDir: string } {
  const dataDir = tmpDir(); dirs.push(dataDir);
  const bus = createEventBus();
  const settings = createSettingsStore(dataDir);
  const workspacesDir = path.join(dataDir, 'workspaces');
  const service = createWorkspaceService({ settings, bus, watcher: null, dataDir, workspacesDir, template: '#let image-placeholder(caption, path: none, height: 2.2in) = figure(caption: caption)[x]\n= T\n' });
  const compile = createCompiler({ settings, service, typstCli: fs.existsSync(TYPST_CLI) ? TYPST_CLI : null });
  const backup = createBackup({ settings, service, bus, dataDir, workspacesDir, version: '0.1.0' });
  return { service, compile, backup, settings, dataDir };
}
const call = (deps: ToolDeps, name: string, args: Record<string, unknown> = {}) => callTool(name, args, deps);

describe('MCP tools', () => {
  it('exposes exactly the 27 tools from the spec', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      'add_font', 'add_slot', 'backup_status', 'clear_slot', 'compile', 'create_workspace', 'delete_asset', 'delete_workspace',
      'edit_source', 'export_pdf', 'get_source', 'get_workspace', 'list_assets', 'list_slots', 'list_snapshots', 'list_workspaces',
      'move_asset', 'move_workspace', 'open_workspace_folder', 'place_image', 'rename_asset', 'rename_workspace', 'run_backup',
      'set_slot_height', 'set_source', 'update_asset', 'upload_asset',
    ]);
    for (const t of TOOLS) expect(t.description.length).toBeGreaterThan(20);
  });

  it('workspace lifecycle and source editing', async () => {
    const d = setup();
    const w = await call(d, 'create_workspace', { name: 'Rep', group: 'G' }) as { id: string; slots: unknown[] };
    expect((await call(d, 'list_workspaces') as unknown[]).length).toBe(1);
    expect(await call(d, 'get_source', { workspace_id: w.id })).toMatchObject({ file: 'main.typ', source: expect.stringContaining('= T') });
    await call(d, 'set_source', { workspace_id: w.id, source: '= A\nhello world\nhello' });
    await expect(call(d, 'edit_source', { workspace_id: w.id, old_string: 'hello', new_string: 'bye' })).rejects.toThrow(/2 times/);
    expect(await call(d, 'edit_source', { workspace_id: w.id, old_string: 'hello', new_string: 'bye', replace_all: true })).toMatchObject({ replacements: 2 });
    expect(await call(d, 'rename_workspace', { workspace_id: w.id, name: 'Rep2' })).toMatchObject({ name: 'Rep2' });
    expect(await call(d, 'move_workspace', { workspace_id: w.id, group: null })).toMatchObject({ group: null });
    const ext = tmpDir(); dirs.push(ext); put(ext, 'main.typ', '= ext');
    expect(await call(d, 'open_workspace_folder', { path: ext })).toMatchObject({ library: false });
    expect(await call(d, 'delete_workspace', { workspace_id: w.id })).toEqual({ ok: true });
    expect(fs.existsSync(path.join(d.dataDir, 'trash'))).toBe(true);
  });

  it('figure slots and assets', async () => {
    const d = setup();
    const w = await call(d, 'create_workspace', { name: 'R' }) as { id: string };
    expect(await call(d, 'add_slot', { workspace_id: w.id, caption: 'Proof' })).toMatchObject({ slot: { caption: 'Proof' }, slotCount: 1 });
    const up = await call(d, 'upload_asset', { workspace_id: w.id, filename: 'shot.jpg', data_base64: PNG_B64, folder: 'f' }) as { id: string };
    expect(up.id).toBe('assets/f/shot.png');
    const placed = await call(d, 'place_image', { workspace_id: w.id, slot_index: 0, asset_id: up.id, height: '3in' }) as { slots: Array<{ path: string | null; heightPt: number | null }> };
    expect(placed.slots[0]).toMatchObject({ path: '/assets/f/shot.png', heightPt: 216 });
    expect((await call(d, 'list_slots', { workspace_id: w.id }) as unknown[]).length).toBe(1);
    await call(d, 'set_slot_height', { workspace_id: w.id, slot_index: 0, height: '2in' });
    expect(await call(d, 'rename_asset', { workspace_id: w.id, asset_id: up.id, stem: 'proof' })).toMatchObject({ references: 1, asset: { id: 'assets/f/proof.png' } });
    expect(await call(d, 'move_asset', { workspace_id: w.id, asset_id: 'assets/f/proof.png', folder: null })).toMatchObject({ asset: { id: 'assets/proof.png' } });
    expect(await call(d, 'update_asset', { workspace_id: w.id, asset_id: 'assets/proof.png', blurs: [{ x: 0, y: 0, w: 0.5, h: 0.5 }] })).toMatchObject({ blurs: [{ x: 0, y: 0, w: 0.5, h: 0.5 }] });
    await call(d, 'clear_slot', { workspace_id: w.id, slot_index: 0 });
    expect((await call(d, 'list_assets', { workspace_id: w.id }) as unknown[]).length).toBe(1);
    const fontPath = 'C:/Users/rober/Desktop/typst-editor/recovered-from-docker/fonts/DejaVuSansMono.ttf';
    expect(await call(d, 'add_font', { workspace_id: w.id, path: fontPath })).toMatchObject({ id: 'fonts/DejaVuSansMono.ttf', fontFamily: 'DejaVu Sans Mono' });
    expect(await call(d, 'delete_asset', { workspace_id: w.id, asset_id: 'assets/proof.png' })).toEqual({ ok: true });
    const ws = await call(d, 'get_workspace', { workspace_id: w.id }) as { assets: unknown[]; slots: unknown[]; files: unknown[] };
    expect(ws.assets).toHaveLength(1);
    expect(ws.slots).toHaveLength(1);
  });

  it('backup tools and compile', async () => {
    const d = setup();
    const dest = tmpDir(); dirs.push(dest);
    d.backup.configure({ destinations: [{ path: dest, mirror: true, snapshots: true }] });
    const w = await call(d, 'create_workspace', { name: 'R', source: '= ok' }) as { id: string };
    expect(await call(d, 'backup_status')).toMatchObject({ destinations: [{ path: path.resolve(dest) }] });
    const ran = await call(d, 'run_backup') as { lastSnapshotAt: number; destinations: Array<{ id: string }> };
    expect(ran.lastSnapshotAt).toBeTruthy();
    expect((await call(d, 'list_snapshots', { destination_id: ran.destinations[0]!.id }) as unknown[]).length).toBe(1);
    if (fs.existsSync(TYPST_CLI)) {
      expect(await call(d, 'compile', { workspace_id: w.id })).toMatchObject({ ok: true });
      const out = path.join(dest, 'r.pdf');
      expect(await call(d, 'export_pdf', { workspace_id: w.id, to: out })).toMatchObject({ path: out, baked: 0 });
    }
  });
});
```

- [ ] **Step 2: Run to verify failure** → module not found.

- [ ] **Step 3: Write `server/mcp-tools.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { z, type ZodRawShape } from 'zod';
import type { TypstAsset, WorkspaceEntry } from '../src/types';
import { parseLength } from '../src/lib/typst-geometry';
import { ensureHelper, findScreenshotSlots, newSlotSnippet, setSlotHeight, setSlotPath, type ScreenshotSlot } from '../src/lib/typst-placeholders';
import type { Backup } from './backup/index';
import { fontFamily } from './fonts';
import { HttpError } from './http';
import { normalizeRel } from './paths';
import type { CompileApi } from './router';
import type { WorkspaceService } from './service';
import type { SettingsStore } from './settings';

export const MCP_ORIGIN = 'mcp';

export interface ToolDeps { service: WorkspaceService; compile: CompileApi; backup: Backup; settings: SettingsStore }
export interface ToolDef { name: string; description: string; schema: ZodRawShape; run: (args: Record<string, unknown>, deps: ToolDeps) => Promise<unknown> | unknown }

const WS = z.string().describe('Workspace id from list_workspaces.');
const SLOT = z.number().int().min(0).describe('Slot index from list_slots / get_workspace (0-based, in document order).');
const FILE = z.string().optional().describe('A .typ path inside the workspace. Defaults to main.typ.');

const entryFile = (f: unknown): string => {
  const n = normalizeRel(typeof f === 'string' && f ? f : 'main.typ');
  if (!n || !n.endsWith('.typ')) throw new HttpError(400, 'file must be a .typ path inside the workspace');
  return n;
};
const readSource = (deps: ToolDeps, id: string, file: string): string => {
  const f = deps.service.fs(id).readFile(file);
  if (!f) throw new HttpError(404, `${file} not found in workspace`);
  return new TextDecoder().decode(f.bytes);
};
const writeSource = (deps: ToolDeps, id: string, file: string, source: string) => deps.service.writeFile(id, file, new TextEncoder().encode(source), MCP_ORIGIN);
const slotsOf = (source: string) => findScreenshotSlots(source).map((s, index) => ({ index, ...s }));
const withSlots = (deps: ToolDeps, e: WorkspaceEntry) => ({ ...e, slots: slotsOf(readSource(deps, e.id, 'main.typ')) });
const decodeBase64 = (s: string): Uint8Array => { const clean = s.replace(/^data:[^,]*,/, ''); return new Uint8Array(Buffer.from(clean, 'base64')); };
const bytesFrom = (args: Record<string, unknown>): { bytes: Uint8Array; name: string } => {
  if (typeof args.path === 'string' && args.path) {
    if (!path.isAbsolute(args.path)) throw new HttpError(400, 'path must be absolute');
    try { return { bytes: new Uint8Array(fs.readFileSync(args.path)), name: path.basename(args.path) }; } catch { throw new HttpError(404, `cannot read ${args.path}`); }
  }
  if (typeof args.data_base64 === 'string' && args.data_base64) return { bytes: decodeBase64(args.data_base64), name: typeof args.filename === 'string' ? args.filename : 'asset' };
  throw new HttpError(400, 'pass path (absolute, on this machine) or data_base64');
};
const rewriteSlot = (deps: ToolDeps, id: string, index: number, fn: (source: string, slot: ScreenshotSlot) => string) => {
  const source = readSource(deps, id, 'main.typ');
  const slot = findScreenshotSlots(source)[index];
  if (!slot) throw new HttpError(404, `no slot ${index}; the document has ${findScreenshotSlots(source).length}`);
  const next = fn(source, slot);
  if (next !== source) writeSource(deps, id, 'main.typ', next);
  return { slots: slotsOf(next) };
};
const heightPt = (h: unknown): number | null => {
  if (h === undefined || h === null) return null;
  const pt = parseLength(String(h));
  if (pt === null || pt <= 0) throw new HttpError(400, `height must be a Typst length such as "3in", "8cm" or "200pt" (got "${String(h)}")`);
  return pt;
};

export const TOOLS: ToolDef[] = [
  { name: 'list_workspaces', description: 'List every workspace: id, name, group, folder path, whether it is in the app library or an external folder, and whether its folder currently exists.', schema: {}, run: (_a, d) => d.service.list() },
  { name: 'get_workspace', description: 'One workspace in full: entry, file tree, images and fonts with their framing, asset folders, and the figure slots in main.typ (index, line, caption, placed path, height in points).', schema: { workspace_id: WS }, run: (a, d) => { const det = d.service.detail(a.workspace_id as string); return { ...det, slots: slotsOf(readSource(d, det.entry.id, 'main.typ')) }; } },
  { name: 'create_workspace', description: 'Create a workspace folder in the app library. Without a source it starts from the starter template, which defines the image-placeholder helper and two empty figure slots.', schema: { name: z.string().optional().describe('Display name; also the folder name. Defaults to "Untitled report".'), group: z.string().optional().describe('Sidebar group label.'), source: z.string().optional().describe('Initial main.typ contents.') }, run: (a, d) => withSlots(d, d.service.create({ name: (a.name as string | undefined) ?? '', group: (a.group as string | undefined) ?? null, source: a.source as string | undefined })) },
  { name: 'open_workspace_folder', description: 'Register an existing folder anywhere on this machine as a workspace (main.typ, assets/, fonts/). Returns the existing entry if it is already registered.', schema: { path: z.string().describe('Absolute folder path.'), name: z.string().optional() }, run: (a, d) => d.service.openFolder(a.path as string, a.name as string | undefined) },
  { name: 'rename_workspace', description: 'Rename a workspace. A library workspace\'s folder is renamed too; an external folder is left alone.', schema: { workspace_id: WS, name: z.string() }, run: (a, d) => d.service.rename(a.workspace_id as string, a.name as string) },
  { name: 'move_workspace', description: 'Set or clear the sidebar group of a workspace (null = loose at the top level). Groups also shape the backup mirror tree.', schema: { workspace_id: WS, group: z.string().nullable() }, run: (a, d) => d.service.setGroup(a.workspace_id as string, a.group as string | null) },
  { name: 'delete_workspace', description: 'Remove a workspace from the app. A library workspace\'s folder moves to the app trash (never deleted); an external folder is only forgotten.', schema: { workspace_id: WS }, run: (a, d) => { d.service.remove(a.workspace_id as string); return { ok: true }; } },

  { name: 'get_source', description: 'Read a Typst file from the workspace (main.typ by default).', schema: { workspace_id: WS, file: FILE }, run: (a, d) => { const f = entryFile(a.file); return { file: f, source: readSource(d, a.workspace_id as string, f) }; } },
  { name: 'set_source', description: 'Replace the entire contents of a Typst file. For a small change prefer edit_source.', schema: { workspace_id: WS, source: z.string(), file: FILE }, run: (a, d) => { const f = entryFile(a.file); writeSource(d, a.workspace_id as string, f, a.source as string); return { file: f, slots: slotsOf(a.source as string) }; } },
  { name: 'edit_source', description: 'Replace an exact string in a Typst file. old_string must occur exactly once (add surrounding lines to disambiguate) unless replace_all is true. Returns the replacement count and the slots afterwards.', schema: { workspace_id: WS, old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional(), file: FILE }, run: (a, d) => {
    const f = entryFile(a.file); const src = readSource(d, a.workspace_id as string, f); const oldS = a.old_string as string;
    if (!oldS) throw new HttpError(400, 'old_string cannot be empty');
    const count = src.split(oldS).length - 1;
    if (count === 0) throw new HttpError(400, 'old_string not found');
    if (count > 1 && !a.replace_all) throw new HttpError(400, `old_string occurs ${count} times; include more context or pass replace_all: true`);
    const next = a.replace_all ? src.split(oldS).join(a.new_string as string) : src.replace(oldS, () => a.new_string as string);
    writeSource(d, a.workspace_id as string, f, next);
    return { replacements: count, file: f, slots: slotsOf(next) };
  } },

  { name: 'list_slots', description: 'The figure slots (#image-placeholder calls) in main.typ, in document order, with caption, placed path and height.', schema: { workspace_id: WS }, run: (a, d) => slotsOf(readSource(d, a.workspace_id as string, 'main.typ')) },
  { name: 'add_slot', description: 'Append an empty figure slot to main.typ, adding the image-placeholder helper if the document lacks it.', schema: { workspace_id: WS, caption: z.string() }, run: (a, d) => {
    const id = a.workspace_id as string; const ensured = ensureHelper(readSource(d, id, 'main.typ'));
    const base = ensured.source.endsWith('\n') ? ensured.source : `${ensured.source}\n`;
    const next = `${base}\n${newSlotSnippet(a.caption as string)}`; writeSource(d, id, 'main.typ', next);
    const slots = slotsOf(next); return { slot: slots[slots.length - 1], slotCount: slots.length, helperChanged: ensured.changed };
  } },
  { name: 'place_image', description: 'Put an image asset into a figure slot by writing path: "/<asset id>" onto that #image-placeholder call. Optionally set the figure height.', schema: { workspace_id: WS, slot_index: SLOT, asset_id: z.string().describe('Asset id from list_assets, e.g. "assets/findings/login.png".'), height: z.string().optional().describe('Typst length, e.g. "3in".') }, run: (a, d) => {
    const asset = d.service.fs(a.workspace_id as string).getAsset(a.asset_id as string);
    if (asset.kind !== 'image') throw new HttpError(400, 'only images can be placed');
    const pt = heightPt(a.height);
    return rewriteSlot(d, a.workspace_id as string, a.slot_index as number, (src, slot) => { let next = setSlotPath(src, slot, `/${asset.id}`); if (pt !== null) { const s2 = findScreenshotSlots(next)[a.slot_index as number]!; next = setSlotHeight(next, s2, pt); } return next; });
  } },
  { name: 'clear_slot', description: 'Remove the image from a figure slot, leaving the empty placeholder box and its caption.', schema: { workspace_id: WS, slot_index: SLOT }, run: (a, d) => rewriteSlot(d, a.workspace_id as string, a.slot_index as number, (src, slot) => setSlotPath(src, slot, null)) },
  { name: 'set_slot_height', description: 'Set (or with null, reset) the height of one figure slot.', schema: { workspace_id: WS, slot_index: SLOT, height: z.string().nullable() }, run: (a, d) => rewriteSlot(d, a.workspace_id as string, a.slot_index as number, (src, slot) => setSlotHeight(src, slot, heightPt(a.height))) },

  { name: 'list_assets', description: 'Images and fonts in the workspace with ids, folders, sizes, crop/blur framing and font families.', schema: { workspace_id: WS }, run: (a, d) => d.service.fs(a.workspace_id as string).listAssets() },
  { name: 'upload_asset', description: 'Add an image (png, jpg, gif, webp, svg) from an absolute path on this machine or from base64. The stored name may differ (sanitised, extension corrected to the bytes, de-duplicated): use the returned id.', schema: { workspace_id: WS, path: z.string().optional(), data_base64: z.string().optional(), filename: z.string().optional(), folder: z.string().optional().describe('Folder under assets/, created if missing.') }, run: (a, d) => { const { bytes, name } = bytesFrom(a); return d.service.addAsset(a.workspace_id as string, { kind: 'image', filename: (a.filename as string | undefined) ?? name, bytes, folder: (a.folder as string | undefined) ?? null }, MCP_ORIGIN); } },
  { name: 'add_font', description: 'Add a font file (ttf, otf, woff, woff2, ttc) to fonts/. The family name is read from the file when possible; pass family for woff/woff2.', schema: { workspace_id: WS, path: z.string().optional(), data_base64: z.string().optional(), filename: z.string().optional(), family: z.string().optional() }, run: (a, d) => { const { bytes, name } = bytesFrom(a); return d.service.addAsset(a.workspace_id as string, { kind: 'font', filename: (a.filename as string | undefined) ?? name, bytes, folder: null, family: (a.family as string | undefined) ?? fontFamily(bytes) }, MCP_ORIGIN); } },
  { name: 'rename_asset', description: 'Rename an asset (extension kept) and rewrite every reference in every .typ file.', schema: { workspace_id: WS, asset_id: z.string(), stem: z.string().describe('New name without extension.') }, run: (a, d) => d.service.renameAsset(a.workspace_id as string, a.asset_id as string, a.stem as string, MCP_ORIGIN) },
  { name: 'move_asset', description: 'Move an image into a folder under assets/ (null = the root), rewriting references.', schema: { workspace_id: WS, asset_id: z.string(), folder: z.string().nullable() }, run: (a, d) => d.service.moveAsset(a.workspace_id as string, a.asset_id as string, a.folder as string | null, MCP_ORIGIN) },
  { name: 'update_asset', description: 'Set render-time framing: crop {x,y,w,h} normalised to the original (may extend past 0..1 to letterbox), blurs (inside 0..1; style gaussian|pixelate; strength 0.25..3), natural width/height. null clears. The file is never modified.', schema: { workspace_id: WS, asset_id: z.string(), crop: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable().optional(), blurs: z.array(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number(), style: z.enum(['gaussian', 'pixelate']).optional(), strength: z.number().optional() })).nullable().optional(), width: z.number().int().optional(), height: z.number().int().optional() }, run: (a, d) => { const { workspace_id, asset_id, ...patch } = a; if (Object.keys(patch).length === 0) throw new HttpError(400, 'pass at least one of crop, blurs, width, height'); return d.service.patchAsset(workspace_id as string, asset_id as string, patch, MCP_ORIGIN); } },
  { name: 'delete_asset', description: 'Delete an image or font file. References left in the source fail to compile until cleared.', schema: { workspace_id: WS, asset_id: z.string() }, run: (a, d) => { d.service.deleteAsset(a.workspace_id as string, a.asset_id as string, MCP_ORIGIN); return { ok: true }; } },

  { name: 'compile', description: 'Compile with the typst CLI and return diagnostics (errors and warnings with file, line, column). No PDF is kept.', schema: { workspace_id: WS, file: FILE }, run: (a, d) => d.compile.compile(a.workspace_id as string, a.file as string | undefined) },
  { name: 'export_pdf', description: 'Compile to a PDF at an absolute path on this machine. Crop and blur redactions are baked into the images first; the result reports how many were baked.', schema: { workspace_id: WS, to: z.string().describe('Absolute output path ending in .pdf'), file: FILE }, run: async (a, d) => { const out = await d.compile.exportPdf(a.workspace_id as string, a.file as string | undefined, a.to as string); return { path: out.path, baked: out.baked }; } },

  { name: 'backup_status', description: 'Backup destinations, snapshot interval and retention, and how the last run went.', schema: {}, run: (_a, d) => d.backup.state() },
  { name: 'run_backup', description: 'Mirror and snapshot to every destination now.', schema: {}, run: (_a, d) => d.backup.run() },
  { name: 'list_snapshots', description: 'Snapshots in one destination, newest first.', schema: { destination_id: z.string() }, run: (a, d) => d.backup.listSnapshots(a.destination_id as string) },
];

export async function callTool(name: string, args: Record<string, unknown>, deps: ToolDeps): Promise<unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new HttpError(404, `unknown tool: ${name}`);
  const parsed = z.object(tool.schema).safeParse(args);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return tool.run(parsed.data as Record<string, unknown>, deps);
}

export type { TypstAsset };
```

- [ ] **Step 4: Run the tool tests** → 4 pass (the `slots[0].heightPt` value 216 = 3in × 72; if `ScreenshotSlot` names the field differently, e.g. `height`, read `src/lib/typst-placeholders.ts` and use its field name in the test).

- [ ] **Step 5: Write the failing test `server/mcp.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { createEventBus } from './events';
import { createSettingsStore } from './settings';
import { createWorkspaceService } from './service';
import { createCompiler } from './compile';
import { createBackup } from './backup/index';
import { createMcp } from './mcp';
import { tmpDir, rmDir } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

function setup() {
  const dataDir = tmpDir(); dirs.push(dataDir);
  const bus = createEventBus();
  const settings = createSettingsStore(dataDir);
  const workspacesDir = path.join(dataDir, 'workspaces');
  const service = createWorkspaceService({ settings, bus, watcher: null, dataDir, workspacesDir, template: '= T' });
  const mcp = createMcp({ service, compile: createCompiler({ settings, service, typstCli: null }), backup: createBackup({ settings, service, bus, dataDir, workspacesDir, version: '0.1.0' }), settings, bus, token: null });
  const post = (body: unknown, session?: string) => mcp.handle(new Request('http://127.0.0.1:8090/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify(body) }));
  return { mcp, post };
}
async function bodyJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const data = text.split('\n').find((l) => l.startsWith('data:'))?.slice(5) ?? text;
  return JSON.parse(data) as Record<string, unknown>;
}

describe('MCP over Streamable HTTP', () => {
  it('initialises a session, lists tools, calls one, reports the client, ends the session', async () => {
    const { mcp, post } = setup();
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '9.9' } } });
    expect(init.status).toBe(200);
    const session = init.headers.get('mcp-session-id')!;
    expect(session).toBeTruthy();
    expect((await bodyJson(init)).result).toMatchObject({ serverInfo: { name: 'typst-figure-studio' } });
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);
    const list = await bodyJson(await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session));
    expect(((list.result as { tools: Array<{ name: string }> }).tools).map((t) => t.name)).toContain('create_workspace');
    const call = await bodyJson(await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_workspace', arguments: { name: 'Via MCP' } } }, session));
    const text = (call.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(JSON.parse(text)).toMatchObject({ name: 'Via MCP', library: true });
    const bad = await bodyJson(await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_workspace', arguments: { workspace_id: 'nope' } } }, session));
    expect((bad.result as { isError: boolean }).isError).toBe(true);
    expect(mcp.status().clients).toEqual([expect.objectContaining({ name: 'claude-code', version: '9.9', sessions: 1 })]);
    const del = await mcp.handle(new Request('http://127.0.0.1:8090/mcp', { method: 'DELETE', headers: { 'mcp-session-id': session } }));
    expect(del.status).toBeLessThan(300);
    expect(mcp.status().clients).toEqual([]);
    mcp.close();
  });
});
```

- [ ] **Step 6: Write `server/mcp.ts`**

```ts
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { McpClientStatus, McpStatus } from '../src/types';
import type { Backup } from './backup/index';
import type { EventBus } from './events';
import { HttpError } from './http';
import { TOOLS, type ToolDeps } from './mcp-tools';
import type { CompileApi, McpApi } from './router';
import type { WorkspaceService } from './service';
import type { SettingsStore } from './settings';

export const SERVER_INFO = { name: 'typst-figure-studio', version: '0.1.0' };
const SESSION_TTL_MS = 30 * 60_000;

interface Session { id: string; server: McpServer; transport: WebStandardStreamableHTTPServerTransport; clientName: string; clientVersion: string | null; lastSeenAt: number; streamOpen: boolean }

export interface McpDeps { service: WorkspaceService; compile: CompileApi; backup: Backup; settings: SettingsStore; bus: EventBus; token: string | null; now?: () => number }

export function createMcp(deps: McpDeps): McpApi & { close(): void } {
  const now = deps.now ?? (() => Date.now());
  const sessions = new Map<string, Session>();
  const toolDeps: ToolDeps = { service: deps.service, compile: deps.compile, backup: deps.backup, settings: deps.settings };

  const status = (): McpStatus => {
    const byName = new Map<string, McpClientStatus>();
    for (const s of sessions.values()) {
      const cur = byName.get(s.clientName);
      const connected = s.streamOpen || now() - s.lastSeenAt < 60_000;
      if (cur) { cur.sessions += 1; cur.connected ||= connected; cur.lastSeenAt = Math.max(cur.lastSeenAt, s.lastSeenAt); }
      else byName.set(s.clientName, { name: s.clientName, version: s.clientVersion, connected, lastSeenAt: s.lastSeenAt, sessions: 1 });
    }
    return { endpoint: '/mcp', authRequired: !!deps.token, clients: [...byName.values()] };
  };
  const publish = () => deps.bus.emit({ type: 'mcp.clients', clients: status().clients });

  const buildServer = (): McpServer => {
    const server = new McpServer(SERVER_INFO);
    for (const t of TOOLS) {
      server.registerTool(t.name, { description: t.description, inputSchema: t.schema }, async (args) => {
        try {
          const out = await t.run((args ?? {}) as Record<string, unknown>, toolDeps);
          return { content: [{ type: 'text', text: JSON.stringify(out ?? null, null, 2) }] };
        } catch (e) {
          const msg = e instanceof HttpError ? e.message : e instanceof Error ? e.message : String(e);
          return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
        }
      });
    }
    return server;
  };

  const newSession = async (): Promise<Session> => {
    const server = buildServer();
    const session: Session = { id: '', server, transport: null as unknown as WebStandardStreamableHTTPServerTransport, clientName: 'unknown', clientVersion: null, lastSeenAt: now(), streamOpen: false };
    session.transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        session.id = id;
        const info = server.server.getClientVersion();
        session.clientName = info?.name ?? 'unknown';
        session.clientVersion = info?.version ?? null;
        sessions.set(id, session);
        publish();
      },
      onsessionclosed: (id) => { sessions.delete(id); publish(); },
    });
    await server.connect(session.transport);
    return session;
  };

  const sweep = () => { for (const [id, s] of sessions) if (!s.streamOpen && now() - s.lastSeenAt > SESSION_TTL_MS) { sessions.delete(id); void s.transport.close(); } };

  return {
    status,
    async handle(req) {
      sweep();
      const sid = req.headers.get('mcp-session-id');
      let session = sid ? sessions.get(sid) : undefined;
      if (!session) {
        if (req.method !== 'POST') return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unknown session' }, id: null }), { status: 404, headers: { 'content-type': 'application/json' } });
        session = await newSession();
      }
      session.lastSeenAt = now();
      if (req.method === 'GET') {
        session.streamOpen = true;
        publish();
        const res = await session.transport.handleRequest(req);
        // The stream ends when the client goes away; the transport resolves the body then.
        void (res.body ? res.body : null);
        return res;
      }
      const res = await session.transport.handleRequest(req);
      if (req.method === 'DELETE') { sessions.delete(session.id); publish(); }
      return res;
    },
    close() { for (const s of sessions.values()) void s.transport.close(); sessions.clear(); },
  };
}
```

If the installed SDK names the callbacks differently (`onsessioninitialized` / `onsessionclosed` are the 1.30 names; `getClientVersion()` lives on `server.server`), read `node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.d.ts` and `mcp.d.ts` and adapt; the observable behaviour in the test is the contract. Marking `streamOpen = false` when the GET stream ends: wrap `res.body` with a `TransformStream` whose `flush`/cancel sets `session.streamOpen = false` and publishes.

- [ ] **Step 7: Copy the stdio bridge**

Copy `$OLD/server/mcp-stdio.ts` to `server/mcp-stdio.ts`. Edit the env block: `const ENDPOINT = process.env.TFS_MCP_URL ?? 'http://127.0.0.1:8090/mcp'; const PASSWORD = process.env.APP_TOKEN ?? '';` and the log prefix to `[typst-studio-stdio]`, the unreachable message to `Typst Studio is not reachable at ${ENDPOINT}. Start it from the desktop icon or with "bun run dev:server".`. No other changes.

- [ ] **Step 8: Wire into `server/index.ts`**

```ts
import { createMcp } from './mcp';
const mcp = createMcp({ service, compile, backup, settings, bus, token: config.token });
// pass `mcp` to createHandler
```

- [ ] **Step 9: Run everything, then a live check with Claude Code, commit**

Run: `bunx vitest run --project server` → all pass; `bun run typecheck` passes.
Live: start `DATA_DIR=./data bun server/index.ts`, then in another shell `claude mcp list` must show `typst-figure-studio: http://localhost:8090/mcp (HTTP) - ✔ Connected`. Stop the server.

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(server): MCP server with 27 tools over Streamable HTTP, sessions, stdio bridge" -- advanced-typst-editor
```

---

### Task 14: Legacy import CLI

**Files:**
- Create: `server/legacy-import.ts`, `server/cli.ts`, `server/legacy-import.test.ts`

**Interfaces:**
- Consumes: `createSettingsStore`, `openWorkspace`, `safeDirName`, `uniqueDirName`.
- Produces: `importLegacy({ legacyDir, dataDir, log? }) -> { imported: Array<{ name: string; group: string | null; path: string; assets: number }> }`; CLI `bun server/cli.ts import-legacy <legacyDir> [--data-dir <dir>]`.

Legacy layout (`$OLD/data`): `documents/<uuid>.json` = `{ id, name, folderId, source, assets: [{ id, kind, filename, mime, size, width?, height?, crop?, blurs?, fontFamily? }], createdAt, updatedAt }`; `blobs/<asset uuid>` = the bytes; `folders.json` = `{ folders: [{ id, name }] }`. Old image path `/assets/<filename>` maps to the new `assets/<filename>` unchanged; fonts move to `fonts/<filename>`.

- [ ] **Step 1: Write the failing test `server/legacy-import.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { importLegacy } from './legacy-import';
import { createSettingsStore } from './settings';
import { openWorkspace } from './workspace';
import { tmpDir, rmDir, OLD } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

describe('importLegacy', () => {
  it('imports the real recovered data set', () => {
    const dataDir = tmpDir(); dirs.push(dataDir);
    const r = importLegacy({ legacyDir: path.join(OLD, 'data'), dataDir, log: () => {} });
    expect(r.imported.map((w) => [w.name, w.group]).sort()).toEqual([
      ['ccdc-inject-template', 'CPTC'], ['cptc-inject-1', 'CPTC'], ['cptc-inject-2', 'CPTC'], ['cptc-report', 'CPTC'],
      ['ece-2300L-lab1', 'ECE-2300L'], ['ece-2300L-template', 'ECE-2300L'],
    ]);
    const settings = createSettingsStore(dataDir);
    expect(settings.listWorkspaces()).toHaveLength(6);
    const report = r.imported.find((w) => w.name === 'cptc-report')!;
    const ws = openWorkspace(report.path);
    expect(fs.readFileSync(path.join(report.path, 'main.typ'), 'utf8').length).toBeGreaterThan(20000);
    const fonts = ws.listAssets().filter((a) => a.kind === 'font');
    expect(fonts.map((f) => f.filename)).toContain('Poppins-Regular.ttf');
    expect(fonts.find((f) => f.filename === 'Poppins-Regular.ttf')?.fontFamily).toBe('Poppins');
    const lab = r.imported.find((w) => w.name === 'ece-2300L-lab1')!;
    expect(openWorkspace(lab.path).listAssets().filter((a) => a.kind === 'image')).toHaveLength(3);
    // running twice creates nothing new
    expect(importLegacy({ legacyDir: path.join(OLD, 'data'), dataDir, log: () => {} }).imported).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Write `server/legacy-import.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { AssetMeta, WorkspaceJson } from '../src/types';
import { ensureDir, readJson, safeDirName, uniqueDirName } from './fsx';
import { createSettingsStore } from './settings';
import { openWorkspace } from './workspace';

interface LegacyAsset { id: string; kind: 'image' | 'font'; filename: string; width?: number | null; height?: number | null; crop?: AssetMeta['crop']; blurs?: AssetMeta['blurs']; fontFamily?: string | null }
interface LegacyDoc { id: string; name: string; folderId: string | null; source: string; assets: LegacyAsset[]; createdAt: number }

export function importLegacy(opts: { legacyDir: string; dataDir: string; log?: (...a: unknown[]) => void }) {
  const log = opts.log ?? ((...a: unknown[]) => console.log('[import-legacy]', ...a));
  const settings = createSettingsStore(opts.dataDir);
  const workspacesDir = path.join(opts.dataDir, 'workspaces');
  ensureDir(workspacesDir);
  const folders = readJson<{ folders?: Array<{ id: string; name: string }> }>(path.join(opts.legacyDir, 'folders.json'), {}).folders ?? [];
  const groupOf = (id: string | null) => folders.find((f) => f.id === id)?.name ?? null;
  const docsDir = path.join(opts.legacyDir, 'documents');
  const imported: Array<{ name: string; group: string | null; path: string; assets: number }> = [];
  const already = new Set(settings.listWorkspaces().map((w) => w.name));

  for (const file of fs.readdirSync(docsDir).filter((f) => f.endsWith('.json')).sort()) {
    const doc = readJson<LegacyDoc | null>(path.join(docsDir, file), null);
    if (!doc || typeof doc.source !== 'string') { log('skipping unreadable', file); continue; }
    if (already.has(doc.name)) { log('already imported', doc.name); continue; }
    const dir = path.join(workspacesDir, uniqueDirName(workspacesDir, safeDirName(doc.name)));
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, 'main.typ'), doc.source);
    const meta: WorkspaceJson = { version: 1, assets: {}, fonts: {} };
    let count = 0;
    for (const a of doc.assets ?? []) {
      const blob = path.join(opts.legacyDir, 'blobs', a.id);
      if (!fs.existsSync(blob)) { log(`missing blob for ${doc.name}/${a.filename}`); continue; }
      const sub = a.kind === 'font' ? 'fonts' : 'assets';
      ensureDir(path.join(dir, sub));
      fs.copyFileSync(blob, path.join(dir, sub, a.filename));
      const id = `${sub}/${a.filename}`;
      if (a.kind === 'font') meta.fonts[id] = { family: a.fontFamily ?? null };
      else if (a.crop || (a.blurs && a.blurs.length) || a.width || a.height) meta.assets[id] = { crop: a.crop ?? null, blurs: a.blurs ?? null, width: a.width ?? null, height: a.height ?? null };
      count += 1;
    }
    if (Object.keys(meta.assets).length || Object.keys(meta.fonts).length) openWorkspace(dir).writeMeta(meta);
    settings.addWorkspace({ path: dir, name: doc.name, group: groupOf(doc.folderId), library: true });
    already.add(doc.name);
    imported.push({ name: doc.name, group: groupOf(doc.folderId), path: dir, assets: count });
    log(`imported ${doc.name} (${count} assets)`);
  }
  return { imported };
}
```

- [ ] **Step 3: Write `server/cli.ts`**

```ts
import path from 'node:path';
import { importLegacy } from './legacy-import';

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'import-legacy') {
  const legacyDir = rest[0];
  const flag = rest.indexOf('--data-dir');
  const dataDir = path.resolve(flag >= 0 ? rest[flag + 1]! : process.env.DATA_DIR ?? './data');
  if (!legacyDir) { console.error('usage: bun server/cli.ts import-legacy <legacyDir> [--data-dir <dir>]'); process.exit(2); }
  const r = importLegacy({ legacyDir: path.resolve(legacyDir), dataDir });
  console.log(`imported ${r.imported.length} workspace(s) into ${dataDir}`);
} else {
  console.error('commands: import-legacy');
  process.exit(2);
}
```

- [ ] **Step 4: Run, typecheck, commit**

Run: `bunx vitest run --project server server/legacy-import.test.ts` → pass. Do **not** run the import against the real `%LOCALAPPDATA%` yet (plan 3 does the cutover); do run it into the dev data dir so plan 2 has real content to render: `bun server/cli.ts import-legacy "C:/Users/rober/Desktop/typst-editor/recovered-from-docker/data" --data-dir ./data`.

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(server): legacy Typst Figure Studio import" -- advanced-typst-editor
```

---

## Plan 1 self-review (done while writing; re-run before execution)

- Spec coverage: 3.1/3.2 (Tasks 3 to 5), 4.1 modules (Tasks 3 to 13; `config`, `fsx`, `paths`, `http` replace the spec's single `config.ts`), 4.2 routes (Task 7 + 12 + 13), 4.3 (Task 5), 4.4 (Tasks 6, 7), 4.5 (Task 9), 4.6 (Task 13), 4.7 (Tasks 10 to 12), 4.8 (Task 12), 8 (Task 14). The spec's "asset id relative to assets/" wording is superseded by `src/types.ts`: ids are workspace-relative (`assets/...`, `fonts/...`); the spec is amended in Task 15 of plan 2.
- Placeholders: none. Every step has code or an exact copy instruction.
- Names used across tasks: `WorkspaceFs` methods (Tasks 4, 5, 7, 9, 13), `WorkspaceService` (7, 9, 12, 13), `BackupApi`/`Backup` (12, 13), `CompileApi` (9, 13), `ToolDeps` (13), `MirrorItem` (10, 11, 12), `HttpError` everywhere. `heightPt` field name on `ScreenshotSlot` is verified in Task 13 step 4.

Next: `docs/superpowers/plans/2026-09-03-typst-studio-2-frontend.md`.

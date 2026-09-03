# Typst Studio, plan 2 of 3: frontend (React) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Typst Studio UI served by the plan-1 server: BTCT's Typst tab (editor, live preview, assets rail with folders, crop/blur, figure slots, search, click-to-source, custom fonts, PDF/SVG export) ported to a single-user, file-backed workspace model, plus a workspace sidebar, folder browser, settings (backups, MCP, CLI, redaction) and a disk-change bar.

**Architecture:** Same stack as BTCT so components port with import-path edits: React 19, Vite 8, Tailwind 4, CodeMirror 6, typst.ts 0.7 compiling in the browser. One zustand store (`useAppStore`) exposes the *same action names* BTCT's typst components already call, backed by the REST API and the SSE stream instead of Yjs. The editor is a plain CodeMirror document autosaved to `main.typ`.

**Tech Stack:** react 19.2, @vitejs/plugin-react 6, tailwindcss 4.3 (+ @tailwindcss/vite), @codemirror/* 6, @lezer/highlight, @myriaddreamin/typst.ts 0.7.0 (+ web-compiler, renderer), lucide-react, zustand 5, clsx, tailwind-merge, vitest 4 (jsdom, @testing-library/jest-dom).

**Spec:** `advanced-typst-editor/docs/superpowers/specs/2026-09-03-typst-studio-design.md` sections 3, 5. Requires plan 1 complete (`bun run dev:server` serves the API on 8090 with the six imported workspaces in `./data`).

## Global Constraints

- Same commit rule and trailer as plan 1 (`git add advanced-typst-editor && git commit -m "..." -- advanced-typst-editor` from the repo root; never touch the staged `Chemistry Tool` entries).
- `$BTCT` = `C:\Users\rober\Desktop\cptc-2026\BeenThereConqueredThat` (read-only). `$OLD` = `C:\Users\rober\Desktop\typst-editor\recovered-from-docker` (read-only).
- **Port, do not rewrite.** For every component listed as "ported", copy the BTCT file first, then apply only the edits the task lists. Keep BTCT's comments and class names. A ported file's behaviour that the task does not mention stays as it is.
- **The store keeps BTCT's action names** (`typstAssets`, `assetFolders`, `activeWorkspaceId`, `addTypstAsset`, `setTypstAssetCrop`, `renameTypstAsset`, `deleteTypstAsset`, `moveTypstAssetToFolder`, `createAssetFolder`, `renameAssetFolder`, `moveAssetFolder`, `deleteAssetFolder`, `loadTypstAssets`) with the same signatures, and is exported as `useAppStore` from `src/stores/index.ts`, so ported components need no store edits.
- Asset ids are workspace-relative paths (`assets/findings/login.png`, `fonts/Inter.ttf`); the Typst path is `'/' + id`. `TypstAsset.folderId` is the directory relative to `assets/` or null. `AssetFolder.id` is that directory path. (Task 15 amends the spec's wording to match.)
- Every fetch sends `X-Client-Id` (a per-tab random id) so the server can tell the tab's own writes from others.
- Byte caches are keyed by asset id + etag; never by id alone.
- Nothing in `src/` imports Yjs, `y-codemirror.next`, `@/auth/*`, `@/realtime/*`, `@/lib/editor-prefs`, or `@/stores/theme-store`. Grep for these before every commit: zero hits.
- Tests: `bunx vitest run --project ui`. Typecheck: `bun run typecheck`. Both pass before every commit.
- Verification in a real browser (Task 22) uses the Vite dev server on `http://127.0.0.1:5173` with the API proxied to 8090.

## File structure

```
advanced-typst-editor/
  index.html  src/main.tsx  src/App.tsx  src/index.css
  scripts/fonts.ts                 copies the 17 default typst.ts fonts into public/fonts
  public/fonts/                    generated, gitignored
  src/lib/utils.ts                 cn()
  src/lib/typst-compiler.ts        ported; fonts from /fonts/
  src/lib/typst-language.ts        ported unchanged
  src/lib/typst-assets.ts          ported; id/etag-based fetch, new upload route
  src/lib/folder-paths.ts          pure: folder id <-> API path mapping (tested)
  src/lib/autosave.ts              pure: debounced save scheduler (tested)
  src/api/client.ts                typed fetch wrappers for every route
  src/api/events.ts                EventSource with reconnect
  src/stores/index.ts              useAppStore
  src/hooks/use-workspace-file.ts  load/edit/save one text file, external-change detection
  src/components/ui/Portal.tsx, ConfirmDialog.tsx        ported unchanged
  src/components/typst/TypstEditor.tsx                   ported; no Yjs
  src/components/typst/TypstPreview.tsx, TypstSearchPanel.tsx, FigureViewport.tsx   ported unchanged
  src/components/typst/PlaceScreenshotDialog.tsx        ported; redaction default from settings
  src/components/typst/TypstAssetsPanel.tsx              ported; folders from the tree
  src/components/typst/TypstView.tsx                     ported; file-backed source, file switcher
  src/components/typst/DiskChangeBar.tsx                 new
  src/components/sidebar/Sidebar.tsx                     new
  src/components/ui/FolderBrowserDialog.tsx              new
  src/components/settings/SettingsView.tsx               new
  src/test/*.test.ts(x)
```

---

### Task 15: UI scaffold, design tokens, local fonts, compiler port

**Files:**
- Create: `index.html`, `src/main.tsx`, `src/App.tsx`, `src/index.css`, `src/lib/utils.ts`, `src/lib/typst-compiler.ts`, `src/lib/typst-language.ts`, `scripts/fonts.ts`, `src/test/fonts-manifest.test.ts`
- Modify: `package.json`, `vite.config.ts`, `.gitignore`, `src/test/setup.ts`, the spec (one wording fix)

- [ ] **Step 1: Add dependencies**

```bash
cd advanced-typst-editor
bun add react@^19.2 react-dom@^19.2 zustand@^5 clsx tailwind-merge lucide-react \
  @codemirror/state @codemirror/view @codemirror/commands @codemirror/language @codemirror/search @lezer/highlight \
  @myriaddreamin/typst.ts@0.7.0 @myriaddreamin/typst-ts-web-compiler@0.7.0 @myriaddreamin/typst-ts-renderer@0.7.0
bun add -d @vitejs/plugin-react@^6 @tailwindcss/vite@^4.3 tailwindcss@^4.3 @types/react@^19 @types/react-dom@^19 @testing-library/jest-dom @testing-library/react
```

Add scripts to `package.json`: `"dev": "vite"`, `"build": "tsc -p tsconfig.json --noEmit && vite build"`, `"fonts": "bun scripts/fonts.ts"`, `"preview": "vite preview"`. Add `public/fonts/` to `.gitignore`. Put `import '@testing-library/jest-dom';` in `src/test/setup.ts`.

- [ ] **Step 2: `vite.config.ts`** (replace the plan-1 file; keep the test projects)

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8090', '/mcp': 'http://127.0.0.1:8090' },
  },
  // The typst.ts packages ship wasm-pack shims + large wasm that esbuild's dep
  // pre-bundler mishandles; they are loaded lazily via dynamic import + `?url`.
  optimizeDeps: { exclude: ['@myriaddreamin/typst.ts', '@myriaddreamin/typst-ts-web-compiler', '@myriaddreamin/typst-ts-renderer'] },
  test: {
    projects: [
      { extends: true, test: { name: 'ui', environment: 'jsdom', globals: true, include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], setupFiles: ['./src/test/setup.ts'] } },
      { extends: true, test: { name: 'server', environment: 'node', globals: true, include: ['server/**/*.test.ts'], testTimeout: 20000 } },
    ],
  },
});
```

- [ ] **Step 3: `index.html`, `src/main.tsx`, `src/App.tsx`, `src/lib/utils.ts`**

`index.html`:

```html
<!DOCTYPE html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Typst Studio</title>
  </head>
  <body class="bg-background text-foreground">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
```

`src/App.tsx` (placeholder until Task 20):

```tsx
export default function App() {
  return <div className="flex h-screen items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">Typst Studio</div>;
}
```

`src/lib/utils.ts`: copy `$BTCT/src/lib/utils.ts` (the `cn` helper).

- [ ] **Step 4: `src/index.css`**

Copy lines 1 through 178 of `$BTCT/src/index.css` (Tailwind import, `@custom-variant dark`, the `:root` and `.dark` token blocks, `body`, transitions, selection, scrollbars, reduced-motion, focus rings). Everything after line 178 is notes/graph/code-block styling for BTCT features that do not exist here; do not copy it. Then append:

```css
/* Asset tree guide lines (BTCT drew these in its glass skin). */
.atree-row { position: relative; }
.atree-guide { position: absolute; left: 0; top: 0; bottom: 0; width: 1px; background: hsl(var(--border)); }
```

Read the copied block once: if it references a CSS variable defined only after line 178 (grep `var(--` names against the token list), add that variable to `:root`/`.dark` with BTCT's value rather than deleting the rule.

- [ ] **Step 5: `scripts/fonts.ts` and its test**

```ts
// Puts the 17 fonts typst.ts installs by default under public/fonts, so the
// compiler never touches the CDN (the app must work offline).
import fs from 'node:fs';
import path from 'node:path';

export const FONT_FILES = [
  'DejaVuSansMono-Bold.ttf', 'DejaVuSansMono-BoldOblique.ttf', 'DejaVuSansMono-Oblique.ttf', 'DejaVuSansMono.ttf',
  'LibertinusSerif-Bold.otf', 'LibertinusSerif-BoldItalic.otf', 'LibertinusSerif-Italic.otf', 'LibertinusSerif-Regular.otf',
  'LibertinusSerif-Semibold.otf', 'LibertinusSerif-SemiboldItalic.otf',
  'NewCM10-Bold.otf', 'NewCM10-BoldItalic.otf', 'NewCM10-Italic.otf', 'NewCM10-Regular.otf',
  'NewCMMath-Bold.otf', 'NewCMMath-Book.otf', 'NewCMMath-Regular.otf',
];
const LOCAL = 'C:/Users/rober/Desktop/typst-editor/recovered-from-docker/fonts';
const CDN = 'https://cdn.jsdelivr.net/gh/typst/typst-assets@v0.13.1/files/fonts/';

async function main() {
  const out = path.resolve(import.meta.dirname, '..', 'public', 'fonts');
  fs.mkdirSync(out, { recursive: true });
  for (const name of FONT_FILES) {
    const target = path.join(out, name);
    if (fs.existsSync(target)) continue;
    const local = path.join(LOCAL, name);
    if (fs.existsSync(local)) { fs.copyFileSync(local, target); continue; }
    const res = await fetch(CDN + name);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    fs.writeFileSync(target, new Uint8Array(await res.arrayBuffer()));
  }
  console.log(`fonts: ${FONT_FILES.length} files in ${out}`);
}
if (process.argv[1] && /fonts\.ts$/.test(process.argv[1])) void main();
```

`src/test/fonts-manifest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FONT_FILES } from '../../scripts/fonts';

describe('default fonts', () => {
  it('lists the 17 faces typst.ts installs and they are staged locally', () => {
    expect(FONT_FILES).toHaveLength(17);
    const dir = path.resolve(__dirname, '..', '..', 'public', 'fonts');
    for (const f of FONT_FILES) expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
  });
});
```

Run `bun run fonts` once, then the test passes.

- [ ] **Step 6: Port the compiler and the language**

Copy `$BTCT/src/lib/typst-language.ts` unchanged. Copy `$BTCT/src/lib/typst-compiler.ts` and make one edit in `buildInstance`:

```ts
    beforeBuild: [loadFonts(fonts as unknown as Uint8Array[], { assets: ['text'], assetUrlPrefix: '/fonts/' })],
```

(`assetUrlPrefix` is typst.ts's option name; see `node_modules/@myriaddreamin/typst.ts/dist/esm/options.init.mjs`.) Add the comment above it: `// Served by the app itself (scripts/fonts.ts); the default would fetch from jsdelivr.`

- [ ] **Step 7: Amend the spec wording**

In the spec, section 3.1, replace the bullet "The asset id used by the API and the UI is the path relative to `assets/` (e.g. `findings/login.png`)..." with: "The asset id used by the API, the UI and MCP is the workspace-relative path (`assets/findings/login.png`, `fonts/Inter.ttf`); the Typst path is `/` + id. `workspace.json` keys are these ids. Byte caches are keyed by id + etag." Change the `workspace.json` example keys to `"assets/findings/login.png"` and `"fonts/Inter-Regular.ttf"`.

- [ ] **Step 8: Build, test, commit**

Run: `bun run fonts && bunx vitest run --project ui && bun run typecheck && bun run build`. Expected: tests pass, `dist/` produced with `assets/*.wasm` and `fonts/*`.

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(ui): scaffold, design tokens, local default fonts, compiler port" -- advanced-typst-editor
```

---

### Task 16: API client, event stream, store

**Files:**
- Create: `src/api/client.ts`, `src/api/events.ts`, `src/lib/folder-paths.ts`, `src/stores/index.ts`, `src/test/folder-paths.test.ts`, `src/test/store.test.ts`

**Interfaces:**
- Produces: `api` object (every route as a typed function), `connectEvents(onEvent, onStatus)`, `useAppStore` with the BTCT-compatible slice plus workspace/settings/backup actions (listed in Step 4), `folderPathFor`, `renamedFolderPath`, `movedFolderPath`, `CLIENT_ID`.

- [ ] **Step 1: `src/lib/folder-paths.ts` and its test**

```ts
/**
 * BTCT's asset panel thinks in folder records (id, parentId, name). Here a
 * folder id IS its path relative to assets/, so these map panel intentions
 * to API paths.
 */
export function folderPathFor(parentId: string | null, name: string): string {
  const clean = name.trim().replace(/[\\/]/g, '_');
  return parentId ? `${parentId}/${clean}` : clean;
}
export function renamedFolderPath(id: string, name: string): string {
  const parent = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : null;
  return folderPathFor(parent, name);
}
export function movedFolderPath(id: string, parentId: string | null): string {
  const base = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return folderPathFor(parentId, base);
}
```

`src/test/folder-paths.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { folderPathFor, movedFolderPath, renamedFolderPath } from '@/lib/folder-paths';

describe('folder paths', () => {
  it('maps panel intentions to assets/-relative paths', () => {
    expect(folderPathFor(null, ' Findings ')).toBe('Findings');
    expect(folderPathFor('Findings', 'a/b')).toBe('Findings/a_b');
    expect(renamedFolderPath('Findings/auth', 'Auth Bypass')).toBe('Findings/Auth Bypass');
    expect(renamedFolderPath('top', 'x')).toBe('x');
    expect(movedFolderPath('Findings/auth', null)).toBe('auth');
    expect(movedFolderPath('auth', 'Appendix')).toBe('Appendix/auth');
  });
});
```

- [ ] **Step 2: `src/api/client.ts`**

```ts
import type { BackupState, CompileResult, DirListing, McpStatus, RedactionDefaults, SnapshotInfo, TypstAsset, TypstAssetKind, WorkspaceDetail, WorkspaceEntry, WorkspaceStatus, AssetFolder } from '@/types';

export const CLIENT_ID: string = (() => {
  try {
    const k = 'tfs-client-id';
    let v = sessionStorage.getItem(k);
    if (!v) { v = Math.random().toString(36).slice(2, 10); sessionStorage.setItem(k, v); }
    return v;
  } catch { return Math.random().toString(36).slice(2, 10); }
})();

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

async function req<T>(method: string, url: string, body?: unknown, raw = false): Promise<T> {
  const headers: Record<string, string> = { 'x-client-id': CLIENT_ID };
  let payload: BodyInit | undefined;
  if (body instanceof Blob || body instanceof Uint8Array) { headers['content-type'] = 'application/octet-stream'; payload = body as BodyInit; }
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(url, { method, headers, body: payload });
  if (!res.ok) {
    let msg = `${method} ${url} failed (${res.status})`;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* keep */ }
    throw new ApiError(res.status, msg);
  }
  if (raw) return (await res.arrayBuffer()) as unknown as T;
  return (res.status === 204 ? null : await res.json()) as T;
}
const enc = encodeURIComponent;
const wsUrl = (id: string) => `/api/workspaces/${enc(id)}`;
const fileUrl = (id: string, p: string) => `${wsUrl(id)}/files/${p.split('/').map(enc).join('/')}`;
const assetUrl = (id: string, a: string) => `${wsUrl(id)}/assets/${a.split('/').map(enc).join('/')}`;

export const api = {
  health: () => req<{ ok: boolean }>('GET', '/api/health'),
  listWorkspaces: () => req<{ workspaces: WorkspaceStatus[] }>('GET', '/api/workspaces').then((r) => r.workspaces),
  createWorkspace: (input: { name: string; group?: string | null; source?: string }) => req<{ workspace: WorkspaceEntry }>('POST', '/api/workspaces', input).then((r) => r.workspace),
  openFolder: (path: string, name?: string) => req<{ workspace: WorkspaceEntry }>('POST', '/api/workspaces/open', { path, name }).then((r) => r.workspace),
  patchWorkspace: (id: string, patch: { name?: string; group?: string | null }) => req<{ workspace: WorkspaceEntry }>('PATCH', wsUrl(id), patch).then((r) => r.workspace),
  deleteWorkspace: (id: string) => req<{ ok: true }>('DELETE', wsUrl(id)),
  getWorkspace: (id: string) => req<WorkspaceDetail>('GET', wsUrl(id)),
  async readText(id: string, path: string): Promise<{ text: string; etag: string }> {
    const res = await fetch(fileUrl(id, path), { headers: { 'x-client-id': CLIENT_ID } });
    if (!res.ok) throw new ApiError(res.status, `cannot read ${path}`);
    return { text: await res.text(), etag: res.headers.get('etag') ?? '' };
  },
  readBytes: (id: string, path: string) => req<ArrayBuffer>('GET', fileUrl(id, path), undefined, true).then((b) => new Uint8Array(b)),
  writeText: (id: string, path: string, text: string, keepalive = false) =>
    fetch(fileUrl(id, path), { method: 'PUT', headers: { 'x-client-id': CLIENT_ID, 'content-type': 'application/octet-stream' }, body: new TextEncoder().encode(text), keepalive }).then((r) => { if (!r.ok) throw new ApiError(r.status, `save failed (${r.status})`); }),
  deleteFile: (id: string, path: string) => req<{ ok: true }>('DELETE', fileUrl(id, path)),
  uploadAsset: (id: string, file: Blob, opts: { kind: TypstAssetKind; filename: string; folder: string | null; family?: string | null }) => {
    const qs = new URLSearchParams({ kind: opts.kind, filename: opts.filename });
    if (opts.folder) qs.set('folder', opts.folder);
    if (opts.family) qs.set('family', opts.family);
    return req<{ asset: TypstAsset }>('POST', `${wsUrl(id)}/assets?${qs}`, file).then((r) => r.asset);
  },
  patchAsset: (id: string, assetId: string, patch: Record<string, unknown>) => req<{ asset: TypstAsset }>('PATCH', assetUrl(id, assetId), patch).then((r) => r.asset),
  renameAsset: (id: string, assetId: string, stem: string) => req<{ asset: TypstAsset; references: number }>('PATCH', assetUrl(id, assetId), { stem }),
  moveAsset: (id: string, assetId: string, folder: string | null) => req<{ asset: TypstAsset; references: number }>('PATCH', assetUrl(id, assetId), { folder }),
  deleteAsset: (id: string, assetId: string) => req<{ ok: true }>('DELETE', assetUrl(id, assetId)),
  createFolder: (id: string, path: string) => req<{ folder: AssetFolder }>('POST', `${wsUrl(id)}/asset-folders`, { path }).then((r) => r.folder),
  renameFolder: (id: string, path: string, newPath: string) => req<{ references: number }>('PATCH', `${wsUrl(id)}/asset-folders`, { path, newPath }),
  deleteFolder: (id: string, path: string) => req<{ references: number; moved: number }>('DELETE', `${wsUrl(id)}/asset-folders?path=${enc(path)}`),
  compile: (id: string, file?: string) => req<CompileResult>('POST', `${wsUrl(id)}/compile`, { file }),
  exportPdfTo: (id: string, to: string, file?: string) => req<{ path: string; baked: number }>('POST', `${wsUrl(id)}/export-pdf`, { to, file }),
  getSettings: () => req<{ typstCli: string | null; redaction: RedactionDefaults }>('GET', '/api/settings'),
  patchSettings: (patch: { typstCli?: string | null; redaction?: Partial<RedactionDefaults> }) => req<{ typstCli: string | null; redaction: RedactionDefaults }>('PATCH', '/api/settings', patch),
  getBackup: () => req<{ backup: BackupState }>('GET', '/api/backup').then((r) => r.backup),
  patchBackup: (patch: Record<string, unknown>) => req<{ backup: BackupState }>('PATCH', '/api/backup', patch).then((r) => r.backup),
  runBackup: () => req<{ backup: BackupState }>('POST', '/api/backup/run').then((r) => r.backup),
  listSnapshots: (destination: string) => req<{ snapshots: SnapshotInfo[] }>('GET', `/api/backup/snapshots?destination=${enc(destination)}`).then((r) => r.snapshots),
  restoreSnapshot: (destination: string, snapshot: string) => req<{ restored: number }>('POST', '/api/backup/restore', { destination, snapshot }),
  browse: (path: string) => req<DirListing>('GET', `/api/fs/browse?path=${enc(path)}`),
  mcpStatus: () => req<McpStatus>('GET', '/api/mcp/status'),
};
```

- [ ] **Step 3: `src/api/events.ts`**

```ts
import type { ServerEvent } from '@/types';

/** Subscribe to the server's SSE stream; reconnects with backoff. Returns a disposer. */
export function connectEvents(onEvent: (ev: ServerEvent) => void, onStatus?: (online: boolean) => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let delay = 1000;
  const types: ServerEvent['type'][] = ['workspace.changed', 'workspaces.changed', 'backup.state', 'mcp.clients'];
  const open = () => {
    if (closed) return;
    es = new EventSource('/api/events');
    es.addEventListener('hello', () => { delay = 1000; onStatus?.(true); });
    for (const t of types) es.addEventListener(t, (e) => { try { onEvent(JSON.parse((e as MessageEvent).data) as ServerEvent); } catch { /* ignore */ } });
    es.onerror = () => { es?.close(); es = null; onStatus?.(false); if (!closed) { setTimeout(open, delay); delay = Math.min(delay * 2, 15000); } };
  };
  open();
  return () => { closed = true; es?.close(); };
}
```

- [ ] **Step 4: `src/stores/index.ts`**

```ts
import { create } from 'zustand';
import { api } from '@/api/client';
import { folderPathFor, movedFolderPath, renamedFolderPath } from '@/lib/folder-paths';
import type { AssetFolder, BackupState, BlurRegion, CropRect, ID, McpStatus, RedactionDefaults, ServerEvent, TypstAsset, TypstAssetKind, WorkspaceDetail, WorkspaceStatus } from '@/types';

export interface ChangeNotice { id: ID; paths: string[]; origin: string | null; seq: number }

export interface AppState {
  workspaces: WorkspaceStatus[];
  activeWorkspaceId: ID | null;
  detail: WorkspaceDetail | null;
  typstAssets: TypstAsset[];
  assetFolders: AssetFolder[];
  redaction: RedactionDefaults;
  typstCli: string | null;
  backup: BackupState | null;
  mcp: McpStatus | null;
  online: boolean;
  lastChange: ChangeNotice | null;
  settingsOpen: boolean;

  loadWorkspaces(): Promise<void>;
  selectWorkspace(id: ID | null): Promise<void>;
  createWorkspace(name: string, group?: string | null): Promise<WorkspaceStatus | null>;
  openFolder(path: string): Promise<void>;
  renameWorkspace(id: ID, name: string): Promise<void>;
  setWorkspaceGroup(id: ID, group: string | null): Promise<void>;
  removeWorkspace(id: ID): Promise<void>;

  // BTCT-compatible asset slice
  loadTypstAssets(): Promise<void>;
  addTypstAsset(file: File, kind: TypstAssetKind, folderId?: ID | null): Promise<TypstAsset>;
  moveTypstAssetToFolder(assetId: ID, folderId: ID | null): Promise<void>;
  createAssetFolder(name: string, parentId?: ID | null): Promise<AssetFolder>;
  renameAssetFolder(id: ID, name: string): Promise<void>;
  moveAssetFolder(id: ID, parentId: ID | null): Promise<void>;
  deleteAssetFolder(id: ID): Promise<void>;
  setTypstAssetCrop(id: ID, crop: CropRect | null, blurs?: BlurRegion[] | null): Promise<void>;
  renameTypstAsset(id: ID, stem: string): Promise<string>;
  deleteTypstAsset(id: ID): Promise<void>;

  loadSettings(): Promise<void>;
  saveSettings(patch: { typstCli?: string | null; redaction?: Partial<RedactionDefaults> }): Promise<void>;
  loadBackup(): Promise<void>;
  loadMcp(): Promise<void>;
  setSettingsOpen(open: boolean): void;
  handleEvent(ev: ServerEvent): void;
  setOnline(online: boolean): void;
}

let seq = 0;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

export const useAppStore = create<AppState>((set, get) => {
  const applyDetail = (detail: WorkspaceDetail) => set({ detail, typstAssets: detail.assets, assetFolders: detail.folders });
  const reloadDetail = async () => {
    const id = get().activeWorkspaceId;
    if (!id) return;
    try { applyDetail(await api.getWorkspace(id)); } catch { /* missing: the sidebar shows it */ }
  };
  return {
    workspaces: [], activeWorkspaceId: null, detail: null, typstAssets: [], assetFolders: [],
    redaction: { style: 'gaussian', strength: 1 }, typstCli: null, backup: null, mcp: null, online: false, lastChange: null, settingsOpen: false,

    async loadWorkspaces() { set({ workspaces: await api.listWorkspaces() }); },
    async selectWorkspace(id) {
      set({ activeWorkspaceId: id, detail: null, typstAssets: [], assetFolders: [] });
      if (id) await reloadDetail();
      try { localStorage.setItem('tfs-active-workspace', id ?? ''); } catch { /* ignore */ }
    },
    async createWorkspace(name, group) {
      const w = await api.createWorkspace({ name, group: group ?? null });
      await get().loadWorkspaces();
      await get().selectWorkspace(w.id);
      return get().workspaces.find((x) => x.id === w.id) ?? null;
    },
    async openFolder(path) { const w = await api.openFolder(path); await get().loadWorkspaces(); await get().selectWorkspace(w.id); },
    async renameWorkspace(id, name) { await api.patchWorkspace(id, { name }); await get().loadWorkspaces(); if (get().activeWorkspaceId === id) await reloadDetail(); },
    async setWorkspaceGroup(id, group) { await api.patchWorkspace(id, { group }); await get().loadWorkspaces(); },
    async removeWorkspace(id) { await api.deleteWorkspace(id); if (get().activeWorkspaceId === id) await get().selectWorkspace(null); await get().loadWorkspaces(); },

    loadTypstAssets: reloadDetail,
    async addTypstAsset(file, kind, folderId) {
      const id = get().activeWorkspaceId!;
      const asset = await api.uploadAsset(id, file, { kind, filename: file.name, folder: folderId ?? null });
      await reloadDetail();
      return get().typstAssets.find((a) => a.id === asset.id) ?? asset;
    },
    async moveTypstAssetToFolder(assetId, folderId) { await api.moveAsset(get().activeWorkspaceId!, assetId, folderId); await reloadDetail(); },
    async createAssetFolder(name, parentId) { const f = await api.createFolder(get().activeWorkspaceId!, folderPathFor(parentId ?? null, name)); await reloadDetail(); return f; },
    async renameAssetFolder(id, name) { await api.renameFolder(get().activeWorkspaceId!, id, renamedFolderPath(id, name)); await reloadDetail(); },
    async moveAssetFolder(id, parentId) { await api.renameFolder(get().activeWorkspaceId!, id, movedFolderPath(id, parentId)); await reloadDetail(); },
    async deleteAssetFolder(id) { await api.deleteFolder(get().activeWorkspaceId!, id); await reloadDetail(); },
    async setTypstAssetCrop(id, crop, blurs) {
      const patch: Record<string, unknown> = { crop };
      if (blurs !== undefined) patch.blurs = blurs;
      const asset = await api.patchAsset(get().activeWorkspaceId!, id, patch);
      set((s) => ({ typstAssets: s.typstAssets.map((a) => (a.id === id ? asset : a)) }));
    },
    async renameTypstAsset(id, stem) { const r = await api.renameAsset(get().activeWorkspaceId!, id, stem); await reloadDetail(); return r.asset.filename; },
    async deleteTypstAsset(id) { await api.deleteAsset(get().activeWorkspaceId!, id); await reloadDetail(); },

    async loadSettings() { const s = await api.getSettings(); set({ redaction: s.redaction, typstCli: s.typstCli }); },
    async saveSettings(patch) { const s = await api.patchSettings(patch); set({ redaction: s.redaction, typstCli: s.typstCli }); },
    async loadBackup() { try { set({ backup: await api.getBackup() }); } catch { set({ backup: null }); } },
    async loadMcp() { try { set({ mcp: await api.mcpStatus() }); } catch { set({ mcp: null }); } },
    setSettingsOpen: (open) => set({ settingsOpen: open }),
    setOnline: (online) => set({ online }),
    handleEvent(ev) {
      switch (ev.type) {
        case 'workspaces.changed': void get().loadWorkspaces(); break;
        case 'backup.state': set({ backup: ev.state }); break;
        case 'mcp.clients': set((s) => ({ mcp: { endpoint: s.mcp?.endpoint ?? '/mcp', authRequired: s.mcp?.authRequired ?? false, clients: ev.clients } })); break;
        case 'workspace.changed':
          if (ev.id !== get().activeWorkspaceId) return;
          set({ lastChange: { id: ev.id, paths: ev.paths, origin: ev.origin, seq: ++seq } });
          if (reloadTimer) clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => { reloadTimer = null; void reloadDetail(); }, 150);
          break;
      }
    },
  };
});
```

- [ ] **Step 5: `src/test/store.test.ts`** (mocks `fetch`)

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '@/stores';

const calls: Array<{ method: string; url: string; body?: unknown }> = [];
function mockFetch(routes: Record<string, unknown>) {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    const key = `${method} ${url.split('?')[0]}`;
    const hit = routes[key] ?? routes[`${method} *`];
    return new Response(JSON.stringify(hit ?? {}), { status: hit === undefined ? 404 : 200, headers: { 'content-type': 'application/json' } });
  }));
}
const detail = { entry: { id: 'w1', name: 'A', path: 'C:/a', group: null, library: true, createdAt: 0, openedAt: 0 }, files: [], meta: { version: 1, assets: {}, fonts: {} }, assets: [], folders: [{ id: 'Findings/auth', name: 'auth', parentId: 'Findings', createdAt: 0, updatedAt: 0 }] };

beforeEach(() => { useAppStore.setState({ activeWorkspaceId: 'w1', detail: null, typstAssets: [], assetFolders: [] }); });

describe('store folder actions map to API paths', () => {
  it('create, rename, move, delete', async () => {
    mockFetch({ 'GET /api/workspaces/w1': detail, 'POST /api/workspaces/w1/asset-folders': { folder: detail.folders[0] }, 'PATCH /api/workspaces/w1/asset-folders': { references: 0 }, 'DELETE /api/workspaces/w1/asset-folders': { references: 0, moved: 0 } });
    const s = useAppStore.getState();
    await s.createAssetFolder('auth', 'Findings');
    expect(calls[0]).toMatchObject({ method: 'POST', body: { path: 'Findings/auth' } });
    await s.renameAssetFolder('Findings/auth', 'Auth Bypass');
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ path: 'Findings/auth', newPath: 'Findings/Auth Bypass' });
    await s.moveAssetFolder('Findings/auth', null);
    expect(calls.filter((c) => c.method === 'PATCH')[1]?.body).toEqual({ path: 'Findings/auth', newPath: 'auth' });
    await s.deleteAssetFolder('Findings/auth');
    expect(calls.find((c) => c.method === 'DELETE')?.url).toContain('path=Findings%2Fauth');
    expect(useAppStore.getState().assetFolders).toEqual(detail.folders);
  });
  it('reloads the active workspace on a change event, debounced', async () => {
    vi.useFakeTimers();
    mockFetch({ 'GET /api/workspaces/w1': detail });
    const s = useAppStore.getState();
    s.handleEvent({ type: 'workspace.changed', id: 'w1', paths: ['main.typ'], origin: 'mcp' });
    s.handleEvent({ type: 'workspace.changed', id: 'w1', paths: ['workspace.json'], origin: 'mcp' });
    s.handleEvent({ type: 'workspace.changed', id: 'other', paths: ['main.typ'], origin: null });
    expect(useAppStore.getState().lastChange).toMatchObject({ paths: ['workspace.json'], seq: 2 });
    await vi.advanceTimersByTimeAsync(200);
    expect(calls.filter((c) => c.url === '/api/workspaces/w1')).toHaveLength(1);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 6: Run, typecheck, commit**

Run: `bunx vitest run --project ui` → all pass; `bun run typecheck` passes.

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(ui): API client, SSE connection, BTCT-compatible app store" -- advanced-typst-editor
```

---

### Task 17: Asset bytes pipeline, autosave, the editor without Yjs, disk-change bar

**Files:**
- Create: `src/lib/typst-assets.ts` (ported), `src/lib/autosave.ts`, `src/hooks/use-workspace-file.ts`, `src/components/typst/TypstEditor.tsx` (ported), `src/components/typst/DiskChangeBar.tsx`, `src/test/autosave.test.ts`, `src/test/typst-assets.test.ts`

**Interfaces:**
- Produces: `assetPath(asset)`, `fetchAssetBytes(id)`, `resolveAssetBytes(asset)`, `readImageSize`, `readFontFamily`, `blurredPreviewBytes`, `detectContentBounds`, `cropImageBytes` (unchanged signatures from BTCT); `createAutosave({delayMs, save}) -> { change(text), flush(): Promise<void>, dirty(): boolean, dispose() }`; `useWorkspaceFile(workspaceId, path) -> { text, loading, dirty, externalChange, setText, flush, reload, keepMine }`; `TypstEditor` props `{ value: string; onChange: (next: string) => void; docKey: string }`; module functions `revealTypstRange`, `getTypstCaret`, `setTypstSearchRequest`, `insertAtTypstCursor`, `setTypstEditorContent(next)`.

- [ ] **Step 1: Port `src/lib/typst-assets.ts`**

Copy `$BTCT/src/lib/typst-assets.ts`, then:

1. Delete `import { API_URL, useAuthStore } from '@/auth/auth-store';` and the `authHeaders()` function. Add `import { api } from '@/api/client';` and `import { useAppStore } from '@/stores';`.
2. Replace `assetPath`:
   ```ts
   /** The Typst path for an asset: what goes inside `#image("…")`. Ids are workspace-relative, so this is just a leading slash. */
   export function assetPath(asset: Pick<TypstAsset, 'id'>): string { return `/${asset.id}`; }
   ```
   and keep `ASSET_DIR = '/assets'` (the panel uses it for display).
3. Replace `uploadAsset` with a thin wrapper: `export async function uploadAsset(file: File | Blob, opts: { workspaceId: string; kind: TypstAssetKind; filename: string; folder?: string | null }): Promise<TypstAsset> { return api.uploadAsset(opts.workspaceId, file, { kind: opts.kind, filename: opts.filename, folder: opts.folder ?? null }); }` and delete `UploadedAsset` and `deleteAssetBytes`.
4. Replace `fetchAssetBytes` so the cache key carries the etag and the bytes come from the files route:
   ```ts
   function assetKey(id: string): { wsId: string; key: string } {
     const s = useAppStore.getState();
     const etag = s.typstAssets.find((a) => a.id === id)?.etag ?? '';
     return { wsId: s.activeWorkspaceId ?? '', key: `${s.activeWorkspaceId}:${id}:${etag}` };
   }
   export function fetchAssetBytes(id: string): Promise<Uint8Array> {
     const { wsId, key } = assetKey(id);
     const hit = rawBytesCache.get(key);
     if (hit) { rawBytesCache.delete(key); rawBytesCache.set(key, hit); return hit; }
     const p = api.readBytes(wsId, id);
     p.catch(() => { rawBytesCache.delete(key); });
     rawBytesCache.set(key, p);
     while (rawBytesCache.size > RAW_CACHE_MAX) { const oldest = rawBytesCache.keys().next().value; if (oldest === undefined) break; rawBytesCache.delete(oldest); }
     return p;
   }
   ```
   Keep `forgetAsset(id)` but make it drop every key starting with `${activeWorkspaceId}:${id}:`.
5. In `resolveAssetBytes`, change the cache key line to include the etag: `const key = \`${asset.id}:${asset.etag}:${claimed}:...\`` (append `:${asset.etag}` after `asset.id`), and the eviction loop's prefix to `${asset.id}:` (unchanged).
6. Keep every other function exactly as copied (`cropImageBytes`, `bakeBlurs`, `renderRegion`, `blurredPreviewBytes`, `detectContentBounds`, `readImageSize`, `readFontFamily`, `GAP_FILL`, `isFullFrame`/`normalizeCrop` re-exports).

`src/test/typst-assets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { assetPath } from '@/lib/typst-assets';

describe('assetPath', () => {
  it('is the id with a leading slash', () => {
    expect(assetPath({ id: 'assets/findings/login.png' })).toBe('/assets/findings/login.png');
    expect(assetPath({ id: 'fonts/Inter.ttf' })).toBe('/fonts/Inter.ttf');
  });
});
```

- [ ] **Step 2: `src/lib/autosave.ts` and its test (write the test first)**

`src/test/autosave.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createAutosave } from '@/lib/autosave';

describe('autosave', () => {
  it('saves once after the quiet period and reports dirty state', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_t: string) => {});
    const a = createAutosave({ delayMs: 500, save });
    a.change('a'); a.change('ab'); a.change('abc');
    expect(a.dirty()).toBe(true);
    await vi.advanceTimersByTimeAsync(499);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('abc');
    expect(a.dirty()).toBe(false);
    vi.useRealTimers();
  });
  it('flush saves immediately and coalesces with an in-flight save', async () => {
    let resolveSave: (() => void) | null = null;
    const save = vi.fn(() => new Promise<void>((r) => { resolveSave = r; }));
    const a = createAutosave({ delayMs: 10_000, save });
    a.change('x');
    const f = a.flush();
    expect(save).toHaveBeenCalledWith('x');
    a.change('xy'); // edited while saving
    resolveSave!();
    await f;
    expect(a.dirty()).toBe(true); // the edit made during the save is still pending
    await a.flush();
    expect(save).toHaveBeenLastCalledWith('xy');
    expect(a.dirty()).toBe(false);
  });
  it('keeps dirty when a save fails', async () => {
    const save = vi.fn(async () => { throw new Error('offline'); });
    const a = createAutosave({ delayMs: 1, save });
    a.change('x');
    await a.flush().catch(() => {});
    expect(a.dirty()).toBe(true);
  });
});
```

`src/lib/autosave.ts`:

```ts
/** Debounced save with a single in-flight write; edits during a save stay pending. */
export function createAutosave(opts: { delayMs: number; save: (text: string) => Promise<void> }) {
  let pending: string | null = null;
  let saving: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = async (): Promise<void> => {
    if (saving) { await saving; }
    if (pending === null) return;
    const text = pending;
    pending = null;
    saving = opts.save(text).catch((err) => { if (pending === null) pending = text; throw err; }).finally(() => { saving = null; });
    await saving;
  };
  return {
    change(text: string) {
      pending = text;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void run().catch(() => {}); }, opts.delayMs);
    },
    async flush() { if (timer) { clearTimeout(timer); timer = null; } await run(); },
    dirty: () => pending !== null || saving !== null,
    dispose() { if (timer) clearTimeout(timer); timer = null; },
  };
}
```

Run `bunx vitest run --project ui src/test/autosave.test.ts` → 3 pass.

- [ ] **Step 3: `src/hooks/use-workspace-file.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, CLIENT_ID } from '@/api/client';
import { createAutosave } from '@/lib/autosave';
import { useAppStore } from '@/stores';

export const AUTOSAVE_MS = 500;

/**
 * One text file of the active workspace: loaded from the API, edited locally,
 * autosaved 500 ms after the last change, on blur and on pagehide. A
 * `workspace.changed` event naming this file from another origin reloads it
 * when the buffer is clean and raises `externalChange` when it is dirty.
 */
export function useWorkspaceFile(workspaceId: string, path: string) {
  const [text, setTextState] = useState('');
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const saver = useRef(createAutosave({ delayMs: AUTOSAVE_MS, save: async (t) => { await api.writeText(workspaceId, path, t); } }));
  const lastChange = useAppStore((s) => s.lastChange);
  const seenSeq = useRef(0);

  const load = useCallback(async () => {
    const r = await api.readText(workspaceId, path);
    setTextState(r.text);
    setDirty(false);
    setExternalChange(false);
  }, [workspaceId, path]);

  useEffect(() => {
    saver.current = createAutosave({ delayMs: AUTOSAVE_MS, save: async (t) => { await api.writeText(workspaceId, path, t); setDirty(false); } });
    setLoading(true);
    void load().finally(() => setLoading(false));
    const s = saver.current;
    const flushKeepalive = () => { void s.flush(); };
    window.addEventListener('pagehide', flushKeepalive);
    window.addEventListener('blur', flushKeepalive);
    return () => { void s.flush(); s.dispose(); window.removeEventListener('pagehide', flushKeepalive); window.removeEventListener('blur', flushKeepalive); };
  }, [workspaceId, path, load]);

  // External edits (MCP, VS Code, restore): reload when clean, ask when dirty.
  useEffect(() => {
    if (!lastChange || lastChange.seq === seenSeq.current) return;
    seenSeq.current = lastChange.seq;
    if (lastChange.id !== workspaceId || !lastChange.paths.includes(path)) return;
    if (lastChange.origin === CLIENT_ID) return;
    if (saver.current.dirty() || dirty) setExternalChange(true);
    else void load();
  }, [lastChange, workspaceId, path, dirty, load]);

  const setText = useCallback((next: string) => { setTextState(next); setDirty(true); saver.current.change(next); }, []);
  const flush = useCallback(() => saver.current.flush(), []);
  const keepMine = useCallback(() => { setExternalChange(false); void saver.current.flush(); }, []);

  return { text, loading, dirty, externalChange, setText, flush, reload: load, keepMine };
}
```

- [ ] **Step 4: Port `src/components/typst/TypstEditor.tsx`**

Copy `$BTCT/src/components/typst/TypstEditor.tsx`, then:

1. Delete the imports of `yjs`, `y-codemirror.next`, `@/realtime/shared-doc`, `@/auth/auth-store`. Add `import { history, historyKeymap } from '@codemirror/commands';` (extend the existing `@codemirror/commands` import) and `import { Compartment } from '@codemirror/state';` is not needed; keep `EditorState`.
2. Replace the header comment's Yjs paragraph with: `// A CodeMirror 6 instance over a plain string. The parent owns the text (see hooks/use-workspace-file.ts); edits flow up through onChange and external replacements flow down through the value prop.`
3. Replace the component:

```tsx
export const TypstEditor = memo(function TypstEditor({ value, onChange, docKey }: { value: string; onChange: (next: string) => void; docKey: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), EditorView.lineWrapping, EditorState.tabSize.of(2),
          history(), typstLanguage(), typstHighlightExtension, editorTheme, highlightSelectionMatches(),
          keymap.of([
            { key: 'Mod-f', preventDefault: true, run: () => { onSearchRequest?.(); return true; } },
            ...historyKeymap, ...defaultKeymap, indentWithTab,
          ]),
          EditorView.updateListener.of((u) => { if (u.docChanged) onChangeRef.current(u.state.doc.toString()); }),
        ],
      }),
    });
    activeView = view;
    viewRef.current = view;
    return () => { if (activeView === view) activeView = null; viewRef.current = null; view.destroy(); };
    // A new document (workspace/file switch) remounts; typing does not (value is only read at mount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // External replacement (reload from disk, search-and-replace, slot placement): apply as one transaction.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    setTypstEditorContent(value);
  }, [value]);

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />;
});
```

4. Add the module function next to `insertAtTypstCursor`:

```ts
/**
 * Replace the whole document with `next` as a minimal change (common prefix
 * and suffix kept), so the caret and undo history survive a rewrite that only
 * touched one slot or one search match. Returns false when no editor is mounted.
 */
export function setTypstEditorContent(next: string): boolean {
  const view = activeView;
  if (!view) return false;
  const cur = view.state.doc.toString();
  if (cur === next) return true;
  let start = 0;
  while (start < cur.length && start < next.length && cur[start] === next[start]) start++;
  let endCur = cur.length, endNext = next.length;
  while (endCur > start && endNext > start && cur[endCur - 1] === next[endNext - 1]) { endCur--; endNext--; }
  view.dispatch({ changes: { from: start, to: endCur, insert: next.slice(start, endNext) } });
  return true;
}
```

Keep `editorTheme`, `revealTypstRange`, `getTypstCaret`, `setTypstSearchRequest`, `insertAtTypstCursor` exactly as copied.

- [ ] **Step 5: `src/components/typst/DiskChangeBar.tsx`**

```tsx
import { RefreshCw } from 'lucide-react';

export function DiskChangeBar({ file, onReload, onKeep }: { file: string; onReload: () => void; onKeep: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-[hsl(var(--status-amber))]/40 bg-[hsl(var(--status-amber))]/10 px-3 py-1.5 text-xs text-[hsl(var(--foreground))]">
      <RefreshCw size={13} className="text-[hsl(var(--status-amber))]" />
      <span className="min-w-0 flex-1 truncate"><b>{file}</b> changed on disk while you have unsaved edits.</span>
      <button type="button" onClick={onReload} className="rounded-md border border-[hsl(var(--border))] px-2 py-0.5 hover:bg-[hsl(var(--accent))]">Reload from disk</button>
      <button type="button" onClick={onKeep} className="rounded-md bg-[hsl(var(--primary))] px-2 py-0.5 text-[hsl(var(--primary-foreground))]">Keep mine</button>
    </div>
  );
}
```

- [ ] **Step 6: Run, typecheck, grep, commit**

Run: `bunx vitest run --project ui && bun run typecheck && grep -rn "yjs\|y-codemirror\|@/auth\|@/realtime\|editor-prefs\|theme-store" src/` (no hits).

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(ui): asset bytes by id+etag, autosave, CodeMirror editor without Yjs, disk-change bar" -- advanced-typst-editor
```

---

### Task 18: Port preview, search panel, figure viewport, place dialog, portal, confirm dialog

**Files:**
- Create (copied from `$BTCT`): `src/components/ui/Portal.tsx`, `src/components/ui/ConfirmDialog.tsx`, `src/components/typst/TypstPreview.tsx`, `src/components/typst/TypstSearchPanel.tsx`, `src/components/typst/FigureViewport.tsx`, `src/components/typst/PlaceScreenshotDialog.tsx`
- Create: `src/test/place-dialog-defaults.test.tsx`

**Interfaces:**
- Consumes: `useAppStore(s => s.redaction)` (Task 16); everything else from Tasks 2, 15, 17.
- Produces: the components with BTCT's props (`TypstPreview { source, revision?, onRevealSource?, onRevealImage? }`, `TypstSearchPanel { source, caret, onReveal, onReplaceSource, onClose }`, `PlaceScreenshotDialog { asset, source, onApply, onUnplace, onAddSlot, onRename, onClose, hidePlacement? }`, `FigureViewport`, `Portal`, `ConfirmDialog`).

- [ ] **Step 1: Copy the six files**

```bash
cd advanced-typst-editor
cp "$BTCT/src/components/ui/Portal.tsx" src/components/ui/Portal.tsx
cp "$BTCT/src/components/ui/ConfirmDialog.tsx" src/components/ui/ConfirmDialog.tsx
for f in TypstPreview TypstSearchPanel FigureViewport PlaceScreenshotDialog; do cp "$BTCT/src/components/typst/$f.tsx" src/components/typst/$f.tsx; done
```

`Portal`, `ConfirmDialog`, `TypstPreview`, `TypstSearchPanel`, `FigureViewport` need no edits (their imports are `react`, `react-dom`, `lucide-react`, `@/lib/*`, `@/types`, `@/components/ui/Portal`, all present).

- [ ] **Step 2: Edit `PlaceScreenshotDialog.tsx`**

1. Delete the three imports: `useAuthStore` from `@/auth/auth-store`, `useThemeStore` from `@/stores/theme-store`, `resolveBlurStrengthPolicy, resolvePrefs` from `@/lib/editor-prefs`. Add `import { useAppStore } from '@/stores';`.
2. Replace the block

```tsx
  const adminBlur = useThemeStore((s) => s.blurDefaults);
  const authUser = useAuthStore((s) => s.user);
  const defaultStrengths = useMemo(
    () => resolveBlurStrengthPolicy(adminBlur, resolvePrefs(authUser).blurDefaults),
    [adminBlur, authUser],
  );
```

with

```tsx
  // New regions start at the strength chosen in Settings > Redaction (BTCT had
  // an admin policy plus per-account overrides; here there is one user).
  const redaction = useAppStore((s) => s.redaction);
  const defaultStrengths = useMemo(
    () => ({ gaussian: redaction.strength, pixelate: redaction.strength }),
    [redaction.strength],
  );
```

and change the two `useState` initialisers that follow so the initial style is the setting too: `useState<BlurStyle>(redaction.style)` and `useState(() => defaultStrengths[redaction.style])`. Remove `useMemo` from the react import only if it is now unused (it is still used here).

- [ ] **Step 3: Write `src/test/place-dialog-defaults.test.tsx`**

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useAppStore } from '@/stores';
import { PlaceScreenshotDialog } from '@/components/typst/PlaceScreenshotDialog';
import type { TypstAsset } from '@/types';

const asset: TypstAsset = { id: 'assets/a.png', kind: 'image', filename: 'a.png', mime: 'image/png', size: 1, etag: '1-1', folderId: null, createdAt: 0, updatedAt: 0, width: 10, height: 10, crop: null, blurs: null };

beforeEach(() => { useAppStore.setState({ redaction: { style: 'pixelate', strength: 2 } }); });

describe('PlaceScreenshotDialog redaction defaults', () => {
  it('starts in the configured style', () => {
    render(<PlaceScreenshotDialog asset={asset} source="= x" onApply={() => {}} onUnplace={() => {}} onAddSlot={() => {}} onRename={async () => 'a.png'} onClose={() => {}} hidePlacement />);
    // The style toggle that is pressed reflects the setting. BTCT renders the
    // two style buttons with aria-pressed; find the pressed one.
    const pressed = screen.getAllByRole('button', { pressed: true });
    expect(pressed.some((b) => /pixel/i.test(b.textContent ?? ''))).toBe(true);
  });
});
```

If BTCT's dialog does not expose `aria-pressed` on the style buttons, assert on the text of the selected control instead (read the JSX once); do not add test-only attributes to the component.

- [ ] **Step 4: Run, typecheck, commit**

Run: `bunx vitest run --project ui && bun run typecheck`. `fetchAssetBytes` is called in the dialog's effect; in jsdom the mocked-less `fetch` rejects and the dialog shows its loading state, which is fine for this test.

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(ui): port preview, search panel, figure viewport, place dialog, portal, confirm dialog" -- advanced-typst-editor
```

---

### Task 19: Port the assets rail and the Typst view onto workspace files

**Files:**
- Create (copied from `$BTCT`): `src/components/typst/TypstAssetsPanel.tsx`, `src/components/typst/TypstView.tsx`

**Interfaces:**
- Consumes: `useWorkspaceFile`, `TypstEditor`, `setTypstEditorContent`, `DiskChangeBar` (Task 17); Task 18 components; store (Task 16).
- Produces: `TypstView` (props: none; reads `activeWorkspaceId` from the store), `TypstAssetsPanel` with BTCT's props (`source`, `onSourceChange`, `fullscreen`, `onToggleFullscreen`, `onHide`, `reveal`, `standalone?`).

- [ ] **Step 1: Copy and edit `TypstAssetsPanel.tsx`**

Copy `$BTCT/src/components/typst/TypstAssetsPanel.tsx`. Then:

1. Header comment: replace the "Folders are organizational only..." paragraph with `// Folders are real subdirectories of assets/. Moving or renaming an image moves the file; the server rewrites every "/assets/…" reference in every .typ file, so the document stays valid.`
2. Any place the panel builds an `#image("…")` snippet or compares a path uses `assetPath(asset)` already (grep `ASSET_DIR` and `assetPath`): leave `assetPath` calls; if a line concatenates `ASSET_DIR + '/' + asset.filename` by hand, replace it with `assetPath(asset)`.
3. Where a folder id is generated locally (grep `uuid`, `crypto.randomUUID`, `newId`): there should be none, since the store creates folders. If there is one, delete it and rely on the returned `AssetFolder`.
4. Everything else stays: drag-and-drop, breadcrumb, tree, upload (`addTypstAsset(file, kind, folderId)`), rename, delete confirmation, place dialog wiring, `insertAtTypstCursor` for fonts.

- [ ] **Step 2: Copy and edit `TypstView.tsx`**

Copy `$BTCT/src/components/typst/TypstView.tsx`. Then:

1. Delete the imports of `yjs`, `@/realtime/shared-doc`, `@/realtime/use-y-text`. Add:
   ```ts
   import { useWorkspaceFile } from '@/hooks/use-workspace-file';
   import { setTypstEditorContent } from './TypstEditor';
   import { DiskChangeBar } from './DiskChangeBar';
   import { api } from '@/api/client';
   ```
   (keep the existing `TypstEditor, revealTypstRange, getTypstCaret, setTypstSearchRequest` import.)
2. Delete `DEFAULT_TYPST_TEMPLATE` and the `useTypstSource` hook entirely (the server seeds `main.typ` from `src/template.ts`).
3. Header comment: replace the Yjs paragraph with `// The source is main.typ (or another .typ picked in the header) of the active workspace, loaded and autosaved by useWorkspaceFile. Every other file in the folder is mounted into the compiler so #include and data files work.`
4. In `TypstView`, keep the "select a workspace" guard. In `TypstWorkspaceView`:
   - Replace `const ytext = useTypstSource(workspaceId);` and the `source`/`setSource` state plus the whole `useEffect` that mirrors `ytext` into `source` with:
     ```tsx
     const [file, setFile] = useState('main.typ');
     const { text: source, loading, dirty, externalChange, setText, reload, keepMine } = useWorkspaceFile(workspaceId, file);
     const typFiles = useAppStore((s) => s.detail?.files.filter((f) => f.path.endsWith('.typ')).map((f) => f.path) ?? []);
     useEffect(() => { setFile('main.typ'); }, [workspaceId]);
     ```
   - Replace `applySource` with:
     ```tsx
     // Programmatic rewrites (slot placement, search replace) go through the
     // editor when it is mounted so undo works; otherwise straight to the file.
     const applySource = useCallback((next: string) => { if (!setTypstEditorContent(next)) setText(next); }, [setText]);
     ```
     (`setTypstEditorContent` dispatches into CodeMirror, whose update listener calls `setText`, so both paths end in the same autosave.)
   - Replace `useTypstAssetSync(workspaceId)` with a version that mounts *every* file: images through `resolveAssetBytes`, fonts through `fetchAssetBytes`, and all other files (`.typ`, `.bib`, `.csv`, `.json`, `.yaml`, `.yml`, `.toml`, `.txt`, `.svg`, `.pdf`) through `api.readBytes`, skipping the file currently open in the editor (its live text is compiled as `/main.typ`... see next bullet) and files over 25 MB. Cache non-asset files by `path:mtime` in a module-level `Map`. The mounted path is `'/' + f.path`.
   - The editor's file is compiled as the main file: change the two `compileTypstSvg(source)` / `compileTypstPdf(source)` calls to pass the current `file` as a second argument, and extend `src/lib/typst-compiler.ts` so `compileTypstSvg(source, opts, mainPath = '/main.typ')` and `compileTypstPdf(source, mainPath = '/main.typ')` use `mainPath` instead of the constant (`compiler.addSource(mainPath, source)` and `mainFilePath: mainPath`). `TypstPreview` calls `compileTypstSvg(source, { coalesce: true })`; give it a `mainPath` prop (default `/main.typ`) and pass `'/' + file`.
   - Header: after the "Typst" label, render a file switcher when `typFiles.length > 1`:
     ```tsx
     <select value={file} onChange={(e) => setFile(e.target.value)} className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-1.5 py-0.5 text-[11px]">
       {typFiles.map((p) => <option key={p} value={p}>{p}</option>)}
     </select>
     ```
     and a small saved/dirty dot: `<span title={dirty ? 'Unsaved' : 'Saved'} className={`h-1.5 w-1.5 rounded-full ${dirty ? 'bg-[hsl(var(--status-amber))]' : 'bg-[hsl(var(--status-green))]'}`} />`.
   - Under the export-error banner add `{externalChange && <DiskChangeBar file={file} onReload={() => void reload()} onKeep={keepMine} />}`.
   - Replace `{ytext ? <TypstEditor ytext={ytext} /> : <div …>Loading…</div>}` with `{loading ? <div …>Loading…</div> : <TypstEditor value={source} onChange={setText} docKey={`${workspaceId}:${file}`} />}` and `{searchOpen && ytext && (` with `{searchOpen && !loading && (`.
   - `exportPdf`/`exportSvg`: name the download after the workspace: `triggerDownload(\`${detailName}.pdf\`, …)` where `const detailName = useAppStore((s) => s.detail?.entry.name ?? 'document')`.
5. Keep everything else (pane resize, reveal, search bridge, assets overlay, `PaneDivider`).

- [ ] **Step 3: Compile-check in the browser**

Start `bun run dev:server` (data from plan 1's import) and `bun run dev`. Temporarily make `App.tsx` render `<TypstView />` after calling `useAppStore.getState().selectWorkspace(<id of cptc-report>)` in a `useEffect` (Task 20 replaces this). Expected in the browser at `http://127.0.0.1:5173`: the report compiles with Poppins, the assets rail lists the six fonts, typing autosaves (watch the dot), reloading the page shows the saved text, `ece-2300L-lab1` shows its three screenshots and the crop dialog opens.

- [ ] **Step 4: Typecheck, grep, commit**

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(ui): port assets rail and Typst view onto workspace files with file switcher" -- advanced-typst-editor
```

---

### Task 20: Sidebar, folder browser, app shell

**Files:**
- Create: `src/lib/workspace-groups.ts`, `src/components/ui/FolderBrowserDialog.tsx`, `src/components/sidebar/Sidebar.tsx`, `src/test/workspace-groups.test.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Produces: `groupWorkspaces(list) -> Array<{ group: string | null; items: WorkspaceStatus[] }>`; `FolderBrowserDialog { title: string; confirmLabel?: string; onPick: (path: string) => void; onClose: () => void }`; `Sidebar` (no props).

- [ ] **Step 1: `src/lib/workspace-groups.ts` and its test (test first)**

```ts
import { describe, it, expect } from 'vitest';
import { groupWorkspaces } from '@/lib/workspace-groups';
import type { WorkspaceStatus } from '@/types';
const w = (name: string, group: string | null, openedAt = 0): WorkspaceStatus => ({ id: name, name, group, path: '', library: true, createdAt: 0, openedAt, status: 'ok' });

describe('groupWorkspaces', () => {
  it('puts loose workspaces first, groups alphabetically, items by recent use', () => {
    const out = groupWorkspaces([w('b', 'Z'), w('a', null, 5), w('c', 'A'), w('d', null, 9), w('e', 'A', 3)]);
    expect(out.map((g) => g.group)).toEqual([null, 'A', 'Z']);
    expect(out[0]!.items.map((i) => i.name)).toEqual(['d', 'a']);
    expect(out[1]!.items.map((i) => i.name)).toEqual(['e', 'c']);
  });
});
```

```ts
import type { WorkspaceStatus } from '@/types';
export function groupWorkspaces(list: WorkspaceStatus[]): Array<{ group: string | null; items: WorkspaceStatus[] }> {
  const by = new Map<string | null, WorkspaceStatus[]>();
  for (const ws of list) { const k = ws.group ?? null; const arr = by.get(k) ?? []; arr.push(ws); by.set(k, arr); }
  const byRecent = (a: WorkspaceStatus, b: WorkspaceStatus) => b.openedAt - a.openedAt || a.name.localeCompare(b.name);
  const groups = [...by.keys()].filter((g): g is string => g !== null).sort((a, b) => a.localeCompare(b));
  return [...(by.has(null) ? [null] : []), ...groups].map((group) => ({ group, items: (by.get(group) ?? []).sort(byRecent) }));
}
```

- [ ] **Step 2: `src/components/ui/FolderBrowserDialog.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { ChevronRight, Folder, HardDrive, X } from 'lucide-react';
import { api, ApiError } from '@/api/client';
import type { DirListing } from '@/types';
import { Portal } from './Portal';

export function FolderBrowserDialog({ title, confirmLabel = 'Use this folder', onPick, onClose }: { title: string; confirmLabel?: string; onPick: (path: string) => void; onClose: () => void }) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const go = async (p: string) => {
    try { const l = await api.browse(p); setListing(l); setInput(l.path); setError(null); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  };
  useEffect(() => { void go(''); }, []);
  const crumbs = listing?.path ? listing.path.split(/[\\/]/).filter(Boolean) : [];
  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
        <div className="flex h-[70vh] w-[640px] flex-col rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--popover))] shadow-xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-4 py-2">
            <span className="text-sm font-semibold">{title}</span>
            <button type="button" onClick={onClose} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><X size={14} /></button>
          </div>
          <form className="flex gap-2 border-b border-[hsl(var(--border))] px-4 py-2" onSubmit={(e) => { e.preventDefault(); void go(input); }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type or paste a path, e.g. D:\Backups\typst" className="min-w-0 flex-1 rounded-md border border-[hsl(var(--input))] bg-transparent px-2 py-1 text-xs" />
            <button type="submit" className="rounded-md border border-[hsl(var(--border))] px-2 py-1 text-xs hover:bg-[hsl(var(--accent))]">Go</button>
          </form>
          <div className="flex flex-wrap items-center gap-1 px-4 py-1 text-[11px] text-[hsl(var(--muted-foreground))]">
            <button type="button" onClick={() => void go('')} className="hover:underline">Drives</button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1"><ChevronRight size={11} /><button type="button" className="hover:underline" onClick={() => void go(crumbs.slice(0, i + 1).join('\\') + (i === 0 ? '\\' : ''))}>{c}</button></span>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-2">
            {listing?.entries.map((e) => (
              <button key={e.path} type="button" onDoubleClick={() => void go(e.path)} onClick={() => setInput(e.path)} className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-[hsl(var(--accent))] ${input === e.path ? 'bg-[hsl(var(--accent))]' : ''}`}>
                {listing.path ? <Folder size={13} /> : <HardDrive size={13} />}
                <span className="flex-1 truncate">{e.name}</span>
                {e.isBackupRoot && <span className="rounded bg-[hsl(var(--status-green))]/20 px-1 text-[10px]">backup</span>}
                {!e.isBackupRoot && listing.path && !e.isEmpty && <span className="text-[10px] text-[hsl(var(--muted-foreground))]">has files</span>}
              </button>
            ))}
            {listing && listing.entries.length === 0 && <div className="px-2 py-4 text-xs text-[hsl(var(--muted-foreground))]">No subfolders.</div>}
          </div>
          {error && <div className="px-4 py-1 text-xs text-[hsl(var(--status-red))]">{error}</div>}
          <div className="flex items-center justify-end gap-2 border-t border-[hsl(var(--border))] px-4 py-2">
            <span className="mr-auto truncate text-[11px] text-[hsl(var(--muted-foreground))]">{input || 'nothing selected'}</span>
            <button type="button" onClick={onClose} className="rounded-md px-3 py-1 text-xs hover:bg-[hsl(var(--accent))]">Cancel</button>
            <button type="button" disabled={!input} onClick={() => onPick(input)} className="rounded-md bg-[hsl(var(--primary))] px-3 py-1 text-xs text-[hsl(var(--primary-foreground))] disabled:opacity-40">{confirmLabel}</button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
```

Double-click descends, single click selects; the path box accepts a pasted path; "Go" lists it.

- [ ] **Step 3: `src/components/sidebar/Sidebar.tsx`**

```tsx
import { useState } from 'react';
import { AlertTriangle, FolderOpen, Plus, Settings, Circle } from 'lucide-react';
import { useAppStore } from '@/stores';
import { groupWorkspaces } from '@/lib/workspace-groups';
import { FolderBrowserDialog } from '@/components/ui/FolderBrowserDialog';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { WorkspaceStatus } from '@/types';

export function Sidebar() {
  const workspaces = useAppStore((s) => s.workspaces);
  const active = useAppStore((s) => s.activeWorkspaceId);
  const select = useAppStore((s) => s.selectWorkspace);
  const create = useAppStore((s) => s.createWorkspace);
  const openFolder = useAppStore((s) => s.openFolder);
  const rename = useAppStore((s) => s.renameWorkspace);
  const setGroup = useAppStore((s) => s.setWorkspaceGroup);
  const remove = useAppStore((s) => s.removeWorkspace);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const backup = useAppStore((s) => s.backup);
  const mcp = useAppStore((s) => s.mcp);
  const online = useAppStore((s) => s.online);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [browsing, setBrowsing] = useState<'open' | { locate: WorkspaceStatus } | null>(null);
  const [removing, setRemoving] = useState<WorkspaceStatus | null>(null);
  const [menu, setMenu] = useState<{ ws: WorkspaceStatus; x: number; y: number } | null>(null);

  const mcpConnected = !!mcp?.clients.some((c) => c.connected);
  const groups = groupWorkspaces(workspaces);

  return (
    <aside data-ui="sidebar" className="flex h-full w-[280px] shrink-0 flex-col border-r border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-bold uppercase tracking-widest">Typst Studio</span>
        <div className="flex gap-1">
          <button type="button" title="New workspace" onClick={() => { setCreating(true); setDraft(''); }} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><Plus size={14} /></button>
          <button type="button" title="Open folder as workspace" onClick={() => setBrowsing('open')} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><FolderOpen size={14} /></button>
          <button type="button" title="Settings" onClick={() => setSettingsOpen(true)} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><Settings size={14} /></button>
        </div>
      </div>
      {creating && (
        <form className="px-3 pb-2" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) void create(draft.trim()); setCreating(false); }}>
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => setCreating(false)} placeholder="Workspace name" className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-2 py-1 text-xs" />
        </form>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {groups.map(({ group, items }) => (
          <div key={group ?? '__loose'} className="mb-2">
            {group && <div className="px-1 py-1 text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">{group}</div>}
            {items.map((ws) => (
              <button key={ws.id} type="button" onClick={() => void select(ws.id)} onContextMenu={(e) => { e.preventDefault(); setMenu({ ws, x: e.clientX, y: e.clientY }); }}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-[hsl(var(--accent))] ${ws.id === active ? 'bg-[hsl(var(--accent))] font-medium' : ''}`}>
                {ws.status === 'missing' ? <AlertTriangle size={12} className="text-[hsl(var(--status-amber))]" /> : <Circle size={6} className={ws.library ? 'fill-current text-[hsl(var(--muted-foreground))]' : 'text-[hsl(var(--status-blue))]'} />}
                <span className="flex-1 truncate" title={ws.path}>{ws.name}</span>
              </button>
            ))}
          </div>
        ))}
        {workspaces.length === 0 && <div className="px-2 py-6 text-center text-xs text-[hsl(var(--muted-foreground))]">No workspaces yet. Create one or open a folder.</div>}
      </div>
      <div className="border-t border-[hsl(var(--border))] px-3 py-2 text-[10px] text-[hsl(var(--muted-foreground))]">
        <div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${mcpConnected ? 'bg-[hsl(var(--status-green))]' : 'bg-[hsl(var(--muted-foreground))]/40'}`} />MCP {mcpConnected ? `connected (${mcp!.clients.filter((c) => c.connected).map((c) => c.name).join(', ')})` : 'no client'}</div>
        <div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${online ? 'bg-[hsl(var(--status-green))]' : 'bg-[hsl(var(--status-red))]'}`} />{backup?.destinations.length ? (backup.lastError ? `backup error: ${backup.lastError}` : backup.lastRunAt ? `backed up ${new Date(backup.lastRunAt).toLocaleTimeString()}` : 'backup pending') : 'no backup destination'}</div>
      </div>

      {menu && (
        <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}>
          <div className="absolute w-44 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--popover))] p-1 text-xs shadow-lg" style={{ left: menu.x, top: menu.y }}>
            <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => { const n = window.prompt('Rename workspace', menu.ws.name); if (n) void rename(menu.ws.id, n); }}>Rename</button>
            <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => { const g = window.prompt('Group (empty for none)', menu.ws.group ?? ''); if (g !== null) void setGroup(menu.ws.id, g.trim() || null); }}>Set group</button>
            {menu.ws.status === 'missing' && <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => setBrowsing({ locate: menu.ws })}>Locate folder</button>}
            <button type="button" className="block w-full rounded px-2 py-1 text-left text-[hsl(var(--status-red))] hover:bg-[hsl(var(--accent))]" onClick={() => setRemoving(menu.ws)}>{menu.ws.library ? 'Move to trash' : 'Forget'}</button>
          </div>
        </div>
      )}
      {browsing === 'open' && <FolderBrowserDialog title="Open a folder as a workspace" onClose={() => setBrowsing(null)} onPick={(p) => { setBrowsing(null); void openFolder(p); }} />}
      {browsing && browsing !== 'open' && <FolderBrowserDialog title={`Locate ${browsing.locate.name}`} onClose={() => setBrowsing(null)} onPick={(p) => { const ws = browsing.locate; setBrowsing(null); void remove(ws.id).then(() => openFolder(p)); }} />}
      {removing && <ConfirmDialog title={removing.library ? 'Move workspace to trash?' : 'Forget this workspace?'} description={removing.library ? `${removing.name} moves to the app trash folder; nothing is deleted.` : `${removing.name} stays on disk at ${removing.path}; it is only removed from the list.`} confirmLabel={removing.library ? 'Move to trash' : 'Forget'} onConfirm={() => { void remove(removing.id); setRemoving(null); }} onCancel={() => setRemoving(null)} />}
    </aside>
  );
}
```

`ConfirmDialog`'s prop names are BTCT's; read `src/components/ui/ConfirmDialog.tsx` and match them exactly (rename `title/description/confirmLabel/onConfirm/onCancel` above if BTCT uses different names).

- [ ] **Step 4: `src/App.tsx`**

```tsx
import { lazy, Suspense, useEffect } from 'react';
import { connectEvents } from '@/api/events';
import { useAppStore } from '@/stores';
import { Sidebar } from '@/components/sidebar/Sidebar';

const TypstView = lazy(() => import('@/components/typst/TypstView').then((m) => ({ default: m.TypstView })));
const SettingsView = lazy(() => import('@/components/settings/SettingsView').then((m) => ({ default: m.SettingsView })));

export default function App() {
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  useEffect(() => {
    const s = useAppStore.getState();
    void (async () => {
      await Promise.all([s.loadWorkspaces(), s.loadSettings(), s.loadBackup(), s.loadMcp()]);
      const list = useAppStore.getState().workspaces;
      let remembered: string | null = null;
      try { remembered = localStorage.getItem('tfs-active-workspace'); } catch { /* ignore */ }
      const pick = list.find((w) => w.id === remembered && w.status === 'ok') ?? list.find((w) => w.status === 'ok') ?? null;
      await s.selectWorkspace(pick?.id ?? null);
    })();
    return connectEvents((ev) => useAppStore.getState().handleEvent(ev), (online) => useAppStore.getState().setOnline(online));
  }, []);
  return (
    <div className="flex h-screen overflow-hidden bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      <Sidebar />
      <main data-ui="main" className="min-w-0 flex-1">
        <Suspense fallback={<div className="p-4 text-xs text-[hsl(var(--muted-foreground))]">Loading…</div>}><TypstView /></Suspense>
      </main>
      {settingsOpen && <Suspense fallback={null}><SettingsView /></Suspense>}
    </div>
  );
}
```

Until Task 21 exists, create `src/components/settings/SettingsView.tsx` exporting a `SettingsView` that renders `null`.

- [ ] **Step 5: Run, browser check, commit**

Run: `bunx vitest run --project ui && bun run typecheck`. In the browser: the sidebar shows CPTC (4) and ECE-2300L (2), clicking switches workspaces, New creates one (folder appears under `./data/workspaces`), right-click offers rename/group/trash, Open folder can register `C:\Users\rober\Desktop\cptc-2026\cptc-typst-report` (its `FullReport.typ` appears in the file switcher; `main.typ` is missing so the editor shows an error until you pick `FullReport.typ`: make the file switcher default to the first `.typ` when `main.typ` is absent).

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(ui): workspace sidebar, folder browser, app shell" -- advanced-typst-editor
```

---

### Task 21: Settings view: backups, MCP, CLI, redaction

**Files:**
- Modify: `src/components/settings/SettingsView.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { useEffect, useState } from 'react';
import { X, Play, RotateCcw, Trash2, Plus } from 'lucide-react';
import { api } from '@/api/client';
import { useAppStore } from '@/stores';
import { Portal } from '@/components/ui/Portal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { FolderBrowserDialog } from '@/components/ui/FolderBrowserDialog';
import type { BackupDestination, SnapshotInfo } from '@/types';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mb-6"><h2 className="mb-2 text-[11px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">{title}</h2>{children}</section>;
}

export function SettingsView() {
  const close = () => useAppStore.getState().setSettingsOpen(false);
  const backup = useAppStore((s) => s.backup);
  const mcp = useAppStore((s) => s.mcp);
  const redaction = useAppStore((s) => s.redaction);
  const typstCli = useAppStore((s) => s.typstCli);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const loadBackup = useAppStore((s) => s.loadBackup);
  const [adding, setAdding] = useState(false);
  const [snapshots, setSnapshots] = useState<Record<string, SnapshotInfo[]>>({});
  const [restore, setRestore] = useState<SnapshotInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cli, setCli] = useState(typstCli ?? '');

  useEffect(() => { void loadBackup(); }, [loadBackup]);
  useEffect(() => {
    if (!backup) return;
    for (const d of backup.destinations) if (d.snapshots) void api.listSnapshots(d.id).then((list) => setSnapshots((s) => ({ ...s, [d.id]: list }))).catch(() => {});
  }, [backup]);

  const patch = async (p: Record<string, unknown>, label: string) => {
    setBusy(label); setError(null);
    try { useAppStore.setState({ backup: await api.patchBackup(p) }); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const setDest = (next: BackupDestination[]) => patch({ destinations: next }, 'destinations');

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={close}>
        <div className="flex h-[80vh] w-[760px] flex-col rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--popover))] shadow-xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-4 py-2">
            <span className="text-sm font-semibold">Settings</span>
            <button type="button" onClick={close} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><X size={14} /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-xs">
            {error && <div className="mb-3 rounded-md border border-[hsl(var(--status-red))]/40 bg-[hsl(var(--status-red))]/10 px-3 py-1.5 text-[hsl(var(--status-red))]">{error}</div>}

            <Section title="Backups">
              <p className="mb-2 text-[hsl(var(--muted-foreground))]">Each destination gets a live mirror of every workspace (nothing is ever deleted there; stale files move to <code>_trash/</code>) and timed zip snapshots under <code>snapshots/</code>. A destination must be empty or one this app already uses.</p>
              {backup?.destinations.map((d) => (
                <div key={d.id} className="mb-2 rounded-md border border-[hsl(var(--border))] p-2">
                  <div className="flex items-center gap-3">
                    <span className="flex-1 truncate font-mono" title={d.path}>{d.path}</span>
                    <label className="flex items-center gap-1"><input type="checkbox" checked={d.mirror} onChange={(e) => void setDest(backup.destinations.map((x) => (x.id === d.id ? { ...x, mirror: e.target.checked } : x)))} />Mirror</label>
                    <label className="flex items-center gap-1"><input type="checkbox" checked={d.snapshots} onChange={(e) => void setDest(backup.destinations.map((x) => (x.id === d.id ? { ...x, snapshots: e.target.checked } : x)))} />Snapshots</label>
                    <button type="button" title="Remove destination (files stay)" onClick={() => void setDest(backup.destinations.filter((x) => x.id !== d.id))} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><Trash2 size={13} /></button>
                  </div>
                  {d.snapshots && (
                    <div className="mt-2 max-h-32 overflow-auto rounded bg-[hsl(var(--muted))]/40 p-1">
                      {(snapshots[d.id] ?? []).map((s) => (
                        <div key={s.name} className="flex items-center gap-2 px-1 py-0.5">
                          <span className="flex-1 font-mono">{s.name}</span>
                          <span className="text-[hsl(var(--muted-foreground))]">{s.workspaces} ws · {(s.bytes / 1e6).toFixed(1)} MB</span>
                          <button type="button" onClick={() => setRestore(s)} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[hsl(var(--accent))]"><RotateCcw size={11} />Restore</button>
                        </div>
                      ))}
                      {(snapshots[d.id] ?? []).length === 0 && <div className="px-1 text-[hsl(var(--muted-foreground))]">No snapshots yet.</div>}
                    </div>
                  )}
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1 rounded-md border border-[hsl(var(--border))] px-2 py-1 hover:bg-[hsl(var(--accent))]"><Plus size={12} />Add destination</button>
                <label className="flex items-center gap-1">Snapshot every <input type="number" min={1} className="w-16 rounded border border-[hsl(var(--input))] bg-transparent px-1" defaultValue={backup?.snapshotIntervalMin ?? 60} onBlur={(e) => void patch({ snapshotIntervalMin: Number(e.target.value) }, 'interval')} /> min</label>
                <label className="flex items-center gap-1">keep last <input type="number" min={1} className="w-16 rounded border border-[hsl(var(--input))] bg-transparent px-1" defaultValue={backup?.keepSnapshots ?? 30} onBlur={(e) => void patch({ keepSnapshots: Number(e.target.value) }, 'keep')} /></label>
                <button type="button" disabled={!backup?.destinations.length || busy === 'run'} onClick={async () => { setBusy('run'); try { useAppStore.setState({ backup: await api.runBackup() }); } finally { setBusy(null); } }} className="ml-auto flex items-center gap-1 rounded-md bg-[hsl(var(--primary))] px-2 py-1 text-[hsl(var(--primary-foreground))] disabled:opacity-40"><Play size={12} />Back up now</button>
              </div>
              {backup && <div className="mt-2 text-[hsl(var(--muted-foreground))]">{backup.lastRunAt ? `Last run ${new Date(backup.lastRunAt).toLocaleString()}, ${backup.lastMirrorFiles ?? 0} files written` : 'No run yet.'}{backup.lastSnapshotAt ? ` · last snapshot ${new Date(backup.lastSnapshotAt).toLocaleString()}` : ''}{backup.lastError ? ` · error: ${backup.lastError}` : ''}</div>}
            </Section>

            <Section title="MCP (Claude Code, Claude Desktop)">
              <p>Endpoint: <code>http://localhost:8090/mcp</code> {mcp?.authRequired ? '(bearer token required: APP_TOKEN)' : '(no token)'}</p>
              <p className="mt-1">Claude Code: <code>claude mcp add --transport http typst-figure-studio http://localhost:8090/mcp</code></p>
              <p className="mt-1">Claude Desktop (stdio bridge): <code>{'{ "command": "bun", "args": ["C:/Users/rober/Desktop/university-tools/advanced-typst-editor/server/mcp-stdio.ts"] }'}</code></p>
              <ul className="mt-2">
                {(mcp?.clients ?? []).map((c) => <li key={c.name} className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${c.connected ? 'bg-[hsl(var(--status-green))]' : 'bg-[hsl(var(--muted-foreground))]/40'}`} />{c.name} {c.version ?? ''} · {c.sessions} session{c.sessions === 1 ? '' : 's'} · seen {new Date(c.lastSeenAt).toLocaleTimeString()}</li>)}
                {(mcp?.clients ?? []).length === 0 && <li className="text-[hsl(var(--muted-foreground))]">No client has connected yet.</li>}
              </ul>
            </Section>

            <Section title="Typst CLI (server-side compile and PDF export for MCP)">
              <div className="flex gap-2">
                <input value={cli} onChange={(e) => setCli(e.target.value)} placeholder="auto (bundled typst.exe, then PATH)" className="min-w-0 flex-1 rounded-md border border-[hsl(var(--input))] bg-transparent px-2 py-1 font-mono" />
                <button type="button" onClick={() => void saveSettings({ typstCli: cli.trim() || null })} className="rounded-md border border-[hsl(var(--border))] px-2 py-1 hover:bg-[hsl(var(--accent))]">Save</button>
              </div>
            </Section>

            <Section title="Redaction defaults for new blur regions">
              <div className="flex items-center gap-3">
                <select value={redaction.style} onChange={(e) => void saveSettings({ redaction: { style: e.target.value as 'gaussian' | 'pixelate' } })} className="rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--card))] px-2 py-1"><option value="gaussian">Blur</option><option value="pixelate">Pixels</option></select>
                <input type="range" min={0.25} max={3} step={0.25} value={redaction.strength} onChange={(e) => void saveSettings({ redaction: { strength: Number(e.target.value) } })} />
                <span>{Math.round(redaction.strength * 100)}%</span>
              </div>
            </Section>
          </div>
        </div>
      </div>
      {adding && <FolderBrowserDialog title="Choose a backup destination" confirmLabel="Use as destination" onClose={() => setAdding(false)} onPick={(p) => { setAdding(false); void setDest([...(backup?.destinations ?? []), { id: '', path: p, mirror: true, snapshots: true }]); }} />}
      {restore && <ConfirmDialog title={`Restore ${restore.name}?`} description="Current workspaces are copied to a pre-restore folder first. Library workspaces are replaced; external ones are restored beside them, never over the original folder." confirmLabel="Restore" onConfirm={async () => { const s = restore; setRestore(null); setBusy('restore'); try { await api.restoreSnapshot(s.destinationId, s.name); await useAppStore.getState().loadWorkspaces(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); } }} onCancel={() => setRestore(null)} />}
    </Portal>
  );
}
```

Match `ConfirmDialog`'s real prop names as in Task 20.

- [ ] **Step 2: Browser check, typecheck, commit**

In the browser: add a destination under a fresh empty folder (e.g. `C:\Users\rober\Desktop\typst-backup-test`), Back up now, confirm the mirror tree and `snapshots/*.zip` appear; edit a report and see the mirror update within ~2 s; Restore the snapshot; Run `bun run typecheck`.

```bash
cd C:/Users/rober/Desktop/university-tools && git add advanced-typst-editor && git commit -m "feat(ui): settings for backups, MCP status, typst CLI, redaction defaults" -- advanced-typst-editor
```

---

### Task 22: End-to-end verification and production build

- [ ] **Step 1: Walk BTCT's Typst feature list against the running app** (dev server + Vite):
  1. Type in the editor; preview updates; the saved dot goes amber then green; reload the page keeps the text.
  2. Drop a PNG on the rail; the place dialog opens; crop, blur (both styles), place into a slot; the PDF export shows the redaction; the original file under `assets/` is untouched.
  3. Create a folder, drag the image in; `main.typ` now references the new path and still compiles.
  4. Ctrl+F finds across the whole document; replace-all works.
  5. Click a rendered paragraph; the editor selects it.
  6. Drop a `.ttf`; the family appears; the `+` inserts `#set text(font: ...)`.
  7. From another terminal: `claude` → ask it to `edit_source` on the open workspace; the editor updates live (clean buffer) or shows the disk-change bar (dirty buffer).
  8. Edit `main.typ` in VS Code; same behaviour.
  9. Close the tab mid-edit; reopen; the last keystrokes were saved (pagehide flush).
- [ ] **Step 2: `bun run build`** succeeds; `bun run test` (both projects) passes; `bun run typecheck` passes; the grep for forbidden imports returns nothing.
- [ ] **Step 3: Commit** any fixes found: `git add advanced-typst-editor && git commit -m "fix(ui): end-to-end verification fixes" -- advanced-typst-editor`.

## Plan 2 self-review

- Spec coverage: 5.1 (Tasks 15, 18), 5.2 (Tasks 17, 19), 5.3 (Tasks 20, 21), 3.1 file mounting (Task 19), "layout persistence in settings.layout" is **not** implemented: `pane-resize.ts` keeps `localStorage`, which WebView2 persists per app; the spec's `layout` block is dropped in Task 15's amendment as well (add one sentence there: "Pane layout stays in localStorage.").
- Placeholders: none.
- Names: `useAppStore` action names match BTCT's (Global Constraints); `setTypstEditorContent`, `useWorkspaceFile`, `DiskChangeBar`, `FolderBrowserDialog`, `groupWorkspaces` used consistently across Tasks 17, 19, 20, 21.

Next: `docs/superpowers/plans/2026-09-03-typst-studio-3-launcher.md`.
# Circuit AI Tool Implementation Plan, part 3: browser client

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Vite-built vanilla TypeScript client served from `dist/`: open recent or discovered schematics, see the breadboard, pan, zoom, drag parts with live re-routing, click switches to simulate, follow the build guide with progress, read pinouts, checks and the truth table, change options, print, and copy connection snippets. Live reload when the schematic changes on disk.

**Architecture:** The client holds the `Design` (parsed from the netlist text the server exposes) and the `Sidecar`, so it can run `buildLayoutDoc` and `renderSvg` itself during drag with no round trip. Drops and option changes go to the server, which persists the sidecar and returns the authoritative doc. Rendering is "state to string": each state change re-renders the SVG and the panels from the current `LayoutDoc`; event handlers are attached by delegation on `data-*` attributes.

**Tech Stack:** Vite 8, vanilla TypeScript, no framework, `bun test` for the two pure helpers. Depends on parts 1 and 2.

**Spec:** `circut-ai-tool/docs/superpowers/specs/2026-09-03-circuit-ai-tool-design.md` (section "Client")

## Global Constraints

- Client code lives in `client/`; it may import from `src/` (pure) but never from `server/`.
- Same visual language as the old guide page: monospace hole names, colour-coded nets, light and dark themes from CSS variables, the board on the left and panels on the right, stacked on narrow screens.
- No web fonts, no CDN. Everything is bundled by Vite.
- Same commit and tooling rules as part 1a.

---

### Task 18: Vite setup, server routes for the client, home page and router

**Files:**
- Modify: `circut-ai-tool/package.json` (scripts `dev`, `build`; devDependency `vite`)
- Create: `circut-ai-tool/vite.config.ts`
- Create: `circut-ai-tool/index.html`
- Create: `circut-ai-tool/client/api.ts`
- Create: `circut-ai-tool/client/state.ts`
- Create: `circut-ai-tool/client/main.ts`
- Create: `circut-ai-tool/client/styles.css`
- Modify: `circut-ai-tool/server/api.ts` (add `GET /projects/:id/netlist` and `GET /projects/:id/sidecar`)
- Modify: `circut-ai-tool/server/openapi.ts` (document the two routes)
- Modify: `circut-ai-tool/test/api.test.ts` (cover the two routes)

**Interfaces:**
- Produces (api.ts client): `api.list()`, `api.open(path)`, `api.summary(id)`, `api.layout(id)`, `api.netlist(id): Promise<string>`, `api.sidecar(id): Promise<Sidecar>`, `api.move(id, ref, holes)`, `api.options(id, patch)`, `api.color(id, net, color)`, `api.reset(id)`, `api.connect()`, `api.events(onEvent): () => void`
- Produces (state.ts): `interface AppState { route: Route; theme: 'light' | 'dark'; project: ProjectState | null; toast: string | null }`, `interface ProjectState { id: string; name: string; path: string; design: Design; sidecar: Sidecar; doc: LayoutDoc; switches: Record<string, boolean>; highlight: Highlight | null; activeStep: number | null; done: Set<number> }`, `store.get()`, `store.set(patch)`, `store.subscribe(fn)`
- Produces (main.ts): hash router `#/`, `#/p/<id>`, `#/connect`; `loadProject(id)`

- [ ] **Step 1: Add the two server routes and their tests**

Append to `test/api.test.ts` inside `describe('REST API')`:

```ts
  test('netlist text and sidecar for the client', async () => {
    const { json, sch } = await setup();
    const { id } = await (await json('/api/projects/open', { path: sch })).json();
    const net = await json(`/api/projects/${id}/netlist`);
    expect(net.headers.get('content-type')).toContain('text/plain');
    expect((await net.text()).startsWith('(export')).toBe(true);
    const side = await (await json(`/api/projects/${id}/sidecar`)).json();
    expect(side.version).toBe(1);
    expect(side.pinned).toEqual({});
  });
```

Run: `cd circut-ai-tool && bun test test/api.test.ts`
Expected: the new test FAILS with 404.

Add to `server/api.ts` after the `/projects/:id/pinouts` route:

```ts
  api.get('/projects/:id/netlist', (c) => c.body(service.get(c.req.param('id')).netlistText, 200, { 'content-type': 'text/plain; charset=utf-8' }));
  api.get('/projects/:id/sidecar', (c) => c.json(service.get(c.req.param('id')).sidecar));
```

Add to `server/openapi.ts` `paths`:

```ts
      '/api/projects/{id}/netlist': { get: op('kicad-cli netlist text (the client parses it to run the layout engine locally)') },
      '/api/projects/{id}/sidecar': { get: op('Pinned placements, options and colours') },
```

Run: `cd circut-ai-tool && bun test test/api.test.ts`
Expected: all pass.

- [ ] **Step 2: Vite config, index.html and package scripts**

Run: `cd circut-ai-tool && bun add -d vite@^8.2.2`

Add to `package.json` scripts: `"dev": "vite"`, `"build": "vite build"`.

`vite.config.ts`:

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: { outDir: 'dist', target: 'es2022', sourcemap: false },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8765', '/mcp': 'http://127.0.0.1:8765', '/openapi.json': 'http://127.0.0.1:8765' },
  },
});
```

`index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>Circuit AI Tool</title>
    <link rel="stylesheet" href="/client/styles.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/client/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Write client/api.ts**

```ts
// Thin fetch wrappers over /api. Errors carry the server's message.

import type { Hole, Options, Sidecar } from '../src/layout/types.ts';
import type { LayoutDoc } from '../src/pipeline.ts';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not json */
    }
    throw new ApiError(msg, res.status);
  }
  return (await res.json()) as T;
}

const post = <T,>(url: string, body: unknown) => call<T>(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  errors: number;
  warnings: number;
  summary: string;
}

export interface ProjectLists {
  recent: { id: string; name: string; path: string; lastOpened: string }[];
  found: { path: string; name: string }[];
}

export interface ConnectInfo {
  appUrl: string;
  mcpUrl: string;
  mcpAliasUrl: string;
  openapiUrl: string;
  stdioCommand: string;
  tools: string[];
  snippets: { id: string; title: string; how: string; language: string; code: string }[];
}

export const api = {
  list: () => call<ProjectLists>('/api/projects'),
  open: (path: string) => post<ProjectSummary>('/api/projects/open', { path }),
  summary: (id: string) => call<ProjectSummary>(`/api/projects/${id}`),
  layout: (id: string) => call<LayoutDoc>(`/api/projects/${id}/layout`),
  netlist: async (id: string) => {
    const res = await fetch(`/api/projects/${id}/netlist`);
    if (!res.ok) throw new ApiError('netlist unavailable', res.status);
    return res.text();
  },
  sidecar: (id: string) => call<Sidecar>(`/api/projects/${id}/sidecar`),
  move: (id: string, ref: string, holes: Record<string, Hole>) => post<LayoutDoc>(`/api/projects/${id}/layout/move`, { ref, holes }),
  options: (id: string, patch: Partial<Options>) => post<LayoutDoc>(`/api/projects/${id}/layout/options`, patch),
  color: (id: string, net: string, color: string | null) => post<LayoutDoc>(`/api/projects/${id}/layout/colors`, { net, color }),
  reset: (id: string) => post<LayoutDoc>(`/api/projects/${id}/layout/reset`, {}),
  connect: () => call<ConnectInfo>('/api/connect'),
  events(onEvent: (ev: { projectId: string; type: string; message?: string }) => void): () => void {
    const es = new EventSource('/api/events');
    const handler = (e: MessageEvent) => {
      try {
        onEvent(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    };
    es.addEventListener('changed', handler);
    es.addEventListener('error', handler as EventListener);
    return () => es.close();
  },
};
```

- [ ] **Step 4: Write client/state.ts**

```ts
// One store, one render. Every change goes through store.set(), which
// notifies subscribers; main.ts re-renders the current route from the state.

import type { Sidecar } from '../src/layout/types.ts';
import type { Design } from '../src/netlist.ts';
import type { LayoutDoc } from '../src/pipeline.ts';
import type { Highlight } from '../src/render/index.ts';

export type Route = { name: 'home' } | { name: 'project'; id: string } | { name: 'connect' };

export interface ProjectState {
  id: string;
  name: string;
  path: string;
  design: Design;
  sidecar: Sidecar;
  doc: LayoutDoc;
  switches: Record<string, boolean>;
  highlight: Highlight | null;
  activeStep: number | null;
  done: Set<number>;
  panel: 'guide' | 'parts' | 'pinouts' | 'checks' | 'truth' | 'options';
}

export interface AppState {
  route: Route;
  theme: 'light' | 'dark';
  project: ProjectState | null;
  loading: boolean;
  toast: string | null;
}

function initialTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* storage blocked */
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

let state: AppState = { route: { name: 'home' }, theme: initialTheme(), project: null, loading: false, toast: null };
const subs = new Set<(s: AppState) => void>();

export const store = {
  get: () => state,
  set(patch: Partial<AppState>) {
    state = { ...state, ...patch };
    for (const fn of subs) fn(state);
  },
  setProject(patch: Partial<ProjectState>) {
    if (!state.project) return;
    store.set({ project: { ...state.project, ...patch } });
  },
  subscribe(fn: (s: AppState) => void) {
    subs.add(fn);
    return () => subs.delete(fn);
  },
};

export function parseRoute(hash: string): Route {
  const m = /^#\/p\/([0-9a-f]{10})/.exec(hash);
  if (m) return { name: 'project', id: m[1] };
  if (hash.startsWith('#/connect')) return { name: 'connect' };
  return { name: 'home' };
}

export function doneKey(id: string) {
  return `guide:${id}`;
}

export function loadDone(id: string): Set<number> {
  try {
    return new Set(JSON.parse(localStorage.getItem(doneKey(id)) ?? '[]') as number[]);
  } catch {
    return new Set();
  }
}

export function saveDone(id: string, done: Set<number>) {
  try {
    localStorage.setItem(doneKey(id), JSON.stringify([...done]));
  } catch {
    /* storage blocked */
  }
}
```

- [ ] **Step 5: Write client/main.ts (router, home page, project shell)**

```ts
// Entry: routing, data loading, and the page shells. The board and the
// panels are rendered by board.ts and panels.ts (Tasks 19 and 20).

import { normalizeSidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { buildLayoutDoc } from '../src/pipeline.ts';
import { api, ApiError } from './api.ts';
import { renderConnect } from './connect.ts';
import { mountBoard } from './board.ts';
import { renderPanels } from './panels.ts';
import { loadDone, parseRoute, store, type AppState } from './state.ts';

const app = document.getElementById('app')!;

export function h(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

export const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function toast(message: string) {
  store.set({ toast: message });
  setTimeout(() => store.get().toast === message && store.set({ toast: null }), 4000);
}

export async function loadProject(id: string) {
  store.set({ loading: true });
  try {
    const [summary, netText, sidecar] = await Promise.all([api.summary(id), api.netlist(id), api.sidecar(id)]);
    const design = parseNetlist(netText);
    const side = normalizeSidecar(sidecar);
    const doc = buildLayoutDoc(design, side);
    store.set({ loading: false, project: { id, name: summary.name, path: summary.path, design, sidecar: side, doc, switches: {}, highlight: null, activeStep: null, done: loadDone(id), panel: 'guide' } });
  } catch (e) {
    store.set({ loading: false, project: null });
    toast(e instanceof ApiError && e.status === 404 ? 'That project is not open on the server. Open it from the home page.' : (e as Error).message);
    location.hash = '#/';
  }
}

async function renderHome() {
  app.replaceChildren(h(`<main class="home"><header><h1>Circuit AI Tool</h1><p class="sub">Open a KiCad schematic and get a breadboard wiring diagram, a build guide, checks and a logic simulator.</p></header>
    <section class="open"><form id="open-form"><label>Schematic path <input name="path" placeholder="C:\\Users\\you\\Documents\\KiCad\\9.0\\projects\\lab1\\lab1.kicad_sch" required></label><button type="submit">Open</button></form></section>
    <section><h2>Recent</h2><ul id="recent" class="projects"></ul></section>
    <section><h2>Found in your KiCad projects folder</h2><ul id="found" class="projects"></ul></section>
    <footer><a href="#/connect">Connect Claude, ChatGPT or Claude Code</a> · <a href="/openapi.json">OpenAPI</a></footer></main>`));
  const form = app.querySelector<HTMLFormElement>('#open-form')!;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const path = (new FormData(form).get('path') as string).trim();
    try {
      const s = await api.open(path);
      location.hash = `#/p/${s.id}`;
    } catch (err) {
      toast((err as Error).message);
    }
  });
  try {
    const lists = await api.list();
    app.querySelector('#recent')!.innerHTML = lists.recent.map((p) => `<li><a href="#/p/${p.id}" data-path="${esc(p.path)}"><b>${esc(p.name)}</b><span>${esc(p.path)}</span></a></li>`).join('') || '<li class="muted">nothing yet</li>';
    app.querySelector('#found')!.innerHTML = lists.found.map((p) => `<li><a href="#/" data-open="${esc(p.path)}"><b>${esc(p.name)}</b><span>${esc(p.path)}</span></a></li>`).join('') || '<li class="muted">no .kicad_sch files found</li>';
    app.querySelectorAll<HTMLAnchorElement>('a[data-open]').forEach((a) =>
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          const s = await api.open(a.dataset.open!);
          location.hash = `#/p/${s.id}`;
        } catch (err) {
          toast((err as Error).message);
        }
      }),
    );
    app.querySelectorAll<HTMLAnchorElement>('#recent a').forEach((a) =>
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          const s = await api.open(a.dataset.path!);
          location.hash = `#/p/${s.id}`;
        } catch (err) {
          toast((err as Error).message);
        }
      }),
    );
  } catch (e) {
    toast(`Server not reachable: ${(e as Error).message}`);
  }
}

let boardUnmount: (() => void) | null = null;

function renderProject(s: AppState) {
  const p = s.project;
  if (!p) {
    app.replaceChildren(h(`<main class="project"><p class="muted">${s.loading ? 'Loading…' : 'No project.'}</p></main>`));
    return;
  }
  if (!app.querySelector('.project[data-id="' + p.id + '"]')) {
    boardUnmount?.();
    app.replaceChildren(h(`<main class="project" data-id="${p.id}">
      <header><a href="#/" class="back">← projects</a><h1>${esc(p.name)}</h1><span class="path">${esc(p.path)}</span><div class="spacer"></div><a href="#/connect">Connect</a><button id="theme">${s.theme === 'dark' ? 'Light' : 'Dark'}</button></header>
      <div class="layout"><section class="boardcol"><div class="board-card"><div id="board"></div><div id="toolbar" class="toolbar"></div><div id="legend" class="legend"></div></div></section><aside id="panels" class="panels"></aside></div></main>`));
    boardUnmount = mountBoard(app.querySelector('#board')!);
    app.querySelector('#theme')!.addEventListener('click', () => {
      const theme = store.get().theme === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem('theme', theme);
      } catch {
        /* ignore */
      }
      store.set({ theme });
    });
  }
  app.querySelector('#theme')!.textContent = s.theme === 'dark' ? 'Light' : 'Dark';
  renderPanels(app.querySelector('#panels')!, app.querySelector('#toolbar')!, app.querySelector('#legend')!, s);
}

function render(s: AppState) {
  document.documentElement.dataset.theme = s.theme;
  document.getElementById('toast')?.remove();
  if (s.toast) document.body.append(h(`<div id="toast" class="toast">${esc(s.toast)}</div>`));
  if (s.route.name === 'home') {
    if (!app.querySelector('main.home')) void renderHome();
    return;
  }
  if (s.route.name === 'connect') {
    if (!app.querySelector('main.connect')) void renderConnect(app);
    return;
  }
  renderProject(s);
}

store.subscribe(render);

function onRoute() {
  const route = parseRoute(location.hash);
  store.set({ route });
  if (route.name === 'project' && store.get().project?.id !== route.id) void loadProject(route.id);
}
addEventListener('hashchange', onRoute);
onRoute();

api.events((ev) => {
  const p = store.get().project;
  if (!p || ev.projectId !== p.id) return;
  if (ev.type === 'changed') {
    toast('Schematic changed on disk; reloading');
    void loadProject(p.id);
  } else if (ev.type === 'error') toast(`Reload failed: ${ev.message}`);
});
```

Until Tasks 19 and 20 exist, create stubs so the build works: `client/board.ts` exporting `mountBoard = () => () => {}`, `client/panels.ts` exporting `renderPanels = () => {}`, `client/connect.ts` exporting `renderConnect = async (root: HTMLElement) => { root.replaceChildren(); }`. They are replaced in the next tasks.

- [ ] **Step 6: Write client/styles.css**

```css
:root {
  --bg: #f6f4ee; --bg-2: #ece9e0; --ink: #1e2229; --ink-2: #5b6270; --line: #d6d2c6; --accent: #1f3b73; --accent-ink: #ffffff;
  --done: #2e7d4f; --warn: #b8860b; --err: #c62828; --card: #ffffff;
  --font-body: "Segoe UI", system-ui, sans-serif; --font-mono: Consolas, "JetBrains Mono", ui-monospace, monospace;
}
:root[data-theme="dark"] { --bg: #17191e; --bg-2: #1f2229; --ink: #e7e5df; --ink-2: #a3a8b3; --line: #343841; --accent: #7fa6e8; --accent-ink: #0f1524; --done: #6fcf97; --card: #22252c; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--font-body); font-size: 15px; line-height: 1.45; }
a { color: var(--accent); }
main { max-width: 1400px; margin: 0 auto; padding: 20px 24px 56px; }
header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 18px; border-bottom: 2px solid var(--ink); padding-bottom: 10px; margin-bottom: 16px; }
header h1 { margin: 0; font-size: 28px; line-height: 1.1; }
header .sub, header .path { color: var(--ink-2); font-size: 14px; }
header .spacer { flex: 1; }
button { font: 600 14px var(--font-body); color: var(--accent); background: transparent; border: 1px solid var(--accent); border-radius: 4px; padding: 4px 12px; cursor: pointer; }
button:hover, button:focus-visible { background: var(--accent); color: var(--accent-ink); outline: none; }
button.primary { background: var(--accent); color: var(--accent-ink); }
input, select { font: 14px var(--font-mono); padding: 5px 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--card); color: var(--ink); min-width: 0; }
code, .mono { font-family: var(--font-mono); font-size: 0.92em; }
.muted { color: var(--ink-2); }
.home .open form { display: flex; gap: 8px; align-items: end; }
.home .open label { display: flex; flex-direction: column; gap: 4px; flex: 1; }
.home .open input { width: 100%; }
.projects { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
.projects a { display: flex; flex-direction: column; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); text-decoration: none; color: var(--ink); }
.projects a span { color: var(--ink-2); font-family: var(--font-mono); font-size: 12px; }
.layout { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(320px, 1fr); gap: 24px; align-items: start; }
@media (max-width: 1000px) { .layout { grid-template-columns: 1fr; } .boardcol { position: static !important; } }
.boardcol { position: sticky; top: 12px; }
.board-card { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 12px 12px 8px; }
#board { overflow: hidden; touch-action: none; }
#board svg { width: 100%; height: auto; display: block; cursor: grab; user-select: none; }
#board svg.dragging { cursor: grabbing; }
#board .part, #board .pkg, #board [data-switch] { cursor: pointer; }
#board .invalid { outline: 2px dashed var(--err); }
.toolbar { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; margin-top: 8px; font-size: 13px; color: var(--ink-2); }
.legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 8px; font-family: var(--font-mono); font-size: 12px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.legend i { width: 18px; height: 5px; border-radius: 2px; display: inline-block; }
.panels { display: flex; flex-direction: column; gap: 12px; }
.tabs { display: flex; flex-wrap: wrap; gap: 4px; }
.tabs button.active { background: var(--accent); color: var(--accent-ink); }
.panel { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 12px 14px; }
.panel h2 { margin: 0 0 8px; font-size: 16px; }
.steps { list-style: none; padding: 0; margin: 0; display: grid; gap: 4px; }
.steps li { display: grid; grid-template-columns: auto auto 1fr; gap: 8px; align-items: start; padding: 5px 6px; border-radius: 4px; }
.steps li.active { background: var(--bg-2); }
.steps li.done { color: var(--ink-2); text-decoration: line-through; }
.steps .phase { font-family: var(--font-mono); font-size: 11px; color: var(--ink-2); margin: 10px 0 2px; text-transform: uppercase; letter-spacing: 0.06em; }
.progress { height: 6px; background: var(--bg-2); border-radius: 3px; overflow: hidden; margin: 6px 0 10px; }
.progress i { display: block; height: 100%; background: var(--done); }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--line); }
td.mono, th.mono { font-family: var(--font-mono); }
.check { padding: 4px 6px; border-left: 3px solid var(--line); margin-bottom: 4px; font-size: 13px; }
.check.error { border-color: var(--err); }
.check.warning { border-color: var(--warn); }
.check.info { border-color: var(--done); }
.options label { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 6px 0; }
.toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); background: var(--ink); color: var(--bg); padding: 8px 14px; border-radius: 6px; font-size: 14px; z-index: 9; }
.connect pre { background: var(--bg-2); padding: 10px 12px; border-radius: 6px; overflow-x: auto; font-size: 12.5px; }
.connect .snippet { margin-bottom: 18px; }
.connect .snippet h3 { margin: 0 0 4px; font-size: 15px; }
@media print {
  header a, header button, .toolbar, .tabs, .toast, .options { display: none !important; }
  body { background: #fff; color: #000; }
  main { max-width: none; padding: 0; }
  .layout { display: block; }
  .boardcol { position: static; page-break-after: always; }
  .board-card, .panel { border: none; box-shadow: none; }
  .steps li { break-inside: avoid; }
}
```

- [ ] **Step 7: Build and check in the browser**

Run: `cd circut-ai-tool && bun run build && bun run typecheck`
Expected: `dist/index.html` and `dist/assets/*.js` written; no type errors.

Run `bun start` in one terminal, open `http://localhost:8765/` in a browser. Expected: the home page lists PL1_1 under "Found in your KiCad projects folder"; clicking it navigates to `#/p/<id>`, shows the header with the project name and an empty board area (the board arrives in Task 19). The Dark button toggles the theme. Stop the server.

- [ ] **Step 8: Commit**

```bash
git add circut-ai-tool/package.json circut-ai-tool/bun.lock circut-ai-tool/vite.config.ts circut-ai-tool/index.html circut-ai-tool/client circut-ai-tool/server/api.ts circut-ai-tool/server/openapi.ts circut-ai-tool/test/api.test.ts
git commit -m "feat(circuit): Vite client shell with home page, router and live events"
```

---

### Task 19: Board view: pan, zoom, hover, drag, switches

**Files:**
- Create: `circut-ai-tool/client/drag.ts` (pure)
- Create: `circut-ai-tool/client/simstate.ts` (pure)
- Modify: `circut-ai-tool/src/sim/index.ts` (add `key` to `SimInput`)
- Replace: `circut-ai-tool/client/board.ts`
- Test: `circut-ai-tool/test/client-helpers.test.ts`

**Interfaces:**
- Produces (drag.ts): `nearestRow(y: number): Row`, `shiftHoles(holes: Record<string, Hole>, dx: number, dy: number, board: BoardSpec, columnsOnly: boolean): Record<string, Hole> | null`
- Produces (simstate.ts): `levelsFromSwitches(model: SimModel, switches: Record<string, boolean>): Record<string, 0 | 1>`, `simState(model, switches): SimState`
- Modifies (sim): `SimInput` gains `key: string` (the `data-switch` value: the switch ref, or `${ref}:${position}` for a real DIP switch)
- Produces (board.ts): `mountBoard(container: HTMLElement): () => void`

- [ ] **Step 1: Write the failing tests**

`test/client-helpers.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { nearestRow, shiftHoles } from '../client/drag.ts';
import { levelsFromSwitches, simState } from '../client/simstate.ts';
import { layout } from '../src/layout/engine.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { buildSimModel } from '../src/sim/index.ts';
import { P, ROWY } from '../src/render/index.ts';
import { readFixture } from './smoke.test.ts';

const board = { cols: 30, kind: 'half' as const, splitCol: null, railGapEvery: 6 };

describe('drag helpers', () => {
  test('nearestRow snaps to strip rows only', () => {
    expect(nearestRow(ROWY.a)).toBe('a');
    expect(nearestRow(ROWY.e + 10)).toBe('e');
    expect(nearestRow(ROWY.f - 10)).toBe('f');
    expect(nearestRow(ROWY['T+'])).toBe('a');
  });
  test('shiftHoles moves columns and rows, refuses off-board', () => {
    const holes = { '1': { col: 5, row: 'a' as const }, '2': { col: 5, row: 'T+' as const } };
    expect(shiftHoles(holes, 2 * P, 0, board, false)).toEqual({ '1': { col: 7, row: 'a' }, '2': { col: 7, row: 'T+' } });
    expect(shiftHoles({ '1': { col: 5, row: 'a' } }, 0, 2 * P, board, false)).toEqual({ '1': { col: 5, row: 'c' } });
    expect(shiftHoles({ '1': { col: 5, row: 'a' } }, 0, 2 * P, board, true)).toEqual({ '1': { col: 5, row: 'a' } });
    expect(shiftHoles({ '1': { col: 29, row: 'a' } }, 2 * P, 0, board, false)).toBeNull();
    expect(shiftHoles({ '1': { col: 2, row: 'a' } }, -2 * P, 0, board, false)).toBeNull();
  });
});

describe('sim state', () => {
  const d = parseNetlist(readFixture('PL1_1.net'));
  const model = buildSimModel(d, layout(d, emptySidecar()));
  test('switch keys map to input levels (active low: closed = 0)', () => {
    expect(model.inputs.map((i) => i.key)).toEqual(['SW1', 'SW2']);
    expect(levelsFromSwitches(model, {})).toEqual({ '/A': 1, '/B': 1 });
    expect(levelsFromSwitches(model, { SW1: true })).toEqual({ '/A': 0, '/B': 1 });
    const s = simState(model, { SW1: true });
    expect(s.leds.D1).toBe(true);
    expect(s.switches).toEqual({ SW1: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd circut-ai-tool && bun test test/client-helpers.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Add `key` to SimInput in src/sim/index.ts**

In the `SimInput` interface add `key: string;`. In `buildSimModel`, change `addInput` to take the key:

```ts
  const addInput = (net: string, other: string, control: string, key: string) => {
    if (powerKind(net) || isUnconnected(net) || seenInput.has(net)) return;
    seenInput.add(net);
    model.inputs.push({ name: displayName(net), net, control, key, activeLow: powerKind(other) !== '+' });
  };
```

and pass keys at the call sites: lead2 switches use `ref`; real DIP switches use `` `${ref}:${i + 1}` ``. Run `bun test test/sim.test.ts` to confirm nothing else changed.

- [ ] **Step 4: Write client/drag.ts and client/simstate.ts**

`client/drag.ts`:

```ts
// Translate a part's holes by a pointer delta in SVG units, snapping to the grid.

import type { BoardSpec, Hole, Row } from '../src/layout/types.ts';
import { isRail } from '../src/layout/board.ts';
import { P, ROWY } from '../src/render/index.ts';

const STRIP_ROWS: Row[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

export function nearestRow(y: number): Row {
  let best: Row = 'a';
  let dist = Infinity;
  for (const r of STRIP_ROWS) {
    const d = Math.abs(ROWY[r] - y);
    if (d < dist) {
      dist = d;
      best = r;
    }
  }
  return best;
}

export function shiftHoles(holes: Record<string, Hole>, dx: number, dy: number, board: BoardSpec, columnsOnly: boolean): Record<string, Hole> | null {
  const dCols = Math.round(dx / P);
  const out: Record<string, Hole> = {};
  for (const [pin, h] of Object.entries(holes)) {
    const col = h.col + dCols;
    const row = columnsOnly || isRail(h.row) ? h.row : nearestRow(ROWY[h.row] + dy);
    if (col < 1 || col > board.cols) return null;
    if (isRail(row) && col % board.railGapEvery === 0) return null;
    out[pin] = { col, row };
  }
  return out;
}
```

`client/simstate.ts`:

```ts
// Switch positions on the board -> input levels -> LED and segment states.

import type { SimState } from '../src/render/index.ts';
import { simulate, type SimModel } from '../src/sim/index.ts';

export function levelsFromSwitches(model: SimModel, switches: Record<string, boolean>): Record<string, 0 | 1> {
  const levels: Record<string, 0 | 1> = {};
  for (const inp of model.inputs) {
    const closed = !!switches[inp.key];
    levels[inp.net] = closed ? (inp.activeLow ? 0 : 1) : inp.activeLow ? 1 : 0;
  }
  return levels;
}

export function simState(model: SimModel, switches: Record<string, boolean>): SimState {
  const r = simulate(model, levelsFromSwitches(model, switches));
  return { leds: r.leds, segments: r.segments, switches: { ...switches } };
}
```

- [ ] **Step 5: Write client/board.ts**

```ts
// The board: render the SVG from state, pan and zoom with the pointer, hover
// to highlight a net, click switches, drag parts with live re-layout.

import { buildLayoutDoc } from '../src/pipeline.ts';
import { renderSvg, svgSize, type Highlight } from '../src/render/index.ts';
import { DARK, LIGHT } from '../src/render/theme.ts';
import { api } from './api.ts';
import { shiftHoles } from './drag.ts';
import { toast } from './main.ts';
import { simState } from './simstate.ts';
import { store, type AppState } from './state.ts';

export function mountBoard(container: HTMLElement): () => void {
  let view = { x: -100, y: 0, w: 0, h: 350 };
  let lastKey = '';
  let drag: { ref: string; columnsOnly: boolean; startX: number; startY: number; origin: Record<string, { col: number; row: never }>; preview: string | null; valid: boolean } | null = null;
  let panning: { x: number; y: number; vx: number; vy: number } | null = null;

  const svgPoint = (e: PointerEvent) => {
    const svg = container.querySelector('svg')!;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  };

  const applyView = () => {
    const svg = container.querySelector('svg');
    if (svg) svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  };

  const render = (s: AppState) => {
    const p = s.project;
    if (!p) {
      container.replaceChildren();
      lastKey = '';
      return;
    }
    const doc = drag?.preview ? JSON.parse(drag.preview) : p.doc;
    const sim = simState(p.doc.sim.model, p.switches);
    const highlight: Highlight | null = p.highlight ?? (p.activeStep !== null ? stepHighlight(p, p.activeStep) : null);
    const key = JSON.stringify([p.id, s.theme, highlight, p.switches, doc === p.doc ? p.doc : drag?.preview]);
    if (key === lastKey) return;
    lastKey = key;
    const size = svgSize(doc.board);
    if (!view.w) view = { x: -100, y: 0, w: size.width, h: size.height };
    container.innerHTML = renderSvg(doc, { theme: s.theme === 'dark' ? DARK : LIGHT, highlight, sim });
    if (drag && !drag.valid) container.querySelector(`[data-ref="${drag.ref}"]`)?.classList.add('invalid');
    applyView();
  };

  const stepHighlight = (p: NonNullable<AppState['project']>, n: number): Highlight | null => {
    const step = p.doc.steps.find((x) => x.n === n);
    if (!step) return null;
    if (step.wire !== undefined) return { wire: step.wire };
    if (step.ref && step.ref !== 'PSU') return { ref: step.ref };
    return null;
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const svg = container.querySelector('svg');
    if (!svg) return;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM()!.inverse());
    const f = e.deltaY < 0 ? 0.85 : 1 / 0.85;
    view = { x: pt.x - (pt.x - view.x) * f, y: pt.y - (pt.y - view.y) * f, w: view.w * f, h: view.h * f };
    applyView();
  };

  const onPointerDown = (e: PointerEvent) => {
    const p = store.get().project;
    if (!p || e.button !== 0) return;
    const target = e.target as Element;
    const sw = target.closest<Element>('[data-switch]');
    if (sw) {
      const k = sw.getAttribute('data-switch')!;
      store.setProject({ switches: { ...p.switches, [k]: !p.switches[k] } });
      return;
    }
    const part = target.closest<Element>('.part[data-ref], .pkg[data-ref]');
    if (part) {
      const ref = part.getAttribute('data-ref')!;
      if (!p.doc.pinHoles[ref]) return;
      const { x, y } = svgPoint(e);
      drag = { ref, columnsOnly: part.classList.contains('pkg'), startX: x, startY: y, origin: p.doc.pinHoles[ref] as never, preview: null, valid: true };
      container.querySelector('svg')!.classList.add('dragging');
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }
    panning = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    const p = store.get().project;
    if (!p) return;
    if (panning) {
      const svg = container.querySelector('svg')!;
      const scale = view.w / svg.getBoundingClientRect().width;
      view = { ...view, x: panning.vx - (e.clientX - panning.x) * scale, y: panning.vy - (e.clientY - panning.y) * scale };
      applyView();
      return;
    }
    if (drag) {
      const { x, y } = svgPoint(e);
      const holes = shiftHoles(drag.origin, x - drag.startX, y - drag.startY, p.doc.board, drag.columnsOnly);
      if (!holes) {
        drag.valid = false;
        return;
      }
      const sidecar = { ...p.sidecar, pinned: { ...p.sidecar.pinned, [drag.ref]: holes } };
      const doc = buildLayoutDoc(p.design, sidecar);
      drag.valid = !doc.warnings.some((w) => w.startsWith(`pinned placement for ${drag!.ref} dropped`));
      drag.preview = JSON.stringify(doc);
      render(store.get());
      return;
    }
    const net = (e.target as Element).closest<Element>('[data-net]')?.getAttribute('data-net')?.split(' ')[0] ?? null;
    const current = p.highlight?.net ?? null;
    if (net !== current && p.activeStep === null) store.setProject({ highlight: net ? { net } : null });
  };

  const onPointerUp = async (e: PointerEvent) => {
    if (panning) {
      panning = null;
      return;
    }
    if (!drag) return;
    const p = store.get().project!;
    const d = drag;
    drag = null;
    container.querySelector('svg')?.classList.remove('dragging');
    const { x, y } = svgPoint(e);
    const holes = shiftHoles(d.origin, x - d.startX, y - d.startY, p.doc.board, d.columnsOnly);
    lastKey = '';
    if (!holes || !d.valid || JSON.stringify(holes) === JSON.stringify(d.origin)) {
      render(store.get());
      return;
    }
    try {
      const doc = await api.move(p.id, d.ref, holes);
      const sidecar = { ...p.sidecar, pinned: { ...p.sidecar.pinned, [d.ref]: holes } };
      store.setProject({ doc, sidecar });
    } catch (err) {
      toast((err as Error).message);
      render(store.get());
    }
  };

  container.addEventListener('wheel', onWheel, { passive: false });
  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', onPointerUp);
  container.addEventListener('pointerleave', () => {
    const p = store.get().project;
    if (p && p.highlight && p.activeStep === null && !drag) store.setProject({ highlight: null });
  });
  const unsub = store.subscribe(render);
  render(store.get());
  return () => {
    unsub();
    container.replaceChildren();
  };
}

export function fitView(container: HTMLElement) {
  const svg = container.querySelector('svg');
  const p = store.get().project;
  if (!svg || !p) return;
  const size = svgSize(p.doc.board);
  svg.setAttribute('viewBox', size.viewBox);
}
```

- [ ] **Step 6: Run the tests and try it in the browser**

Run: `cd circut-ai-tool && bun test && bun run typecheck && bun run build`
Expected: green.

Run `bun start`, open PL1_1 in the browser. Check: the board renders; the wheel zooms around the pointer; dragging empty board pans; hovering a wire dims everything except its net; clicking SW1 toggles it and D1 lights or goes dark; dragging R1 three columns right shows it re-routed live, and after release the position survives a page reload (the sidecar `PL1_1.breadboard.json` appears next to the schematic). Dragging U1 onto U2 shows the dashed red outline and snaps back on release.

- [ ] **Step 7: Commit**

```bash
git add circut-ai-tool/client circut-ai-tool/src/sim/index.ts circut-ai-tool/test/client-helpers.test.ts
git commit -m "feat(circuit): interactive board with pan, zoom, drag, hover and switches"
```

---

### Task 20: Panels, toolbar, legend and print

**Files:**
- Replace: `circut-ai-tool/client/panels.ts`

**Interfaces:**
- Produces: `renderPanels(panels: HTMLElement, toolbar: HTMLElement, legend: HTMLElement, s: AppState): void`

- [ ] **Step 1: Write client/panels.ts**

```ts
// Right-hand panels (guide, parts, pinouts, checks, truth table, options),
// the toolbar under the board and the net legend. Pure "state to HTML" with
// delegated event handlers.

import { displayName } from '../src/netlist.ts';
import { api } from './api.ts';
import { fitView } from './board.ts';
import { esc, toast } from './main.ts';
import { saveDone, store, type AppState, type ProjectState } from './state.ts';

const TABS: [ProjectState['panel'], string][] = [['guide', 'Guide'], ['parts', 'Parts'], ['pinouts', 'Pinouts'], ['checks', 'Checks'], ['truth', 'Truth table'], ['options', 'Options']];

function guide(p: ProjectState): string {
  const total = p.doc.steps.length;
  const done = p.doc.steps.filter((s) => p.done.has(s.n)).length;
  let phase = '';
  const items = p.doc.steps
    .map((s) => {
      const head = s.phase !== phase ? `<div class="phase">${s.phase}</div>` : '';
      phase = s.phase;
      const label = esc(s.label).replace(/\b([a-j]\d{1,2})\b/g, '<code>$1</code>');
      return `${head}<li class="${p.done.has(s.n) ? 'done' : ''} ${p.activeStep === s.n ? 'active' : ''}" data-step="${s.n}"><input type="checkbox" data-done="${s.n}" ${p.done.has(s.n) ? 'checked' : ''}><b>${s.n}.</b><span>${label}</span></li>`;
    })
    .join('');
  return `<div class="panel"><h2>Build guide</h2><div class="progress"><i style="width:${total ? (100 * done) / total : 0}%"></i></div><p class="muted">${done} of ${total} steps. Click a step to highlight it on the board.</p><ol class="steps">${items}</ol></div>`;
}

function parts(p: ProjectState): string {
  const unplaced = p.doc.unplaced.length ? `<h2>Not placed</h2><ul>${p.doc.unplaced.map((u) => `<li><b>${esc(u.ref)}</b>: ${esc(u.reason)}</li>`).join('')}</ul>` : '';
  return `<div class="panel"><h2>Parts list</h2><ul>${p.doc.partsList.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>${unplaced}</div>`;
}

function pinouts(p: ProjectState): string {
  return p.doc.pinouts
    .map((po) => `<div class="panel"><h2>${esc(po.ref)} ${esc(po.name)}</h2><table><tr><th>pin</th><th>function</th><th>net</th><th>hole</th></tr>${po.pins.map((x) => `<tr class="${x.used ? '' : 'muted'}"><td class="mono">${x.num}</td><td>${esc(x.function)}</td><td class="mono">${esc(x.net)}</td><td class="mono">${esc(x.hole)}</td></tr>`).join('')}</table></div>`)
    .join('') || '<div class="panel"><p class="muted">No chips.</p></div>';
}

function checks(p: ProjectState): string {
  return `<div class="panel"><h2>Checks</h2>${p.doc.checks.map((c) => `<div class="check ${c.level}" ${c.refs[0] ? `data-ref="${esc(c.refs[0])}"` : ''}><b>${c.level}</b> ${esc(c.message)}</div>`).join('') || '<p class="muted">No checks.</p>'}</div>`;
}

function truth(p: ProjectState): string {
  const t = p.doc.sim.truthTable;
  if (!t) return `<div class="panel"><h2>Truth table</h2><p class="muted">${esc(p.doc.sim.note ?? 'not available')}</p></div>`;
  const head = `<tr>${t.inputs.map((i) => `<th class="mono">${esc(i)}</th>`).join('')}<th></th>${t.outputs.map((o) => `<th class="mono">${esc(o)}</th>`).join('')}${t.leds.map((l) => `<th class="mono">${esc(l)}</th>`).join('')}</tr>`;
  const rows = t.rows.map((r) => `<tr>${r.inputs.map((v) => `<td class="mono">${v}</td>`).join('')}<td>→</td>${r.outputs.map((v) => `<td class="mono">${v}</td>`).join('')}${r.leds.map((l) => `<td>${l ? '● on' : '○ off'}</td>`).join('')}</tr>`).join('');
  const note = p.doc.sim.note ? `<p class="muted">${esc(p.doc.sim.note)}</p>` : '';
  return `<div class="panel"><h2>Truth table</h2><p class="muted">Inputs are logic levels on the nets (switch closed = 0 for pull-up inputs).</p><table>${head}${rows}</table>${note}</div>`;
}

function options(p: ProjectState): string {
  const o = p.sidecar.options;
  const chips = p.doc.packages.filter((x) => x.kind === 'dip').map((x) => x.id);
  return `<div class="panel options"><h2>Options</h2>
    <label>Board <select data-opt="board"><option value="auto" ${o.board === 'auto' ? 'selected' : ''}>auto</option><option value="half" ${o.board === 'half' ? 'selected' : ''}>half (30 columns)</option><option value="full" ${o.board === 'full' ? 'selected' : ''}>full (63 columns)</option></select></label>
    <label>Rail split <select data-opt="railSplit"><option value="null" ${o.railSplit === null ? 'selected' : ''}>auto</option><option value="true" ${o.railSplit === true ? 'selected' : ''}>split</option><option value="false" ${o.railSplit === false ? 'selected' : ''}>continuous</option></select></label>
    <label>DIP switch positions (0 = separate switches) <input type="number" min="0" max="16" data-opt="dipSwitchPositions" value="${o.dipSwitchPositions}"></label>
    <label>Chip order <input data-opt="packageOrder" value="${esc(o.packageOrder.join(' '))}" placeholder="${esc(chips.join(' '))}"></label>
    <p><button data-action="reset">Reset layout</button> <span class="muted">forgets moved parts, options and colours</span></p>
    <p class="muted mono">${esc(p.path)}</p></div>`;
}

export function renderPanels(panels: HTMLElement, toolbar: HTMLElement, legend: HTMLElement, s: AppState) {
  const p = s.project;
  if (!p) return;
  const body = { guide, parts, pinouts, checks, truth, options }[p.panel](p);
  panels.innerHTML = `<div class="tabs">${TABS.map(([id, label]) => `<button data-tab="${id}" class="${p.panel === id ? 'active' : ''}">${label}${id === 'checks' && p.doc.checks.some((c) => c.level === 'error') ? ' ⚠' : ''}</button>`).join('')}</div>${body}`;
  toolbar.innerHTML = `<button data-action="fit">Fit</button><button data-action="print">Print</button><a href="/api/projects/${p.id}/board.svg" download="${esc(p.name)}-breadboard.svg">SVG</a><a href="/api/projects/${p.id}/board.png" download="${esc(p.name)}-breadboard.png">PNG</a><a href="/api/projects/${p.id}/schematic.svg" target="_blank">Schematic</a><span>${esc(p.doc.board.kind)} board, ${p.doc.wires.length} wires, ${p.doc.checks.filter((c) => c.level === 'error').length} errors</span>${p.activeStep !== null ? '<button data-action="clear-step">Clear highlight</button>' : ''}`;
  legend.innerHTML = Object.entries(p.doc.nets)
    .sort(([, a], [, b]) => (a.power ? 0 : 1) - (b.power ? 0 : 1) || a.name.localeCompare(b.name))
    .map(([net, info]) => `<span data-legend="${esc(net)}" title="click to recolour"><i style="background:${info.color}"></i>${esc(info.name)}</span>`)
    .join('');

  panels.onclick = async (e) => {
    const t = e.target as HTMLElement;
    const tab = t.closest<HTMLElement>('[data-tab]');
    if (tab) return store.setProject({ panel: tab.dataset.tab as ProjectState['panel'] });
    const done = t.closest<HTMLInputElement>('input[data-done]');
    if (done) {
      const n = Number(done.dataset.done);
      const set = new Set(p.done);
      done.checked ? set.add(n) : set.delete(n);
      saveDone(p.id, set);
      return store.setProject({ done: set });
    }
    const step = t.closest<HTMLElement>('li[data-step]');
    if (step) {
      const n = Number(step.dataset.step);
      return store.setProject({ activeStep: p.activeStep === n ? null : n, highlight: null });
    }
    const check = t.closest<HTMLElement>('.check[data-ref]');
    if (check) return store.setProject({ highlight: { ref: check.dataset.ref! }, activeStep: null });
    const action = t.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'reset') {
      try {
        const doc = await api.reset(p.id);
        store.setProject({ doc, sidecar: { ...p.sidecar, pinned: {}, colors: {}, options: doc.board ? { ...p.sidecar.options, board: 'auto', railSplit: null, dipSwitchPositions: 0, packageOrder: [], substitutions: {} } : p.sidecar.options } });
      } catch (err) {
        toast((err as Error).message);
      }
    }
  };
  panels.onchange = async (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const opt = t.dataset.opt;
    if (!opt) return;
    const patch: Record<string, unknown> = {};
    if (opt === 'board') patch.board = t.value;
    if (opt === 'railSplit') patch.railSplit = t.value === 'null' ? null : t.value === 'true';
    if (opt === 'dipSwitchPositions') patch.dipSwitchPositions = Number(t.value);
    if (opt === 'packageOrder') patch.packageOrder = t.value.split(/[\s,]+/).filter(Boolean);
    try {
      const doc = await api.options(p.id, patch);
      store.setProject({ doc, sidecar: { ...p.sidecar, options: { ...p.sidecar.options, ...patch } } });
    } catch (err) {
      toast((err as Error).message);
    }
  };
  toolbar.onclick = (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'fit') fitView(document.getElementById('board')!);
    if (action === 'print') window.print();
    if (action === 'clear-step') store.setProject({ activeStep: null, highlight: null });
  };
  legend.onclick = async (e) => {
    const net = (e.target as HTMLElement).closest<HTMLElement>('[data-legend]')?.dataset.legend;
    if (!net) return;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = p.doc.nets[net].color;
    input.addEventListener('change', async () => {
      try {
        const doc = await api.color(p.id, net, input.value);
        store.setProject({ doc, sidecar: { ...p.sidecar, colors: { ...p.sidecar.colors, [net]: input.value } } });
      } catch (err) {
        toast((err as Error).message);
      }
    });
    input.click();
  };
  legend.onmouseover = (e) => {
    const net = (e.target as HTMLElement).closest<HTMLElement>('[data-legend]')?.dataset.legend;
    if (net && p.activeStep === null) store.setProject({ highlight: { net } });
  };
  legend.onmouseleave = () => {
    if (p.activeStep === null) store.setProject({ highlight: null });
  };
}
```

- [ ] **Step 2: Build and verify in the browser**

Run: `cd circut-ai-tool && bun run typecheck && bun run build`, then `bun start`, open PL1_1. Check: the Guide tab lists phases and steps; ticking a checkbox fills the progress bar and survives reload; clicking a step highlights that wire or part on the board and "Clear highlight" removes it; Parts, Pinouts, Checks and Truth table tabs show their content; in Options, setting DIP switch positions to 4 re-lays the board with a DIP switch and the guide updates; Reset layout returns to the automatic layout; clicking a legend swatch opens a colour picker and recolours the net's wires; Print shows the board on page 1 and the guide after it with no toolbar; the SVG and PNG links download files.

- [ ] **Step 3: Commit**

```bash
git add circut-ai-tool/client/panels.ts
git commit -m "feat(circuit): guide, parts, pinouts, checks, truth table and options panels"
```

---

### Task 21: Connect page and README

**Files:**
- Replace: `circut-ai-tool/client/connect.ts`
- Modify: `circut-ai-tool/README.md`

- [ ] **Step 1: Write client/connect.ts**

```ts
// Copy-paste snippets for Claude Desktop, Claude Code, ChatGPT, Codex and curl.

import { api } from './api.ts';
import { esc, h } from './main.ts';

export async function renderConnect(root: HTMLElement) {
  root.replaceChildren(h('<main class="connect"><header><a href="#/" class="back">← projects</a><h1>Connect an assistant</h1></header><p class="muted">Loading…</p></main>'));
  try {
    const info = await api.connect();
    const main = root.querySelector('main')!;
    main.replaceChildren(
      h(`<header><a href="#/" class="back">← projects</a><h1>Connect an assistant</h1><span class="path">MCP ${esc(info.mcpUrl)}</span></header>`),
      h(`<p>Tools: <code>${info.tools.map(esc).join('</code>, <code>')}</code></p>`),
      ...info.snippets.map((s) => h(`<section class="snippet"><h3>${esc(s.title)}</h3><p class="muted">${esc(s.how)}</p><pre><code>${esc(s.code)}</code></pre><button data-copy>Copy</button></section>`)),
    );
    main.querySelectorAll<HTMLButtonElement>('button[data-copy]').forEach((b) =>
      b.addEventListener('click', async () => {
        await navigator.clipboard.writeText(b.previousElementSibling!.textContent ?? '');
        b.textContent = 'Copied';
        setTimeout(() => (b.textContent = 'Copy'), 1500);
      }),
    );
  } catch (e) {
    root.querySelector('p')!.textContent = `Server not reachable: ${(e as Error).message}`;
  }
}
```

- [ ] **Step 2: Extend README.md**

Add after "Develop":

```markdown
## Run

    bun run build      # once, and after client changes
    bun start          # http://localhost:8765

Open a `.kicad_sch` from the home page (your `Documents\KiCad\9.0\projects`
folder is scanned), drag parts, click switches, follow the guide, print it.
Moved parts, options and colours are saved in `NAME.breadboard.json` next to
the schematic. Saving the schematic in KiCad reloads the board.

## Connect Claude, ChatGPT or Claude Code

Open `http://localhost:8765/#/connect` for copy-paste snippets. The MCP
endpoint is `/mcp` (alias `/mcp-server/mcp`); a stdio entry point for Claude
Desktop is `bun server/mcp-stdio.ts`. ChatGPT needs a tunnel (cloudflared or
ngrok) because it only reaches servers on the internet.

## Environment

`CIRCUIT_PORT` (8765), `CIRCUIT_HOST` (127.0.0.1), `KICAD_CLI`, `KICAD_SYMBOL_DIR`,
`DATA_DIR` (`%LOCALAPPDATA%\UniversityTools\circuit`), `PROJECTS_DIR`.
```

- [ ] **Step 3: Build, verify, commit**

Run: `cd circut-ai-tool && bun run typecheck && bun run build && bun test`
Expected: green. Start the server, open `#/connect`, click Copy on the Claude Desktop snippet and paste it somewhere to confirm the clipboard works. Then, with the server running, save PL1_1 in KiCad (or `touch` the file) and confirm the browser shows "Schematic changed on disk; reloading" and re-renders.

```bash
git add circut-ai-tool/client/connect.ts circut-ai-tool/README.md
git commit -m "feat(circuit): connect page and README"
```

---

## Self-review (part 3)

- Spec coverage: routes `#/`, `#/p/<id>`, `#/connect`; recent list, open box, folder scan; board with wheel zoom, drag to pan, drag parts snapped to holes with live re-layout and server persistence; hover highlights a net; click a switch to toggle the simulator; panels Guide (checkboxes in localStorage, step highlight), Parts (with Unplaced), Pinouts, Checks, Truth table, Options; toolbar with fit, print, SVG/PNG download, schematic link; legend with recolouring; light and dark themes; print stylesheet; live reload through SSE; connect page with copy buttons.
- Placeholder scan: the three stub modules in Task 18 are explicitly replaced in Tasks 19 to 21.
- Type consistency: `SimInput.key` added in Task 19 matches the renderer's `data-switch` values (`part.id` for lead2 switches, `pkg.map[pos]` for folded switches which equals the switch ref, `${pkg.id}:${pos}` for real DIP switches); `api.move` posts `Record<string, Hole>` as `Service.movePart` expects; `renderPanels` and `mountBoard` signatures match their use in `main.ts`.

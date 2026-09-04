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
    <section class="open"><form id="open-form"><label>Schematic path <input name="path" placeholder="C:\\Users\\you\\Documents\\KiCad\\9.0\\projects\\lab1\\lab1.kicad_sch" required></label><button class="primary" type="submit">Open</button></form></section>
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
      <header class="appbar"><a href="#/" class="back">← Projects</a><h1>${esc(p.name)}</h1><span class="path" title="${esc(p.path)}">${esc(p.path)}</span><div class="spacer"></div><a class="btn ghost" href="#/connect">Connect</a><button type="button" id="theme">${s.theme === 'dark' ? 'Light' : 'Dark'}</button></header>
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

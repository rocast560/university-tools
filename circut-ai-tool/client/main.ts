// Entry: routing, data loading, and the page shells. The board and the
// panels are rendered by board.ts and panels.ts (Tasks 19 and 20).

// Bundled, so the type never depends on a CDN (the app runs offline in Docker).
import { mountFullscreenChrome } from './fschrome.ts';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { normalizeSidecar } from '../src/layout/types.ts';
import { parseNetlist } from '../src/netlist.ts';
import { buildLayoutDoc } from '../src/pipeline.ts';
import { analog } from './analog.ts';
import { api, ApiError } from './api.ts';
import { renderConnect } from './connect.ts';
import { mountBoard } from './board.ts';
import { renderPanels } from './panels.ts';
import { close3d } from './view3d.ts';
import { mountLights, noteClient, placeLights } from './lights.ts';
import { mountOrganizer } from './organizer.ts';
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

/** Bumped per load, so a slower, older load cannot land over a newer one. */
let loadSeq = 0;

export async function loadProject(id: string) {
  const seq = ++loadSeq;
  store.set({ loading: true });
  try {
    const [summary, netText, sidecar] = await Promise.all([api.summary(id), api.netlist(id), api.sidecar(id)]);
    if (seq !== loadSeq) return;
    const design = parseNetlist(netText);
    const side = normalizeSidecar(sidecar);
    const doc = buildLayoutDoc(design, side);
    // Read now, not before the fetch: anything the user did while it ran counts.
    const prev = store.get().project;
    const base = { id, name: summary.name, path: summary.path, design, sidecar: side, doc };
    if (prev?.id === id) {
      // The same project reloaded (an edit from the card, an agent, a save on
      // disk): keep what the user was doing wherever it still makes sense in
      // the new design, rather than dumping them back at the start.
      const hl = prev.highlight;
      const hlOk = !hl || (hl.net !== undefined ? !!doc.nets[hl.net] : hl.ref !== undefined ? !!doc.pinHoles[hl.ref] : hl.wire !== undefined ? hl.wire < doc.wires.length : true);
      const running = prev.running && analog.isRunning();
      const next = {
        ...base,
        switches: prev.switches,
        highlight: hlOk ? hl : null,
        activeStep: prev.activeStep !== null && doc.steps.some((x) => x.n === prev.activeStep) ? prev.activeStep : null,
        selectedRef: prev.selectedRef && doc.pinHoles[prev.selectedRef] ? prev.selectedRef : null,
        done: prev.done,
        panel: prev.panel,
        running,
      };
      store.set({ loading: false, project: next });
      // A running simulation carries on with the new design; a stopped one
      // just forgets the old solver, as before.
      if (running) {
        try {
          analog.rebuild(next);
        } catch (e) {
          analog.invalidate();
          store.setProject({ running: false });
          toast(`Simulation stopped: ${(e as Error).message}`);
        }
      } else analog.invalidate();
      return;
    }
    // A different board means a different circuit: drop the old solver.
    analog.invalidate();
    store.set({ loading: false, project: { ...base, switches: {}, highlight: null, activeStep: null, selectedRef: null, done: loadDone(id), panel: 'guide', running: false } });
  } catch (e) {
    if (seq !== loadSeq) return;
    store.set({ loading: false, project: null });
    toast(e instanceof ApiError && e.status === 404 ? 'That project is not open on the server. Open it from the home page.' : (e as Error).message);
    location.hash = '#/';
  }
}

async function renderHome() {
  // The header is rebuilt below; the lights follow it once it exists.
  queueMicrotask(placeLights);
  setTimeout(placeLights, 300);
  app.replaceChildren(h(`<main class="home"><header><h1><span>Bench<span class="brand-mate">Mate</span></span></h1><p class="sub">Open a KiCad schematic and get a breadboard wiring diagram, a build guide, checks and a logic simulator.</p></header>
    <section class="open"><div id="drop" class="dropzone"><b>Drop a .kicad_sch here</b><span class="muted">or</span><button class="primary" type="button" id="pick">Import…</button><input type="file" id="file" accept=".kicad_sch" hidden></div>
      <form id="open-form"><label>Or open one in place <input name="path" placeholder="absolute path to a .kicad_sch" required></label><button type="submit">Open</button></form></section>
    <section><h2>Lab 3 · BCD to 7-segment</h2><p>L3 Auxiliary supplies inverted inputs and segments a–d. This example completes e–g with gates and a common-anode display. W is the 8-bit weight; Z is the 1-bit weight. A low output lights a segment.</p><button type="button" id="lab3-example">Create Lab 3 prelab example</button><p class="muted">Header numbers follow the instructor’s board labels, not its internal IC. Inputs 10–15 are don’t-care cases. The electrical model is approximate.</p></section>
    <section class="organizer"><h2>Projects</h2><div id="organizer"><p class="muted">Loading…</p></div></section>
    <footer><a href="#/connect">Connect Claude, ChatGPT or Claude Code</a> · <a href="/openapi.json">OpenAPI</a></footer></main>`));
  app.querySelector<HTMLButtonElement>('#lab3-example')!.addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      const response = await fetch('/api/examples/lab3', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Could not create example');
      location.hash = `#/p/${result.id}`;
    } catch (error) { toast((error as Error).message); }
    finally { button.disabled = false; }
  });
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
  const drop = app.querySelector<HTMLElement>('#drop')!;
  const filePicker = app.querySelector<HTMLInputElement>('#file')!;
  async function importFile(file: File) {
    if (!file.name.toLowerCase().endsWith('.kicad_sch')) return toast('Only .kicad_sch files can be imported');
    try {
      toast(`Importing ${file.name}…`);
      const s = await api.import(file);
      location.hash = `#/p/${s.id}`;
    } catch (err) {
      toast((err as Error).message);
    }
  }
  app.querySelector('#pick')!.addEventListener('click', () => filePicker.click());
  filePicker.addEventListener('change', () => {
    if (filePicker.files?.[0]) void importFile(filePicker.files[0]);
    filePicker.value = '';
  });
  for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, (e) => (e.preventDefault(), drop.classList.add('over')));
  for (const type of ['dragleave', 'dragend']) drop.addEventListener(type, () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (file) void importFile(file);
  });

  try {
    const lists = await api.list();
    const sep = lists.projectsDir.includes('\\') ? '\\' : '/';
    form.querySelector<HTMLInputElement>('input[name=path]')!.placeholder = `${lists.projectsDir}${sep}lab1${sep}lab1.kicad_sch`;
    await mountOrganizer(app.querySelector<HTMLElement>('#organizer')!, lists);
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
    // The card is about to be replaced, so anything mounted into it has to go
    // with it or its renderer keeps running against a detached canvas.
    close3d();
    app.replaceChildren(h(`<main class="project" data-id="${p.id}">
      <header class="appbar"><a href="#/" class="back">← Projects</a><h1>${esc(p.name)}</h1><span class="path" title="${esc(p.path)}">${esc(p.path)}</span><div class="spacer"></div><a class="btn ghost" href="#/connect">Connect</a><button type="button" id="theme">${s.theme === 'dark' ? 'Light' : 'Dark'}</button></header>
      <div class="layout ${localStorage.getItem('panelsCollapsed') === '1' ? 'collapsed' : ''}"><section class="boardcol"><div class="board-card"><div id="board"></div><div id="toolbar" class="toolbar"></div><div id="legend" class="legend"></div></div></section><aside id="panels" class="panels"></aside></div></main>`));
    boardUnmount = mountBoard(app.querySelector('#board')!);
    mountFullscreenChrome(app.querySelector<HTMLElement>('.board-card')!);
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
  placeLights();
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

mountLights();
api.events((ev) => {
  if (ev.type === 'client' && ev.client) return noteClient(ev.client);
  const p = store.get().project;
  if (!p || ev.projectId !== p.id) return;
  if (ev.type === 'changed') {
    // Service.edit() (the card, an agent over MCP, REST) announces itself as
    // 'edit': the user or their agent asked for it, so no alarm. Anything else
    // is the file changing under us.
    if (ev.source !== 'edit') toast('Schematic changed on disk; reloading');
    void loadProject(p.id);
  } else if (ev.type === 'error') toast(`Reload failed: ${ev.message}`);
});

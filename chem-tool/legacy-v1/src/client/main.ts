// Chemistry Tool web client. One file, no framework: a search box with
// autocomplete, a result view (2D SVG inline, 3D through a lazily loaded
// 3Dmol wrapper), a browse view and a connect view. The URL (?q=, ?view=)
// is the source of truth so links from MCP tools open the same page.

import './styles.css';
import type { Compound, Resolved } from '../chem/types.ts';
import type { ModelOptions, Style3D, Viewer3D } from './viewer3d.ts';

interface MoleculeResponse extends Omit<Resolved, 'svg' | 'molfile'> {
  ok: true;
  svg?: string | null;
  molfile?: string | null;
  lattice: LatticeInfo | null;
  links: Record<string, string>;
}
interface LatticeInfo {
  name: string;
  formula: string;
  type: string;
  title: string;
  note: string;
  a: number;
  c?: number;
  atomsPerCell: number;
  coordination: number;
  packingFactor?: number;
}
interface ErrorResponse {
  ok: false;
  error: string;
  suggestions?: Array<{ id: string; name: string; formula: string }>;
  pubchemDown?: boolean;
}
interface SearchHit {
  id: string;
  name: string;
  formula: string;
  formulaHtml: string;
  category: string;
  matchedOn: string;
  matchedText: string;
}
interface Summary {
  id: string;
  name: string;
  formula: string;
  formulaHtml: string;
  molarMass: number;
  category: string;
  kind: string;
  note: string;
}

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const main = $('#main');
const input = $<HTMLInputElement>('#search-input');
const form = $<HTMLFormElement>('#search-form');
const suggestions = $<HTMLUListElement>('#suggestions');

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function h(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  return (await res.json()) as T;
}

// ---------- Routing ----------

type View = 'home' | 'result' | 'browse' | 'connect';

function route(): { view: View; q: string; category: string; lattice: boolean } {
  const p = new URLSearchParams(location.search);
  const q = (p.get('q') ?? '').trim();
  const view = (p.get('view') as View | null) ?? (q ? 'result' : 'home');
  return { view: view === 'lattice' ? 'result' : view, q, category: p.get('category') ?? '', lattice: p.get('view') === 'lattice' };
}

function navigate(params: Record<string, string | undefined>, replace = false): void {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const url = p.size ? `?${p}` : location.pathname;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  render();
}

window.addEventListener('popstate', () => render());

document.addEventListener('click', (ev) => {
  const a = (ev.target as HTMLElement).closest('a[data-nav], a[href^="?"]') as HTMLAnchorElement | null;
  if (!a || ev.metaKey || ev.ctrlKey) return;
  ev.preventDefault();
  const nav = a.dataset.nav;
  if (nav === 'home') navigate({});
  else navigate(Object.fromEntries(new URL(a.href).searchParams));
});

function lookup(q: string): void {
  input.value = q;
  hideSuggestions();
  navigate({ q });
}

// ---------- Search box ----------

let debounce = 0;
let activeIndex = -1;
let hits: Array<{ text: string; html: string; remote: boolean }> = [];

function hideSuggestions(): void {
  suggestions.hidden = true;
  activeIndex = -1;
}

function showSuggestions(): void {
  if (!hits.length) return hideSuggestions();
  suggestions.innerHTML = hits
    .map((s, i) => `<li data-i="${i}" class="${i === activeIndex ? 'active' : ''}${s.remote ? ' remote' : ''}">${s.html}</li>`)
    .join('');
  suggestions.hidden = false;
}

async function fetchSuggestions(q: string): Promise<void> {
  const data = await getJson<{ hits: SearchHit[]; pubchem: string[] }>(`/api/search?q=${encodeURIComponent(q)}&limit=8&remote=1`);
  if (input.value.trim() !== q) return;
  hits = [
    ...data.hits.map((s) => ({
      text: s.name,
      remote: false,
      html: `<span>${esc(s.name)}${s.matchedOn === 'alias' ? ` <span class="f">(${esc(s.matchedText)})</span>` : ''}</span><span class="f">${s.formulaHtml}</span>`,
    })),
    ...data.pubchem.map((n) => ({ text: n, remote: true, html: `<span>${esc(n)}</span><span class="f">PubChem</span>` })),
  ];
  showSuggestions();
}

input.addEventListener('input', () => {
  clearTimeout(debounce);
  const q = input.value.trim();
  if (q.length < 2) return hideSuggestions();
  debounce = window.setTimeout(() => void fetchSuggestions(q).catch(hideSuggestions), 120);
});
input.addEventListener('keydown', (ev) => {
  if (suggestions.hidden) return;
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    activeIndex = (activeIndex + (ev.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
    showSuggestions();
  } else if (ev.key === 'Enter' && activeIndex >= 0) {
    ev.preventDefault();
    lookup(hits[activeIndex].text);
  } else if (ev.key === 'Escape') hideSuggestions();
});
suggestions.addEventListener('mousedown', (ev) => {
  const li = (ev.target as HTMLElement).closest('li');
  if (li) {
    ev.preventDefault();
    lookup(hits[Number(li.dataset.i)].text);
  }
});
input.addEventListener('blur', () => setTimeout(hideSuggestions, 150));
form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const q = input.value.trim();
  if (q) lookup(q);
});

// ---------- Views ----------

function setNav(view: View): void {
  document.querySelectorAll<HTMLAnchorElement>('.nav a').forEach((a) => a.classList.toggle('current', a.dataset.nav === view));
}

async function render(): Promise<void> {
  const r = route();
  setNav(r.view);
  if (r.view === 'result' && r.q) {
    input.value = r.q;
    await renderResult(r.q, r.lattice);
  } else if (r.view === 'browse') await renderBrowse(r.category);
  else if (r.view === 'connect') await renderConnect();
  else renderHome();
}

const EXAMPLES = ['water', 'CH3COOH', 'caffeine', 'C6H12O6', 'NaCl', 'benzene', 'aspirin', 'sulfuric acid', 'Ca(OH)2', 'diamond', 'R-134a', 'TNT', 'c1ccccc1O'];

function renderHome(): void {
  document.title = 'Chemistry Tool';
  main.replaceChildren(
    h(`<section class="hero">
      <h1>Any chemical, drawn in 2D and 3D</h1>
      <p>Type a name, a formula in any spelling, a CAS number, a PubChem CID or a SMILES string.</p>
      <div class="examples">${EXAMPLES.map((e) => `<button type="button" data-q="${esc(e)}">${esc(e)}</button>`).join('')}</div>
    </section>`),
    h('<div id="home-cats"></div>'),
  );
  main.querySelectorAll<HTMLButtonElement>('[data-q]').forEach((b) => b.addEventListener('click', () => lookup(b.dataset.q!)));
  void getJson<{ categories: Array<{ category: string; count: number }> }>('/api/categories').then((data) => {
    const el = main.querySelector('#home-cats');
    if (!el) return;
    el.replaceChildren(
      h(`<div class="cats">${data.categories
        .map((c) => `<a class="chip link" href="?view=browse&category=${encodeURIComponent(c.category)}">${esc(c.category)}<span class="count">${c.count}</span></a>`)
        .join('')}</div>`),
    );
  });
}

async function renderBrowse(category: string): Promise<void> {
  document.title = `Browse: ${category || 'categories'}`;
  const cats = await getJson<{ categories: Array<{ category: string; count: number }> }>('/api/categories');
  const catBar = h(`<div class="cats">${cats.categories
    .map((c) => `<a class="chip link${c.category === category ? ' on' : ''}" href="?view=browse&category=${encodeURIComponent(c.category)}">${esc(c.category)}<span class="count">${c.count}</span></a>`)
    .join('')}</div>`);
  const grid = h('<div class="cards"></div>');
  main.replaceChildren(h(`<h1 style="margin:6px 0 0">${esc(category || 'Library')}</h1>`), catBar, grid);
  const data = await getJson<{ entries: Summary[] }>(`/api/library${category ? `?category=${encodeURIComponent(category)}` : ''}`);
  grid.innerHTML = data.entries
    .map((e) => `<button class="card" data-q="${esc(e.name)}"><div><span class="t">${esc(e.name)}</span> <span class="f">${e.formulaHtml}</span></div><div class="s">${esc(e.note)}</div></button>`)
    .join('');
  grid.querySelectorAll<HTMLButtonElement>('[data-q]').forEach((b) => b.addEventListener('click', () => lookup(b.dataset.q!)));
}

async function renderConnect(): Promise<void> {
  document.title = 'Connect Claude or ChatGPT';
  main.replaceChildren(h('<div class="connect"><p>Loading…</p></div>'));
  const info = await getJson<{
    appUrl: string;
    mcpUrl: string;
    openapiUrl: string;
    tools: string[];
    snippets: Array<{ id: string; title: string; how: string; language: string; code: string }>;
  }>('/api/connect');
  const wrap = h(`<div class="connect">
    <h1 style="margin:6px 0 4px">Connect a chat app</h1>
    <p style="color:var(--muted);margin:0 0 16px">The same tools are available to Claude Desktop, Claude Code, ChatGPT and anything that speaks MCP or plain HTTP.
    Tools: ${info.tools.map((t) => `<code>${esc(t)}</code>`).join(', ')}.</p>
  </div>`);
  for (const s of info.snippets) {
    const panel = h(`<section class="panel">
      <h2>${esc(s.title)}<span class="spacer"></span><button class="copy" type="button">Copy</button></h2>
      <div class="how">${esc(s.how)}</div>
      <pre><code>${esc(s.code)}</code></pre>
    </section>`);
    const btn = panel.querySelector('button')!;
    btn.addEventListener('click', () => {
      void navigator.clipboard.writeText(s.code).then(() => {
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = 'Copy'), 1500);
      });
    });
    wrap.appendChild(panel);
  }
  main.replaceChildren(wrap);
}

// ---------- Result view ----------

let viewer: Viewer3D | null = null;
let viewerPromise: Promise<typeof import('./viewer3d.ts')> | null = null;
let currentStyle: Style3D = 'ballstick';
let labelsOn = false;
let spinOn = false;

async function ensureViewer(container: HTMLElement): Promise<Viewer3D> {
  viewerPromise ??= import('./viewer3d.ts');
  const mod = await viewerPromise;
  viewer = mod.createViewer3D(container);
  return viewer;
}

function fmt(n: number, digits = 3): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

async function renderResult(q: string, latticeView: boolean): Promise<void> {
  document.title = `${q} · Chemistry Tool`;
  main.replaceChildren(h('<p style="color:var(--muted)">Looking up…</p>'));
  const res = await fetch(`/api/molecule?q=${encodeURIComponent(q)}`);
  const data = (await res.json()) as MoleculeResponse | ErrorResponse;
  if (!data.ok) {
    main.replaceChildren(
      h(`<div class="error"><strong>${esc(data.error)}</strong>${
        data.suggestions?.length
          ? `<div style="margin-top:8px">Did you mean: ${data.suggestions.map((s) => `<button type="button" data-q="${esc(s.name)}">${esc(s.name)} (${esc(s.formula)})</button>`).join(' ')}</div>`
          : ''
      }</div>`),
    );
    main.querySelectorAll<HTMLButtonElement>('[data-q]').forEach((b) => b.addEventListener('click', () => lookup(b.dataset.q!)));
    return;
  }
  const c = data.compound;
  document.title = `${c.name} (${c.formulaUnicode}) · Chemistry Tool`;

  const head = h(`<div>
    <div class="result-head">
      <h1>${esc(c.name)}</h1>
      <span class="formula">${c.formulaHtml}</span>
      <span class="mass">${fmt(c.molarMass)} g/mol</span>
    </div>
    <div class="chips">
      <span class="chip">${esc(c.kind)}</span>
      ${[c.category, ...c.tags].map((t) => `<a class="chip link" href="?view=browse&category=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}
      <span class="chip">matched on ${esc(data.matchedOn)} · ${esc(c.source)}</span>
    </div>
    ${c.note ? `<p class="note">${esc(c.note)}</p>` : '<div style="height:10px"></div>'}
    ${data.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
  </div>`);

  const grid = h('<div class="grid"></div>');
  const d2 = h(`<section class="panel d2"><h2>2D structure<span class="spacer"></span>
    <a href="${esc(data.links.svg2d)}" target="_blank">SVG</a>&nbsp;<a href="${esc(data.links.png2d)}" target="_blank">PNG</a></h2>
    <div class="body">${data.svg ?? '<span style="color:var(--muted)">No 2D depiction (no SMILES for this record).</span>'}</div></section>`);
  const svgEl = d2.querySelector('svg');
  if (svgEl) {
    svgEl.removeAttribute('width');
    svgEl.removeAttribute('height');
    const vb = svgEl.getAttribute('viewBox')?.split(/\s+/).map(Number) ?? [0, 0, 300, 200];
    const scale = Math.min(520 / vb[2], 400 / vb[3], 3.5);
    svgEl.style.width = `${Math.round(vb[2] * scale)}px`;
    svgEl.style.height = `${Math.round(vb[3] * scale)}px`;
  }

  const hasLattice = !!data.lattice;
  const showLattice = latticeView && hasLattice;
  const d3 = h(`<section class="panel d3"><h2>3D model
      ${hasLattice ? `<span class="group"><button type="button" class="mode${!showLattice ? ' on' : ''}" data-mode="molecule">${c.kind === 'ionic' ? 'formula unit' : 'molecule'}</button><button type="button" class="mode${showLattice ? ' on' : ''}" data-mode="lattice">crystal lattice</button></span>` : ''}
      <span class="spacer"></span>
      <a href="${esc(data.links.sdf)}" download="${esc(c.id)}.sdf">SDF</a>&nbsp;<a href="${esc(data.links.xyz)}" download="${esc(c.id)}.xyz">XYZ</a>&nbsp;<a href="${esc(data.links.pdb)}" download="${esc(c.id)}.pdb">PDB</a>&nbsp;<a href="#" class="png3d">PNG</a>
    </h2>
    <div class="body"><div class="viewer"><div class="loading">Loading 3D viewer…</div></div>
    <div class="toolbar">
      <span class="group">
        <button type="button" data-style="ballstick">Ball &amp; stick</button>
        <button type="button" data-style="stick">Stick</button>
        <button type="button" data-style="spacefill">Space fill</button>
        <button type="button" data-style="wire">Wire</button>
      </span>
      <span class="group">
        <button type="button" data-toggle="labels">Labels</button>
        <button type="button" data-toggle="spin">Spin</button>
        <button type="button" data-action="reset">Reset view</button>
      </span>
      <span class="spacer"></span>
      <span style="color:var(--muted);font-size:13px;align-self:center">Drag to rotate · scroll to zoom · right drag to pan</span>
    </div></div></section>`);
  grid.append(d2, d3);

  const facts = h(`<div class="facts">
    <section class="panel"><h2>Identifiers</h2><div class="body"><dl>
      ${c.iupac ? `<dt>IUPAC</dt><dd>${esc(c.iupac)}</dd>` : ''}
      <dt>Hill formula</dt><dd>${esc(c.hill)}</dd>
      ${c.smiles ? `<dt>SMILES</dt><dd><code>${esc(c.smiles)}</code></dd>` : ''}
      ${c.cas ? `<dt>CAS</dt><dd>${esc(c.cas)}</dd>` : ''}
      ${c.cid ? `<dt>PubChem</dt><dd><a href="${esc(c.pubchemUrl ?? '#')}" target="_blank" rel="noopener">CID ${c.cid}</a></dd>` : ''}
      ${c.charge ? `<dt>Charge</dt><dd>${c.charge > 0 ? '+' : ''}${c.charge}</dd>` : ''}
      ${c.aliases.length ? `<dt>Also called</dt><dd>${esc(c.aliases.join(', '))}</dd>` : ''}
    </dl></div></section>
    <section class="panel"><h2>Composition</h2><div class="body"><table>
      <tr><th>Element</th><th class="n">Atoms</th><th class="n">g/mol</th><th class="n">Mass %</th></tr>
      ${data.composition.map((x) => `<tr><td>${esc(x.name)} (${esc(x.symbol)})</td><td class="n">${x.count}</td><td class="n">${fmt(x.mass, 2)}</td><td class="n">${fmt(x.massPercent, 1)}</td></tr>`).join('')}
      <tr><td><strong>Total</strong></td><td class="n">${data.composition.reduce((s, x) => s + x.count, 0)}</td><td class="n"><strong>${fmt(c.molarMass, 2)}</strong></td><td class="n">100</td></tr>
    </table></div></section>
    ${data.lattice ? `<section class="panel"><h2>Crystal structure</h2><div class="body"><dl>
      <dt>Structure</dt><dd>${esc(data.lattice.title)}</dd>
      <dt>Lattice constant</dt><dd>a = ${data.lattice.a} Å${data.lattice.c ? `, c = ${data.lattice.c} Å` : ''}</dd>
      <dt>Atoms per cell</dt><dd>${data.lattice.atomsPerCell}</dd>
      <dt>Coordination</dt><dd>${data.lattice.coordination}</dd>
      ${data.lattice.packingFactor ? `<dt>Packing factor</dt><dd>${data.lattice.packingFactor}</dd>` : ''}
    </dl><p class="note" style="margin:10px 0 0">${esc(data.lattice.note)}</p></div></section>` : ''}
    ${data.alternatives.length ? `<section class="panel"><h2>Same formula (${esc(c.hill)})</h2><div class="body chips">
      ${data.alternatives.map((a: Compound) => `<button type="button" class="chip link" data-q="${esc(a.name)}">${esc(a.name)} · ${a.formulaHtml}</button>`).join('')}
    </div></section>` : ''}
  </div>`);

  main.replaceChildren(head, grid, facts);
  main.querySelectorAll<HTMLButtonElement>('[data-q]').forEach((b) => b.addEventListener('click', () => lookup(b.dataset.q!)));

  // 3D
  const container = d3.querySelector<HTMLElement>('.viewer')!;
  const toolbar = d3.querySelector<HTMLElement>('.toolbar')!;
  const styleButtons = toolbar.querySelectorAll<HTMLButtonElement>('[data-style]');
  const syncButtons = () => {
    styleButtons.forEach((b) => b.classList.toggle('on', b.dataset.style === currentStyle));
    toolbar.querySelector('[data-toggle="labels"]')!.classList.toggle('on', labelsOn);
    toolbar.querySelector('[data-toggle="spin"]')!.classList.toggle('on', spinOn);
  };
  syncButtons();

  const loadModel = async (mode: 'molecule' | 'lattice') => {
    let molfile = data.molfile ?? null;
    let options: ModelOptions = { style: currentStyle, labels: labelsOn, packed: data.structureSource === 'lattice' && c.kind !== 'network' };
    if (mode === 'lattice' && data.lattice) {
      const lat = await getJson<{ ok: boolean; molfile: string; edges: ModelOptions['edges']; type: string }>(`/api/lattice?q=${encodeURIComponent(data.lattice.formula)}&repeat=2`);
      if (lat.ok) {
        molfile = lat.molfile;
        const covalent = ['diamond', 'graphite', 'zincblende'].includes(lat.type);
        options = { style: currentStyle, labels: labelsOn, packed: !covalent, edges: lat.edges };
      }
    }
    if (!molfile) {
      container.innerHTML = '<div class="loading">No 3D structure available for this entry.</div>';
      return;
    }
    try {
      const v = viewer && container.contains(container.querySelector('canvas')) ? viewer : await ensureViewer(container);
      v.setModel(molfile, options);
      v.spin(spinOn);
      container.querySelector('.loading')?.remove();
    } catch (err) {
      container.innerHTML = `<div class="loading">3D viewer failed to start (${esc(String(err))}). WebGL may be disabled.</div>`;
    }
  };
  void loadModel(showLattice ? 'lattice' : 'molecule');

  styleButtons.forEach((b) =>
    b.addEventListener('click', () => {
      currentStyle = b.dataset.style as Style3D;
      viewer?.setStyle(currentStyle);
      syncButtons();
    }),
  );
  toolbar.querySelector('[data-toggle="labels"]')!.addEventListener('click', () => {
    labelsOn = !labelsOn;
    viewer?.setLabels(labelsOn);
    syncButtons();
  });
  toolbar.querySelector('[data-toggle="spin"]')!.addEventListener('click', () => {
    spinOn = !spinOn;
    viewer?.spin(spinOn);
    syncButtons();
  });
  toolbar.querySelector('[data-action="reset"]')!.addEventListener('click', () => viewer?.reset());
  d3.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => {
      d3.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
      const p = new URLSearchParams(location.search);
      if (b.dataset.mode === 'lattice') p.set('view', 'lattice');
      else p.delete('view');
      history.replaceState(null, '', `?${p}`);
      void loadModel(b.dataset.mode as 'molecule' | 'lattice');
    }),
  );
  d3.querySelector<HTMLAnchorElement>('.png3d')!.addEventListener('click', (ev) => {
    ev.preventDefault();
    if (!viewer) return;
    const a = document.createElement('a');
    a.href = viewer.pngDataUrl();
    a.download = `${c.id}-3d.png`;
    a.click();
  });
}

void render();

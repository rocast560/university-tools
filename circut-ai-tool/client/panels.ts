// Right-hand panels (guide, parts, pinouts, checks, truth table, options),
// the toolbar above the board and the net legend below it. Pure "state to HTML" with
// delegated event handlers.

import { displayName } from '../src/netlist.ts';
import { ledSpec, type LedColour } from '../src/parts/led.ts';
import type { ResistorKind } from '../src/parts/resistor.ts';
import type { Highlight, PartGroup } from '../src/render/index.ts';
import { partIcon } from './part-icons.ts';
import { showBar } from './showbar.ts';
import { icon, type IconName } from './icons.ts';
import { shortNet } from '../src/ui/netname.ts';
import type { AnalogState } from '../src/sim/analog/simulator.ts';
import { runTest, switchesForTest, type SimTest } from '../src/sim/tests.ts';
import { analog } from './analog.ts';
import { close3d, is3dOpen, open3d } from './view3d.ts';
import { api } from './api.ts';
import { fitView } from './board.ts';
import { flowOrder } from './floworder.ts';
import { esc, toast } from './main.ts';
import { saveDone, store, type AppState, type ProjectState } from './state.ts';

const TABS: [ProjectState['panel'], string, IconName, string][] = [['guide', 'Guide', 'guide', 'Guide'], ['sim', 'Simulate', 'simulate', 'Simulate'], ['parts', 'Parts', 'parts', 'Parts'], ['pinouts', 'Pinouts', 'pinouts', 'Pinouts'], ['checks', 'Checks', 'checks', 'Checks'], ['truth', 'Truth', 'truth', 'Truth table'], ['options', 'Options', 'options', 'Options']];

const LED_COLOURS: [LedColour, string][] = [['red', 'Red'], ['orange', 'Orange'], ['yellow', 'Yellow'], ['green', 'Green'], ['blue', 'Blue'], ['white', 'White'], ['uv', 'UV']];

/**
 * The Simulate panel is rendered once per structural change and then patched
 * in place - see patchSim(). Rebuilding this HTML every frame would mean
 * three innerHTML writes per frame, which costs far more than the solver.
 */
function sim(p: ProjectState): string {
  const inputs = p.doc.sim.model.inputs;
  const leds = p.doc.parts.filter((x) => x.style === 'LED');
  const parts = p.doc.parts.filter((x) => x.style === 'R' || x.style === 'LED' || x.style === 'D');
  const nets = Object.keys(p.doc.nets).sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { numeric: true }));
  const controls = inputs.length
    ? `<ul class="sources">${inputs.map((i) => `<li><label><input type="checkbox" data-sw="${esc(i.key)}" ${p.switches[i.key] ? 'checked' : ''}> <b class="mono" title="${esc(i.name)}">${esc(i.name)}</b></label><span class="muted">${esc(i.control)}</span><span class="mono" data-live-net="${esc(displayName(i.net))}">—</span></li>`).join('')}</ul>`
    : '<p class="muted">No switches on this board, so there is nothing to drive by hand.</p>';
  const colours = leds.length
    ? `<h3>LED colour</h3><ul class="ledcolours">${leds.map((l) => `<li><b class="mono">${esc(l.id)}</b><select data-ledcolour="${esc(l.id)}">${LED_COLOURS.map(([k, label]) => `<option value="${k}" ${ledColourOf(p, l.id) === k ? 'selected' : ''}>${label}</option>`).join('')}</select><span class="mono" data-live-i="${esc(l.id)}">—</span></li>`).join('')}</ul>`
    : '';
  return `<div class="panel sim">
    <h2>Simulate</h2>
    <p class="muted">A real solve of the board as wired: every net gets a voltage, every part a current. Press Run in the toolbar.</p>
    <div class="simstat"><span class="mono" data-live-clock>0.000 s</span><span class="mono" data-live-status>idle</span></div>
    ${testsSection(p)}
    <h3>Inputs</h3>${controls}
    ${colours}
    <h3>Faults</h3><div data-live-faults><p class="muted">None.</p></div>
    <h3>Parts</h3>
    <table class="live"><tr><th>Part</th><th>Current</th><th>Power</th></tr>
    ${parts.map((x) => `<tr data-ref="${esc(x.id)}"><td class="mono">${esc(x.id)} ${esc(x.value)}</td><td class="mono" data-live-i="${esc(x.id)}">—</td><td class="mono" data-live-p="${esc(x.id)}">—</td></tr>`).join('')}</table>
    <h3>Nets</h3>
    <table class="live"><tr><th>Net</th><th>Voltage</th></tr>
    ${nets.map((netName) => `<tr data-net="${esc(netName)}"><td class="mono">${esc(displayName(netName))}</td><td class="mono" data-live-net="${esc(displayName(netName))}">—</td></tr>`).join('')}</table>
  </div>`;
}

/** What a test expects, in words: the LEDs by their value (SIGN rather than D1) and the digit on each display. */
function expectText(p: ProjectState, t: SimTest): string {
  const name = (ref: string) => p.doc.parts.find((x) => x.id === ref)?.value ?? ref;
  const leds = Object.entries(t.expect?.leds ?? {}).map(([ref, on]) => `${name(ref)} ${on ? 'on' : 'off'}`);
  const shows = Object.entries(t.expect?.displays ?? {}).map(([ref, d]) => `${ref} shows ${d}`);
  return [...shows, ...leds].join(', ');
}

/**
 * Saved tests: pick one and the switches are set for it, the board shows the
 * result, and the panel says whether it matches what the test expects. The
 * pass marks come from the logic simulator, so they are there before Run.
 */
function testsSection(p: ProjectState): string {
  const tests = p.sidecar.tests;
  if (!tests.length) return '';
  const model = p.doc.sim.model;
  const outcomes = tests.map((t) => runTest(model, t));
  const passing = outcomes.filter((o) => o.pass).length;
  const cur = p.simTest ?? null;
  const groups: [string, number[]][] = [];
  tests.forEach((t, i) => {
    const g = t.group ?? 'Tests';
    const last = groups[groups.length - 1];
    if (last && last[0] === g) last[1].push(i);
    else groups.push([g, [i]]);
  });
  const option = (i: number) => `<option value="${i}" ${cur === i ? 'selected' : ''}>${outcomes[i].pass ? '✓' : '✗'} ${esc(tests[i].name)}</option>`;
  const select = `<select data-test><option value="" ${cur === null ? 'selected' : ''}>Choose a test to set the switches</option>${groups.map(([g, idx]) => `<optgroup label="${esc(g)}">${idx.map(option).join('')}</optgroup>`).join('')}</select>`;
  let detail = '';
  if (cur !== null && tests[cur]) {
    const t = tests[cur];
    const o = outcomes[cur];
    const shown = Object.entries(o.shown).map(([ref, d]) => `${ref} shows ${d}`);
    const leds = Object.keys(t.expect?.leds ?? {}).map((ref) => `${p.doc.parts.find((x) => x.id === ref)?.value ?? ref} ${o.result.leds[ref] ? 'on' : 'off'}`);
    detail = `<div class="testcase ${o.pass ? 'pass' : 'fail'}">
      ${t.note ? `<p class="mono">${esc(t.note)}</p>` : ''}
      <p><b>Expected:</b> ${esc(expectText(p, t)) || 'nothing recorded'}</p>
      <p><b>Board:</b> ${esc([...shown, ...leds].join(', '))}</p>
      <p class="verdict">${o.pass ? 'Pass' : `Fail: ${esc(o.failures.join('; '))}`}</p>
    </div>`;
  }
  return `<h3>Tests</h3>
    <div class="tests"><div class="testpick">${select}<button type="button" class="btn ghost" data-action="test-prev" ${cur === null || cur === 0 ? 'disabled' : ''}>Prev</button><button type="button" class="btn ghost" data-action="test-next" ${cur === tests.length - 1 ? 'disabled' : ''}>Next</button></div>
    <p class="muted">${passing} of ${tests.length} pass in the logic simulator.</p>${detail}</div>`;
}

/** Set the switches for saved test `i` (every other input left open) and tell the solver. */
function applyTest(p: ProjectState, i: number | null) {
  if (i === null || !p.sidecar.tests[i]) return store.setProject({ simTest: null });
  const switches = switchesForTest(p.doc.sim.model, p.sidecar.tests[i]);
  store.setProject({ simTest: i, switches });
  analog.refresh({ ...p, switches });
}

/** The colour override for an LED, falling back to whatever its value says. */
export function ledColourOf(p: ProjectState, ref: string): LedColour {
  const override = p.sidecar.ledColors?.[ref];
  if (override) return override;
  const part = p.doc.parts.find((x) => x.id === ref);
  return ledSpec(part?.value ?? 'LED').key;
}

/**
 * Write the live numbers into the panel that is already on the page. Only
 * textContent, and only where the text actually changed.
 */
export function patchSim(root: HTMLElement, s: AnalogState | null, running: boolean) {
  const put = (el: Element | null, text: string) => {
    if (el && el.textContent !== text) el.textContent = text;
  };
  put(root.querySelector('[data-live-clock]'), s ? `${s.time.toFixed(3)} s` : '0.000 s');
  put(root.querySelector('[data-live-status]'), !s ? 'idle' : !s.converged ? 'did not settle' : running ? 'running' : 'solved');
  for (const el of root.querySelectorAll<HTMLElement>('[data-live-net]')) {
    const v = s?.netVolts[el.dataset.liveNet!];
    put(el, v === undefined ? '—' : `${v.toFixed(2)} V`);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-live-i]')) {
    const i = s?.currents[el.dataset.liveI!];
    put(el, i === undefined ? '—' : formatAmps(i));
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-live-p]')) {
    const w = s?.power[el.dataset.liveP!];
    put(el, w === undefined ? '—' : `${(w * 1000).toFixed(1)} mW`);
  }
  const faults = root.querySelector('[data-live-faults]');
  if (faults) {
    const html = s?.faults.length ? s.faults.map((f) => `<div class="check ${f.level}" ${f.ref ? `data-ref="${esc(f.ref)}"` : ''}><b>${esc(f.level)}</b> ${esc(f.message)}</div>`).join('') : '<p class="muted">None.</p>';
    if (faults.innerHTML !== html) faults.innerHTML = html;
  }
}

function formatAmps(i: number): string {
  const a = Math.abs(i);
  if (a < 1e-6) return '0 A';
  if (a < 1e-3) return `${(i * 1e6).toFixed(1)} µA`;
  if (a < 1) return `${(i * 1000).toFixed(2)} mA`;
  return `${i.toFixed(3)} A`;
}

function guide(p: ProjectState): string {
  const total = p.doc.steps.length;
  const done = p.doc.steps.filter((s) => p.done.has(s.n)).length;
  let phase = '';
  const items = p.doc.steps
    .map((s) => {
      const head = s.phase !== phase ? `<li class="phase">${esc(s.phase)}</li>` : '';
      phase = s.phase;
      const label = esc(s.label).replace(/\b([a-j]\d{1,2})\b/g, '<code>$1</code>');
      return `${head}<li class="${p.done.has(s.n) ? 'done' : ''} ${p.activeStep === s.n ? 'active' : ''}" data-step="${s.n}"><input type="checkbox" data-done="${s.n}" aria-label="Step ${s.n} done" ${p.done.has(s.n) ? 'checked' : ''}><b>${s.n}.</b><span>${label}</span></li>`;
    })
    .join('');
  return `<div class="panel"><h2>Build guide</h2><div class="progress"><i style="width:${total ? (100 * done) / total : 0}%"></i></div><p class="muted">${done} of ${total} steps. Click a step to highlight it on the board.</p><ol class="steps">${items}</ol></div>`;
}

function parts(p: ProjectState): string {
  const unplaced = p.doc.unplaced.length ? `<h2>Not placed</h2><ul>${p.doc.unplaced.map((u) => `<li><b>${esc(u.ref)}</b>: ${esc(u.reason)}</li>`).join('')}</ul>` : '';
  const kind = p.sidecar.options.resistorKind;
  const hasResistors = p.doc.partsList.some((l) => l.icon.kind === 'resistor');
  const kindBtn = (k: ResistorKind, label: string) => `<button type="button" class="btn ${kind === k ? 'is-on' : ''}" data-action="resistor-kind" data-kind="${k}" aria-pressed="${kind === k}">${label}</button>`;
  const toggle = hasResistors ? `<div class="resistor-kind"><span class="muted">Resistors</span><div class="tgroup">${kindBtn('carbon', 'Tan carbon film')}${kindBtn('metal', 'Blue metal film')}</div></div>` : '';
  const rows = p.doc.partsList.map((l) => `<li>${partIcon(l.icon, kind, (ref) => ledColourOf(p, ref))}<span>${esc(l.text)}</span></li>`).join('');
  return `<div class="panel"><h2>Parts list</h2>${toggle}<ul class="partslist">${rows}</ul>${unplaced}</div>`;
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
    <label>Board <select data-opt="board"><option value="auto" ${o.board === 'auto' ? 'selected' : ''}>auto</option><option value="half" ${o.board === 'half' ? 'selected' : ''}>half (30 columns)</option><option value="full" ${o.board === 'full' ? 'selected' : ''}>full (63 columns)</option><option value="double" ${o.board === 'double' ? 'selected' : ''}>double (2 full boards side by side)</option><option value="stacked" ${o.board === 'stacked' ? 'selected' : ''}>stacked (2 full boards, one above the other)</option></select></label>
    <label>Rail split <select data-opt="railSplit"><option value="null" ${o.railSplit === null ? 'selected' : ''}>auto</option><option value="true" ${o.railSplit === true ? 'selected' : ''}>split</option><option value="false" ${o.railSplit === false ? 'selected' : ''}>continuous</option></select></label>
    <label>DIP switch positions (0 = separate switches) <input type="number" min="0" max="16" data-opt="dipSwitchPositions" value="${o.dipSwitchPositions}"></label>
    <label>Chip order <input data-opt="packageOrder" value="${esc(o.packageOrder.join(' '))}" placeholder="${esc(chips.join(' '))}"></label>
    <label>2D wires <select data-opt="wireStyle"><option value="arc" ${o.wireStyle !== 'orthogonal' ? 'selected' : ''}>curved arcs (default)</option><option value="orthogonal" ${o.wireStyle === 'orthogonal' ? 'selected' : ''}>square corners, no shared lines</option></select></label>
    <p><button data-action="reset">Reset layout</button> <span class="muted">forgets moved parts, options and colours</span></p>
    <p class="muted mono">${esc(p.path)}</p></div>`;
}

/**
 * Live numbers are written straight into the DOM, off the store, and no more
 * than ten times a second. Nobody reads a 60 Hz table, and textContent writes
 * across forty rows are the expensive part of showing one.
 */
let liveWired = false;
const LIVE_HZ = 10;

let fullscreenHandler: (() => void) | null = null;
/** One listener for entering or leaving full screen, always calling the latest repaint. */
function watchFullscreen(onChange: () => void) {
  const first = fullscreenHandler === null;
  fullscreenHandler = onChange;
  if (first) document.addEventListener('fullscreenchange', () => fullscreenHandler?.());
}

function wireLive() {
  if (liveWired) return;
  liveWired = true;
  let last = 0;
  let trailing = 0;
  const paint = (frame: AnalogState) => {
    last = performance.now();
    const panels = document.getElementById('panels');
    if (panels) patchSim(panels, frame, analog.isRunning());
    const clock = document.querySelector<HTMLElement>('.toolbar [data-live-clock]');
    if (clock) clock.textContent = `${frame.time.toFixed(3)} s`;
  };
  analog.subscribe((frame) => {
    const wait = 1000 / LIVE_HZ - (performance.now() - last);
    if (wait <= 0) {
      clearTimeout(trailing);
      return paint(frame);
    }
    // Always schedule the frame that was throttled away. Dropping it outright
    // loses the last frame of a run, and loses a one-off re-solve entirely -
    // which looks exactly like the change having had no effect.
    clearTimeout(trailing);
    trailing = setTimeout(() => paint(frame), wait) as unknown as number;
  });
}

// The Export menu lives inside the toolbar, which is rebuilt on every state
// change, so whether it is open (and where focus sits in it) is kept here.
let exportOpen = false;
/** Where focus goes after the next paint: -1 the Export button, n the nth item, null leave it. */
let pendingFocus: number | null = null;
let exportRepaint: (() => void) | null = null;
let outsideWired = false;
let exportProject: string | null = null;

function setExport(open: boolean, focus: number | null) {
  exportOpen = open;
  pendingFocus = focus;
  exportRepaint?.();
}

const exportItems = (toolbar: HTMLElement) => [...toolbar.querySelectorAll<HTMLElement>('.export-menu [role="menuitem"]')];

/** Focus inside the menu (or on its button) before a repaint, so the repaint can give it back. */
function exportFocusToKeep(toolbar: HTMLElement): number | null {
  if (pendingFocus !== null) return pendingFocus;
  const a = document.activeElement as HTMLElement | null;
  if (!a || !toolbar.contains(a)) return null;
  if (a.matches('[data-action="export"]')) return -1;
  const i = exportItems(toolbar).indexOf(a);
  return i >= 0 ? i : null;
}

function placeExportMenu(toolbar: HTMLElement, focus: number | null) {
  pendingFocus = null;
  const button = toolbar.querySelector<HTMLElement>('[data-action="export"]');
  const menu = toolbar.querySelector<HTMLElement>('.export-menu');
  if (button && menu) {
    // Fixed, so a toolbar that scrolls sideways (compact full screen) cannot clip it.
    const r = button.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
    // Upward when there is no room below, for example a board card scrolled near the window bottom.
    const below = r.bottom + 4 + menu.offsetHeight <= innerHeight - 8;
    menu.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - 4 - menu.offsetHeight)}px`;
  }
  if (!outsideWired) {
    outsideWired = true;
    document.addEventListener('pointerdown', (e) => {
      if (exportOpen && !(e.target as HTMLElement).closest?.('.export')) setExport(false, null);
    });
    addEventListener('resize', () => exportOpen && setExport(false, null));
    // The menu is fixed to where the button was, so any scroll (capture: scroll does not bubble) closes it.
    document.addEventListener('scroll', (e) => {
      if (exportOpen && !(e.target as HTMLElement).closest?.('.export-menu')) setExport(false, null);
    }, true);
  }
  if (focus === null) return;
  if (focus < 0) button?.focus();
  else {
    // Infinity means the last item (ArrowUp on the closed button).
    const items = exportItems(toolbar);
    items[Math.min(focus, items.length - 1)]?.focus();
  }
}

function exportKey(e: KeyboardEvent, toolbar: HTMLElement) {
  const t = e.target as HTMLElement;
  const items = exportItems(toolbar);
  if (t.closest('[data-action="export"]')) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setExport(!exportOpen, exportOpen ? -1 : 0);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setExport(true, e.key === 'ArrowDown' ? 0 : Infinity);
    } else if (e.key === 'Escape' && exportOpen) {
      e.preventDefault();
      setExport(false, -1);
    } else if (e.key === 'Tab' && exportOpen) setExport(false, -1);
    return;
  }
  const i = items.indexOf(t);
  if (i < 0) return;
  const go = (n: number) => (e.preventDefault(), items[(n + items.length) % items.length].focus());
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(i - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(items.length - 1);
  else if (e.key === 'Escape') {
    e.preventDefault();
    setExport(false, -1);
  } else if (e.key === 'Tab') setExport(false, -1);
}

export function renderPanels(panels: HTMLElement, toolbar: HTMLElement, legend: HTMLElement, s: AppState) {
  const p = s.project;
  if (!p) return;
  wireLive();
  const body = { guide, sim, parts, pinouts, checks, truth, options }[p.panel](p);
  // The tab bar is built once and kept: replacing it on every state change
  // killed the active-pill transition and reset the panel's scroll position.
  const flagged = p.doc.checks.filter((c) => c.level === 'error' || c.level === 'warning').length;
  let tabs = panels.querySelector<HTMLElement>('.tabs');
  if (!tabs) {
    const tab = ([id, label, ic, tip]: (typeof TABS)[number], cls = '') => `<button type="button" role="tab"${cls ? ` class="${cls}"` : ''} data-tab="${id}" title="${tip}" aria-label="${tip}">${icon(ic)}<span class="tl">${label}</span>${id === 'checks' ? '<span class="tab-badge" hidden></span>' : ''}</button>`;
    panels.innerHTML = `<button type="button" class="panels-toggle" data-collapse title="hide or show this panel"><span class="when-open">Hide panel ▸</span><span class="when-closed">◂ Guide</span></button><nav class="tabs" role="tablist" aria-label="Side panel">${TABS.slice(0, -1).map((t) => tab(t)).join('')}<span class="tabs-gap" aria-hidden="true"></span>${tab(TABS[TABS.length - 1], 'util')}</nav><div class="panelbody"></div>`;
    tabs = panels.querySelector<HTMLElement>('.tabs')!;
  }
  for (const b of tabs.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    const on = b.dataset.tab === p.panel;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    if (b.dataset.tab === 'checks') {
      const badge = b.querySelector<HTMLElement>('.tab-badge')!;
      badge.textContent = String(flagged);
      badge.toggleAttribute('hidden', !flagged);
      const tip = flagged ? `Checks, ${flagged} to review` : 'Checks';
      b.title = tip;
      b.setAttribute('aria-label', tip);
    }
  }
  panels.querySelector<HTMLElement>('.panelbody')!.innerHTML = body;
  if (p.panel === 'sim') patchSim(panels, analog.latest(), p.running);

  // A newly opened project never starts with the Export menu open.
  if (exportProject !== p.id) {
    exportProject = p.id;
    exportOpen = false;
    pendingFocus = null;
  }
  // Opening or closing the menu repaints just the toolbar, so the panel keeps its scroll and open details.
  const paintToolbar = () => {
  const errs = p.doc.checks.filter((c) => c.level === 'error').length;
  const wantFocus = exportFocusToKeep(toolbar);
  const fs = !!document.fullscreenElement;
  const square = p.sidecar.options.wireStyle === 'orthogonal';
  toolbar.innerHTML =
    `<div class="tgroup run"><button type="button" class="btn primary ${p.running ? 'is-on' : ''}" data-action="${p.running ? 'stop' : 'run'}">${p.running ? '<span aria-hidden="true">■</span>Stop' : `${icon('run')}Run`}</button><button type="button" class="btn" data-action="step" ${p.running ? 'disabled' : ''}>${icon('step')}Step</button><button type="button" class="btn icon-only" data-action="reset-sim" title="Reset the simulation" aria-label="Reset the simulation">${icon('reset')}</button><span class="simclock mono" data-live-clock>0.000 s</span></div><span class="tsep" aria-hidden="true"></span>` +
    `<div class="tgroup"><button type="button" class="btn icon-only" data-action="fit" title="Fit the board to the view" aria-label="Fit the board to the view">${icon('fit')}</button><button type="button" class="btn icon-only ${fs ? 'is-on' : ''}" data-action="fullscreen" title="${fs ? 'Exit full screen' : 'Full screen'}" aria-label="${fs ? 'Exit full screen' : 'Full screen'}">${icon('fullscreen')}</button><button type="button" class="btn ${square ? 'is-on' : ''}" data-action="wirestyle" aria-pressed="${square}" title="curved arcs or square-cornered runs">${icon('wires')}Square wires</button><button type="button" class="btn ${is3dOpen() ? 'is-on' : ''}" data-action="view3d">${icon('cube')}${is3dOpen() ? 'Exit 3D' : '3D'}</button></div><span class="tsep" aria-hidden="true"></span>` +
    `<div class="export"><button type="button" class="btn" data-action="export" aria-haspopup="menu" aria-expanded="${exportOpen}"${exportOpen ? ' aria-controls="export-menu"' : ''}>${icon('export')}Export<span class="caret" aria-hidden="true">▾</span></button>${
      exportOpen
        ? `<div class="export-menu" id="export-menu" role="menu" aria-label="Export">` +
          `<a role="menuitem" tabindex="-1" href="/api/projects/${p.id}/board.svg" download="${esc(p.name)}-breadboard.svg">Breadboard SVG</a>` +
          `<a role="menuitem" tabindex="-1" href="/api/projects/${p.id}/board.png" download="${esc(p.name)}-breadboard.png">Breadboard PNG</a>` +
          `<a role="menuitem" tabindex="-1" href="/api/projects/${p.id}/schematic.svg" target="_blank" rel="noopener">Schematic</a>` +
          `<button type="button" role="menuitem" tabindex="-1" data-action="print">Print</button></div>`
        : ''
    }</div>` +
    (p.activeStep !== null ? '<button type="button" class="btn ghost" data-action="clear-step">Clear highlight</button>' : '') +
    `<span class="statuschip"><em class="errs ${errs ? 'is-bad' : 'is-ok'}">${errs ? '' : icon('check')}${errs} ${errs === 1 ? 'error' : 'errors'}</em><span>${p.doc.wires.length} wires</span><span>${esc(p.doc.board.kind)}</span></span>`;
  placeExportMenu(toolbar, wantFocus);
  };
  paintToolbar();
  exportRepaint = () => {
    const cur = store.get().project;
    if (cur && cur.id === p.id) paintToolbar();
  };
  const floatEl = document.getElementById('boardfloat');
  if (floatEl) floatEl.innerHTML = showBar(p.partGroup ?? null);
  legend.innerHTML =
    `<b class="legend-label">Nets</b>` +
    (() => {
      const order = flowOrder(p.doc);
      return order
        .map((net) => [net, p.doc.nets[net]] as const)
        .map(([net, info]) => `<span data-legend="${esc(net)}" title="${esc(info.name)} (click to recolour)"><i style="background:${esc(info.color)}"></i><span>${esc(shortNet(net, order))}</span></span>`)
        .join('');
    })();
  watchFullscreen(() => {
    fitView(document.getElementById('board')!);
    renderPanels(panels, toolbar, legend, store.get());
  });

  panels.onclick = async (e) => {
    const t = e.target as HTMLElement;
    const kindBtn = t.closest<HTMLElement>('[data-action="resistor-kind"]');
    if (kindBtn) {
      const resistorKind = kindBtn.dataset.kind as ResistorKind;
      if (resistorKind === p.sidecar.options.resistorKind) return;
      try {
        const doc = await api.options(p.id, { resistorKind });
        store.setProject({ doc, sidecar: { ...p.sidecar, options: { ...p.sidecar.options, resistorKind } } });
      } catch (err) {
        toast((err as Error).message);
      }
      return;
    }
    if (t.closest('[data-collapse]')) {
      // The board column takes the room; the choice sticks across projects.
      const layout = panels.closest<HTMLElement>('.layout');
      const collapsed = layout?.classList.toggle('collapsed') ?? false;
      try {
        localStorage.setItem('panelsCollapsed', collapsed ? '1' : '0');
      } catch {
        /* storage blocked */
      }
      fitView(document.getElementById('board')!);
      return;
    }
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
    const sw = t.closest<HTMLInputElement>('input[data-sw]');
    if (sw) {
      const key = sw.dataset.sw!;
      store.setProject({ switches: { ...p.switches, [key]: sw.checked }, simTest: null });
      return void analog.refresh({ ...p, switches: { ...p.switches, [key]: sw.checked } });
    }
    const action = t.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'test-prev' || action === 'test-next') {
      const n = p.sidecar.tests.length;
      const cur = p.simTest ?? -1;
      return applyTest(p, Math.min(n - 1, Math.max(0, action === 'test-next' ? cur + 1 : cur - 1)));
    }
    if (action === 'reset') {
      try {
        const doc = await api.reset(p.id);
        store.setProject({ doc, sidecar: { ...p.sidecar, pinned: {}, colors: {}, wirePaths: {}, options: doc.board ? { ...p.sidecar.options, board: 'auto', railSplit: null, dipSwitchPositions: 0, packageOrder: [], substitutions: {}, wireStyle: 'arc' } : p.sidecar.options } });
      } catch (err) {
        toast((err as Error).message);
      }
    }
  };
  panels.onchange = async (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    if (t.dataset.test !== undefined) return applyTest(p, t.value === '' ? null : Number(t.value));
    const led = t.dataset.ledcolour;
    if (led) {
      try {
        const doc = await api.ledColor(p.id, led, t.value);
        const ledColors = { ...p.sidecar.ledColors, [led]: t.value as LedColour };
        store.setProject({ doc, sidecar: { ...p.sidecar, ledColors } });
        // The colour changes the diode model, so the solver has to be rebuilt.
        analog.rebuild({ ...p, doc, sidecar: { ...p.sidecar, ledColors } });
      } catch (err) {
        toast((err as Error).message);
      }
      return;
    }
    const opt = t.dataset.opt;
    if (!opt) return;
    const patch: Record<string, unknown> = {};
    if (opt === 'board') patch.board = t.value;
    if (opt === 'railSplit') patch.railSplit = t.value === 'null' ? null : t.value === 'true';
    if (opt === 'dipSwitchPositions') patch.dipSwitchPositions = Number(t.value);
    if (opt === 'packageOrder') patch.packageOrder = t.value.split(/[\s,]+/).filter(Boolean);
    if (opt === 'wireStyle') patch.wireStyle = t.value === 'orthogonal' ? 'orthogonal' : 'arc';
    try {
      const doc = await api.options(p.id, patch);
      store.setProject({ doc, sidecar: { ...p.sidecar, options: { ...p.sidecar.options, ...patch } } });
    } catch (err) {
      toast((err as Error).message);
    }
  };
  toolbar.onkeydown = (e) => exportKey(e, toolbar);
  toolbar.onkeyup = (e) => {
    // Space on the Export button is handled on keydown; keep the click it would add from toggling back.
    if (e.key === ' ' && (e.target as HTMLElement).closest('[data-action="export"]')) e.preventDefault();
  };
  toolbar.onclick = (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'export') {
      // A real click (keyboard activation is taken on keydown): toggle without moving focus.
      setExport(!exportOpen, null);
      return;
    }
    // Picking an item closes the menu once the browser has acted on it.
    if ((e.target as HTMLElement).closest('[role="menuitem"]')) setTimeout(() => setExport(false, -1), 0);
    if (action === 'fit') fitView(document.getElementById('board')!);
    if (action === 'fullscreen') {
      // The whole card goes full screen, so the toolbar and legend stay in reach.
      const card = document.querySelector<HTMLElement>('.board-card')!;
      (document.fullscreenElement ? document.exitFullscreen() : card.requestFullscreen()).catch((err: Error) => toast(err.message));
    }
    if (action === 'print') window.print();
    if (action === 'wirestyle') {
      const wireStyle = p.sidecar.options.wireStyle === 'orthogonal' ? 'arc' : 'orthogonal';
      api.options(p.id, { wireStyle }).then((doc) => store.setProject({ doc, sidecar: { ...p.sidecar, options: { ...p.sidecar.options, wireStyle } } })).catch((err: Error) => toast(err.message));
    }
    if (action === 'clear-step') store.setProject({ activeStep: null, highlight: null });
    if (action === 'run') {
      analog.start(p);
      store.setProject({ running: true });
    }
    if (action === 'stop') {
      analog.stop();
      store.setProject({ running: false });
    }
    if (action === 'step') analog.stepOnce(p);
    if (action === 'reset-sim') analog.reset(p);
    if (action === 'view3d') {
      const repaint = () => renderPanels(panels, toolbar, legend, store.get());
      if (is3dOpen()) {
        close3d();
        repaint();
      } else {
        void open3d().then(repaint);
      }
    }
  };
  // The Show filter floats over the board, outside the legend strip.
  const floating = document.getElementById('boardfloat');
  if (floating) {
    floating.onclick = (e) => {
      const show = (e.target as HTMLElement).closest<HTMLElement>('[data-show]');
      if (!show) return;
      // Picking the same group again goes back to showing everything.
      const group = (show.dataset.show || null) as PartGroup | null;
      store.setProject({ partGroup: group === p.partGroup ? null : group });
    };
    floating.onmouseover = (e) => {
      // Hovering a Show button previews that group: rings and arrows on every part in it.
      const show = (e.target as HTMLElement).closest<HTMLElement>('[data-show]')?.dataset.show;
      if (show === undefined) return;
      const hl: Highlight | null = show ? { group: show as PartGroup } : null;
      // The bar is rebuilt on every change, so only a real change of highlight may set state.
      if (p.activeStep === null && JSON.stringify(hl) !== JSON.stringify(p.highlight ?? null)) store.setProject({ highlight: hl });
    };
    floating.onmouseleave = () => {
      if (p.activeStep === null && p.highlight) store.setProject({ highlight: null });
    };
  }
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
    // The legend is rebuilt on every change, so the pointer is "over" a fresh
    // element after each one: only a real change of highlight may set state,
    // or hovering would re-render forever.
    const set = (hl: Highlight | null) => {
      if (p.activeStep === null && JSON.stringify(hl) !== JSON.stringify(p.highlight ?? null)) store.setProject({ highlight: hl });
    };
    const net = (e.target as HTMLElement).closest<HTMLElement>('[data-legend]')?.dataset.legend;
    if (net) set({ net });
  };
  legend.onmouseleave = () => {
    if (p.activeStep === null && p.highlight) store.setProject({ highlight: null });
  };
}

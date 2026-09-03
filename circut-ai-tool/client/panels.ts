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

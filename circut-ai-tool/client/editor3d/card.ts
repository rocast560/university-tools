// The floating card beside the selected part: what it is, its value (edited
// in place), its pins and their nets, and what can be done to it. It rides
// the part on screen, re-projected each frame only when it has actually
// moved, and flips below the part when there is no room above.
//
// Delete asks inside the card. A browser dialog would block the page's
// event loop, the render loop with it, and every automation driving it.

import { flipDip, rotateLead2, validatePlacement } from '../../src/edit/placement.ts';
import { api } from '../api.ts';
import { icon } from '../icons.ts';
import { esc, loadProject, toast } from '../main.ts';
import { store } from '../state.ts';
import { duplicatePart } from './duplicate.ts';
import { history } from './history.ts';
import { moveCommand } from './manipulate.ts';
import type { Workspace } from './workspace.ts';

const short = (net: string) => net.split('/').filter(Boolean).pop() ?? net;

export function attachCard(ws: Workspace): () => void {
  const card = document.createElement('div');
  card.className = 'ws-card';
  card.hidden = true;
  ws.canvasHost.appendChild(card);
  let shownFor: string | null = null;
  let docFor: unknown = null;
  let last = '';
  const render = () => {
    const p = store.get().project;
    const ref = p?.selectedRef ?? null;
    // Gone after a reload (deleted, renumbered): close rather than point at nothing.
    if (!p || !ref || !p.doc.pinHoles[ref]) {
      card.hidden = true;
      delete card.dataset.ref;
      shownFor = null;
      return;
    }
    if (ref === shownFor && p.doc === docFor) return;
    shownFor = ref;
    docFor = p.doc;
    const comp = p.design.components.get(ref);
    const part = p.doc.parts.find((x) => x.id === ref);
    const pkg = p.doc.packages.find((x) => x.id === ref);
    const pins = Object.entries(p.doc.pinHoles[ref]).sort(([a], [b]) => Number(a) - Number(b) || a.localeCompare(b));
    card.dataset.ref = ref;
    card.hidden = false;
    card.innerHTML =
      `<header><b>${esc(ref)}</b><span>${esc(pkg?.name ?? part?.style ?? comp?.part ?? '')}</span><button type="button" class="ws-card-x" data-card="close" title="Deselect (Esc)" aria-label="Deselect">${icon('close')}</button></header>` +
      `<label>Value <input name="value" value="${esc(comp?.value ?? part?.value ?? '')}" spellcheck="false"></label>` +
      `<ul class="ws-card-pins">${pins.map(([pin, h]) => {
        const net = comp?.pins.get(pin)?.net ?? '';
        return `<li><span>${esc(pin)}</span><span>${esc(h.row + h.col)}</span>${net ? `<button type="button" data-net="${esc(net)}" title="follow this net">${esc(short(net))}</button>` : '<i>unconnected</i>'}</li>`;
      }).join('')}</ul>` +
      '<footer>' +
      (part?.kind === 'lead2' ? '<button type="button" data-card="rotate" title="R">Rotate</button>' : '') +
      (pkg?.kind === 'dip' ? '<button type="button" data-card="flip" title="Shift+R">Flip</button>' : '') +
      '<button type="button" data-card="focus" title="F">Focus</button>' +
      `<button type="button" data-card="duplicate" title="D">${icon('duplicate')}Duplicate</button>` +
      `<button type="button" data-card="delete" class="danger" title="Delete">${icon('trash')}Delete</button>` +
      '</footer><div class="ws-card-confirm" hidden>Remove ' + esc(ref) + ' from the schematic? A backup is kept. <button type="button" data-card="confirm" class="danger">Remove</button><button type="button" data-card="cancel">Keep</button></div>';
    last = '';
  };

  const place = () => {
    if (card.hidden || !shownFor) return;
    const a = ws.board.anchor(shownFor);
    if (!a) return;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const host = ws.canvasHost.getBoundingClientRect();
    const pad = 12;
    let x = a.x - w / 2;
    let y = a.y - h - 18;
    if (y < pad) y = a.y + 28;
    x = Math.min(Math.max(pad, x), host.width - w - pad);
    y = Math.min(Math.max(pad, y), host.height - h - pad);
    const key = `${Math.round(x)},${Math.round(y)},${a.visible}`;
    if (key === last) return;
    last = key;
    card.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    card.style.visibility = a.visible ? 'visible' : 'hidden';
  };

  const busy = async (work: () => Promise<unknown>): Promise<boolean> => {
    const p = store.get().project;
    if (!p) return false;
    card.classList.add('is-busy');
    try {
      await work();
      await loadProject(p.id);
      return true;
    } catch (e) {
      toast((e as Error).message);
      return false;
    } finally {
      card.classList.remove('is-busy');
    }
  };

  card.addEventListener('keydown', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.name !== 'value' || e.key !== 'Enter') return;
    e.preventDefault();
    const p = store.get().project;
    const ref = shownFor;
    if (!p || !ref) return;
    const value = input.value.trim();
    if (!value) return toast('A value cannot be empty');
    // loadProject keeps the selection across a same-project reload, so the card comes back by itself.
    void busy(() => api.editValue(p.id, ref, value));
  });

  card.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const net = t.closest<HTMLElement>('[data-net]')?.dataset.net;
    if (net) return store.setProject({ highlight: { net, soft: true }, activeStep: null });
    const what = t.closest<HTMLElement>('[data-card]')?.dataset.card;
    const p = store.get().project;
    const ref = shownFor;
    if (!what || !p || !ref) return;
    const confirm = card.querySelector<HTMLElement>('.ws-card-confirm')!;
    if (what === 'close') store.setProject({ selectedRef: null });
    if (what === 'focus') ws.board.focus(ref);
    if (what === 'duplicate') void duplicatePart(ref);
    if (what === 'delete') confirm.hidden = false;
    if (what === 'cancel') confirm.hidden = true;
    if (what === 'confirm') void busy(() => api.editRemove(p.id, ref)).then((ok) => ok && store.get().project?.id === p.id && store.setProject({ selectedRef: null }));
    if (what === 'rotate' || what === 'flip') {
      const holes = p.doc.pinHoles[ref];
      const part = p.doc.parts.find((x) => x.id === ref);
      const next = what === 'flip' ? flipDip(holes) : part ? rotateLead2(holes, [part.pins[0], part.pins[1]]) : null;
      const verdict = next ? validatePlacement(p.doc, p.design, ref, next) : null;
      if (!next || !verdict?.ok) return toast(`Can't ${what === 'flip' ? 'flip' : 'turn'} ${ref}: ${verdict?.reason ?? 'the turned leg would leave the board'}`);
      void history.execute(moveCommand(ref, holes, next, `${what} ${ref}`));
    }
  });

  const offStore = store.subscribe(render);
  const offFrame = ws.board.onFrame(place);
  render();
  return () => {
    offStore();
    offFrame();
    card.remove();
  };
}

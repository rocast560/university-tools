// Jumpers in the 3D editor. Click one to select it: its net is followed
// softly, an accent line runs along it, and the wire card opens with its net,
// length and colour. With square wires it also grows handles:
//
// - drag a segment handle to slide that run sideways (snapped to a corridor
//   lane, never onto a row or column of holes; a run out of a hole jogs);
// - drag a bend handle to move the corner;
// - double-click the wire to put a small Z in it, double-click a bend (or
//   click it and press Delete) to take it out.
//
// Every edited plan is judged exactly as the server will judge it on save and
// the router on layout (planToPath, then shapePlan): one that fails goes red
// and is refused. A kept shape is saved through layout/wire as one undoable
// command, and every other wire is re-routed round it by the server. Digit
// keys 1-9 recolour the selected wire's net: colour belongs to the net, as it
// always has.

import { addBendPair, handles as handlesOf, moveBend, moveSegment, nearestRun, removeBend, snapAcross, type Handle } from '../../src/edit/wireshape.ts';
import { holeKey } from '../../src/layout/board.ts';
import { COLOR_GND, COLOR_PLUS, PALETTE } from '../../src/layout/engine.ts';
import type { Wire, WirePath } from '../../src/layout/types.ts';
import type { LayoutDoc } from '../../src/pipeline.ts';
import { P } from '../../src/render/geometry.ts';
import { planLength, planToPath, shapePlan, wireKey, type Point } from '../../src/render/route3d.ts';
import { api } from '../api.ts';
import { esc, toast } from '../main.ts';
import { store } from '../state.ts';
import { history, type Command } from './history.ts';
import { addKeyHandler, type Workspace } from './workspace.ts';

/** The kit's colours, for keys 1 to 9: red, black, then the signal colours, then two spares. */
export const WIRE_COLOURS = [COLOR_PLUS, COLOR_GND, ...PALETTE, '#8E44AD', '#8A8D91'];
const MM = P / 2.54;
/** Movement under this, in CSS px, is a click rather than a drag. */
const CLICK_PX = 4;
/** A press held longer than this, in ms, is not a click (board3d's rule too). */
const CLICK_MS = 600;

/**
 * Whether an edited plan can be this jumper's shape: the saved form of it, or
 * why not. The same two steps the server's save check and the router take,
 * so what is accepted here saves, and what saves lays out as drawn.
 */
function judge(w: Wire, plan: Point[], doc: LayoutDoc): { path: WirePath; why: null } | { path: null; why: string } {
  const path = planToPath(w, plan);
  if (!path) return { path: null, why: 'it leaves the lane grid' };
  const { why } = shapePlan(w, path, doc.packages, doc.board);
  return why ? { path: null, why } : { path, why: null };
}

/**
 * Save one wire's hand shape (null forgets it; key "*" with null forgets
 * them all) and take the server's doc. False, with a toast, when refused.
 */
export async function commitWirePath(key: string, path: WirePath | null): Promise<boolean> {
  const p = store.get().project;
  if (!p) return false;
  try {
    const doc = await api.wirePath(p.id, key, path);
    const q = store.get().project;
    if (!q || q.id !== p.id) return false;
    const wirePaths = key === '*' ? {} : { ...q.sidecar.wirePaths };
    if (key !== '*') {
      if (path) wirePaths[key] = path;
      else delete wirePaths[key];
    }
    store.setProject({ doc, sidecar: { ...q.sidecar, wirePaths } });
    return true;
  } catch (err) {
    toast((err as Error).message);
    return false;
  }
}

/** A wire reshape as an undoable command: the saved shape before and after (null: routed). */
export function wirePathCommand(key: string, before: WirePath | null, after: WirePath | null, label: string): Command {
  return { label, run: () => commitWirePath(key, after), undo: () => commitWirePath(key, before) };
}

/** Forget every hand shape; undo puts each one back. */
function tidyCommand(before: Record<string, WirePath>): Command {
  return {
    label: 'tidy all wires',
    run: () => commitWirePath('*', null),
    async undo() {
      for (const [key, path] of Object.entries(before)) if (!(await commitWirePath(key, path))) return false;
      return true;
    },
  };
}

export interface WireEdit {
  detach(): void;
  /** The selected wire's key, or null. For the e2e hook. */
  selected(): string | null;
  select(key: string | null): void;
}

export function attachWireEdit(ws: Workspace): WireEdit {
  const { board } = ws;
  const dom = board.dom;
  let selected: string | null = null;
  /** The bend picked by a click on its handle, for Delete. */
  let bend: number | null = null;
  let press: { x: number; y: number; t: number } | null = null;
  let drag: {
    key: string;
    index: number;
    pointerId: number;
    handle: Handle;
    origin: Point[];
    x: number;
    y: number;
    moved: boolean;
    plan: Point[] | null;
    /** The snapped plan last previewed, so the tube is rebuilt only when it changes. */
    shown: string;
    path: WirePath | null;
    bad: string | null;
  } | null = null;

  const current = () => {
    const p = store.get().project;
    if (!p || !selected) return null;
    const index = p.doc.wires.findIndex((w) => wireKey(w) === selected);
    if (index < 0) return null;
    return { p, index, wire: p.doc.wires[index], route: p.doc.routes?.[index] ?? null, square: p.sidecar.options.wireStyle === 'orthogonal' };
  };

  const card = document.createElement('div');
  card.className = 'ws-card ws-wirecard';
  card.hidden = true;
  ws.canvasHost.appendChild(card);
  let cardFor = '';
  /** Bumped with every new doc, so the card is rebuilt only when something it shows can have changed. */
  let docSeq = 0;
  let lastDoc = store.get().project?.doc;
  let handlesFor = '';
  let placed = '';

  const renderCard = (c: NonNullable<ReturnType<typeof current>>) => {
    const key = `${selected}|${docSeq}|${c.square}`;
    if (key === cardFor && !card.hidden) return;
    cardFor = key;
    const colour = (c.p.doc.nets[c.wire.net]?.color ?? '').toLowerCase();
    const saved = !!c.p.sidecar.wirePaths[selected!];
    const shaped = Object.keys(c.p.sidecar.wirePaths).length > 0;
    const about = c.route ? `${Math.round(planLength(c.route.plan) / MM)} mm along the board` : 'curved jumper';
    card.hidden = false;
    card.dataset.wire = selected!;
    card.innerHTML =
      `<header><b>${esc(c.p.doc.nets[c.wire.net]?.name ?? c.wire.net)}</b><span>${esc(holeKey(c.wire.a))} to ${esc(holeKey(c.wire.b))}</span><button type="button" class="ws-card-x" data-wire="close" title="Deselect (Esc)">×</button></header>` +
      `<p class="ws-card-note">${about}${saved ? ' · shaped by hand' : ''}${c.route?.warning ? ` · ${esc(c.route.warning)}` : ''}</p>` +
      `<div class="ws-swatches">${WIRE_COLOURS.map((col, i) => `<button type="button" data-colour="${col}" title="${i + 1}" style="background:${col}"${col.toLowerCase() === colour ? ' class="is-on"' : ''}></button>`).join('')}</div>` +
      `<footer>${c.square && saved ? '<button type="button" data-wire="reroute" title="Forget this wire\'s hand shape">Re-route</button>' : ''}${c.square && shaped ? '<button type="button" data-wire="tidy" title="Forget every hand shape">Tidy all wires</button>' : ''}</footer>` +
      `<p class="ws-card-hint">${c.square ? 'drag a handle to reshape · double-click to add or remove a bend · 1-9 colour' : 'switch Wires to square to reshape · 1-9 colour'}</p>`;
    placed = '';
  };

  const paint = () => {
    const c = current();
    if (!c) {
      selected = null;
      bend = null;
      board.setWireSelected(null);
      if (handlesFor) board.setHandles([]);
      handlesFor = '';
      card.hidden = true;
      delete card.dataset.wire;
      return;
    }
    board.setWireSelected(c.index);
    const list = c.square && c.route && !drag ? handlesOf(c.route.plan) : [];
    const key = `${JSON.stringify(list)}|${bend}`;
    if (key !== handlesFor) {
      handlesFor = key;
      board.setHandles(list, bend);
    }
    renderCard(c);
  };

  const select = (key: string | null) => {
    selected = key;
    bend = null;
    // A wire and a part are never selected together.
    if (key && store.get().project?.selectedRef) store.setProject({ selectedRef: null });
    paint();
  };

  const place = () => {
    const c = card.hidden ? null : current();
    if (!c) return;
    const a = board.wireAnchor(c.index);
    if (!a) return;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const host = ws.canvasHost.getBoundingClientRect();
    const pad = 12;
    let x = a.x - w / 2;
    let y = a.y - h - 22;
    if (y < pad) y = a.y + 28;
    x = Math.min(Math.max(pad, x), host.width - w - pad);
    y = Math.min(Math.max(pad, y), host.height - h - pad);
    const key = `${Math.round(x)},${Math.round(y)},${a.visible}`;
    if (key === placed) return;
    placed = key;
    card.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    card.style.visibility = a.visible ? 'visible' : 'hidden';
  };

  /** Keep `plan` as the wire's shape, after judging it; a refusal puts the routed shape and the handles back. */
  const save = async (key: string, index: number, plan: Point[], label: string) => {
    const p = store.get().project;
    if (!p) return;
    const wire = p.doc.wires[index];
    const v = judge(wire, plan, p.doc);
    if (!v.path) {
      board.setWirePreview(index, null);
      toast(`Not reshaped: ${v.why}`);
      return paint();
    }
    const before = p.sidecar.wirePaths[key] ?? null;
    const ok = await history.execute(wirePathCommand(key, before, v.path, `${label} the ${wire.net} jumper`));
    // A kept shape rebuilds the board from the new doc; a refusal needs the routed shape back.
    if (!ok && store.get().project?.doc === p.doc) {
      board.setWirePreview(index, null);
      paint();
    }
  };

  const recolour = (colour: string) => {
    const c = current();
    if (!c) return;
    const { id } = c.p;
    const net = c.wire.net;
    api
      .color(id, net, colour)
      .then((doc) => {
        const q = store.get().project;
        if (q?.id === id) store.setProject({ doc, sidecar: { ...q.sidecar, colors: { ...q.sidecar.colors, [net]: colour } } });
      })
      .catch((err: Error) => toast(err.message));
  };

  const straighten = (k: number) => {
    const c = current();
    if (!c?.route) return;
    const out = removeBend(c.route.plan, k);
    if (!out) return void toast("That bend holds the wire's end on its column");
    bend = null;
    void save(selected!, c.index, out, 'straighten');
  };

  const endDrag = () => {
    if (!drag) return;
    const d = drag;
    // Cleared first, so the lostpointercapture that releasing fires finds nothing left to end.
    drag = null;
    board.setOrbit(true);
    if (dom.hasPointerCapture(d.pointerId)) dom.releasePointerCapture(d.pointerId);
    ws.hint('');
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || board.flying || drag) return;
    press = { x: e.clientX, y: e.clientY, t: performance.now() };
    const c = current();
    if (!c?.square || !c.route) return;
    const h = board.pickHandle(e);
    const handle = h && handlesOf(c.route.plan).find((k) => k.kind === h.kind && k.index === h.index);
    if (!handle) return;
    // A press on a handle is the editor's, decided before OrbitControls (or
    // the part manipulation, or board3d's click) sees it.
    board.setOrbit(false);
    e.stopImmediatePropagation();
    dom.setPointerCapture(e.pointerId);
    drag = { key: selected!, index: c.index, pointerId: e.pointerId, handle, origin: c.route.plan, x: e.clientX, y: e.clientY, moved: false, plan: null, shown: '', path: null, bad: null };
  };

  const onMove = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.stopImmediatePropagation();
    const p = store.get().project;
    const at = board.boardPoint(e);
    if (!p || !at) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < CLICK_PX) return;
    if (!drag.moved) {
      drag.moved = true;
      board.setHandles([]);
      handlesFor = '';
    }
    const { handle, origin } = drag;
    const cols = p.doc.board.cols;
    // Snapped first (wireshape expects it), so the preview jumps lane to lane.
    const next =
      handle.kind === 'segment'
        ? moveSegment(origin, handle.index, snapAcross(handle.horizontal, handle.horizontal ? at[1] : at[0], cols))
        : moveBend(origin, handle.index, [snapAcross(false, at[0], cols), snapAcross(true, at[1], cols)]);
    const shown = JSON.stringify(next);
    if (shown === drag.shown) return;
    drag.shown = shown;
    drag.plan = next;
    const v = judge(p.doc.wires[drag.index], next, p.doc);
    drag.path = v.path;
    drag.bad = v.why;
    board.setWirePreview(drag.index, next, !!drag.bad);
    ws.hint(drag.bad ? `can't shape it like that: ${drag.bad}` : 'release to keep this shape');
  };

  const onUp = (e: PointerEvent) => {
    if (drag) {
      if (e.pointerId !== drag.pointerId) return;
      e.stopImmediatePropagation();
      const d = drag;
      endDrag();
      press = null;
      if (!d.moved) {
        // A click on a bend picks it, for Delete.
        if (d.handle.kind === 'bend') bend = bend === d.handle.index ? null : d.handle.index;
        return paint();
      }
      const changed = !!d.plan && d.shown !== JSON.stringify(d.origin);
      if (!changed || d.bad) {
        board.setWirePreview(d.index, null);
        if (d.bad) toast(`Not reshaped: ${d.bad}`);
        return paint();
      }
      void save(d.key, d.index, d.plan!, 'reshape');
      return;
    }
    const start = press;
    press = null;
    if (!start || e.button !== 0 || board.flying) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_PX || performance.now() - start.t > CLICK_MS) return;
    const hit = board.pick(e);
    const p = store.get().project;
    if (hit?.kind === 'wire' && p?.doc.wires[hit.index]) select(wireKey(p.doc.wires[hit.index]));
    // A part (the manipulation selects it) or empty board drops the wire; a switch leaves it be.
    else if (hit?.kind !== 'switch' && selected) select(null);
  };

  const onDbl = (e: MouseEvent) => {
    const c = current();
    if (!c?.square || !c.route || board.flying) return;
    const h = board.pickHandle(e);
    if (h?.kind === 'bend') {
      // Ours, not a focus glide onto a part the handle happens to sit over.
      e.stopImmediatePropagation();
      return straighten(h.index);
    }
    const hit = board.pick(e);
    const at = board.boardPoint(e);
    if (hit?.kind !== 'wire' || hit.index !== c.index || !at) return;
    const out = addBendPair(c.route.plan, nearestRun(c.route.plan, at), at, c.p.doc.board.cols);
    if (out === c.route.plan) return void toast('That run is too short to bend');
    const v = judge(c.wire, out, c.p.doc);
    if (v.why) return void toast(`Can't bend it there: ${v.why}`);
    void save(selected!, c.index, out, 'bend');
  };

  // The browser took the pointer away: neither a click nor a drop.
  const onCancel = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    endDrag();
    board.setWirePreview(d.index, null);
    paint();
  };

  card.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const colour = t.closest<HTMLElement>('[data-colour]')?.dataset.colour;
    if (colour) return recolour(colour);
    const what = t.closest<HTMLElement>('[data-wire]')?.dataset.wire;
    const c = current();
    if (!what || !c) return;
    if (what === 'close') select(null);
    if (what === 'reroute') void history.execute(wirePathCommand(selected!, c.p.sidecar.wirePaths[selected!] ?? null, null, `re-route the ${c.wire.net} jumper`));
    if (what === 'tidy') void history.execute(tidyCommand({ ...c.p.sidecar.wirePaths }));
  });

  const offKey = addKeyHandler((e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (drag) {
      // F would start a focus glide or flight under the drag; swallow it.
      if (e.key !== 'Escape') return e.key === 'f' || e.key === 'F';
      const d = drag;
      endDrag();
      board.setWirePreview(d.index, null);
      paint();
      return true;
    }
    if (!selected) return false;
    if (/^[1-9]$/.test(e.key)) {
      if (!e.repeat) recolour(WIRE_COLOURS[Number(e.key) - 1]);
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && bend !== null) {
      straighten(bend);
      return true;
    }
    if (e.key === 'Escape') {
      if (bend !== null) {
        bend = null;
        paint();
      } else select(null);
      return true;
    }
    return false;
  });

  let lastRef = store.get().project?.selectedRef ?? null;
  const offStore = store.subscribe((s) => {
    const q = s.project;
    if (q?.doc !== lastDoc) {
      lastDoc = q?.doc;
      docSeq++;
      // A new doc (a kept shape, an edit elsewhere, a reload): any drag is
      // over, and a picked bend may no longer be the same corner.
      if (drag) endDrag();
      bend = null;
    }
    // Picking a part drops the wire.
    if (q?.selectedRef && q.selectedRef !== lastRef) selected = null;
    lastRef = q?.selectedRef ?? null;
    paint();
  });
  const offFrame = board.onFrame(place);

  // Capture phase on the canvas, attached before the part manipulation: a
  // press on a handle is stopped here, before that, board3d or OrbitControls.
  dom.addEventListener('pointerdown', onDown, true);
  dom.addEventListener('pointermove', onMove, true);
  dom.addEventListener('pointerup', onUp, true);
  dom.addEventListener('dblclick', onDbl);
  dom.addEventListener('pointercancel', onCancel);
  dom.addEventListener('lostpointercapture', onCancel);
  return {
    selected: () => selected,
    select,
    detach() {
      offKey();
      offStore();
      offFrame();
      endDrag();
      dom.removeEventListener('pointerdown', onDown, true);
      dom.removeEventListener('pointermove', onMove, true);
      dom.removeEventListener('pointerup', onUp, true);
      dom.removeEventListener('dblclick', onDbl);
      dom.removeEventListener('pointercancel', onCancel);
      dom.removeEventListener('lostpointercapture', onCancel);
      card.remove();
    },
  };
}

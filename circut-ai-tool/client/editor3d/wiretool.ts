// The wire tool: draw a jumper from one hole to another. W or the toolbar's
// Wire button turns it on. Click a hole, then click a second one (or press on
// the first and let go over the second); a ghost jumper follows the pointer
// with the hint saying what it would do. There are no bends to click: the
// router lays the jumper, and its shape is edited from the wire card.
//
// A jumper is a schematic change only when one end's strip carries a net and
// the other's holds legs that are on none: those legs join the net. A jumper
// between two strips already on one net changes nothing (the engine owns
// jumpers), and one between two nets is refused. That decision is
// jumperOutcome's (src/edit/placement.ts); this file wires pointer events to it.

import { holeNear } from '../../src/edit/newpart.ts';
import { jumperOutcome, type JumperOutcome, type Tint } from '../../src/edit/placement.ts';
import type { Hole } from '../../src/layout/types.ts';
import { displayName } from '../../src/netlist.ts';
import { api } from '../api.ts';
import { loadProject, toast } from '../main.ts';
import { store } from '../state.ts';
import { claimTool, onToolClaimed } from './tool.ts';
import { addKeyHandler, type Workspace } from './workspace.ts';

/** Movement under this, in CSS px, is a click rather than a drag. */
const TAP_PX = 4;
const IDLE_HINT = 'click a hole to start a jumper · Esc cancels';

const same = (a: Hole | null, b: Hole | null) => !!a && !!b && a.col === b.col && a.row === b.row;
const describe = (o: JumperOutcome) => (o.kind === 'connect' ? `joins ${displayName(o.net)}` : o.kind === 'same' ? `already on ${displayName(o.net)}` : o.reason);

export function attachWireTool(ws: Workspace): () => void {
  const { board } = ws;
  const button = ws.root.querySelector<HTMLButtonElement>('[data-ws=wire]')!;
  let on = false;
  let busy = false;
  let disposed = false;
  /** The jumper's first end, once a hole has been clicked. */
  let a: Hole | null = null;
  /** The press in progress: where it went down, and whether it set `a`. */
  let down: { x: number; y: number; started: boolean } | null = null;
  /** The previewed second end, so the preview is redrawn only when it changes. */
  let shown: { b: Hole | null; doc: unknown } | null = null;

  /** The hole under the pointer, when the canvas itself is under it. */
  const holeAt = (e: { clientX: number; clientY: number }) => {
    const p = store.get().project;
    if (!p || document.elementFromPoint(e.clientX, e.clientY) !== board.dom) return null;
    const pt = board.boardPoint(e);
    return pt ? holeNear(p.doc.board, pt) : null;
  };

  const clearPreview = () => {
    if (!shown) return;
    shown = null;
    board.setGhost(null);
    board.setStripTint([]);
  };
  const preview = (e: { clientX: number; clientY: number }) => {
    const p = store.get().project;
    if (!p || !a) return;
    const b = holeAt(e);
    if (shown && shown.doc === p.doc && (same(shown.b, b) || (!shown.b && !b))) return;
    shown = { b, doc: p.doc };
    if (!b || same(a, b)) {
      board.setGhost({ holes: [a], footprint: 'other', ok: true });
      board.setStripTint([]);
      ws.hint(`jumper from ${a.row}${a.col}: click a second hole · Esc cancels`);
      return;
    }
    const o = jumperOutcome(p.doc, p.design, a, b);
    const tone: Tint['tone'] = o.kind === 'refuse' ? 'bad' : o.kind === 'connect' ? 'join' : 'ok';
    const label = o.kind === 'refuse' ? undefined : displayName(o.net);
    board.setGhost({ holes: [a, b], footprint: 'lead2', ok: o.kind !== 'refuse' });
    board.setStripTint([a, b].map((hole) => ({ hole, tone, label })));
    ws.hint(describe(o));
  };

  /** Drop the jumper in progress, keeping the tool on; whether there was one. */
  const drop = () => {
    const had = !!a || !!down;
    if (down) board.setOrbit(true);
    a = null;
    down = null;
    clearPreview();
    if (on) ws.hint(IDLE_HINT);
    return had;
  };

  const finish = async (b: Hole) => {
    const p = store.get().project;
    const from = a;
    drop();
    if (!p || !from || busy) return;
    const o = jumperOutcome(p.doc, p.design, from, b);
    if (o.kind === 'refuse') return void toast(o.reason);
    if (o.kind === 'same') return void toast('already connected: the router lays that jumper');
    busy = true;
    try {
      // An automatically named net gets a label on the first connect, which
      // renames it; the rest then join it under its new name.
      const [first, ...rest] = o.pins;
      await api.editConnect(p.id, first.ref, first.pin, o.net);
      let net = o.net;
      if (rest.length) {
        await loadProject(p.id);
        net = store.get().project?.design.components.get(first.ref)?.pins.get(first.pin)?.net ?? net;
        for (const { ref, pin } of rest) await api.editConnect(p.id, ref, pin, net);
      }
      await loadProject(p.id);
      if (disposed) return;
      net = store.get().project?.design.components.get(first.ref)?.pins.get(first.pin)?.net ?? net;
      toast(`joined ${displayName(net)}`);
    } catch (e) {
      toast(`Not joined: ${(e as Error).message}`);
      await loadProject(p.id).catch(() => {});
    } finally {
      busy = false;
    }
  };

  // ---------- pointer ----------
  // Capture listeners on the canvas's parent run before the canvas's own, so
  // selection, wire editing and orbit never see a press that draws a jumper.
  function onDown(e: PointerEvent) {
    if (e.target !== board.dom) return;
    if (e.button === 2) {
      if (!a) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      drop();
      return;
    }
    if (e.button !== 0) return;
    const hole = holeAt(e);
    // A press off the holes with no jumper started is the board's: orbit, select.
    if (!a && !hole) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (busy) return;
    const started = !a;
    if (started) a = hole;
    down = { x: e.clientX, y: e.clientY, started };
    board.setOrbit(false);
    preview(e);
  }
  function onUp(e: PointerEvent) {
    if (!down) return;
    e.stopImmediatePropagation();
    board.setOrbit(true);
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > TAP_PX;
    const { started } = down;
    down = null;
    // The click that set the first end: wait for the second.
    if (started && !moved) return;
    const b = holeAt(e);
    if (b && !same(a, b)) return void finish(b);
    // A drag let go off the holes (or back on its start) drops the jumper.
    if (moved) drop();
  }
  function onMove(e: PointerEvent) {
    if (a) preview(e);
  }
  function onMenu(e: Event) {
    if (!a) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  const setOn = (next: boolean) => {
    if (next === on) return;
    if (next) claimTool('wire');
    on = next;
    button.classList.toggle('is-on', on);
    if (on) {
      ws.canvasHost.addEventListener('pointerdown', onDown, true);
      ws.canvasHost.addEventListener('pointerup', onUp, true);
      ws.canvasHost.addEventListener('contextmenu', onMenu, true);
      window.addEventListener('pointermove', onMove);
      ws.hint(IDLE_HINT);
    } else {
      drop();
      ws.canvasHost.removeEventListener('pointerdown', onDown, true);
      ws.canvasHost.removeEventListener('pointerup', onUp, true);
      ws.canvasHost.removeEventListener('contextmenu', onMenu, true);
      window.removeEventListener('pointermove', onMove);
      ws.hint('');
    }
  };

  const onButton = () => setOn(!on);
  button.addEventListener('click', onButton);
  const offTool = onToolClaimed((t) => t !== 'wire' && setOn(false));
  const offKey = addKeyHandler((e) => {
    if (e.key === 'w' || e.key === 'W') {
      // W with a jumper half drawn only drops it; the next W turns the tool off.
      if (!drop() || !on) setOn(!on);
      return true;
    }
    if (e.key === 'Escape' && on) {
      if (!drop()) setOn(false);
      return true;
    }
    return false;
  });
  // A new doc under a live preview: its verdict is stale, so draw it again on the next move.
  const offStore = store.subscribe(() => {
    if (shown && shown.doc !== store.get().project?.doc) shown.doc = null;
  });

  return () => {
    disposed = true;
    setOn(false);
    button.removeEventListener('click', onButton);
    offTool();
    offKey();
    offStore();
  };
}

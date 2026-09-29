// Pointer work in the 3D editor: hover and click to select a part,
// double-click to fly to it, and drag a selected part to new holes.
//
// The rule that keeps the camera usable: a press on the part that is already
// selected belongs to the editor, and any other press belongs to orbit. It is
// decided on pointerdown, before OrbitControls sees the event, because
// turning orbit off half-way through a gesture leaves it stuck.

import type { Hole } from '../../src/layout/types.ts';
import { validatePlacement, type Verdict } from '../../src/edit/placement.ts';
import { buildLayoutDoc } from '../../src/pipeline.ts';
import { api } from '../api.ts';
import { shiftHoles } from '../drag.ts';
import { toast } from '../main.ts';
import { store } from '../state.ts';
import { addKeyHandler, type Workspace } from './workspace.ts';

/** Movement under this, in CSS px, is a click rather than a drag (twice that for touch). */
const CLICK_PX = 4;
/** A press held longer than this, in ms, is not a click (board3d's rule too). */
const CLICK_MS = 600;

/**
 * Ask the server to put `ref`'s legs in `holes`, the same call the flat
 * board's drag makes, and take its answer as the new doc. False, with a
 * toast, when it refuses; the store is then left exactly as it was.
 */
export async function commitMove(ref: string, holes: Record<string, Hole>): Promise<boolean> {
  const p = store.get().project;
  if (!p) return false;
  try {
    const doc = await api.move(p.id, ref, holes);
    store.setProject({ doc, sidecar: { ...p.sidecar, pinned: { ...p.sidecar.pinned, [ref]: holes } } });
    return true;
  } catch (err) {
    toast((err as Error).message);
    return false;
  }
}

export function attachManipulation(ws: Workspace): () => void {
  const { board } = ws;
  const dom = board.dom;
  let press: { x: number; y: number; t: number; touch: boolean; ref: string | null } | null = null;
  let hoverQueued: PointerEvent | null = null;
  let hoverRaf = 0;

  let drag: {
    ref: string;
    pointerId: number;
    origin: Record<string, Hole>;
    grab: [number, number];
    columnsOnly: boolean;
    holes: Record<string, Hole> | null;
    verdict: Verdict | null;
    lastKey: string;
  } | null = null;

  const endDrag = () => {
    if (!drag) return;
    const d = drag;
    // Cleared first, so the lostpointercapture that releasing fires finds nothing left to end.
    drag = null;
    board.nudge(d.ref, 0, 0);
    board.setStripTint([]);
    board.setOrbit(true);
    if (dom.hasPointerCapture(d.pointerId)) dom.releasePointerCapture(d.pointerId);
    ws.hint('');
  };

  const cancelHover = () => {
    if (hoverRaf) cancelAnimationFrame(hoverRaf);
    hoverRaf = 0;
    hoverQueued = null;
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || board.flying) return;
    const hit = board.pick(e);
    press = { x: e.clientX, y: e.clientY, t: performance.now(), touch: e.pointerType === 'touch', ref: hit?.kind === 'part' ? hit.ref : null };
    const p = store.get().project;
    const at = board.boardPoint(e);
    if (p && at && hit?.kind === 'part' && hit.ref === p.selectedRef && p.doc.pinHoles[hit.ref]) {
      // Decided here, synchronously, so OrbitControls never starts a rotate.
      board.setOrbit(false);
      // OrbitControls listens on this same canvas; stopImmediatePropagation
      // is what keeps it (and board3d's own click handling) out of this press.
      e.stopImmediatePropagation();
      dom.setPointerCapture(e.pointerId);
      cancelHover();
      const pkg = p.doc.packages.find((x) => x.id === hit.ref);
      drag = { ref: hit.ref, pointerId: e.pointerId, origin: p.doc.pinHoles[hit.ref], grab: at, columnsOnly: !!pkg, holes: null, verdict: null, lastKey: '' };
    }
  };

  const onUp = (e: PointerEvent) => {
    if (drag) {
      const d = drag;
      endDrag();
      press = null;
      if (d.holes && d.verdict?.ok && JSON.stringify(d.holes) !== JSON.stringify(d.origin)) void commitMove(d.ref, d.holes);
      else if (d.verdict && !d.verdict.ok) toast(`Not moved: ${d.verdict.reason}`);
      return;
    }
    const start = press;
    press = null;
    if (!start || e.button !== 0) return;
    const slop = start.touch ? CLICK_PX * 2 : CLICK_PX;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > slop || performance.now() - start.t > CLICK_MS) return;
    const p = store.get().project;
    if (!p) return;
    if (start.ref) store.setProject({ selectedRef: start.ref, highlight: null, activeStep: null });
    // A click on a jacket or empty board is board3d's own business (follow or
    // release a net); it also drops the selection so the two never fight.
    else if (p.selectedRef) store.setProject({ selectedRef: null });
  };

  const onMove = (e: PointerEvent) => {
    if (drag) {
      const p = store.get().project;
      const at = board.boardPoint(e);
      if (!p || !at) return;
      const dx = at[0] - drag.grab[0];
      const dy = at[1] - drag.grab[1];
      // The mesh follows the pointer smoothly; the holes it would drop into snap.
      board.nudge(drag.ref, dx, dy);
      const holes = shiftHoles(drag.origin, dx, dy, p.doc.board, drag.columnsOnly);
      const key = JSON.stringify(holes);
      if (key === drag.lastKey) return;
      drag.lastKey = key;
      drag.holes = holes;
      if (!holes) {
        drag.verdict = { ok: false, reason: 'off the board', tints: [] };
      } else {
        drag.verdict = validatePlacement(p.doc, p.design, drag.ref, holes);
        // The engine has the last word on anything the pure rules cannot see.
        // Built once per change of snapped holes, not once per pointer move.
        if (drag.verdict.ok) {
          const doc = buildLayoutDoc(p.design, { ...p.sidecar, pinned: { ...p.sidecar.pinned, [drag.ref]: holes } });
          const dropped = doc.warnings.find((w) => w.startsWith(`pinned placement for ${drag!.ref} dropped`));
          if (dropped) drag.verdict = { ok: false, reason: dropped.replace(`pinned placement for ${drag.ref} dropped: `, ''), tints: drag.verdict.tints.map((t) => ({ ...t, tone: 'bad' as const })) };
        }
      }
      board.setStripTint(drag.verdict.tints);
      ws.hint(drag.verdict.ok ? `release to move ${drag.ref}` : `can't go here: ${drag.verdict.reason}`);
      return;
    }
    if (press || board.flying) return;
    // One raycast per frame at most, however fast the pointer reports.
    if (!hoverQueued) hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const ev = hoverQueued;
      hoverQueued = null;
      if (!ev) return;
      const hit = board.pick(ev);
      board.setHovered(hit?.kind === 'part' ? hit.ref : null);
    });
    hoverQueued = e;
  };

  const onDbl = (e: MouseEvent) => {
    if (board.flying) return;
    const hit = board.pick(e);
    if (hit?.kind !== 'part') return;
    store.setProject({ selectedRef: hit.ref, highlight: null, activeStep: null });
    board.focus(hit.ref);
  };

  const onLeave = () => {
    // A frame already queued would otherwise re-hover after the pointer has gone.
    cancelHover();
    board.setHovered(null);
  };

  // The browser took the pointer away (a touch that became a scroll, a lost
  // capture): neither a click nor a drop.
  const onCancel = () => {
    press = null;
    endDrag();
  };

  // Escape, or the doc changing underneath (a reload, an edit elsewhere), cancels a drag.
  const offKey = addKeyHandler((e) => {
    if (e.key !== 'Escape' || !drag) return false;
    endDrag();
    return true;
  });
  let docSeen = store.get().project?.doc;
  const offStore = store.subscribe((s) => {
    if (s.project?.doc !== docSeen) {
      docSeen = s.project?.doc;
      endDrag();
    }
  });

  // Capture phase on the canvas: these run before OrbitControls' own listeners.
  dom.addEventListener('pointerdown', onDown, true);
  dom.addEventListener('pointerup', onUp, true);
  dom.addEventListener('pointermove', onMove, true);
  dom.addEventListener('dblclick', onDbl);
  dom.addEventListener('pointerleave', onLeave);
  dom.addEventListener('pointercancel', onCancel);
  dom.addEventListener('lostpointercapture', onCancel);
  return () => {
    offKey();
    offStore();
    endDrag();
    cancelHover();
    dom.removeEventListener('pointerdown', onDown, true);
    dom.removeEventListener('pointerup', onUp, true);
    dom.removeEventListener('pointermove', onMove, true);
    dom.removeEventListener('dblclick', onDbl);
    dom.removeEventListener('pointerleave', onLeave);
    dom.removeEventListener('pointercancel', onCancel);
    dom.removeEventListener('lostpointercapture', onCancel);
  };
}

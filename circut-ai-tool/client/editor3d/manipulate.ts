// Pointer work in the 3D editor: hover and click to select a part,
// double-click to fly to it, and (Task 6) drag a selected part to new holes.
//
// The rule that keeps the camera usable: a press on the part that is already
// selected belongs to the editor, and any other press belongs to orbit. It is
// decided on pointerdown, before OrbitControls sees the event, because
// turning orbit off half-way through a gesture leaves it stuck.

import { store } from '../state.ts';
import type { Workspace } from './workspace.ts';

/** Movement under this, in CSS px, is a click rather than a drag (twice that for touch). */
const CLICK_PX = 4;

export function attachManipulation(ws: Workspace): () => void {
  const { board } = ws;
  const dom = board.dom;
  let press: { x: number; y: number; touch: boolean; ref: string | null } | null = null;
  let hoverQueued: PointerEvent | null = null;

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || board.flying) return;
    const hit = board.pick(e);
    press = { x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch', ref: hit?.kind === 'part' ? hit.ref : null };
  };

  const onUp = (e: PointerEvent) => {
    const start = press;
    press = null;
    if (!start || e.button !== 0) return;
    const slop = start.touch ? CLICK_PX * 2 : CLICK_PX;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > slop) return;
    const p = store.get().project;
    if (!p) return;
    if (start.ref) store.setProject({ selectedRef: start.ref, highlight: null, activeStep: null });
    // A click on a jacket or empty board is board3d's own business (follow or
    // release a net); it also drops the selection so the two never fight.
    else if (p.selectedRef) store.setProject({ selectedRef: null });
  };

  const onMove = (e: PointerEvent) => {
    if (press || board.flying) return;
    // One raycast per frame at most, however fast the pointer reports.
    if (!hoverQueued) requestAnimationFrame(() => {
      const ev = hoverQueued;
      hoverQueued = null;
      if (!ev) return;
      const hit = board.pick(ev);
      board.setHovered(hit?.kind === 'part' ? hit.ref : null);
    });
    hoverQueued = e;
  };

  const onDbl = (e: MouseEvent) => {
    const hit = board.pick(e);
    if (hit?.kind !== 'part') return;
    store.setProject({ selectedRef: hit.ref, highlight: null, activeStep: null });
    board.focus(hit.ref);
  };

  const onLeave = () => board.setHovered(null);

  // Capture phase on the canvas: these run before OrbitControls' own listeners.
  dom.addEventListener('pointerdown', onDown, true);
  dom.addEventListener('pointerup', onUp, true);
  dom.addEventListener('pointermove', onMove, true);
  dom.addEventListener('dblclick', onDbl);
  dom.addEventListener('pointerleave', onLeave);
  return () => {
    dom.removeEventListener('pointerdown', onDown, true);
    dom.removeEventListener('pointerup', onUp, true);
    dom.removeEventListener('pointermove', onMove, true);
    dom.removeEventListener('dblclick', onDbl);
    dom.removeEventListener('pointerleave', onLeave);
  };
}

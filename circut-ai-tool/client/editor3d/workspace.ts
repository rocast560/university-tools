// The 3D editor's shell: a full-screen layer over the page with the tray
// strip, a toolbar, the canvas, the net legend and the hint line. It owns the
// keyboard while it is open, mirrors the store into the scene, and is what
// Esc and the browser's Back button close.
//
// It is mounted on document.body, not inside the board card, so the page
// re-rendering underneath (every store change re-renders the panels) can
// never take the canvas with it.

import { analog } from '../analog.ts';
import type { Board3D } from '../board3d.ts';
import { currentHighlight } from '../board.ts';
import { flowOrder } from '../floworder.ts';
import { esc } from '../main.ts';
import { simState } from '../simstate.ts';
import { store } from '../state.ts';
import { history as editHistory } from './history.ts';
import { attachManipulation } from './manipulate.ts';

export interface Workspace {
  board: Board3D;
  root: HTMLElement;
  canvasHost: HTMLElement;
  hint(text: string): void;
  close(): void;
}
export type KeyHandler = (e: KeyboardEvent, ws: Workspace) => boolean;

const keyHandlers = new Set<KeyHandler>();
export const addKeyHandler = (fn: KeyHandler) => (keyHandlers.add(fn), () => keyHandlers.delete(fn));

const ORBIT_HINT = 'drag to orbit · right-drag to pan · scroll to zoom · click a part to select it · F focus · R rotate · Shift+R flip chip · Del delete · Ctrl+Z undo · Esc close';
const FLY_HINT = 'WASD to move · mouse to look · space and C for up and down · shift to sprint · F or Esc to orbit again';

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName));
};

/**
 * Open the editor. Aborting `signal` while three is still loading takes the
 * shell down again and resolves null; after that, `Workspace.close` is the way.
 */
export async function openWorkspace(onClosed: () => void, signal?: AbortSignal): Promise<Workspace | null> {
  const p = store.get().project;
  if (!p) return null;
  const root = document.createElement('div');
  root.className = 'ws';
  root.innerHTML =
    '<div class="ws-tray" aria-label="Parts tray"><span class="ws-tray-soon">Parts tray: coming in phase 3</span></div>' +
    '<div class="ws-bar">' +
    '<button type="button" class="ws-btn" data-ws="exit" title="Close the 3D editor (Esc)">← Exit</button>' +
    '<button type="button" class="ws-btn" data-ws="fly" title="Fly through (F with nothing selected)">Fly through</button>' +
    '<button type="button" class="ws-btn" data-ws="prev" title="previous build step">◀</button><span class="ws-step"></span><button type="button" class="ws-btn" data-ws="next" title="next build step">▶</button>' +
    '<button type="button" class="ws-btn" data-ws="undo" title="Undo (Ctrl+Z)" disabled>Undo</button><button type="button" class="ws-btn" data-ws="redo" title="Redo (Ctrl+Shift+Z)" disabled>Redo</button>' +
    '<span class="ws-hint"></span></div>' +
    '<div class="ws-canvas"></div>' +
    `<div class="ws-legend">${flowOrder(p.doc).map((net) => `<span data-legend="${esc(net)}" title="click to follow this net"><i style="background:${esc(p.doc.nets[net].color)}"></i><span>${esc(p.doc.nets[net].name)}</span></span>`).join('')}</div>`;
  document.body.appendChild(root);
  document.body.classList.add('ws-open');
  const canvasHost = root.querySelector<HTMLElement>('.ws-canvas')!;
  const hintEl = root.querySelector<HTMLElement>('.ws-hint')!;
  const stepEl = root.querySelector<HTMLElement>('.ws-step')!;

  const dismantle = () => {
    root.remove();
    document.body.classList.remove('ws-open');
  };
  signal?.addEventListener('abort', dismantle, { once: true });
  let mount3d: typeof import('../board3d.ts').mount3d;
  try {
    // Test-only: lets a scenario hold the download open long enough to race it.
    const delay = location.search.includes('e2e') ? (window as { __e3dDelay?: number }).__e3dDelay : 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    ({ mount3d } = await import('../board3d.ts'));
  } catch (e) {
    dismantle();
    throw e;
  }
  // Closed again while three was still downloading.
  if (signal?.aborted || !root.isConnected) {
    dismantle();
    return null;
  }
  let mountedStyle = p.sidecar.options.wireStyle;
  let mountedDoc = p.doc;
  let mountedId = p.id;
  // Whatever has been built so far, so one teardown serves both close() and a failed setup.
  let disposeBoard = () => {};
  let offStore = () => {};
  let offSim = () => {};
  let offKey = () => {};
  let detachManip = () => {};
  let offHistory = () => {};
  const release = () => {
    offStore();
    offSim();
    offKey();
    offHistory();
    detachManip();
    disposeBoard();
    dismantle();
    delete (window as { __e3d?: unknown }).__e3d;
  };
  try {
    if (location.search.includes('e2e') && (window as { __e3dFailMount?: boolean }).__e3dFailMount) throw new Error('mount failed (test)');
    const board = mount3d(canvasHost, p.doc, {
      wireStyle: mountedStyle,
      onToggle(key) {
        const q = store.get().project;
        if (!q) return;
        const switches = { ...q.switches, [key]: !q.switches[key] };
        store.setProject({ switches });
        analog.refresh({ ...q, switches });
      },
      onSelectNet(net) {
        const q = store.get().project;
        if (!q) return;
        if (net) store.setProject({ highlight: { net }, activeStep: null, selectedRef: null });
        else if (q.highlight || q.selectedRef) store.setProject({ highlight: null, selectedRef: null });
      },
      onMode(mode) {
        hintEl.textContent = mode === 'fly' ? FLY_HINT : ORBIT_HINT;
      },
    });
    hintEl.textContent = ORBIT_HINT;
    disposeBoard = () => board.dispose();

    let closed = false;
    const ws: Workspace = {
      board,
      root,
      canvasHost,
      hint: (t) => (hintEl.textContent = t || ORBIT_HINT),
      close() {
        if (closed) return;
        closed = true;
        release();
        onClosed();
      },
    };

    detachManip = attachManipulation(ws);

    const undoBtn = root.querySelector<HTMLButtonElement>('[data-ws=undo]')!;
    const redoBtn = root.querySelector<HTMLButtonElement>('[data-ws=redo]')!;
    const paintHistory = () => {
      undoBtn.disabled = !editHistory.canUndo;
      redoBtn.disabled = !editHistory.canRedo;
    };
    offHistory = editHistory.onChange(paintHistory);
    paintHistory();

    const push = () => {
      const q = store.get().project;
      if (!q || closed) return;
      // A new doc is new parts, and a wire-style change is different jumper
      // geometry; both are a rebuild in place, the camera staying where it is.
      if (q.doc !== mountedDoc || q.sidecar.options.wireStyle !== mountedStyle) {
        // Another project is another undo stack; a re-solve of the same one keeps it.
        if (q.id !== mountedId) {
          mountedId = q.id;
          editHistory.clear();
        }
        mountedDoc = q.doc;
        mountedStyle = q.sidecar.options.wireStyle;
        board.rebuild(q.doc, mountedStyle);
      }
      const s = simState(q.doc.sim.model, q.switches);
      board.setBoard(q.switches, s.leds, s.segments);
      board.setHighlight(currentHighlight(q) ?? (q.selectedRef ? { ref: q.selectedRef, soft: true } : null));
      board.setSelected(q.selectedRef);
      for (const chip of root.querySelectorAll<HTMLElement>('[data-legend]')) chip.classList.toggle('is-on', q.highlight?.net === chip.dataset.legend);
      const n = q.doc.steps.length;
      const step = q.activeStep !== null ? q.doc.steps.find((x) => x.n === q.activeStep) : undefined;
      stepEl.textContent = step ? `Step ${step.n}/${n}: ${step.label}` : `Walk-through: ▶ for step 1 of ${n}`;
    };
    const unsubStore = store.subscribe(push);
    offStore = unsubStore;
    board.setState(analog.refresh(p));
    const unsubSim = analog.subscribe((s) => board.setState(s));
    offSim = unsubSim;

    const stepBy = (dir: -1 | 1) => {
      const q = store.get().project;
      if (!q) return;
      const next = Math.min(q.doc.steps.length, Math.max(0, (q.activeStep ?? 0) + dir));
      store.setProject({ activeStep: next === 0 ? null : next, highlight: null });
    };
    root.querySelector('.ws-bar')!.addEventListener('click', (e) => {
      const what = (e.target as HTMLElement).closest<HTMLElement>('[data-ws]')?.dataset.ws;
      if (what === 'exit') history.back();
      if (what === 'fly') board.setFly(!board.flying);
      if (what === 'prev') stepBy(-1);
      if (what === 'next') stepBy(1);
      if (what === 'undo') void editHistory.undo();
      if (what === 'redo') void editHistory.redo();
    });
    const legend = root.querySelector<HTMLElement>('.ws-legend')!;
    legend.addEventListener('click', (e) => {
      const net = (e.target as HTMLElement).closest<HTMLElement>('[data-legend]')?.dataset.legend;
      const q = store.get().project;
      if (!net || !q) return;
      store.setProject({ highlight: q.highlight?.net === net ? null : { net, soft: true }, activeStep: null });
    });
    legend.addEventListener('mouseover', (e) => board.setHover((e.target as HTMLElement).closest<HTMLElement>('[data-legend]')?.dataset.legend ?? null));
    legend.addEventListener('mouseleave', () => board.setHover(null));

    // Keys: later tasks register handlers; these are the shell's own, tried last.
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      if (!board.flying && (e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'z' || k === 'y') {
          e.preventDefault();
          void (k === 'y' || e.shiftKey ? editHistory.redo() : editHistory.undo());
          return;
        }
      }
      // Ctrl, Cmd and Alt chords (Ctrl+F is the browser's find) are the browser's, unless a handler claims them.
      if (e.ctrlKey || e.metaKey || e.altKey) {
        if (!board.flying) for (const fn of keyHandlers) if (fn(e, ws)) return void e.preventDefault();
        return;
      }
      if (board.flying) {
        if (e.key === 'f' || e.key === 'F' || e.key === 'Escape') {
          e.preventDefault();
          board.setFly(false);
        }
        return;
      }
      for (const fn of keyHandlers) if (fn(e, ws)) return void e.preventDefault();
      const q = store.get().project;
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        if (q?.selectedRef) board.focus(q.selectedRef);
        else board.setFly(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (q?.selectedRef) store.setProject({ selectedRef: null });
        else history.back();
      }
    };
    // Capture phase, so the shell hears a key before anything on the page does.
    document.addEventListener('keydown', onKey, true);
    offKey = () => document.removeEventListener('keydown', onKey, true);

    push();
    // Test hook for scripts/e2e-3d.ts; only present when the URL asks for it.
    if (location.search.includes('e2e')) {
      let frames = 0;
      board.onFrame(() => frames++);
      (window as { __e3d?: unknown }).__e3d = {
        get ready() {
          return frames > 2;
        },
        selected: () => store.get().project?.selectedRef ?? null,
        holes: (ref: string) => store.get().project?.doc.pinHoles[ref] ?? null,
        screenOf(ref: string) {
          const a = board.anchor(ref);
          const r = canvasHost.getBoundingClientRect();
          return a ? { x: r.left + a.x, y: r.top + a.y + 6 } : null;
        },
        pickAt: (x: number, y: number) => board.pick({ clientX: x, clientY: y }),
        parts: () => store.get().project?.doc.parts.map((x) => x.id) ?? [],
        tintCount: () => (board as unknown as { _tintCount(): number })._tintCount(),
        lead2: () => store.get().project?.doc.parts.filter((x) => x.kind === 'lead2').map((x) => x.id) ?? [],
        select: (ref: string) => store.setProject({ selectedRef: ref }),
        chips: () => store.get().project?.doc.packages.filter((x) => x.kind === 'dip').map((x) => x.id) ?? [],
      };
    }
    return ws;
  } catch (e) {
    release();
    throw e;
  }
}

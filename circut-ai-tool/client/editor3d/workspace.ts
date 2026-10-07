// The 3D editor's shell: a full-screen layer over the page with the tray
// strip, a toolbar, the canvas, the net legend and the hint line. It owns the
// keyboard while it is open, mirrors the store into the scene, and is what
// Esc and the browser's Back button close.
//
// It is mounted on document.body, not inside the board card, so the page
// re-rendering underneath (every store change re-renders the panels) can
// never take the canvas with it.

import { analog } from '../analog.ts';
import { api } from '../api.ts';
import type { Board3D } from '../board3d.ts';
import type { ModelSet } from '../models.ts';
import { cachedModels } from './modelcache.ts';
import type { ModelKey } from '../../src/models/manifest.ts';
import { currentHighlight } from '../board.ts';
import { showBar } from '../showbar.ts';
import type { PartGroup } from '../../src/render/index.ts';
import { flowOrder } from '../floworder.ts';
import { esc, toast } from '../main.ts';
import { icon, type IconName } from '../icons.ts';
import { simState } from '../simstate.ts';
import { store } from '../state.ts';
import { history as editHistory } from './history.ts';
import { attachCard } from './card.ts';
import { attachDuplicate } from './duplicate.ts';
import { attachManipulation, commitMove } from './manipulate.ts';
import { _failNextMove, attachTray } from './tray.ts';
import { attachWireEdit } from './wireEdit.ts';
import { attachWireTool } from './wiretool.ts';
import { jumperOutcome } from '../../src/edit/placement.ts';
import { wireKey } from '../../src/render/route3d.ts';
import { placeAt } from '../../src/render/geometry.ts';
import type { Hole } from '../../src/layout/types.ts';

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

const ORBIT_HINT = 'drag to orbit · right-drag to pan · scroll to zoom · click a part or a wire to select it · F focus · R rotate · Shift+R flip chip · 1-9 wire colour · Del delete · Ctrl+Z undo · Esc close';
const FLY_HINT = 'WASD to move · mouse to look · space and C for up and down · shift to sprint · F or Esc to orbit again';

type Detail = 'high' | 'simple';
const DETAIL_KEY = 'benchmate.3dDetail';
const readDetail = (): Detail => {
  try {
    return localStorage.getItem(DETAIL_KEY) === 'simple' ? 'simple' : 'high';
  } catch {
    return 'high';
  }
};
const saveDetail = (d: Detail) => {
  try {
    localStorage.setItem(DETAIL_KEY, d);
  } catch {
    /* private mode: the choice just doesn't persist */
  }
};

// The kit models are fetched once per page; reopening the editor reuses them.
// Never rejects: no models just means the simple shapes.
let dropHook: ModelKey[] = [];
const getModels = cachedModels(() => import('../models.ts').then((m) => m.loadModels('/models/', undefined, dropHook)));

/** A toolbar button's face: its icon, then a label that changes with the state. */
const btnLabel = (name: IconName, text: string) => `${icon(name)}${esc(text)}`;

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
    '<div class="ws-tray" aria-label="Parts tray"></div>' +
    '<div class="ws-bar">' +
    `<button type="button" class="ws-btn" data-ws="exit" title="Close the 3D editor (Esc)">${icon('exit')}Exit</button>` +
    `<button type="button" class="ws-btn" data-ws="fly" title="Fly through (F with nothing selected)">${icon('eye')}Fly through</button>` +
    '<span class="tsep" aria-hidden="true"></span>' +
    `<button type="button" class="ws-btn icon-only" data-ws="prev" title="Previous build step" aria-label="Previous build step">${icon('chevron', 'i flip')}</button><span class="ws-step"></span><button type="button" class="ws-btn icon-only" data-ws="next" title="Next build step" aria-label="Next build step">${icon('chevron')}</button>` +
    '<span class="tsep" aria-hidden="true"></span>' +
    `<button type="button" class="ws-btn" data-ws="wires" title="curved arcs or square-cornered runs">${btnLabel('wires', 'Wires: curved')}</button>` +
    `<button type="button" class="ws-btn" data-ws="detail" title="Real part models or simple shapes">${btnLabel('cube', 'Detail: high')}</button>` +
    `<button type="button" class="ws-btn" data-ws="wire" title="Draw a jumper from one hole to another (W)">${icon('wire')}Wire</button>` +
    '<span class="tsep" aria-hidden="true"></span>' +
    `<button type="button" class="ws-btn icon-only" data-ws="undo" title="Undo (Ctrl+Z)" aria-label="Undo" disabled>${icon('undo')}</button><button type="button" class="ws-btn icon-only" data-ws="redo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled>${icon('redo')}</button>` +
    '<span class="ws-hint"></span></div>' +
    '<div class="ws-canvas"></div>' +
    `<div class="ws-legend">${showBar(p.partGroup ?? null)}${flowOrder(p.doc).map((net) => `<span data-legend="${esc(net)}" title="click to follow this net"><i style="background:${esc(p.doc.nets[net].color)}"></i><span>${esc(p.doc.nets[net].name)}</span></span>`).join('')}</div>`;
  document.body.appendChild(root);
  document.body.classList.add('ws-open');
  const canvasHost = root.querySelector<HTMLElement>('.ws-canvas')!;
  const hintEl = root.querySelector<HTMLElement>('.ws-hint')!;
  const stepEl = root.querySelector<HTMLElement>('.ws-step')!;
  const detailBtn = root.querySelector<HTMLButtonElement>('[data-ws=detail]')!;
  detailBtn.innerHTML = btnLabel('cube', `Detail: ${readDetail()}`);
  const wiresBtn = root.querySelector<HTMLButtonElement>('[data-ws=wires]')!;

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
  let detail = readDetail();
  let models: ModelSet | null = detail === 'high' ? await getModels() : null;
  if (signal?.aborted || !root.isConnected) {
    dismantle();
    return null;
  }
  let mountedStyle = p.sidecar.options.wireStyle;
  let mountedDoc = p.doc;
  let mountedDesign = p.design;
  // Whatever has been built so far, so one teardown serves both close() and a failed setup.
  let disposeBoard = () => {};
  let offStore = () => {};
  let offSim = () => {};
  let offKey = () => {};
  let detachManip = () => {};
  let detachCard = () => {};
  let detachTray = () => {};
  let detachWireTool = () => {};
  let detachDuplicate = () => {};
  let offDel = () => {};
  let offHistory = () => {};
  let detachWires = () => {};
  // Read by onContextLost, which the board can call before setup has finished.
  let closed = false;
  const release = () => {
    offStore();
    offSim();
    offKey();
    offHistory();
    offDel();
    detachWires();
    detachDuplicate();
    detachWireTool();
    detachTray();
    detachCard();
    detachManip();
    disposeBoard();
    dismantle();
    delete (window as { __e3d?: unknown }).__e3d;
    // The flat board draws the selection as a hard highlight that dims
    // everything else; leaving 3D must not leave the page stuck that way.
    if (store.get().project?.selectedRef) store.setProject({ selectedRef: null });
  };
  try {
    if (location.search.includes('e2e') && (window as { __e3dFailMount?: boolean }).__e3dFailMount) throw new Error('mount failed (test)');
    const board = mount3d(canvasHost, p.doc, {
      wireStyle: mountedStyle,
      models,
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
        // Softly: the rest of the board stays as glass, so the wire reads in place.
        if (net) store.setProject({ highlight: { net, soft: true }, activeStep: null, selectedRef: null });
        else if (q.highlight || q.selectedRef) store.setProject({ highlight: null, selectedRef: null });
      },
      onMode(mode) {
        hintEl.textContent = mode === 'fly' ? FLY_HINT : ORBIT_HINT;
      },
      onContextLost() {
        // Every buffer went with the context, so the board cannot be drawn
        // again. Close the way Back does; pressing 3D mounts a fresh one.
        if (closed) return;
        toast('The 3D view lost its graphics context and was closed. Press 3D to open it again.');
        history.back();
      },
    });
    hintEl.textContent = ORBIT_HINT;
    disposeBoard = () => board.dispose();

    const ws: Workspace = {
      board,
      root,
      canvasHost,
      hint: (t) => (hintEl.textContent = t || ORBIT_HINT),
      close() {
        if (closed) return;
        closed = true;
        release();
        editHistory.clear();
        onClosed();
      },
    };

    // Wires first: their canvas listeners must run before the part
    // manipulation's, so a press on a wire handle never reaches it.
    const wires = attachWireEdit(ws);
    detachWires = () => wires.detach();
    detachManip = attachManipulation(ws);
    detachCard = attachCard(ws);
    detachTray = attachTray(ws);
    detachWireTool = attachWireTool(ws);
    detachDuplicate = attachDuplicate(ws);
    offDel = addKeyHandler((e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return false;
      const card = root.querySelector<HTMLElement>('.ws-card:not(.ws-wirecard):not([hidden])');
      const confirm = card?.querySelector<HTMLElement>('.ws-card-confirm');
      // A card whose part is off-screen is invisible: don't act on it unseen.
      if (!card || !confirm || card.style.visibility === 'hidden') return false;
      confirm.hidden = false;
      confirm.querySelector<HTMLButtonElement>('[data-card=confirm]')!.focus();
      return true;
    });

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
        // A schematic reload (another project, or this one edited from the
        // card, an agent or KiCad) can remove or renumber parts the stack
        // points at, so it starts over; a move only swaps the doc and keeps it.
        if (q.design !== mountedDesign) {
          mountedDesign = q.design;
          editHistory.clear();
        }
        mountedDoc = q.doc;
        mountedStyle = q.sidecar.options.wireStyle;
        board.rebuild(q.doc, mountedStyle);
      }
      const s = simState(q.doc.sim.model, q.switches);
      board.setBoard(q.switches, s.leds, s.segments);
      board.setHighlight(currentHighlight(q, (ref) => ({ ref, soft: true })));
      board.setSelected(q.selectedRef);
      for (const chip of root.querySelectorAll<HTMLElement>('[data-legend]')) chip.classList.toggle('is-on', q.highlight?.net === chip.dataset.legend);
      for (const b of root.querySelectorAll<HTMLElement>('.ws-legend [data-show]')) b.classList.toggle('is-on', (b.dataset.show || null) === (q.partGroup ?? null));
      const square = q.sidecar.options.wireStyle === 'orthogonal';
      const wiresText = square ? 'Wires: square' : 'Wires: curved';
      if (wiresBtn.textContent !== wiresText) wiresBtn.innerHTML = btnLabel('wires', wiresText);
      wiresBtn.classList.toggle('is-on', square);
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
      if (what === 'wires') {
        // The same call as the page toolbar's button; the store update it
        // makes is what rebuilds the scene in place (see push).
        const q = store.get().project;
        if (!q) return;
        const wireStyle = q.sidecar.options.wireStyle === 'orthogonal' ? 'arc' : 'orthogonal';
        api
          .options(q.id, { wireStyle })
          .then((doc) => {
            const now = store.get().project;
            if (now?.id === q.id) store.setProject({ doc, sidecar: { ...now.sidecar, options: { ...now.sidecar.options, wireStyle } } });
          })
          .catch((err: Error) => toast(err.message));
      }
      if (what === 'detail') {
        detail = detail === 'high' ? 'simple' : 'high';
        saveDetail(detail);
        detailBtn.innerHTML = btnLabel('cube', `Detail: ${detail}`);
        const want = detail;
        (want === 'high' ? getModels() : Promise.resolve(null)).then((set) => {
          // Toggled again, or closed, while the models were loading.
          if (closed || detail !== want) return;
          models = set;
          board.setModels(models);
        });
      }
      if (what === 'undo') void editHistory.undo();
      if (what === 'redo') void editHistory.redo();
    });
    const legend = root.querySelector<HTMLElement>('.ws-legend')!;
    legend.addEventListener('click', (e) => {
      const show = (e.target as HTMLElement).closest<HTMLElement>('[data-show]');
      if (show) {
        const q = store.get().project;
        const group = (show.dataset.show || null) as PartGroup | null;
        if (q) store.setProject({ partGroup: group === (q.partGroup ?? null) ? null : group });
        return;
      }
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
        // F frames the selection, part or wire (spec section 2); only with nothing selected does it fly.
        const wire = wires.selected();
        const index = wire && q ? q.doc.wires.findIndex((w) => wireKey(w) === wire) : -1;
        if (q?.selectedRef) board.focus(q.selectedRef);
        else if (index >= 0) board.focusWire(index);
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
        // The value in the reloaded design, not whatever an input happens to show.
        value: (ref: string) => store.get().project?.design.components.get(ref)?.value ?? null,
        wireStyle: () => store.get().project?.sidecar.options.wireStyle ?? null,
        // A layout move from outside the pointer path, to change the doc under a live drag.
        move: (ref: string, holes: Parameters<typeof commitMove>[1]) => commitMove(ref, holes),
        // Wires (phase 2).
        routes: () => store.get().project?.doc.routes?.map((r) => r.plan) ?? null,
        wires: () => store.get().project?.doc.wires.map(wireKey) ?? [],
        maxLift: () => Math.max(0, ...(store.get().project?.doc.routes ?? []).flatMap((r) => r.lifts.map((l) => l.height))),
        wireScreen(i: number) {
          const a = board.wireAnchor(i);
          const r = canvasHost.getBoundingClientRect();
          return a ? { x: r.left + a.x, y: r.top + a.y } : null;
        },
        selectedWire: () => wires.selected(),
        selectWire: (key: string | null) => wires.select(key),
        handles: () => (board as unknown as { _handles(): { kind: string; index: number; x: number; y: number }[] })._handles(),
        wirePath: (key: string) => store.get().project?.sidecar.wirePaths[key] ?? null,
        netColor: (net: string) => store.get().project?.doc.nets[net]?.color ?? null,
        wireTop: () => (board as unknown as { _wireTop(): number })._wireTop(),
        loseContext: () => (board as unknown as { _loseContext(): void })._loseContext(),
        // The parts tray (phase 3).
        ghostCount: () => (board as unknown as { _ghostCount(): number })._ghostCount(),
        components: () => [...(store.get().project?.design.components.keys() ?? [])],
        allHoles: () => store.get().project?.doc.pinHoles ?? {},
        boardSpec: () => store.get().project?.doc.board ?? null,
        holeScreen(h: Hole) {
          const q = store.get().project;
          if (!q) return null;
          const [x, y] = placeAt(q.doc.board, h);
          const a = board.project(x, 0, y);
          const r = canvasHost.getBoundingClientRect();
          return a.visible ? { x: r.left + a.x, y: r.top + a.y } : null;
        },
        failNextMove: _failNextMove,
        modelKeys: () => (models?.keys ?? []) as string[],
        // Test-only: the next open loads without these (the cache is cleared so it does).
        dropModels(keys: ModelKey[]) {
          dropHook = keys;
          getModels.clear();
        },
        // The wire tool.
        pinNet: (ref: string, pin: string) => store.get().project?.design.components.get(ref)?.pins.get(pin)?.net ?? null,
        jumper(a: Hole, b: Hole) {
          const q = store.get().project;
          return q ? jumperOutcome(q.doc, q.design, a, b) : null;
        },
        doc: () => store.get().project?.doc ?? null,
      };
    }
    return ws;
  } catch (e) {
    release();
    throw e;
  }
}

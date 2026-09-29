// Opening and closing the 3D board.
//
// three is loaded on demand, so a user who never opens this never downloads
// it and the first paint of the flat board stays as quick as it was.
//
// The 3D board is a second view of the same state, not a picture of it:
// flicking a switch there goes through the same store and the same solver the
// flat board uses, so the two can never disagree about what is closed.

import type { LayoutDoc } from '../src/pipeline.ts';
import { analog } from './analog.ts';
import type { Board3D } from './board3d.ts';
import { simState } from './simstate.ts';
import { store } from './state.ts';
import { currentHighlight } from './board.ts';
import { flowOrder } from './floworder.ts';
import { esc } from './main.ts';

let view: Board3D | null = null;
let host: HTMLElement | null = null;
let unsub: (() => void) | null = null;
let unsubStore: (() => void) | null = null;

/**
 * Open, and still on the page. A route re-render replaces the whole board
 * card, taking the canvas with it while this module is left holding a live
 * renderer, so a mounted view whose host has been detached does not count.
 */
export const is3dOpen = () => !!view && !!host?.isConnected;

let stepText: HTMLElement | null = null;
let netOut: HTMLElement | null = null;
let onPop: (() => void) | null = null;
/** The wire style the mounted scene was built with; a change means a rebuild. */
let mountedStyle: 'arc' | 'orthogonal' = 'arc';
let legend: HTMLElement | null = null;

/** Push the board's switch positions, LED state, and the followed step or net into 3D. */
function pushBoard() {
  const p = store.get().project;
  if (!p || !view) return;
  // The square and curved jumpers are different geometry, so a change of
  // style rebuilds the scene where it stands.
  if (p.sidecar.options.wireStyle !== mountedStyle && host?.parentElement) {
    const card = host.parentElement;
    close3d(false);
    void open3d(card, p.doc);
    return;
  }
  if (legend) for (const chip of legend.querySelectorAll<HTMLElement>('[data-legend]')) chip.classList.toggle('is-on', p.highlight?.net === chip.dataset.legend);
  const s = simState(p.doc.sim.model, p.switches);
  view.setBoard(p.switches, s.leds, s.segments);
  view.setHighlight(currentHighlight(p));
  if (stepText) {
    const n = p.doc.steps.length;
    const step = p.activeStep !== null ? p.doc.steps.find((x) => x.n === p.activeStep) : undefined;
    stepText.textContent = step ? `Step ${step.n}/${n}: ${step.label}` : `Walk-through: ▶ for step 1 of ${n}`;
    stepText.title = step?.label ?? '';
  }
  if (netOut && p.highlight?.net) netOut.textContent = `following ${p.highlight.net.split('/').filter(Boolean).pop() ?? p.highlight.net} · click empty board to release`;
}

/** Move the walk-through one step, staying inside the guide; before step 1 is "no step". */
function stepBy(dir: -1 | 1) {
  const p = store.get().project;
  if (!p) return;
  const n = p.doc.steps.length;
  const next = Math.min(n, Math.max(0, (p.activeStep ?? 0) + dir));
  store.setProject({ activeStep: next === 0 ? null : next, highlight: null });
}

export async function open3d(card: HTMLElement, doc: LayoutDoc) {
  if (is3dOpen()) return;
  // Release a renderer left behind by a card that has since been replaced.
  if (view) close3d();
  host = document.createElement('div');
  host.className = 'view3d';
  host.innerHTML =
    '<div class="view3d-bar">' +
    '<button type="button" class="view3d-mode">Fly through</button>' +
    '<button type="button" class="view3d-mode view3d-step" data-dir="-1" title="previous build step">◀</button>' +
    '<span class="view3d-steptext"></span>' +
    '<button type="button" class="view3d-mode view3d-step" data-dir="1" title="next build step">▶</button>' +
    '<span class="view3d-hint"></span>' +
    '<span class="view3d-net"></span>' +
    '</div><div class="view3d-canvas"></div>' +
    `<div class="view3d-legend">${flowOrder(doc).map((net) => `<span data-legend="${esc(net)}" title="click to follow this net; the rest fades"><i style="background:${esc(doc.nets[net].color)}"></i><span>${esc(doc.nets[net].name)}</span></span>`).join('')}</div>`;
  card.appendChild(host);
  // Opening 3D is a place the browser's Back button can leave: one history
  // entry on the same URL, so Back closes the 3D view instead of leaving the
  // project. The router only listens for hash changes, so this entry is
  // invisible to it.
  history.pushState({ ...(history.state ?? {}), view3d: true }, '');
  onPop = () => {
    if (!is3dOpen()) return;
    close3d(false);
    // Repaint the toolbar so its button reads 3D again.
    store.setProject({});
  };
  addEventListener('popstate', onPop);
  const canvasHost = host.querySelector<HTMLElement>('.view3d-canvas')!;
  const modeBtn = host.querySelector<HTMLButtonElement>('.view3d-mode')!;
  const hint = host.querySelector<HTMLElement>('.view3d-hint')!;
  netOut = host.querySelector<HTMLElement>('.view3d-net')!;
  stepText = host.querySelector<HTMLElement>('.view3d-steptext')!;
  for (const b of host.querySelectorAll<HTMLButtonElement>('.view3d-step')) b.addEventListener('click', () => stepBy(Number(b.dataset.dir) as -1 | 1));
  // The legend under the 3D board: click a net to follow it with the rest
  // faded, click it again to release; hover lights it for a look.
  legend = host.querySelector<HTMLElement>('.view3d-legend')!;
  legend.addEventListener('click', (e) => {
    const net = (e.target as HTMLElement).closest<HTMLElement>('[data-legend]')?.dataset.legend;
    const p = store.get().project;
    if (!net || !p) return;
    store.setProject({ highlight: p.highlight?.net === net ? null : { net, soft: true }, activeStep: null });
  });
  legend.addEventListener('mouseover', (e) => {
    const net = (e.target as HTMLElement).closest<HTMLElement>('[data-legend]')?.dataset.legend;
    if (net) view?.setHover(net);
  });
  legend.addEventListener('mouseleave', () => view?.setHover(null));

  // Two ways to move mean two sets of keys, and a hint bar showing the ones
  // that do nothing right now is worse than no hint bar.
  const ORBIT = 'drag to orbit · right-drag to pan · scroll to zoom · click a wire to follow its net (others hide) · click a switch to flick it · ◀ ▶ walk the build';
  const FLY = 'WASD to move · mouse to look · space and C for up and down · shift to sprint · F or Esc to orbit again';
  let flying = false;
  const showMode = () => {
    hint.textContent = flying ? FLY : ORBIT;
    modeBtn.textContent = flying ? 'Back to orbit' : 'Fly through';
    modeBtn.classList.toggle('is-on', flying);
  };
  showMode();
  modeBtn.addEventListener('click', () => view?.setFly(!flying));

  const { mount3d } = await import('./board3d.ts');
  // The user may have closed it again while three was still downloading.
  if (!host.isConnected) return;
  mountedStyle = store.get().project?.sidecar.options.wireStyle ?? 'arc';
  view = mount3d(canvasHost, doc, {
    wireStyle: mountedStyle,
    onToggle(key) {
      const p = store.get().project;
      if (!p) return;
      const switches = { ...p.switches, [key]: !p.switches[key] };
      store.setProject({ switches });
      // The flat board repaints from the store; the solver has to be told, or
      // a running simulation would carry on with the old switch positions.
      analog.refresh({ ...p, switches });
    },
    onNet(net) {
      // The layout's net names are paths; the last segment is the name anyone
      // would recognise from the schematic. A followed net keeps its notice.
      const p = store.get().project;
      if (p?.highlight?.net) return;
      if (netOut) netOut.textContent = net ? net.split('/').filter(Boolean).pop() ?? net : '';
    },
    onSelectNet(net) {
      // Follow the clicked net; a click on nothing releases a followed net
      // but leaves an active build step alone.
      const p = store.get().project;
      if (!p) return;
      if (net) store.setProject({ highlight: { net }, activeStep: null });
      else if (p.highlight) {
        store.setProject({ highlight: null });
        if (netOut) netOut.textContent = '';
      }
    },
    onMode(mode) {
      flying = mode === 'fly';
      showMode();
    },
  });
  const p = store.get().project;
  view.setState(p ? analog.refresh(p) : analog.latest());
  pushBoard();
  unsub = analog.subscribe((s) => view?.setState(s));
  unsubStore = store.subscribe(pushBoard);
}

/** Close the 3D view; `viaHistory` also drops the history entry opening it pushed, so Back does not return to a view that is no longer there. */
export function close3d(viaHistory = true) {
  if (onPop) {
    removeEventListener('popstate', onPop);
    onPop = null;
  }
  if (viaHistory && (history.state as { view3d?: boolean } | null)?.view3d) history.back();
  unsub?.();
  unsub = null;
  unsubStore?.();
  unsubStore = null;
  view?.dispose();
  view = null;
  host?.remove();
  host = null;
  stepText = null;
  netOut = null;
  legend = null;
}

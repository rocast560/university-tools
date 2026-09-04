// The board: render the SVG from state, pan and zoom with the pointer, hover
// to highlight a net, click switches, drag parts with live re-layout.

import { buildLayoutDoc } from '../src/pipeline.ts';
import { renderSvg, svgSize, type Highlight } from '../src/render/index.ts';
import { DARK, LIGHT } from '../src/render/theme.ts';
import { api } from './api.ts';
import { shiftHoles } from './drag.ts';
import { toast } from './main.ts';
import { simState } from './simstate.ts';
import { store, type AppState } from './state.ts';

export function mountBoard(container: HTMLElement): () => void {
  let view = { x: -100, y: 0, w: 0, h: 350 };
  let lastKey = '';
  let drag: { ref: string; columnsOnly: boolean; startX: number; startY: number; origin: Record<string, { col: number; row: never }>; preview: string | null; valid: boolean } | null = null;
  let panning: { x: number; y: number; vx: number; vy: number } | null = null;

  const svgPoint = (e: PointerEvent) => {
    const svg = container.querySelector('svg')!;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  };

  const applyView = () => {
    const svg = container.querySelector('svg');
    if (svg) svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  };

  const render = (s: AppState) => {
    const p = s.project;
    if (!p) {
      container.replaceChildren();
      lastKey = '';
      return;
    }
    const doc = drag?.preview ? JSON.parse(drag.preview) : p.doc;
    const sim = simState(p.doc.sim.model, p.switches);
    const highlight: Highlight | null = p.highlight ?? (p.activeStep !== null ? stepHighlight(p, p.activeStep) : null);
    const key = JSON.stringify([p.id, s.theme, highlight, p.switches, doc === p.doc ? p.doc : drag?.preview]);
    if (key === lastKey) return;
    lastKey = key;
    const size = svgSize(doc.board);
    if (!view.w) view = { x: -100, y: 0, w: size.width, h: size.height };
    container.innerHTML = renderSvg(doc, { theme: s.theme === 'dark' ? DARK : LIGHT, highlight, sim });
    if (drag && !drag.valid) container.querySelector(`[data-ref="${drag.ref}"]`)?.classList.add('invalid');
    applyView();
  };

  const stepHighlight = (p: NonNullable<AppState['project']>, n: number): Highlight | null => {
    const step = p.doc.steps.find((x) => x.n === n);
    if (!step) return null;
    if (step.wire !== undefined) return { wire: step.wire };
    if (step.ref && step.ref !== 'PSU') return { ref: step.ref };
    return null;
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const svg = container.querySelector('svg');
    if (!svg) return;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM()!.inverse());
    const f = e.deltaY < 0 ? 0.85 : 1 / 0.85;
    view = { x: pt.x - (pt.x - view.x) * f, y: pt.y - (pt.y - view.y) * f, w: view.w * f, h: view.h * f };
    applyView();
  };

  const onPointerDown = (e: PointerEvent) => {
    const p = store.get().project;
    if (!p || e.button !== 0) return;
    const target = e.target as Element;
    const sw = target.closest<Element>('[data-switch]');
    if (sw) {
      const k = sw.getAttribute('data-switch')!;
      store.setProject({ switches: { ...p.switches, [k]: !p.switches[k] } });
      return;
    }
    const part = target.closest<Element>('.part[data-ref], .pkg[data-ref]');
    if (part) {
      const ref = part.getAttribute('data-ref')!;
      if (!p.doc.pinHoles[ref]) return;
      const { x, y } = svgPoint(e);
      drag = { ref, columnsOnly: part.classList.contains('pkg'), startX: x, startY: y, origin: p.doc.pinHoles[ref] as never, preview: null, valid: true };
      container.querySelector('svg')!.classList.add('dragging');
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }
    panning = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    const p = store.get().project;
    if (!p) return;
    if (panning) {
      const svg = container.querySelector('svg')!;
      const scale = view.w / svg.getBoundingClientRect().width;
      view = { ...view, x: panning.vx - (e.clientX - panning.x) * scale, y: panning.vy - (e.clientY - panning.y) * scale };
      applyView();
      return;
    }
    if (drag) {
      const { x, y } = svgPoint(e);
      const holes = shiftHoles(drag.origin, x - drag.startX, y - drag.startY, p.doc.board, drag.columnsOnly);
      if (!holes) {
        drag.valid = false;
        return;
      }
      const sidecar = { ...p.sidecar, pinned: { ...p.sidecar.pinned, [drag.ref]: holes } };
      const doc = buildLayoutDoc(p.design, sidecar);
      drag.valid = !doc.warnings.some((w) => w.startsWith(`pinned placement for ${drag!.ref} dropped`));
      drag.preview = JSON.stringify(doc);
      render(store.get());
      return;
    }
    const net = (e.target as Element).closest<Element>('[data-net]')?.getAttribute('data-net')?.split(' ')[0] ?? null;
    const current = p.highlight?.net ?? null;
    if (net !== current && p.activeStep === null) store.setProject({ highlight: net ? { net } : null });
  };

  const onPointerUp = async (e: PointerEvent) => {
    if (panning) {
      panning = null;
      return;
    }
    if (!drag) return;
    const p = store.get().project!;
    const d = drag;
    drag = null;
    container.querySelector('svg')?.classList.remove('dragging');
    const { x, y } = svgPoint(e);
    const holes = shiftHoles(d.origin, x - d.startX, y - d.startY, p.doc.board, d.columnsOnly);
    lastKey = '';
    if (!holes || !d.valid || JSON.stringify(holes) === JSON.stringify(d.origin)) {
      render(store.get());
      return;
    }
    try {
      const doc = await api.move(p.id, d.ref, holes);
      const sidecar = { ...p.sidecar, pinned: { ...p.sidecar.pinned, [d.ref]: holes } };
      store.setProject({ doc, sidecar });
    } catch (err) {
      toast((err as Error).message);
      render(store.get());
    }
  };

  container.addEventListener('wheel', onWheel, { passive: false });
  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', onPointerUp);
  container.addEventListener('pointerleave', () => {
    const p = store.get().project;
    if (p && p.highlight && p.activeStep === null && !drag) store.setProject({ highlight: null });
  });
  const unsub = store.subscribe(render);
  render(store.get());
  return () => {
    unsub();
    container.replaceChildren();
  };
}

export function fitView(container: HTMLElement) {
  const svg = container.querySelector('svg');
  const p = store.get().project;
  if (!svg || !p) return;
  const size = svgSize(p.doc.board);
  svg.setAttribute('viewBox', size.viewBox);
}

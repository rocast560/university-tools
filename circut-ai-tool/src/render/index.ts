// One SVG generator for the browser and the server. Pure string building:
// no DOM, no dependencies. Elements carry data-ref / data-net / data-wire so
// the client can attach hover, drag and click handlers.

import { isRail } from '../layout/board.ts';
import type { EngineResult } from '../layout/engine.ts';
import type { BoardSpec, Hole, Package, PlacedPart, Row, Wire } from '../layout/types.ts';
import { displayName } from '../netlist.ts';
import { LIGHT, type Theme } from './theme.ts';

export const P = 18;
export const X0 = 40;
export const ROWY: Record<Row, number> = { 'T+': 30, 'T-': 48, a: 84, b: 102, c: 120, d: 138, e: 156, f: 192, g: 210, h: 228, i: 246, j: 264, 'B-': 300, 'B+': 318 };
const HEIGHT = 350;

export interface SimState {
  leds: Record<string, boolean>;
  segments: Record<string, Record<string, boolean>>;
  switches: Record<string, boolean>;
}

export interface Highlight {
  net?: string;
  ref?: string;
  wire?: number;
}

export interface RenderOptions {
  theme?: Theme;
  highlight?: Highlight | null;
  sim?: SimState | null;
}

export function pt(h: Hole): [number, number] {
  return [X0 + (h.col - 1) * P, ROWY[h.row]];
}

export function svgSize(board: BoardSpec): { width: number; height: number; viewBox: string } {
  const xr = X0 + (board.cols - 1) * P;
  const width = xr + 140;
  return { width, height: HEIGHT, viewBox: `-100 0 ${width} ${HEIGHT}` };
}

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

function el(tag: string, attrs: Record<string, string | number | undefined>, inner = ''): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}="${typeof v === 'number' ? n(v) : esc(v as string)}"`)
    .join(' ');
  return inner ? `<${tag} ${a}>${inner}</${tag}>` : `<${tag} ${a}/>`;
}

function text(x: number, y: number, s: string, extra: Record<string, string | number> = {}): string {
  return el('text', { x, y, 'font-family': 'ui-monospace, Consolas, monospace', 'font-size': 9, 'text-anchor': 'middle', ...extra }, esc(s));
}

// ---------- board ----------

function drawBoard(res: EngineResult, t: Theme): string {
  const b = res.board;
  const xr = X0 + (b.cols - 1) * P;
  const out: string[] = [];
  out.push(el('rect', { x: 8, y: 8, width: xr + 16, height: 334, rx: 6, fill: t.board, stroke: t.boardStroke }));
  out.push(el('rect', { x: 26, y: 168, width: xr - 10, height: 12, rx: 2, fill: t.gutter }));
  const gapL = b.splitCol ? pt({ col: b.splitCol, row: 'a' })[0] + 7 : null;
  const gapR = b.splitCol ? pt({ col: b.splitCol + 1, row: 'a' })[0] - 7 : null;
  const railNet: Record<string, string> = { 'T+': res.power.plus.length ? displayName(res.power.plusName) : '+', 'T-': displayName(res.power.gndName), 'B-': displayName(res.power.gndName), 'B+': displayName(res.power.secondName ?? res.power.plusName) };
  for (const [row, color] of [['T+', t.railPlus], ['T-', t.railMinus], ['B-', t.railMinus], ['B+', t.railPlus]] as [Row, string][]) {
    const y = ROWY[row];
    if (gapL !== null && gapR !== null) {
      out.push(el('line', { x1: 34, y1: y, x2: gapL, y2: y, stroke: color, 'stroke-width': 1.2, opacity: 0.55 }));
      out.push(el('line', { x1: gapR, y1: y, x2: xr + 10, y2: y, stroke: color, 'stroke-width': 1.2, opacity: 0.55 }));
    } else out.push(el('line', { x1: 34, y1: y, x2: xr + 10, y2: y, stroke: color, 'stroke-width': 1.2, opacity: 0.55 }));
    out.push(text(xr + 18, y + 3.5, row[1], { 'font-size': 12, fill: color, 'font-weight': 600 }));
    out.push(text(-40, y + 3.5, railNet[row], { 'font-size': 9, fill: color, 'font-weight': 600, 'text-anchor': 'end' }));
    for (let c = 1; c <= b.cols; c++) if (c % b.railGapEvery !== 0) out.push(el('circle', { cx: pt({ col: c, row })[0], cy: y, r: 2.4, fill: t.hole, class: 'hole', 'data-hole': `${row}${c}` }));
  }
  if (gapL !== null && gapR !== null) {
    const sx = (gapL + gapR) / 2;
    out.push(el('line', { x1: sx, y1: 22, x2: sx, y2: 56, stroke: t.textMuted, 'stroke-dasharray': '2 2' }));
    out.push(el('line', { x1: sx, y1: 292, x2: sx, y2: 326, stroke: t.textMuted, 'stroke-dasharray': '2 2' }));
    out.push(text(sx, 6, 'rail split', { 'font-size': 6.5, fill: t.textMuted }));
  }
  for (const row of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] as Row[]) {
    out.push(text(22, ROWY[row] + 3.5, row, { 'font-size': 10, fill: t.textMuted }));
    out.push(text(xr + 18, ROWY[row] + 3.5, row, { 'font-size': 10, fill: t.textMuted }));
    for (let c = 1; c <= b.cols; c++) out.push(el('circle', { cx: pt({ col: c, row })[0], cy: ROWY[row], r: 2.4, fill: t.hole, class: 'hole', 'data-hole': `${row}${c}` }));
  }
  for (let c = 1; c <= b.cols; c++) {
    if (c !== 1 && c % 5 !== 0) continue;
    out.push(text(pt({ col: c, row: 'a' })[0], 70, String(c), { 'font-size': 8.5, fill: t.textMuted }));
    out.push(text(pt({ col: c, row: 'a' })[0], 285, String(c), { 'font-size': 8.5, fill: t.textMuted }));
  }
  return out.join('');
}

// ---------- supply ----------

function drawSupply(res: EngineResult, t: Theme, dim: (nets: string[], refs: string[]) => number | undefined): string {
  if (!res.supply) return '';
  return res.supply.leads
    .map((lead, i) => {
      const [x, y] = pt(lead.hole);
      const color = res.nets[lead.net]?.color ?? t.text;
      const x0 = -70;
      const y0 = y + (i - 1) * 4;
      return el('g', { class: 'supply', 'data-net': lead.net, opacity: dim([lead.net], []) }, el('path', { d: `M ${n(x0)} ${n(y0)} C ${n(x0 + 40)} ${n(y0)} ${n(x - 30)} ${n(y)} ${n(x)} ${n(y)}`, fill: 'none', stroke: color, 'stroke-width': 2.6 }) + el('circle', { cx: x, cy: y, r: 3.2, fill: color, stroke: t.chip, 'stroke-width': 0.8 }) + text(x0 - 4, y0 + 3, displayName(lead.net), { 'text-anchor': 'end', fill: color, 'font-weight': 600 }));
    })
    .join('');
}

// ---------- packages ----------

const SEG_SHAPES: Record<string, [number, number, number, number]> = { a: [-7, -14, 14, 3], b: [7, -12, 3, 11], c: [7, 1, 3, 11], d: [-7, 11, 14, 3], e: [-10, 1, 3, 11], f: [-10, -12, 3, 11], g: [-7, -1.5, 14, 3] };

function drawPackage(pkg: Package, res: EngineResult, t: Theme, sim: SimState | null, dim: (nets: string[], refs: string[]) => number | undefined): string {
  const width = pkg.kind === 'dipswitch' ? (pkg.positions ?? 1) : pkg.pins / 2;
  const x1 = pt({ col: pkg.col0, row: 'e' })[0] - P / 2 + 2;
  const x2 = pt({ col: pkg.col0 + width - 1, row: 'e' })[0] + P / 2 - 2;
  const y1 = ROWY.e - 7;
  const y2 = ROWY.f + 7;
  const ym = (y1 + y2) / 2;
  const parts: string[] = [];
  if (pkg.kind === 'dipswitch') {
    parts.push(el('rect', { x: x1, y: y1, width: x2 - x1, height: y2 - y1, rx: 3, fill: '#B4232C', stroke: '#6E1219' }));
    for (let i = 0; i < width; i++) {
      const cx = pt({ col: pkg.col0 + i, row: 'e' })[0];
      const on = !!sim?.switches[pkg.map?.[String(i + 1)] ?? pkg.id] || !!sim?.switches[`${pkg.id}:${i + 1}`];
      parts.push(el('rect', { x: cx - 4, y: y1 + 8, width: 8, height: y2 - y1 - 16, rx: 2, fill: '#F2E9D8', stroke: '#6E1219' }));
      parts.push(el('rect', { x: cx - 3, y: on ? y1 + 9 : ym + 1, width: 6, height: (y2 - y1) / 2 - 10, rx: 1.5, fill: '#3A3D44', class: 'slider', 'data-switch': pkg.map?.[String(i + 1)] ?? `${pkg.id}:${i + 1}`, 'data-on': on ? 'on' : 'off' }));
      parts.push(text(cx, y2 - 2, String(i + 1), { 'font-size': 6, fill: '#F2E9D8' }));
    }
    parts.push(text((x1 + x2) / 2, y1 - 4, pkg.name, { fill: t.text, 'font-size': 8 }));
  } else if (pkg.kind === 'sevenseg') {
    parts.push(el('rect', { x: x1, y: y1 - 6, width: x2 - x1, height: y2 - y1 + 12, rx: 3, fill: '#1B1C20', stroke: '#000' }));
    const cx = (x1 + x2) / 2;
    const state = sim?.segments[pkg.id] ?? {};
    for (const [seg, [dx, dy, w, h]] of Object.entries(SEG_SHAPES)) parts.push(el('rect', { x: cx + dx, y: ym + dy, width: w, height: h, rx: 1, fill: state[seg] ? t.segOn : t.segOff, 'data-seg': seg, 'data-lit': state[seg] ? 'on' : 'off' }));
    parts.push(el('circle', { cx: x2 - 5, cy: y2 + 1, r: 1.5, fill: t.segOff }));
    parts.push(text(cx, y1 - 10, `${pkg.id} ${pkg.name}`, { fill: t.text, 'font-size': 8 }));
  } else {
    parts.push(el('rect', { x: x1, y: y1, width: x2 - x1, height: y2 - y1, rx: 3, fill: t.chip, stroke: '#000' }));
    parts.push(el('circle', { cx: x1, cy: ym, r: 5, fill: t.notch }));
    parts.push(el('circle', { cx: x1 + 8, cy: y2 - 8, r: 1.8, fill: t.chipText }));
    parts.push(text((x1 + x2) / 2, ym + 3, pkg.name, { fill: t.chipText, 'font-size': 9, 'font-weight': 600 }));
    parts.push(text((x1 + x2) / 2, y1 - 4, pkg.id, { fill: t.text, 'font-size': 8 }));
  }
  return el('g', { class: 'pkg', 'data-ref': pkg.id, opacity: dim([], [pkg.id]) }, parts.join(''));
}

// ---------- parts ----------

function body2(part: PlacedPart, t: Theme, sim: SimState | null): string {
  // Drawn horizontally, centred at the origin; the caller rotates it along the leg axis.
  const value = part.value;
  switch (part.style) {
    case 'R':
      return el('rect', { x: -11, y: -4.5, width: 22, height: 9, rx: 2, fill: t.body, stroke: t.bodyStroke }) + el('rect', { x: -6, y: -4.5, width: 2, height: 9, fill: '#B4232C' }) + el('rect', { x: -1, y: -4.5, width: 2, height: 9, fill: '#3A3D44' }) + el('rect', { x: 4, y: -4.5, width: 2, height: 9, fill: '#E3B505' });
    case 'C':
      return el('rect', { x: -3.5, y: -6, width: 2.2, height: 12, fill: '#2F6FBF' }) + el('rect', { x: 1.3, y: -6, width: 2.2, height: 12, fill: '#2F6FBF' });
    case 'Cpol':
      return el('rect', { x: -9, y: -6, width: 18, height: 12, rx: 3, fill: '#2F3E5C', stroke: '#101827' }) + el('rect', { x: 3, y: -6, width: 4, height: 12, fill: '#E7E5DF' }) + text(-4, 2.5, '+', { fill: '#FFFFFF', 'font-size': 8, 'font-weight': 700 });
    case 'L':
      return el('rect', { x: -11, y: -4.5, width: 22, height: 9, rx: 4.5, fill: '#4A6B3A', stroke: '#22361A' }) + el('path', { d: 'M -8 0 a 2.7 2.7 0 0 1 5.4 0 a 2.7 2.7 0 0 1 5.4 0 a 2.7 2.7 0 0 1 5.4 0', fill: 'none', stroke: '#C9D9B8', 'stroke-width': 1.2 });
    case 'D':
    case 'Z':
      return el('rect', { x: -9, y: -4, width: 18, height: 8, rx: 2, fill: '#1B1C20', stroke: '#000' }) + el('rect', { x: -8, y: -4, width: 2.5, height: 8, fill: '#D0D3D8' }) + (part.style === 'Z' ? text(0, 2.5, 'Z', { fill: '#FFFFFF', 'font-size': 6 }) : '');
    case 'LED': {
      const on = !!sim?.leds[part.id];
      return el('circle', { cx: 0, cy: 0, r: 6.5, fill: on ? t.ledOn : t.ledOff, stroke: '#7A1F1F', 'data-led': on ? 'on' : 'off' }) + el('line', { x1: -6.5, y1: -4, x2: -6.5, y2: 4, stroke: '#1E1E1E', 'stroke-width': 1.6 });
    }
    case 'SW': {
      const on = !!sim?.switches[part.id];
      return el('rect', { x: -10, y: -5, width: 20, height: 10, rx: 2, fill: '#3A3D44', stroke: '#000' }) + el('line', { x1: -6, y1: 0, x2: on ? 6 : 4, y2: on ? 0 : -6, stroke: '#E7E5DF', 'stroke-width': 1.8, 'data-switch': part.id, 'data-on': on ? 'on' : 'off' });
    }
    case 'BTN': {
      const on = !!sim?.switches[part.id];
      return el('rect', { x: -7, y: -7, width: 14, height: 14, rx: 2, fill: '#3A3D44', stroke: '#000' }) + el('circle', { cx: 0, cy: 0, r: 3.5, fill: on ? '#E3B505' : '#8A8F98', 'data-switch': part.id, 'data-on': on ? 'on' : 'off' });
    }
    default:
      return el('rect', { x: -10, y: -4.5, width: 20, height: 9, rx: 2, fill: '#8A8F98', stroke: '#3A3D44' }) + text(0, 2.5, value.slice(0, 4), { fill: '#FFFFFF', 'font-size': 6 });
  }
}

function drawPart(part: PlacedPart, res: EngineResult, t: Theme, sim: SimState | null, dim: (nets: string[], refs: string[]) => number | undefined): string {
  const pts = part.holes.map(pt);
  const inner: string[] = [];
  if (part.kind === 'lead2') {
    const [[ax, ay], [bx, by]] = pts;
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const deg = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
    inner.push(el('line', { x1: ax, y1: ay, x2: bx, y2: by, stroke: t.lead, 'stroke-width': 1.8 }));
    inner.push(el('g', { transform: `translate(${n(mx)} ${n(my)}) rotate(${n(deg)})` }, body2(part, t, sim)));
    for (const [x, y] of pts) inner.push(el('circle', { cx: x, cy: y, r: 2.2, fill: t.lead }));
    const perp = Math.abs(deg) < 45 || Math.abs(deg) > 135 ? [0, -10] : [12, 3];
    inner.push(text(mx + perp[0], my + perp[1], part.style === 'LED' ? part.id : `${part.id} ${part.value}`, { fill: t.text, 'font-size': 7.5, 'text-anchor': perp[0] ? 'start' : 'middle' }));
  } else {
    const [[x0, y0], [x1], [x2]] = pts;
    const cx = x1;
    const up = part.holes[0].row <= 'e';
    const dir = up ? -1 : 1;
    for (const [x, y] of pts) inner.push(el('line', { x1: x, y1: y, x2: x, y2: y + dir * 12, stroke: t.lead, 'stroke-width': 1.8 }));
    if (part.kind === 'to92') {
      const yb = y0 + dir * 12;
      inner.push(el('path', { d: `M ${n(x0 - 6)} ${n(yb)} L ${n(x2 + 6)} ${n(yb)} A ${n((x2 - x0) / 2 + 6)} ${n((x2 - x0) / 2 + 6)} 0 0 ${up ? 0 : 1} ${n(x0 - 6)} ${n(yb)} Z`, fill: '#1B1C20', stroke: '#000' }));
      inner.push(text(cx, yb + dir * 14 + 3, part.value, { fill: '#FFFFFF', 'font-size': 7 }));
    } else {
      const yb = up ? y0 - 12 - 24 : y0 + 12;
      inner.push(el('rect', { x: x0 - 8, y: yb, width: x2 - x0 + 16, height: 24, rx: 3, fill: '#2F6FBF', stroke: '#1B3F73' }));
      inner.push(el('circle', { cx, cy: yb + 12, r: 7, fill: '#E7E5DF', stroke: '#1B3F73' }));
      inner.push(el('line', { x1: cx, y1: yb + 12, x2: cx + 5, y2: yb + 7, stroke: '#1B3F73', 'stroke-width': 1.5 }));
      inner.push(text(cx, up ? yb - 4 : yb + 34, `${part.id} ${part.value}`, { fill: t.text, 'font-size': 7.5 }));
    }
    part.labels.forEach((l, i) => inner.push(text(pts[i][0], pts[i][1] + dir * -4 + (up ? 0 : 0) + (up ? 12 : -6), l, { fill: t.textMuted, 'font-size': 6 })));
    for (const [x, y] of pts) inner.push(el('circle', { cx: x, cy: y, r: 2.2, fill: t.lead }));
  }
  return el('g', { class: 'part', 'data-ref': part.id, 'data-net': part.nets.join(' '), opacity: dim(part.nets, [part.id]) }, inner.join(''));
}

// ---------- wires ----------

function drawWire(w: Wire, i: number, color: string, t: Theme, opacity: number | undefined): string {
  const [ax, ay] = pt(w.a);
  const [bx, by] = pt(w.b);
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const bulge = Math.min(0.28 * len, 26) * (w.role === 'power' || w.role === 'bridge' ? 0.6 : 1);
  const cx = (ax + bx) / 2 + (-dy / len) * bulge;
  const cy = (ay + by) / 2 + (dx / len) * bulge;
  const rail = isRail(w.a.row) || isRail(w.b.row);
  return el('g', { class: 'wire', 'data-net': w.net, 'data-wire': i, opacity }, el('path', { d: `M ${n(ax)} ${n(ay)} Q ${n(cx)} ${n(cy)} ${n(bx)} ${n(by)}`, fill: 'none', stroke: color, 'stroke-width': rail ? 2.2 : 2.6, 'stroke-linecap': 'round' }) + el('circle', { cx: ax, cy: ay, r: 3.2, fill: color, stroke: t.chip, 'stroke-width': 0.8 }) + el('circle', { cx: bx, cy: by, r: 3.2, fill: color, stroke: t.chip, 'stroke-width': 0.8 }));
}

// ---------- entry ----------

export function renderSvg(res: EngineResult, opts: RenderOptions = {}): string {
  const t = opts.theme ?? LIGHT;
  const hl = opts.highlight ?? null;
  const sim = opts.sim ?? null;
  const dim = (nets: string[], refs: string[], wire?: number): number | undefined => {
    if (!hl) return undefined;
    if (hl.net !== undefined) return nets.includes(hl.net) ? undefined : t.dim;
    if (hl.ref !== undefined) return refs.includes(hl.ref) ? undefined : t.dim;
    if (hl.wire !== undefined) return wire === hl.wire ? undefined : t.dim;
    return undefined;
  };
  const dimPart = (nets: string[], refs: string[]) => (hl?.wire !== undefined ? t.dim : dim(nets, refs));
  const size = svgSize(res.board);
  const layers = [
    drawBoard(res, t),
    el('g', { class: 'packages' }, res.packages.map((p) => drawPackage(p, res, t, sim, hl?.wire !== undefined || hl?.net !== undefined ? () => undefined : dim)).join('')),
    el('g', { class: 'parts' }, res.parts.map((p) => drawPart(p, res, t, sim, dimPart)).join('')),
    el('g', { class: 'wires' }, res.wires.map((w, i) => drawWire(w, i, res.nets[w.net]?.color ?? t.text, t, dim([w.net], [], i))).join('')),
    drawSupply(res, t, hl?.wire !== undefined ? () => undefined : dim),
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${size.viewBox}" width="${size.width}" height="${size.height}" font-family="ui-monospace, Consolas, monospace">${layers.join('')}</svg>`;
}

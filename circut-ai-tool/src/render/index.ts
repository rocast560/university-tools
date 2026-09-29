// One SVG generator for the browser and the server. Pure string building:
// no DOM, no dependencies. Elements carry data-ref / data-net / data-wire so
// the client can attach hover, drag and click handlers.

import { isRail } from '../layout/board.ts';
import { moduleRect, P, pt, ROWY, svgSize, X0 } from './geometry.ts';
import { wireControls, type Control } from './routing.ts';
import { routeWires, type Point as OrthoPoint, type WireRoute } from './route3d.ts';
import type { EngineResult } from '../layout/engine.ts';
import type { BoardSpec, Hole, Package, PlacedPart, Row, Wire } from '../layout/types.ts';
import { displayName } from '../netlist.ts';
import type { LedColour } from '../parts/led.ts';
import { colourBands } from '../parts/resistor.ts';
import { L3_BOARD, L3_SILK } from '../parts/lab3.ts';
import { FLAT, type BoardGeom, type Skin, type SkinContext, type SkinLedState } from './skin.ts';
import { LIGHT, type Theme } from './theme.ts';

export { HEIGHT, moduleRect, overhang, P, pt, ROWY, svgSize, X0 } from './geometry.ts';

export interface SimState {
  leds: Record<string, boolean>;
  segments: Record<string, Record<string, boolean>>;
  switches: Record<string, boolean>;
  /**
   * LED reference -> 0..1 from the analog solver. Optional: without it an LED
   * is simply on or off, which is what the boolean simulator and every
   * existing caller supply.
   */
  ledBrightness?: Record<string, number>;
  /** LED reference -> how far past its rated current it is being driven. */
  ledOverdrive?: Record<string, number>;
}

export interface Highlight {
  net?: string;
  ref?: string;
  wire?: number;
  /** In 3D, fade everything else instead of hiding it (a net picked from the legend). */
  soft?: boolean;
}

export interface RenderOptions {
  theme?: Theme;
  highlight?: Highlight | null;
  sim?: SimState | null;
  /**
   * How to paint it. Omitted means FLAT, which is byte-identical to what this
   * renderer has always produced - the contract resvg, the MCP picture, the
   * downloads and the print sheet all depend on.
   */
  skin?: Skin;
  /**
   * Jumpers as bowed arcs (the default, and what the fixtures pin), or as
   * square-cornered runs along the corridors between rows that never share a
   * line with one another.
   */
  wireStyle?: 'arc' | 'orthogonal';
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

function drawBoard(res: EngineResult, t: Theme, sk: Skin): string {
  const b = res.board;
  const xr = X0 + (b.cols - 1) * P;
  const geom: BoardGeom = { x: 8, y: 8, width: xr + 16, height: 334, xr, board: b };
  const out: string[] = [];
  out.push(sk.boardSlab?.(geom, t) ?? el('rect', { x: 8, y: 8, width: xr + 16, height: 334, rx: 6, fill: t.board, stroke: t.boardStroke }));
  if (sk.boardOverlay) out.push(sk.boardOverlay(geom, t));
  out.push(sk.channel?.(geom, t) ?? el('rect', { x: 26, y: 168, width: xr - 10, height: 12, rx: 2, fill: t.gutter }));
  const bands = sk.holeBands?.(geom, t);
  if (bands) out.push(bands);
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
    if (!bands) for (let c = 1; c <= b.cols; c++) if (c % b.railGapEvery !== 0) out.push(el('circle', { cx: pt({ col: c, row })[0], cy: y, r: 2.4, fill: t.hole, class: 'hole', 'data-hole': `${row}${c}` }));
  }
  if (gapL !== null && gapR !== null) {
    const sx = (gapL + gapR) / 2;
    out.push(el('line', { x1: sx, y1: 22, x2: sx, y2: 56, stroke: t.textMuted, 'stroke-dasharray': '2 2' }));
    out.push(el('line', { x1: sx, y1: 292, x2: sx, y2: 326, stroke: t.textMuted, 'stroke-dasharray': '2 2' }));
    // Above the board rect, so it lands on the surround, not on the board.
    out.push(text(sx, 6, 'rail split', { 'font-size': 6.5, fill: t.margin }));
  }
  for (const row of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] as Row[]) {
    out.push(text(22, ROWY[row] + 3.5, row, { 'font-size': 10, fill: t.textMuted }));
    out.push(text(xr + 18, ROWY[row] + 3.5, row, { 'font-size': 10, fill: t.textMuted }));
    if (!bands) for (let c = 1; c <= b.cols; c++) out.push(el('circle', { cx: pt({ col: c, row })[0], cy: ROWY[row], r: 2.4, fill: t.hole, class: 'hole', 'data-hole': `${row}${c}` }));
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

/**
 * The key the simulator knows one DIP switch position by, and so the key a
 * click on its slider must send. A folded package maps each position to the
 * separate switch it stands for; a real DIP switch is one part, so its
 * positions are numbered within it. Collapsing the two cases would give all
 * seven sliders of one part the same key, and they would flip together.
 */
export function positionKey(pkg: Package, pos: number): string {
  const ref = pkg.map?.[String(pos)];
  return ref && ref !== pkg.id ? ref : `${pkg.id}:${pos}`;
}

function drawPackage(pkg: Package, res: EngineResult, t: Theme, sim: SimState | null, dim: (nets: string[], refs: string[]) => number | undefined): string {
  const width = pkg.kind === 'module' ? pkg.pins : pkg.kind === 'dipswitch' ? (pkg.positions ?? 1) : pkg.pins / 2;
  const x1 = pt({ col: pkg.col0, row: 'e' })[0] - P / 2 + 2;
  const x2 = pt({ col: pkg.col0 + width - 1, row: 'e' })[0] + P / 2 - 2;
  const y1 = ROWY.e - 7;
  const y2 = ROWY.f + 7;
  const ym = (y1 + y2) / 2;
  const parts: string[] = [];
  if (pkg.kind === 'module') {
    return el('g', { class: 'pkg', 'data-ref': pkg.id, opacity: dim([], [pkg.id]) }, drawModule(pkg));
  } else if (pkg.kind === 'dipswitch') {
    parts.push(el('rect', { x: x1, y: y1, width: x2 - x1, height: y2 - y1, rx: 3, fill: '#B4232C', stroke: '#6E1219' }));
    for (let i = 0; i < width; i++) {
      const cx = pt({ col: pkg.col0 + i, row: 'e' })[0];
      const key = positionKey(pkg, i + 1);
      const on = !!sim?.switches[key];
      // The whole way is the click target, well and number included. The
      // slider alone is about three pixels wide at the zoom a full board
      // opens at, which is not something you can reliably hit.
      // Wells nearly fill the pitch, the way they do on the real part, which
      // also leaves only a thin rib of red between one way and the next.
      const well = el('rect', { x: cx - 6, y: y1 + 8, width: 12, height: y2 - y1 - 16, rx: 2, fill: '#F2E9D8', stroke: '#6E1219' });
      const slider = el('rect', { x: cx - 4.5, y: on ? y1 + 9 : ym + 1, width: 9, height: (y2 - y1) / 2 - 10, rx: 1.5, fill: '#3A3D44', class: 'slider' });
      parts.push(el('g', { class: 'position', 'data-switch': key, 'data-on': on ? 'on' : 'off' }, well + slider + text(cx, y2 - 2, String(i + 1), { 'font-size': 6, fill: '#F2E9D8' })));
    }
    // A folded package stands in for several separate switches and has no
    // reference of its own; a real DIP switch is a part, so name it.
    const folded = Object.values(pkg.map ?? {}).some((ref) => ref !== pkg.id);
    parts.push(text((x1 + x2) / 2, y1 - 4, folded ? pkg.name : `${pkg.id} ${pkg.name}`, { fill: t.text, 'font-size': 8 }));
  } else if (pkg.kind === 'sevenseg') {
    // The body at its real height: 19 mm across the gutter, rows c to h, with
    // the pins showing at rows d and g and the digit centred on the gutter.
    const by1 = ROWY.c - 8;
    const by2 = ROWY.h + 8;
    parts.push(el('rect', { x: x1, y: by1, width: x2 - x1, height: by2 - by1, rx: 3, fill: '#1B1C20', stroke: '#000' }));
    for (const [num, h] of Object.entries(res.pinHoles[pkg.id] ?? {})) {
      const [hx, hy] = pt(h);
      parts.push(el('circle', { cx: hx, cy: hy, r: 2.2, fill: '#8a8f99', stroke: '#000', 'stroke-width': 0.5 }));
      parts.push(text(hx, hy + (hy < ym ? -5 : 10), num, { fill: '#c9ccd3', 'font-size': 5.5 }));
    }
    const cx = (x1 + x2) / 2;
    const state = sim?.segments[pkg.id] ?? {};
    for (const [seg, [dx, dy, w, h]] of Object.entries(SEG_SHAPES)) parts.push(el('rect', { x: cx + dx * 1.5, y: ym + dy * 1.6, width: w * 1.5, height: h * 1.6, rx: 1, fill: state[seg] ? t.segOn : t.segOff, 'data-seg': seg, 'data-lit': state[seg] ? 'on' : 'off' }));
    parts.push(el('circle', { cx: x2 - 7, cy: ym + 22, r: 1.8, fill: t.segOff }));
    parts.push(text(cx, by1 - 4, `${pkg.id} ${pkg.name}`, { fill: t.text, 'font-size': 8 }));
  } else {
    parts.push(el('rect', { x: x1, y: y1, width: x2 - x1, height: y2 - y1, rx: 3, fill: t.chip, stroke: '#000' }));
    // The notch and the pin 1 dimple mark the pin 1 end, which is the right
    // end once the chip has been turned round.
    const flip = !!pkg.flipped;
    parts.push(el('circle', { cx: flip ? x2 : x1, cy: ym, r: 5, fill: t.notch }));
    parts.push(el('circle', { cx: flip ? x2 - 8 : x1 + 8, cy: flip ? y1 + 8 : y2 - 8, r: 1.8, fill: t.chipText }));
    parts.push(text((x1 + x2) / 2, ym + 3, pkg.name, { fill: t.chipText, 'font-size': 9, 'font-weight': 600 }));
    parts.push(text((x1 + x2) / 2, y1 - 4, pkg.id, { fill: t.text, 'font-size': 8 }));
  }
  return el('g', { class: 'pkg', 'data-ref': pkg.id, opacity: dim([], [pkg.id]) }, parts.join(''));
}

/**
 * The L3 board at its real size: a blue PCB about 18 by 13 pitches with its
 * 15-position header half a pitch in from the long edge that sits on the
 * breadboard, silkscreen beside each position, and the wide DIP socket with
 * the potted chip filling the rest. It hangs outward from its header row.
 */
function drawModule(pkg: Package): string {
  const r = moduleRect(pkg);
  const row = pkg.row ?? 'a';
  const yh = ROWY[row];
  const out: string[] = [];
  out.push(el('rect', { x: r.x1, y: r.y1, width: r.x2 - r.x1, height: r.y2 - r.y1, rx: 6, fill: '#1f3a66', stroke: '#0f1f3a', 'stroke-width': 1.2 }));
  // Silkscreen: the separator line between Z and ~W, the labels, and the board name near the far edge.
  const xs = Array.from({ length: pkg.pins }, (_, i) => pt({ col: pkg.col0 + i, row })[0]);
  const yFar = yh + r.dir * L3_BOARD.depth * P;
  out.push(text((r.x1 + r.x2) / 2, yFar - r.dir * 5 + 3, `${pkg.id}  L3 AUXILIARY`, { fill: '#e8ecf4', 'font-size': 7, 'font-weight': 600 }));
  for (let i = 0; i < pkg.pins; i++) {
    const x = xs[i];
    out.push(el('circle', { cx: x, cy: yh, r: 4.2, fill: '#c7a544', stroke: '#7a6220', 'stroke-width': 0.6 }));
    out.push(el('circle', { cx: x, cy: yh, r: 1.6, fill: '#101f38' }));
    const label = L3_SILK[i];
    // Labels read along the board's short axis, the way they are printed.
    const ly = yh + r.dir * 8;
    if (label) out.push(el('text', { x, y: ly, transform: `rotate(${r.dir === -1 ? -90 : 90} ${n(x)} ${n(ly)})`, 'font-family': 'ui-monospace, Consolas, monospace', 'font-size': 6.5, 'font-weight': 700, fill: '#f4f6fa', 'text-anchor': 'start', 'dominant-baseline': 'middle' }, esc(label)));
    else out.push(el('line', { x1: x, y1: yh + r.dir * 6, x2: x, y2: yh + r.dir * 24, stroke: '#f4f6fa', 'stroke-width': 1.2 }));
  }
  // The wide DIP socket, its pin rows parallel to the header, and the chip in it.
  const sNear = yh + r.dir * L3_BOARD.socket.near * P;
  const sFar = yh + r.dir * L3_BOARD.socket.far * P;
  const sx1 = xs[0] - P / 2;
  const sx2 = xs[pkg.pins - 1] + P / 2;
  out.push(el('rect', { x: sx1, y: Math.min(sNear, sFar) - 5, width: sx2 - sx1, height: Math.abs(sFar - sNear) + 10, rx: 2, fill: '#3a3d44', stroke: '#1b1d22' }));
  for (let i = 0; i < L3_BOARD.socket.perSide; i++) {
    const x = xs[0] + ((xs[pkg.pins - 1] - xs[0]) * i) / (L3_BOARD.socket.perSide - 1);
    for (const y of [sNear, sFar]) out.push(el('circle', { cx: x, cy: y, r: 2.2, fill: '#c7a544' }));
  }
  const cx1 = sx1 + 3;
  const cx2 = sx2 - 3;
  const cy1 = Math.min(sNear, sFar) + 8;
  const cy2 = Math.max(sNear, sFar) - 8;
  out.push(el('rect', { x: cx1, y: cy1, width: cx2 - cx1, height: cy2 - cy1, rx: 2, fill: '#111216', stroke: '#000' }));
  // Pin 1 mark at the near-left corner, and the legend along the chip's long axis.
  out.push(el('circle', { cx: cx1 + 6, cy: r.dir === -1 ? cy2 - 6 : cy1 + 6, r: 2, fill: '#d8dbe2' }));
  out.push(text((cx1 + cx2) / 2, (cy1 + cy2) / 2 + 4, 'L3 CKT', { fill: '#e8ecf4', 'font-size': 11, 'font-weight': 700, 'letter-spacing': 1.5 }));
  return out.join('');
}

// ---------- parts ----------

function body2(part: PlacedPart, t: Theme, sim: SimState | null, sk: Skin, colours: Record<string, LedColour>): string {
  // Drawn horizontally, centred at the origin; the caller rotates it along the leg axis.
  const value = part.value;
  switch (part.style) {
    case 'R': {
      // The bands are read off the value, so a resistor never shows a code for
      // some other part. Three grouped at one end, tolerance alone at the far
      // end, the way they are painted.
      const bands = colourBands(value);
      const xs = [-7.5, -4.5, -1.5, 5.5];
      return el('rect', { x: -11, y: -4.5, width: 22, height: 9, rx: 2, fill: t.body, stroke: t.bodyStroke }) + (bands ?? []).map((b, i) => el('rect', { x: xs[i], y: -4.5, width: 2, height: 9, fill: b.hex })).join('');
    }
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
      const state = ledState(part.id, sim);
      if (sk.ledBody) return sk.ledBody(part, state, t, colours);
      const on = state.brightness > 0;
      // Flat: a solid dot, but its opacity follows the solved current when
      // there is one, so even the printable skin distinguishes dim from hot.
      const fade = sim?.ledBrightness ? { 'fill-opacity': (0.35 + 0.65 * Math.min(state.brightness, 1)).toFixed(2) } : {};
      return el('circle', { cx: 0, cy: 0, r: 6.5, fill: on ? t.ledOn : t.ledOff, stroke: '#7A1F1F', 'data-led': on ? 'on' : 'off', ...fade }) + el('line', { x1: -6.5, y1: -4, x2: -6.5, y2: 4, stroke: '#1E1E1E', 'stroke-width': 1.6 });
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

function drawPart(part: PlacedPart, res: EngineResult, t: Theme, sim: SimState | null, dim: (nets: string[], refs: string[]) => number | undefined, sk: Skin): string {
  const pts = part.holes.map(pt);
  const inner: string[] = [];
  if (part.kind === 'lead2') {
    const [[ax, ay], [bx, by]] = pts;
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const deg = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
    const shadow = sk.contactShadow?.(part, mx, my, Math.hypot(bx - ax, by - ay) / 2);
    if (shadow) inner.push(shadow);
    const leads = part.style === 'LED' ? sk.ledLeads?.(part, [ax, ay], [bx, by]) : undefined;
    inner.push(leads ?? el('line', { x1: ax, y1: ay, x2: bx, y2: by, stroke: t.lead, 'stroke-width': 1.8 }));
    inner.push(el('g', { transform: `translate(${n(mx)} ${n(my)}) rotate(${n(deg)})` }, body2(part, t, sim, sk, res.ledColors ?? {})));
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

/** A named layer, or nothing at all when the skin does not paint one. */
function wrap(id: string, style: string, inner: string | undefined): string {
  return inner ? `<g id="${id}" style="${style}" aria-hidden="true">${inner}</g>` : '';
}

function drawWire(w: Wire, i: number, color: string, t: Theme, opacity: number | undefined, sk: Skin, c: Control): string {
  const [ax, ay] = pt(w.a);
  const [bx, by] = pt(w.b);
  // Every jumper bows, and wires sharing a corridor bow by different amounts,
  // so a run of links along one row reads as several arcs rather than a single
  // straight line. routing.ts works out where each control point goes.
  const [cx, cy] = c;
  const rail = isRail(w.a.row) || isRail(w.b.row);
  const body = sk.wireBody?.([ax, ay], [cx, cy], [bx, by], color, rail);
  return el('g', { class: 'wire', 'data-net': w.net, 'data-wire': i, opacity }, body ?? el('path', { d: `M ${n(ax)} ${n(ay)} Q ${n(cx)} ${n(cy)} ${n(bx)} ${n(by)}`, fill: 'none', stroke: color, 'stroke-width': rail ? 2.2 : 2.6, 'stroke-linecap': 'round' }) + (body ? '' : el('circle', { cx: ax, cy: ay, r: 3.2, fill: color, stroke: t.chip, 'stroke-width': 0.8 }) + el('circle', { cx: bx, cy: by, r: 3.2, fill: color, stroke: t.chip, 'stroke-width': 0.8 })));
}

/**
 * A square-cornered jumper: a dark edge under the coloured run, mitred
 * corners, and a dot in each hole. One the router could not route cleanly is
 * dashed, the same flag the 3D board shows as a red tint.
 */
function drawOrthoWire(w: Wire, i: number, color: string, t: Theme, opacity: number | undefined, pts: OrthoPoint[], warn: boolean): string {
  const rail = isRail(w.a.row) || isRail(w.b.row);
  const width = rail ? 2.2 : 2.6;
  const d = pts.map(([x, y], k) => `${k ? 'L' : 'M'} ${n(x)} ${n(y)}`).join(' ');
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  return el(
    'g',
    { class: 'wire', 'data-net': w.net, 'data-wire': i, opacity },
    el('path', { d, fill: 'none', stroke: 'rgba(0,0,0,0.38)', 'stroke-width': width + 1.6, 'stroke-linejoin': 'miter', 'stroke-linecap': 'round' }) +
      el('path', { d, fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linejoin': 'miter', 'stroke-linecap': 'round', 'stroke-dasharray': warn ? '5 3' : undefined }) +
      el('circle', { cx: ax, cy: ay, r: 3.2, fill: color, stroke: t.chip, 'stroke-width': 0.8 }) +
      el('circle', { cx: bx, cy: by, r: 3.2, fill: color, stroke: t.chip, 'stroke-width': 0.8 }),
  );
}

// ---------- entry ----------

/** An LED's live state, defaulting to the boolean on/off when no solver ran. */
function ledState(ref: string, sim: SimState | null): SkinLedState {
  const b = sim?.ledBrightness?.[ref];
  return { brightness: b !== undefined ? b : sim?.leds[ref] ? 1 : 0, overdrive: sim?.ledOverdrive?.[ref] ?? 0 };
}

/**
 * `res.routes` is what the pipeline routed for square wires (LayoutDoc has it
 * when the sidecar asks for them); a bare engine result is routed here.
 */
export function renderSvg(res: EngineResult & { routes?: WireRoute[] }, opts: RenderOptions = {}): string {
  const t = opts.theme ?? LIGHT;
  const sk = opts.skin ?? FLAT;
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
  const size = svgSize(res.board, res.packages);
  const ortho = opts.wireStyle === 'orthogonal';
  const controls = ortho ? [] : wireControls(res.wires);
  // Fallback for bare EngineResult callers only: it ignores saved wirePaths (the pipeline routes with them).
  const routes = ortho ? (res.routes ?? routeWires(res).routes) : [];
  const ctx: SkinContext = { parts: res.parts, board: res.board, ledColors: res.ledColors ?? {}, leds: Object.fromEntries(res.parts.filter((p) => p.style === 'LED').map((p) => [p.id, ledState(p.id, sim)])) };
  const defs = sk.defs?.(ctx, t);
  const layers = [
    defs ? `<defs>${defs}</defs>` : '',
    drawBoard(res, t, sk),
    // Spill sits between the board and the parts and multiplies onto the
    // plastic, so light pools on the board. Glow sits above the wires and
    // screens over them, so it reads as light in the air.
    wrap('l-spill', 'mix-blend-mode:multiply', sk.spillLayer?.(ctx, t)),
    el('g', { class: 'packages' }, res.packages.map((p) => drawPackage(p, res, t, sim, hl?.wire !== undefined || hl?.net !== undefined ? () => undefined : dim)).join('')),
    el('g', { class: 'parts' }, res.parts.map((p) => drawPart(p, res, t, sim, dimPart, sk)).join('')),
    el('g', { class: 'wires' }, res.wires.map((w, i) => (ortho ? drawOrthoWire(w, i, res.nets[w.net]?.color ?? t.text, t, dim([w.net], [], i), routes[i].plan, !!routes[i].warning) : drawWire(w, i, res.nets[w.net]?.color ?? t.text, t, dim([w.net], [], i), sk, controls[i]))).join('')),
    drawSupply(res, t, hl?.wire !== undefined ? () => undefined : dim),
    wrap('l-glow', 'mix-blend-mode:screen', sk.glowLayer?.(ctx, t)),
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${size.viewBox}" width="${size.width}" height="${size.height}" font-family="ui-monospace, Consolas, monospace">${layers.join('')}</svg>`;
}

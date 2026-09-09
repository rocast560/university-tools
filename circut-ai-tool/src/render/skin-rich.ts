// The browser's skin: moulded plastic, recessed sockets, and LEDs that look
// like LEDs.
//
// Two rules keep this fast enough to animate at 60 fps.
//
// 1. The filter budget is two, and neither is board-sized. feTurbulence over
//    the whole slab would be re-evaluated on every zoom notch, because
//    changing the viewBox changes the raster scale and invalidates the cached
//    filter result. It runs once inside a 64x64 pattern tile instead.
// 2. Nothing per-frame lives in <defs>. Mutating a gradient stop invalidates
//    every element referencing it, so each LED gets its own gradients and the
//    animation moves `opacity` and `r` on elements.
//
// The ~880 holes are four <rect>s filled with a repeating pattern rather than
// 880 groups of shapes. The rows are uniformly one pitch apart, so a tile
// lines up exactly.

import { ROWY, X0, P } from './geometry.ts';
import type { BoardGeom, Point, Skin, SkinContext, SkinLedState } from './skin.ts';
import type { Theme } from './theme.ts';
import { ledSpec, ledSpecFor, type LedColour } from '../parts/led.ts';
import type { PlacedPart } from '../layout/types.ts';

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
/** Safe for an id: refs are like "D1", but never trust them blindly. */
const idOf = (ref: string) => ref.replace(/[^A-Za-z0-9_-]/g, '_');

/** 5mm through-hole LEDs are nearly two columns wide at true scale, which */
/** would swallow the wiring, so the dome is drawn a little under one. */
const R_DOME = 8;
const R_FLANGE = 9.2;

/** Mix a hex colour towards white (positive) or black (negative). */
function shade(hex: string, amount: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const to = amount >= 0 ? 255 : 0;
  const k = Math.abs(amount);
  const ch = (i: number) => Math.round(parseInt(m[i], 16) * (1 - k) + to * k);
  return `#${[1, 2, 3].map((i) => ch(i).toString(16).padStart(2, '0')).join('')}`;
}

function socketPatterns(g: BoardGeom): string {
  const gap = g.board.railGapEvery;
  const tile = gap * P;
  // The rails skip every `gap`-th column, so one tile has to cover the whole
  // repeat rather than a single hole.
  const railUses: string[] = [];
  for (let c = 1; c < gap; c++) railUses.push(`<use href="#bbSkt" x="${n(c * P - P / 2)}" y="9"/>`);
  return (
    `<g id="bbSkt">` +
    `<rect x="-3.1" y="-3.1" width="6.2" height="6.2" rx="1.1" fill="url(#bbLip)"/>` +
    `<rect x="-2.2" y="-2.2" width="4.4" height="4.4" rx=".7" fill="#22252B"/>` +
    `<rect x="-1.5" y="-2" width="3" height="2.2" rx=".4" fill="url(#bbClip)"/>` +
    `</g>` +
    `<pattern id="bbStripHoles" x="${n(X0 - P / 2)}" y="${n(ROWY.a - 9)}" width="${P}" height="${P}" patternUnits="userSpaceOnUse"><use href="#bbSkt" x="9" y="9"/></pattern>` +
    `<pattern id="bbRailHoles" x="${n(X0 - P / 2)}" y="${n(ROWY['T+'] - 9)}" width="${tile}" height="${P}" patternUnits="userSpaceOnUse">${railUses.join('')}</pattern>`
  );
}

/** A chosen colour wins over whatever the schematic value says. */
export function specOf(ref: string, value: string, colours: Record<string, LedColour>): ReturnType<typeof ledSpec> {
  const chosen = colours[ref];
  return chosen ? ledSpecFor(chosen) : ledSpec(value || 'LED');
}

function ledDefs(ctx: SkinContext): string {
  const out: string[] = [];
  for (const part of ctx.parts) {
    if (part.style !== 'LED') continue;
    const id = idOf(part.id);
    const spec = specOf(part.id, part.value, ctx.ledColors);
    const body = spec.body;
    const light = spec.light;
    out.push(
      `<radialGradient id="bbEpoxy-${id}" cx=".38" cy=".32" r=".78">` +
        `<stop offset="0" stop-color="${shade(body, 0.45)}" stop-opacity=".95"/>` +
        `<stop offset=".45" stop-color="${body}" stop-opacity=".9"/>` +
        `<stop offset="1" stop-color="${shade(body, -0.45)}" stop-opacity=".95"/>` +
        `</radialGradient>`,
      `<radialGradient id="bbCore-${id}">` +
        `<stop offset="0" stop-color="#FFFFFF"/>` +
        `<stop offset=".35" stop-color="${shade(light, 0.35)}"/>` +
        `<stop offset="1" stop-color="${light}" stop-opacity="0"/>` +
        `</radialGradient>`,
      `<radialGradient id="bbHalo-${id}">` +
        `<stop offset="0" stop-color="${light}" stop-opacity=".95"/>` +
        `<stop offset=".38" stop-color="${light}" stop-opacity=".55"/>` +
        `<stop offset="1" stop-color="${light}" stop-opacity="0"/>` +
        `</radialGradient>`,
      `<radialGradient id="bbSpill-${id}">` +
        `<stop offset="0" stop-color="${light}" stop-opacity=".42"/>` +
        `<stop offset=".55" stop-color="${light}" stop-opacity=".15"/>` +
        `<stop offset="1" stop-color="${light}" stop-opacity="0"/>` +
        `</radialGradient>`,
    );
  }
  return out.join('');
}

export const RICH: Skin = {
  name: 'rich',

  defs(ctx, t) {
    const g: BoardGeom = { x: 8, y: 8, width: 0, height: 334, xr: 0, board: ctx.board };
    return (
      // Grain: turbulence evaluated once into a small tile, then repeated.
      `<filter id="bbNoise" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
        `<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="7" stitchTiles="stitch" result="n"/>` +
        `<feColorMatrix in="n" type="saturate" values="0"/>` +
        `<feComponentTransfer><feFuncA type="table" tableValues="0 0.15"/></feComponentTransfer>` +
        `</filter>` +
      `<pattern id="bbGrain" width="64" height="64" patternUnits="userSpaceOnUse">` +
        `<rect width="64" height="64" fill="${shade(t.board, -0.25)}" filter="url(#bbNoise)"/>` +
        `</pattern>` +
      `<filter id="bbDrop" x="-4%" y="-12%" width="108%" height="126%" color-interpolation-filters="sRGB">` +
        `<feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#2A2416" flood-opacity=".28"/>` +
        `</filter>` +
      `<linearGradient id="bbSlab" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="${shade(t.board, 0.35)}"/>` +
        `<stop offset=".45" stop-color="${t.board}"/>` +
        `<stop offset="1" stop-color="${shade(t.board, -0.12)}"/>` +
        `</linearGradient>` +
      `<linearGradient id="bbChan" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="${shade(t.gutter, -0.3)}"/>` +
        `<stop offset=".22" stop-color="${shade(t.gutter, 0.06)}"/>` +
        `<stop offset=".8" stop-color="${shade(t.gutter, 0.1)}"/>` +
        `<stop offset="1" stop-color="${shade(t.gutter, -0.16)}"/>` +
        `</linearGradient>` +
      `<radialGradient id="bbLip" cx=".5" cy=".34" r=".78">` +
        `<stop offset="0" stop-color="${shade(t.board, 0.55)}" stop-opacity=".85"/>` +
        `<stop offset=".6" stop-color="${shade(t.board, -0.15)}" stop-opacity=".35"/>` +
        `<stop offset="1" stop-color="${shade(t.board, -0.42)}" stop-opacity=".55"/>` +
        `</radialGradient>` +
      `<linearGradient id="bbClip" x1="0" y1="0" x2=".3" y2="1">` +
        `<stop offset="0" stop-color="#9AA0AA"/><stop offset=".5" stop-color="#5A5F68"/><stop offset="1" stop-color="#2F333A"/>` +
        `</linearGradient>` +
      `<radialGradient id="bbContact"><stop offset="0" stop-color="#2A2416" stop-opacity=".26"/><stop offset="1" stop-color="#2A2416" stop-opacity="0"/></radialGradient>` +
      `<linearGradient id="bbTin" x1="0" y1="0" x2=".35" y2="1">` +
        `<stop offset="0" stop-color="#F2F4F7"/><stop offset=".38" stop-color="#B9BFC8"/>` +
        `<stop offset=".7" stop-color="#818892"/><stop offset="1" stop-color="#5A606A"/>` +
        `</linearGradient>` +
      `<radialGradient id="bbSpec"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".92"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>` +
      socketPatterns(g) +
      ledDefs(ctx)
    );
  },

  boardSlab(g, t) {
    return (
      `<rect x="${n(g.x)}" y="${n(g.y)}" width="${n(g.width)}" height="${n(g.height)}" rx="6" fill="url(#bbSlab)" stroke="${shade(t.boardStroke, -0.18)}" filter="url(#bbDrop)"/>`
    );
  },

  boardOverlay(g) {
    return (
      `<rect data-grain="1" x="${n(g.x)}" y="${n(g.y)}" width="${n(g.width)}" height="${n(g.height)}" rx="6" fill="url(#bbGrain)" opacity=".55"/>` +
      // Bevel: a bright inner edge, so the slab reads as moulded rather than printed.
      `<rect x="${n(g.x + 0.8)}" y="${n(g.y + 0.8)}" width="${n(g.width - 1.6)}" height="${n(g.height - 1.6)}" rx="5.4" fill="none" stroke="#FFFDF6" stroke-opacity=".5" stroke-width="1.5"/>`
    );
  },

  channel(g, t) {
    const w = g.xr - 10;
    return (
      `<rect x="26" y="168" width="${n(w)}" height="12" rx="2" fill="url(#bbChan)"/>` +
      `<line x1="26" y1="168.6" x2="${n(26 + w)}" y2="168.6" stroke="${shade(t.gutter, -0.45)}" stroke-opacity=".55" stroke-width=".8"/>` +
      `<line x1="26" y1="179.4" x2="${n(26 + w)}" y2="179.4" stroke="#FFFCF2" stroke-opacity=".5" stroke-width=".8"/>`
    );
  },

  holeBands(g) {
    const w = g.board.cols * P;
    const x = X0 - P / 2;
    const band = (y: number, h: number, fill: string) => `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="url(#${fill})"/>`;
    return (
      band(ROWY['T+'] - 9, ROWY['T-'] - ROWY['T+'] + 18, 'bbRailHoles') +
      band(ROWY.a - 9, ROWY.e - ROWY.a + 18, 'bbStripHoles') +
      band(ROWY.f - 9, ROWY.j - ROWY.f + 18, 'bbStripHoles') +
      band(ROWY['B-'] - 9, ROWY['B+'] - ROWY['B-'] + 18, 'bbRailHoles')
    );
  },

  contactShadow(_part, mx, my, halfLen) {
    // A gradient ellipse, not a drop-shadow filter: one filter region per part
    // would re-rasterise on every zoom.
    return `<ellipse cx="${n(mx + 1)}" cy="${n(my + 3.4)}" rx="${n(halfLen + 5)}" ry="7" fill="url(#bbContact)"/>`;
  },

  ledBody(part, state, _t, colours) {
    const id = idOf(part.id);
    const spec = specOf(part.id, part.value, colours);
    const lit = state.brightness > 0;
    return (
      // Flange with the cathode flat cut as a chord on the -x side.
      `<path d="M ${n(-R_DOME)} -4.6 A ${n(R_FLANGE)} ${n(R_FLANGE)} 0 1 1 ${n(-R_DOME)} 4.6 Z" fill="#C9C2AE" stroke="#8E8877" stroke-width=".7"/>` +
      // Anvil cup on the cathode side, post on the anode side, bond wire between.
      `<path d="M -5.6 3 L -5.6 -0.9 A 2.5 2.5 0 0 1 -0.6 -0.9 L -0.6 3 Z" fill="#7E838C" opacity=".5"/>` +
      `<rect x="2.6" y="-0.9" width="1.7" height="3.9" rx=".4" fill="#7E838C" opacity=".45"/>` +
      `<line x1="-3.1" y1="-0.4" x2="3.4" y2="-0.4" stroke="#9AA0AA" stroke-width=".7" opacity=".4"/>` +
      // Epoxy dome.
      `<circle data-led-dome="${esc(part.id)}" r="${R_DOME}" fill="url(#bbEpoxy-${id})" data-led="${lit ? 'on' : 'off'}"/>` +
      // Emissive core and blow-out, both patched per frame.
      `<circle data-led-core="${esc(part.id)}" cx="-0.6" cy="0" r="5.6" fill="url(#bbCore-${id})" opacity="${n(coreOpacity(state))}"/>` +
      `<circle data-led-blow="${esc(part.id)}" r="${R_DOME}" fill="#FFFFFF" opacity="${n(blowOpacity(state))}"/>` +
      // Specular highlight and the ring where the dome turns away from you.
      `<ellipse cx="-2.7" cy="-3" rx="2.8" ry="1.9" transform="rotate(-24 -2.7 -3)" fill="url(#bbSpec)"/>` +
      `<circle r="${n(R_DOME - 1.6)}" fill="none" stroke="#FFFFFF" stroke-opacity=".22" stroke-width=".9"/>` +
      `<circle r="${R_DOME}" fill="none" stroke="${shade(spec.body, -0.6)}" stroke-opacity=".8" stroke-width=".8"/>`
    );
  },

  ledLeads(_part, a, b) {
    // The cathode leg is the short, dull one; the anode is longer and brighter.
    const [ax, ay] = a;
    const [bx, by] = b;
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    return (
      `<path d="M ${n(ax)} ${n(ay)} L ${n(mx - 4.4)} ${n(my)}" fill="none" stroke="#8A8F98" stroke-width="1.7" stroke-linecap="round"/>` +
      `<path d="M ${n(bx)} ${n(by)} L ${n(mx + 4.4)} ${n(my)}" fill="none" stroke="#B9BFC8" stroke-width="1.7" stroke-linecap="round"/>`
    );
  },

  wireBody(a, c, b, color, rail) {
    const d = `M ${n(a[0])} ${n(a[1])} Q ${n(c[0])} ${n(c[1])} ${n(b[0])} ${n(b[1])}`;
    const w = rail ? 3.2 : 3.6;
    // The insulation is the same path with its two ends dashed away, so the
    // bare tinned core underneath shows through exactly where a real jumper
    // is stripped. pathLength normalises the curve to 100 units, which means
    // no Bezier splitting is needed to place the cut.
    const tip = Math.round(Math.min(28, Math.max(5, (TIP_UNITS / quadLength(a, c, b)) * 100)));
    const jacket = { pathLength: 100, 'stroke-dasharray': `0 ${tip} ${100 - 2 * tip} ${tip}`, 'stroke-linecap': 'butt' as const };
    const stroke = (extra: Record<string, string | number>) => `<path d="${d}" fill="none" ${Object.entries(extra).map(([k, v]) => `${k}="${typeof v === 'number' ? n(v) : v}"`).join(' ')}/>`;
    return (
      // Cast shadow, so a wire crossing another reads as over rather than merged.
      stroke({ stroke: '#2A2416', 'stroke-opacity': '.22', 'stroke-width': w + 2.4, 'stroke-linecap': 'round', transform: 'translate(0.8 2.2)' }) +
      // Bare core: only the stripped ends are ever visible.
      stroke({ stroke: 'url(#bbTin)', 'stroke-width': w * 0.62, 'stroke-linecap': 'round' }) +
      // Three concentric strokes read as a round tube: dark edge, body, sheen.
      stroke({ ...jacket, stroke: shade(color, -0.5), 'stroke-width': w + 1.3 }) +
      stroke({ ...jacket, stroke: color, 'stroke-width': w }) +
      stroke({ ...jacket, stroke: shade(color, 0.55), 'stroke-opacity': '.5', 'stroke-width': w * 0.3 }) +
      // The crimp where the jacket is cut, and the pin pressed into the hole.
      endCap(a, color) +
      endCap(b, color)
    );
  },

  spillLayer(ctx) {
    return ledPositions(ctx)
      .map(({ part, x, y, state }) => `<ellipse data-spill="${esc(part.id)}" cx="${n(x)}" cy="${n(y)}" rx="34" ry="26" fill="url(#bbSpill-${idOf(part.id)})" opacity="${n(spillOpacity(state))}"/>`)
      .join('');
  },

  glowLayer(ctx) {
    return ledPositions(ctx)
      .map(({ part, x, y, state }) => `<circle data-glow="${esc(part.id)}" cx="${n(x)}" cy="${n(y)}" r="${n(haloRadius(state))}" fill="url(#bbHalo-${idOf(part.id)})" opacity="${n(haloOpacity(state))}"/>`)
      .join('');
  },
};

/** How much bare conductor to leave showing at each end, in board units. */
const TIP_UNITS = 7;

/** Good enough for a shallow arc, and it only picks the dash length. */
function quadLength(a: Point, c: Point, b: Point): number {
  const d = (p: Point, q: Point) => Math.hypot(q[0] - p[0], q[1] - p[1]);
  return Math.max((d(a, c) + d(c, b) + d(a, b)) / 2, 1);
}

/** A pin pressed into a hole, with the crimp of the jacket behind it. */
function endCap([x, y]: Point, color: string): string {
  return (
    `<circle cx="${n(x)}" cy="${n(y)}" r="2.9" fill="url(#bbTin)" stroke="${shade(color, -0.6)}" stroke-width=".6"/>` +
    `<circle cx="${n(x - 0.7)}" cy="${n(y - 0.8)}" r="1" fill="#FFFFFF" opacity=".5"/>`
  );
}

/** The mid-point of each LED, where its light comes from. */
function ledPositions(ctx: SkinContext): { part: PlacedPart; x: number; y: number; state: SkinLedState }[] {
  const out: { part: PlacedPart; x: number; y: number; state: SkinLedState }[] = [];
  for (const part of ctx.parts) {
    if (part.style !== 'LED' || part.holes.length < 2) continue;
    const [a, b] = part.holes;
    out.push({
      part,
      x: (X0 + (a.col - 1) * P + X0 + (b.col - 1) * P) / 2,
      y: (ROWY[a.row] + ROWY[b.row]) / 2,
      state: ctx.leds[part.id] ?? { brightness: 0, overdrive: 0 },
    });
  }
  return out;
}

// The visual response is deliberately not linear in current. Perceived
// brightness runs closer to a power law, so a 1 mA LED has to look dim rather
// than invisible, and the difference between 10 and 15 mA has to look small.
export const coreOpacity = (s: SkinLedState) => Math.pow(Math.min(Math.max(s.brightness, 0), 1), 0.45);
export const haloOpacity = (s: SkinLedState) => Math.pow(coreOpacity(s), 1.4);
export const haloRadius = (s: SkinLedState) => 15 + 21 * coreOpacity(s) + 20 * Math.min(Math.max(s.overdrive, 0), 1);
export const spillOpacity = (s: SkinLedState) => 0.62 * coreOpacity(s);
export const blowOpacity = (s: SkinLedState) => 0.85 * Math.min(Math.max(s.overdrive, 0), 1);

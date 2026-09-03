// Software 3D snapshot: orthographic projection, depth sorted, to SVG. Used when no window
// can answer a live snapshot request.

import { bySymbol } from './elements';
import type { Atom, Bond, ViewState } from './types';

export interface SnapshotOptions {
  width?: number; height?: number;
  style?: ViewState['style'];
  /** Degrees about x, y, z, applied in that order. */
  rotation?: [number, number, number];
  showHydrogens?: boolean;
  highlight?: number[];
  background?: string;
}

const rad = (d: number) => (d * Math.PI) / 180;

function rotate([x, y, z]: [number, number, number], [rx, ry, rz]: [number, number, number]): [number, number, number] {
  let [X, Y, Z] = [x, y, z];
  [Y, Z] = [Y * Math.cos(rad(rx)) - Z * Math.sin(rad(rx)), Y * Math.sin(rad(rx)) + Z * Math.cos(rad(rx))];
  [X, Z] = [X * Math.cos(rad(ry)) + Z * Math.sin(rad(ry)), -X * Math.sin(rad(ry)) + Z * Math.cos(rad(ry))];
  [X, Y] = [X * Math.cos(rad(rz)) - Y * Math.sin(rad(rz)), X * Math.sin(rad(rz)) + Y * Math.cos(rad(rz))];
  return [X, Y, Z];
}

const f = (n: number) => n.toFixed(2);

function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.min(255, Math.round(v + (255 - v) * amount));
  return `#${((ch(n >> 16) << 16) | (ch((n >> 8) & 255) << 8) | ch(n & 255)).toString(16).padStart(6, '0')}`;
}

export function renderSnapshotSvg(atoms: Atom[], bonds: Bond[], opts: SnapshotOptions = {}): string {
  const { width = 640, height = 480, style = 'ballstick', rotation = [20, 30, 0], showHydrogens = true, highlight = [], background = '#ffffff' } = opts;
  const visible = atoms.filter((a) => showHydrogens || a.element !== 'H');
  const pts = visible.map((a) => ({ a, p: rotate([a.x, a.y, a.z], rotation) }));
  const xs = pts.map((q) => q.p[0]);
  const ys = pts.map((q) => q.p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 2) + 3;
  const scale = Math.min(width, height) / span;
  const proj = (p: [number, number, number]) => [width / 2 + (p[0] - cx) * scale, height / 2 - (p[1] - cy) * scale] as const;
  const colorOf = (el: string) => bySymbol(el)?.color ?? '#ff00ff';
  const radiusOf = (el: string) => {
    const r = bySymbol(el)?.radius ?? 0.7;
    return style === 'spacefill' ? r * 1.7 : style === 'stick' ? 0.22 : r * 0.45;
  };
  const pos = new Map(pts.map((q) => [q.a.index, q.p]));
  const byIndex = new Map(atoms.map((a) => [a.index, a]));
  const items: { z: number; svg: string }[] = [];
  const bondWidth = style === 'wireframe' ? 2 : style === 'stick' ? 0.22 * scale : 0.12 * scale;

  if (style !== 'spacefill') {
    for (const b of bonds) {
      const pa = pos.get(b.a);
      const pb = pos.get(b.b);
      if (!pa || !pb) continue;
      const [x1, y1] = proj(pa);
      const [x2, y2] = proj(pb);
      const [mx, my] = [(x1 + x2) / 2, (y1 + y2) / 2];
      const ca = colorOf(byIndex.get(b.a)!.element);
      const cb = colorOf(byIndex.get(b.b)!.element);
      items.push({
        z: (pa[2] + pb[2]) / 2,
        svg: `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(mx)}" y2="${f(my)}" stroke="${ca}" stroke-width="${f(bondWidth)}" stroke-linecap="round"/>` +
          `<line x1="${f(mx)}" y1="${f(my)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${cb}" stroke-width="${f(bondWidth)}" stroke-linecap="round"/>`,
      });
    }
  }
  const used = new Set<string>();
  if (style !== 'wireframe') {
    for (const { a, p } of pts) {
      const [x, y] = proj(p);
      const r = radiusOf(a.element) * scale;
      used.add(a.element);
      const ring = highlight.includes(a.index) ? `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r + 4)}" fill="none" stroke="#ffd400" stroke-width="3"/>` : '';
      items.push({ z: p[2] + 0.01, svg: `${ring}<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="url(#g-${a.element})" stroke="#333" stroke-width="0.8"/>` });
    }
  }
  items.sort((p, q) => p.z - q.z);
  const defs = [...used].map((el) => {
    const c = colorOf(el);
    return `<radialGradient id="g-${el}" cx="35%" cy="35%" r="65%"><stop offset="0%" stop-color="${lighten(c, 0.6)}"/><stop offset="100%" stop-color="${c}"/></radialGradient>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${defs}</defs><rect width="100%" height="100%" fill="${background}"/>${items.map((i) => i.svg).join('')}</svg>`;
}

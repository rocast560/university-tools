// Software rendered 3D snapshot as SVG.
//
// The browser gets real WebGL through 3Dmol.js; MCP clients and the PNG
// endpoints need a picture without a GPU. This is a painter's algorithm
// renderer: centre the molecule, align its principal axes with the screen
// (so flat molecules face the viewer), tilt a little for depth, project
// orthographically, sort every sphere and bond segment back to front, and
// emit circles with radial gradients and round capped lines.

import { covalentRadius, cpkColor } from './elements.ts';
import type { Structure3D } from './structure.ts';

export type RenderStyle = 'ballstick' | 'stick' | 'spacefill';

export interface RenderOptions {
  width?: number;
  height?: number;
  style?: RenderStyle;
  /** Extra rotation in degrees applied after the automatic alignment. */
  rotate?: { x?: number; y?: number; z?: number };
  /** CSS colour or 'transparent'. */
  background?: string;
  /** Label heavy atoms with their symbol. */
  labels?: boolean;
  /** Colour for labels and bond outlines. */
  foreground?: string;
  /** Extra line segments (cell edges) in the same coordinate system. */
  lines?: Array<{ from: [number, number, number]; to: [number, number, number]; color?: string }>;
}

type Vec = [number, number, number];
type Mat = [Vec, Vec, Vec];

function mulMatVec(m: Mat, v: Vec): Vec {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function mulMat(a: Mat, b: Mat): Mat {
  const r: Mat = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i][j] += a[i][k] * b[k][j];
  return r;
}

function rotX(deg: number): Mat {
  const t = (deg * Math.PI) / 180;
  return [[1, 0, 0], [0, Math.cos(t), -Math.sin(t)], [0, Math.sin(t), Math.cos(t)]];
}
function rotY(deg: number): Mat {
  const t = (deg * Math.PI) / 180;
  return [[Math.cos(t), 0, Math.sin(t)], [0, 1, 0], [-Math.sin(t), 0, Math.cos(t)]];
}
function rotZ(deg: number): Mat {
  const t = (deg * Math.PI) / 180;
  return [[Math.cos(t), -Math.sin(t), 0], [Math.sin(t), Math.cos(t), 0], [0, 0, 1]];
}

/**
 * Eigenvectors of a symmetric 3x3 matrix by cyclic Jacobi rotations,
 * returned as rows sorted by descending eigenvalue. That is the rotation
 * that puts the longest molecular axis on x and the flattest on z.
 */
export function principalAxes(points: Vec[]): Mat {
  const n = points.length;
  if (n < 2) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const cov: Mat = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of points) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += p[i] * p[j] / n;
  const v: Mat = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const a: Mat = [[...cov[0]], [...cov[1]], [...cov[2]]] as Mat;
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) off += a[i][j] * a[i][j];
    if (off < 1e-18) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-12) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  const rows = order.map((i) => [v[0][i], v[1][i], v[2][i]] as Vec) as Mat;
  // Keep a right handed frame so nothing is mirrored.
  const cross: Vec = [
    rows[0][1] * rows[1][2] - rows[0][2] * rows[1][1],
    rows[0][2] * rows[1][0] - rows[0][0] * rows[1][2],
    rows[0][0] * rows[1][1] - rows[0][1] * rows[1][0],
  ];
  if (cross[0] * rows[2][0] + cross[1] * rows[2][1] + cross[2] * rows[2][2] < 0) rows[2] = [-rows[2][0], -rows[2][1], -rows[2][2]];
  return rows;
}

interface Sphere {
  kind: 'sphere';
  x: number;
  y: number;
  z: number;
  r: number;
  color: string;
  label?: string;
}
interface Segment {
  kind: 'segment';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  z: number;
  width: number;
  color: string;
}
type Primitive = Sphere | Segment;

function shade(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((n >> 16) & 255) * factor);
  const g = clamp(((n >> 8) & 255) * factor);
  const b = clamp((n & 255) * factor);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Render a structure to an SVG string. */
export function renderStructureSvg(structure: Structure3D, options: RenderOptions = {}): string {
  const {
    width = 640,
    height = 480,
    style = 'ballstick',
    rotate = {},
    background = 'transparent',
    labels = false,
    foreground = '#1a1a1a',
    lines = [],
  } = options;

  const atoms = structure.atoms;
  if (atoms.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"></svg>`;
  }
  const cx = atoms.reduce((s, a) => s + a.x, 0) / atoms.length;
  const cy = atoms.reduce((s, a) => s + a.y, 0) / atoms.length;
  const cz = atoms.reduce((s, a) => s + a.z, 0) / atoms.length;
  const centred: Vec[] = atoms.map((a) => [a.x - cx, a.y - cy, a.z - cz]);

  const align = principalAxes(centred);
  const tilt = mulMat(mulMat(rotZ(rotate.z ?? 0), rotX((rotate.x ?? 0) + 18)), rotY((rotate.y ?? 0) + 22));
  const view = mulMat(tilt, align);
  const pts = centred.map((p) => mulMatVec(view, p));
  const extraLines = lines.map((l) => ({
    from: mulMatVec(view, [l.from[0] - cx, l.from[1] - cy, l.from[2] - cz]),
    to: mulMatVec(view, [l.to[0] - cx, l.to[1] - cy, l.to[2] - cz]),
    color: l.color ?? foreground,
  }));

  const radiusFor = (symbol: string): number => {
    const cov = covalentRadius(symbol);
    if (style === 'spacefill') return cov * 1.8;
    if (style === 'stick') return 0.18;
    return symbol === 'H' ? 0.24 : cov * 0.42;
  };

  // Fit: the extent of every sphere and line end in screen units.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  pts.forEach((p, i) => {
    const r = radiusFor(atoms[i].symbol);
    minX = Math.min(minX, p[0] - r);
    maxX = Math.max(maxX, p[0] + r);
    minY = Math.min(minY, p[1] - r);
    maxY = Math.max(maxY, p[1] + r);
  });
  for (const l of extraLines) {
    for (const p of [l.from, l.to]) {
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
  }
  const margin = 0.08;
  const scale = Math.min((width * (1 - 2 * margin)) / Math.max(maxX - minX, 0.5), (height * (1 - 2 * margin)) / Math.max(maxY - minY, 0.5));
  const ox = width / 2 - ((minX + maxX) / 2) * scale;
  const oy = height / 2 + ((minY + maxY) / 2) * scale;
  const sx = (v: number) => ox + v * scale;
  const sy = (v: number) => oy - v * scale;

  const prims: Primitive[] = [];
  const stickWidth = (style === 'stick' ? 0.36 : 0.2) * scale;

  if (style !== 'spacefill') {
    for (const b of structure.bonds) {
      const p = pts[b.a];
      const q = pts[b.b];
      const mid: Vec = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const len = Math.hypot(dx, dy) || 1;
      // Perpendicular offset in the screen plane for double and triple bonds.
      const nx = (-dy / len) * 0.22;
      const ny = (dx / len) * 0.22;
      const offsets = b.order === 2 ? [-0.5, 0.5] : b.order === 3 ? [-1, 0, 1] : [0];
      const w = offsets.length === 1 ? stickWidth : stickWidth * 0.6;
      for (const o of offsets) {
        const ax = p[0] + nx * o, ay = p[1] + ny * o;
        const mx = mid[0] + nx * o, my = mid[1] + ny * o;
        const bx = q[0] + nx * o, by = q[1] + ny * o;
        prims.push({ kind: 'segment', x1: sx(ax), y1: sy(ay), x2: sx(mx), y2: sy(my), z: (p[2] + mid[2]) / 2, width: w, color: cpkColor(atoms[b.a].symbol) });
        prims.push({ kind: 'segment', x1: sx(mx), y1: sy(my), x2: sx(bx), y2: sy(by), z: (mid[2] + q[2]) / 2, width: w, color: cpkColor(atoms[b.b].symbol) });
      }
    }
  }
  pts.forEach((p, i) => {
    const symbol = atoms[i].symbol;
    prims.push({
      kind: 'sphere',
      x: sx(p[0]),
      y: sy(p[1]),
      z: p[2],
      r: radiusFor(symbol) * scale,
      color: cpkColor(symbol),
      label: labels && symbol !== 'H' ? symbol : undefined,
    });
  });
  for (const l of extraLines) {
    prims.push({ kind: 'segment', x1: sx(l.from[0]), y1: sy(l.from[1]), x2: sx(l.to[0]), y2: sy(l.to[1]), z: (l.from[2] + l.to[2]) / 2 - 0.01, width: Math.max(1, scale * 0.04), color: l.color });
  }
  prims.sort((a, b) => a.z - b.z);

  const gradients = new Map<string, string>();
  const gradId = (color: string): string => {
    let id = gradients.get(color);
    if (!id) {
      id = 'g' + gradients.size;
      gradients.set(color, id);
    }
    return id;
  };
  const body: string[] = [];
  for (const p of prims) {
    if (p.kind === 'segment') {
      body.push(`<line x1="${p.x1.toFixed(1)}" y1="${p.y1.toFixed(1)}" x2="${p.x2.toFixed(1)}" y2="${p.y2.toFixed(1)}" stroke="${p.color}" stroke-width="${p.width.toFixed(1)}" stroke-linecap="round"/>`);
    } else {
      const g = gradId(p.color);
      body.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.r.toFixed(1)}" fill="url(#${g})" stroke="${shade(p.color, 0.45)}" stroke-width="${Math.max(0.6, p.r * 0.06).toFixed(1)}"/>`);
      if (p.label) {
        const size = Math.max(9, p.r * 0.9);
        body.push(`<text x="${p.x.toFixed(1)}" y="${(p.y + size * 0.35).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-weight="600" font-size="${size.toFixed(1)}" fill="${foreground}" stroke="#ffffff" stroke-width="${(size * 0.18).toFixed(1)}" paint-order="stroke">${escapeXml(p.label)}</text>`);
      }
    }
  }
  const defs = [...gradients.entries()]
    .map(([color, id]) =>
      `<radialGradient id="${id}" cx="35%" cy="32%" r="70%"><stop offset="0%" stop-color="${shade(color, 1.35)}"/><stop offset="55%" stop-color="${color}"/><stop offset="100%" stop-color="${shade(color, 0.55)}"/></radialGradient>`)
    .join('');
  const bg = background === 'transparent' ? '' : `<rect width="100%" height="100%" fill="${escapeXml(background)}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${defs}</defs>${bg}${body.join('')}</svg>`;
}

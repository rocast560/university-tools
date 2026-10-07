// Pure maths for placing KiCad 3D part models on the breadboard. No DOM, no three.js.

export type ModelKey = 'dip14' | 'dip16' | 'dipswitch7' | 'seg056' | 'led5' | 'r0207';

export const KIT_MODELS: Record<ModelKey, { footprint: string }> = {
  dip14: { footprint: 'Package_DIP:DIP-14_W7.62mm' },
  dip16: { footprint: 'Package_DIP:DIP-16_W7.62mm' },
  dipswitch7: { footprint: 'Button_Switch_THT:SW_DIP_SPSTx07_Slide_9.78x19.96mm_W7.62mm_P2.54mm' },
  seg056: { footprint: 'Display_7Segment:7SegmentLED_LTS6760_LTS6780' },
  led5: { footprint: 'LED_THT:LED_D5.0mm' },
  r0207: { footprint: 'Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal' },
};

export interface ModelInfo {
  file: string;
  footprint: string;
  /** Pad positions in the model's own frame, millimetres, [x, z] (y is up). */
  pads: Record<string, [number, number]>;
  /** Bounding box of the leg-free body, millimetres, in the model frame. */
  box: { min: [number, number, number]; max: [number, number, number] };
}
export interface Manifest { version: 1; models: Partial<Record<ModelKey, ModelInfo>> }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isVec = (x: unknown, n: number): boolean => Array.isArray(x) && x.length === n && x.every(isNum);

export function validateManifest(x: unknown): Manifest {
  if (!isObj(x)) throw new Error('manifest: not an object');
  if (x.version !== 1) throw new Error(`manifest: version must be 1, got ${String(x.version)}`);
  if (!isObj(x.models)) throw new Error('manifest: models must be an object');
  for (const [key, m] of Object.entries(x.models)) {
    if (!Object.hasOwn(KIT_MODELS, key)) throw new Error(`manifest: unknown model "${key}"`);
    if (!isObj(m)) throw new Error(`manifest: ${key} must be an object`);
    if (typeof m.file !== 'string' || !m.file) throw new Error(`manifest: ${key}.file must be a non-empty string`);
    if (typeof m.footprint !== 'string') throw new Error(`manifest: ${key}.footprint must be a string`);
    if (!isObj(m.pads)) throw new Error(`manifest: ${key}.pads must be an object`);
    for (const [pad, p] of Object.entries(m.pads)) {
      if (!isVec(p, 2)) throw new Error(`manifest: ${key}.pads.${pad} must be [x, z] numbers`);
    }
    const box = m.box;
    if (!isObj(box) || !isVec(box.min, 3) || !isVec(box.max, 3)) throw new Error(`manifest: ${key}.box needs min and max as [x, y, z] numbers`);
  }
  return x as unknown as Manifest;
}

export function modelKeyFor(kind: string, style: string | undefined, pins: number, positions?: number): ModelKey | null {
  if (kind === 'dip') return pins === 14 ? 'dip14' : pins === 16 ? 'dip16' : null;
  if (kind === 'dipswitch') return positions === 7 ? 'dipswitch7' : null;
  if (kind === 'sevenseg') return pins === 10 ? 'seg056' : null;
  if (kind === 'lead2') return style === 'LED' ? 'led5' : style === 'R' ? 'r0207' : null;
  return null;
}

/** KiCad's exported metal (pin legs): metallic, or a light, near-grey colour. */
export function isLegMaterial(m: { color: [number, number, number]; metallic?: number }): boolean {
  if ((m.metallic ?? 0) >= 0.5) return true;
  const max = Math.max(...m.color), min = Math.min(...m.color);
  return max >= 0.45 && (max - min) / max <= 0.15;
}

export type Frame = 'identity' | 'flipZ' | 'flipX' | 'rot180';

export function applyFrame(f: Frame, p: [number, number]): [number, number] {
  const [x, z] = p;
  switch (f) {
    case 'identity': return [x, z];
    case 'flipZ': return [x, -z];
    case 'flipX': return [-x, z];
    case 'rot180': return [-x, -z];
  }
}

const FRAMES: Frame[] = ['identity', 'flipZ', 'flipX', 'rot180'];

export function chooseFrame(found: Record<string, [number, number]>, expected: Record<string, [number, number]>, tol = 0.3): Frame {
  for (const f of FRAMES) {
    const ok = Object.entries(expected).every(([pad, e]) => {
      const g = found[pad];
      if (!g) return false;
      const [x, z] = applyFrame(f, g);
      return Math.hypot(x - e[0], z - e[1]) <= tol;
    });
    if (ok) return f;
  }
  throw new Error(`no frame fits the pads: ${Object.keys(expected).join(', ')}`);
}

/** Where a model stands: its offset, its turn about +y and its stretch along its own x and z (on top of the mm scale). */
export interface Placement {
  x: number;
  z: number;
  rotationY: number;
  sx: number;
  sz: number;
}

/**
 * Stand a model on the board. Pads 1 → 2 (`padA` → `padB`) set the turn. With
 * `holes` (every pin's hole, board units), the middle of all the pads lands on
 * the middle of all the holes, and the body is squeezed across its pin rows by
 * how much closer the board draws those rows than the part has them: the
 * drawing narrows the centre channel, so rows e and f are 5.08 mm apart rather
 * than a DIP's 7.62. Without `holes`, pads A and B land on holes A and B.
 */
export function bodyPlacement(
  info: ModelInfo, padA: string, padB: string,
  holeA: [number, number], holeB: [number, number], mm: number,
  holes?: Record<string, [number, number]>,
): Placement {
  const a = info.pads[padA], b = info.pads[padB];
  if (!a || !b) throw new Error(`model ${info.file} has no pad ${!a ? padA : padB}`);
  const angleModel = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const angleBoard = Math.atan2(holeB[1] - holeA[1], holeB[0] - holeA[0]);
  // three.js turns a point about +y by θ: (x cosθ + z sinθ, −x sinθ + z cosθ), so directions turn by −θ.
  const rotationY = angleModel - angleBoard;
  const c = Math.cos(rotationY), s = Math.sin(rotationY);

  const pins = holes ? Object.keys(holes).filter((k) => info.pads[k]) : [];
  if (!pins.includes(padA)) pins.push(padA);
  if (!pins.includes(padB)) pins.push(padB);
  const hole = (k: string): [number, number] => holes?.[k] ?? (k === padA ? holeA : holeB);
  const mean = (ps: [number, number][]): [number, number] => [ps.reduce((t, p) => t + p[0], 0) / ps.length, ps.reduce((t, p) => t + p[1], 0) / ps.length];

  // Across the rows: the model axis square to pad A → pad B, and the board's.
  const spread = (ps: [number, number][], [ux, uz]: [number, number]) => {
    const d = ps.map(([x, z]) => -uz * x + ux * z);
    return Math.max(...d) - Math.min(...d);
  };
  const lenM = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const lenB = Math.hypot(holeB[0] - holeA[0], holeB[1] - holeA[1]) || 1;
  const uM: [number, number] = [(b[0] - a[0]) / lenM, (b[1] - a[1]) / lenM];
  const uB: [number, number] = [(holeB[0] - holeA[0]) / lenB, (holeB[1] - holeA[1]) / lenB];
  const padGap = spread(pins.map((k) => info.pads[k]!), uM) * mm;
  const holeGap = spread(pins.map(hole), uB);
  const k = padGap > 1e-6 && holeGap > 1e-6 ? holeGap / padGap : 1;
  // Only a model whose pin rows run along one of its own axes can be squeezed by its scale.
  const alongZ = Math.abs(uM[0]) < 1e-3, alongX = Math.abs(uM[1]) < 1e-3;
  const sx = alongZ ? k : 1, sz = alongX ? k : 1;

  const [px, pz] = mean(pins.map((k) => info.pads[k]!));
  const [hx, hz] = mean(pins.map(hole));
  const mx = px * sx * mm, mz = pz * sz * mm;
  return { x: hx - (mx * c + mz * s), z: hz - (-mx * s + mz * c), rotationY, sx, sz };
}

// Types shared by the engine, checks, simulator, guide, renderer and client.

import { LED_COLOURS, type LedColour } from '../parts/led.ts';

export type Row = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'T+' | 'T-' | 'B+' | 'B-';

export interface Hole {
  col: number;
  row: Row;
}

export interface Options {
  board: 'auto' | 'half' | 'full';
  railSplit: boolean | null;
  dipSwitchPositions: number;
  packageOrder: string[];
  substitutions: Record<string, string>;
  /** How the flat board draws jumpers: bowed arcs, or square-cornered runs along the corridors between rows. */
  wireStyle: 'arc' | 'orthogonal';
}

export interface Sidecar {
  version: 1;
  options: Options;
  /** ref -> pin number -> hole. Every pin of the footprint must be present. */
  pinned: Record<string, Record<string, Hole>>;
  /** net name -> CSS colour. */
  colors: Record<string, string>;
  /** ref -> pin -> uuids of labels or power symbols this app placed on that pin (editing plan). */
  placed: Record<string, Record<string, string[]>>;
  /**
   * LED reference -> colour, chosen on the board rather than in the schematic.
   * Read by both the renderer and the analog solver, so picking blue also
   * raises that LED's forward voltage and drops its current.
   */
  ledColors: Record<string, LedColour>;
  /**
   * Hand-shaped jumpers. Key: `${net}|${holeA}|${holeB}` with the two holes in
   * MCP naming (`e12`, `T+3`) sorted as strings; see wireKey in
   * src/render/route3d.ts. Absent from sidecars written before phase 2.
   */
  wirePaths: Record<string, WirePath>;
}

/** One bend of a hand-shaped jumper, in grid units rather than SVG units. */
export interface WirePoint {
  /** Column position in pitches; 12.5 sits halfway between columns 12 and 13. */
  col: number;
  /** The corridor it lies in, named by the rows either side ('c|d', 'e|f', 'T-|a'), or 'top' / 'bottom' outside the rails. */
  gap: string;
  /** Signed sub-lane inside that corridor, one per half pitch; 0 is its centre line. */
  lane: number;
}

/** The bends between a jumper's two end holes, listed from the hole whose name sorts first. */
export interface WirePath {
  points: WirePoint[];
}

export const defaultOptions = (): Options => ({ board: 'auto', railSplit: null, dipSwitchPositions: 0, packageOrder: [], substitutions: {}, wireStyle: 'arc' });

export const emptySidecar = (): Sidecar => ({ version: 1, options: defaultOptions(), pinned: {}, colors: {}, placed: {}, ledColors: {}, wirePaths: {} });

const ROWS = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'T+', 'T-', 'B+', 'B-']);

export function isHole(x: unknown): x is Hole {
  return !!x && typeof x === 'object' && Number.isInteger((x as Hole).col) && (x as Hole).col >= 1 && ROWS.has((x as Hole).row);
}

/**
 * A saved wire shape as it came off disk or the wire, or null when it is not
 * one. Only the shape is checked here; whether its corridors exist on the
 * board and whether it clears the chips is the router's business.
 */
export function normalizeWirePath(x: unknown): WirePath | null {
  const pts = (x as { points?: unknown } | null)?.points;
  if (!Array.isArray(pts) || pts.length > 64) return null;
  const out: WirePoint[] = [];
  for (const p of pts) {
    if (!p || typeof p !== 'object') return null;
    const { col, gap, lane } = p as WirePoint;
    if (typeof col !== 'number' || !Number.isFinite(col) || typeof gap !== 'string' || !Number.isInteger(lane) || Math.abs(lane) > 4) return null;
    out.push({ col, gap, lane });
  }
  return { points: out };
}

/** Accept whatever is on disk and return a well-formed sidecar. */
export function normalizeSidecar(x: unknown): Sidecar {
  const s = emptySidecar();
  if (!x || typeof x !== 'object') return s;
  const o = x as Partial<Sidecar>;
  const opt = (o.options ?? {}) as Partial<Options>;
  if (opt.board === 'half' || opt.board === 'full') s.options.board = opt.board;
  if (typeof opt.railSplit === 'boolean') s.options.railSplit = opt.railSplit;
  if (Number.isInteger(opt.dipSwitchPositions) && (opt.dipSwitchPositions as number) >= 0) s.options.dipSwitchPositions = opt.dipSwitchPositions as number;
  if (Array.isArray(opt.packageOrder)) s.options.packageOrder = opt.packageOrder.filter((r) => typeof r === 'string');
  if (opt.wireStyle === 'arc' || opt.wireStyle === 'orthogonal') s.options.wireStyle = opt.wireStyle;
  if (opt.substitutions && typeof opt.substitutions === 'object') for (const [k, v] of Object.entries(opt.substitutions)) if (typeof v === 'string') s.options.substitutions[k] = v;
  if (o.pinned && typeof o.pinned === 'object') {
    for (const [ref, pins] of Object.entries(o.pinned)) {
      if (!pins || typeof pins !== 'object') continue;
      const clean: Record<string, Hole> = {};
      for (const [pin, h] of Object.entries(pins as Record<string, unknown>)) if (isHole(h)) clean[pin] = { col: h.col, row: h.row };
      if (Object.keys(clean).length) s.pinned[ref] = clean;
    }
  }
  if (o.colors && typeof o.colors === 'object') for (const [k, v] of Object.entries(o.colors)) if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) s.colors[k] = v;
  if (o.placed && typeof o.placed === 'object') {
    for (const [ref, pins] of Object.entries(o.placed)) {
      if (!pins || typeof pins !== 'object') continue;
      const clean: Record<string, string[]> = {};
      for (const [pin, ids] of Object.entries(pins as Record<string, unknown>)) if (Array.isArray(ids)) clean[pin] = ids.filter((i) => typeof i === 'string');
      s.placed[ref] = clean;
    }
  }
  if (o.ledColors && typeof o.ledColors === 'object') {
    for (const [ref, c] of Object.entries(o.ledColors)) if (typeof c === 'string' && (LED_COLOURS as readonly string[]).includes(c)) s.ledColors[ref] = c as LedColour;
  }
  if (o.wirePaths && typeof o.wirePaths === 'object') {
    for (const [key, path] of Object.entries(o.wirePaths).slice(0, 1024)) {
      const clean = normalizeWirePath(path);
      if (clean) s.wirePaths[key] = clean;
    }
  }
  return s;
}

export interface BoardSpec {
  cols: number;
  kind: 'half' | 'full';
  splitCol: number | null;
  railGapEvery: number;
}

export interface SupplyLead {
  net: string;
  hole: Hole;
  label: string;
}

export interface Supply {
  leads: SupplyLead[];
}

export interface Package {
  id: string;
  kind: 'dip' | 'dipswitch' | 'sevenseg' | 'module';
  name: string;
  col0: number;
  pins: number;
  positions?: number;
  /** dipswitch: position number -> switch ref. */
  map?: Record<string, string>;
  common?: 'cathode' | 'anode';
  /** module: the strip row its header sits in (a or j); the body hangs outward from it. */
  row?: Row;
  /** dip: turned end for end, notch and pin 1 at the right. Absent, never false, so unflipped docs are unchanged. */
  flipped?: true;
}

export interface PlacedPart {
  id: string;
  kind: 'lead2' | 'to92' | 'pot3';
  style: string;
  value: string;
  holes: Hole[];
  pins: string[];
  nets: string[];
  polarized: boolean;
  /** One label per hole, e.g. ["K", "A"] for an LED or ["E", "B", "C"] for a transistor. */
  labels: string[];
}

export interface Wire {
  net: string;
  a: Hole;
  b: Hole;
  role: 'power' | 'signal' | 'bridge' | 'split';
}

export interface NetInfo {
  name: string;
  color: string;
  power: '+' | '-' | 'gnd' | null;
}

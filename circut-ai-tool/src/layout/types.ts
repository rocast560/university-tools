// Types shared by the engine, checks, simulator, guide, renderer and client.

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
}

export const defaultOptions = (): Options => ({ board: 'auto', railSplit: null, dipSwitchPositions: 0, packageOrder: [], substitutions: {} });

export const emptySidecar = (): Sidecar => ({ version: 1, options: defaultOptions(), pinned: {}, colors: {}, placed: {} });

const ROWS = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'T+', 'T-', 'B+', 'B-']);

export function isHole(x: unknown): x is Hole {
  return !!x && typeof x === 'object' && Number.isInteger((x as Hole).col) && (x as Hole).col >= 1 && ROWS.has((x as Hole).row);
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
  kind: 'dip' | 'dipswitch' | 'sevenseg';
  name: string;
  col0: number;
  pins: number;
  positions?: number;
  /** dipswitch: position number -> switch ref. */
  map?: Record<string, string>;
  common?: 'cathode' | 'anode';
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

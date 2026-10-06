// Deterministic breadboard placement and routing.
//
// Order: size the board, claim pinned holes, place packages across the
// gutter, supply leads, three-lead parts, two-lead parts anchored to nets that
// already have a home strip, power jumpers to the rails, signal jumpers strip
// to strip, rail bridges. Every hole has one owner. Problems never throw out
// of layout(): they land in `error`, `unplaced` and `warnings`.

import type { ResistorKind } from '../parts/resistor.ts';
import type { Component, Design, DesignPin } from '../netlist.ts';
import { displayName, isUnconnected } from '../netlist.ts';
import { classify, powerKind, type Footprint, type PowerKind } from '../parts/catalog.ts';
import type { LedColour } from '../parts/led.ts';
import { compareRefs } from '../parts/values.ts';
import { L3_BOARD, l3CoveredCols } from '../parts/lab3.ts';
import { BOT_ROWS, Board, LayoutError, MID_ROWS, Occupancy, PART_ROWS, RAILS, TOP_ROWS, WIRE_ROWS, hole, isRail, stripCol, stripHalf, stripOf } from './board.ts';
import type { BoardSpec, Hole, NetInfo, Options, Package, PlacedPart, Row, Sidecar, Supply, Wire } from './types.ts';

export { LayoutError };

/** Signal jumper colours: the lab kit has red, black, blue, green, orange, yellow and white wires; red is +5V and black is ground, so signals cycle through the rest. */
export const PALETTE = ['#1F6FE0', '#2E9E4F', '#F26B1D', '#E3B505', '#F4F4F0'];
export const COLOR_PLUS = '#D7263D';
export const COLOR_GND = '#1E1E1E';
export const COLOR_MINUS = '#1F6FE0';

export interface EngineResult {
  board: BoardSpec;
  supply: Supply | null;
  packages: Package[];
  parts: PlacedPart[];
  wires: Wire[];
  nets: Record<string, NetInfo>;
  pinHoles: Record<string, Record<string, Hole>>;
  unplaced: { ref: string; reason: string }[];
  warnings: string[];
  footprints: Record<string, Footprint>;
  values: Record<string, string>;
  power: { plus: string[]; minus: string[]; gnd: string[]; plusName: string; gndName: string; secondName: string | null };
  /** LED reference -> the colour chosen on the board, when one was. */
  ledColors: Record<string, LedColour>;
  /** Tan carbon film or blue metal film. Optional so results saved before it existed still load. */
  resistorKind?: ResistorKind;
  error: string | null;
}

/** The pins a footprint puts in holes, in the order the layout numbers them. */
export function footprintPins(fp: Footprint, comp: Component): string[] {
  switch (fp.kind) {
    case 'module':
    case 'dip':
    case 'sevenseg':
      return [...comp.pins.keys()].filter((p) => /^\d+$/.test(p)).sort((a, b) => Number(a) - Number(b));
    case 'lead2':
      return [fp.a, fp.b];
    case 'to92':
    case 'pot3':
      return [...fp.legs];
    case 'dipswitch':
      return fp.pairs.flat();
    default:
      return [];
  }
}

type Half = 'T' | 'B';

/** Rows under a single-digit display's 19 mm body when it straddles the gutter. */
const SEVENSEG_BODY_ROWS: Row[] = ['c', 'd', 'e', 'f', 'g', 'h'];

/** Columns a two-lead part's body may run along a row: a quarter-watt resistor with bent leads reaches about 0.6 inch. */
const MAX_LEAD_SPAN = 6;

interface TwoLeadPlan {
  x: DesignPin;
  y: DesignPin;
  strip: string;
  row: Row;
  hb: { kind: 'rail' } | { kind: 'near'; strip: string } | { kind: 'col'; col: number };
  cost: number;
}
const pinKey = (ref: string, pin: string) => `${ref} ${pin}`;
const uniq = <T,>(xs: T[]): T[] => [...new Set(xs)];

export function layout(design: Design, sidecar: Sidecar): EngineResult {
  const first = new Engine(design, sidecar, null).build();
  const outOfRoom = first.error !== null || first.unplaced.some((u) => /no room|no free/.test(u.reason));
  if (sidecar.options.board === 'auto' && first.board.kind === 'half' && outOfRoom) {
    const second = new Engine(design, sidecar, 'full').build();
    if (!second.error && second.unplaced.length <= first.unplaced.length) return second;
  }
  return first;
}

class Engine {
  private opt: Options;
  private occ = new Occupancy();
  private fp = new Map<string, Footprint>();
  private values = new Map<string, string>();
  private plus: string[] = [];
  private minus: string[] = [];
  private gnd: string[] = [];
  private plusName = '+5V';
  private gndName = 'GND';
  private secondName: string | null = null;
  private packages: Package[] = [];
  private parts: PlacedPart[] = [];
  private wires: Wire[] = [];
  private pinHole = new Map<string, Hole>();
  private homes = new Map<string, string[]>();
  private pkgCols = new Set<number>();
  /** Column runs already taken by a two-lead body lying along a strip row, so no two bodies overlap in one row. */
  private spans: { row: Row; c1: number; c2: number }[] = [];
  private dipMap = new Map<string, number>();
  private board: Board | null = null;
  private supply: Supply | null = null;
  private unplaced: { ref: string; reason: string }[] = [];
  private warnings: string[] = [];

  constructor(
    private d: Design,
    private sidecar: Sidecar,
    private forceBoard: 'half' | 'full' | 'double' | 'stacked' | null,
  ) {
    this.opt = sidecar.options;
    for (const [ref, comp] of d.components) {
      const value = this.opt.substitutions[ref] ?? comp.value;
      this.values.set(ref, value);
      this.fp.set(ref, classify({ ...comp, value }));
    }
    for (const net of d.nets.keys()) {
      const k = powerKind(net);
      if (k === '+') this.plus.push(net);
      else if (k === '-') this.minus.push(net);
      else if (k === 'gnd') this.gnd.push(net);
    }
    this.plus.sort();
    this.minus.sort();
    this.gnd.sort();
    if (this.plus.length) this.plusName = this.plus[0];
    if (this.gnd.length) this.gndName = this.gnd[0];
  }

  // ---------- nets and rails ----------

  private power(net: string): PowerKind {
    return this.plus.includes(net) ? '+' : this.minus.includes(net) ? '-' : this.gnd.includes(net) ? 'gnd' : null;
  }

  /** Rail a net uses when reached from a given half; null for signal nets. */
  private railFor(net: string, half: Half): Row | null {
    const k = this.power(net);
    if (k === 'gnd') return `${half}-` as Row;
    if (net === this.plusName) return this.secondName ? 'T+' : (`${half}+` as Row);
    if (net === this.secondName) return 'B+';
    return k ? 'T+' : null;
  }

  private railNet(rail: Row): string | null {
    if (rail === 'T-' || rail === 'B-') return this.gnd.length ? this.gndName : null;
    if (rail === 'T+') return this.plus.length ? this.plusName : null;
    return this.secondName ?? (this.plus.length ? this.plusName : null);
  }

  private addHome(net: string, strip: string) {
    if (isUnconnected(net)) return;
    const list = this.homes.get(net) ?? [];
    if (!list.includes(strip)) list.push(strip);
    this.homes.set(net, list);
  }

  private claimPin(ref: string, pin: string, h: Hole, net: string | undefined) {
    this.occ.claim(h, ref);
    this.pinHole.set(pinKey(ref, pin), h);
    if (net) this.addHome(net, stripOf(h));
  }

  private pinsOf(ref: string): string[] {
    return footprintPins(this.fp.get(ref)!, this.d.components.get(ref)!);
  }

  private packageWidth(fp: Footprint): number {
    return fp.kind === 'module' ? fp.pins : fp.kind === 'dip' ? fp.pins / 2 : fp.kind === 'dipswitch' ? fp.positions : fp.kind === 'sevenseg' ? fp.pins / 2 : 0;
  }

  private isPackage(fp: Footprint): boolean {
    return fp.kind === 'module' || fp.kind === 'dip' || fp.kind === 'dipswitch' || fp.kind === 'sevenseg';
  }

  private packageRefs(): string[] {
    const refs = [...this.fp.entries()].filter(([, f]) => this.isPackage(f)).map(([r]) => r);
    const ordered = this.opt.packageOrder.filter((r) => refs.includes(r));
    // The L3 board goes last: it is placed from the right end, where the
    // rails its body covers are the ones nothing else wanted.
    const rank = (r: string) => ({ dipswitch: 0, dip: 1, sevenseg: 2, module: 3 })[this.fp.get(r)!.kind as 'dipswitch' | 'dip' | 'sevenseg' | 'module'];
    const rest = refs.filter((r) => !ordered.includes(r)).sort((a, b) => rank(a) - rank(b) || compareRefs(a, b));
    return [...ordered, ...rest];
  }

  private foldedSwitches(): string[] {
    if (!this.opt.dipSwitchPositions) return [];
    return [...this.fp.entries()]
      .filter(([r, f]) => f.kind === 'lead2' && f.style === 'SW' && !this.sidecar.pinned[r])
      .map(([r]) => r)
      .sort(compareRefs);
  }

  // ---------- board ----------

  private sizeBoard() {
    const extra = [...this.plus.slice(1), ...this.minus];
    if (extra.length > 1) throw new LayoutError(`more than two non-ground supplies: ${[...this.plus, ...this.minus].map(displayName).join(', ')}. A breadboard has two rail pairs.`);
    this.secondName = extra[0] ?? null;
    let need = 3;
    const folded = this.foldedSwitches();
    if (folded.length) need += Math.max(this.opt.dipSwitchPositions, folded.length) + 2;
    for (const ref of this.packageRefs()) if (!this.sidecar.pinned[ref]) need += this.packageWidth(this.fp.get(ref)!) + 2;
    let maxPinned = 0;
    for (const holes of Object.values(this.sidecar.pinned)) for (const h of Object.values(holes)) maxPinned = Math.max(maxPinned, h.col);
    need = Math.max(need, maxPinned + 3);
    const kind = this.forceBoard ?? (this.opt.board !== 'auto' ? this.opt.board : need <= 30 ? 'half' : need <= 63 ? 'full' : 'double');
    const cols = kind === 'half' ? 30 : kind === 'full' ? 63 : 126;
    const tiers = kind === 'stacked' ? 2 : 1;
    if (need > cols) throw new LayoutError(`the packages need about ${need} columns; a ${kind}-size board has ${cols}. Switch the board option to ${kind === 'half' ? 'full' : 'double or stacked'} or unpin parts.`);
    const split = this.opt.railSplit ?? kind !== 'half';
    this.board = new Board(cols, kind, split ? (cols === 126 ? 63 : 30) : null, 6, tiers);
  }

  private get b(): Board {
    if (!this.board) throw new LayoutError('board not sized');
    return this.board;
  }

  // ---------- registration ----------

  private registerPlaced(ref: string, fp: Footprint, comp: Component, holes: Record<string, Hole>) {
    const value = this.values.get(ref) ?? comp.value;
    const netOf = (p: string) => comp.pins.get(p)?.net ?? '';
    const col0 = Math.min(...Object.values(holes).map((h) => h.col));
    const addCols = (w: number) => {
      for (let c = col0; c < col0 + w; c++) this.pkgCols.add(c);
    };
    switch (fp.kind) {
      case 'module': {
        const row = holes['1']?.row ?? 'a';
        this.packages.push({ id: ref, kind: 'module', name: value, col0, pins: fp.pins, row });
        addCols(fp.pins);
        // The body hangs outward over the supply rails on its side of the
        // board, so nothing else may land in the rail holes it covers.
        for (const h of this.moduleBodyHoles(col0, row)) {
          if (this.occ.isFree(h)) this.occ.claim(h, `${ref} body`);
          else this.warnings.push(`${ref}: the L3 board covers hole ${h.row}${h.col}, which ${this.occ.owner(h)} is using`);
        }
        break;
      }
      case 'dip':
        // Pin 1 lives bottom-left (row f) when the placer puts a chip down;
        // pinned by hand with pin 1 in row e, it has been turned end for end.
        this.packages.push({ id: ref, kind: 'dip', name: value, col0, pins: fp.pins, ...(holes['1']?.row === 'e' ? { flipped: true as const } : {}) });
        addCols(fp.pins / 2);
        break;
      case 'sevenseg': {
        this.packages.push({ id: ref, kind: 'sevenseg', name: value, col0, pins: fp.pins, common: fp.common });
        addCols(fp.pins / 2);
        // The body covers rows c to h of its columns; only the pin holes
        // themselves are usable there.
        const pinHoles = new Set(Object.values(holes).map((h) => `${h.row}${h.col}`));
        for (let c = col0; c < col0 + fp.pins / 2; c++) {
          for (const r of SEVENSEG_BODY_ROWS) {
            const h = hole(c, r);
            if (pinHoles.has(`${r}${c}`)) continue;
            if (this.occ.isFree(h)) this.occ.claim(h, `${ref} body`);
            else this.warnings.push(`${ref}: the display's body covers hole ${r}${c}, which ${this.occ.owner(h)} is using`);
          }
        }
        break;
      }
      case 'dipswitch':
        this.packages.push({ id: ref, kind: 'dipswitch', name: value, col0, pins: fp.positions * 2, positions: fp.positions, map: Object.fromEntries(fp.pairs.map((_, i) => [String(i + 1), ref])) });
        addCols(fp.positions);
        break;
      case 'lead2': {
        const [ha, hb] = [holes[fp.a], holes[fp.b]];
        if (ha.row === hb.row && !isRail(ha.row)) this.spans.push({ row: ha.row, c1: Math.min(ha.col, hb.col), c2: Math.max(ha.col, hb.col) });
        this.parts.push({ id: ref, kind: 'lead2', style: fp.style, value, holes: [ha, hb], pins: [fp.a, fp.b], nets: [netOf(fp.a), netOf(fp.b)], polarized: fp.polarized, labels: [fp.aLabel, fp.bLabel] });
        break;
      }
      case 'to92':
        this.parts.push({ id: ref, kind: 'to92', style: fp.names.join(''), value, holes: fp.legs.map((p) => holes[p]), pins: [...fp.legs], nets: fp.legs.map(netOf), polarized: false, labels: [...fp.names] });
        break;
      case 'pot3':
        this.parts.push({ id: ref, kind: 'pot3', style: 'POT', value, holes: fp.legs.map((p) => holes[p]), pins: [...fp.legs], nets: fp.legs.map(netOf), polarized: false, labels: ['1', 'W', '3'] });
        break;
      default:
        break;
    }
  }

  // ---------- pinned ----------

  private placePinned() {
    for (const [ref, holes] of Object.entries(this.sidecar.pinned)) {
      const comp = this.d.components.get(ref);
      const fp = this.fp.get(ref);
      if (!comp || !fp || (!this.isPackage(fp) && fp.kind !== 'lead2' && fp.kind !== 'to92' && fp.kind !== 'pot3')) {
        this.warnings.push(`pinned placement for ${ref} dropped: not a placeable part of this schematic`);
        continue;
      }
      const pins = this.pinsOf(ref);
      const missing = pins.filter((p) => !holes[p]);
      if (missing.length) {
        this.warnings.push(`pinned placement for ${ref} dropped: pins changed (${missing.join(', ')} missing)`);
        continue;
      }
      const bad = pins.map((p) => holes[p]).find((h) => !this.b.inBounds(h) || !this.occ.isFree(h));
      if (bad) {
        this.warnings.push(`pinned placement for ${ref} dropped: hole ${bad.row}${bad.col} is off the board or already taken`);
        continue;
      }
      if (fp.kind === 'module') {
        const row = holes[pins[0]].row;
        const col0 = holes[pins[0]].col;
        const shape = pins.every((p, i) => holes[p].row === row && holes[p].col === col0 + i);
        if (!shape || (row !== 'a' && row !== 'j')) {
          this.warnings.push(`pinned placement for ${ref} dropped: the L3 board's header is one row of ${fp.pins} consecutive columns in row a or row j, with the body hanging off that edge of the breadboard`);
          continue;
        }
      }
      const clean: Record<string, Hole> = {};
      for (const p of pins) {
        clean[p] = { col: holes[p].col, row: holes[p].row };
        // A rail-row hole (e.g. one leg of a power-net-connected two-lead part)
        // isn't a normal strip: stripOf() would return the rail name itself
        // (e.g. "T+") and stripCol() on that yields NaN, poisoning downstream
        // routing (pickStrip/routePower). The auto-placer's own rail leg in
        // tryPlaceTwoLead never registers a strip home for it either — mirror
        // that here by skipping addHome for rail-row pins.
        this.claimPin(ref, p, clean[p], isRail(clean[p].row) ? undefined : comp.pins.get(p)?.net);
      }
      this.registerPlaced(ref, fp, comp, clean);
    }
  }

  private isPlaced(ref: string): boolean {
    const pins = this.pinsOf(ref);
    return pins.length > 0 && this.pinHole.has(pinKey(ref, pins[0]));
  }

  // ---------- packages ----------

  private spanFree(col: number, width: number): boolean {
    if (col < 1 || col + width - 1 > this.b.cols || !this.b.sameTier(col, col + width - 1)) return false;
    for (let c = col - 2; c <= col + width + 1; c++) if (this.pkgCols.has(c)) return false;
    for (let c = col; c < col + width; c++) if (!this.occ.isFree(hole(c, 'e')) || !this.occ.isFree(hole(c, 'f'))) return false;
    return true;
  }

  private findPackageColumn(width: number, owner: string): number {
    for (let col = 3; col + width - 1 <= this.b.cols - 2; col++) if (this.spanFree(col, width)) return col;
    throw new LayoutError(`no room for ${owner} (${width} columns) on a ${this.b.kind}-size board`);
  }

  /** Rail holes under the L3 board's body when its pin 1 is in `col0` of an outer row. */
  private moduleBodyHoles(col0: number, row: Row): Hole[] {
    const rails: Row[] = row === 'j' ? ['B+', 'B-'] : ['T+', 'T-'];
    const out: Hole[] = [];
    for (const c of l3CoveredCols(col0)) {
      if (this.b.railExists(c)) for (const r of rails) out.push(hole(c, r));
      // The board's end margins also cover the header row past the end pins.
      if ((c < col0 || c >= col0 + L3_BOARD.pins) && c >= 1 && c <= this.b.cols) out.push(hole(c, row));
    }
    return out;
  }

  /**
   * A column for the L3 board: its header takes row a of `pins` consecutive
   * columns, kept clear of other packages like any chip, and the rail holes
   * under its body must still be free. Searched from the right end of the
   * board inward, so the body covers the rails past the last package rather
   * than the ones every supply jumper and bridge is competing for.
   */
  private findModuleColumn(pins: number, owner: string): number {
    for (let col = this.b.cols - 2 - pins + 1; col >= 3; col--) {
      let ok = this.b.sameTier(col - L3_BOARD.endMargin, col + pins - 1 + L3_BOARD.endMargin);
      for (let c = col - 2; c <= col + pins + 1 && ok; c++) if (this.pkgCols.has(c)) ok = false;
      for (let c = col; c < col + pins && ok; c++) if (!this.occ.isFree(hole(c, 'a'))) ok = false;
      for (const h of this.moduleBodyHoles(col, 'a')) if (!this.occ.isFree(h)) ok = false;
      if (ok) return col;
    }
    throw new LayoutError(`no room for ${owner} (the L3 board needs ${pins} header columns in row a plus ${L3_BOARD.endMargin} columns of rail on each side) on a ${this.b.kind}-size board`);
  }

  private placePackages() {
    const folded = this.foldedSwitches();
    if (folded.length) {
      const npos = Math.max(this.opt.dipSwitchPositions, folded.length);
      const col0 = this.findPackageColumn(npos, 'the DIP switch');
      const pkg: Package = { id: 'SW', kind: 'dipswitch', name: `${npos}-position DIP switch`, col0, pins: npos * 2, positions: npos, map: {} };
      folded.forEach((ref, i) => {
        const comp = this.d.components.get(ref)!;
        const fp = this.fp.get(ref) as Extract<Footprint, { kind: 'lead2' }>;
        const pa = comp.pins.get(fp.a)!;
        const pb = comp.pins.get(fp.b)!;
        const [top, bottom] = this.power(pb.net) === 'gnd' ? [pa, pb] : this.power(pa.net) === 'gnd' ? [pb, pa] : [pa, pb];
        this.claimPin(ref, top.num, hole(col0 + i, 'e'), top.net);
        this.claimPin(ref, bottom.num, hole(col0 + i, 'f'), bottom.net);
        pkg.map![String(i + 1)] = ref;
        this.dipMap.set(ref, i + 1);
      });
      for (let i = folded.length; i < npos; i++) {
        this.occ.claim(hole(col0 + i, 'e'), 'SW');
        this.occ.claim(hole(col0 + i, 'f'), 'SW');
      }
      for (let c = col0; c < col0 + npos; c++) this.pkgCols.add(c);
      this.packages.push(pkg);
    }
    for (const ref of this.packageRefs()) {
      if (this.isPlaced(ref)) continue;
      const fp = this.fp.get(ref)!;
      const comp = this.d.components.get(ref)!;
      const width = this.packageWidth(fp);
      let col0: number;
      try {
        col0 = fp.kind === 'module' ? this.findModuleColumn(fp.pins, ref) : this.findPackageColumn(width, ref);
      } catch (e) {
        this.unplaced.push({ ref, reason: (e as Error).message });
        continue;
      }
      const holes: Record<string, Hole> = {};
      if (fp.kind === 'module') {
        for (const p of this.pinsOf(ref)) holes[p] = hole(col0 + Number(p) - 1, 'a');
      } else if (fp.kind === 'dip' || fp.kind === 'sevenseg') {
        // A DIP straddles the gutter with its rows in e and f. A single-digit
        // display's pin rows are about 0.6 inch apart and its 19 mm body
        // reaches from row c to row h, so its pins go in d and g and the rows
        // between are covered; its jumpers land in a, b, i and j.
        const n = fp.pins;
        const half = n / 2;
        const [bottom, top]: [Row, Row] = fp.kind === 'sevenseg' ? ['g', 'd'] : ['f', 'e'];
        for (const p of this.pinsOf(ref)) {
          const k = Number(p);
          holes[p] = k <= half ? hole(col0 + k - 1, bottom) : hole(col0 + (n - k), top);
        }
      } else if (fp.kind === 'dipswitch') {
        fp.pairs.forEach(([t, bt], i) => {
          holes[t] = hole(col0 + i, 'f');
          holes[bt] = hole(col0 + i, 'e');
        });
      }
      for (const [p, h] of Object.entries(holes)) this.claimPin(ref, p, h, comp.pins.get(p)?.net);
      this.registerPlaced(ref, fp, comp, holes);
    }
  }

  // ---------- holes ----------

  private freeRows(strip: string, order: Record<Half, Row[]>): Row[] {
    const half = stripHalf(strip);
    const col = stripCol(strip);
    return order[half].filter((r) => this.occ.isFree(hole(col, r)));
  }

  private take(strip: string, order: Record<Half, Row[]>, owner: string, preferRow?: Row): Hole {
    let rows = this.freeRows(strip, order);
    if (preferRow && rows.includes(preferRow)) rows = [preferRow, ...rows.filter((r) => r !== preferRow)];
    if (!rows.length) throw new LayoutError(`no free hole in strip ${strip} for ${owner}`);
    return this.occ.claim(hole(stripCol(strip), rows[0]), owner);
  }

  private railHole(rail: Row, nearCol: number, owner: string, step: -1 | 1 | null = null): Hole {
    const split = this.b.splitCol;
    let cands = Array.from({ length: this.b.cols }, (_, i) => i + 1).sort((x, y) => Math.abs(x - nearCol) - Math.abs(y - nearCol) || x - y);
    if (step !== null) cands = cands.filter((c) => (c - nearCol) * step >= 0);
    else if (split) cands = cands.filter((c) => (c <= split) === (nearCol <= split));
    for (const c of cands) if (this.b.railExists(c) && this.occ.isFree(hole(c, rail))) return this.occ.claim(hole(c, rail), owner);
    throw new LayoutError(`no free ${rail} rail hole near column ${nearCol} for ${owner}`);
  }

  /** True when no two-lead body already lies along `row` anywhere in columns c1..c2. */
  private spanClear(row: Row, c1: number, c2: number): boolean {
    const lo = Math.min(c1, c2);
    const hi = Math.max(c1, c2);
    return !this.spans.some((sp) => sp.row === row && lo <= sp.c2 && sp.c1 <= hi);
  }

  private freeBlock(half: Half, near: number, width: number, owner: string, extra: (c: number) => boolean = () => true): number {
    const rows = half === 'T' ? TOP_ROWS : BOT_ROWS;
    const ok = (c: number) => c >= 1 && c + width - 1 <= this.b.cols && this.b.sameTier(c, c + width - 1) && extra(c) && Array.from({ length: width }, (_, i) => c + i).every((cc) => !this.pkgCols.has(cc) && rows.every((r) => this.occ.isFree(hole(cc, r))));
    const dists = [2, 3, 1, ...Array.from({ length: this.b.cols }, (_, i) => i + 4)];
    for (const dist of dists) for (const c of [near + dist, near - dist - width + 1]) if (ok(c)) return c;
    if (ok(near)) return near;
    throw new LayoutError(`no free block of ${width} column${width > 1 ? 's' : ''} near column ${near} for ${owner}`);
  }

  private pickStrip(net: string): string {
    const strips = uniq(this.homes.get(net) ?? []).sort((a, b) => stripCol(a) - stripCol(b));
    let best = strips[0];
    let bestScore = -1;
    for (const s of strips) {
      const score = this.freeRows(s, PART_ROWS).length;
      if (score > bestScore) {
        best = s;
        bestScore = score;
      }
    }
    if (bestScore <= 0) throw new LayoutError(`no free hole on net ${displayName(net)}`);
    return best;
  }

  // ---------- supply ----------

  private placeSupply() {
    if (!this.plus.length && !this.minus.length) {
      this.warnings.push('no supply net found (add a +5V or similar power symbol); the rails stay empty');
      return;
    }
    if (!this.gnd.length) this.warnings.push('no GND net found; the ground rails stay empty');
    const leads: Supply['leads'] = [];
    if (this.plus.length) leads.push({ net: this.plusName, hole: this.railHole('T+', 1, 'supply +'), label: `${displayName(this.plusName)} lead` });
    if (this.gnd.length) leads.push({ net: this.gndName, hole: this.railHole('T-', 2, 'supply GND'), label: `${displayName(this.gndName)} lead` });
    if (this.secondName) leads.push({ net: this.secondName, hole: this.railHole('B+', 1, 'supply 2'), label: `${displayName(this.secondName)} lead` });
    this.supply = { leads };
  }

  // ---------- three-lead parts ----------

  private placeThreeLead() {
    const refs = [...this.fp.entries()].filter(([r, f]) => (f.kind === 'to92' || f.kind === 'pot3') && !this.isPlaced(r)).map(([r]) => r).sort(compareRefs);
    for (const ref of refs) {
      const fp = this.fp.get(ref) as Extract<Footprint, { kind: 'to92' | 'pot3' }>;
      const comp = this.d.components.get(ref)!;
      let near = this.packages[0]?.col0 ?? 3;
      let half: Half = 'T';
      for (const p of fp.legs) {
        const net = comp.pins.get(p)?.net ?? '';
        const hs = this.homes.get(net);
        if (hs?.length && !this.power(net)) {
          near = stripCol(hs[0]);
          half = stripHalf(hs[0]);
          break;
        }
      }
      try {
        const col = this.freeBlock(half, near, 3, ref);
        const row: Row = half === 'T' ? 'c' : 'h';
        const holes: Record<string, Hole> = {};
        fp.legs.forEach((p, i) => {
          holes[p] = hole(col + i, row);
        });
        for (const [p, h] of Object.entries(holes)) this.claimPin(ref, p, h, comp.pins.get(p)?.net);
        this.registerPlaced(ref, fp, comp, holes);
      } catch (e) {
        if (!(e instanceof LayoutError)) throw e;
        this.unplaced.push({ ref, reason: e.message });
      }
    }
  }

  // ---------- two-lead parts ----------

  private placeTwoLead() {
    const pending = [...this.fp.entries()]
      .filter(([r, f]) => f.kind === 'lead2' && !this.dipMap.has(r) && !this.isPlaced(r))
      .map(([r]) => r)
      .sort(compareRefs);
    const drop = (ref: string) => pending.splice(pending.indexOf(ref), 1);
    let progress = true;
    while (pending.length && progress) {
      progress = false;
      for (const ref of [...pending]) {
        try {
          if (this.tryPlaceTwoLead(ref, false)) {
            drop(ref);
            progress = true;
          }
        } catch (e) {
          if (!(e instanceof LayoutError)) throw e;
          this.unplaced.push({ ref, reason: e.message });
          drop(ref);
          progress = true;
        }
      }
    }
    for (const ref of [...pending]) {
      try {
        this.tryPlaceTwoLead(ref, true);
      } catch (e) {
        if (!(e instanceof LayoutError)) throw e;
        this.unplaced.push({ ref, reason: e.message });
      }
    }
  }

  /**
   * Where a two-lead part could go if it started at `x`'s net: the strip and
   * row for that lead, where the other lead lands, and a cost that grows with
   * the body's run and jumps when the start hole already sits inside another
   * body or the run has to cross one. Nothing is claimed here.
   */
  private planTwoLead(ref: string, x: DesignPin, y: DesignPin, isSwitch: boolean): TwoLeadPlan | null {
    if (this.power(x.net) || isUnconnected(x.net) || !this.homes.get(x.net)?.length) return null;
    const toRail = !!this.power(y.net) && !isSwitch && !!this.railFor(y.net, 'T');
    let strip: string;
    try {
      strip = this.pickStrip(x.net);
    } catch (e) {
      if (!(e instanceof LayoutError)) throw e;
      return null;
    }
    const col = stripCol(strip);
    const half = stripHalf(strip);
    const order = toRail ? PART_ROWS : MID_ROWS;
    const rows = this.freeRows(strip, order);
    if (!rows.length) return null;
    const row = rows.find((r) => this.spanClear(r, col, col)) ?? rows[0];
    const base = this.spanClear(row, col, col) ? 0 : 50;
    if (toRail) return { x, y, strip, row, hb: { kind: 'rail' }, cost: base };
    const near = (this.homes.get(y.net) ?? [])
      .filter((s) => stripHalf(s) === half && stripCol(s) !== col && Math.abs(stripCol(s) - col) <= 2 && this.b.sameTier(stripCol(s), col))
      .sort((a, b) => Math.abs(stripCol(a) - col) - Math.abs(stripCol(b) - col));
    if (near.length && this.freeRows(near[0], MID_ROWS).length) return { x, y, strip, row, hb: { kind: 'near', strip: near[0] }, cost: base + Math.abs(stripCol(near[0]) - col) };
    // The body lies along the row from the start hole to the new column, so
    // that run must not cross another body in the row, and it should be no
    // longer than a part's leads comfortably reach.
    try {
      const c = this.freeBlock(half, col, 1, ref, (cc) => this.spanClear(row, col, cc) && Math.abs(cc - col) <= MAX_LEAD_SPAN && this.b.sameTier(col, cc));
      return { x, y, strip, row, hb: { kind: 'col', col: c }, cost: base + Math.abs(c - col) };
    } catch (e) {
      if (!(e instanceof LayoutError)) throw e;
    }
    try {
      const c = this.freeBlock(half, col, 1, ref, (cc) => this.b.sameTier(col, cc));
      return { x, y, strip, row, hb: { kind: 'col', col: c }, cost: 100 + base + Math.abs(c - col) };
    } catch (e) {
      if (!(e instanceof LayoutError)) throw e;
      return null;
    }
  }

  private tryPlaceTwoLead(ref: string, force: boolean): boolean {
    const fp = this.fp.get(ref) as Extract<Footprint, { kind: 'lead2' }>;
    const comp = this.d.components.get(ref)!;
    const pa0 = comp.pins.get(fp.a);
    const pb0 = comp.pins.get(fp.b);
    if (!pa0 || !pb0) throw new LayoutError(`${ref} is missing pin ${!pa0 ? fp.a : fp.b} in the netlist`);
    const isSwitch = fp.style === 'SW' || fp.style === 'BTN';
    // Either lead may be the one that starts on a net that already has a
    // home; take whichever gives the shorter, cleaner body.
    const plans = [this.planTwoLead(ref, pa0, pb0, isSwitch), this.planTwoLead(ref, pb0, pa0, isSwitch)].filter((p): p is TwoLeadPlan => !!p).sort((a, b) => a.cost - b.cost);
    let ha: Hole;
    let hb: Hole;
    let pa: DesignPin;
    let pb: DesignPin;
    if (plans.length) {
      const plan = plans[0];
      pa = plan.x;
      pb = plan.y;
      const toRail = plan.hb.kind === 'rail';
      ha = this.take(plan.strip, toRail ? PART_ROWS : MID_ROWS, ref, plan.row);
      const half = stripHalf(stripOf(ha));
      if (plan.hb.kind === 'rail') hb = this.railHole(this.railFor(pb.net, half)!, ha.col, ref);
      else if (plan.hb.kind === 'near') hb = this.take(plan.hb.strip, MID_ROWS, ref, ha.row);
      else {
        hb = this.occ.claim(hole(plan.hb.col, ha.row), ref);
        this.addHome(pb.net, `${half}${plan.hb.col}`);
        if (Math.abs(plan.hb.col - ha.col) > MAX_LEAD_SPAN) this.warnings.push(`${ref} spans ${Math.abs(plan.hb.col - ha.col)} columns from ${ha.row}${ha.col} to ${hb.row}${hb.col}; a part's leads reach about ${MAX_LEAD_SPAN}, so bend them or pin it closer`);
      }
    } else {
      if (this.power(pa0.net) && this.power(pb0.net)) [pa, pb] = [pa0, pb0];
      else if (force) [pa, pb] = [pa0, pb0];
      else return false;
      const toRail = !!this.power(pb.net) && !isSwitch && !!this.railFor(pb.net, 'T');
      const c = this.freeBlock('T', this.packages[0]?.col0 ?? 3, 1, ref);
      ha = this.occ.claim(hole(c, 'a'), ref);
      this.addHome(pa.net, `T${c}`);
      if (toRail) hb = this.railHole(this.railFor(pb.net, 'T')!, ha.col, ref);
      else {
        const c2 = this.freeBlock('T', ha.col, 1, ref, (cc) => this.spanClear('a', ha.col, cc));
        hb = this.occ.claim(hole(c2, 'a'), ref);
        this.addHome(pb.net, `T${c2}`);
      }
    }
    this.pinHole.set(pinKey(ref, pa.num), ha);
    this.pinHole.set(pinKey(ref, pb.num), hb);
    this.registerPlaced(ref, fp, comp, { [pa.num]: ha, [pb.num]: hb });
    return true;
  }

  // ---------- wires ----------

  private routePower() {
    for (const net of [...this.homes.keys()].sort()) {
      if (!this.power(net)) continue;
      for (const s of uniq(this.homes.get(net)!).sort((a, b) => stripCol(a) - stripCol(b))) {
        const rail = this.railFor(net, stripHalf(s));
        if (!rail || !this.railNet(rail)) continue;
        const owner = `${displayName(net)} wire`;
        const h = this.take(s, PART_ROWS, owner);
        const r = this.railHole(rail, stripCol(s), owner);
        this.wires.push({ net, a: h, b: r, role: 'power' });
      }
    }
  }

  private pairHoles(s1: string, s2: string, owner: string): [Hole, Hole] {
    if (stripHalf(s1) === stripHalf(s2)) {
      const f1 = this.freeRows(s1, WIRE_ROWS);
      const f2 = this.freeRows(s2, WIRE_ROWS);
      const common = WIRE_ROWS[stripHalf(s1)].find((r) => f1.includes(r) && f2.includes(r));
      if (common) return [this.occ.claim(hole(stripCol(s1), common), owner), this.occ.claim(hole(stripCol(s2), common), owner)];
    }
    return [this.take(s1, WIRE_ROWS, owner), this.take(s2, WIRE_ROWS, owner)];
  }

  private routeSignals() {
    const nets = [...this.homes.keys()].sort((a, b) => displayName(a).localeCompare(displayName(b)));
    for (const net of nets) {
      if (this.power(net) || isUnconnected(net)) continue;
      const strips = uniq(this.homes.get(net)!).sort((a, b) => stripCol(a) - stripCol(b) || a.localeCompare(b));
      for (let i = 0; i + 1 < strips.length; i++) {
        const [h1, h2] = this.pairHoles(strips[i], strips[i + 1], `${displayName(net)} wire`);
        this.wires.push({ net, a: h1, b: h2, role: 'signal' });
      }
    }
  }

  private placeBridges() {
    if (!this.supply) return;
    const freeCol = (exclude: Set<number>) => {
      for (let c = 1; c <= this.b.cols; c++) {
        if (this.pkgCols.has(c) || exclude.has(c) || !this.b.railExists(c)) continue;
        if ([...TOP_ROWS, ...BOT_ROWS, ...RAILS].every((r) => this.occ.isFree(hole(c, r)))) return c;
      }
      throw new LayoutError('no free column for a rail bridge');
    };
    const pairs: [string, Row, Row][] = [];
    if (this.gnd.length) pairs.push([this.gndName, 'T-', 'B-']);
    if (this.plus.length && !this.secondName) pairs.push([this.plusName, 'T+', 'B+']);
    const used = new Set<number>();
    for (const [net, ra, rb] of pairs) {
      const c = freeCol(used);
      used.add(c);
      this.wires.push({ net, a: this.occ.claim(hole(c, ra), 'bridge'), b: this.occ.claim(hole(c, rb), 'bridge'), role: 'bridge' });
    }
    const split = this.b.splitCol;
    if (split) {
      for (const rail of RAILS) {
        const net = this.railNet(rail);
        if (!net) continue;
        const a = this.railHole(rail, split, 'split bridge', -1);
        const bb = this.railHole(rail, split + 1, 'split bridge', 1);
        this.wires.push({ net, a, b: bb, role: 'split' });
      }
    }
  }

  // ---------- colours ----------

  private makeNets(): Record<string, NetInfo> {
    const nets: Record<string, NetInfo> = {};
    const color = (net: string, fallback: string) => this.sidecar.colors[net] ?? fallback;
    let i = 0;
    const next = () => PALETTE[i++ % PALETTE.length];
    const switchNets: string[] = [];
    for (const [ref, f] of this.fp) {
      if (f.kind === 'lead2' && (f.style === 'SW' || f.style === 'BTN')) for (const p of this.d.components.get(ref)!.pins.values()) if (!this.power(p.net) && !isUnconnected(p.net)) switchNets.push(p.net);
      if (f.kind === 'dipswitch') for (const p of this.d.components.get(ref)!.pins.values()) if (!this.power(p.net) && !isUnconnected(p.net)) switchNets.push(p.net);
    }
    const ledNets: string[] = [];
    for (const part of this.parts) if (part.style === 'LED') ledNets.push(...part.nets);
    const order = [...this.plus, ...this.gnd, ...this.minus, ...switchNets.sort(), ...ledNets, ...[...this.d.nets.keys()].sort((a, b) => displayName(a).localeCompare(displayName(b)))];
    for (const net of order) {
      if (nets[net] || isUnconnected(net)) continue;
      const power = this.power(net);
      const fallback = power === '+' ? COLOR_PLUS : power === 'gnd' ? COLOR_GND : power === '-' ? COLOR_MINUS : next();
      nets[net] = { name: displayName(net), color: color(net, fallback), power };
    }
    return nets;
  }

  // ---------- build ----------

  build(): EngineResult {
    let error: string | null = null;
    try {
      this.sizeBoard();
      this.placePinned();
      this.placePackages();
      this.placeSupply();
      this.placeThreeLead();
      this.placeTwoLead();
      this.routePower();
      this.routeSignals();
      this.placeBridges();
    } catch (e) {
      if (!(e instanceof LayoutError)) throw e;
      error = e.message;
    }
    if (!this.board) this.board = new Board(30, 'half', null, 6);
    for (const [ref, f] of this.fp) if (f.kind === 'unsupported') this.unplaced.push({ ref, reason: f.reason });
    this.unplaced.sort((x, y) => compareRefs(x.ref, y.ref));
    const pinHoles: Record<string, Record<string, Hole>> = {};
    for (const [k, h] of this.pinHole) {
      const [ref, pin] = k.split(' ');
      (pinHoles[ref] ??= {})[pin] = h;
    }
    this.parts.sort((x, y) => compareRefs(x.id, y.id));
    return {
      board: this.board.spec(),
      supply: this.supply,
      packages: this.packages,
      parts: this.parts,
      wires: this.wires,
      nets: this.makeNets(),
      pinHoles,
      unplaced: this.unplaced,
      warnings: this.warnings,
      footprints: Object.fromEntries(this.fp),
      values: Object.fromEntries(this.values),
      power: { plus: this.plus, minus: this.minus, gnd: this.gnd, plusName: this.plusName, gndName: this.gndName, secondName: this.secondName },
      ledColors: { ...this.sidecar.ledColors },
      resistorKind: this.sidecar.options.resistorKind,
      error,
    };
  }
}

// Deterministic breadboard placement and routing.
//
// Order: size the board, claim pinned holes, place packages across the
// gutter, supply leads, three-lead parts, two-lead parts anchored to nets that
// already have a home strip, power jumpers to the rails, signal jumpers strip
// to strip, rail bridges. Every hole has one owner. Problems never throw out
// of layout(): they land in `error`, `unplaced` and `warnings`.

import type { Component, Design, DesignPin } from '../netlist.ts';
import { displayName, isUnconnected } from '../netlist.ts';
import { classify, powerKind, type Footprint, type PowerKind } from '../parts/catalog.ts';
import { compareRefs } from '../parts/values.ts';
import { BOT_ROWS, Board, LayoutError, MID_ROWS, Occupancy, PART_ROWS, RAILS, TOP_ROWS, WIRE_ROWS, hole, isRail, stripCol, stripHalf, stripOf } from './board.ts';
import type { BoardSpec, Hole, NetInfo, Options, Package, PlacedPart, Row, Sidecar, Supply, Wire } from './types.ts';

export { LayoutError };

export const PALETTE = ['#E3B505', '#2E9E4F', '#F26B1D', '#7B3FBF', '#1F6FE0', '#8B5A2B', '#0FA3A3', '#D6336C', '#5C7C2A', '#3E4A61', '#B8860B', '#4682B4'];
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
  error: string | null;
}

type Half = 'T' | 'B';
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
  private dipMap = new Map<string, number>();
  private board: Board | null = null;
  private supply: Supply | null = null;
  private unplaced: { ref: string; reason: string }[] = [];
  private warnings: string[] = [];

  constructor(
    private d: Design,
    private sidecar: Sidecar,
    private forceBoard: 'half' | 'full' | null,
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
    const fp = this.fp.get(ref)!;
    const comp = this.d.components.get(ref)!;
    switch (fp.kind) {
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

  private packageWidth(fp: Footprint): number {
    return fp.kind === 'dip' ? fp.pins / 2 : fp.kind === 'dipswitch' ? fp.positions : fp.kind === 'sevenseg' ? fp.pins / 2 : 0;
  }

  private isPackage(fp: Footprint): boolean {
    return fp.kind === 'dip' || fp.kind === 'dipswitch' || fp.kind === 'sevenseg';
  }

  private packageRefs(): string[] {
    const refs = [...this.fp.entries()].filter(([, f]) => this.isPackage(f)).map(([r]) => r);
    const ordered = this.opt.packageOrder.filter((r) => refs.includes(r));
    const rank = (r: string) => ({ dipswitch: 0, dip: 1, sevenseg: 2 })[this.fp.get(r)!.kind as 'dipswitch' | 'dip' | 'sevenseg'];
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
    const kind = this.forceBoard ?? (this.opt.board !== 'auto' ? this.opt.board : need <= 30 ? 'half' : 'full');
    const cols = kind === 'half' ? 30 : 63;
    if (need > cols) throw new LayoutError(`the packages need about ${need} columns; a ${kind}-size board has ${cols}. Switch the board option to full or unpin parts.`);
    const split = this.opt.railSplit ?? kind === 'full';
    this.board = new Board(cols, kind, split ? 30 : null, 6);
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
      case 'dip':
        this.packages.push({ id: ref, kind: 'dip', name: value, col0, pins: fp.pins });
        addCols(fp.pins / 2);
        break;
      case 'sevenseg':
        this.packages.push({ id: ref, kind: 'sevenseg', name: value, col0, pins: fp.pins, common: fp.common });
        addCols(fp.pins / 2);
        break;
      case 'dipswitch':
        this.packages.push({ id: ref, kind: 'dipswitch', name: value, col0, pins: fp.positions * 2, positions: fp.positions, map: Object.fromEntries(fp.pairs.map((_, i) => [String(i + 1), ref])) });
        addCols(fp.positions);
        break;
      case 'lead2':
        this.parts.push({ id: ref, kind: 'lead2', style: fp.style, value, holes: [holes[fp.a], holes[fp.b]], pins: [fp.a, fp.b], nets: [netOf(fp.a), netOf(fp.b)], polarized: fp.polarized, labels: [fp.aLabel, fp.bLabel] });
        break;
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
    if (col < 1 || col + width - 1 > this.b.cols) return false;
    for (let c = col - 2; c <= col + width + 1; c++) if (this.pkgCols.has(c)) return false;
    for (let c = col; c < col + width; c++) if (!this.occ.isFree(hole(c, 'e')) || !this.occ.isFree(hole(c, 'f'))) return false;
    return true;
  }

  private findPackageColumn(width: number, owner: string): number {
    for (let col = 3; col + width - 1 <= this.b.cols - 2; col++) if (this.spanFree(col, width)) return col;
    throw new LayoutError(`no room for ${owner} (${width} columns) on a ${this.b.kind}-size board`);
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
        col0 = this.findPackageColumn(width, ref);
      } catch (e) {
        this.unplaced.push({ ref, reason: (e as Error).message });
        continue;
      }
      const holes: Record<string, Hole> = {};
      if (fp.kind === 'dip' || fp.kind === 'sevenseg') {
        const n = fp.pins;
        const half = n / 2;
        for (const p of this.pinsOf(ref)) {
          const k = Number(p);
          holes[p] = k <= half ? hole(col0 + k - 1, 'f') : hole(col0 + (n - k), 'e');
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

  private freeBlock(half: Half, near: number, width: number, owner: string): number {
    const rows = half === 'T' ? TOP_ROWS : BOT_ROWS;
    const ok = (c: number) => c >= 1 && c + width - 1 <= this.b.cols && Array.from({ length: width }, (_, i) => c + i).every((cc) => !this.pkgCols.has(cc) && rows.every((r) => this.occ.isFree(hole(cc, r))));
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

  private tryPlaceTwoLead(ref: string, force: boolean): boolean {
    const fp = this.fp.get(ref) as Extract<Footprint, { kind: 'lead2' }>;
    const comp = this.d.components.get(ref)!;
    const pa0 = comp.pins.get(fp.a);
    const pb0 = comp.pins.get(fp.b);
    if (!pa0 || !pb0) throw new LayoutError(`${ref} is missing pin ${!pa0 ? fp.a : fp.b} in the netlist`);
    let pair: [DesignPin, DesignPin] | null = null;
    for (const [x, y] of [[pa0, pb0], [pb0, pa0]] as [DesignPin, DesignPin][]) {
      if (!this.power(x.net) && !isUnconnected(x.net) && this.homes.get(x.net)?.length) {
        pair = [x, y];
        break;
      }
    }
    if (!pair) {
      if (this.power(pa0.net) && this.power(pb0.net)) pair = [pa0, pb0];
      else if (force) pair = [pa0, pb0];
      else return false;
    }
    const [pa, pb] = pair;
    const isSwitch = fp.style === 'SW' || fp.style === 'BTN';
    const toRail = !!this.power(pb.net) && !isSwitch && !!this.railFor(pb.net, 'T');
    let ha: Hole;
    if (this.homes.get(pa.net)?.length && !this.power(pa.net)) {
      ha = this.take(this.pickStrip(pa.net), toRail ? PART_ROWS : MID_ROWS, ref);
    } else {
      const c = this.freeBlock('T', this.packages[0]?.col0 ?? 3, 1, ref);
      ha = this.occ.claim(hole(c, 'a'), ref);
      this.addHome(pa.net, `T${c}`);
    }
    const half = stripHalf(stripOf(ha));
    let hb: Hole;
    if (toRail) {
      hb = this.railHole(this.railFor(pb.net, half)!, ha.col, ref);
    } else {
      const near = (this.homes.get(pb.net) ?? [])
        .filter((s) => stripHalf(s) === half && stripCol(s) !== ha.col && Math.abs(stripCol(s) - ha.col) <= 2)
        .sort((x, y) => Math.abs(stripCol(x) - ha.col) - Math.abs(stripCol(y) - ha.col));
      if (near.length && this.freeRows(near[0], MID_ROWS).length) {
        hb = this.take(near[0], MID_ROWS, ref, ha.row);
      } else {
        const c = this.freeBlock(half, ha.col, 1, ref);
        hb = this.occ.claim(hole(c, ha.row), ref);
        this.addHome(pb.net, `${half}${c}`);
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
      error,
    };
  }
}

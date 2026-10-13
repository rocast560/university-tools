// 74xx chip facts: gate pinouts for the simulator, supply pins and currents
// for the checks. Pin numbers are the DIP package pins.

export type GateKind = 'nand' | 'nor' | 'not' | 'and' | 'or' | 'xor' | 'xnor';

export interface GateSpec {
  inputs: number[];
  output: number;
}

export interface ChipSpec {
  code: string;
  description: string;
  kind: GateKind | null;
  gates: GateSpec[];
  decoder: '7447' | '7448' | null;
  /** 3-to-8 line decoder with active-low outputs (74138). */
  demux?: boolean;
  /** 8-to-1 data selector with true and complement outputs (74151). */
  mux?: boolean;
  /** 4-bit binary full adder with carry (74283). */
  adder?: boolean;
  vcc: number;
  gnd: number;
  iccMax: number;
  pins: number;
}

const g = (pairs: [number[], number][]): GateSpec[] => pairs.map(([inputs, output]) => ({ inputs, output }));
const QUAD2 = g([[[1, 2], 3], [[4, 5], 6], [[9, 10], 8], [[12, 13], 11]]);
const TRIPLE3 = g([[[1, 2, 13], 12], [[3, 4, 5], 6], [[9, 10, 11], 8]]);
const DUAL4 = g([[[1, 2, 4, 5], 6], [[9, 10, 12, 13], 8]]);
const HEX1 = g([[[1], 2], [[3], 4], [[5], 6], [[9], 8], [[11], 10], [[13], 12]]);

const chip = (code: string, description: string, kind: GateKind, gates: GateSpec[], iccMax: number): ChipSpec => ({ code, description, kind, gates, decoder: null, vcc: 14, gnd: 7, iccMax, pins: 14 });

export const CHIPS: Record<string, ChipSpec> = {
  '00': chip('00', 'quad 2-input NAND', 'nand', QUAD2, 8e-3),
  '02': chip('02', 'quad 2-input NOR', 'nor', g([[[2, 3], 1], [[5, 6], 4], [[8, 9], 10], [[11, 12], 13]]), 8e-3),
  '04': chip('04', 'hex inverter', 'not', HEX1, 6.6e-3),
  '08': chip('08', 'quad 2-input AND', 'and', QUAD2, 8.8e-3),
  '10': chip('10', 'triple 3-input NAND', 'nand', TRIPLE3, 6.6e-3),
  '11': chip('11', 'triple 3-input AND', 'and', TRIPLE3, 6.6e-3),
  '20': chip('20', 'dual 4-input NAND', 'nand', DUAL4, 4.4e-3),
  '21': chip('21', 'dual 4-input AND', 'and', DUAL4, 4.4e-3),
  '27': chip('27', 'triple 3-input NOR', 'nor', TRIPLE3, 6.6e-3),
  '30': chip('30', '8-input NAND', 'nand', g([[[1, 2, 3, 4, 5, 6, 11, 12], 8]]), 4.4e-3),
  '32': chip('32', 'quad 2-input OR', 'or', QUAD2, 9.8e-3),
  '86': chip('86', 'quad 2-input XOR', 'xor', QUAD2, 10e-3),
  '47': { code: '47', description: 'BCD to 7-segment decoder, active-low outputs (common-anode display)', kind: null, gates: [], decoder: '7447', vcc: 16, gnd: 8, iccMax: 64e-3, pins: 16 },
  '48': { code: '48', description: 'BCD to 7-segment decoder, active-high outputs (common-cathode display)', kind: null, gates: [], decoder: '7448', vcc: 16, gnd: 8, iccMax: 76e-3, pins: 16 },
  '283': { code: '283', description: '4-bit binary full adder with fast carry', kind: null, gates: [], decoder: null, adder: true, vcc: 16, gnd: 8, iccMax: 39e-3, pins: 16 },
  '138': { code: '138', description: '3-to-8 line decoder, active-low outputs', kind: null, gates: [], decoder: null, demux: true, vcc: 16, gnd: 8, iccMax: 10e-3, pins: 16 },
  '151': { code: '151', description: '8-to-1 line data selector/multiplexer', kind: null, gates: [], decoder: null, mux: true, vcc: 16, gnd: 8, iccMax: 10e-3, pins: 16 },
};

/** 74138 pinout: select A0-A2, enables E1 and E2 (active low) and E3 (active high), outputs O0-O7. */
export const DEMUX_PINS = {
  select: [1, 2, 3],
  enableLow: [4, 5],
  enableHigh: 6,
  outputs: [15, 14, 13, 12, 11, 10, 9, 7],
};

/** Output levels O0-O7 of a 74138: the selected line goes low only while enabled. */
export function demuxOutputs(select: number[], enableLow: number[], enableHigh: number): (0 | 1)[] {
  const on = enableLow.every((v) => v === 0) && enableHigh === 1;
  const line = select[0] + 2 * select[1] + 4 * select[2];
  return DEMUX_PINS.outputs.map((_, i) => (on && i === line ? 0 : 1));
}

/** 74151 pinout: data D0-D7, select S0-S2, strobe (active low), Z and its complement W. */
export const MUX_PINS = {
  data: [4, 3, 2, 1, 15, 14, 13, 12],
  select: [11, 10, 9],
  strobe: 7,
  z: 5,
  w: 6,
};

/** Outputs of a 74151: Z is the selected data input while the strobe is low; a high strobe holds Z low. */
export function muxOutputs(data: number[], select: number[], strobe: number): { z: 0 | 1; w: 0 | 1 } {
  const z: 0 | 1 = strobe === 0 && data[select[0] + 2 * select[1] + 4 * select[2]] === 1 ? 1 : 0;
  return { z, w: z === 1 ? 0 : 1 };
}

/** 74283 pinout, bit 0 first: A1-A4, B1-B4, sums S1-S4, carry in C0 and carry out C4. */
export const ADDER_PINS = {
  a: [5, 3, 14, 12],
  b: [6, 2, 15, 11],
  sum: [4, 1, 13, 10],
  carryIn: 7,
  carryOut: 9,
};

/** Sum bits (bit 0 first) and carry out of a 74283. */
export function adderOutputs(a: number[], b: number[], carryIn: number): { sum: (0 | 1)[]; carryOut: 0 | 1 } {
  const word = (bits: number[]) => bits.reduce((acc, v, i) => acc + (v << i), 0);
  const total = word(a) + word(b) + carryIn;
  return { sum: [0, 1, 2, 3].map((i) => ((total >> i) & 1) as 0 | 1), carryOut: ((total >> 4) & 1) as 0 | 1 };
}

/** 7447 / 7448 pinout (same for both). */
export const DECODER_PINS = {
  inputs: { A: 7, B: 1, C: 2, D: 6 },
  lampTest: 3,
  blanking: 4,
  rippleBlankingIn: 5,
  outputs: { a: 13, b: 12, c: 11, d: 10, e: 9, f: 15, g: 14 } as Record<string, number>,
};

export const DC = {
  LS: { volMax: 0.5, vohMin: 2.7, iol: 8e-3, ioh: 0.4e-3, iih: 20e-6, iil: 0.4e-3, fanout: 20 },
  HC: { volMax: 0.33, vohMin: 3.84, iol: 4e-3, ioh: 4e-3, iih: 1e-6, iil: 1e-6, fanout: 50 },
};

const IC_RE = /(?:SN|DM|MC|CD)?74\s*(LS|HCT|HC|ALS|ACT|AC|F)?(\d{2,3})/i;

export interface IcInfo {
  code: string;
  family: 'LS' | 'HC';
  spec: ChipSpec | null;
  vcc: number;
  gnd: number;
}

export function icInfo(value: string, pinCount = 14): IcInfo | null {
  const m = IC_RE.exec(value ?? '');
  if (!m) return null;
  const fam = (m[1] ?? '').toUpperCase();
  const family = fam === 'HC' || fam === 'HCT' || fam === 'AC' || fam === 'ACT' ? 'HC' : 'LS';
  const spec = CHIPS[m[2]] ?? null;
  return { code: m[2], family, spec, vcc: spec?.vcc ?? pinCount, gnd: spec?.gnd ?? pinCount / 2 };
}

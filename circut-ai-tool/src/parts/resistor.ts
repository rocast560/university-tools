// The colour code painted on a resistor, worked out from its value.
//
// Both boards draw the bands, and a picture of a resistor that says something
// other than its printed value is worse than no bands at all: a student
// reading the 3D model would fetch the wrong part out of the drawer. So the
// code comes from the same parsed ohms the checks and the solver use.

import { parseOhms } from './values.ts';

export interface Band {
  /** The colour's name in the code, e.g. "brown". */
  name: string;
  hex: string;
}

/** Digit colours, black first, in the order the code numbers them. */
const DIGITS: Band[] = [
  { name: 'black', hex: '#1A1A1A' },
  { name: 'brown', hex: '#6B4226' },
  { name: 'red', hex: '#C62828' },
  { name: 'orange', hex: '#E8641A' },
  { name: 'yellow', hex: '#E8C11A' },
  { name: 'green', hex: '#2E7D32' },
  { name: 'blue', hex: '#1F4FBF' },
  { name: 'violet', hex: '#7B3FBF' },
  { name: 'grey', hex: '#9AA0A6' },
  { name: 'white', hex: '#F2F0EA' },
];
const GOLD: Band = { name: 'gold', hex: '#C9A227' };
const SILVER: Band = { name: 'silver', hex: '#C6CBD1' };

/**
 * The four bands of a 5% resistor: two significant digits, the power of ten
 * to multiply them by, and the gold tolerance band. Null when the value is not
 * a resistance this code can express.
 */
export function colourBands(value: string): [Band, Band, Band, Band] | null {
  const ohms = parseOhms(value);
  if (ohms === null || !Number.isFinite(ohms) || ohms <= 0) return null;
  // Two significant digits and the exponent that scales them back up.
  let exp = Math.floor(Math.log10(ohms)) - 1;
  let digits = Math.round(ohms / 10 ** exp);
  // Rounding 99.6 up lands on 100, which is three digits: shift instead.
  if (digits >= 100) {
    digits = Math.round(digits / 10);
    exp += 1;
  }
  if (digits < 10) {
    digits *= 10;
    exp -= 1;
  }
  const multiplier = exp === -2 ? SILVER : exp === -1 ? GOLD : DIGITS[exp];
  if (!multiplier) return null;
  return [DIGITS[Math.floor(digits / 10)], DIGITS[digits % 10], multiplier, GOLD];
}

/**
 * Carbon film is the tan 5% resistor in the lab kit; metal film is the blue
 * 1% one sold in bulk kits online, which carries a five-band code.
 */
export type ResistorKind = 'carbon' | 'metal';
export const RESISTOR_KINDS: readonly ResistorKind[] = ['carbon', 'metal'];

/** Body colour and its outline for each kind, shared by every renderer. */
export const RESISTOR_BODY: Record<ResistorKind, { fill: string; stroke: string }> = {
  carbon: { fill: '#E8D5A3', stroke: '#5B4A1F' },
  metal: { fill: '#4F8FD6', stroke: '#1E3F66' },
};

/**
 * The five bands of a 1% resistor: three significant digits, the multiplier
 * and the brown tolerance band. Null when the code cannot express the value.
 */
export function colourBands5(value: string): Band[] | null {
  const ohms = parseOhms(value);
  if (ohms === null || !Number.isFinite(ohms) || ohms <= 0) return null;
  let exp = Math.floor(Math.log10(ohms)) - 2;
  let digits = Math.round(ohms / 10 ** exp);
  if (digits >= 1000) {
    digits = Math.round(digits / 10);
    exp += 1;
  }
  const multiplier = exp === -2 ? SILVER : exp === -1 ? GOLD : DIGITS[exp];
  if (!multiplier) return null;
  return [DIGITS[Math.floor(digits / 100)], DIGITS[Math.floor(digits / 10) % 10], DIGITS[digits % 10], multiplier, DIGITS[1]];
}

/** The bands painted on a resistor of this kind. */
export function resistorBands(value: string, kind: ResistorKind): Band[] | null {
  return kind === 'metal' ? colourBands5(value) : colourBands(value);
}

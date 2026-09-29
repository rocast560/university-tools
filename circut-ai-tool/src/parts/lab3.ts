import type { GateKind } from './gates.ts';

// Header positions counted top-to-bottom in Lab3_Auxiliary_Circuit.pdf.
// Position 7 is the unlabeled separator: reserved, never wire it.
export const L3_HEADER = ['VCC', 'GND', 'W', 'X', 'Y', 'Z', 'NC', '~W', '~X', '~Y', '~Z', 'a', 'b', 'c', 'd'];
/** What the board's silkscreen prints beside each header position (position 7 is a bare separator line). */
export const L3_SILK = ['VCC', 'GND', 'W', 'X', 'Y', 'Z', '', '~W', '~X', '~Y', '~Z', 'A', 'B', 'C', 'D'];
export const L3_ID = 'ECE2300L:L3_Auxiliary';

/**
 * Mechanical model of the instructor board, in 0.1 inch pitches, measured off
 * the photo in Lab3_Auxiliary_Circuit.pdf against the header's own pitch.
 *
 * The board is a rectangle of about 18 by 13 pitches (46 x 33 mm). Its only
 * breadboard connection is the 15-position header, which runs along one long
 * edge half a pitch in from it, with two pitches of board past each end pin.
 * The rest of the board is a wide DIP socket holding the potted "L3 CKT"
 * chip. So the board sits in an outer strip row (a or j) and its body hangs
 * outward, over that side's supply rails and off the edge of the breadboard,
 * which leaves the four inner rows of every header column free for jumpers.
 */
export const L3_BOARD = {
  /** Header positions, one row, 0.1 inch pitch. */
  pins: 15,
  /** Board past pin 1 and past pin 15, in pitches. */
  endMargin: 2,
  /** Header row in from the near long edge, in pitches. */
  inset: 0.5,
  /** Far long edge beyond the header row, in pitches. */
  depth: 12.5,
  /** The wide DIP socket: its two pin rows, in pitches beyond the header, and pins per row. */
  socket: { near: 5.5, far: 11.5, perSide: 15 },
} as const;

/** Columns the board covers when its pin 1 sits in `col0`: the end margins are part of the board. */
export function l3CoveredCols(col0: number): number[] {
  const from = col0 - L3_BOARD.endMargin;
  const to = col0 + L3_BOARD.pins - 1 + L3_BOARD.endMargin;
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** Gate-equivalent model of the whiteboard expressions, not the hidden IC. */
export function l3Gates(pin: (p: string) => string, ref: string): { name: string; kind: GateKind; inputs: string[]; output: string }[] {
  const gates: { name: string; kind: GateKind; inputs: string[]; output: string }[] = [];
  const p = (n: number) => pin(String(n));
  const add = (kind: GateKind, inputs: string[], output: string) => gates.push({ name: `${ref}:${gates.length}`, kind, inputs, output });
  const internal = (s: string) => `unconnected-(${ref}-internal-${s})`;
  for (let i = 0; i < 4; i++) add('not', [p(3 + i)], p(8 + i));
  add('and', [p(8), p(9), p(10), p(6)], internal('a1'));
  add('and', [p(4), p(10), p(11)], internal('a2'));
  add('or', [internal('a1'), internal('a2')], p(12));
  add('xor', [p(5), p(6)], internal('xor'));
  add('and', [p(4), internal('xor')], p(13));
  add('and', [p(9), p(5), p(11)], p(14));
  add('and', [p(4), p(5), p(6)], internal('xyz'));
  add('or', [p(12), internal('xyz')], p(15));
  return gates;
}

/** Embedded custom symbol, available without installing a KiCad library. */
export function l3Symbol(): string {
  const pins = L3_HEADER.map((name, i) => {
    const input = i < 7;
    const y = 17.78 - (input ? i : i - 7) * 5.08;
    return `(pin ${i < 2 ? 'power_in' : i === 6 ? 'no_connect' : input ? 'input' : 'output'} line (at ${input ? -22.86 : 22.86} ${y} ${input ? 0 : 180}) (length 5.08) (name "${name}" (effects (font (size 1.27 1.27)))) (number "${i + 1}" (effects (font (size 1.27 1.27)))))`;
  }).join('\n');
  return `(symbol "${L3_ID}" (pin_names (offset 1.016)) (in_bom yes) (on_board yes)
    (property "Reference" "U" (at 0 25.4 0) (effects (font (size 1.27 1.27))))
    (property "Value" "L3_Auxiliary" (at 0 22.86 0) (effects (font (size 1.27 1.27))))
    (symbol "L3_Auxiliary_0_1" (rectangle (start -17.78 20.32) (end 17.78 -20.32) (stroke (width 0.254) (type default)) (fill (type background))))
    (symbol "L3_Auxiliary_1_1" ${pins}))`;
}

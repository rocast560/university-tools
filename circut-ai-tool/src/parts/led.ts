// LED colour: what the value string says, what it looks like, and what it
// costs in forward volts.
//
// Two consumers with different needs share this table. The analog solver wants
// `vf` and `ifRated` to build a diode model and to spot an overdriven part;
// the rich renderer wants `body`, `light` and `gain` to paint the epoxy and
// scale the glow. Keeping them together stops the two drifting apart, so a
// blue LED cannot end up drawn blue but simulated at 1.8 V.
//
// The flat skin deliberately does NOT use this: it keeps theme.ledOn/ledOff so
// the server SVG, the print sheet and the MCP picture stay byte-identical.

export const LED_COLOURS = ['red', 'orange', 'amber', 'yellow', 'green', 'blue', 'white', 'uv', 'ir'] as const;
export type LedColour = (typeof LED_COLOURS)[number];

export interface LedSpec {
  key: LedColour;
  /** Epoxy colour when the LED is dark. */
  body: string;
  /** Hue it emits when lit. */
  light: string;
  /** Typical forward drop at the rated current, in volts. */
  vf: number;
  /** Rated forward current, in amps. */
  ifRated: number;
  /** Luminous-efficiency scaler, so equal currents look comparably bright. */
  gain: number;
}

const TABLE: Record<LedColour, Omit<LedSpec, 'key'>> = {
  red: { body: '#E8202A', light: '#FF3B30', vf: 1.9, ifRated: 0.02, gain: 1 },
  orange: { body: '#E8631A', light: '#FF7A1A', vf: 2.0, ifRated: 0.02, gain: 1.05 },
  amber: { body: '#E8881A', light: '#FFA51A', vf: 2.0, ifRated: 0.02, gain: 1.05 },
  yellow: { body: '#E3B505', light: '#FFD23B', vf: 2.1, ifRated: 0.02, gain: 1.1 },
  green: { body: '#2E9E4F', light: '#3BE86A', vf: 2.2, ifRated: 0.02, gain: 1.15 },
  blue: { body: '#1F5FE0', light: '#4FA8FF', vf: 3.1, ifRated: 0.02, gain: 0.95 },
  white: { body: '#E7E5DF', light: '#FFF6E8', vf: 3.1, ifRated: 0.02, gain: 1.2 },
  uv: { body: '#7B3FBF', light: '#B98BFF', vf: 3.4, ifRated: 0.02, gain: 0.5 },
  ir: { body: '#3A2020', light: '#8E2A2A', vf: 1.3, ifRated: 0.05, gain: 0.15 },
};

const WORDS: [RegExp, LedColour][] = [
  [/\bir\b|infra ?red/i, 'ir'],
  [/\buv\b|ultra ?violet/i, 'uv'],
  [/white/i, 'white'],
  [/blue/i, 'blue'],
  [/green/i, 'green'],
  [/yellow/i, 'yellow'],
  [/amber/i, 'amber'],
  [/orange/i, 'orange'],
  [/red/i, 'red'],
];

/** Dominant wavelength in nm -> colour. */
function fromNanometres(nm: number): LedColour | null {
  if (nm >= 780) return 'ir';
  if (nm >= 620) return 'red';
  if (nm >= 590) return 'orange';
  if (nm >= 565) return 'yellow';
  if (nm >= 495) return 'green';
  if (nm >= 420) return 'blue';
  if (nm > 0) return 'uv';
  return null;
}

/**
 * Read an LED's colour out of its schematic value or symbol name. Understands
 * "LED_Blue", "green", "LED 525nm" and a trailing "2.6V" override; anything
 * unrecognised is red, which is what the board has always drawn.
 */
/** The spec for a colour chosen directly, bypassing the value string. */
export function ledSpecFor(key: LedColour): LedSpec {
  return { key, ...TABLE[key] };
}

export function ledSpec(value: string): LedSpec {
  const s = String(value ?? '');
  let key: LedColour = 'red';
  const nm = /(\d{3})\s*nm/i.exec(s);
  const word = WORDS.find(([re]) => re.test(s));
  if (word) key = word[1];
  else if (nm) key = fromNanometres(Number(nm[1])) ?? 'red';
  const spec: LedSpec = { key, ...TABLE[key] };
  // An explicit forward voltage in the value wins over the colour default.
  const volts = /(\d(?:\.\d+)?)\s*V(?![A-Za-z])/i.exec(s);
  if (volts) spec.vf = Number(volts[1]);
  return spec;
}

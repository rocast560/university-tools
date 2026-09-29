// Concrete colours for the renderer.
//
// The breadboard is a physical object: it does not follow the page theme, and
// every colour of the board itself is the same in both palettes. A real board
// is tan under any lighting.
//
// What does differ is the margin. The renderer draws supply leads, their
// +5V/GND labels and the rail-split note OUTSIDE the board rect, on whatever
// the board is sitting on, and the two callers sit it on opposite surfaces:
// the client mounts it in a near-black well (--well in client/styles.css) so
// running LEDs read as lamps, while server/png.ts renders onto a light page
// because an exported PNG goes into a build guide. Theme.margin is the ink for
// that surround, and it is the only colour the two palettes disagree about.

export interface Theme {
  name: 'light' | 'dark';
  board: string;
  boardStroke: string;
  gutter: string;
  hole: string;
  text: string;
  textMuted: string;
  /** Ink for anything drawn outside the board rect, onto the surround. */
  margin: string;
  railPlus: string;
  railMinus: string;
  chip: string;
  chipText: string;
  lead: string;
  body: string;
  bodyStroke: string;
  bodyText: string;
  ledOff: string;
  ledOn: string;
  segOff: string;
  segOn: string;
  notch: string;
  dim: number;
}

export const LIGHT: Theme = {
  name: 'light',
  board: '#EAE5D6',
  boardStroke: '#C9C2AE',
  gutter: '#DAD4C2',
  hole: '#6E7079',
  text: '#1E2229',
  textMuted: '#5B6270',
  margin: '#5B6270',
  railPlus: '#D7263D',
  railMinus: '#2F6FBF',
  chip: '#2B2D33',
  chipText: '#FFFFFF',
  lead: '#8A8F98',
  body: '#E8D5A3',
  bodyStroke: '#5B4A1F',
  bodyText: '#1E2229',
  ledOff: '#B7BCC6',
  ledOn: '#FF3B30',
  segOff: '#3A3D44',
  segOn: '#FF453A',
  notch: '#EAE5D6',
  dim: 0.18,
};

// The board itself is identical to LIGHT: same tan, same rails, same holes.
// Only the margin ink changes, because this is the palette used when the board
// is sitting on the client's near-black well rather than on a printed page.
export const DARK: Theme = { ...LIGHT, name: 'dark', margin: '#AEB7C7' };

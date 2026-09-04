// Concrete colours for the renderer.
//
// The breadboard is a physical object: it does not follow the page theme. Both
// palettes are identical, so the board looks the same in light and dark mode.
// The client mounts the SVG in a constant light well (--well in
// client/styles.css) because the supply leads and their +5V/GND labels are
// drawn in the margin OUTSIDE the board rect, where dark ink on a dark card
// would be invisible.

export interface Theme {
  name: 'light' | 'dark';
  board: string;
  boardStroke: string;
  gutter: string;
  hole: string;
  text: string;
  textMuted: string;
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

// Deliberately identical to LIGHT apart from the name: see the note above.
// `?theme=dark` (server/api.ts) and the DARK import in client/board.ts are
// therefore inert, but are kept so the API and its OpenAPI enum still work.
export const DARK: Theme = { ...LIGHT, name: 'dark' };

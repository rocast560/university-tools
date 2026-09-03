// Concrete colours for the renderer. The client picks LIGHT or DARK from the
// page theme; the server always renders LIGHT for PNG output.

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

export const DARK: Theme = {
  ...LIGHT,
  name: 'dark',
  board: '#2A2D34',
  boardStroke: '#3B3F48',
  gutter: '#23262C',
  hole: '#8A8F98',
  text: '#E7E5DF',
  textMuted: '#A3A8B3',
  chip: '#15171B',
  body: '#C9B27A',
  bodyText: '#15171B',
  ledOff: '#4A4F59',
  notch: '#2A2D34',
};

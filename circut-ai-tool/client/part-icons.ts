// The small flat pictures beside each parts-list row: a chip with the right
// number of legs, the red DIP switch with its toggles, the display, a resistor
// painted with its own colour code, an LED in the colour it is set to. Drawn
// here rather than shipped as images so they always match the part.

import type { PartIcon } from '../src/guide.ts';
import { ledSpecFor, type LedColour } from '../src/parts/led.ts';
import { RESISTOR_BODY, resistorBands, type ResistorKind } from '../src/parts/resistor.ts';

const W = 56;
const x = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const H = 32;

const svg = (body: string, label: string) =>
  `<svg class="part-icon" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${label}">${body}</svg>`;

function chip(pins: number, label: string): string {
  const per = Math.max(1, Math.round(pins / 2));
  const bodyW = Math.min(50, 6 + per * 3.2);
  const x0 = (W - bodyW) / 2;
  const legs: string[] = [];
  for (let i = 0; i < per; i++) {
    const x = x0 + 3 + (i * (bodyW - 6)) / Math.max(1, per - 1) - 0.9;
    legs.push(`<rect x="${x.toFixed(1)}" y="5" width="1.8" height="4" fill="#B8BEC7"/>`, `<rect x="${x.toFixed(1)}" y="23" width="1.8" height="4" fill="#B8BEC7"/>`);
  }
  const short = label.replace(/^(SN|DM)?74/, '74').slice(0, 8);
  return svg(
    legs.join('') +
      `<rect x="${x0}" y="8" width="${bodyW}" height="16" rx="1.5" fill="#24262C" stroke="#0E0F12"/>` +
      `<path d="M ${x0} 13.5 a 2.5 2.5 0 0 1 0 5" fill="#3A3D45"/>` +
      `<text x="${W / 2 + 1.5}" y="18.3" text-anchor="middle" font-size="5.6" font-family="ui-monospace,monospace" fill="#D9DCE2">${x(short)}</text>`,
    `${x(label)} chip`,
  );
}

function dipswitch(positions: number): string {
  const n = Math.max(1, Math.min(12, positions));
  const bodyW = Math.min(52, 6 + n * 6);
  const x0 = (W - bodyW) / 2;
  const step = (bodyW - 4) / n;
  const toggles: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = x0 + 2 + i * step + step / 2 - 2;
    toggles.push(`<rect x="${x.toFixed(1)}" y="10" width="4" height="12" rx=".8" fill="#7E1414"/>`, `<rect x="${x.toFixed(1)}" y="10.5" width="4" height="5" rx=".8" fill="#F4F1EA"/>`);
  }
  return svg(`<rect x="${x0}" y="6" width="${bodyW}" height="20" rx="1.5" fill="#C62020" stroke="#6E0B0B"/>` + toggles.join(''), `${n}-position DIP switch`);
}

function sevenseg(): string {
  // An 8 with every segment lit, on the dark face of the display.
  const seg = (d: string) => `<path d="${d}" stroke="#FF3B2F" stroke-width="2" stroke-linecap="round" fill="none"/>`;
  return svg(
    `<rect x="16" y="1" width="24" height="30" rx="1.5" fill="#2A2C31" stroke="#0E0F12"/>` +
      seg('M 23 6 L 32 6') + seg('M 33.5 7.5 L 32.8 14.5') + seg('M 32.5 17.5 L 31.8 24.5') + seg('M 22 26 L 31 26') +
      seg('M 21.2 17.5 L 20.5 24.5') + seg('M 22.2 7.5 L 21.5 14.5') + seg('M 22.5 16 L 31.5 16') +
      `<circle cx="35" cy="26.5" r="1.1" fill="#FF3B2F"/>`,
    '7-segment display',
  );
}

function resistor(value: string, kind: ResistorKind): string {
  const body = RESISTOR_BODY[kind];
  const bands = resistorBands(value, kind) ?? [];
  const xs = bands.length === 5 ? [18, 21.5, 25, 28.5, 36] : [18.5, 22.5, 26.5, 35.5];
  return svg(
    `<line x1="2" y1="16" x2="54" y2="16" stroke="#B8BEC7" stroke-width="1.6"/>` +
      `<rect x="14" y="10" width="28" height="12" rx="4.5" fill="${body.fill}" stroke="${body.stroke}"/>` +
      bands.map((b, i) => `<rect x="${xs[i]}" y="10.4" width="2.4" height="11.2" fill="${b.hex}"/>`).join(''),
    `${x(value)} ${kind === 'metal' ? 'metal-film' : 'carbon-film'} resistor`,
  );
}

function led(colour: LedColour): string {
  const spec = ledSpecFor(colour);
  return svg(
    `<line x1="25" y1="22" x2="25" y2="31" stroke="#B8BEC7" stroke-width="1.4"/><line x1="31" y1="22" x2="31" y2="29" stroke="#B8BEC7" stroke-width="1.4"/>` +
      `<rect x="20.5" y="19.5" width="15" height="3" rx="1" fill="${spec.body}" opacity=".9"/>` +
      `<path d="M 21.5 20 L 21.5 9 a 6.5 6.5 0 0 1 13 0 L 34.5 20 Z" fill="${spec.body}" opacity=".85" stroke="rgba(0,0,0,.35)"/>` +
      `<ellipse cx="25.5" cy="9" rx="1.6" ry="3" fill="#fff" opacity=".55"/>`,
    `${colour} LED`,
  );
}

function wire(): string {
  return svg(
    `<path d="M 6 26 C 14 2, 26 2, 30 18" stroke="#D32F2F" stroke-width="2.6" fill="none" stroke-linecap="round"/>` +
      `<path d="M 22 28 C 30 8, 42 6, 50 22" stroke="#1E63C6" stroke-width="2.6" fill="none" stroke-linecap="round"/>` +
      `<path d="M 14 29 C 20 20, 34 22, 42 29" stroke="#2E9D3A" stroke-width="2.6" fill="none" stroke-linecap="round"/>`,
    'jumper wires',
  );
}

function generic(style: string): string {
  return svg(
    `<line x1="2" y1="16" x2="54" y2="16" stroke="#B8BEC7" stroke-width="1.6"/><rect x="18" y="9" width="20" height="14" rx="3" fill="#5C6470" stroke="#2C3036"/>` +
      `<text x="28" y="18.6" text-anchor="middle" font-size="6" font-family="ui-monospace,monospace" fill="#EEF0F3">${x(style.slice(0, 4))}</text>`,
    `${x(style)} part`,
  );
}

/** The SVG for one parts-list row, using the board's resistor type and LED colours. */
export function partIcon(icon: PartIcon, resistorKind: ResistorKind, ledColour: (ref: string) => LedColour): string {
  switch (icon.kind) {
    case 'chip':
      return chip(icon.pins, icon.label);
    case 'dipswitch':
      return dipswitch(icon.positions);
    case 'sevenseg':
      return sevenseg();
    case 'resistor':
      return resistor(icon.value, resistorKind);
    case 'led':
      return led(ledColour(icon.ref));
    case 'wire':
      return wire();
    case 'part':
      return generic(icon.style);
  }
}

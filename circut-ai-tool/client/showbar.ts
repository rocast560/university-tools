// The Show filter's buttons, shared by the flat board's legend and the 3D
// view's: one kind of part shown, everything else faded. Clicks are handled by
// whichever legend holds them, through the data-show attribute ('' is All).

import type { PartGroup } from '../src/render/index.ts';

const GROUPS: [PartGroup | null, string][] = [
  [null, 'All'],
  ['chips', 'Chips &amp; modules'],
  ['resistors', 'Resistors'],
  ['leds', 'LEDs'],
];

export function showBar(current: PartGroup | null): string {
  const btn = ([g, label]: [PartGroup | null, string]) => `<button type="button" class="btn ${current === g ? 'is-on' : ''}" data-show="${g ?? ''}" aria-pressed="${current === g}">${label}</button>`;
  return `<div class="showbar"><span class="muted">Show</span><div class="tgroup">${GROUPS.map(btn).join('')}</div></div>`;
}

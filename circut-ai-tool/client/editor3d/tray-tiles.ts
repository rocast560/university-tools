// What the parts tray shows: its groups, which parts each lists, and the HTML
// for the search box, the chips and a tile. No events and no state; tray.ts
// owns those and calls in here to draw.

import type { PartIcon } from '../../src/guide.ts';
import type { PartAlias } from '../../src/parts/aliases.ts';
import type { ResistorKind } from '../../src/parts/resistor.ts';
import type { PartFootprint } from '../api.ts';
import { esc } from '../main.ts';
import { partIcon } from '../part-icons.ts';

export const GROUPS = ['Basic', 'Passives', 'Indicators', 'Inputs', 'Logic', 'All'] as const;
export type Group = (typeof GROUPS)[number];
/** The lab kit's everyday parts, in this order, whichever of them exist as aliases. */
const BASIC = ['resistor', 'LED', 'capacitor', 'pushbutton', 'DIP switch 7', '74LS00', '74LS04', '74LS08', '74LS32', '74LS86', '74LS283', '74LS47'];

/** The tray group a part is listed under; null for power symbols, which are never shown. */
export function groupOf(a: PartAlias): Exclude<Group, 'Basic' | 'All'> | 'Other' | null {
  const id = a.libId;
  if (id.startsWith('power:')) return null;
  if (id.startsWith('Device:LED') || id.startsWith('Display_Character:')) return 'Indicators';
  if (id.startsWith('Device:') || id.startsWith('Diode:')) return 'Passives';
  if (id.startsWith('Switch:')) return 'Inputs';
  if (id.startsWith('74xx:')) return 'Logic';
  return 'Other';
}

/** The flat picture for a tray tile; a chip's leg count comes from its footprint once fetched. */
export function iconFor(a: PartAlias, fp?: PartFootprint): PartIcon {
  const id = a.libId;
  if (id.startsWith('74xx:')) return { kind: 'chip', pins: fp?.footprint.kind === 'dip' ? fp.footprint.pins : 14, label: a.defaultValue ?? a.alias };
  const dip = /^Switch:SW_DIP_x(\d+)$/.exec(id);
  if (dip) return { kind: 'dipswitch', positions: Number(dip[1]) };
  if (id.startsWith('Device:R') && !id.startsWith('Device:R_Pot')) return { kind: 'resistor', value: a.defaultValue ?? '1k' };
  if (id.startsWith('Device:LED')) return { kind: 'led', ref: '' };
  if (id.startsWith('Display_Character:')) return { kind: 'sevenseg' };
  return { kind: 'part', style: a.alias.slice(0, 3) };
}

/** The parts to show: a search looks through every part, otherwise the chosen group. */
export function listParts(parts: PartAlias[], group: Group, query: string): PartAlias[] {
  const visible = parts.filter((a) => groupOf(a) !== null);
  const q = query.trim().toLowerCase();
  if (q) return visible.filter((a) => a.alias.toLowerCase().includes(q) || a.description.toLowerCase().includes(q) || a.libId.toLowerCase().includes(q));
  if (group === 'All') return visible;
  if (group === 'Basic') return BASIC.flatMap((n) => visible.find((a) => a.alias === n) ?? []);
  return visible.filter((a) => groupOf(a) === group);
}

export const iconHtml = (a: PartAlias, fp: PartFootprint | undefined, kind: ResistorKind) => partIcon(iconFor(a, fp), kind, () => 'red');

export const tileHtml = (a: PartAlias, fp: PartFootprint | undefined, kind: ResistorKind, armed: boolean) =>
  `<button type="button" class="ws-tile${armed ? ' is-armed' : ''}" data-alias="${esc(a.alias)}" title="${esc(a.description)}">${iconHtml(a, fp, kind)}<span>${esc(a.alias)}</span></button>`;

export const trayHtml = () =>
  '<input type="search" class="ws-search" placeholder="Search parts (/)" aria-label="Search parts" spellcheck="false">' +
  `<div class="ws-chips">${GROUPS.map((g) => `<button type="button" class="ws-chip" data-group="${g}">${g}</button>`).join('')}</div>` +
  '<div class="ws-tiles"></div>';

// Parts that are not in the schematic yet: their pins and breadboard
// footprint, worked out from the library symbol. Pure, so the tray's choices
// are testable without a browser.

import type { LibSymbol } from '../kicad/schematic.ts';
import type { Component, DesignPin } from '../netlist.ts';

/** Every pin of every unit, unconnected: what classify() needs to pick a footprint. */
export function componentFromSymbol(lib: LibSymbol, value: string, ref = 'NEW?'): Component {
  const libName = lib.id.includes(':') ? lib.id.slice(0, lib.id.indexOf(':')) : '';
  const pins = new Map<string, DesignPin>();
  for (const list of lib.units.values()) for (const p of list) if (!pins.has(p.number)) pins.set(p.number, { num: p.number, name: p.name, type: p.type, net: '' });
  return { ref, value, lib: libName, part: lib.name, pins };
}

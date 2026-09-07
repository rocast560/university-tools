// How the board is painted, separately from where everything sits.
//
// A skin never computes a coordinate. It supplies paint and extra sibling
// markup at a handful of named points, and every member is optional: a skin
// that implements nothing renders exactly what the board has always rendered,
// byte for byte. That is what FLAT is, and why the flat path cannot drift.
//
// Only the browser ever loads the rich skin. The server renderer, the MCP
// picture, the downloads and the print sheet all go through FLAT, so none of
// them can meet a gradient or a filter that resvg cannot rasterise.

import type { BoardSpec, PlacedPart } from '../layout/types.ts';
import type { Theme } from './theme.ts';

/** Where the board sits, so a skin can paint it without recomputing it. */
export interface BoardGeom {
  /** Left edge of the slab. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** X of the last column's centre. */
  xr: number;
  board: BoardSpec;
}

export interface SkinLedState {
  /** 0..1, from the analog solver. */
  brightness: number;
  /** Above 1 the part is being driven past its rating. */
  overdrive: number;
}

export interface Skin {
  name: 'flat' | 'rich';
  /** Contents of a single <defs> block, emitted before every layer. */
  defs?(res: SkinContext, t: Theme): string;
  /** Replaces the slab rect. */
  boardSlab?(g: BoardGeom, t: Theme): string;
  /** Drawn over the slab and under the holes: grain, bevel, vignette. */
  boardOverlay?(g: BoardGeom, t: Theme): string;
  /** Replaces the centre channel rect. */
  channel?(g: BoardGeom, t: Theme): string;
  /** Replaces every per-hole circle in one go. */
  holeBands?(g: BoardGeom, t: Theme): string;
  /** A soft shadow under a part, drawn before its body. */
  contactShadow?(part: PlacedPart, mx: number, my: number, halfLen: number): string;
  /** Replaces the LED body inside the rotated group. */
  ledBody?(part: PlacedPart, state: SkinLedState, t: Theme): string;
  /** Replaces the straight lead line between an LED's two holes. */
  ledLeads?(part: PlacedPart, a: [number, number], b: [number, number]): string;
  /** Coloured light pooling on the board, drawn under the parts. */
  spillLayer?(res: SkinContext, t: Theme): string;
  /** Light in the air, drawn over the wires. */
  glowLayer?(res: SkinContext, t: Theme): string;
}

/** The slice of the layout a skin is allowed to look at. */
export interface SkinContext {
  parts: PlacedPart[];
  board: BoardSpec;
  /** LED reference -> its live state, when a simulation is running. */
  leds: Record<string, SkinLedState>;
}

/** The absence of a skin: every hook unimplemented. */
export const FLAT: Skin = { name: 'flat' };

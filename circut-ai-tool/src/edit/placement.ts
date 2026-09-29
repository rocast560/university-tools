// Pure rules for putting a part's legs into breadboard holes: which holes are
// taken, what a leg would short or join, and where a quarter turn puts a
// two-lead part. No DOM and no three, so every rule is a unit test away and
// the 3D editor, the tray and any future MCP tool all judge a placement the
// same way.

import { isRail, stripOf } from '../layout/board.ts';
import type { BoardSpec, Hole, Row } from '../layout/types.ts';
import type { Design } from '../netlist.ts';
import type { LayoutDoc } from '../pipeline.ts';

export type Tone = 'ok' | 'join' | 'bad';
export interface Tint {
  hole: Hole;
  tone: Tone;
  /** The net a 'join' leg would join, or the net a 'bad' leg would short to. */
  label?: string;
}
export interface Verdict {
  ok: boolean;
  /** The first reason the placement is refused, in words a user can act on. */
  reason: string | null;
  tints: Tint[];
}

/** Every row top to bottom, so a turn can be done in whole row steps. */
export const ROW_ORDER: Row[] = ['T+', 'T-', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'B-', 'B+'];

const short = (net: string) => net.split('/').filter(Boolean).pop() ?? net;
const name = (h: Hole) => `${h.row}${h.col}`;

export function inBoard(h: Hole, board: BoardSpec): boolean {
  if (h.col < 1 || h.col > board.cols) return false;
  return !(isRail(h.row) && h.col % board.railGapEvery === 0);
}

/**
 * The nets each strip already carries: from every leg on the board except
 * those of `except`, and from the supply leads on the rails. Wires are left
 * out on purpose: the engine re-routes them after any move, so a jumper
 * landing in a strip today says nothing about where it will land tomorrow.
 */
export function stripNets(doc: LayoutDoc, design: Design, except: string | null): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (h: Hole, net: string) => {
    if (!net) return;
    const k = stripOf(h);
    let s = out.get(k);
    if (!s) out.set(k, (s = new Set()));
    s.add(net);
  };
  for (const [ref, pins] of Object.entries(doc.pinHoles)) {
    if (ref === except) continue;
    const comp = design.components.get(ref);
    for (const [pin, h] of Object.entries(pins)) add(h, comp?.pins.get(pin)?.net ?? '');
  }
  for (const lead of doc.supply?.leads ?? []) add(lead.hole, lead.net);
  return out;
}

/** Hole name -> the part whose leg is in it, for every part but `except`. */
export function takenHoles(doc: LayoutDoc, except: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const [ref, pins] of Object.entries(doc.pinHoles)) {
    if (ref === except) continue;
    for (const h of Object.values(pins)) out.set(name(h), ref);
  }
  return out;
}

/**
 * Whether `ref`'s legs may go in `holes`, with a tint for every leg. A leg
 * whose pin has no net yet (a part fresh from the tray) joins whatever its
 * strip carries; a leg with a net may only share a strip with that net.
 */
export function validatePlacement(doc: LayoutDoc, design: Design, ref: string, holes: Record<string, Hole>, netOf?: (pin: string) => string): Verdict {
  const comp = design.components.get(ref);
  const net = netOf ?? ((pin: string) => comp?.pins.get(pin)?.net ?? '');
  const nets = stripNets(doc, design, ref);
  const taken = takenHoles(doc, ref);
  const tints: Tint[] = [];
  let reason: string | null = null;
  const fail = (why: string) => {
    reason ??= why;
  };
  /** Strip -> the net of the first of this part's own legs placed in it. */
  const mine = new Map<string, string>();
  for (const [pin, h] of Object.entries(holes)) {
    let tone: Tone = 'ok';
    let label: string | undefined;
    const n = net(pin);
    if (!inBoard(h, doc.board)) {
      tone = 'bad';
      fail(`pin ${pin} would be off the board at ${name(h)}`);
    } else if (taken.has(name(h))) {
      tone = 'bad';
      fail(`hole ${name(h)} is taken by ${taken.get(name(h))}`);
    } else {
      const k = stripOf(h);
      const there = [...(nets.get(k) ?? [])].filter((x) => x !== n);
      if (there.length && n) {
        tone = 'bad';
        label = there[0];
        fail(`pin ${pin} would short ${short(n)} to ${short(there[0])} at ${name(h)}`);
      } else if (there.length) {
        tone = 'join';
        label = there[0];
      }
      const prev = mine.get(k);
      if (prev !== undefined && prev !== n) {
        tone = 'bad';
        fail(`${ref}'s pins would short each other in one strip (${short(prev) || 'unconnected'} and ${short(n) || 'unconnected'})`);
      }
      mine.set(k, n);
    }
    tints.push({ hole: h, tone, label });
  }
  const pkg = doc.packages.find((p) => p.id === ref);
  if (pkg?.kind === 'dip' && Object.values(holes).some((h) => h.row !== 'e' && h.row !== 'f')) fail(`${ref} has to straddle the centre channel (rows e and f)`);
  return { ok: reason === null, reason, tints };
}

/**
 * A quarter turn clockwise, as seen from above, about pin 1, in whole column
 * and row steps. Null when the turned leg would leave the rows altogether.
 * Whether the result is sensible (a part stood inside one half shorts itself)
 * is validatePlacement's call, not this one's.
 */
export function rotateLead2(holes: Record<string, Hole>, pins: [string, string]): Record<string, Hole> | null {
  const [p1, p2] = pins;
  const a = holes[p1];
  const b = holes[p2];
  const ra = ROW_ORDER.indexOf(a.row);
  const dc = b.col - a.col;
  const dr = ROW_ORDER.indexOf(b.row) - ra;
  // Screen axes: x to the right, rows downward. Clockwise takes (dx, dy) to (-dy, dx).
  const row = ROW_ORDER[ra + dc];
  if (!row) return null;
  return { [p1]: { ...a }, [p2]: { col: a.col - dr, row } };
}

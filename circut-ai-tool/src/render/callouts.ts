// Callouts: what the board points at so nothing gets missed. Every part or
// wire the highlight picks out (a Show group, a hovered net, the build step)
// gets a red ring; targets bunched together share one arrow and a count, so a
// row of six resistors reads as "x6 here" rather than six arrows on top of
// each other. Pure geometry; the renderer draws it and CSS animates it.

import type { EngineResult } from '../layout/engine.ts';
import type { Hole } from '../layout/types.ts';
import { placeAt } from './geometry.ts';
import type { Highlight } from './index.ts';
import { groupRefs } from './index.ts';
import { packageRects } from './ortho.ts';

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Ring {
  /** The part or wire this ring belongs to; a wire has a ring at each end. */
  id: string;
  kind: 'part' | 'wire';
  box: Box;
}

export interface Cluster {
  box: Box;
  /** How many parts or wires, not rings: a wire with both ends here counts once. */
  count: number;
  kind: 'part' | 'wire';
}

/** Smallest ring drawn, so a lead or a short hop is never too small to see. */
const MIN = 16;
/** Air between a target and its ring. */
const PAD = 5;
/** Targets whose rings come this close share one arrow... */
const NEAR = 30;
/** ...as long as the group stays a spot you can take in at a glance. */
const SPAN = 160;

const around = (pts: [number, number][], pad: number): Box => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const b = { x1: Math.min(...xs) - pad, y1: Math.min(...ys) - pad, x2: Math.max(...xs) + pad, y2: Math.max(...ys) + pad };
  const grow = (lo: number, hi: number): [number, number] => (hi - lo >= MIN ? [lo, hi] : [(lo + hi) / 2 - MIN / 2, (lo + hi) / 2 + MIN / 2]);
  [b.x1, b.x2] = grow(b.x1, b.x2);
  [b.y1, b.y2] = grow(b.y1, b.y2);
  return b;
};

const gap = (a: Box, b: Box) => Math.max(0, a.x1 - b.x2, b.x1 - a.x2, a.y1 - b.y2, b.y1 - a.y2);
const union = (a: Box, b: Box): Box => ({ x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) });

const fits = (b: Box) => b.x2 - b.x1 <= SPAN && b.y2 - b.y1 <= SPAN;

/**
 * Group boxes that sit within NEAR of each other into spots no wider or taller
 * than SPAN, one entry per spot with its outline and how many items it holds.
 * `ids` names the item each box belongs to (several boxes may share one).
 */
export function clusterBoxes(boxes: Box[], kind: Cluster['kind'] = 'part', ids: string[] = boxes.map((_, i) => String(i))): Cluster[] {
  const spots: { box: Box; items: Set<string> }[] = [];
  boxes.forEach((b, i) => {
    let into = { box: { ...b }, items: new Set([ids[i]]) };
    // Absorb every spot this box (or what it has grown into) touches, while the result stays small.
    for (let k = spots.length - 1; k >= 0; k--) {
      const merged = union(spots[k].box, into.box);
      if (gap(spots[k].box, into.box) <= NEAR && fits(merged)) {
        into = { box: merged, items: new Set([...spots[k].items, ...into.items]) };
        spots.splice(k, 1);
      }
    }
    spots.push(into);
  });
  return spots.map((s) => ({ box: s.box, count: s.items.size, kind }));
}

/** What to ring and where to point for a highlight; empty when there is none. */
export function callouts(res: Pick<EngineResult, 'parts' | 'packages' | 'wires' | 'board'>, hl: Highlight | null): { rings: Ring[]; clusters: Cluster[] } {
  if (!hl) return { rings: [], clusters: [] };
  const at = (h: Hole) => placeAt(res.board, h);
  const rects = packageRects(res.packages, res.board);
  const partRing = (id: string): Ring | null => {
    const pi = res.packages.findIndex((p) => p.id === id);
    if (pi >= 0) {
      const r = rects[pi];
      return { id, kind: 'part', box: around([[r.x1, r.y1], [r.x2, r.y2]], PAD) };
    }
    const part = res.parts.find((p) => p.id === id);
    return part ? { id, kind: 'part', box: around(part.holes.map(at), PAD + 3) } : null;
  };
  // A wire is rung at both ends, where it goes in: a ring round a long jumper
  // would cover half the board and point at nothing.
  const wireRings = (i: number): Ring[] => {
    const w = res.wires[i];
    return w ? [w.a, w.b].map((h) => ({ id: `wire${i}`, kind: 'wire' as const, box: around([at(h)], PAD) })) : [];
  };

  let rings: Ring[] = [];
  if (hl.group) rings = [...groupRefs(res, hl.group)].map(partRing).filter((r): r is Ring => !!r);
  else if (hl.net !== undefined) rings = res.wires.flatMap((w, i) => (w.net === hl.net ? wireRings(i) : []));
  else if (hl.wire !== undefined) rings = wireRings(hl.wire);
  else if (hl.ref !== undefined) rings = [partRing(hl.ref)].filter((r): r is Ring => !!r);
  const kind = rings[0]?.kind ?? 'part';
  return { rings, clusters: clusterBoxes(rings.map((r) => r.box), kind, rings.map((r) => r.id)) };
}

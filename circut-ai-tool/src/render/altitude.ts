// How high each jumper flies, once the other jumpers are taken into account.
//
// The sideways bow in routing.ts gives every wire its own lane along a shared
// corridor, and archHeight lifts a wire over the chips beneath it. Neither
// looks at the other wires, so two jumpers crossing at right angles were both
// drawn at the height their own obstacles demanded and ran straight through
// each other. On a busy board that is the difference between a picture you can
// trace and a plate of spaghetti.
//
// This module is the third pass: find where wires cross in plan, and lift one
// of each crossing pair until there is daylight between them. Wires are only
// ever raised, never lowered, so a lift here can never drop a jumper into the
// chip that archHeight raised it over.
//
// Pure and deterministic, and it touches nothing the flat SVG is drawn from:
// heights exist only in 3D, so the flat board's byte-for-byte output is not
// affected by anything here.

/** A point in plan, in the same units the flat board is drawn in. */
export type Point = [number, number];

/** Where a jumper's ends sit: just inside the socket, below the board face. */
export const WIRE_END_Y = -4;

/**
 * The tallest loop worth drawing. A jumper that would have to go higher than
 * this to clear something is one a builder would reroute, and drawing a 20 mm
 * arch over the board says less than letting it brush past.
 */
export const MAX_ARCH = 150;

/** Air left between two jumpers where they cross. Two 4-unit jackets plus room. */
export const CROSS_GAP = 10;

/** How close two wires have to come in plan before their heights matter. */
const NEAR_XZ = 9;

/** Samples per curve when looking for crossings. */
const STEPS = 28;

/**
 * Passes over the whole crossing list. Lifting one wire can push it into a
 * third, so the list is walked more than once; boards settle in two or three,
 * and the ceiling stops a pathological one from running away.
 */
const PASSES = 6;

/** Below this the curve is too near its ends to be lifted usefully. */
const MIN_SHARE = 0.08;

/** One jumper as the planner sees it: where it runs, and how high it starts. */
export interface Span {
  a: Point;
  b: Point;
  /** The quadratic control point the flat board bows through. */
  control: Point;
  /** Control height that already clears the parts underneath. */
  height: number;
}

/** Where a jumper runs in plan at t along its curve. */
export function planAt(s: Span, t: number): Point {
  const u = 1 - t;
  return [u * u * s.a[0] + 2 * u * t * s.control[0] + t * t * s.b[0], u * u * s.a[1] + 2 * u * t * s.control[1] + t * t * s.b[1]];
}

/** How high a jumper drawn with this control height actually runs at t. */
export function archY(height: number, t: number): number {
  const u = 1 - t;
  return 3 * t * u * height + WIRE_END_Y * (u ** 3 + t ** 3);
}

/** What one unit of control height is worth at t: the curve's own leverage. */
const share = (t: number) => 3 * t * (1 - t);

/** Where two jumpers meet, as a position along each of their curves. */
interface Meeting {
  i: number;
  j: number;
  ti: number;
  tj: number;
}

/**
 * Every place two wires come within touching distance in plan.
 *
 * Sampling beats solving here: the curves are quadratics, but what matters is
 * a near miss as much as a true intersection, and a wire that merely grazes
 * another needs the same daylight as one that crosses it outright. Only the
 * closest approach in each run of near samples is kept, so a pair that runs
 * alongside for a while yields one meeting rather than thirty.
 */
function meetings(spans: Span[]): Meeting[] {
  const plans = spans.map((s) => Array.from({ length: STEPS + 1 }, (_, k) => planAt(s, k / STEPS)));
  // A box round each wire, so most pairs are rejected without touching samples.
  const boxes = plans.map((p) => ({
    x0: Math.min(...p.map((q) => q[0])),
    x1: Math.max(...p.map((q) => q[0])),
    z0: Math.min(...p.map((q) => q[1])),
    z1: Math.max(...p.map((q) => q[1])),
  }));

  const out: Meeting[] = [];
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const bi = boxes[i];
      const bj = boxes[j];
      if (bi.x1 + NEAR_XZ < bj.x0 || bj.x1 + NEAR_XZ < bi.x0 || bi.z1 + NEAR_XZ < bj.z0 || bj.z1 + NEAR_XZ < bi.z0) continue;
      // The closest sample pair, and whether anything was near at all.
      let best = Infinity;
      let bi2 = -1;
      let bj2 = -1;
      for (let m = 0; m <= STEPS; m++) {
        for (let n = 0; n <= STEPS; n++) {
          const d = Math.hypot(plans[i][m][0] - plans[j][n][0], plans[i][m][1] - plans[j][n][1]);
          if (d < best) {
            best = d;
            bi2 = m;
            bj2 = n;
          }
        }
      }
      if (best <= NEAR_XZ) out.push({ i, j, ti: bi2 / STEPS, tj: bj2 / STEPS });
    }
  }
  return out;
}

/**
 * The height each jumper should fly at so no two of them run through each
 * other, given the heights that already clear the parts below.
 *
 * Of each crossing pair the wire that is already higher goes over, so the
 * lower one keeps the run it was given and the board keeps whatever shape
 * archHeight chose. Ties go to the later wire, which makes the result depend
 * on the wire list alone.
 */
export function liftCrossings(spans: Span[], gap = CROSS_GAP, ceiling = MAX_ARCH): number[] {
  const heights = spans.map((s) => Math.min(s.height, ceiling));
  const meets = meetings(spans);
  if (!meets.length) return heights;

  for (let pass = 0; pass < PASSES; pass++) {
    let moved = false;
    for (const m of meets) {
      const yi = archY(heights[m.i], m.ti);
      const yj = archY(heights[m.j], m.tj);
      if (Math.abs(yi - yj) >= gap) continue;
      // Whoever is higher goes over. Level pegging hands it to the later wire.
      const overIsI = yi > yj || (yi === yj && m.i > m.j);
      const over = overIsI ? m.i : m.j;
      const t = overIsI ? m.ti : m.tj;
      const lift = share(t);
      // Too close to a socket to gain height from a taller control point.
      if (lift < MIN_SHARE) continue;
      const target = (overIsI ? yj : yi) + gap;
      const wanted = heights[over] + (target - (overIsI ? yi : yj)) / lift;
      const next = Math.min(wanted, ceiling);
      if (next > heights[over] + 1e-9) {
        heights[over] = next;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return heights;
}

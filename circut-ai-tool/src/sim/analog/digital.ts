// The electrical behaviour of a logic pin: what voltage an output actually
// produces, what a chip reads back as a level, and what an input costs the
// thing driving it.
//
// The existing DC table in src/parts/gates.ts holds worst-case datasheet
// limits, which are the right numbers for a fan-out check and the wrong ones
// for a solver: "Voh min 2.7 V at Ioh 0.4 mA" implies a 1750 ohm output
// resistance, which no totem-pole output has. The values here are typical
// ones chosen to give the right currents, and the tests pin them against the
// datasheet limits they have to stay inside.

export type Family = 'LS' | 'HC';

export interface DriveSpec {
  /** Open-circuit output voltage when high; null means "the Vcc node". */
  voh: number | null;
  roh: number;
  vol: number;
  rol: number;
  /** Fixed TTL input thresholds, in volts. */
  vih: number;
  vil: number;
  /** CMOS thresholds, as a fraction of Vcc. */
  vihFrac: number | null;
  vilFrac: number | null;
  /**
   * Input structure, as a single resistance from the pin up to the chip's Vcc
   * node. See inputLoad() for why it is modelled this way.
   */
  inputToVcc: number;
}

export const DRIVE: Record<Family, DriveSpec> = {
  // 12.5k puts Iil at 5/12500 = 0.4 mA, the LS datasheet figure.
  LS: { voh: 3.6, roh: 160, vol: 0.1, rol: 35, vih: 2.0, vil: 0.8, vihFrac: null, vilFrac: null, inputToVcc: 12.5e3 },
  HC: { voh: null, roh: 40, vol: 0, rol: 40, vih: 0, vil: 0, vihFrac: 0.7, vilFrac: 0.3, inputToVcc: 1e8 },
};

/** Thresholds for a family at a given supply. */
function thresholds(fam: Family, vcc: number): { vih: number; vil: number } {
  const d = DRIVE[fam];
  return d.vihFrac === null ? { vih: d.vih, vil: d.vil } : { vih: d.vihFrac * vcc, vil: d.vilFrac! * vcc };
}

/**
 * What a chip reads on an input pin. Between the two thresholds the level is
 * genuinely undefined, and the pin keeps whatever it had: that hysteresis is
 * what lets a latch settle into the state it is actually in instead of
 * oscillating, and it is the only reason the outer mixed loop terminates on
 * circuits with feedback.
 */
export function readLevel(volts: number, vcc: number, fam: Family, last: 0 | 1): 0 | 1 {
  const { vih, vil } = thresholds(fam, vcc);
  if (volts >= vih) return 1;
  if (volts <= vil) return 0;
  return last;
}

/** Seed a level before there is any history, on the first solve. */
export function initialLevel(volts: number, vcc: number, fam: Family): 0 | 1 {
  const { vih, vil } = thresholds(fam, vcc);
  return volts > (vih + vil) / 2 ? 1 : 0;
}

/** The Thevenin source a driven output presents, referred to the chip's ground. */
export function driveOf(level: 0 | 1, fam: Family, vcc: number): { volts: number; rout: number } {
  const d = DRIVE[fam];
  if (level === 1) return { volts: d.voh ?? vcc, rout: d.roh };
  return { volts: d.vol, rout: d.rol };
}

/**
 * The load an input puts on whatever drives it: one resistance from the pin up
 * to the chip's Vcc node.
 *
 * A 74LS input is the emitter of an input transistor, so current flows out of
 * the pin when you hold it low and essentially stops when you let it rise.
 * A resistor to Vcc reproduces all three cases that matter, and stays linear:
 *
 *   driven to 0 V  -> sources Vcc/R = 0.4 mA back out of the pin, which is Iil
 *   driven to Vcc  -> carries nothing, which is close enough to the 20 uA Iih
 *   left floating  -> drifts up to Vcc and reads high, matching the boolean
 *                     simulator's "an open TTL input reads high"
 *
 * A piecewise current source keyed on the pin's level looks more faithful but
 * is worse on every count: it puts a floating input at a large negative
 * voltage, because nothing in that model stops the sink term running away, and
 * it adds a discrete state to the outer loop for no gain.
 */
export function inputLoad(fam: Family): { ohmsToVcc: number } {
  return { ohmsToVcc: DRIVE[fam].inputToVcc };
}

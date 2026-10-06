import { describe, expect, test } from 'bun:test';
import { wireShape } from '../client/wiretube-math.ts';
import { routeWires, WIRE_R } from '../src/render/route3d.ts';
import { docs } from './route-fixtures.ts';

const OPTS = { base: WIRE_R, endY: -4, top: 0, radius: WIRE_R, core: 2.1, sides: 10, coreSides: 8 };

describe('vertex budget on lab3', () => {
  test('mean per wire and worst wire stay small, jacket plus tin', () => {
    const routes = routeWires(docs.lab3).routes;
    const counts = routes.map((r) => {
      const w = wireShape(r.plan, r.lifts, OPTS);
      return (w.jacket.positions.length + w.tin.positions.length) / 3;
    });
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const worst = Math.max(...counts);
    console.log(`lab3 wires=${counts.length} total=${counts.reduce((a, b) => a + b, 0)} mean=${mean.toFixed(1)} worst=${worst}`);
    // Measured with full fidelity (15 degree bends, 10-sided jacket, 8-sided tin, ramps unfilleted):
    // mean 669.8, worst 1912 with every hump one diameter high. Stacked humps (a hump over a wire that
    // is itself humping) and the valley samples between overlapping humps brought that to mean 709.2,
    // worst 2154. The limits are the first figures plus about 15%. They are not a target: they exist
    // to catch a regression such as filleting every hump ramp like a full bend (mean 926, worst 3489),
    // or steepening a taller hump instead of lengthening it (worst about 2700).
    expect(mean).toBeLessThanOrEqual(770);
    expect(worst).toBeLessThanOrEqual(2200);
  });
});

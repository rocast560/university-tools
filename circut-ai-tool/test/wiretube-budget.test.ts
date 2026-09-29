import { describe, expect, test } from 'bun:test';
import { wireShape } from '../client/wiretube-math.ts';
import { routeWires, WIRE_R } from '../src/render/route3d.ts';
import { docs } from './route-fixtures.ts';

const OPTS = { base: WIRE_R, endY: -4, top: 0, radius: WIRE_R, core: 2.1, sides: 8, coreSides: 6 };

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
    expect(mean).toBeLessThanOrEqual(450);
    expect(worst).toBeLessThanOrEqual(1200);
  });
});

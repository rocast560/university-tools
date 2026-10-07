import { describe, expect, test } from 'bun:test';
import { applyFrame, bodyPlacement, chooseFrame, isLegMaterial, KIT_MODELS, modelKeyFor, validateManifest, type ModelInfo } from '../src/models/manifest.ts';

const info = (pads: Record<string, [number, number]>): ModelInfo => ({ file: 'x.glb', footprint: 'X', pads, box: { min: [0, 0, 0], max: [1, 1, 1] } });
const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);

describe('model keys', () => {
  test('kit parts map to their models; other parts to none', () => {
    expect(modelKeyFor('dip', undefined, 14)).toBe('dip14');
    expect(modelKeyFor('dip', undefined, 16)).toBe('dip16');
    expect(modelKeyFor('dipswitch', undefined, 14, 7)).toBe('dipswitch7');
    expect(modelKeyFor('sevenseg', undefined, 10)).toBe('seg056');
    // A display with another pin count is another package: no body rather than the wrong one.
    expect(modelKeyFor('sevenseg', undefined, 14)).toBeNull();
    expect(modelKeyFor('lead2', 'LED', 2)).toBe('led5');
    expect(modelKeyFor('lead2', 'R', 2)).toBe('r0207');
    expect(modelKeyFor('lead2', 'C', 2)).toBeNull();
    expect(modelKeyFor('dip', undefined, 8)).toBeNull();
    expect(Object.keys(KIT_MODELS).sort()).toEqual(['dip14', 'dip16', 'dipswitch7', 'led5', 'r0207', 'seg056']);
  });
});

describe('leg material', () => {
  test('the dark body is kept and the light metal is a leg', () => {
    expect(isLegMaterial({ color: [0.019, 0.018, 0.018] })).toBe(false);
    expect(isLegMaterial({ color: [0.645, 0.638, 0.572] })).toBe(true);
    expect(isLegMaterial({ color: [0.2, 0.2, 0.2], metallic: 0.9 })).toBe(true);
  });
  test('a coloured body (tan resistor, red switch, LED dome) is not a leg', () => {
    expect(isLegMaterial({ color: [0.85, 0.75, 0.55] })).toBe(false);
    expect(isLegMaterial({ color: [0.75, 0.1, 0.1] })).toBe(false);
  });
});

describe('frames', () => {
  test('chooseFrame finds the frame that puts the pads where the footprint says', () => {
    const expected = { '1': [0, 0] as [number, number], '2': [0, 2.54] as [number, number], '8': [7.62, 15.24] as [number, number] };
    const found = { '1': [0, 0] as [number, number], '2': [0, -2.54] as [number, number], '8': [7.62, -15.24] as [number, number] };
    expect(chooseFrame(found, expected)).toBe('flipZ');
    expect(applyFrame('flipZ', [7.62, 15.24])).toEqual([7.62, -15.24]);
  });
  test('chooseFrame refuses when no frame matches the pads', () => {
    expect(() => chooseFrame({ '1': [0, 0], '2': [5, 5] }, { '1': [0, 0], '2': [0, 2.54] })).toThrow(/no frame fits/);
  });
});

describe('bodyPlacement', () => {
  test('bodyPlacement turns the model to follow pad 1 → pad 2', () => {
    // Model pads along +z; board holes along +x: a quarter turn.
    // Pads away from the origin, so landing on the holes is a real check.
    const p = bodyPlacement(info({ '1': [1, 1], '2': [1, 3.54] }), '1', '2', [100, 50], [100 + 2.54 * 7, 50], 7);
    close(Math.abs(p.rotationY), Math.PI / 2);
    // three.js turns (x, z) about +y by θ to (x cosθ + z sinθ, −x sinθ + z cosθ).
    const c = Math.cos(p.rotationY), s = Math.sin(p.rotationY);
    const land = ([x, z]: [number, number]) => [p.x + (x * c + z * s) * 7, p.z + (-x * s + z * c) * 7];
    const [x1, z1] = land([1, 1]);
    const [x2, z2] = land([1, 3.54]);
    close(x1, 100);
    close(z1, 50);
    close(x2, 100 + 2.54 * 7);
    close(z2, 50);
  });
  test('a resistor body centres between its holes whatever their spacing', () => {
    const r = info({ '1': [0, 0], '2': [10.16, 0] });
    const p = bodyPlacement(r, '1', '2', [0, 0], [200, 0], 7);
    // The pads' midpoint (5.08 mm → 35.56 units) sits on the holes' midpoint (100).
    close(p.x + 5.08 * 7, 100);
    close(p.rotationY, 0);
  });
});

describe('bodyPlacement on every hole', () => {
  // The 10-pin display: pins 1-5 down x = 0, 6-10 back up x = 15.24 mm.
  const seg = info({ '1': [0, 0], '2': [0, 2.54], '3': [0, 5.08], '4': [0, 7.62], '5': [0, 10.16], '6': [15.24, 10.16], '7': [15.24, 7.62], '8': [15.24, 5.08], '9': [15.24, 2.54], '10': [15.24, 0] });
  // On the board the rows are 72 units apart (rows d and g), not the 108 units 15.24 mm would be.
  const mm = 18 / 2.54;
  const holes: Record<string, [number, number]> = {};
  for (let i = 0; i < 5; i++) {
    holes[String(i + 1)] = [500 + i * 18, 610];
    holes[String(10 - i)] = [500 + i * 18, 538];
  }
  const p = bodyPlacement(seg, '1', '2', holes['1'], holes['2'], mm, holes);
  const land = ([x, z]: [number, number]) => {
    const c = Math.cos(p.rotationY), s = Math.sin(p.rotationY);
    const [sx, sz] = [x * p.sx, z * p.sz];
    return [p.x + (sx * c + sz * s) * mm, p.z + (-sx * s + sz * c) * mm];
  };

  test('every pad lands on its hole, the far row too', () => {
    for (const [pin, pad] of Object.entries(seg.pads)) {
      const [x, z] = land(pad);
      close(x, holes[pin][0]);
      close(z, holes[pin][1]);
    }
  });
  test('the squeeze is across the rows only: the model x, by the drawn gap over the real one', () => {
    close(p.sx, 72 / (15.24 * mm));
    close(p.sz, 1);
  });
});

describe('validateManifest', () => {
  test('accepts a well-formed manifest and names the bad field otherwise', () => {
    const ok = { version: 1, models: { dip14: { file: 'dip14.glb', footprint: 'Package_DIP:DIP-14_W7.62mm', pads: { '1': [0, 0], '2': [0, 2.54] }, box: { min: [0, 0, 0], max: [1, 1, 1] } } } };
    expect(validateManifest(ok).models.dip14?.file).toBe('dip14.glb');
    expect(() => validateManifest({ version: 2, models: {} })).toThrow(/version/);
    expect(() => validateManifest({ version: 1, models: { dip14: { file: 3 } } })).toThrow(/dip14/);
    expect(() => validateManifest({ version: 1, models: { nope: ok.models.dip14 } })).toThrow(/nope/);
  });
});

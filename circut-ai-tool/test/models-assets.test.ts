import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { KIT_MODELS, validateManifest } from '../src/models/manifest.ts';

const dir = new URL('../public/models/', import.meta.url);

describe('committed part models', () => {
  test('the manifest is valid and lists every kit model', () => {
    const m = validateManifest(JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')));
    expect(Object.keys(m.models).sort()).toEqual(Object.keys(KIT_MODELS).sort());
  });
  test('every listed model file exists, is a GLB and is small', () => {
    const m = validateManifest(JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')));
    for (const info of Object.values(m.models)) {
      const f = new URL(info!.file, dir);
      expect(existsSync(f)).toBe(true);
      expect(readFileSync(f).subarray(0, 4).toString()).toBe('glTF');
      expect(statSync(f).size).toBeLessThan(400_000);
    }
  });
  test('pad 1 is the origin and boxes are real bodies', () => {
    const m = validateManifest(JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')));
    for (const [key, info] of Object.entries(m.models)) {
      expect(info!.pads['1'], key).toEqual([0, 0]);
      const [x0, y0, z0] = info!.box.min, [x1, y1, z1] = info!.box.max;
      expect(x1 - x0 > 1 && y1 - y0 > 0.5 && z1 - z0 > 1, key).toBe(true);
    }
  });
  test('the KiCad license note ships with the models', () => {
    expect(readFileSync(new URL('LICENSE-KiCad-3D.md', dir), 'utf8')).toMatch(/CC-BY-SA 4\.0/);
  });
});

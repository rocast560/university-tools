import { describe, expect, test } from 'bun:test';
import { cachedModels } from '../client/editor3d/modelcache.ts';
import type { ModelSet } from '../client/models.ts';

const some: ModelSet = { keys: ['dip14'], body: () => null };

describe('cachedModels', () => {
  test('loads once and shares the set', async () => {
    let loads = 0;
    const get = cachedModels(async () => (loads++, some));
    expect(await get()).toBe(some);
    expect(await get()).toBe(some);
    expect(loads).toBe(1);
  });

  test('a failed load (the chunk gone after a redeploy) is no models, warned once, and tried again next time', async () => {
    let loads = 0;
    const warnings: unknown[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a);
    try {
      const get = cachedModels(() => (loads++ < 2 ? Promise.reject(new Error('chunk 404')) : Promise.resolve(some)));
      const first = await get();
      expect(first.keys).toEqual([]);
      expect(first.body('dip14')).toBeNull();
      expect((await get()).keys).toEqual([]);
      expect(await get()).toBe(some);
      expect(loads).toBe(3);
      expect(warnings.length).toBe(1);
    } finally {
      console.warn = warn;
    }
  });

  test('an empty set does not stick either', async () => {
    let loads = 0;
    const get = cachedModels(async () => (loads++ ? some : { keys: [], body: () => null }));
    expect((await get()).keys).toEqual([]);
    expect(await get()).toBe(some);
  });
});

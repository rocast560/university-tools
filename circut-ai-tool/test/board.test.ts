import { describe, expect, test } from 'bun:test';
import { Board, Occupancy, halfOf, hole, holeKey, holeName, isRail, parseHole, stripOf } from '../src/layout/board.ts';
import { emptySidecar, normalizeSidecar, normalizeWirePath } from '../src/layout/types.ts';

describe('holes and strips', () => {
  test('naming', () => {
    expect(stripOf(hole(12, 'c'))).toBe('T12');
    expect(stripOf(hole(12, 'h'))).toBe('B12');
    expect(stripOf(hole(3, 'T+'))).toBe('T+');
    expect(isRail('B-')).toBe(true);
    expect(halfOf('j')).toBe('B');
    expect(holeKey(hole(7, 'a'))).toBe('a7');
    expect(holeName(hole(7, 'a'))).toBe('a7');
    expect(holeName(hole(3, 'T+'))).toBe('top + rail, column 3');
    expect(parseHole('f12')).toEqual({ col: 12, row: 'f' });
    expect(parseHole('B-4')).toEqual({ col: 4, row: 'B-' });
    expect(() => parseHole('k1')).toThrow();
  });
});

describe('Board', () => {
  test('rails skip every sixth column and split on full boards', () => {
    const half = new Board(30, 'half', null, 6);
    expect(half.railExists(6)).toBe(false);
    expect(half.railExists(7)).toBe(true);
    expect(half.inBounds(hole(31, 'a'))).toBe(false);
    expect(half.railNode('T+', 5)).toBe('T+');
    const full = new Board(63, 'full', 30, 6);
    expect(full.railNode('T+', 30)).toBe('T+L');
    expect(full.railNode('T+', 31)).toBe('T+R');
  });
});

describe('Occupancy', () => {
  test('one owner per hole', () => {
    const occ = new Occupancy();
    occ.claim(hole(1, 'a'), 'R1');
    expect(occ.isFree(hole(1, 'a'))).toBe(false);
    expect(occ.owner(hole(1, 'a'))).toBe('R1');
    expect(() => occ.claim(hole(1, 'a'), 'R2')).toThrow(/a1 needed by R2 is already used by R1/);
  });
});

describe('sidecar', () => {
  test('normalize fills defaults and drops malformed holes', () => {
    const s = normalizeSidecar({ pinned: { R1: { '1': { col: 3, row: 'a' }, '2': { col: 'x', row: 'zz' } } }, colors: { '/A': '#123456' } });
    expect(s.options).toEqual(emptySidecar().options);
    expect(s.pinned).toEqual({ R1: { '1': { col: 3, row: 'a' } } });
    expect(s.colors['/A']).toBe('#123456');
    expect(s.placed).toEqual({});
  });

  test('wire shapes: an old sidecar has none, good ones are kept, malformed ones dropped', () => {
    expect(normalizeSidecar({ pinned: {} }).wirePaths).toEqual({});
    expect(emptySidecar().wirePaths).toEqual({});
    const good = { points: [{ col: 12.5, gap: 'c|d', lane: 0 }, { col: 20, gap: 'e|f', lane: -1 }] };
    const s = normalizeSidecar({
      wirePaths: {
        '/A|a12|e20': good,
        '/B|a1|a2': { points: [{ col: 'x', gap: 'c|d', lane: 0 }] },
        '/C|a1|a3': { points: [{ col: 3, gap: 'c|d', lane: 0.5 }] },
        '/D|a1|a4': 'nope',
      },
    });
    expect(s.wirePaths).toEqual({ '/A|a12|e20': good });
    expect(normalizeWirePath({ points: [] })).toEqual({ points: [] });
    expect(normalizeWirePath({ points: [{ col: 3, gap: 'c|d', lane: 9 }] })).toBeNull();
  });

  test('wire shapes: a "__proto__", "constructor" or "prototype" key in the file is skipped, never set as the prototype', () => {
    const good = { points: [{ col: 12.5, gap: 'c|d', lane: 0 }] };
    // As it arrives from disk: JSON.parse makes "__proto__" an ordinary own key.
    const raw = JSON.parse(`{"wirePaths": {"__proto__": ${JSON.stringify(good)}, "constructor": ${JSON.stringify(good)}, "prototype": ${JSON.stringify(good)}, "/A|a12|e20": ${JSON.stringify(good)}}}`);
    const s = normalizeSidecar(raw);
    expect(Object.getPrototypeOf(s.wirePaths)).toBe(Object.prototype);
    expect(Object.keys(s.wirePaths)).toEqual(['/A|a12|e20']);
    expect((s.wirePaths as Record<string, unknown>).points).toBeUndefined();
  });
});

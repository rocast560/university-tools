import { describe, expect, test } from 'bun:test';
import { shiftHoles } from '../client/drag.ts';
import { layout } from '../src/layout/engine.ts';
import { emptySidecar, type BoardSpec } from '../src/layout/types.ts';
import { makeDesign } from '../src/netlist.ts';
import { placeAt, pt, svgSize, tierAtY, TIER_PITCH } from '../src/render/geometry.ts';
import { renderSvg } from '../src/render/index.ts';

const STACKED: BoardSpec = { cols: 126, kind: 'stacked', splitCol: 63, railGapEvery: 6, tiers: 2 };
const FULL: BoardSpec = { cols: 63, kind: 'full', splitCol: 30, railGapEvery: 6 };

/** Nine 74LS283s in a chain, each output pulled up: far more than one full board holds. */
function nineChips() {
  const spec: Parameters<typeof makeDesign>[0] = {};
  for (let k = 1; k <= 9; k++) {
    const pins: Record<string, [string, string, string]> = {};
    for (let n = 1; n <= 16; n++) pins[String(n)] = ['~', 'input', `unconnected-(U${k}-Pad${n})`];
    Object.assign(pins, { '16': ['VCC', 'power_in', '+5V'], '8': ['GND', 'power_in', 'GND'], '5': ['A1', 'input', `/N${k - 1}`], '4': ['S1', 'output', `/N${k}`] });
    spec[`U${k}`] = { lib: '74xx', part: '74LS283', value: '74LS283', pins };
    spec[`R${k}`] = { lib: 'Device', part: 'R', value: '1k', pins: { '1': ['~', 'passive', '+5V'], '2': ['~', 'passive', `/N${k}`] } };
  }
  return makeDesign(spec);
}

describe('stacked boards geometry', () => {
  test('a single board draws exactly where pt() says', () => {
    expect(placeAt(FULL, { col: 40, row: 'c' })).toEqual(pt({ col: 40, row: 'c' }));
  });

  test('columns 64-126 land on the second board, under columns 1-63', () => {
    const [x1, y1] = placeAt(STACKED, { col: 5, row: 'c' });
    const [x2, y2] = placeAt(STACKED, { col: 68, row: 'c' });
    expect(x2).toBe(x1);
    expect(y2 - y1).toBe(TIER_PITCH);
    expect(tierAtY(STACKED, y2)).toEqual({ tier: 1, y: y1 });
  });

  test('the picture is one board wide and two boards tall', () => {
    const one = svgSize(FULL);
    const two = svgSize(STACKED);
    expect(two.width).toBe(one.width);
    expect(two.height).toBe(one.height + TIER_PITCH);
  });

  test('dragging a part down moves it onto the second board', () => {
    const moved = shiftHoles({ '1': { col: 10, row: 'c' }, '2': { col: 13, row: 'c' } }, 0, TIER_PITCH, STACKED, false);
    expect(moved).toEqual({ '1': { col: 73, row: 'c' }, '2': { col: 76, row: 'c' } });
  });
});

describe('stacked layout', () => {
  const s = emptySidecar();
  s.options.board = 'stacked';
  const r = layout(nineChips(), s);

  test('lays the design out over two boards with the rails split between them', () => {
    expect(r.error).toBeNull();
    expect(r.unplaced).toEqual([]);
    expect(r.board).toMatchObject({ cols: 126, kind: 'stacked', splitCol: 63, tiers: 2 });
  });

  test('uses the second board, and no chip or two-lead body straddles the two', () => {
    const side = (c: number) => (c <= 63 ? 0 : 1);
    expect(r.packages.some((p) => p.col0 > 63)).toBe(true);
    for (const p of r.packages) expect(side(p.col0)).toBe(side(p.col0 + p.pins / 2 - 1));
    for (const part of r.parts) expect(new Set(part.holes.map((h) => side(h.col))).size).toBe(1);
  });

  test('renders each board as its own tier, holes named by their place in the whole run', () => {
    const svg = renderSvg(r, { wireStyle: 'orthogonal' });
    expect(svg.match(/class="tier"/g)?.length).toBe(2);
    expect(svg).toContain('data-hole="a64"');
    expect(svg).toContain('board 2');
  });
});

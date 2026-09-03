import { describe, expect, test } from 'bun:test';
import { connectivity, hasErrors, holeNode, runChecks } from '../src/checks/index.ts';
import { layout } from '../src/layout/engine.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { makeDesign, parseNetlist } from '../src/netlist.ts';
import { readFixture } from './smoke.test.ts';

const pl1 = parseNetlist(readFixture('PL1_1.net'));

describe('holeNode', () => {
  test('strips and split rails', () => {
    const full = { cols: 63, kind: 'full' as const, splitCol: 30, railGapEvery: 6 };
    expect(holeNode({ col: 12, row: 'c' }, full)).toBe('T12');
    expect(holeNode({ col: 12, row: 'T+' }, full)).toBe('T+L');
    expect(holeNode({ col: 40, row: 'B-' }, full)).toBe('B-R');
    expect(holeNode({ col: 40, row: 'B-' }, { ...full, splitCol: null })).toBe('B-');
  });
});

describe('runChecks on PL1_1', () => {
  const res = layout(pl1, emptySidecar());
  const checks = runChecks(pl1, res);

  test('the generated layout passes connectivity and power checks', () => {
    expect(checks.filter((c) => c.level === 'error')).toEqual([]);
    expect(hasErrors(checks)).toBe(false);
    expect(checks.some((c) => c.id === 'connectivity' && c.level === 'info')).toBe(true);
  });

  test('LED polarity is explained', () => {
    const led = checks.filter((c) => c.id === 'led-polarity');
    expect(led).toHaveLength(2);
    expect(led[0].level).toBe('info');
    expect(led[0].message).toMatch(/lights when .* is low/);
  });

  test('unused gate inputs are not reported as floating', () => {
    expect(checks.filter((c) => c.id === 'floating-input')).toEqual([]);
  });

  test('a removed wire breaks connectivity, a moved wire shorts nets', () => {
    const broken = { ...res, wires: res.wires.filter((w) => w.net !== '/A') };
    const c1 = runChecks(pl1, broken);
    expect(c1.some((c) => c.id === 'connectivity' && c.level === 'error' && c.message.includes('A'))).toBe(true);
    const uf = connectivity(broken);
    const holes = pl1.nets.get('/A')!.map((m) => holeNode(res.pinHoles[m.ref][m.pin], res.board));
    expect(new Set(holes.map((h) => uf.find(h))).size).toBeGreaterThan(1);

    const wA = res.wires.find((w) => w.net === '/A')!;
    const wB = res.wires.find((w) => w.net === '/B')!;
    const shorted = { ...res, wires: [...res.wires, { net: '/A', a: wA.a, b: wB.a, role: 'signal' as const }] };
    const c2 = runChecks(pl1, shorted);
    expect(c2.some((c) => c.id === 'short' && c.level === 'error')).toBe(true);
  });
});

describe('DC and polarity rules', () => {
  test('reversed LED, missing resistor, driver conflict and floating input', () => {
    const d = makeDesign({
      U1: { lib: '74xx', part: '74LS00', value: '74LS00', pins: { '1': ['~', 'input', '/A'], '2': ['~', 'input', 'unconnected-(U1-Pad2)'], '3': ['~', 'output', '/Y'], '4': ['~', 'input', '/A'], '5': ['~', 'input', '/A'], '6': ['~', 'output', '/Y'], '7': ['GND', 'power_in', 'GND'], '14': ['VCC', 'power_in', '+5V'], '8': ['~', 'output', 'unconnected-(U1-Pad8)'], '9': ['~', 'input', 'unconnected-(U1-Pad9)'], '10': ['~', 'input', 'unconnected-(U1-Pad10)'], '11': ['~', 'output', 'unconnected-(U1-Pad11)'], '12': ['~', 'input', 'unconnected-(U1-Pad12)'], '13': ['~', 'input', 'unconnected-(U1-Pad13)'] } },
      SW1: { lib: 'Switch', part: 'SW_SPST', value: 'SW_SPST', pins: { '1': ['A', 'passive', '/A'], '2': ['B', 'passive', 'GND'] } },
      R1: { lib: 'Device', part: 'R', value: '10k', pins: { '1': ['~', 'passive', '+5V'], '2': ['~', 'passive', '/A'] } },
      D1: { lib: 'Device', part: 'LED', value: 'LED', pins: { '1': ['K', 'passive', '+5V'], '2': ['A', 'passive', '/Y'] } },
    });
    const res = layout(d, emptySidecar());
    const checks = runChecks(d, res);
    expect(checks.some((c) => c.id === 'led-polarity' && c.level === 'error' && c.refs.includes('D1'))).toBe(true);
    expect(checks.some((c) => c.id === 'led-current' && c.level === 'warning' && c.message.includes('series resistor'))).toBe(true);
    expect(checks.some((c) => c.id === 'driver-conflict' && c.level === 'error')).toBe(true);
    expect(checks.some((c) => c.id === 'floating-input' && c.refs.includes('U1') && c.message.includes('pin 2'))).toBe(true);
  });

  test('LED current is computed from the series resistor', () => {
    const d = makeDesign({
      R1: { lib: 'Device', part: 'R', value: '47', pins: { '1': ['~', 'passive', '+5V'], '2': ['~', 'passive', '/LA'] } },
      D1: { lib: 'Device', part: 'LED', value: 'LED', pins: { '1': ['K', 'passive', 'GND'], '2': ['A', 'passive', '/LA'] } },
    });
    const checks = runChecks(d, layout(d, emptySidecar()));
    const cur = checks.find((c) => c.id === 'led-current')!;
    expect(cur.level).toBe('warning');
    expect(cur.message).toMatch(/64 mA/);
  });
});

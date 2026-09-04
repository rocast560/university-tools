import { describe, expect, it } from 'vitest';
import { principalAxes, renderStructureSvg } from './render3d.ts';
import { molfileToStructure, smilesToMolfile3D } from './structure.ts';

describe('principalAxes', () => {
  it('puts the long axis of a rod on x', () => {
    const pts: Array<[number, number, number]> = [[0, 0, -5], [0, 0, -2], [0, 0, 2], [0, 0, 5], [0.1, 0, 0], [-0.1, 0, 0]];
    const m = principalAxes(pts);
    expect(Math.abs(m[0][2])).toBeCloseTo(1, 3);
    expect(Math.abs(m[2][0]) + Math.abs(m[2][1])).toBeGreaterThan(0.99);
  });
  it('is right handed', () => {
    const m = principalAxes([[1, 0, 0], [-1, 0, 0], [0, 0.5, 0], [0, -0.5, 0], [0, 0, 0.1], [0, 0, -0.1]]);
    const det =
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    expect(det).toBeCloseTo(1, 6);
  });
});

describe('renderStructureSvg', () => {
  const benzene = molfileToStructure(smilesToMolfile3D('c1ccccc1')!)!;

  it('draws every atom as a circle and every bond as segments', () => {
    const svg = renderStructureSvg(benzene, { width: 300, height: 200 });
    expect(svg.startsWith('<svg')).toBe(true);
    expect((svg.match(/<circle/g) ?? []).length).toBe(12);
    // 6 single C-H bonds (2 halves) + 3 single + 3 double ring bonds (2 or 4 halves)
    expect((svg.match(/<line/g) ?? []).length).toBe(12 + 6 + 12);
    expect(svg).toContain('width="300"');
  });

  it('keeps everything inside the viewport', () => {
    const svg = renderStructureSvg(benzene, { width: 300, height: 200 });
    const xs = [...svg.matchAll(/cx="([\d.]+)"/g)].map((m) => Number(m[1]));
    const ys = [...svg.matchAll(/cy="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeGreaterThan(0);
    expect(Math.max(...xs)).toBeLessThan(300);
    expect(Math.min(...ys)).toBeGreaterThan(0);
    expect(Math.max(...ys)).toBeLessThan(200);
  });

  it('supports spacefill (no bonds), labels and a background', () => {
    const svg = renderStructureSvg(benzene, { style: 'spacefill', labels: true, background: '#ffffff' });
    expect(svg).not.toContain('<line');
    expect((svg.match(/<text/g) ?? []).length).toBe(6);
    expect(svg).toContain('<rect width="100%" height="100%" fill="#ffffff"/>');
  });

  it('handles a single atom and an empty structure', () => {
    expect(renderStructureSvg({ atoms: [{ symbol: 'Ar', x: 0, y: 0, z: 0, charge: 0 }], bonds: [] })).toContain('<circle');
    expect(renderStructureSvg({ atoms: [], bonds: [] })).toContain('<svg');
  });
});

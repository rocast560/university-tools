import { describe, expect, test } from 'vitest';
import { renderSnapshotSvg } from './render3d';
import { buildSpecies } from './species';

const water = buildSpecies({ name: 'Water', smiles: 'O', source: 'library' });

describe('renderSnapshotSvg', () => {
  test('ball and stick draws one circle per atom and two half-lines per bond', () => {
    const svg = renderSnapshotSvg(water.atoms, water.bonds, { width: 200, height: 100 });
    expect(svg).toContain('<svg');
    expect(svg).toContain('width="200"');
    expect((svg.match(/<circle/g) ?? []).length).toBe(3);
    expect((svg.match(/<line/g) ?? []).length).toBe(4);
  });
  test('hydrogens can be hidden, wireframe has no spheres, spacefill has no bonds', () => {
    expect((renderSnapshotSvg(water.atoms, water.bonds, { showHydrogens: false }).match(/<circle/g) ?? []).length).toBe(1);
    expect(renderSnapshotSvg(water.atoms, water.bonds, { style: 'wireframe' })).not.toContain('<circle');
    expect(renderSnapshotSvg(water.atoms, water.bonds, { style: 'spacefill' })).not.toContain('<line');
  });
  test('highlight adds a ring and rotation changes the picture', () => {
    const a = renderSnapshotSvg(water.atoms, water.bonds, { highlight: [1] });
    expect(a).toContain('#ffd400');
    const b = renderSnapshotSvg(water.atoms, water.bonds, { rotation: [90, 0, 0] });
    expect(b).not.toBe(renderSnapshotSvg(water.atoms, water.bonds));
  });
});

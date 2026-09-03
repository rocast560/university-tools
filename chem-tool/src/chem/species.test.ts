import { describe, expect, test } from 'vitest';
import { SpeciesError, buildSpecies, newId, speciesFromMolecule } from './species';
import { parseSmiles } from './structure';

describe('buildSpecies', () => {
  test('water from SMILES', () => {
    const s = buildSpecies({ name: 'Water', smiles: 'O', source: 'library', displayFormula: 'H2O' });
    expect(s.formula).toBe('H2O');
    expect(s.displayFormula).toBe('H2O');
    expect(s.charge).toBe(0);
    expect(s.info.molarMass).toBeCloseTo(18.015, 2);
    expect(s.info.composition.map((c) => c.element)).toEqual(['H', 'O']);
    expect(s.atoms).toHaveLength(3);
    expect(s.atoms[0].element).toBe('O');
    expect(s.bonds).toHaveLength(2);
    expect(s.svg2d).toContain('<svg');
    expect(s.svg2dNumbered).toContain('O1');
    expect(s.molfile3d).toContain('V2000');
    expect(s.geometry).toBe('conformer');
    expect(s.smiles).toBe('O');
    expect(s.id).toMatch(/^[a-z0-9]{6}$/);
  });
  test('sulfate keeps its charge and defaults displayFormula to Hill', () => {
    const s = buildSpecies({ name: 'Sulfate', smiles: '[O-]S(=O)(=O)[O-]', source: 'smiles' });
    expect(s.charge).toBe(-2);
    expect(s.formula).toBe('O4S 2-');
    expect(s.displayFormula).toBe('O4S 2-');
  });
  test('molfile input and precomputed 3D', () => {
    const base = buildSpecies({ name: 'Ethanol', smiles: 'CCO', source: 'library' });
    const fromMol = buildSpecies({ name: 'Ethanol', molfile: base.molfile2d, source: 'edit' });
    expect(fromMol.formula).toBe('C2H6O');
    const pre = buildSpecies({ name: 'Ethanol', smiles: 'CCO', molfile3d: base.molfile3d, source: 'library' });
    expect(pre.atoms.map((a) => [a.x, a.y, a.z])).toEqual(base.atoms.map((a) => [a.x, a.y, a.z]));
  });
  test('invalid input throws SpeciesError', () => {
    expect(() => buildSpecies({ name: 'Bad', smiles: 'C(', source: 'smiles' })).toThrow(SpeciesError);
    expect(() => buildSpecies({ name: 'Bad', source: 'smiles' })).toThrow(SpeciesError);
  });
  test('speciesFromMolecule and unique ids', () => {
    const s = speciesFromMolecule(parseSmiles('CC')!, { name: 'Ethane', source: 'edit' });
    expect(s.formula).toBe('C2H6');
    expect(new Set(Array.from({ length: 50 }, newId)).size).toBe(50);
  });
});

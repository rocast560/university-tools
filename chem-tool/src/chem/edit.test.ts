import { describe, expect, test } from 'vitest';
import { EditError, applyEdits } from './edit';
import { hillFormula } from './formula';
import { countsOf, extractAtomsBonds, parseSmiles, to3D, totalCharge } from './structure';

/** Build the 3D, heavy-first molecule a Species would hold, then apply ops and return the Hill formula. */
function edit(smiles: string, ops: Parameters<typeof applyEdits>[1]) {
  const mol3d = to3D(parseSmiles(smiles)!).mol;
  const out = applyEdits(mol3d, ops);
  return { formula: hillFormula(countsOf(out), totalCharge(out)), out };
}

describe('applyEdits', () => {
  test('replace OH of ethanol (atom 3) with NH2 gives ethylamine', () => {
    expect(edit('CCO', [{ op: 'replace_group', index: 3, group: 'NH2' }]).formula).toBe('C2H7N');
  });
  test('attach CH3 to carbon 1 of ethanol gives a propanol', () => {
    expect(edit('CCO', [{ op: 'attach_group', index: 1, group: 'CH3' }]).formula).toBe('C3H8O');
  });
  test('attach a SMILES fragment and a named group with a heteroatom', () => {
    expect(edit('C', [{ op: 'attach_group', index: 1, group: 'COOH' }]).formula).toBe('C2H4O2');
    expect(edit('c1ccccc1', [{ op: 'attach_group', index: 1, group: 'C(=O)O' }]).formula).toBe('C7H6O2');
  });
  test('bond order, remove atom, add atom', () => {
    expect(edit('CC', [{ op: 'set_bond_order', a: 1, b: 2, order: 2 }]).formula).toBe('C2H4');
    expect(edit('CC', [{ op: 'set_bond_order', a: 1, b: 2, order: 3 }]).formula).toBe('C2H2');
    expect(edit('CCC', [{ op: 'remove_atom', index: 1 }]).formula).toBe('C2H6');
    expect(edit('C', [{ op: 'add_atom', element: 'Cl', bondTo: 1 }]).formula).toBe('CH3Cl');
    expect(edit('C', [{ op: 'add_atom', element: 'O', bondTo: 1, order: 2 }]).formula).toBe('CH2O');
  });
  test('replace a hydrogen, set element and charge, remove and add bonds', () => {
    expect(edit('C', [{ op: 'replace_group', index: 2, group: 'OH' }]).formula).toBe('CH4O');
    expect(edit('CO', [{ op: 'set_element', index: 2, element: 'S' }]).formula).toBe('CH4S');
    expect(edit('N', [{ op: 'set_charge', index: 1, charge: 1 }]).formula).toBe('H4N +');
    expect(edit('C1CC1', [{ op: 'remove_bond', a: 1, b: 3 }]).formula).toBe('C3H8');
    expect(edit('CCCC', [{ op: 'add_bond', a: 1, b: 4 }]).formula).toBe('C4H8');
  });
  test('several ops keep the original numbering', () => {
    // propane: 1:C 2:C 3:C. Remove atom 1, then put Cl on what was atom 3.
    expect(edit('CCC', [{ op: 'remove_atom', index: 1 }, { op: 'add_atom', element: 'Cl', bondTo: 3 }]).formula).toBe('C2H5Cl');
  });
  test('result is heavy-first with hydrogens re-saturated and the input untouched', () => {
    const mol3d = to3D(parseSmiles('C')!).mol;
    const out = applyEdits(mol3d, [{ op: 'add_atom', element: 'Cl', bondTo: 1 }]);
    const { atoms } = extractAtomsBonds(out);
    expect(atoms.map((a) => a.element)).toEqual(['C', 'Cl', 'H', 'H', 'H']);
    expect(mol3d.getAllAtoms()).toBe(5);
  });
  test('errors name the atoms and leave nothing half done', () => {
    expect(() => edit('C', Array(5).fill({ op: 'add_atom', element: 'Cl', bondTo: 1 }))).toThrow(/carbon 1 would have 5 bonds/);
    expect(() => edit('C', [{ op: 'add_atom', element: 'Cl', bondTo: 99 }])).toThrow(/Atom 99 does not exist/);
    expect(() => edit('CCO', [{ op: 'remove_atom', index: 3 }, { op: 'set_element', index: 3, element: 'N' }])).toThrow(/removed earlier/);
    expect(() => edit('C', [{ op: 'attach_group', index: 1, group: 'XYZ' }])).toThrow(EditError);
    expect(() => edit('CCO', [{ op: 'replace_group', index: 2, group: 'OH' }])).toThrow(/exactly one heavy neighbour/);
    expect(() => edit('CC', [{ op: 'add_bond', a: 1, b: 2 }])).toThrow(/already bonded/);
    expect(() => edit('CC', [{ op: 'remove_bond', a: 1, b: 5 }])).toThrow(/No bond/);
    expect(() => edit('C', [])).toThrow(/No edit/);
  });
});

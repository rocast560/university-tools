// Atom-level edits on an OpenChemLib molecule with explicit hydrogens (a Species' molfile3d).
// Ops refer to 1-based atom numbers as they were when the command started.

import * as OCL from 'openchemlib';
import { bySymbol } from './elements';
import { heavyAtomCount, reorderHeavyFirst } from './structure';

export type EditOp =
  | { op: 'add_atom'; element: string; bondTo: number; order?: 1 | 2 | 3 }
  | { op: 'remove_atom'; index: number }
  | { op: 'set_element'; index: number; element: string }
  | { op: 'set_charge'; index: number; charge: number }
  | { op: 'add_bond'; a: number; b: number; order?: 1 | 2 | 3 }
  | { op: 'remove_bond'; a: number; b: number }
  | { op: 'set_bond_order'; a: number; b: number; order: 1 | 2 | 3 }
  | { op: 'attach_group'; index: number; group: string }
  | { op: 'replace_group'; index: number; group: string };

export class EditError extends Error {}

/** Named groups. The first atom of the fragment is the attachment point. */
export const GROUPS: Record<string, string> = {
  H: '[H]', OH: 'O', NH2: 'N', CH3: 'C', C2H5: 'CC', COOH: 'C(=O)O', CHO: 'C=O', CN: 'C#N', NO2: '[N+](=O)[O-]',
  SO3H: 'S(=O)(=O)O', OCH3: 'OC', SH: 'S', F: 'F', Cl: 'Cl', Br: 'Br', I: 'I', phenyl: 'c1ccccc1',
};

function atomicNo(symbol: string): number {
  const e = bySymbol(symbol);
  if (!e) throw new EditError(`Unknown element "${symbol}"`);
  return e.z;
}

function elementName(mol: OCL.Molecule, i: number): string {
  return bySymbol(mol.getAtomLabel(i))?.name.toLowerCase() ?? mol.getAtomLabel(i);
}

class Editor {
  private readonly n0: number;
  private readonly map: number[];

  constructor(readonly mol: OCL.Molecule) {
    this.n0 = mol.getAllAtoms();
    this.map = Array.from({ length: this.n0 }, (_, i) => i);
  }

  refresh(): void { this.mol.ensureHelperArrays(OCL.Molecule.cHelperNeighbours); }

  /** Current 0-based index of the atom that had 1-based number `index` at the start. */
  at(index: number): number {
    if (!Number.isInteger(index) || index < 1 || index > this.n0) throw new EditError(`Atom ${index} does not exist (the molecule has ${this.n0} atoms)`);
    const cur = this.map[index - 1];
    if (cur < 0) throw new EditError(`Atom ${index} was removed earlier in this edit`);
    return cur;
  }

  delete(cur: number): void {
    this.mol.deleteAtom(cur);
    for (let i = 0; i < this.map.length; i++) {
      if (this.map[i] === cur) this.map[i] = -1;
      else if (this.map[i] > cur) this.map[i]--;
    }
  }

  neighbours(cur: number, hydrogen: boolean): number[] {
    this.refresh();
    const out: number[] = [];
    for (let k = 0; k < this.mol.getConnAtoms(cur); k++) {
      const n = this.mol.getConnAtom(cur, k);
      if ((this.mol.getAtomicNo(n) === 1) === hydrogen) out.push(n);
    }
    return out;
  }

  /** Removes explicit hydrogens from `cur` until it has `needed` free valences (or none are left). Returns cur's new index. */
  freeUp(cur: number, needed = 1): number {
    for (;;) {
      this.refresh();
      if (this.mol.getFreeValence(cur) >= needed) return cur;
      const hs = this.neighbours(cur, true);
      if (hs.length === 0) return cur;
      const h = hs[0];
      this.delete(h);
      if (h < cur) cur--;
    }
  }

  bond(a: number, b: number, opA: number, opB: number): number {
    this.refresh();
    const bd = this.mol.getBond(a, b);
    if (bd === -1) throw new EditError(`No bond between atoms ${opA} and ${opB}`);
    return bd;
  }

  attach(cur: number, group: string): void {
    let frag: OCL.Molecule;
    try { frag = OCL.Molecule.fromSmiles(GROUPS[group] ?? group); } catch { frag = new OCL.Molecule(0, 0); }
    if (frag.getAllAtoms() === 0) throw new EditError(`Unknown group "${group}": use a named group (${Object.keys(GROUPS).join(', ')}) or a SMILES fragment`);
    const anchor = this.freeUp(cur);
    const idx = this.mol.addMolecule(frag);
    const b = this.mol.addBond(anchor, idx[0]);
    this.mol.setBondOrder(b, 1);
  }
}

export function applyEdits(source: OCL.Molecule, ops: EditOp[]): OCL.Molecule {
  if (ops.length === 0) throw new EditError('No edit operations given');
  const ed = new Editor(source.getCompactCopy());
  const mol = ed.mol;

  for (const op of ops) {
    switch (op.op) {
      case 'add_atom': {
        const need = op.order ?? 1;
        const to = ed.freeUp(ed.at(op.bondTo), need);
        const a = mol.addAtom(atomicNo(op.element));
        const b = mol.addBond(to, a);
        mol.setBondOrder(b, need);
        break;
      }
      case 'remove_atom': {
        const cur = ed.at(op.index);
        for (const v of [...ed.neighbours(cur, true), cur].sort((x, y) => y - x)) ed.delete(v);
        break;
      }
      case 'set_element': mol.setAtomicNo(ed.at(op.index), atomicNo(op.element)); break;
      case 'set_charge': mol.setAtomCharge(ed.at(op.index), op.charge); break;
      case 'add_bond': {
        if (op.a === op.b) throw new EditError('add_bond needs two different atoms');
        ed.refresh();
        if (mol.getBond(ed.at(op.a), ed.at(op.b)) !== -1) throw new EditError(`Atoms ${op.a} and ${op.b} are already bonded (use set_bond_order)`);
        const need = op.order ?? 1;
        ed.freeUp(ed.at(op.a), need);
        ed.freeUp(ed.at(op.b), need);
        const b = mol.addBond(ed.at(op.a), ed.at(op.b));
        mol.setBondOrder(b, need);
        break;
      }
      case 'remove_bond': mol.deleteBond(ed.bond(ed.at(op.a), ed.at(op.b), op.a, op.b)); break;
      case 'set_bond_order': {
        const current = mol.getBondOrder(ed.bond(ed.at(op.a), ed.at(op.b), op.a, op.b));
        const extra = op.order - current;
        if (extra > 0) {
          ed.freeUp(ed.at(op.a), extra);
          ed.freeUp(ed.at(op.b), extra);
        }
        mol.setBondOrder(ed.bond(ed.at(op.a), ed.at(op.b), op.a, op.b), op.order);
        break;
      }
      case 'attach_group': ed.attach(ed.at(op.index), op.group); break;
      case 'replace_group': {
        const cur = ed.at(op.index);
        const isH = mol.getAtomicNo(cur) === 1;
        const heavy = ed.neighbours(cur, false);
        if (!isH && heavy.length !== 1) throw new EditError(`Atom ${op.index} must be a hydrogen or a leaf atom with exactly one heavy neighbour to be replaced (it has ${heavy.length})`);
        if (isH && heavy.length === 0) throw new EditError(`Hydrogen ${op.index} is not attached to a heavy atom`);
        let anchor = heavy[0];
        for (const v of [...ed.neighbours(cur, true), cur].sort((x, y) => y - x)) {
          ed.delete(v);
          if (v < anchor) anchor--;
        }
        ed.attach(anchor, op.group);
        break;
      }
    }
  }

  mol.ensureHelperArrays(OCL.Molecule.cHelperNeighbours);
  mol.removeExplicitHydrogens();
  mol.addImplicitHydrogens();
  mol.ensureHelperArrays(OCL.Molecule.cHelperNeighbours);
  for (let i = 0; i < mol.getAllAtoms(); i++) {
    if (mol.getFreeValence(i) < 0) {
      throw new EditError(`${elementName(mol, i)} ${i + 1} would have ${mol.getOccupiedValence(i)} bonds, more than its valence of ${mol.getMaxValence(i)}`);
    }
  }
  return reorderHeavyFirst(mol);
}

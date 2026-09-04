import OCL from 'openchemlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

OCL.Resources.registerFromNodejs();
function conf(smiles) {
  const mol = OCL.Molecule.fromSmiles(smiles);
  mol.addImplicitHydrogens();
  const t0 = Date.now();
  const c = new OCL.ConformerGenerator(42).getOneConformerAsMolecule(mol);
  return { ms: Date.now() - t0, atoms: c ? c.getAllAtoms() : null, xyz: c ? [c.getAtomX(0), c.getAtomY(0), c.getAtomZ(0)] : null, mol: c };
}
for (const s of ['O', 'CC(=O)O', 'CN1C=NC2=C1C(=O)N(C(=O)N2C)C', '[Na+].[Cl-]', 'OC[C@H]1OC(O)[C@H](O)[C@@H](O)[C@@H]1O', 'c1ccc2ccccc2c1', 'C[C@H](N)C(O)=O', '[Ca+2].[O-]C([O-])=O']) {
  const r = conf(s);
  console.log(s.padEnd(40), r.ms + 'ms', 'atoms', r.atoms, r.xyz && r.xyz.map(v => v.toFixed(2)).join(','));
}
const r = conf('[Na+].[Cl-]');
if (r.mol) { console.log('NaCl coords', [0,1].map(i => [r.mol.getAtomX(i), r.mol.getAtomY(i), r.mol.getAtomZ(i)].map(v=>v.toFixed(2)).join(','))); console.log(r.mol.toMolfile()); }
const m = OCL.Molecule.fromSmiles('[Na+].[Cl-]');
console.log('fragmentNumbers', typeof m.getFragmentNumbers, typeof m.getFragments, typeof m.getAtomCharge);
const w = OCL.Molecule.fromSmiles('O'); w.addImplicitHydrogens();
console.log('water svg (with H?)', w.toSVG(200,150,'w',{autoCrop:true}).includes('>H<'));
const w2 = OCL.Molecule.fromSmiles('O');
console.log('water svg plain', w2.toSVG(200,150,'w',{autoCrop:true}).replace(/\s+/g,' ').slice(0,400));

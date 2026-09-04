import OCL from 'openchemlib';
console.log('OCL keys:', Object.keys(OCL).filter(k => /Molecule|Conformer|SmilesParser|Depictor|SVG|Util|Version|version/i.test(k)));
const mol = OCL.Molecule.fromSmiles('CC(=O)O');
console.log('atoms', mol.getAllAtoms(), 'formula', mol.getMolecularFormula().formula, 'mw', mol.getMolecularFormula().relativeWeight);
const svg = mol.toSVG(300, 200, 'm1', { autoCrop: true, suppressChiralText: true });
console.log('svg len', svg.length, svg.slice(0, 120));
const t0 = Date.now();
mol.addImplicitHydrogens();
const cg = new OCL.ConformerGenerator(42);
const conf = cg.getOneConformerAsMolecule(mol);
console.log('conformer ms', Date.now() - t0, 'atoms', conf.getAllAtoms(), 'z', conf.getAtomZ(0), conf.getAtomZ(3));
const mf = conf.toMolfile();
console.log(mf.split('\n').slice(0, 6).join('\n'));
// ionic test
const ion = OCL.Molecule.fromSmiles('[Na+].[Cl-]');
ion.addImplicitHydrogens();
const c2 = new OCL.ConformerGenerator(1).getOneConformerAsMolecule(ion);
console.log('ionic atoms', c2 ? c2.getAllAtoms() : null, c2 ? [c2.getAtomX(0), c2.getAtomX(1)] : null);
// fragments
console.log('fragments', ion.getFragmentNumbers ? 'has getFragmentNumbers' : 'no', typeof mol.getFragments);
// bigger molecule timing
const caf = OCL.Molecule.fromSmiles('CN1C=NC2=C1C(=O)N(C(=O)N2C)C');
caf.addImplicitHydrogens();
const t1 = Date.now();
const c3 = new OCL.ConformerGenerator(1).getOneConformerAsMolecule(caf);
console.log('caffeine conformer ms', Date.now() - t1, c3.getAllAtoms());
// molfile V3 & bonds
console.log('bond count', c3.getAllBonds(), 'order0', c3.getBondOrder(0), 'atomLabel', c3.getAtomLabel(0));

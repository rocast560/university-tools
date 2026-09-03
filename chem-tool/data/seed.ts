// Curated general-chemistry compounds. Order matters: when several entries share a formula
// (ethanol and dimethyl ether are both C2H6O) the earlier one is the default for that formula.
// `formula` is the conventional display form; the Hill form is derived. The library test checks
// that every SMILES produces the same Hill formula and charge as the formula text.

export interface SeedEntry {
  name: string;
  formula: string;
  smiles: string;
  aliases?: string[];
  category: string;
  note?: string;
  cid?: number;
}

const G = 'Gases and diatomics', A = 'Acids', B = 'Bases', S = 'Salts', I = 'Polyatomic ions', H = 'Hydrocarbons';
const AL = 'Alcohols and ethers', K = 'Aldehydes and ketones', E = 'Carboxylic acids and esters', N = 'Amines and amides';
const X = 'Halides', BIO = 'Biomolecules', SOL = 'Solvents and reagents', EV = 'Everyday chemicals';

export const SEED: SeedEntry[] = [
  // Gases and diatomics
  { name: 'Water', formula: 'H2O', smiles: 'O', aliases: ['dihydrogen monoxide', 'ice', 'steam'], category: G, cid: 962, note: 'Bent, 104.5°, hydrogen bonded; the universal solvent.' },
  { name: 'Hydrogen', formula: 'H2', smiles: '[H][H]', aliases: ['dihydrogen', 'hydrogen gas'], category: G, cid: 783 },
  { name: 'Oxygen', formula: 'O2', smiles: 'O=O', aliases: ['dioxygen', 'oxygen gas'], category: G, cid: 977 },
  { name: 'Nitrogen', formula: 'N2', smiles: 'N#N', aliases: ['dinitrogen', 'nitrogen gas'], category: G, cid: 947 },
  { name: 'Ozone', formula: 'O3', smiles: '[O-][O+]=O', aliases: ['trioxygen'], category: G },
  { name: 'Carbon dioxide', formula: 'CO2', smiles: 'O=C=O', aliases: ['dry ice'], category: G, cid: 280 },
  { name: 'Carbon monoxide', formula: 'CO', smiles: '[C-]#[O+]', category: G, cid: 281 },
  { name: 'Hydrogen sulfide', formula: 'H2S', smiles: 'S', aliases: ['sulfane', 'rotten egg gas'], category: G },
  { name: 'Sulfur dioxide', formula: 'SO2', smiles: 'O=S=O', aliases: ['sulphur dioxide'], category: G },
  { name: 'Sulfur trioxide', formula: 'SO3', smiles: 'O=S(=O)=O', aliases: ['sulphur trioxide'], category: G },
  { name: 'Nitric oxide', formula: 'NO', smiles: '[N]=O', aliases: ['nitrogen monoxide'], category: G },
  { name: 'Nitrogen dioxide', formula: 'NO2', smiles: '[O]N=O', category: G },
  { name: 'Nitrous oxide', formula: 'N2O', smiles: '[N-]=[N+]=O', aliases: ['laughing gas', 'dinitrogen monoxide'], category: G },
  { name: 'Hydrogen peroxide', formula: 'H2O2', smiles: 'OO', aliases: ['peroxide'], category: G },
  { name: 'Chlorine', formula: 'Cl2', smiles: 'ClCl', aliases: ['dichlorine', 'chlorine gas'], category: G },
  { name: 'Fluorine', formula: 'F2', smiles: 'FF', aliases: ['difluorine'], category: G },
  { name: 'Bromine', formula: 'Br2', smiles: 'BrBr', aliases: ['dibromine'], category: G },
  { name: 'Iodine', formula: 'I2', smiles: 'II', aliases: ['diiodine'], category: G },
  { name: 'Helium', formula: 'He', smiles: '[He]', category: G },
  { name: 'Neon', formula: 'Ne', smiles: '[Ne]', category: G },
  { name: 'Argon', formula: 'Ar', smiles: '[Ar]', category: G },
  { name: 'Phosphine', formula: 'PH3', smiles: 'P', aliases: ['phosphane'], category: G },
  // Acids
  { name: 'Hydrogen chloride', formula: 'HCl', smiles: 'Cl', aliases: ['hydrochloric acid', 'muriatic acid'], category: A, cid: 313 },
  { name: 'Hydrogen fluoride', formula: 'HF', smiles: 'F', aliases: ['hydrofluoric acid'], category: A },
  { name: 'Hydrogen bromide', formula: 'HBr', smiles: 'Br', aliases: ['hydrobromic acid'], category: A },
  { name: 'Sulfuric acid', formula: 'H2SO4', smiles: 'OS(=O)(=O)O', aliases: ['sulphuric acid', 'oil of vitriol', 'battery acid'], category: A, cid: 1118 },
  { name: 'Nitric acid', formula: 'HNO3', smiles: 'O[N+](=O)[O-]', aliases: ['aqua fortis'], category: A, cid: 944 },
  { name: 'Phosphoric acid', formula: 'H3PO4', smiles: 'OP(=O)(O)O', aliases: ['orthophosphoric acid'], category: A, cid: 1004 },
  { name: 'Acetic acid', formula: 'CH3COOH', smiles: 'CC(=O)O', aliases: ['ethanoic acid', 'vinegar', 'C2H4O2'], category: A, cid: 176 },
  { name: 'Formic acid', formula: 'HCOOH', smiles: 'C(=O)O', aliases: ['methanoic acid'], category: A },
  { name: 'Carbonic acid', formula: 'H2CO3', smiles: 'OC(=O)O', category: A },
  { name: 'Hydrogen cyanide', formula: 'HCN', smiles: 'C#N', aliases: ['prussic acid', 'hydrocyanic acid'], category: A },
  { name: 'Hypochlorous acid', formula: 'HOCl', smiles: 'OCl', aliases: ['HClO'], category: A },
  { name: 'Perchloric acid', formula: 'HClO4', smiles: 'OCl(=O)(=O)=O', category: A },
  { name: 'Citric acid', formula: 'C6H8O7', smiles: 'OC(=O)CC(O)(CC(=O)O)C(=O)O', category: A },
  { name: 'Oxalic acid', formula: 'C2H2O4', smiles: 'OC(=O)C(=O)O', aliases: ['ethanedioic acid'], category: A },
  { name: 'Boric acid', formula: 'H3BO3', smiles: 'OB(O)O', aliases: ['orthoboric acid'], category: A },
  // Bases
  { name: 'Ammonia', formula: 'NH3', smiles: 'N', aliases: ['azane'], category: B, cid: 222 },
  { name: 'Sodium hydroxide', formula: 'NaOH', smiles: '[Na+].[OH-]', aliases: ['caustic soda', 'lye'], category: B },
  { name: 'Potassium hydroxide', formula: 'KOH', smiles: '[K+].[OH-]', aliases: ['caustic potash'], category: B },
  { name: 'Calcium hydroxide', formula: 'Ca(OH)2', smiles: '[Ca+2].[OH-].[OH-]', aliases: ['slaked lime', 'limewater'], category: B },
  { name: 'Magnesium hydroxide', formula: 'Mg(OH)2', smiles: '[Mg+2].[OH-].[OH-]', aliases: ['milk of magnesia'], category: B },
  { name: 'Sodium bicarbonate', formula: 'NaHCO3', smiles: '[Na+].OC(=O)[O-]', aliases: ['baking soda', 'sodium hydrogen carbonate'], category: B },
  { name: 'Sodium carbonate', formula: 'Na2CO3', smiles: '[Na+].[Na+].[O-]C(=O)[O-]', aliases: ['soda ash', 'washing soda'], category: B },
  // Salts
  { name: 'Sodium chloride', formula: 'NaCl', smiles: '[Na+].[Cl-]', aliases: ['table salt', 'halite'], category: S },
  { name: 'Potassium chloride', formula: 'KCl', smiles: '[K+].[Cl-]', category: S },
  { name: 'Calcium carbonate', formula: 'CaCO3', smiles: '[Ca+2].[O-]C(=O)[O-]', aliases: ['limestone', 'calcite', 'chalk'], category: S },
  { name: 'Calcium chloride', formula: 'CaCl2', smiles: '[Ca+2].[Cl-].[Cl-]', category: S },
  { name: 'Magnesium sulfate', formula: 'MgSO4', smiles: '[Mg+2].[O-]S(=O)(=O)[O-]', aliases: ['epsom salt'], category: S },
  { name: 'Copper(II) sulfate', formula: 'CuSO4', smiles: '[Cu+2].[O-]S(=O)(=O)[O-]', aliases: ['copper sulfate', 'cupric sulfate'], category: S },
  { name: 'Silver nitrate', formula: 'AgNO3', smiles: '[Ag+].[O-][N+](=O)[O-]', category: S },
  { name: 'Potassium permanganate', formula: 'KMnO4', smiles: '[K+].[O-][Mn](=O)(=O)=O', category: S },
  { name: 'Ammonium nitrate', formula: 'NH4NO3', smiles: '[NH4+].[O-][N+](=O)[O-]', category: S },
  { name: 'Ammonium chloride', formula: 'NH4Cl', smiles: '[NH4+].[Cl-]', aliases: ['sal ammoniac'], category: S },
  { name: 'Potassium nitrate', formula: 'KNO3', smiles: '[K+].[O-][N+](=O)[O-]', aliases: ['saltpeter', 'saltpetre'], category: S },
  { name: 'Sodium sulfate', formula: 'Na2SO4', smiles: '[Na+].[Na+].[O-]S(=O)(=O)[O-]', category: S },
  // Polyatomic ions
  { name: 'Hydroxide', formula: 'OH-', smiles: '[OH-]', category: I },
  { name: 'Hydronium', formula: 'H3O+', smiles: '[OH3+]', category: I },
  { name: 'Ammonium', formula: 'NH4+', smiles: '[NH4+]', category: I },
  { name: 'Nitrate', formula: 'NO3-', smiles: '[O-][N+](=O)[O-]', category: I },
  { name: 'Nitrite', formula: 'NO2-', smiles: '[O-]N=O', category: I },
  { name: 'Sulfate', formula: 'SO4 2-', smiles: '[O-]S(=O)(=O)[O-]', aliases: ['sulphate'], category: I },
  { name: 'Sulfite', formula: 'SO3 2-', smiles: '[O-]S(=O)[O-]', category: I },
  { name: 'Carbonate', formula: 'CO3 2-', smiles: '[O-]C(=O)[O-]', category: I },
  { name: 'Bicarbonate', formula: 'HCO3-', smiles: 'OC(=O)[O-]', aliases: ['hydrogen carbonate'], category: I },
  { name: 'Phosphate', formula: 'PO4 3-', smiles: '[O-]P(=O)([O-])[O-]', category: I },
  { name: 'Acetate', formula: 'CH3COO-', smiles: 'CC(=O)[O-]', aliases: ['ethanoate', 'C2H3O2-'], category: I },
  { name: 'Cyanide', formula: 'CN-', smiles: '[C-]#N', category: I },
  { name: 'Permanganate', formula: 'MnO4-', smiles: '[O-][Mn](=O)(=O)=O', category: I },
  { name: 'Hypochlorite', formula: 'ClO-', smiles: '[O-]Cl', category: I },
  // Hydrocarbons
  { name: 'Methane', formula: 'CH4', smiles: 'C', aliases: ['natural gas'], category: H, cid: 297 },
  { name: 'Ethane', formula: 'C2H6', smiles: 'CC', category: H },
  { name: 'Propane', formula: 'C3H8', smiles: 'CCC', category: H },
  { name: 'Butane', formula: 'C4H10', smiles: 'CCCC', aliases: ['n-butane'], category: H },
  { name: 'Octane', formula: 'C8H18', smiles: 'CCCCCCCC', aliases: ['n-octane'], category: H },
  { name: 'Ethylene', formula: 'C2H4', smiles: 'C=C', aliases: ['ethene'], category: H },
  { name: 'Propylene', formula: 'C3H6', smiles: 'CC=C', aliases: ['propene'], category: H },
  { name: 'Acetylene', formula: 'C2H2', smiles: 'C#C', aliases: ['ethyne'], category: H },
  { name: 'Benzene', formula: 'C6H6', smiles: 'c1ccccc1', category: H, cid: 241 },
  { name: 'Toluene', formula: 'C7H8', smiles: 'Cc1ccccc1', aliases: ['methylbenzene'], category: H },
  { name: 'Cyclohexane', formula: 'C6H12', smiles: 'C1CCCCC1', category: H },
  { name: 'Naphthalene', formula: 'C10H8', smiles: 'c1ccc2ccccc2c1', aliases: ['mothballs'], category: H },
  // Alcohols and ethers
  { name: 'Methanol', formula: 'CH3OH', smiles: 'CO', aliases: ['methyl alcohol', 'wood alcohol', 'CH4O'], category: AL, cid: 887 },
  { name: 'Ethanol', formula: 'C2H5OH', smiles: 'CCO', aliases: ['ethyl alcohol', 'grain alcohol', 'C2H6O'], category: AL, cid: 702 },
  { name: 'Isopropanol', formula: 'C3H7OH', smiles: 'CC(C)O', aliases: ['isopropyl alcohol', '2-propanol', 'rubbing alcohol'], category: AL },
  { name: 'Ethylene glycol', formula: 'C2H6O2', smiles: 'OCCO', aliases: ['antifreeze', '1,2-ethanediol'], category: AL },
  { name: 'Glycerol', formula: 'C3H8O3', smiles: 'OCC(O)CO', aliases: ['glycerin', 'glycerine'], category: AL },
  { name: 'Dimethyl ether', formula: 'C2H6O', smiles: 'COC', aliases: ['methoxymethane'], category: AL },
  { name: 'Diethyl ether', formula: 'C4H10O', smiles: 'CCOCC', aliases: ['ether', 'ethoxyethane'], category: AL },
  { name: 'Phenol', formula: 'C6H5OH', smiles: 'Oc1ccccc1', aliases: ['carbolic acid'], category: AL },
  // Aldehydes and ketones
  { name: 'Formaldehyde', formula: 'CH2O', smiles: 'C=O', aliases: ['methanal', 'formalin'], category: K },
  { name: 'Acetaldehyde', formula: 'C2H4O', smiles: 'CC=O', aliases: ['ethanal'], category: K },
  { name: 'Acetone', formula: 'C3H6O', smiles: 'CC(C)=O', aliases: ['propanone', '2-propanone'], category: K, cid: 180 },
  // Carboxylic acids and esters
  { name: 'Benzoic acid', formula: 'C7H6O2', smiles: 'OC(=O)c1ccccc1', category: E },
  { name: 'Ethyl acetate', formula: 'C4H8O2', smiles: 'CCOC(C)=O', aliases: ['ethyl ethanoate'], category: E },
  { name: 'Aspirin', formula: 'C9H8O4', smiles: 'CC(=O)Oc1ccccc1C(=O)O', aliases: ['acetylsalicylic acid'], category: E, cid: 2244 },
  { name: 'Lactic acid', formula: 'C3H6O3', smiles: 'CC(O)C(=O)O', aliases: ['2-hydroxypropanoic acid'], category: E },
  // Amines and amides
  { name: 'Methylamine', formula: 'CH3NH2', smiles: 'CN', aliases: ['aminomethane'], category: N },
  { name: 'Urea', formula: 'CH4N2O', smiles: 'NC(N)=O', aliases: ['carbamide'], category: N },
  { name: 'Caffeine', formula: 'C8H10N4O2', smiles: 'Cn1cnc2c1c(=O)n(C)c(=O)n2C', category: N, cid: 2519 },
  { name: 'Glycine', formula: 'C2H5NO2', smiles: 'NCC(=O)O', aliases: ['aminoacetic acid'], category: N },
  { name: 'Alanine', formula: 'C3H7NO2', smiles: 'C[C@H](N)C(=O)O', aliases: ['L-alanine'], category: N },
  // Halides
  { name: 'Chloroform', formula: 'CHCl3', smiles: 'ClC(Cl)Cl', aliases: ['trichloromethane'], category: X },
  { name: 'Carbon tetrachloride', formula: 'CCl4', smiles: 'ClC(Cl)(Cl)Cl', aliases: ['tetrachloromethane'], category: X },
  { name: 'Dichloromethane', formula: 'CH2Cl2', smiles: 'ClCCl', aliases: ['DCM', 'methylene chloride'], category: X },
  { name: 'Chloromethane', formula: 'CH3Cl', smiles: 'CCl', aliases: ['methyl chloride'], category: X },
  { name: 'Vinyl chloride', formula: 'C2H3Cl', smiles: 'C=CCl', aliases: ['chloroethene'], category: X },
  // Biomolecules
  { name: 'Glucose', formula: 'C6H12O6', smiles: 'OC[C@H]1OC(O)[C@H](O)[C@@H](O)[C@@H]1O', aliases: ['dextrose', 'D-glucose', 'blood sugar'], category: BIO, cid: 5793 },
  { name: 'Adenine', formula: 'C5H5N5', smiles: 'Nc1ncnc2[nH]cnc12', category: BIO },
  // Solvents and reagents
  { name: 'Acetonitrile', formula: 'C2H3N', smiles: 'CC#N', aliases: ['methyl cyanide'], category: SOL },
  { name: 'Dimethyl sulfoxide', formula: 'C2H6OS', smiles: 'CS(C)=O', aliases: ['DMSO'], category: SOL },
  { name: 'Hexane', formula: 'C6H14', smiles: 'CCCCCC', aliases: ['n-hexane'], category: SOL },
  // Everyday chemicals
  { name: 'Sodium hypochlorite', formula: 'NaClO', smiles: '[Na+].[O-]Cl', aliases: ['bleach'], category: EV },
  { name: 'Calcium oxide', formula: 'CaO', smiles: '[Ca+2].[O-2]', aliases: ['quicklime', 'lime'], category: EV },
  { name: 'Magnesium oxide', formula: 'MgO', smiles: '[Mg+2].[O-2]', aliases: ['magnesia'], category: EV },
  { name: 'Silicon dioxide', formula: 'SiO2', smiles: 'O=[Si]=O', aliases: ['silica', 'quartz', 'sand'], category: EV, note: 'A network solid; the molecule shown is the formula unit.' },
];

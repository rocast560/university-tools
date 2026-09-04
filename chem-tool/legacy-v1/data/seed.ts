// Curated compound list. Order matters: when several entries share a formula
// (ethanol and dimethyl ether are both C2H6O) the earlier one is the default
// answer for that formula, so put the more common isomer first in the file.

export type Category =
  | 'Simple molecules & gases'
  | 'Acids'
  | 'Bases'
  | 'Salts & ionic compounds'
  | 'Oxides & minerals'
  | 'Hydrocarbons'
  | 'Alcohols, ethers & phenols'
  | 'Aldehydes & ketones'
  | 'Carboxylic acids, esters & anhydrides'
  | 'Amines & nitrogen compounds'
  | 'Halogenated compounds'
  | 'Polymers & monomers'
  | 'Fuels & energetics'
  | 'Solvents'
  | 'Biochemistry'
  | 'Refrigerants & atmosphere'
  | 'Materials & semiconductors'
  | 'Electrochemistry & batteries'
  | 'Everyday & pharmaceuticals'
  | 'Lab reagents & indicators';

export interface SeedEntry {
  /** Display name. Also the PubChem query unless pubchemName is set. */
  name: string;
  /** Conventional display formula: 'CH3COOH', 'NaCl', 'Ca(OH)2', 'CuSO4·5H2O'. */
  formula: string;
  /** Other names people type: trade names, abbreviations (DMSO, THF), condensed formulas ('C2H5OH'), old names. */
  aliases?: string[];
  category: Category;
  /** Extra categories for browsing; optional. */
  tags?: Category[];
  /** One sentence, plain, useful to an engineering student: what it is and where they meet it. */
  note?: string;
  /** Use when the display name is ambiguous or not what PubChem calls it. */
  pubchemName?: string;
  /** PubChem CID when you are certain of it; leave out otherwise. */
  cid?: number;
  /** 'molecule' (default), 'ionic' (salt: 3D shows the formula unit), 'element' (a pure element such as O2, Fe), 'network' (covalent or metallic solid: SiO2, graphite, Fe). */
  kind?: 'molecule' | 'ionic' | 'element' | 'network';
}

export const SEED: SeedEntry[] = [
  // ---------------------------------------------------------------- Simple molecules & gases
  { name: 'Water', formula: 'H2O', aliases: ['dihydrogen monoxide', 'ice', 'steam', 'oxidane'], category: 'Simple molecules & gases', tags: ['Solvents'], cid: 962, note: 'The universal solvent; its bent 104.5° geometry and hydrogen bonding explain its high boiling point, heat capacity and surface tension.' },
  { name: 'Hydrogen', formula: 'H2', aliases: ['dihydrogen', 'hydrogen gas', 'H2 gas'], category: 'Simple molecules & gases', tags: ['Fuels & energetics', 'Electrochemistry & batteries'], kind: 'element', cid: 783, note: 'The lightest gas and the fuel of fuel cells and future steelmaking, with about 120 MJ/kg lower heating value but very low energy per volume.' },
  { name: 'Oxygen', formula: 'O2', aliases: ['dioxygen', 'oxygen gas', 'O2 gas', 'LOX'], category: 'Simple molecules & gases', tags: ['Refrigerants & atmosphere', 'Fuels & energetics'], kind: 'element', cid: 977, note: 'About 21% of air; the oxidiser in combustion, corrosion and respiration, and paramagnetic because of two unpaired electrons.' },
  { name: 'Nitrogen', formula: 'N2', aliases: ['dinitrogen', 'nitrogen gas', 'N2 gas', 'liquid nitrogen', 'LN2'], category: 'Simple molecules & gases', tags: ['Refrigerants & atmosphere'], kind: 'element', cid: 947, note: 'About 78% of air; its triple bond makes it so inert that it is used as a blanketing gas and, as a liquid at 77 K, a cheap cryogen.' },
  { name: 'Carbon dioxide', formula: 'CO2', aliases: ['carbonic acid gas', 'dry ice', 'R-744', 'carbon dioxide gas'], category: 'Simple molecules & gases', tags: ['Refrigerants & atmosphere', 'Solvents'], cid: 280, note: 'The linear product of complete combustion and the reference greenhouse gas; solid dry ice sublimes at -78.5 °C and supercritical CO2 is a green solvent.' },
  { name: 'Carbon monoxide', formula: 'CO', aliases: ['carbonic oxide', 'syngas component'], category: 'Simple molecules & gases', tags: ['Fuels & energetics'], cid: 281, note: 'Toxic product of incomplete combustion, and with hydrogen the syngas feedstock for methanol and Fischer-Tropsch fuels.' },
  { name: 'Hydrogen peroxide', formula: 'H2O2', aliases: ['peroxide', 'dihydrogen dioxide', 'hair bleach'], category: 'Simple molecules & gases', tags: ['Everyday & pharmaceuticals', 'Electrochemistry & batteries', 'Lab reagents & indicators'], cid: 784, note: 'A strong oxidiser that decomposes to water and oxygen; 3% solutions are antiseptic and concentrated grades are rocket monopropellants.' },
  { name: 'Hydrogen sulfide', formula: 'H2S', aliases: ['sulfane', 'sour gas', 'rotten egg gas', 'hydrosulfuric acid'], category: 'Simple molecules & gases', tags: ['Acids'], note: 'The rotten-egg gas of sour natural gas and sewers; toxic at low ppm and the cause of sulfide stress cracking in pipelines.' },
  { name: 'Sulfur dioxide', formula: 'SO2', aliases: ['sulfurous anhydride', 'sulphur dioxide'], category: 'Simple molecules & gases', tags: ['Refrigerants & atmosphere'], note: 'Formed when sulfur-containing fuels burn; the precursor of acid rain and the intermediate in sulfuric acid manufacture.' },
  { name: 'Sulfur trioxide', formula: 'SO3', aliases: ['sulfuric anhydride', 'sulphur trioxide'], category: 'Simple molecules & gases', tags: ['Acids'], note: 'Made from SO2 over a vanadium catalyst in the contact process and absorbed into sulfuric acid to give oleum.' },
  { name: 'Nitric oxide', formula: 'NO', aliases: ['nitrogen monoxide', 'nitrogen(II) oxide'], category: 'Simple molecules & gases', tags: ['Refrigerants & atmosphere', 'Biochemistry'], note: 'A radical formed in high-temperature combustion (thermal NOx) and a signalling molecule that dilates blood vessels.' },
  { name: 'Nitrogen dioxide', formula: 'NO2', aliases: ['nitrogen(IV) oxide', 'NOx'], category: 'Simple molecules & gases', tags: ['Refrigerants & atmosphere'], note: 'The brown toxic gas of smog and diesel exhaust, in equilibrium with its colourless dimer N2O4 and an intermediate in nitric acid production.' },
  { name: 'Dinitrogen pentoxide', formula: 'N2O5', aliases: ['nitric anhydride', 'nitrogen pentoxide'], category: 'Simple molecules & gases', note: 'The anhydride of nitric acid; its first-order decomposition is the classic kinetics textbook example.' },
  { name: 'Chlorine', formula: 'Cl2', aliases: ['dichlorine', 'chlorine gas'], category: 'Simple molecules & gases', tags: ['Halogenated compounds', 'Electrochemistry & batteries'], kind: 'element', note: 'The yellow-green gas made by chlor-alkali electrolysis of brine and used for water treatment, PVC and bleaching.' },
  { name: 'Fluorine', formula: 'F2', aliases: ['difluorine', 'fluorine gas'], category: 'Simple molecules & gases', tags: ['Halogenated compounds'], kind: 'element', note: 'The most electronegative element and strongest oxidiser; it reacts with almost everything, including glass and water.' },
  { name: 'Bromine', formula: 'Br2', aliases: ['dibromine'], category: 'Simple molecules & gases', tags: ['Halogenated compounds', 'Lab reagents & indicators'], kind: 'element', note: 'The only non-metal that is liquid at room temperature; bromine water is the classic test for alkenes.' },
  { name: 'Sulfur', formula: 'S8', aliases: ['octasulfur', 'sulphur', 'brimstone', 'elemental sulfur', 'S'], category: 'Simple molecules & gases', tags: ['Oxides & minerals'], pubchemName: 'octasulfur', kind: 'element', note: 'Yellow crown-shaped S8 rings recovered from sour gas by the Claus process and burned to make sulfuric acid or used to vulcanise rubber.' },
  { name: 'White phosphorus', formula: 'P4', aliases: ['tetraphosphorus', 'yellow phosphorus', 'elemental phosphorus'], category: 'Simple molecules & gases', pubchemName: 'tetraphosphorus', kind: 'element', note: 'Tetrahedral P4 molecules with 60° bond angles, so strained that the solid ignites spontaneously in air and is stored under water.' },
  { name: 'Phosphine', formula: 'PH3', aliases: ['phosphane', 'hydrogen phosphide'], category: 'Simple molecules & gases', tags: ['Materials & semiconductors'], note: 'A toxic garlic-smelling gas used as a grain fumigant and as the phosphorus dopant source in semiconductor fabrication.' },
  { name: 'Silane', formula: 'SiH4', aliases: ['monosilane', 'silicon tetrahydride'], category: 'Simple molecules & gases', tags: ['Materials & semiconductors'], note: 'The silicon analogue of methane, pyrophoric in air, and the precursor for depositing silicon films in solar cells and chips.' },
  { name: 'Diborane', formula: 'B2H6', aliases: ['boroethane', 'boron hydride'], category: 'Simple molecules & gases', tags: ['Materials & semiconductors'], note: 'The textbook electron-deficient molecule with two three-centre two-electron B-H-B bridges; a boron dopant gas in chip making.' },
  { name: 'Hydrogen cyanide', formula: 'HCN', aliases: ['prussic acid', 'hydrocyanic acid', 'formonitrile'], category: 'Simple molecules & gases', tags: ['Acids', 'Polymers & monomers'], note: 'A highly toxic weak acid produced on an industrial scale for making acrylonitrile, methyl methacrylate and adiponitrile for nylon.' },
  { name: 'Carbonyl sulfide', formula: 'COS', aliases: ['carbon oxide sulfide', 'carbon oxysulfide', 'OCS'], category: 'Simple molecules & gases', tags: ['Refrigerants & atmosphere'], note: 'The most abundant sulfur gas in the atmosphere and a trace impurity in LPG and syngas that poisons catalysts.' },
  { name: 'Phosgene', formula: 'COCl2', aliases: ['carbonyl chloride', 'carbonyl dichloride'], category: 'Simple molecules & gases', tags: ['Halogenated compounds', 'Polymers & monomers'], note: 'A toxic gas made from CO and chlorine and consumed on a huge scale to make polycarbonate and polyurethane isocyanates.' },
  { name: 'Boron trifluoride', formula: 'BF3', aliases: ['trifluoroborane'], category: 'Simple molecules & gases', tags: ['Lab reagents & indicators'], note: 'The classic Lewis acid: a trigonal planar molecule with an empty p orbital that accepts an electron pair from ethers or amines.' },
  { name: 'Boron trichloride', formula: 'BCl3', aliases: ['trichloroborane'], category: 'Simple molecules & gases', tags: ['Materials & semiconductors'], note: 'A Lewis-acidic gas used for plasma etching of aluminium in microelectronics and as a boron source for fibres.' },
  { name: 'Chlorine dioxide', formula: 'ClO2', aliases: ['chlorine(IV) oxide', 'chlorine peroxide'], category: 'Simple molecules & gases', tags: ['Everyday & pharmaceuticals'], note: 'A yellow radical gas generated on site to bleach wood pulp and disinfect drinking water without forming chlorinated by-products.' },
  { name: 'Phosphorus trichloride', formula: 'PCl3', aliases: ['phosphorus(III) chloride', 'trichlorophosphane'], category: 'Simple molecules & gases', tags: ['Lab reagents & indicators'], note: 'A pyramidal liquid that hydrolyses violently and converts alcohols and carboxylic acids to chlorides; the precursor of organophosphates.' },
  { name: 'Phosphorus pentachloride', formula: 'PCl5', aliases: ['phosphorus(V) chloride', 'pentachlorophosphorane'], category: 'Simple molecules & gases', tags: ['Lab reagents & indicators'], note: 'The textbook trigonal bipyramidal molecule; it exists as PCl4+ PCl6- ions in the solid and is a chlorinating agent in synthesis.' },
  { name: 'Silicon tetrachloride', formula: 'SiCl4', aliases: ['tetrachlorosilane', 'silicon(IV) chloride'], category: 'Simple molecules & gases', tags: ['Materials & semiconductors'], note: 'A fuming liquid intermediate in producing electronic-grade polysilicon, optical fibre and fumed silica.' },
  { name: 'Titanium tetrachloride', formula: 'TiCl4', aliases: ['titanium(IV) chloride', 'tickle'], category: 'Simple molecules & gases', tags: ['Materials & semiconductors'], note: 'A colourless liquid that fumes in moist air; it is reduced with magnesium in the Kroll process to make titanium metal and oxidised to make TiO2 pigment.' },

  // ---------------------------------------------------------------- Acids
  { name: 'Hydrochloric acid', formula: 'HCl', aliases: ['muriatic acid', 'hydrogen chloride', 'spirits of salt', 'chlorane'], category: 'Acids', tags: ['Lab reagents & indicators', 'Simple molecules & gases'], cid: 313, note: 'The strong monoprotic acid of the stomach and of pickling steel; 37% aqueous solution is the concentrated lab reagent.' },
  { name: 'Sulfuric acid', formula: 'H2SO4', aliases: ['sulphuric acid', 'oil of vitriol', 'battery acid', 'hydrogen sulfate'], category: 'Acids', tags: ['Electrochemistry & batteries', 'Lab reagents & indicators'], cid: 1118, note: 'The most produced industrial chemical; a strong diprotic acid, dehydrating agent and the electrolyte of lead-acid batteries.' },
  { name: 'Nitric acid', formula: 'HNO3', aliases: ['aqua fortis', 'hydrogen nitrate', 'spirit of nitre'], category: 'Acids', tags: ['Fuels & energetics', 'Lab reagents & indicators'], cid: 944, note: 'A strong oxidising acid made by the Ostwald process from ammonia; the source of nitrate fertilisers and nitro explosives.' },
  { name: 'Phosphoric acid', formula: 'H3PO4', aliases: ['orthophosphoric acid', 'phosphoric(V) acid'], category: 'Acids', tags: ['Everyday & pharmaceuticals'], cid: 1004, note: 'A triprotic acid with three distinct pKa values, used in cola drinks, rust conversion coatings and fertiliser manufacture.' },
  { name: 'Acetic acid', formula: 'CH3COOH', aliases: ['ethanoic acid', 'vinegar', 'glacial acetic acid', 'C2H4O2', 'AcOH'], category: 'Acids', tags: ['Carboxylic acids, esters & anhydrides', 'Everyday & pharmaceuticals', 'Solvents'], cid: 176, note: 'The weak acid of vinegar (pKa 4.76); pure glacial acetic acid freezes at 16.6 °C and is made by carbonylating methanol.' },
  { name: 'Carbonic acid', formula: 'H2CO3', aliases: ['dihydrogen carbonate', 'carbonated water acid'], category: 'Acids', tags: ['Biochemistry', 'Refrigerants & atmosphere'], note: 'Formed when CO2 dissolves in water; it buffers blood and the oceans and drives limestone dissolution and concrete carbonation.' },
  { name: 'Hydrofluoric acid', formula: 'HF', aliases: ['hydrogen fluoride', 'fluoric acid'], category: 'Acids', tags: ['Materials & semiconductors', 'Halogenated compounds'], note: 'A weak but extremely hazardous acid that etches glass and silicon dioxide; used in semiconductor cleaning and alkylation refineries.' },
  { name: 'Hydrobromic acid', formula: 'HBr', aliases: ['hydrogen bromide'], category: 'Acids', tags: ['Halogenated compounds'], note: 'A strong acid, stronger than HCl, used to make alkyl bromides and inorganic bromides.' },
  { name: 'Hydroiodic acid', formula: 'HI', aliases: ['hydrogen iodide', 'hydriodic acid'], category: 'Acids', tags: ['Halogenated compounds'], note: 'The strongest of the hydrohalic acids and a powerful reducing agent used in organic synthesis.' },
  { name: 'Perchloric acid', formula: 'HClO4', aliases: ['hydrogen perchlorate', 'chloric(VII) acid'], category: 'Acids', tags: ['Lab reagents & indicators'], note: 'One of the strongest simple acids and a dangerous oxidiser when hot and concentrated; its salts are rocket oxidisers.' },
  { name: 'Hypochlorous acid', formula: 'HOCl', aliases: ['HClO', 'chloric(I) acid', 'hydrogen hypochlorite'], category: 'Acids', tags: ['Everyday & pharmaceuticals'], note: 'The weak acid that forms when chlorine dissolves in water and the actual disinfecting species in pool and tap water.' },
  { name: 'Nitrous acid', formula: 'HNO2', aliases: ['nitric(III) acid', 'hydrogen nitrite'], category: 'Acids', note: 'An unstable weak acid known only in solution; it converts primary amines to diazonium salts used in dye chemistry.' },
  { name: 'Sulfurous acid', formula: 'H2SO3', aliases: ['sulphurous acid', 'sulfuric(IV) acid'], category: 'Acids', note: 'The nominal acid of SO2 dissolved in water, responsible for the acidity of acid rain; it has never been isolated pure.' },
  { name: 'Phosphorous acid', formula: 'H3PO3', aliases: ['phosphonic acid', 'phosphoric(III) acid'], category: 'Acids', note: 'A diprotic acid despite its three hydrogens, because one H is bonded directly to phosphorus; a reducing agent and PVC stabiliser feedstock.' },
  { name: 'Hypophosphorous acid', formula: 'H3PO2', aliases: ['phosphinic acid', 'phosphoric(I) acid'], category: 'Acids', tags: ['Electrochemistry & batteries'], note: 'A monoprotic reducing acid whose sodium salt is the reducer in electroless nickel plating.' },
  { name: 'Boric acid', formula: 'H3BO3', aliases: ['orthoboric acid', 'boracic acid', 'B(OH)3'], category: 'Acids', tags: ['Everyday & pharmaceuticals', 'Materials & semiconductors'], cid: 7628, note: 'A very weak Lewis acid used as a mild antiseptic, insecticide, neutron absorber in reactor coolant and borosilicate glass ingredient.' },
  { name: 'Chromic acid', formula: 'H2CrO4', aliases: ['tetraoxochromic acid', 'chromic(VI) acid'], category: 'Acids', tags: ['Lab reagents & indicators', 'Electrochemistry & batteries'], note: 'A strong oxidising acid, once used in glassware cleaning and chrome plating baths, now restricted because Cr(VI) is carcinogenic.' },
  { name: 'Sulfamic acid', formula: 'NH2SO3H', aliases: ['amidosulfonic acid', 'H3NSO3', 'sulphamic acid'], category: 'Acids', tags: ['Everyday & pharmaceuticals'], note: 'A solid, stable strong acid sold as descaler for boilers, kettles and heat exchangers because it dissolves limescale without fuming.' },
  { name: 'Methanesulfonic acid', formula: 'CH3SO3H', aliases: ['MSA', 'methylsulfonic acid'], category: 'Acids', tags: ['Electrochemistry & batteries'], note: 'A strong, biodegradable organic acid used as a catalyst and in tin and lead electroplating baths.' },
  { name: 'Trifluoromethanesulfonic acid', formula: 'CF3SO3H', aliases: ['triflic acid', 'TfOH'], category: 'Acids', tags: ['Halogenated compounds'], note: 'A superacid about a thousand times stronger than sulfuric acid, used as a catalyst in organic synthesis.' },

  // ---------------------------------------------------------------- Bases
  { name: 'Ammonia', formula: 'NH3', aliases: ['azane', 'R-717', 'anhydrous ammonia', 'ammonia gas'], category: 'Bases', tags: ['Simple molecules & gases', 'Refrigerants & atmosphere', 'Fuels & energetics'], cid: 222, note: 'Made from N2 and H2 by the Haber-Bosch process; the basis of all nitrogen fertiliser, an efficient industrial refrigerant (R-717) and a hydrogen carrier.' },
  { name: 'Sodium hydroxide', formula: 'NaOH', aliases: ['caustic soda', 'lye', 'sodium hydrate'], category: 'Bases', tags: ['Lab reagents & indicators', 'Everyday & pharmaceuticals', 'Electrochemistry & batteries'], kind: 'ionic', cid: 14798, note: 'The standard strong base of titrations, soap making and drain cleaners, produced with chlorine by the chlor-alkali process.' },
  { name: 'Potassium hydroxide', formula: 'KOH', aliases: ['caustic potash', 'potash lye'], category: 'Bases', tags: ['Electrochemistry & batteries', 'Lab reagents & indicators'], kind: 'ionic', cid: 14797, note: 'A strong base and the electrolyte in alkaline and nickel-metal hydride cells and alkaline water electrolysers.' },
  { name: 'Calcium hydroxide', formula: 'Ca(OH)2', aliases: ['slaked lime', 'hydrated lime', 'limewater', 'portlandite'], category: 'Bases', tags: ['Materials & semiconductors', 'Oxides & minerals'], kind: 'ionic', note: 'Made by slaking quicklime with water; it is the binder in lime mortar, a water softener and the phase that gives concrete its pH of about 12.5.' },
  { name: 'Magnesium hydroxide', formula: 'Mg(OH)2', aliases: ['milk of magnesia', 'brucite'], category: 'Bases', tags: ['Everyday & pharmaceuticals', 'Polymers & monomers'], kind: 'ionic', note: 'A sparingly soluble base used as an antacid and as a halogen-free flame retardant filler in cables.' },
  { name: 'Lithium hydroxide', formula: 'LiOH', aliases: ['lithium hydrate'], category: 'Bases', tags: ['Electrochemistry & batteries', 'Refrigerants & atmosphere'], kind: 'ionic', note: 'A strong base that scrubs CO2 from spacecraft and submarine air and is a precursor for battery cathode materials.' },
  { name: 'Barium hydroxide', formula: 'Ba(OH)2', aliases: ['baryta', 'baryta water'], category: 'Bases', tags: ['Lab reagents & indicators'], kind: 'ionic', note: 'A strong base whose solution turns cloudy with CO2 and whose octahydrate gives the classic endothermic reaction with ammonium salts.' },
  { name: 'Aluminium hydroxide', formula: 'Al(OH)3', aliases: ['aluminum hydroxide', 'gibbsite', 'hydrated alumina', 'ATH'], category: 'Bases', tags: ['Everyday & pharmaceuticals', 'Oxides & minerals', 'Polymers & monomers'], kind: 'ionic', note: 'An amphoteric hydroxide precipitated in the Bayer process from bauxite and used as an antacid and a flame-retardant filler.' },
  { name: 'Ammonium hydroxide', formula: 'NH4OH', aliases: ['ammonia water', 'aqueous ammonia', 'household ammonia', 'ammonia solution'], category: 'Bases', tags: ['Everyday & pharmaceuticals', 'Lab reagents & indicators'], kind: 'ionic', note: 'Ammonia dissolved in water; a weak base (pKb 4.75) used in cleaners and to precipitate metal hydroxides in qualitative analysis.' },
  { name: 'Sodium amide', formula: 'NaNH2', aliases: ['sodamide', 'sodium azanide'], category: 'Bases', tags: ['Lab reagents & indicators'], kind: 'ionic', note: 'A very strong base used to deprotonate terminal alkynes and in the industrial synthesis of indigo and sodium azide.' },
  { name: 'Sodium hydride', formula: 'NaH', aliases: ['sodium hydride ionic'], category: 'Bases', tags: ['Lab reagents & indicators'], kind: 'ionic', note: 'An ionic hydride with H- ions in a rock-salt lattice; a strong non-nucleophilic base used to deprotonate alcohols and active methylenes.' },
  { name: 'Potassium tert-butoxide', formula: 'C4H9KO', aliases: ['KOtBu', 'potassium t-butoxide', '(CH3)3COK'], category: 'Bases', tags: ['Lab reagents & indicators'], kind: 'ionic', note: 'A bulky strong alkoxide base favouring elimination over substitution, giving the less substituted (Hofmann) alkene.' },

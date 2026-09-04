// Periodic table data used by the formula parser, molar mass, and the
// renderers. Masses are the IUPAC conventional standard atomic weights
// (2021 abridged); a bracketed value in a textbook becomes the mass number of
// the longest lived isotope here. Colours are the Jmol CPK set, which is
// what 3Dmol.js and most textbooks use, so the 2D, 3D and snapshot views
// agree with each other. Covalent radii follow Cordero et al. (2008).

export interface Element {
  z: number;
  symbol: string;
  name: string;
  mass: number;
  /** Hex colour without '#'. */
  color: string;
  /** Covalent radius in angstrom. */
  radius: number;
}

type Row = [symbol: string, name: string, mass: number, color: string, radius: number];

const ROWS: Row[] = [
  ['H', 'Hydrogen', 1.008, 'FFFFFF', 0.31],
  ['He', 'Helium', 4.0026, 'D9FFFF', 0.28],
  ['Li', 'Lithium', 6.94, 'CC80FF', 1.28],
  ['Be', 'Beryllium', 9.0122, 'C2FF00', 0.96],
  ['B', 'Boron', 10.81, 'FFB5B5', 0.84],
  ['C', 'Carbon', 12.011, '909090', 0.76],
  ['N', 'Nitrogen', 14.007, '3050F8', 0.71],
  ['O', 'Oxygen', 15.999, 'FF0D0D', 0.66],
  ['F', 'Fluorine', 18.998, '90E050', 0.57],
  ['Ne', 'Neon', 20.18, 'B3E3F5', 0.58],
  ['Na', 'Sodium', 22.99, 'AB5CF2', 1.66],
  ['Mg', 'Magnesium', 24.305, '8AFF00', 1.41],
  ['Al', 'Aluminium', 26.982, 'BFA6A6', 1.21],
  ['Si', 'Silicon', 28.085, 'F0C8A0', 1.11],
  ['P', 'Phosphorus', 30.974, 'FF8000', 1.07],
  ['S', 'Sulfur', 32.06, 'FFFF30', 1.05],
  ['Cl', 'Chlorine', 35.45, '1FF01F', 1.02],
  ['Ar', 'Argon', 39.95, '80D1E3', 1.06],
  ['K', 'Potassium', 39.098, '8F40D4', 2.03],
  ['Ca', 'Calcium', 40.078, '3DFF00', 1.76],
  ['Sc', 'Scandium', 44.956, 'E6E6E6', 1.7],
  ['Ti', 'Titanium', 47.867, 'BFC2C7', 1.6],
  ['V', 'Vanadium', 50.942, 'A6A6AB', 1.53],
  ['Cr', 'Chromium', 51.996, '8A99C7', 1.39],
  ['Mn', 'Manganese', 54.938, '9C7AC7', 1.39],
  ['Fe', 'Iron', 55.845, 'E06633', 1.32],
  ['Co', 'Cobalt', 58.933, 'F090A0', 1.26],
  ['Ni', 'Nickel', 58.693, '50D050', 1.24],
  ['Cu', 'Copper', 63.546, 'C88033', 1.32],
  ['Zn', 'Zinc', 65.38, '7D80B0', 1.22],
  ['Ga', 'Gallium', 69.723, 'C28F8F', 1.22],
  ['Ge', 'Germanium', 72.63, '668F8F', 1.2],
  ['As', 'Arsenic', 74.922, 'BD80E3', 1.19],
  ['Se', 'Selenium', 78.971, 'FFA100', 1.2],
  ['Br', 'Bromine', 79.904, 'A62929', 1.2],
  ['Kr', 'Krypton', 83.798, '5CB8D1', 1.16],
  ['Rb', 'Rubidium', 85.468, '702EB0', 2.2],
  ['Sr', 'Strontium', 87.62, '00FF00', 1.95],
  ['Y', 'Yttrium', 88.906, '94FFFF', 1.9],
  ['Zr', 'Zirconium', 91.224, '94E0E0', 1.75],
  ['Nb', 'Niobium', 92.906, '73C2C9', 1.64],
  ['Mo', 'Molybdenum', 95.95, '54B5B5', 1.54],
  ['Tc', 'Technetium', 98, '3B9E9E', 1.47],
  ['Ru', 'Ruthenium', 101.07, '248F8F', 1.46],
  ['Rh', 'Rhodium', 102.91, '0A7D8C', 1.42],
  ['Pd', 'Palladium', 106.42, '006985', 1.39],
  ['Ag', 'Silver', 107.87, 'C0C0C0', 1.45],
  ['Cd', 'Cadmium', 112.41, 'FFD98F', 1.44],
  ['In', 'Indium', 114.82, 'A67573', 1.42],
  ['Sn', 'Tin', 118.71, '668080', 1.39],
  ['Sb', 'Antimony', 121.76, '9E63B5', 1.39],
  ['Te', 'Tellurium', 127.6, 'D47A00', 1.38],
  ['I', 'Iodine', 126.9, '940094', 1.39],
  ['Xe', 'Xenon', 131.29, '429EB0', 1.4],
  ['Cs', 'Caesium', 132.91, '57178F', 2.44],
  ['Ba', 'Barium', 137.33, '00C900', 2.15],
  ['La', 'Lanthanum', 138.91, '70D4FF', 2.07],
  ['Ce', 'Cerium', 140.12, 'FFFFC7', 2.04],
  ['Pr', 'Praseodymium', 140.91, 'D9FFC7', 2.03],
  ['Nd', 'Neodymium', 144.24, 'C7FFC7', 2.01],
  ['Pm', 'Promethium', 145, 'A3FFC7', 1.99],
  ['Sm', 'Samarium', 150.36, '8FFFC7', 1.98],
  ['Eu', 'Europium', 151.96, '61FFC7', 1.98],
  ['Gd', 'Gadolinium', 157.25, '45FFC7', 1.96],
  ['Tb', 'Terbium', 158.93, '30FFC7', 1.94],
  ['Dy', 'Dysprosium', 162.5, '1FFFC7', 1.92],
  ['Ho', 'Holmium', 164.93, '00FF9C', 1.92],
  ['Er', 'Erbium', 167.26, '00E675', 1.89],
  ['Tm', 'Thulium', 168.93, '00D452', 1.9],
  ['Yb', 'Ytterbium', 173.05, '00BF38', 1.87],
  ['Lu', 'Lutetium', 174.97, '00AB24', 1.87],
  ['Hf', 'Hafnium', 178.49, '4DC2FF', 1.75],
  ['Ta', 'Tantalum', 180.95, '4DA6FF', 1.7],
  ['W', 'Tungsten', 183.84, '2194D6', 1.62],
  ['Re', 'Rhenium', 186.21, '267DAB', 1.51],
  ['Os', 'Osmium', 190.23, '266696', 1.44],
  ['Ir', 'Iridium', 192.22, '175487', 1.41],
  ['Pt', 'Platinum', 195.08, 'D0D0E0', 1.36],
  ['Au', 'Gold', 196.97, 'FFD123', 1.36],
  ['Hg', 'Mercury', 200.59, 'B8B8D0', 1.32],
  ['Tl', 'Thallium', 204.38, 'A6544D', 1.45],
  ['Pb', 'Lead', 207.2, '575961', 1.46],
  ['Bi', 'Bismuth', 208.98, '9E4FB5', 1.48],
  ['Po', 'Polonium', 209, 'AB5C00', 1.4],
  ['At', 'Astatine', 210, '754F45', 1.5],
  ['Rn', 'Radon', 222, '428296', 1.5],
  ['Fr', 'Francium', 223, '420066', 2.6],
  ['Ra', 'Radium', 226, '007D00', 2.21],
  ['Ac', 'Actinium', 227, '70ABFA', 2.15],
  ['Th', 'Thorium', 232.04, '00BAFF', 2.06],
  ['Pa', 'Protactinium', 231.04, '00A1FF', 2.0],
  ['U', 'Uranium', 238.03, '008FFF', 1.96],
  ['Np', 'Neptunium', 237, '0080FF', 1.9],
  ['Pu', 'Plutonium', 244, '006BFF', 1.87],
  ['Am', 'Americium', 243, '545CF2', 1.8],
  ['Cm', 'Curium', 247, '785CE3', 1.69],
  ['Bk', 'Berkelium', 247, '8A4FE3', 1.68],
  ['Cf', 'Californium', 251, 'A136D4', 1.68],
  ['Es', 'Einsteinium', 252, 'B31FD4', 1.65],
  ['Fm', 'Fermium', 257, 'B31FBA', 1.67],
  ['Md', 'Mendelevium', 258, 'B30DA6', 1.73],
  ['No', 'Nobelium', 259, 'BD0D87', 1.76],
  ['Lr', 'Lawrencium', 266, 'C70066', 1.61],
  ['Rf', 'Rutherfordium', 267, 'CC0059', 1.57],
  ['Db', 'Dubnium', 268, 'D1004F', 1.49],
  ['Sg', 'Seaborgium', 269, 'D90045', 1.43],
  ['Bh', 'Bohrium', 270, 'E00038', 1.41],
  ['Hs', 'Hassium', 269, 'E6002E', 1.34],
  ['Mt', 'Meitnerium', 278, 'EB0026', 1.29],
  ['Ds', 'Darmstadtium', 281, 'EB0026', 1.28],
  ['Rg', 'Roentgenium', 282, 'EB0026', 1.21],
  ['Cn', 'Copernicium', 285, 'EB0026', 1.22],
  ['Nh', 'Nihonium', 286, 'EB0026', 1.36],
  ['Fl', 'Flerovium', 289, 'EB0026', 1.43],
  ['Mc', 'Moscovium', 290, 'EB0026', 1.62],
  ['Lv', 'Livermorium', 293, 'EB0026', 1.75],
  ['Ts', 'Tennessine', 294, 'EB0026', 1.65],
  ['Og', 'Oganesson', 294, 'EB0026', 1.57],
];

export const ELEMENTS: readonly Element[] = ROWS.map(([symbol, name, mass, color, radius], i) => ({
  z: i + 1,
  symbol,
  name,
  mass,
  color,
  radius,
}));

const BY_SYMBOL = new Map(ELEMENTS.map((e) => [e.symbol, e]));
const BY_NAME = new Map(ELEMENTS.map((e) => [e.name.toLowerCase(), e]));
BY_NAME.set('aluminum', BY_SYMBOL.get('Al')!);
BY_NAME.set('cesium', BY_SYMBOL.get('Cs')!);
BY_NAME.set('sulphur', BY_SYMBOL.get('S')!);

/** Case sensitive symbol lookup ('Cl', not 'CL'). */
export function elementBySymbol(symbol: string): Element | undefined {
  return BY_SYMBOL.get(symbol);
}

/** Case insensitive English name lookup, with the common US/UK variants. */
export function elementByName(name: string): Element | undefined {
  return BY_NAME.get(name.trim().toLowerCase());
}

export function elementByNumber(z: number): Element | undefined {
  return ELEMENTS[z - 1];
}

/** Colour for an atom symbol, with a neutral fallback for unknowns. */
export function cpkColor(symbol: string): string {
  return '#' + (BY_SYMBOL.get(symbol)?.color ?? 'FF1493');
}

/** Covalent radius in angstrom, 1.5 for anything not tabulated. */
export function covalentRadius(symbol: string): number {
  return BY_SYMBOL.get(symbol)?.radius ?? 1.5;
}

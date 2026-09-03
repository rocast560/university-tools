// Periodic table data. Masses are IUPAC 2021 conventional values, electronegativities are
// Pauling, covalent radii are Cordero et al. 2008 (Å), colours are the Jmol CPK scheme.
// `valence` is the number of valence electrons (group number for main-group elements,
// s+d electrons for transition metals).

export interface Element {
  z: number; symbol: string; name: string; mass: number; valence: number;
  en: number | null; radius: number; color: string;
}

type Row = [number, string, string, number, number, number | null, number, string];

const ROWS: Row[] = [
  [1, 'H', 'Hydrogen', 1.008, 1, 2.2, 0.31, '#FFFFFF'],
  [2, 'He', 'Helium', 4.0026, 2, null, 0.28, '#D9FFFF'],
  [3, 'Li', 'Lithium', 6.94, 1, 0.98, 1.28, '#CC80FF'],
  [4, 'Be', 'Beryllium', 9.0122, 2, 1.57, 0.96, '#C2FF00'],
  [5, 'B', 'Boron', 10.81, 3, 2.04, 0.84, '#FFB5B5'],
  [6, 'C', 'Carbon', 12.011, 4, 2.55, 0.76, '#909090'],
  [7, 'N', 'Nitrogen', 14.007, 5, 3.04, 0.71, '#3050F8'],
  [8, 'O', 'Oxygen', 15.999, 6, 3.44, 0.66, '#FF0D0D'],
  [9, 'F', 'Fluorine', 18.998, 7, 3.98, 0.57, '#90E050'],
  [10, 'Ne', 'Neon', 20.18, 8, null, 0.58, '#B3E3F5'],
  [11, 'Na', 'Sodium', 22.99, 1, 0.93, 1.66, '#AB5CF2'],
  [12, 'Mg', 'Magnesium', 24.305, 2, 1.31, 1.41, '#8AFF00'],
  [13, 'Al', 'Aluminium', 26.982, 3, 1.61, 1.21, '#BFA6A6'],
  [14, 'Si', 'Silicon', 28.085, 4, 1.9, 1.11, '#F0C8A0'],
  [15, 'P', 'Phosphorus', 30.974, 5, 2.19, 1.07, '#FF8000'],
  [16, 'S', 'Sulfur', 32.06, 6, 2.58, 1.05, '#FFFF30'],
  [17, 'Cl', 'Chlorine', 35.45, 7, 3.16, 1.02, '#1FF01F'],
  [18, 'Ar', 'Argon', 39.948, 8, null, 1.06, '#80D1E3'],
  [19, 'K', 'Potassium', 39.098, 1, 0.82, 2.03, '#8F40D4'],
  [20, 'Ca', 'Calcium', 40.078, 2, 1.0, 1.76, '#3DFF00'],
  [21, 'Sc', 'Scandium', 44.956, 3, 1.36, 1.7, '#E6E6E6'],
  [22, 'Ti', 'Titanium', 47.867, 4, 1.54, 1.6, '#BFC2C7'],
  [23, 'V', 'Vanadium', 50.942, 5, 1.63, 1.53, '#A6A6AB'],
  [24, 'Cr', 'Chromium', 51.996, 6, 1.66, 1.39, '#8A99C7'],
  [25, 'Mn', 'Manganese', 54.938, 7, 1.55, 1.39, '#9C7AC7'],
  [26, 'Fe', 'Iron', 55.845, 8, 1.83, 1.32, '#E06633'],
  [27, 'Co', 'Cobalt', 58.933, 9, 1.88, 1.26, '#F090A0'],
  [28, 'Ni', 'Nickel', 58.693, 10, 1.91, 1.24, '#50D050'],
  [29, 'Cu', 'Copper', 63.546, 11, 1.9, 1.32, '#C88033'],
  [30, 'Zn', 'Zinc', 65.38, 12, 1.65, 1.22, '#7D80B0'],
  [31, 'Ga', 'Gallium', 69.723, 3, 1.81, 1.22, '#C28F8F'],
  [32, 'Ge', 'Germanium', 72.63, 4, 2.01, 1.2, '#668F8F'],
  [33, 'As', 'Arsenic', 74.922, 5, 2.18, 1.19, '#BD80E3'],
  [34, 'Se', 'Selenium', 78.971, 6, 2.55, 1.2, '#FFA100'],
  [35, 'Br', 'Bromine', 79.904, 7, 2.96, 1.2, '#A62929'],
  [36, 'Kr', 'Krypton', 83.798, 8, 3.0, 1.16, '#5CB8D1'],
  [37, 'Rb', 'Rubidium', 85.468, 1, 0.82, 2.2, '#702EB0'],
  [38, 'Sr', 'Strontium', 87.62, 2, 0.95, 1.95, '#00FF00'],
  [39, 'Y', 'Yttrium', 88.906, 3, 1.22, 1.9, '#94FFFF'],
  [40, 'Zr', 'Zirconium', 91.224, 4, 1.33, 1.75, '#94E0E0'],
  [41, 'Nb', 'Niobium', 92.906, 5, 1.6, 1.64, '#73C2C9'],
  [42, 'Mo', 'Molybdenum', 95.95, 6, 2.16, 1.54, '#54B5B5'],
  [43, 'Tc', 'Technetium', 98, 7, 1.9, 1.47, '#3B9E9E'],
  [44, 'Ru', 'Ruthenium', 101.07, 8, 2.2, 1.46, '#248F8F'],
  [45, 'Rh', 'Rhodium', 102.91, 9, 2.28, 1.42, '#0A7D8C'],
  [46, 'Pd', 'Palladium', 106.42, 10, 2.2, 1.39, '#006985'],
  [47, 'Ag', 'Silver', 107.87, 11, 1.93, 1.45, '#C0C0C0'],
  [48, 'Cd', 'Cadmium', 112.41, 12, 1.69, 1.44, '#FFD98F'],
  [49, 'In', 'Indium', 114.82, 3, 1.78, 1.42, '#A67573'],
  [50, 'Sn', 'Tin', 118.71, 4, 1.96, 1.39, '#668080'],
  [51, 'Sb', 'Antimony', 121.76, 5, 2.05, 1.39, '#9E63B5'],
  [52, 'Te', 'Tellurium', 127.6, 6, 2.1, 1.38, '#D47A00'],
  [53, 'I', 'Iodine', 126.9, 7, 2.66, 1.39, '#940094'],
  [54, 'Xe', 'Xenon', 131.29, 8, 2.6, 1.4, '#429EB0'],
  [55, 'Cs', 'Caesium', 132.91, 1, 0.79, 2.44, '#57178F'],
  [56, 'Ba', 'Barium', 137.33, 2, 0.89, 2.15, '#00C900'],
  [74, 'W', 'Tungsten', 183.84, 6, 2.36, 1.62, '#2194D6'],
  [78, 'Pt', 'Platinum', 195.08, 10, 2.28, 1.36, '#D0D0E0'],
  [79, 'Au', 'Gold', 196.97, 11, 2.54, 1.36, '#FFD123'],
  [80, 'Hg', 'Mercury', 200.59, 12, 2.0, 1.32, '#B8B8D0'],
  [82, 'Pb', 'Lead', 207.2, 4, 2.33, 1.46, '#575961'],
  [92, 'U', 'Uranium', 238.03, 6, 1.38, 1.96, '#008FFF'],
];

export const ELEMENTS: Element[] = ROWS.map(([z, symbol, name, mass, valence, en, radius, color]) => ({
  z, symbol, name, mass, valence, en, radius, color,
}));

const BY_SYMBOL = new Map(ELEMENTS.map((e) => [e.symbol, e]));
const BY_NUMBER = new Map(ELEMENTS.map((e) => [e.z, e]));

export function bySymbol(symbol: string): Element | undefined { return BY_SYMBOL.get(symbol); }
export function byNumber(z: number): Element | undefined { return BY_NUMBER.get(z); }

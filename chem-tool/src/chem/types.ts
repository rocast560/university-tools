// Shared data model (spec section 5). Server, client and tests import from here.

export type Source = 'library' | 'pubchem' | 'smiles' | 'edit';

export interface Atom { index: number; element: string; x: number; y: number; z: number; charge: number }
export interface Bond { a: number; b: number; order: 1 | 2 | 3; aromatic: boolean }
export interface Composition { element: string; count: number; massPercent: number }

export interface LewisData {
  valenceElectrons: number;
  atoms: { index: number; lonePairs: number; formalCharge: number; octet: 'ok' | 'incomplete' | 'expanded' | 'radical' }[];
  bonds: { a: number; b: number; order: 1 | 2 | 3; delocalised: boolean }[];
  hasResonance: boolean;
  svg: string;
}

export interface VseprCenter {
  index: number; element: string;
  bondedGroups: number; lonePairs: number; stericNumber: number;
  electronGeometry: string; molecularGeometry: string; hybridisation: string;
  idealAngle: number;
  measuredAngles: { min: number; mean: number; max: number };
}

export interface PolarityData {
  bonds: { a: number; b: number; deltaEN: number; kind: 'nonpolar' | 'polar' | 'ionic'; towards: number }[];
  netDipole: { x: number; y: number; z: number; magnitude: number };
  polar: boolean;
  reasoning: string;
  arrow?: { from: [number, number, number]; to: [number, number, number] };
  sigmaBonds: number; piBonds: number;
}

/** lewis, vsepr and polarity are filled in phase 3. */
export interface SpeciesInfo {
  molarMass: number;
  composition: Composition[];
  lewis?: LewisData;
  vsepr?: VseprCenter[];
  polarity?: PolarityData;
}

/** How the 3D coordinates were obtained. 'flat' means 2D coordinates with z = 0. */
export type Geometry = 'conformer' | 'star' | 'flat';

export interface Species {
  id: string;
  name: string;
  iupacName?: string;
  /** Hill order with charge suffix: "C2H4O2", "O4S 2-". Used for matching. */
  formula: string;
  /** Conventional form for display: "CH3COOH", "SO4 2-". */
  displayFormula: string;
  charge: number;
  source: Source;
  cid?: number; cas?: string; description?: string; category?: string;
  smiles: string;
  molfile2d: string;
  molfile3d: string;
  geometry: Geometry;
  atoms: Atom[];
  bonds: Bond[];
  info: SpeciesInfo;
  svg2d: string;
  svg2dNumbered: string;
}

export interface ViewState {
  style: 'ballstick' | 'stick' | 'spacefill' | 'wireframe';
  labels: 'none' | 'element' | 'index';
  highlight: number[];
  spin: boolean;
  showDipole: boolean;
  showHydrogens: boolean;
  camera: { preset: 'fit' | 'front' | 'top' | 'side'; rotation: [number, number, number] };
}

export const DEFAULT_VIEW: ViewState = {
  style: 'ballstick', labels: 'none', highlight: [], spin: false, showDipole: false, showHydrogens: true,
  camera: { preset: 'fit', rotation: [0, 0, 0] },
};

export interface Equation {
  reactants: { coefficient: number; speciesId: string }[];
  products: { coefficient: number; speciesId: string }[];
  balanced: boolean;
  text: string;
}

export interface Scene {
  id: string;
  title: string;
  kind: 'molecule' | 'reaction';
  species: Species[];
  equation?: Equation;
  focusId: string;
  view: ViewState;
  history: { past: SceneSnapshot[]; future: SceneSnapshot[] };
}

export type SceneSnapshot = Pick<Scene, 'kind' | 'species' | 'equation' | 'focusId'>;

export interface Workspace { version: number; scenes: Scene[]; activeSceneId: string }

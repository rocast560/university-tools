# ChemTool Phases 1 and 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Bun server that resolves a chemical name, formula or SMILES into a 2D drawing, a 3D model and basic info, holds a live workspace that MCP clients and a React window edit together, and (phase 2) supports atom-level edits, a sketcher, undo, view commands and live WebGL snapshots.

**Architecture:** One Bun process owns chemistry (OpenChemLib), the workspace, REST, WebSocket and MCP. Every change goes through `WorkspaceStore.dispatch`, which bumps a version and broadcasts the whole workspace to every connected window. The React client is a renderer of that state plus a command sender. Chemistry modules are pure and Node-compatible so Vitest runs them; only `server/index.ts` touches Bun APIs.

**Tech Stack:** Bun 1.3, Hono 4, `@hono/mcp`, `@modelcontextprotocol/sdk`, OpenChemLib 9.25, `@resvg/resvg-wasm`, zod 4, React 19, Vite 8, Vitest 4, Zustand 5, 3Dmol.js 2.5.

**Spec:** `chem-tool/docs/superpowers/specs/2026-09-03-chem-tool-design.md` (sections 4 to 10, 12 to 14). Read it first. This plan implements phases 1 and 2 of section 14. Two deliberate deviations from the spec, both small: `Species` gains `displayFormula` (the conventional formula such as `CH3COOH`) beside the Hill `formula` (`C2H4O2`) used for matching, and hydrogens are re-saturated automatically after every edit command instead of via an explicit `set_hydrogens` op.

## Global Constraints

- Working directory for every command is `chem-tool/` inside the `university-tools` repo. Paths below are relative to it.
- Runtime: Bun `>=1.3` runs the server; Node `>=24` runs Vitest. Vitest runs under Node, so **no Bun-only API (`Bun.serve`, `Bun.file`) anywhere except `server/index.ts`**. Use `node:fs/promises`, `node:path`, `fetch`, `WebSocket`.
- ESM only (`"type": "module"`), TypeScript strict, extensionless relative imports (`./formula`), `moduleResolution: bundler`.
- Port `8140`, host `127.0.0.1`, env vars exactly as spec 4.2: `PORT`, `TUNNEL_PORT`, `HOST`, `DATA_DIR` (default `./.data`), `STATIC_DIR` (default `./dist`), `PUBCHEM_LIVE`.
- Atom numbering is 1-based, heavy atoms first, hydrogens after, everywhere a user or an AI sees it. Internal OpenChemLib indices are 0-based; convert at the boundary.
- `Species` objects are immutable once built. Never mutate one; build a new one.
- Tests: `bun run test` (Vitest). No network in tests unless `PUBCHEM_LIVE=1`. OpenChemLib 3D generation is slow (up to 1 s for sugars); keep per-test molecule counts small.
- **Git: the repo index already holds unrelated staged entries from an earlier incident. Never run `git add -A`, `git add .`, `git commit -a`, or a bare `git commit`. Always `git add <files>` then `git commit -m "..." -- <files>`.** Every commit message ends with the two trailer lines:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01QiWkMqG7iGFc1gM4UJChdf`
  (pass them as extra `-m` arguments as shown in each commit step).
- Never delete or rename a directory with a shell command in this repo (see `INCIDENT-2026-09-03-folder-deletion.md` at the repo root).

## File structure

| Path | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `.gitignore` | Scaffold. `vite.config.ts` also carries the Vitest config. |
| `src/chem/types.ts` | Shared data types (spec section 5). |
| `src/chem/elements.ts` | Periodic table data and lookups. |
| `src/chem/formula.ts` | Formula parsing, Hill order, molar mass, composition. |
| `src/chem/structure.ts` | OpenChemLib wrappers: parse, 2D SVG, 3D geometry, atom/bond extraction. |
| `src/chem/species.ts` | Builds a `Species` from SMILES, molfile or a `Molecule`. |
| `data/seed.ts` | Curated compounds with SMILES. |
| `src/chem/library.ts` | Indexes over the seed: by name, alias, formula; search; suggestions. |
| `src/chem/pubchem.ts` | PubChem PUG REST client with disk cache and rate limit. |
| `src/chem/resolve.ts` | Query pipeline: library, formula, SMILES, PubChem. |
| `src/chem/png.ts` | SVG to PNG via resvg-wasm. |
| `src/chem/render3d.ts` | Software 3D snapshot to SVG. |
| `src/chem/edit.ts` | (Phase 2) Atom-level edit ops with valence checking. |
| `server/config.ts` | Environment variables. |
| `server/schemas.ts` | zod schemas for commands, view state, edit ops. |
| `server/workspace.ts` | `WorkspaceStore`: the single mutation path, history, listeners. |
| `server/persist.ts` | Load and debounced save of `workspace.json`. |
| `server/static.ts` | Static file serving from `STATIC_DIR` with immutable caching. |
| `server/api.ts` | REST routes under `/api`. |
| `server/ws.ts` | WebSocket protocol, window registry. |
| `server/snapshots.ts` | (Phase 2) Live snapshot broker. |
| `server/mcp.ts` | MCP server definition and `/mcp` mount. |
| `server/app.ts` | Assembles the Hono app from the pieces above. |
| `server/index.ts` | Bun entry point. |
| `src/client/main.tsx`, `App.tsx`, `styles.css` | React shell and layout. |
| `src/client/store.ts`, `selectors.ts` | Zustand store and pure selectors. |
| `src/client/ws.ts`, `commands.ts`, `api.ts` | Live connection, command helpers, REST helpers. |
| `src/client/components/*` | `SearchBar`, `SceneTabs`, `Viewer3D`, `SidePanel`, `Structure2D`, `InfoPanel`, `StatusBar`, `ConnectDialog`, (phase 2) `Sketch`. |
| `src/client/viewer3d.ts` | 3Dmol.js wrapper, loaded lazily. |
| `src/client/sketchSync.ts` | (Phase 2) Echo-suppression logic for the sketcher. |

---

## Phase 1

### Task 1: Scaffold, shared types, periodic table

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `.gitignore`
- Create: `src/chem/types.ts`, `src/chem/elements.ts`
- Test: `src/chem/elements.test.ts`

**Interfaces:**
- Produces: every type in `src/chem/types.ts` (copied below); `ELEMENTS: Element[]`, `bySymbol(symbol: string): Element | undefined`, `byNumber(z: number): Element | undefined` where `Element = { z, symbol, name, mass, valence, en: number | null, radius, color }` (mass in g/mol, `valence` = valence electrons, `en` = Pauling electronegativity, `radius` = covalent radius in Å, `color` = CPK hex).

- [ ] **Step 1: Create the scaffold files**

`package.json` (dependencies are added in step 2):

```json
{
  "name": "chem-tool",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "description": "Look up a chemical by name, formula or SMILES; see it in 2D and 3D; edit it live from Claude or ChatGPT over MCP.",
  "scripts": {
    "dev": "vite",
    "dev:server": "bun --watch server/index.ts",
    "build": "vite build",
    "start": "bun server/index.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": { "bun": ">=1.3", "node": ">=24" }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["bun-types", "vite/client"]
  },
  "include": ["src", "server", "data", "scripts", "proxy", "vite.config.ts"]
}
```

`vite.config.ts` (Vite and Vitest share it):

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8140',
      '/mcp': 'http://127.0.0.1:8140',
      '/openapi.json': 'http://127.0.0.1:8140',
      '/ws': { target: 'ws://127.0.0.1:8140', ws: true },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'server/**/*.test.ts'],
    testTimeout: 20000,
  },
});
```

`index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ChemTool</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/client/main.tsx"></script>
  </body>
</html>
```

`.gitignore`:

```
node_modules/
dist/
.data/
coverage/
*.log
```

`src/chem/types.ts`:

```ts
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
```

- [ ] **Step 2: Install dependencies**

Run:

```bash
bun add hono @hono/mcp @modelcontextprotocol/sdk openchemlib @resvg/resvg-wasm zod
bun add -d vite vitest @vitejs/plugin-react typescript@^5.9 @types/bun react react-dom @types/react @types/react-dom zustand 3dmol jsdom @testing-library/react
```

Expected: `package.json` gains `dependencies` and `devDependencies`; `bun.lock` is created. React, Zustand and 3Dmol are dev dependencies on purpose: they are bundled into `dist/` and the server never imports them.

- [ ] **Step 3: Write the failing test**

`src/chem/elements.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { ELEMENTS, byNumber, bySymbol } from './elements';

describe('elements', () => {
  test('looks up oxygen by symbol', () => {
    const o = bySymbol('O');
    expect(o?.name).toBe('Oxygen');
    expect(o?.mass).toBeCloseTo(15.999, 3);
    expect(o?.valence).toBe(6);
    expect(o?.en).toBeCloseTo(3.44, 2);
    expect(o?.color).toBe('#FF0D0D');
  });
  test('looks up by atomic number', () => {
    expect(byNumber(6)?.symbol).toBe('C');
    expect(byNumber(999)).toBeUndefined();
  });
  test('is case sensitive and rejects unknown symbols', () => {
    expect(bySymbol('CL')).toBeUndefined();
    expect(bySymbol('Cl')?.z).toBe(17);
    expect(bySymbol('Xx')).toBeUndefined();
  });
  test('noble gases have no electronegativity, transition metals have group valence', () => {
    expect(bySymbol('Ne')?.en).toBeNull();
    expect(bySymbol('Fe')?.valence).toBe(8);
    expect(ELEMENTS.length).toBeGreaterThanOrEqual(60);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `bun run test src/chem/elements.test.ts`
Expected: FAIL, cannot resolve `./elements`.

- [ ] **Step 5: Write the implementation**

`src/chem/elements.ts`:

```ts
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
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun run test src/chem/elements.test.ts`
Expected: 4 passed.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock tsconfig.json vite.config.ts index.html .gitignore src/chem/types.ts src/chem/elements.ts src/chem/elements.test.ts
git commit -m "feat(chem-tool): scaffold, shared types, periodic table" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QiWkMqG7iGFc1gM4UJChdf" -- package.json bun.lock tsconfig.json vite.config.ts index.html .gitignore src/chem/types.ts src/chem/elements.ts src/chem/elements.test.ts
```

---

### Task 2: Formula parsing, Hill order, molar mass

**Files:**
- Create: `src/chem/formula.ts`
- Test: `src/chem/formula.test.ts`

**Interfaces:**
- Consumes: `bySymbol` from Task 1, `Composition` type.
- Produces: `type Counts = Record<string, number>`; `parseFormula(text): { counts: Counts; charge: number }` (throws `FormulaError`); `hillFormula(counts, charge = 0): string`; `molarMass(counts): number`; `composition(counts): Composition[]`; `looksLikeFormula(text): boolean`; `normalizeFormulaText(text): string`.

Charge notation rule (document it in the module comment and keep it): the sign alone means magnitude 1 (`NH4+`, `OH-`, `C2H3O2-`); digits before the sign are the magnitude only when separated by a space, `^` or parentheses (`SO4 2-`, `Fe^3+`, `SO4(2-)`), or when the body is a single element symbol (`Fe3+`, `Ca2+`).

- [ ] **Step 1: Write the failing test**

`src/chem/formula.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { FormulaError, composition, hillFormula, looksLikeFormula, molarMass, parseFormula } from './formula';

describe('parseFormula', () => {
  test('simple and nested groups', () => {
    expect(parseFormula('H2O')).toEqual({ counts: { H: 2, O: 1 }, charge: 0 });
    expect(parseFormula('Ca(OH)2').counts).toEqual({ Ca: 1, O: 2, H: 2 });
    expect(parseFormula('CH3COOH').counts).toEqual({ C: 2, H: 4, O: 2 });
    expect(parseFormula('K4[Fe(CN)6]').counts).toEqual({ K: 4, Fe: 1, C: 6, N: 6 });
  });
  test('hydrates and unicode', () => {
    expect(parseFormula('CuSO4·5H2O').counts).toEqual({ Cu: 1, S: 1, O: 9, H: 10 });
    expect(parseFormula('CuSO4.5H2O').counts).toEqual({ Cu: 1, S: 1, O: 9, H: 10 });
    expect(parseFormula('H₂O').counts).toEqual({ H: 2, O: 1 });
    expect(parseFormula('SO₄²⁻')).toEqual({ counts: { S: 1, O: 4 }, charge: -2 });
  });
  test('charge notation', () => {
    expect(parseFormula('NH4+').charge).toBe(1);
    expect(parseFormula('NH4+').counts).toEqual({ N: 1, H: 4 });
    expect(parseFormula('OH-').charge).toBe(-1);
    expect(parseFormula('C2H3O2-')).toEqual({ counts: { C: 2, H: 3, O: 2 }, charge: -1 });
    expect(parseFormula('SO4 2-')).toEqual({ counts: { S: 1, O: 4 }, charge: -2 });
    expect(parseFormula('SO4^2-').charge).toBe(-2);
    expect(parseFormula('SO4(2-)').charge).toBe(-2);
    expect(parseFormula('Fe3+')).toEqual({ counts: { Fe: 1 }, charge: 3 });
    expect(parseFormula('Ca2+').charge).toBe(2);
  });
  test('rejects garbage', () => {
    expect(() => parseFormula('Xy2')).toThrow(FormulaError);
    expect(() => parseFormula('H2O)')).toThrow(FormulaError);
    expect(() => parseFormula('(H2O')).toThrow(FormulaError);
    expect(() => parseFormula('')).toThrow(FormulaError);
    expect(() => parseFormula('water')).toThrow(FormulaError);
  });
});

describe('hillFormula', () => {
  test('carbon first, hydrogen second, then alphabetical', () => {
    expect(hillFormula({ C: 2, H: 4, O: 2 })).toBe('C2H4O2');
    expect(hillFormula({ O: 1, H: 2 })).toBe('H2O');
    expect(hillFormula({ Na: 1, Cl: 1 })).toBe('ClNa');
    expect(hillFormula({ S: 1, O: 4 }, -2)).toBe('O4S 2-');
    expect(hillFormula({ N: 1, H: 4 }, 1)).toBe('H4N +');
    expect(hillFormula({ Fe: 1 }, 3)).toBe('Fe 3+');
  });
});

describe('molarMass and composition', () => {
  test('known masses', () => {
    expect(molarMass({ H: 2, O: 1 })).toBeCloseTo(18.015, 2);
    expect(molarMass({ C: 6, H: 12, O: 6 })).toBeCloseTo(180.156, 2);
    expect(molarMass(parseFormula('CuSO4·5H2O').counts)).toBeCloseTo(249.68, 1);
  });
  test('mass percent in Hill order', () => {
    const c = composition({ H: 2, O: 1 });
    expect(c.map((x) => x.element)).toEqual(['H', 'O']);
    expect(c[0].massPercent).toBeCloseTo(11.19, 2);
    expect(c[1].massPercent).toBeCloseTo(88.81, 2);
  });
});

test('looksLikeFormula', () => {
  expect(looksLikeFormula('NaCl')).toBe(true);
  expect(looksLikeFormula('SO4 2-')).toBe(true);
  expect(looksLikeFormula('water')).toBe(false);
  expect(looksLikeFormula('acetic acid')).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/chem/formula.test.ts`
Expected: FAIL, cannot resolve `./formula`.

- [ ] **Step 3: Write the implementation**

`src/chem/formula.ts`:

```ts
// Chemical formula text: parse, Hill order, molar mass, composition.
//
// Charge notation: the sign alone means magnitude 1 ("NH4+", "OH-", "C2H3O2-").
// Digits before the sign are the magnitude only when separated by a space, "^" or
// parentheses ("SO4 2-", "Fe^3+", "SO4(2-)"), or when the body is one element symbol
// ("Fe3+", "Ca2+"). "SO42-" therefore parses as S O42 with charge -1; the library
// catches that case by name ("sulfate") before formula parsing is attempted.

import { bySymbol } from './elements';
import type { Composition } from './types';

export type Counts = Record<string, number>;
export interface ParsedFormula { counts: Counts; charge: number }
export class FormulaError extends Error {}

const SUB: Record<string, string> = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };
const SUP: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-' };

export function normalizeFormulaText(text: string): string {
  return text
    .trim()
    .replace(/[₀-₉]/g, (c) => SUB[c])
    // A superscript charge ("²⁻", "⁺") is unambiguous: turn it into the "^2-" separator form.
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]*[⁺⁻]/g, (m) => '^' + [...m].map((c) => SUP[c]).join(''))
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => SUP[c])
    .replace(/[·•*]/g, '.')
    .replace(/[−–]/g, '-')
    .replace(/\s+/g, ' ');
}

function splitCharge(text: string): { body: string; charge: number } {
  const m = /^(.*?)([ ^(]?)(\d*)([+-])\)?$/.exec(text);
  if (!m) return { body: text, charge: 0 };
  const [, body, sep, digits, sign] = m;
  const s = sign === '+' ? 1 : -1;
  if (sep) return { body, charge: s * (digits ? Number(digits) : 1) };
  const singleElement = /^[A-Z][a-z]?$/.test(body);
  if (digits && singleElement) return { body, charge: s * Number(digits) };
  return { body: body + digits, charge: s };
}

class Parser {
  private i = 0;
  constructor(private readonly s: string, private readonly original: string) {}

  parseGroups(close: string | null): Counts {
    const counts: Counts = {};
    while (this.i < this.s.length) {
      const ch = this.s[this.i];
      if (ch === close) { this.i++; return counts; }
      let inner: Counts;
      if (ch === '(' || ch === '[') {
        this.i++;
        inner = this.parseGroups(ch === '(' ? ')' : ']');
      } else {
        const m = /^[A-Z][a-z]?/.exec(this.s.slice(this.i));
        if (!m || !bySymbol(m[0])) throw new FormulaError(`Unknown element at "${this.s.slice(this.i)}" in "${this.original}"`);
        this.i += m[0].length;
        inner = { [m[0]]: 1 };
      }
      const n = this.readNumber();
      for (const [el, c] of Object.entries(inner)) counts[el] = (counts[el] ?? 0) + c * n;
    }
    if (close) throw new FormulaError(`Missing "${close}" in "${this.original}"`);
    return counts;
  }

  private readNumber(): number {
    const m = /^\d+/.exec(this.s.slice(this.i));
    if (!m) return 1;
    this.i += m[0].length;
    return Number(m[0]);
  }
}

export function parseFormula(text: string): ParsedFormula {
  const norm = normalizeFormulaText(text);
  if (!norm) throw new FormulaError('Empty formula');
  const { body, charge } = splitCharge(norm);
  const counts: Counts = {};
  for (const part of body.replace(/ /g, '').split('.')) {
    if (!part) throw new FormulaError(`Empty fragment in "${text}"`);
    const m = /^(\d*)(.*)$/.exec(part)!;
    const mult = m[1] ? Number(m[1]) : 1;
    const c = new Parser(m[2], text).parseGroups(null);
    for (const [el, n] of Object.entries(c)) counts[el] = (counts[el] ?? 0) + n * mult;
  }
  if (Object.keys(counts).length === 0) throw new FormulaError(`No elements in "${text}"`);
  return { counts, charge };
}

/** Element symbols in Hill order: C, H, then alphabetical; all alphabetical when there is no carbon. */
export function hillOrder(counts: Counts): string[] {
  const syms = Object.keys(counts).filter((s) => counts[s] > 0);
  const hasC = syms.includes('C');
  const rest = syms.filter((s) => !(hasC && (s === 'C' || s === 'H'))).sort();
  return hasC ? ['C', ...(syms.includes('H') ? ['H'] : []), ...rest] : rest;
}

export function hillFormula(counts: Counts, charge = 0): string {
  const body = hillOrder(counts).map((s) => s + (counts[s] === 1 ? '' : counts[s])).join('');
  if (!charge) return body;
  const mag = Math.abs(charge);
  return `${body} ${mag === 1 ? '' : mag}${charge > 0 ? '+' : '-'}`;
}

export function molarMass(counts: Counts): number {
  let total = 0;
  for (const [el, n] of Object.entries(counts)) {
    const e = bySymbol(el);
    if (!e) throw new FormulaError(`Unknown element ${el}`);
    total += e.mass * n;
  }
  return total;
}

export function composition(counts: Counts): Composition[] {
  const total = molarMass(counts);
  return hillOrder(counts).map((el) => ({
    element: el,
    count: counts[el],
    massPercent: Math.round((100 * bySymbol(el)!.mass * counts[el] / total) * 100) / 100,
  }));
}

export function looksLikeFormula(text: string): boolean {
  try { parseFormula(text); return true; } catch { return false; }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test src/chem/formula.test.ts`
Expected: all pass. If `SO₄²⁻` fails, check that `normalizeFormulaText` runs the superscript replacement before `splitCharge` sees the text.

- [ ] **Step 5: Commit**

```bash
git add src/chem/formula.ts src/chem/formula.test.ts
git commit -m "feat(chem-tool): formula parser, Hill order, molar mass" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QiWkMqG7iGFc1gM4UJChdf" -- src/chem/formula.ts src/chem/formula.test.ts
```

---

### Task 3: OpenChemLib wrappers: parse, 2D SVG, 3D geometry

**Files:**
- Create: `src/chem/structure.ts`
- Test: `src/chem/structure.test.ts`

**Interfaces:**
- Consumes: `Atom`, `Bond`, `Geometry` types; `bySymbol`; `Counts`.
- Produces (all synchronous):
  - `ensureResources(): void` (registers OpenChemLib's static tables once; call before 3D)
  - `parseSmiles(smiles): OCL.Molecule | null`, `parseMolfile(molfile): OCL.Molecule | null`
  - `heavyAtomCount(mol): number`, `heavyCopy(mol): OCL.Molecule` (explicit hydrogens removed, unless the molecule is hydrogen only)
  - `toSvg(mol, { width?, height?, numbered?, hydrogens? }): string`
  - `to3D(mol, seed = 42): { mol: OCL.Molecule; geometry: Geometry }` (explicit hydrogens, heavy atoms first, fragments side by side)
  - `reorderHeavyFirst(mol): OCL.Molecule`
  - `extractAtomsBonds(mol3d): { atoms: Atom[]; bonds: Bond[] }` (1-based indices)
  - `countsOf(mol): Counts` (implicit hydrogens included), `totalCharge(mol): number`, `canonicalSmiles(mol): string`
  - `molfile2D(mol): string`, `molfile3D(mol3d): string`

Facts verified against OpenChemLib 9.25 under Bun and Node: `Resources.registerFromNodejs()` works in both; `ConformerGenerator(seed).getOneConformerAsMolecule(mol)` returns `null` for metal centres such as permanganate and stacks disconnected fragments on top of each other, hence the per-fragment layout and the star fallback; `toSVG`'s `showAtomNumber` option is 0-based, hence custom labels; `deleteAtom` shifts later indices down; `addMolecule(frag)` returns the new indices of the fragment's atoms; `getIDCode()` is equal for the same molecule parsed from SMILES, from a molfile, or stripped of explicit hydrogens after 3D generation.

- [ ] **Step 1: Write the failing test**

`src/chem/structure.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  canonicalSmiles, countsOf, extractAtomsBonds, heavyAtomCount, molfile2D, molfile3D,
  parseMolfile, parseSmiles, to3D, toSvg, totalCharge,
} from './structure';

describe('parsing', () => {
  test('valid and invalid SMILES', () => {
    expect(parseSmiles('CCO')?.getAllAtoms()).toBe(3);
    expect(parseSmiles('C(')).toBeNull();
    expect(parseSmiles('')).toBeNull();
  });
  test('molfile round trip', () => {
    const mol = parseSmiles('CC(=O)O')!;
    const back = parseMolfile(molfile2D(mol));
    expect(back?.getAllAtoms()).toBe(4);
    expect(parseMolfile('garbage')).toBeNull();
  });
});

describe('toSvg', () => {
  test('draws water with hydrogens and ethanol without', () => {
    const water = toSvg(parseSmiles('O')!);
    expect(water).toContain('<svg');
    expect(water).toMatch(/>H/);
    expect(water).toContain('currentColor');
    expect(water).not.toContain('class="event"');
    const ethanol = toSvg(parseSmiles('CCO')!);
    expect(ethanol).toContain('<svg');
  });
  test('numbered drawing labels heavy atoms C1, C2, O3', () => {
    const svg = toSvg(parseSmiles('CCO')!, { numbered: true });
    expect(svg).toContain('C1');
    expect(svg).toContain('C2');
    expect(svg).toContain('O3');
  });
});

describe('to3D', () => {
  test('acetic acid: 8 atoms, heavy first, real z coordinates', () => {
    const { mol, geometry } = to3D(parseSmiles('CC(=O)O')!);
    expect(geometry).toBe('conformer');
    const { atoms, bonds } = extractAtomsBonds(mol);
    expect(atoms).toHaveLength(8);
    expect(atoms.slice(0, 4).map((a) => a.element)).toEqual(['C', 'C', 'O', 'O']);
    expect(atoms.slice(4).every((a) => a.element === 'H')).toBe(true);
    expect(atoms[0].index).toBe(1);
    expect(atoms.some((a) => Math.abs(a.z) > 0.1)).toBe(true);
    expect(bonds).toHaveLength(7);
    expect(bonds.every((b) => b.a >= 1 && b.b <= 8)).toBe(true);
  });
  test('salt fragments are laid out apart', () => {
    const { mol } = to3D(parseSmiles('[Na+].[Cl-]')!);
    const { atoms } = extractAtomsBonds(mol);
    expect(atoms.map((a) => a.charge)).toEqual([1, -1]);
    const d = Math.hypot(atoms[0].x - atoms[1].x, atoms[0].y - atoms[1].y, atoms[0].z - atoms[1].z);
    expect(d).toBeGreaterThan(2);
  });
  test('permanganate falls back to ideal star geometry', () => {
    const { mol, geometry } = to3D(parseSmiles('[O-][Mn](=O)(=O)=O')!);
    expect(geometry).toBe('star');
    const { atoms, bonds } = extractAtomsBonds(mol);
    expect(atoms).toHaveLength(5);
    expect(bonds).toHaveLength(4);
    const mn = atoms.find((a) => a.element === 'Mn')!;
    for (const o of atoms.filter((a) => a.element === 'O')) {
      expect(Math.hypot(o.x - mn.x, o.y - mn.y, o.z - mn.z)).toBeCloseTo(1.39 + 0.66, 1);
    }
  });
  test('benzene bonds are flagged aromatic with Kekulé orders', () => {
    const { bonds } = extractAtomsBonds(to3D(parseSmiles('c1ccccc1')!).mol);
    const ring = bonds.filter((b) => b.aromatic);
    expect(ring).toHaveLength(6);
    expect(ring.filter((b) => b.order === 2)).toHaveLength(3);
  });
});

describe('counts, charge, smiles', () => {
  test('ethanol counts include implicit hydrogens', () => {
    expect(countsOf(parseSmiles('CCO')!)).toEqual({ C: 2, H: 6, O: 1 });
  });
  test('sulfate charge and canonical smiles', () => {
    const mol = parseSmiles('[O-]S(=O)(=O)[O-]')!;
    expect(totalCharge(mol)).toBe(-2);
    expect(canonicalSmiles(to3D(mol).mol)).toBe(canonicalSmiles(mol));
    expect(heavyAtomCount(to3D(mol).mol)).toBe(5);
  });
  test('molfile3D keeps 3D coordinates', () => {
    const mol3d = to3D(parseSmiles('C')!).mol;
    const back = parseMolfile(molfile3D(mol3d))!;
    expect(back.getAllAtoms()).toBe(5);
    expect(Math.abs(back.getAtomZ(1)) + Math.abs(back.getAtomZ(2))).toBeGreaterThan(0.1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/chem/structure.test.ts`
Expected: FAIL, cannot resolve `./structure`.

- [ ] **Step 3: Write the implementation**

`src/chem/structure.ts`:

```ts
// OpenChemLib wrappers. Everything here is synchronous and CPU bound. 3D generation costs
// 1 ms (water) to about 1 s (sugars with stereocentres).

import * as OCL from 'openchemlib';
import { bySymbol } from './elements';
import type { Counts } from './formula';
import type { Atom, Bond, Geometry } from './types';

let registered = false;
/** The conformer generator needs OCL's static tables; register them once. */
export function ensureResources(): void {
  if (!registered) { OCL.Resources.registerFromNodejs(); registered = true; }
}

export function parseSmiles(smiles: string): OCL.Molecule | null {
  try {
    const mol = OCL.Molecule.fromSmiles(smiles.trim());
    return mol.getAllAtoms() > 0 ? mol : null;
  } catch { return null; }
}

export function parseMolfile(molfile: string): OCL.Molecule | null {
  try {
    const mol = OCL.Molecule.fromMolfile(molfile.split(/\$\$\$\$/)[0]);
    return mol.getAllAtoms() > 0 ? mol : null;
  } catch { return null; }
}

export function heavyAtomCount(mol: OCL.Molecule): number {
  let n = 0;
  for (let i = 0; i < mol.getAllAtoms(); i++) if (mol.getAtomicNo(i) !== 1) n++;
  return n;
}

/** Copy without explicit hydrogens. A hydrogen-only molecule (H2) keeps them. */
export function heavyCopy(mol: OCL.Molecule): OCL.Molecule {
  const c = mol.getCompactCopy();
  if (heavyAtomCount(c) > 0) c.removeExplicitHydrogens();
  return c;
}

export interface SvgOptions { width?: number; height?: number; numbered?: boolean; hydrogens?: boolean | 'auto' }

/**
 * Skeletal 2D drawing. Black is replaced by currentColor so the SVG follows the page theme.
 * `numbered` labels every heavy atom "C1", "O3" (1-based, heavy-first order).
 */
export function toSvg(source: OCL.Molecule, opts: SvgOptions = {}): string {
  const { width = 480, height = 360, numbered = false, hydrogens = 'auto' } = opts;
  const mol = heavyCopy(source);
  if (numbered) {
    for (let i = 0; i < mol.getAllAtoms(); i++) mol.setAtomCustomLabel(i, `${mol.getAtomLabel(i)}${i + 1}`);
  } else if (hydrogens === true || (hydrogens === 'auto' && heavyAtomCount(mol) <= 3)) {
    mol.addImplicitHydrogens();
  }
  const svg = mol.toSVG(width, height, 'mol', {
    autoCrop: true, autoCropMargin: 12, suppressChiralText: true, suppressCIPParity: true, suppressESR: true, fontWeight: 'normal',
  });
  return svg
    .replace(/rgb\(0,0,0\)/g, 'currentColor')
    .replace(/[ \t]*<(?:circle|line) id="[^"]*" class="event"[^>]*\/>\r?\n?/g, '');
}

/** New molecule with heavy atoms first, hydrogens after; coordinates, charges and bond orders copied. */
export function reorderHeavyFirst(mol: OCL.Molecule): OCL.Molecule {
  const n = mol.getAllAtoms();
  const order = [...Array(n).keys()].sort((a, b) => Number(mol.getAtomicNo(a) === 1) - Number(mol.getAtomicNo(b) === 1) || a - b);
  const map = new Map(order.map((old, i) => [old, i]));
  const out = new OCL.Molecule(n, mol.getAllBonds());
  for (const old of order) {
    const a = out.addAtom(mol.getAtomicNo(old));
    out.setAtomX(a, mol.getAtomX(old)); out.setAtomY(a, mol.getAtomY(old)); out.setAtomZ(a, mol.getAtomZ(old));
    out.setAtomCharge(a, mol.getAtomCharge(old));
  }
  for (let b = 0; b < mol.getAllBonds(); b++) {
    const nb = out.addBond(map.get(mol.getBondAtom(0, b))!, map.get(mol.getBondAtom(1, b))!);
    out.setBondOrder(nb, mol.getBondOrder(b));
  }
  return out;
}

function tryConformer(mol: OCL.Molecule, seed: number): OCL.Molecule | null {
  try { return new OCL.ConformerGenerator(seed).getOneConformerAsMolecule(mol) ?? null; } catch { return null; }
}

// Unit vectors for ideal geometries by number of neighbours (VSEPR without lone pairs).
const STAR: Record<number, [number, number, number][]> = {
  1: [[1, 0, 0]],
  2: [[1, 0, 0], [-1, 0, 0]],
  3: [[1, 0, 0], [-0.5, 0.866, 0], [-0.5, -0.866, 0]],
  4: [[0.577, 0.577, 0.577], [-0.577, -0.577, 0.577], [-0.577, 0.577, -0.577], [0.577, -0.577, -0.577]],
  5: [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-0.5, 0.866, 0], [-0.5, -0.866, 0]],
  6: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],
};

/** Ideal geometry for a "star": one centre bonded to every other atom (MnO4-, SF6, CH4 ...). */
function starGeometry(mol: OCL.Molecule): OCL.Molecule | null {
  const n = mol.getAllAtoms();
  if (n < 2 || n > 7) return null;
  mol.ensureHelperArrays(OCL.Molecule.cHelperNeighbours);
  let centre = 0;
  for (let i = 1; i < n; i++) if (mol.getConnAtoms(i) > mol.getConnAtoms(centre)) centre = i;
  if (mol.getConnAtoms(centre) !== n - 1) return null;
  for (let i = 0; i < n; i++) if (i !== centre && mol.getConnAtoms(i) !== 1) return null;
  const out = mol.getCompactCopy();
  const rc = bySymbol(mol.getAtomLabel(centre))?.radius ?? 1.2;
  out.setAtomX(centre, 0); out.setAtomY(centre, 0); out.setAtomZ(centre, 0);
  const dirs = STAR[n - 1];
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (i === centre) continue;
    const len = rc + (bySymbol(mol.getAtomLabel(i))?.radius ?? 0.7);
    const [dx, dy, dz] = dirs[k++];
    out.setAtomX(i, dx * len); out.setAtomY(i, dy * len); out.setAtomZ(i, dz * len);
  }
  return out;
}

const RANK: Record<Geometry, number> = { conformer: 0, star: 1, flat: 2 };

function layoutFragments(parts: { mol: OCL.Molecule; geometry: Geometry }[]): { mol: OCL.Molecule; geometry: Geometry } {
  const total = parts.reduce((s, p) => s + p.mol.getAllAtoms(), 0);
  const out = new OCL.Molecule(total, total);
  let cursor = 0;
  let geometry: Geometry = 'conformer';
  for (const { mol, geometry: g } of parts) {
    if (RANK[g] > RANK[geometry]) geometry = g;
    const xs = [...Array(mol.getAllAtoms()).keys()].map((i) => mol.getAtomX(i));
    const offset = cursor - Math.min(...xs);
    const map: number[] = [];
    for (let i = 0; i < mol.getAllAtoms(); i++) {
      const a = out.addAtom(mol.getAtomicNo(i));
      out.setAtomX(a, mol.getAtomX(i) + offset); out.setAtomY(a, mol.getAtomY(i)); out.setAtomZ(a, mol.getAtomZ(i));
      out.setAtomCharge(a, mol.getAtomCharge(i));
      map.push(a);
    }
    for (let b = 0; b < mol.getAllBonds(); b++) {
      const nb = out.addBond(map[mol.getBondAtom(0, b)], map[mol.getBondAtom(1, b)]);
      out.setBondOrder(nb, mol.getBondOrder(b));
    }
    cursor = Math.max(...xs) + offset + 2.5;
  }
  return { mol: reorderHeavyFirst(out), geometry };
}

/**
 * 3D coordinates with explicit hydrogens, heavy atoms first. Disconnected fragments (salts)
 * are generated separately and placed side by side along x, 2.5 Å apart. When the conformer
 * generator gives up (metal centres) an ideal star geometry is used; failing that, 2D
 * coordinates with z = 0.
 */
export function to3D(source: OCL.Molecule, seed = 42): { mol: OCL.Molecule; geometry: Geometry } {
  ensureResources();
  const mol = source.getCompactCopy();
  mol.addImplicitHydrogens();
  const frags = mol.getFragments();
  if (frags.length > 1) return layoutFragments(frags.map((f) => to3D(f, seed)));
  const conf = tryConformer(mol, seed);
  if (conf) return { mol: reorderHeavyFirst(conf), geometry: 'conformer' };
  const star = starGeometry(mol);
  if (star) return { mol: reorderHeavyFirst(star), geometry: 'star' };
  const flat = mol.getCompactCopy();
  flat.inventCoordinates();
  for (let i = 0; i < flat.getAllAtoms(); i++) flat.setAtomZ(i, 0);
  return { mol: reorderHeavyFirst(flat), geometry: 'flat' };
}

const round = (v: number) => Math.round(v * 10000) / 10000;

/** Atoms and bonds with 1-based indices in the molecule's own order (call on a heavy-first molecule). */
export function extractAtomsBonds(mol: OCL.Molecule): { atoms: Atom[]; bonds: Bond[] } {
  mol.ensureHelperArrays(OCL.Molecule.cHelperRings);
  const atoms: Atom[] = [];
  for (let i = 0; i < mol.getAllAtoms(); i++) {
    atoms.push({ index: i + 1, element: mol.getAtomLabel(i), x: round(mol.getAtomX(i)), y: round(mol.getAtomY(i)), z: round(mol.getAtomZ(i)), charge: mol.getAtomCharge(i) });
  }
  const bonds: Bond[] = [];
  for (let b = 0; b < mol.getAllBonds(); b++) {
    bonds.push({ a: mol.getBondAtom(0, b) + 1, b: mol.getBondAtom(1, b) + 1, order: Math.min(3, Math.max(1, mol.getBondOrder(b))) as 1 | 2 | 3, aromatic: mol.isAromaticBond(b) });
  }
  return { atoms, bonds };
}

/** Element counts including implicit hydrogens. */
export function countsOf(mol: OCL.Molecule): Counts {
  const c = mol.getCompactCopy();
  c.addImplicitHydrogens();
  const counts: Counts = {};
  for (let i = 0; i < c.getAllAtoms(); i++) {
    const sym = c.getAtomLabel(i);
    counts[sym] = (counts[sym] ?? 0) + 1;
  }
  return counts;
}

export function totalCharge(mol: OCL.Molecule): number {
  let q = 0;
  for (let i = 0; i < mol.getAllAtoms(); i++) q += mol.getAtomCharge(i);
  return q;
}

export function canonicalSmiles(mol: OCL.Molecule): string {
  return heavyCopy(mol).toIsomericSmiles();
}

export function molfile2D(mol: OCL.Molecule): string {
  const c = heavyCopy(mol);
  c.inventCoordinates();
  return c.toMolfile();
}

export function molfile3D(mol3d: OCL.Molecule): string {
  return mol3d.toMolfile();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test src/chem/structure.test.ts`
Expected: all pass. If the permanganate test reports `conformer` instead of `star`, OpenChemLib has learned metal centres; relax the assertion to `expect(['conformer', 'star']).toContain(geometry)` and keep the distance check.

- [ ] **Step 5: Commit**

```bash
git add src/chem/structure.ts src/chem/structure.test.ts
git commit -m "feat(chem-tool): OpenChemLib wrappers for 2D SVG and 3D geometry" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QiWkMqG7iGFc1gM4UJChdf" -- src/chem/structure.ts src/chem/structure.test.ts
```

---

### Task 4: Species builder

**Files:**
- Create: `src/chem/species.ts`
- Test: `src/chem/species.test.ts`

**Interfaces:**
- Consumes: Task 2 and Task 3 exports, `Species`, `Source` types.
- Produces: `newId(): string` (6 lowercase alphanumerics); `class SpeciesError extends Error`; `interface SpeciesSeed { name; smiles?; molfile?; molfile3d?; source; displayFormula?; iupacName?; cid?; cas?; description?; category?; id? }`; `buildSpecies(seed: SpeciesSeed): Species`; `speciesFromMolecule(mol: OCL.Molecule, seed: SpeciesSeed): Species`.

- [ ] **Step 1: Write the failing test**

`src/chem/species.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/chem/species.test.ts`
Expected: FAIL, cannot resolve `./species`.

- [ ] **Step 3: Write the implementation**

`src/chem/species.ts`:

```ts
// Builds immutable Species records: the one place that turns a molecule into everything the
// workspace, the window and the MCP tools need.

import type * as OCL from 'openchemlib';
import { composition, hillFormula, molarMass } from './formula';
import {
  canonicalSmiles, countsOf, extractAtomsBonds, molfile2D, molfile3D, parseMolfile, parseSmiles,
  reorderHeavyFirst, to3D, toSvg, totalCharge,
} from './structure';
import type { Geometry, Source, Species } from './types';

export class SpeciesError extends Error {}

export interface SpeciesSeed {
  name: string;
  smiles?: string;
  molfile?: string;
  /** Precomputed 3D molfile (library entries); skips conformer generation. */
  molfile3d?: string;
  source: Source;
  displayFormula?: string;
  iupacName?: string;
  cid?: number;
  cas?: string;
  description?: string;
  category?: string;
  id?: string;
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

export function buildSpecies(seed: SpeciesSeed): Species {
  const mol = seed.molfile ? parseMolfile(seed.molfile) : seed.smiles ? parseSmiles(seed.smiles) : null;
  if (!mol) throw new SpeciesError(`Cannot parse the structure of "${seed.name}"`);
  return speciesFromMolecule(mol, seed);
}

export function speciesFromMolecule(mol: OCL.Molecule, seed: SpeciesSeed): Species {
  let mol3d: OCL.Molecule;
  let geometry: Geometry;
  const pre = seed.molfile3d ? parseMolfile(seed.molfile3d) : null;
  if (pre) {
    mol3d = reorderHeavyFirst(pre);
    geometry = 'conformer';
  } else {
    ({ mol: mol3d, geometry } = to3D(mol));
  }
  const { atoms, bonds } = extractAtomsBonds(mol3d);
  const counts = countsOf(mol3d);
  const charge = totalCharge(mol3d);
  const formula = hillFormula(counts, charge);
  return {
    id: seed.id ?? newId(),
    name: seed.name,
    iupacName: seed.iupacName,
    formula,
    displayFormula: seed.displayFormula ?? formula,
    charge,
    source: seed.source,
    cid: seed.cid,
    cas: seed.cas,
    description: seed.description,
    category: seed.category,
    smiles: canonicalSmiles(mol3d),
    molfile2d: molfile2D(mol3d),
    molfile3d: molfile3D(mol3d),
    geometry,
    atoms,
    bonds,
    info: { molarMass: Math.round(molarMass(counts) * 1000) / 1000, composition: composition(counts) },
    svg2d: toSvg(mol3d),
    svg2dNumbered: toSvg(mol3d, { numbered: true }),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test src/chem/species.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/chem/species.ts src/chem/species.test.ts
git commit -m "feat(chem-tool): species builder" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QiWkMqG7iGFc1gM4UJChdf" -- src/chem/species.ts src/chem/species.test.ts
```

---

### Task 5: Seed library and indexes

**Files:**
- Create: `data/seed.ts`, `src/chem/library.ts`
- Test: `src/chem/library.test.ts`

**Interfaces:**
- Consumes: Task 2 (`parseFormula`, `hillFormula`), Task 3 (`parseSmiles`, `countsOf`, `totalCharge`).
- Produces: `SeedEntry { name; formula; smiles; aliases?; category; note?; cid? }`, `SEED: SeedEntry[]`; `LibraryEntry extends SeedEntry { hill: string; charge: number; keys: string[] }`; `LIBRARY: LibraryEntry[]`; `normalizeName(s): string`; `findByName(q): LibraryEntry | undefined`; `findByFormula(hill): LibraryEntry[]` (seed order); `search(q, limit = 20): LibraryEntry[]`; `suggestions(q, limit = 5): string[]`; `categories(): string[]`.

Every entry's SMILES must produce the same Hill formula (with charge) as its `formula` text; the test enforces it, so a typo in either fails loudly.

- [ ] **Step 1: Write the failing test**

`src/chem/library.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { SEED } from '../../data/seed';
import { hillFormula, parseFormula } from './formula';
import { LIBRARY, categories, findByFormula, findByName, normalizeName, search, suggestions } from './library';
import { countsOf, parseSmiles, totalCharge } from './structure';

describe('seed integrity', () => {
  test('every SMILES matches its formula text, names are unique', () => {
    const names = new Set<string>();
    for (const e of SEED) {
      const mol = parseSmiles(e.smiles);
      expect(mol, `${e.name}: SMILES does not parse`).not.toBeNull();
      const fromSmiles = hillFormula(countsOf(mol!), totalCharge(mol!));
      const p = parseFormula(e.formula);
      expect(fromSmiles, `${e.name}: formula ${e.formula} vs SMILES ${e.smiles}`).toBe(hillFormula(p.counts, p.charge));
      expect(names.has(normalizeName(e.name)), `duplicate name ${e.name}`).toBe(false);
      names.add(normalizeName(e.name));
    }
    expect(SEED.length).toBeGreaterThanOrEqual(60);
  });
});

describe('lookups', () => {
  test('by name, alias, formula text, any case', () => {
    expect(findByName('water')?.name).toBe('Water');
    expect(findByName('Dihydrogen Monoxide')?.name).toBe('Water');
    expect(findByName('h2o')?.name).toBe('Water');
    expect(findByName('NaCl')?.name).toBe('Sodium chloride');
    expect(findByName('table salt')?.name).toBe('Sodium chloride');
    expect(findByName('nothing here')).toBeUndefined();
  });
  test('by Hill formula returns isomers in seed order', () => {
    expect(findByFormula('C2H6O').map((e) => e.name)).toEqual(['Ethanol', 'Dimethyl ether']);
    expect(findByFormula('O4S 2-')[0].name).toBe('Sulfate');
    expect(findByFormula('Zz')).toEqual([]);
  });
  test('search ranks exact, prefix, then substring', () => {
    const hits = search('acet').map((e) => e.name);
    expect(hits[0]).toBe('Acetic acid');
    expect(hits).toContain('Acetone');
    expect(search('xyz')).toEqual([]);
    expect(search('a', 3)).toHaveLength(3);
  });
  test('suggestions tolerate typos', () => {
    expect(suggestions('watr')).toContain('Water');
    expect(suggestions('ethanl')).toContain('Ethanol');
  });
  test('categories and derived fields', () => {
    expect(categories()).toContain('Acids');
    expect(LIBRARY.find((e) => e.name === 'Sulfate')?.charge).toBe(-2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/chem/library.test.ts`
Expected: FAIL, cannot resolve `../../data/seed`.

- [ ] **Step 3: Write the seed**

`data/seed.ts`:

```ts
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
```

- [ ] **Step 4: Write the library**

`src/chem/library.ts`:

```ts
// Indexes over the seed: normalised names and aliases, formula text, Hill formula.

import { SEED, type SeedEntry } from '../../data/seed';
import { hillFormula, parseFormula } from './formula';

export interface LibraryEntry extends SeedEntry { hill: string; charge: number; keys: string[] }

export function normalizeName(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[\s_]+/g, ' ').trim();
}

const compact = (s: string) => normalizeName(s).replace(/[\s·.]/g, '');

export const LIBRARY: LibraryEntry[] = SEED.map((e) => {
  const p = parseFormula(e.formula);
  const hill = hillFormula(p.counts, p.charge);
  const keys = [normalizeName(e.name), ...(e.aliases ?? []).map(normalizeName), compact(e.formula), compact(hill)];
  return { ...e, hill, charge: p.charge, keys: [...new Set(keys)] };
});

const BY_KEY = new Map<string, LibraryEntry>();
const BY_HILL = new Map<string, LibraryEntry[]>();
for (const entry of LIBRARY) {
  for (const k of entry.keys) if (!BY_KEY.has(k)) BY_KEY.set(k, entry);
  BY_HILL.set(entry.hill, [...(BY_HILL.get(entry.hill) ?? []), entry]);
}

export function findByName(query: string): LibraryEntry | undefined {
  const n = normalizeName(query);
  return BY_KEY.get(n) ?? BY_KEY.get(compact(query));
}

export function findByFormula(hill: string): LibraryEntry[] {
  return BY_HILL.get(hill) ?? [];
}

function rank(entry: LibraryEntry, q: string): number {
  const name = entry.keys[0];
  if (entry.keys.includes(q)) return 0;
  if (name.startsWith(q)) return 1;
  if (entry.keys.some((k) => k.startsWith(q))) return 2;
  if (name.includes(q)) return 3;
  if (entry.keys.some((k) => k.includes(q))) return 4;
  return -1;
}

export function search(query: string, limit = 20): LibraryEntry[] {
  const q = normalizeName(query);
  if (!q) return [];
  return LIBRARY
    .map((entry, i) => ({ entry, i, r: rank(entry, q) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.entry);
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Closest entry names for a query that matched nothing. */
export function suggestions(query: string, limit = 5): string[] {
  const q = normalizeName(query);
  const scored = LIBRARY.map((e) => ({ name: e.name, d: Math.min(...e.keys.map((k) => levenshtein(q, k))) }));
  return scored.filter((s) => s.d <= Math.max(2, Math.floor(q.length / 3))).sort((a, b) => a.d - b.d).slice(0, limit).map((s) => s.name);
}

export function categories(): string[] {
  return [...new Set(LIBRARY.map((e) => e.category))];
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test src/chem/library.test.ts`
Expected: all pass. A failing integrity assertion names the entry; fix its SMILES or formula, never weaken the test. Known trap: `[O-2]` is the SMILES spelling of a doubly charged oxide ion; if OpenChemLib rejects it, use `[O--]`.

- [ ] **Step 6: Commit**

```bash
git add data/seed.ts src/chem/library.ts src/chem/library.test.ts
git commit -m "feat(chem-tool): seed library with name, alias and formula indexes" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QiWkMqG7iGFc1gM4UJChdf" -- data/seed.ts src/chem/library.ts src/chem/library.test.ts
```

---

### Task 6: PubChem client

**Files:**
- Create: `src/chem/pubchem.ts`
- Test: `src/chem/pubchem.test.ts`

**Interfaces:**
- Produces: `class PubChem` with constructor `({ fetch?, cacheDir?: string | null, minIntervalMs?, timeoutMs? })` and methods `byName(name): Promise<PubChemCompound[]>`, `byCid(cid): Promise<PubChemCompound | null>`, `byCids(cids): Promise<PubChemCompound[]>`, `byFormula(hillBody, max = 8): Promise<PubChemCompound[]>`, `sdf(cid, '2d' | '3d'): Promise<string | null>`, `synonyms(cid): Promise<string[]>`, `description(cid): Promise<string | null>`; `PubChemCompound { cid; formula; weight; smiles; connectivitySmiles; iupac; title }`; `class PubChemUnavailable extends Error`; `findCas(synonyms): string | undefined`.

PubChem renamed its SMILES properties in 2025: `SMILES` (isomeric) and `ConnectivitySMILES`. The client asks for both. Requests are spaced 210 ms apart (PubChem's limit is 5 per second) and responses with status 200 or 404 are cached on disk keyed by the URL's SHA-1.

- [ ] **Step 1: Write the failing test**

`src/chem/pubchem.test.ts`:

```ts
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PubChem, PubChemUnavailable, findCas } from './pubchem';

const props = (cid: number, formula: string, smiles: string, title: string) => JSON.stringify({
  PropertyTable: { Properties: [{ CID: cid, MolecularFormula: formula, MolecularWeight: '46.07', SMILES: smiles, ConnectivitySMILES: smiles, IUPACName: 'ethanol', Title: title }] },
});

function fakeFetch(routes: Record<string, { status: number; body: string }>, calls: string[]) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    const { status, body } = hit ? hit[1] : { status: 404, body: '{"Fault":{}}' };
    return new Response(body, { status });
  }) as typeof fetch;
}

describe('PubChem', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'pubchem-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('byName parses properties and caches on disk', async () => {
    const calls: string[] = [];
    const pc = new PubChem({ fetch: fakeFetch({ '/compound/name/ethanol/': { status: 200, body: props(702, 'C2H6O', 'CCO', 'Ethanol') } }, calls), cacheDir: dir, minIntervalMs: 0 });
    const first = await pc.byName('ethanol');
    expect(first[0]).toMatchObject({ cid: 702, formula: 'C2H6O', smiles: 'CCO', title: 'Ethanol', iupac: 'ethanol' });
    expect(first[0].weight).toBeCloseTo(46.07, 2);
    await pc.byName('ethanol');
    expect(calls).toHaveLength(1);
    expect((await readdir(dir)).length).toBe(1);
  });
  test('404 is an empty answer, 5xx throws PubChemUnavailable', async () => {
    const calls: string[] = [];
    const pc = new PubChem({ fetch: fakeFetch({ '/compound/name/broken/': { status: 503, body: 'busy' } }, calls), cacheDir: null, minIntervalMs: 0 });
    expect(await pc.byName('nothing')).toEqual([]);
    await expect(pc.byName('broken')).rejects.toBeInstanceOf(PubChemUnavailable);
  });
  test('byFormula chains cids to properties', async () => {
    const calls: string[] = [];
    const pc = new PubChem({ fetch: fakeFetch({
      '/fastformula/C2H6O/cids/': { status: 200, body: JSON.stringify({ IdentifierList: { CID: [702, 8254] } }) },
      '/compound/cid/702,8254/property/': { status: 200, body: props(702, 'C2H6O', 'CCO', 'Ethanol') },
    }, calls), cacheDir: null, minIntervalMs: 0 });
    const hits = await pc.byFormula('C2H6O');
    expect(hits.map((h) => h.cid)).toEqual([702]);
  });
  test('sdf returns text or null', async () => {
    const pc = new PubChem({ fetch: fakeFetch({ '/compound/cid/702/SDF?record_type=3d': { status: 200, body: 'mol\n  3D\n' } }, []), cacheDir: null, minIntervalMs: 0 });
    expect(await pc.sdf(702, '3d')).toContain('3D');
    expect(await pc.sdf(1, '3d')).toBeNull();
  });
  test('network failure throws PubChemUnavailable', async () => {
    const pc = new PubChem({ fetch: (async () => { throw new Error('offline'); }) as typeof fetch, cacheDir: null, minIntervalMs: 0 });
    await expect(pc.byName('water')).rejects.toThrow(/offline/);
  });
  test('findCas picks the CAS-shaped synonym', () => {
    expect(findCas(['ethanol', '64-17-5', 'alcohol'])).toBe('64-17-5');
    expect(findCas(['ethanol'])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/chem/pubchem.test.ts`
Expected: FAIL, cannot resolve `./pubchem`.

- [ ] **Step 3: Write the implementation**

`src/chem/pubchem.ts`:

```ts
// PubChem PUG REST client. The only module in src/chem that talks to the network.
// At most 5 requests per second (210 ms spacing). 200 and 404 answers are cached on disk so a
// repeated lookup never hits the network twice; errors are not cached.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';

export interface PubChemCompound {
  cid: number;
  formula: string;
  weight: number;
  smiles: string;
  connectivitySmiles: string;
  iupac: string;
  title: string;
}

export class PubChemUnavailable extends Error {}

export interface PubChemOptions {
  fetch?: typeof fetch;
  /** Directory for the response cache; null disables caching. */
  cacheDir?: string | null;
  minIntervalMs?: number;
  timeoutMs?: number;
}

interface CachedResponse { status: number; body: string }

const PROPERTIES = 'MolecularFormula,MolecularWeight,SMILES,ConnectivitySMILES,IUPACName,Title';

export class PubChem {
  private readonly fetchImpl: typeof fetch;
  private readonly cacheDir: string | null;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private lastStart = 0;
  private readonly inflight = new Map<string, Promise<CachedResponse>>();

  constructor(options: PubChemOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.cacheDir = options.cacheDir ?? null;
    this.minIntervalMs = options.minIntervalMs ?? 210;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private cachePath(url: string): string | null {
    return this.cacheDir ? path.join(this.cacheDir, createHash('sha1').update(url).digest('hex') + '.json') : null;
  }

  private async readCache(url: string): Promise<CachedResponse | null> {
    const file = this.cachePath(url);
    if (!file) return null;
    try { return JSON.parse(await readFile(file, 'utf8')) as CachedResponse; } catch { return null; }
  }

  private async writeCache(url: string, value: CachedResponse): Promise<void> {
    const file = this.cachePath(url);
    if (!file) return;
    try { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); } catch { /* a cache failure never fails a lookup */ }
  }

  private throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastStart + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastStart = Date.now();
      return fn();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** Rate limited, cached GET. Resolves for 200 and 404; throws PubChemUnavailable otherwise. */
  private get(url: string, accept = 'application/json'): Promise<CachedResponse> {
    const existing = this.inflight.get(url);
    if (existing) return existing;
    const job = (async () => {
      const cached = await this.readCache(url);
      if (cached) return cached;
      const result = await this.throttled(async () => {
        let res: Response;
        try {
          res = await this.fetchImpl(url, { headers: { accept, 'user-agent': 'chem-tool/0.1 (local educational app)' }, signal: AbortSignal.timeout(this.timeoutMs) });
        } catch (err) {
          throw new PubChemUnavailable(`PubChem request failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        const body = await res.text();
        if (res.status !== 200 && res.status !== 404) throw new PubChemUnavailable(`PubChem answered ${res.status} for ${url}`);
        return { status: res.status, body };
      });
      await this.writeCache(url, result);
      return result;
    })();
    this.inflight.set(url, job);
    job.finally(() => this.inflight.delete(url)).catch(() => {});
    return job;
  }

  private static parseProperties(body: string): PubChemCompound[] {
    const json = JSON.parse(body) as { PropertyTable?: { Properties?: Array<Record<string, string | number>> } };
    return (json.PropertyTable?.Properties ?? []).map((p) => ({
      cid: Number(p.CID),
      formula: String(p.MolecularFormula ?? ''),
      weight: Number(p.MolecularWeight ?? 0),
      smiles: String(p.SMILES ?? p.ConnectivitySMILES ?? ''),
      connectivitySmiles: String(p.ConnectivitySMILES ?? p.SMILES ?? ''),
      iupac: String(p.IUPACName ?? ''),
      title: String(p.Title ?? ''),
    }));
  }

  async byName(name: string): Promise<PubChemCompound[]> {
    const res = await this.get(`${BASE}/compound/name/${encodeURIComponent(name.trim())}/property/${PROPERTIES}/JSON`);
    return res.status === 200 ? PubChem.parseProperties(res.body) : [];
  }

  async byCids(cids: number[]): Promise<PubChemCompound[]> {
    if (cids.length === 0) return [];
    const res = await this.get(`${BASE}/compound/cid/${cids.join(',')}/property/${PROPERTIES}/JSON`);
    return res.status === 200 ? PubChem.parseProperties(res.body) : [];
  }

  async byCid(cid: number): Promise<PubChemCompound | null> {
    return (await this.byCids([cid]))[0] ?? null;
  }

  /** Compounds with exactly this Hill formula (no charge suffix), PubChem's relevance order. */
  async byFormula(formula: string, max = 8): Promise<PubChemCompound[]> {
    const res = await this.get(`${BASE}/compound/fastformula/${encodeURIComponent(formula)}/cids/JSON?MaxRecords=${max}`);
    if (res.status !== 200) return [];
    const json = JSON.parse(res.body) as { IdentifierList?: { CID?: number[] } };
    return this.byCids((json.IdentifierList?.CID ?? []).slice(0, max));
  }

  /** SDF text, or null when PubChem has no record of that kind (3D is missing for salts and large molecules). */
  async sdf(cid: number, kind: '2d' | '3d'): Promise<string | null> {
    const res = await this.get(`${BASE}/compound/cid/${cid}/SDF?record_type=${kind}`, 'chemical/x-mdl-sdfile');
    return res.status === 200 ? res.body : null;
  }

  async synonyms(cid: number, max = 30): Promise<string[]> {
    const res = await this.get(`${BASE}/compound/cid/${cid}/synonyms/JSON`);
    if (res.status !== 200) return [];
    const json = JSON.parse(res.body) as { InformationList?: { Information?: Array<{ Synonym?: string[] }> } };
    return (json.InformationList?.Information?.[0]?.Synonym ?? []).slice(0, max);
  }

  async description(cid: number): Promise<string | null> {
    const res = await this.get(`${BASE}/compound/cid/${cid}/description/JSON`);
    if (res.status !== 200) return null;
    const json = JSON.parse(res.body) as { InformationList?: { Information?: Array<{ Description?: string }> } };
    return json.InformationList?.Information?.find((i) => i.Description)?.Description ?? null;
  }
}

export function findCas(synonyms: string[]): string | undefined {
  return synonyms.find((s) => /^\d{2,7}-\d{2}-\d$/.test(s));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test src/chem/pubchem.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/chem/pubchem.ts src/chem/pubchem.test.ts
git commit -m "feat(chem-tool): PubChem client with cache and rate limit" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QiWkMqG7iGFc1gM4UJChdf" -- src/chem/pubchem.ts src/chem/pubchem.test.ts
```

---

### Task 7: Resolve pipeline

**Files:**
- Create: `src/chem/resolve.ts`
- Test: `src/chem/resolve.test.ts`

**Interfaces:**
- Consumes: library, formula, structure, species, pubchem.
- Produces: `interface Alternative { name; formula; smiles }`; `interface ResolveResult { species: Species; alternatives: Alternative[]; note?: string }`; `class ResolveError extends Error { suggestions: string[]; reason?: string }`; `interface Resolver { resolve(query): Promise<ResolveResult> }`; `speciesFromEntry(entry: LibraryEntry): Species`; `createResolver({ pubchem?: PubChemLike | null }): Resolver` where `PubChemLike = Pick<PubChem, 'byName' | 'byFormula'>`.

Order (spec section 7): library by name; library by Hill formula when the text parses as a formula; SMILES when the text is not a lowercase word; PubChem by name; PubChem by formula body. Results are cached per normalised query in memory (library species are rebuilt on demand, so a cache of 200 entries is plenty).

- [ ] **Step 1: Write the failing test**

`src/chem/resolve.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import type { PubChemCompound } from './pubchem';
import { PubChemUnavailable } from './pubchem';
import { ResolveError, createResolver } from './resolve';

const aspirin: PubChemCompound = { cid: 2244, formula: 'C9H8O4', weight: 180.16, smiles: 'CC(=O)Oc1ccccc1C(=O)O', connectivitySmiles: 'CC(=O)Oc1ccccc1C(=O)O', iupac: '2-acetyloxybenzoic acid', title: 'Aspirin' };

function stub(byName: Record<string, PubChemCompound[]> = {}, byFormula: Record<string, PubChemCompound[]> = {}) {
  return {
    calls: [] as string[],
    async byName(n: string) { this.calls.push('name:' + n); return byName[n] ?? []; },
    async byFormula(f: string) { this.calls.push('formula:' + f); return byFormula[f] ?? []; },
  };
}

describe('resolve', () => {
  test('library by name and by formula, with isomers as alternatives', async () => {
    const pc = stub();
    const r = createResolver({ pubchem: pc });
    const water = await r.resolve('water');
    expect(water.species.name).toBe('Water');
    expect(water.species.source).toBe('library');
    expect(water.species.displayFormula).toBe('H2O');
    const eth = await r.resolve('C2H6O');
    expect(eth.species.name).toBe('Ethanol');
    expect(eth.alternatives.map((a) => a.name)).toEqual(['Dimethyl ether']);
    expect(pc.calls).toEqual([]);
  });
  test('SMILES input', async () => {
    const r = createResolver({ pubchem: stub() });
    const res = await r.resolve('CC(C)C');
    expect(res.species.source).toBe('smiles');
    expect(res.species.formula).toBe('C4H10');
    expect(res.species.name).toBe('C4H10');
  });
  test('PubChem by name, then by formula', async () => {
    const pc = stub({ 'aspirin': [aspirin] }, { 'C9H8O4': [aspirin] });
    const r = createResolver({ pubchem: pc });
    const byName = await r.resolve('aspirin');
    expect(byName.species.source).toBe('pubchem');
    expect(byName.species.cid).toBe(2244);
    expect(byName.species.iupacName).toBe('2-acetyloxybenzoic acid');
    const byFormula = await r.resolve('C9H8O4');
    expect(byFormula.species.name).toBe('Aspirin');
    expect(pc.calls).toEqual(['name:aspirin', 'name:C9H8O4', 'formula:C9H8O4']);
  });
  test('unknown query fails with suggestions', async () => {
    const r = createResolver({ pubchem: stub() });
    const err = await r.resolve('watre').catch((e) => e);
    expect(err).toBeInstanceOf(ResolveError);
    expect((err as ResolveError).suggestions).toContain('Water');
  });
  test('PubChem disabled or unreachable is reported', async () => {
    const off = createResolver({ pubchem: null });
    await expect(off.resolve('ibuprofen')).rejects.toThrow(/PubChem is disabled/);
    const down = createResolver({ pubchem: { async byName() { throw new PubChemUnavailable('timeout'); }, async byFormula() { return []; } } });
    const err = await down.resolve('ibuprofen').catch((e) => e);
    expect(err.message).toMatch(/unreachable/);
    expect(err.reason).toBe('timeout');
  });
  test('results are cached per normalised query', async () => {
    const pc = stub({ 'aspirin': [aspirin] });
    const r = createResolver({ pubchem: pc });
    await r.resolve('Aspirin');
    await r.resolve('aspirin ');
    expect(pc.calls).toEqual(['name:Aspirin']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/chem/resolve.test.ts`
Expected: FAIL, cannot resolve `./resolve`.

- [ ] **Step 3: Write the implementation**

`src/chem/resolve.ts`:

```ts
// Query pipeline: library by name, library by formula, SMILES, PubChem by name, PubChem by formula.

import { hillFormula, looksLikeFormula, parseFormula } from './formula';
import { findByFormula, findByName, normalizeName, suggestions, type LibraryEntry } from './library';
import type { PubChem, PubChemCompound } from './pubchem';
import { PubChemUnavailable } from './pubchem';
import { buildSpecies } from './species';
import { parseSmiles } from './structure';
import type { Species } from './types';

export interface Alternative { name: string; formula: string; smiles: string }
export interface ResolveResult { species: Species; alternatives: Alternative[]; note?: string }

export class ResolveError extends Error {
  constructor(message: string, public readonly suggestions: string[] = [], public readonly reason?: string) { super(message); }
}

export interface Resolver { resolve(query: string): Promise<ResolveResult> }
export type PubChemLike = Pick<PubChem, 'byName' | 'byFormula'>;

export function speciesFromEntry(entry: LibraryEntry): Species {
  return buildSpecies({ name: entry.name, smiles: entry.smiles, source: 'library', displayFormula: entry.formula, category: entry.category, description: entry.note, cid: entry.cid });
}

function fromCompound(c: PubChemCompound, fallbackName: string): Species {
  return buildSpecies({ name: c.title || fallbackName, smiles: c.smiles || c.connectivitySmiles, source: 'pubchem', iupacName: c.iupac || undefined, cid: c.cid, displayFormula: c.formula || undefined });
}

const altFromEntry = (e: LibraryEntry): Alternative => ({ name: e.name, formula: e.formula, smiles: e.smiles });
const altFromCompound = (c: PubChemCompound): Alternative => ({ name: c.title, formula: c.formula, smiles: c.smiles || c.connectivitySmiles });

export function createResolver(deps: { pubchem?: PubChemLike | null }): Resolver {
  const pubchem = deps.pubchem ?? null;
  const cache = new Map<string, ResolveResult>();

  async function resolveUncached(q: string): Promise<ResolveResult> {
    const entry = findByName(q);
    if (entry) {
      const isomers = findByFormula(entry.hill).filter((e) => e !== entry);
      return { species: speciesFromEntry(entry), alternatives: isomers.map(altFromEntry) };
    }
    let hillBody: string | undefined;
    if (looksLikeFormula(q)) {
      const p = parseFormula(q);
      const hill = hillFormula(p.counts, p.charge);
      hillBody = hillFormula(p.counts);
      const hits = findByFormula(hill);
      if (hits.length) return { species: speciesFromEntry(hits[0]), alternatives: hits.slice(1).map(altFromEntry) };
    }
    if (!/^[a-z ]+$/.test(q) && !/\s/.test(q)) {
      const mol = parseSmiles(q);
      if (mol) {
        const species = buildSpecies({ name: '', smiles: q, source: 'smiles' });
        return { species: { ...species, name: species.formula }, alternatives: [], note: 'Interpreted as SMILES' };
      }
    }
    if (!pubchem) throw new ResolveError(`No match for "${q}" in the library and PubChem is disabled`, suggestions(q));
    try {
      const byName = await pubchem.byName(q);
      if (byName[0]) return { species: fromCompound(byName[0], q), alternatives: byName.slice(1, 6).map(altFromCompound) };
      if (hillBody) {
        const byFormula = await pubchem.byFormula(hillBody);
        if (byFormula[0]) return { species: fromCompound(byFormula[0], q), alternatives: byFormula.slice(1, 6).map(altFromCompound) };
      }
    } catch (err) {
      if (err instanceof PubChemUnavailable) throw new ResolveError(`No library match for "${q}" and PubChem is unreachable`, suggestions(q), err.message);
      throw err;
    }
    throw new ResolveError(`No chemical found for "${q}"`, suggestions(q));
  }

  return {
    async resolve(query: string): Promise<ResolveResult> {
      const q = query.trim();
      if (!q) throw new ResolveError('Empty query');
      const key = normalizeName(q);
      const hit = cache.get(key);
      if (hit) return hit;
      const result = await resolveUncached(q);
      if (cache.size >= 200) cache.delete(cache.keys().next().value!);
      cache.set(key, result);
      return result;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test src/chem/resolve.test.ts`
Expected: 6 passed. Note the SMILES branch's `name: ''` then `name: species.formula`: `buildSpecies` needs a name only for error messages, and the species is renamed to its Hill formula.

- [ ] **Step 5: Commit**

```bash
git add src/chem/resolve.ts src/chem/resolve.test.ts
git commit -m "feat(chem-tool): resolve pipeline over library, SMILES and PubChem" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QiWkMqG7iGFc1gM4UJChdf" -- src/chem/resolve.ts src/chem/resolve.test.ts
```

---

### Task 8: PNG output and the software 3D snapshot

**Files:**
- Create: `src/chem/png.ts`, `src/chem/render3d.ts`
- Test: `src/chem/png.test.ts`, `src/chem/render3d.test.ts`

**Interfaces:**
- Produces: `svgToPng(svg: string, width = 800): Promise<Uint8Array>`; `renderSnapshotSvg(atoms: Atom[], bonds: Bond[], opts?: { width?, height?, style?: ViewState['style'], rotation?: [number, number, number], showHydrogens?, highlight?: number[], background? }): string`.

`svgToPng` replaces `currentColor` with near-black and paints a white background so the image reads on dark chat backgrounds. resvg-wasm's `initWasm` runs once; the `.wasm` file is resolved through `import.meta.resolve` (verified under Bun and Node).

- [ ] **Step 1: Write the failing tests**

`src/chem/png.test.ts`:

```ts
import { expect, test } from 'vitest';
import { svgToPng } from './png';
import { parseSmiles, toSvg } from './structure';

test('svgToPng produces a PNG of the requested width', async () => {
  const png = await svgToPng(toSvg(parseSmiles('CCO')!), 300);
  expect(Array.from(png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  // IHDR width is bytes 16..19 big-endian
  const width = (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19];
  expect(width).toBe(300);
});
```

`src/chem/render3d.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { renderSnapshotSvg } from './render3d';
import { buildSpecies } from './species';

const water = buildSpecies({ name: 'Water', smiles: 'O', source: 'library' });

describe('renderSnapshotSvg', () => {
  test('ball and stick draws one circle per atom and two half-lines per bond', () => {
    const svg = renderSnapshotSvg(water.atoms, water.bonds, { width: 200, height: 100 });
    expect(svg).toContain('<svg');
    expect(svg).toContain('width="200"');
    expect((svg.match(/<circle/g) ?? []).length).toBe(3);
    expect((svg.match(/<line/g) ?? []).length).toBe(4);
  });
  test('hydrogens can be hidden, wireframe has no spheres, spacefill has no bonds', () => {
    expect((renderSnapshotSvg(water.atoms, water.bonds, { showHydrogens: false }).match(/<circle/g) ?? []).length).toBe(1);
    expect(renderSnapshotSvg(water.atoms, water.bonds, { style: 'wireframe' })).not.toContain('<circle');
    expect(renderSnapshotSvg(water.atoms, water.bonds, { style: 'spacefill' })).not.toContain('<line');
  });
  test('highlight adds a ring and rotation changes the picture', () => {
    const a = renderSnapshotSvg(water.atoms, water.bonds, { highlight: [1] });
    expect(a).toContain('#ffd400');
    const b = renderSnapshotSvg(water.atoms, water.bonds, { rotation: [90, 0, 0] });
    expect(b).not.toBe(renderSnapshotSvg(water.atoms, water.bonds));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test src/chem/png.test.ts src/chem/render3d.test.ts`
Expected: FAIL, cannot resolve `./png` and `./render3d`.

- [ ] **Step 3: Write the implementations**

`src/chem/png.ts`:

```ts
// SVG to PNG through resvg-wasm. The wasm module is initialised once per process.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Resvg, initWasm } from '@resvg/resvg-wasm';

let ready: Promise<void> | null = null;

function init(): Promise<void> {
  ready ??= (async () => {
    const wasm = await readFile(fileURLToPath(import.meta.resolve('@resvg/resvg-wasm/index_bg.wasm')));
    await initWasm(wasm);
  })();
  return ready;
}

/** Renders an SVG string to PNG bytes at the given pixel width with a white background. */
export async function svgToPng(svg: string, width = 800): Promise<Uint8Array> {
  await init();
  const concrete = svg.replace(/currentColor/g, '#1a1a1a');
  return new Resvg(concrete, { fitTo: { mode: 'width', value: width }, background: '#ffffff' }).render().asPng();
}
```

`src/chem/render3d.ts`:

```ts
// Software 3D snapshot: orthographic projection, depth sorted, to SVG. Used when no window
// can answer a live snapshot request.

import { bySymbol } from './elements';
import type { Atom, Bond, ViewState } from './types';

export interface SnapshotOptions {
  width?: number; height?: number;
  style?: ViewState['style'];
  /** Degrees about x, y, z, applied in that order. */
  rotation?: [number, number, number];
  showHydrogens?: boolean;
  highlight?: number[];
  background?: string;
}

const rad = (d: number) => (d * Math.PI) / 180;

function rotate([x, y, z]: [number, number, number], [rx, ry, rz]: [number, number, number]): [number, number, number] {
  let [X, Y, Z] = [x, y, z];
  [Y, Z] = [Y * Math.cos(rad(rx)) - Z * Math.sin(rad(rx)), Y * Math.sin(rad(rx)) + Z * Math.cos(rad(rx))];
  [X, Z] = [X * Math.cos(rad(ry)) + Z * Math.sin(rad(ry)), -X * Math.sin(rad(ry)) + Z * Math.cos(rad(ry))];
  [X, Y] = [X * Math.cos(rad(rz)) - Y * Math.sin(rad(rz)), X * Math.sin(rad(rz)) + Y * Math.cos(rad(rz))];
  return [X, Y, Z];
}

const f = (n: number) => n.toFixed(2);

function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.min(255, Math.round(v + (255 - v) * amount));
  return `#${((ch(n >> 16) << 16) | (ch((n >> 8) & 255) << 8) | ch(n & 255)).toString(16).padStart(6, '0')}`;
}

export function renderSnapshotSvg(atoms: Atom[], bonds: Bond[], opts: SnapshotOptions = {}): string {
  const { width = 640, height = 480, style = 'ballstick', rotation = [20, 30, 0], showHydrogens = true, highlight = [], background = '#ffffff' } = opts;
  const visible = atoms.filter((a) => showHydrogens || a.element !== 'H');
  const pts = visible.map((a) => ({ a, p: rotate([a.x, a.y, a.z], rotation) }));
  const xs = pts.map((q) => q.p[0]);
  const ys = pts.map((q) => q.p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 2) + 3;
  const scale = Math.min(width, height) / span;
  const proj = (p: [number, number, number]) => [width / 2 + (p[0] - cx) * scale, height / 2 - (p[1] - cy) * scale] as const;
  const colorOf = (el: string) => bySymbol(el)?.color ?? '#ff00ff';
  const radiusOf = (el: string) => {
    const r = bySymbol(el)?.radius ?? 0.7;
    return style === 'spacefill' ? r * 1.7 : style === 'stick' ? 0.22 : r * 0.45;
  };
  const pos = new Map(pts.map((q) => [q.a.index, q.p]));
  const byIndex = new Map(atoms.map((a) => [a.index, a]));
  const items: { z: number; svg: string }[] = [];
  const bondWidth = style === 'wireframe' ? 2 : style === 'stick' ? 0.22 * scale : 0.12 * scale;

  if (style !== 'spacefill') {
    for (const b of bonds) {
      const pa = pos.get(b.a);
      const pb = pos.get(b.b);
      if (!pa || !pb) continue;
      const [x1, y1] = proj(pa);
      const [x2, y2] = proj(pb);
      const [mx, my] = [(x1 + x2) / 2, (y1 + y2) / 2];
      const ca = colorOf(byIndex.get(b.a)!.element);
      const cb = colorOf(byIndex.get(b.b)!.element);
      items.push({
        z: (pa[2] + pb[2]) / 2,
        svg: `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(mx)}" y2="${f(my)}" stroke="${ca}" stroke-width="${f(bondWidth)}" stroke-linecap="round"/>` +
          `<line x1="${f(mx)}" y1="${f(my)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${cb}" stroke-width="${f(bondWidth)}" stroke-linecap="round"/>`,
      });
    }
  }
  const used = new Set<string>();
  if (style !== 'wireframe') {
    for (const { a, p } of pts) {
      const [x, y] = proj(p);
      const r = radiusOf(a.element) * scale;
      used.add(a.element);
      const ring = highlight.includes(a.index) ? `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r + 4)}" fill="none" stroke="#ffd400" stroke-width="3"/>` : '';
      items.push({ z: p[2] + 0.01, svg: `${ring}<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="url(#g-${a.element})" stroke="#333" stroke-width="0.8"/>` });
    }
  }
  items.sort((p, q) => p.z - q.z);
  const defs = [...used].map((el) => {
    const c = colorOf(el);
    return `<radialGradient id="g-${el}" cx="35%" cy="35%" r="65%"><stop offset="0%" stop-color="${lighten(c, 0.6)}"/><stop offset="100%" stop-color="${c}"/></radialGradient>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${defs}</defs><rect width="100%" height="100%" fill="${background}"/>${items.map((i) => i.svg).join('')}</svg>`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test src/chem/png.test.ts src/chem/render3d.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/chem/png.ts src/chem/png.test.ts src/chem/render3d.ts src/chem/render3d.test.ts
git commit -m "feat(chem-tool): PNG output and software 3D snapshot" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QiWkMqG7iGFc1gM4UJChdf" -- src/chem/png.ts src/chem/png.test.ts src/chem/render3d.ts src/chem/render3d.test.ts
```

---

### Task 9: Command schemas, workspace store, persistence

**Files:**
- Create: `server/schemas.ts`, `server/workspace.ts`, `server/persist.ts`
- Test: `server/workspace.test.ts`, `server/persist.test.ts`

**Interfaces:**
- Consumes: `Resolver`, `ResolveError`, `Alternative` (Task 7); `buildSpecies`, `speciesFromMolecule`, `newId` (Task 4); `parseSmiles`, `parseMolfile` (Task 3); types.
- Produces:
  - `schemas.ts`: `ViewPatchSchema`, `CommandSchema` (zod discriminated union on `type`), `type Command`, `type ViewPatch`. Phase 2 adds `edit`, `undo`, `redo`.
  - `workspace.ts`: `type Actor = \`window:${string}\` | 'mcp' | 'api' | 'system'`; `class CommandError extends Error { status: 400 | 404 | 409 | 422; details: Record<string, unknown> }`; `interface CommandResult { message; sceneId; speciesId?; alternatives? }`; `newScene(title, species): Scene`; `createInitialWorkspace(): Workspace`; `pushHistory(scene): void`; `mergeView(view, patch): ViewState`; `describe(species): string`; `class WorkspaceStore` with `constructor(ws, resolver, onChange?)`, `get()`, `subscribe(fn): () => void`, `activeScene()`, `scene(id?)`, `focused(sceneId?)`, `findSpecies(id?)`, `dispatch(command, actor): Promise<CommandResult>`.
  - `persist.ts`: `loadWorkspace(file): Promise<Workspace | null>`; `createSaver(file, delayMs = 250): { save(ws): void; flush(): Promise<void> }`.

Rules: `dispatch` is the only mutation path. Every applied command bumps `version`, calls `onChange`, then every listener with the actor. Structural commands (`load`, `set_structure`) push a history snapshot; view and scene-management commands do not. `set_structure` carries `baseVersion` and is rejected with 409 when stale.

- [ ] **Step 1: Write the failing tests**

`server/workspace.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { createResolver } from '../src/chem/resolve';
import { CommandError, WorkspaceStore, createInitialWorkspace, mergeView } from './workspace';
import { DEFAULT_VIEW } from '../src/chem/types';

function makeStore() {
  const events: string[] = [];
  const store = new WorkspaceStore(createInitialWorkspace(), createResolver({ pubchem: null }), (ws) => events.push(`saved:${ws.version}`));
  return { store, events };
}

describe('WorkspaceStore', () => {
  test('starts with water in one scene', () => {
    const { store } = makeStore();
    expect(store.get().version).toBe(1);
    expect(store.get().scenes).toHaveLength(1);
    expect(store.focused().name).toBe('Water');
  });
  test('load replaces the focused species, bumps version, notifies listeners and saver', async () => {
    const { store, events } = makeStore();
    const seen: string[] = [];
    store.subscribe((ws, actor) => seen.push(`${actor}:${ws.version}`));
    const result = await store.dispatch({ type: 'load', query: 'ethanol' }, 'mcp');
    expect(result.speciesId).toBe(store.focused().id);
    expect(result.message).toMatch(/Ethanol/);
    expect(store.focused().name).toBe('Ethanol');
    expect(store.activeScene().title).toBe('Ethanol');
    expect(store.get().version).toBe(2);
    expect(seen).toEqual(['mcp:2']);
    expect(events).toEqual(['saved:2']);
    expect(store.activeScene().history.past).toHaveLength(1);
  });
  test('load with isomers reports alternatives; unknown query is a 404 with suggestions', async () => {
    const { store } = makeStore();
    const r = await store.dispatch({ type: 'load', query: 'C2H6O' }, 'api');
    expect(r.alternatives?.map((a) => a.name)).toEqual(['Dimethyl ether']);
    const err = await store.dispatch({ type: 'load', query: 'watre' }, 'api').catch((e) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect(err.status).toBe(404);
    expect(err.details.suggestions).toContain('Water');
    expect(store.get().version).toBe(2);
  });
  test('load into a new scene', async () => {
    const { store } = makeStore();
    const r = await store.dispatch({ type: 'load', query: 'methane', newScene: true }, 'api');
    expect(store.get().scenes).toHaveLength(2);
    expect(store.get().activeSceneId).toBe(r.sceneId);
    expect(store.focused().name).toBe('Methane');
  });
  test('set_structure from SMILES, version conflicts, invalid input', async () => {
    const { store } = makeStore();
    await store.dispatch({ type: 'set_structure', smiles: 'CCO', baseVersion: 1 }, 'window:a');
    expect(store.focused().formula).toBe('C2H6O');
    expect(store.focused().source).toBe('edit');
    expect(store.focused().name).toBe('Water (edited)');
    const stale = await store.dispatch({ type: 'set_structure', smiles: 'C', baseVersion: 1 }, 'window:a').catch((e) => e);
    expect(stale.status).toBe(409);
    expect(stale.details.version).toBe(2);
    const bad = await store.dispatch({ type: 'set_structure', smiles: 'C(' }, 'window:a').catch((e) => e);
    expect(bad.status).toBe(422);
    expect(store.get().version).toBe(2);
  });
  test('set_view merges and is not history', async () => {
    const { store } = makeStore();
    await store.dispatch({ type: 'set_view', view: { style: 'spacefill', highlight: [1] } }, 'mcp');
    expect(store.activeScene().view).toMatchObject({ style: 'spacefill', highlight: [1], labels: 'none' });
    expect(store.activeScene().history.past).toHaveLength(0);
  });
  test('scene management', async () => {
    const { store } = makeStore();
    const first = store.activeScene().id;
    const r = await store.dispatch({ type: 'new_scene', title: 'Copy' }, 'api');
    expect(store.get().scenes.map((s) => s.title)).toEqual(['Water', 'Copy']);
    await store.dispatch({ type: 'rename_scene', sceneId: r.sceneId, title: 'Second' }, 'api');
    await store.dispatch({ type: 'switch_scene', sceneId: first }, 'api');
    expect(store.get().activeSceneId).toBe(first);
    await store.dispatch({ type: 'close_scene', sceneId: r.sceneId }, 'api');
    expect(store.get().scenes).toHaveLength(1);
    const last = await store.dispatch({ type: 'close_scene', sceneId: first }, 'api').catch((e) => e);
    expect(last.status).toBe(400);
  });
  test('focus by species id across scenes', async () => {
    const { store } = makeStore();
    const waterId = store.focused().id;
    await store.dispatch({ type: 'load', query: 'ammonia', newScene: true }, 'api');
    await store.dispatch({ type: 'focus', speciesId: waterId }, 'api');
    expect(store.focused().name).toBe('Water');
    const missing = await store.dispatch({ type: 'focus', speciesId: 'nope' }, 'api').catch((e) => e);
    expect(missing.status).toBe(404);
  });
});

test('mergeView keeps unspecified fields', () => {
  const v = mergeView(DEFAULT_VIEW, { spin: true, camera: { preset: 'top', rotation: [0, 90, 0] } });
  expect(v).toMatchObject({ spin: true, style: 'ballstick', camera: { preset: 'top', rotation: [0, 90, 0] } });
});
```

`server/persist.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createSaver, loadWorkspace } from './persist';
import { createInitialWorkspace } from './workspace';

test('save then load round trips; missing or corrupt files load as null', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'chemws-'));
  const file = path.join(dir, 'nested', 'workspace.json');
  try {
    expect(await loadWorkspace(file)).toBeNull();
    const saver = createSaver(file, 0);
    const ws = createInitialWorkspace();
    saver.save({ ...ws, version: 5 });
    saver.save({ ...ws, version: 6 });
    await saver.flush();
    const back = await loadWorkspace(file);
    expect(back?.version).toBe(6);
    expect(back?.scenes[0].species[0].name).toBe('Water');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test server/workspace.test.ts server/persist.test.ts`
Expected: FAIL, cannot resolve `./workspace` and `./persist`.

- [ ] **Step 3: Write the schemas**

`server/schemas.ts`:

```ts
// zod schemas shared by REST, WebSocket and MCP. Phase 2 adds edit, undo and redo.

import { z } from 'zod';

export const ViewPatchSchema = z.object({
  style: z.enum(['ballstick', 'stick', 'spacefill', 'wireframe']).optional(),
  labels: z.enum(['none', 'element', 'index']).optional(),
  highlight: z.array(z.number().int().min(1)).optional(),
  spin: z.boolean().optional(),
  showDipole: z.boolean().optional(),
  showHydrogens: z.boolean().optional(),
  camera: z.object({
    preset: z.enum(['fit', 'front', 'top', 'side']),
    rotation: z.tuple([z.number(), z.number(), z.number()]),
  }).optional(),
});
export type ViewPatch = z.infer<typeof ViewPatchSchema>;

export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('load'), query: z.string().min(1), sceneId: z.string().optional(), newScene: z.boolean().optional() }),
  z.object({ type: z.literal('set_structure'), smiles: z.string().optional(), molfile: z.string().optional(), name: z.string().optional(), baseVersion: z.number().int().optional() }),
  z.object({ type: z.literal('set_view'), view: ViewPatchSchema, sceneId: z.string().optional() }),
  z.object({ type: z.literal('focus'), speciesId: z.string() }),
  z.object({ type: z.literal('new_scene'), title: z.string().optional(), query: z.string().optional() }),
  z.object({ type: z.literal('close_scene'), sceneId: z.string() }),
  z.object({ type: z.literal('switch_scene'), sceneId: z.string() }),
  z.object({ type: z.literal('rename_scene'), sceneId: z.string(), title: z.string().min(1) }),
]);
export type Command = z.infer<typeof CommandSchema>;
```

- [ ] **Step 4: Write the store**

`server/workspace.ts`:

```ts
// The workspace store: the single mutation path for the live molecule state.

import { ResolveError, type Alternative, type ResolveResult, type Resolver } from '../src/chem/resolve';
import { buildSpecies, newId, speciesFromMolecule } from '../src/chem/species';
import { parseMolfile, parseSmiles } from '../src/chem/structure';
import { DEFAULT_VIEW, type Scene, type SceneSnapshot, type Species, type ViewState, type Workspace } from '../src/chem/types';
import type { Command, ViewPatch } from './schemas';

export type Actor = `window:${string}` | 'mcp' | 'api' | 'system';

export class CommandError extends Error {
  constructor(public readonly status: 400 | 404 | 409 | 422, message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface CommandResult { message: string; sceneId: string; speciesId?: string; alternatives?: Alternative[] }
export type Listener = (workspace: Workspace, actor: Actor) => void;

export const HISTORY_LIMIT = 50;

export function newScene(title: string, species: Species): Scene {
  return {
    id: newId(), title, kind: 'molecule', species: [species], focusId: species.id,
    view: { ...DEFAULT_VIEW, highlight: [], camera: { ...DEFAULT_VIEW.camera } },
    history: { past: [], future: [] },
  };
}

export function createInitialWorkspace(): Workspace {
  const water = buildSpecies({ name: 'Water', smiles: 'O', source: 'library', displayFormula: 'H2O', category: 'Gases and diatomics' });
  const scene = newScene('Water', water);
  return { version: 1, scenes: [scene], activeSceneId: scene.id };
}

export function snapshotOf(scene: Scene): SceneSnapshot {
  return { kind: scene.kind, species: [...scene.species], equation: scene.equation, focusId: scene.focusId };
}

export function pushHistory(scene: Scene): void {
  scene.history.past.push(snapshotOf(scene));
  if (scene.history.past.length > HISTORY_LIMIT) scene.history.past.shift();
  scene.history.future = [];
}

export function mergeView(view: ViewState, patch: ViewPatch): ViewState {
  return { ...view, ...patch, highlight: patch.highlight ?? view.highlight, camera: patch.camera ? { ...patch.camera } : view.camera };
}

export function describe(s: Species): string {
  return `${s.name} (${s.displayFormula})`;
}

export class WorkspaceStore {
  private readonly listeners = new Set<Listener>();

  constructor(private ws: Workspace, private readonly resolver: Resolver, private readonly onChange?: (ws: Workspace) => void) {}

  get(): Workspace { return this.ws; }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  activeScene(): Scene { return this.scene(this.ws.activeSceneId); }

  scene(id?: string): Scene {
    const target = id ?? this.ws.activeSceneId;
    const s = this.ws.scenes.find((x) => x.id === target);
    if (!s) throw new CommandError(404, `No scene ${target}`);
    return s;
  }

  focused(sceneId?: string): Species {
    const s = this.scene(sceneId);
    return s.species.find((x) => x.id === s.focusId) ?? s.species[0];
  }

  findSpecies(id?: string): { scene: Scene; species: Species } {
    if (!id) { const scene = this.activeScene(); return { scene, species: this.focused() }; }
    for (const scene of this.ws.scenes) {
      const species = scene.species.find((x) => x.id === id);
      if (species) return { scene, species };
    }
    throw new CommandError(404, `No species ${id}`);
  }

  async dispatch(command: Command, actor: Actor): Promise<CommandResult> {
    const result = await this.apply(command);
    this.ws = { ...this.ws, version: this.ws.version + 1 };
    this.onChange?.(this.ws);
    for (const fn of this.listeners) fn(this.ws, actor);
    return result;
  }

  protected checkVersion(base?: number): void {
    if (base !== undefined && base !== this.ws.version) {
      throw new CommandError(409, `Workspace changed (you had version ${base}, it is now ${this.ws.version})`, { version: this.ws.version });
    }
  }

  protected replaceFocused(scene: Scene, species: Species): void {
    pushHistory(scene);
    scene.species = scene.kind === 'molecule' ? [species] : scene.species.map((s) => (s.id === scene.focusId ? species : s));
    scene.focusId = species.id;
    scene.view = { ...scene.view, highlight: [] };
    if (scene.kind === 'molecule') scene.title = species.name;
  }

  protected async resolveOr404(query: string): Promise<ResolveResult> {
    try {
      return await this.resolver.resolve(query);
    } catch (err) {
      if (err instanceof ResolveError) throw new CommandError(404, err.message, { suggestions: err.suggestions, reason: err.reason });
      throw err;
    }
  }

  protected async apply(cmd: Command): Promise<CommandResult> {
    switch (cmd.type) {
      case 'load': {
        const r = await this.resolveOr404(cmd.query);
        if (cmd.newScene || this.ws.scenes.length === 0) {
          const scene = newScene(r.species.name, r.species);
          this.ws.scenes.push(scene);
          this.ws.activeSceneId = scene.id;
          return { message: `Loaded ${describe(r.species)} into a new scene`, sceneId: scene.id, speciesId: r.species.id, alternatives: r.alternatives };
        }
        const scene = this.scene(cmd.sceneId);
        this.replaceFocused(scene, r.species);
        return { message: `Loaded ${describe(r.species)} from ${r.species.source}${r.note ? '. ' + r.note : ''}`, sceneId: scene.id, speciesId: r.species.id, alternatives: r.alternatives };
      }
      case 'set_structure': {
        this.checkVersion(cmd.baseVersion);
        const scene = this.activeScene();
        const current = this.focused();
        const mol = cmd.molfile ? parseMolfile(cmd.molfile) : cmd.smiles ? parseSmiles(cmd.smiles) : null;
        if (!mol) throw new CommandError(422, 'set_structure needs a valid SMILES or molfile');
        const name = cmd.name ?? (current.name.endsWith('(edited)') ? current.name : `${current.name} (edited)`);
        const species = speciesFromMolecule(mol, { name, source: 'edit', category: current.category });
        this.replaceFocused(scene, species);
        return { message: `Structure replaced: ${describe(species)}`, sceneId: scene.id, speciesId: species.id };
      }
      case 'set_view': {
        const scene = this.scene(cmd.sceneId);
        scene.view = mergeView(scene.view, cmd.view);
        return { message: 'View updated', sceneId: scene.id };
      }
      case 'focus': {
        const { scene, species } = this.findSpecies(cmd.speciesId);
        scene.focusId = species.id;
        this.ws.activeSceneId = scene.id;
        return { message: `Focused ${describe(species)}`, sceneId: scene.id, speciesId: species.id };
      }
      case 'new_scene': {
        const species = cmd.query ? (await this.resolveOr404(cmd.query)).species : this.focused();
        const scene = newScene(cmd.title ?? species.name, species);
        this.ws.scenes.push(scene);
        this.ws.activeSceneId = scene.id;
        return { message: `New scene "${scene.title}"`, sceneId: scene.id, speciesId: species.id };
      }
      case 'close_scene': {
        if (this.ws.scenes.length === 1) throw new CommandError(400, 'Cannot close the last scene');
        const idx = this.ws.scenes.findIndex((s) => s.id === cmd.sceneId);
        if (idx < 0) throw new CommandError(404, `No scene ${cmd.sceneId}`);
        this.ws.scenes.splice(idx, 1);
        if (this.ws.activeSceneId === cmd.sceneId) this.ws.activeSceneId = this.ws.scenes[Math.max(0, idx - 1)].id;
        return { message: 'Scene closed', sceneId: this.ws.activeSceneId };
      }
      case 'switch_scene': {
        const scene = this.scene(cmd.sceneId);
        this.ws.activeSceneId = scene.id;
        return { message: `Switched to "${scene.title}"`, sceneId: scene.id };
      }
      case 'rename_scene': {
        const scene = this.scene(cmd.sceneId);
        scene.title = cmd.title;
        return { message: 'Scene renamed', sceneId: scene.id };
      }
    }
  }
}
```

- [ ] **Step 5: Write persistence**

`server/persist.ts`:

```ts
// workspace.json: load on start, debounced atomic save on change.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from '../src/chem/types';

export async function loadWorkspace(file: string): Promise<Workspace | null> {
  try {
    const ws = JSON.parse(await readFile(file, 'utf8')) as Workspace;
    if (typeof ws.version !== 'number' || !Array.isArray(ws.scenes) || ws.scenes.length === 0) return null;
    return ws;
  } catch {
    return null;
  }
}

export function createSaver(file: string, delayMs = 250): { save(ws: Workspace): void; flush(): Promise<void> } {
  let pending: Workspace | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const write = async () => {
    timer = null;
    const ws = pending;
    pending = null;
    if (!ws) return;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file + '.tmp', JSON.stringify(ws));
      await rename(file + '.tmp', file);
    } catch (err) {
      console.error('workspace save failed:', err);
    }
  };

  return {
    save(ws) {
      pending = ws;
      if (!timer) timer = setTimeout(() => { writing = write(); }, delayMs);
    },
    async flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      await writing;
      await write();
    },
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run test server/workspace.test.ts server/persist.test.ts`
Expected: 10 passed.

- [ ] **Step 7: Commit**

```bash
git add server/schemas.ts server/workspace.ts server/persist.ts server/workspace.test.ts server/persist.test.ts
git commit -m "feat(chem-tool): workspace store, command schemas, persistence" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QiWkMqG7iGFc1gM4UJChdf" -- server/schemas.ts server/workspace.ts server/persist.ts server/workspace.test.ts server/persist.test.ts
```

---

### Task 10: HTTP server: REST, WebSocket, static files, Bun entry

**Files:**
- Create: `server/config.ts`, `server/static.ts`, `server/api.ts`, `server/ws.ts`, `server/app.ts`, `server/index.ts`
- Test: `server/api.test.ts`

**Interfaces:**
- Consumes: Task 9 store and schemas; `search` (Task 5); `svgToPng` (Task 8); `renderSnapshotSvg` (Task 8); formula helpers.
- Produces:
  - `config.ts`: `config = { port, tunnelPort, host, dataDir, staticDir, pubchemLive }`.
  - `app.ts`: `interface AppDeps { store; resolver; staticDir?; upgradeWebSocket?; host?; port? }`; `createApp(deps): { app: Hono; ws: WsRegistry | null }`.
  - `api.ts`: `registerApi(app, deps)`; `connectInfo(deps): { mcpUrl; claudeCode; openapi; window }`.
  - `ws.ts`: `registerWs(app, deps, upgradeWebSocket): WsRegistry` where `WsRegistry = { clients: Map<WSContext, { windowId: string }>; broadcast(msg): void }`. Protocol as spec 9.3 plus `{ type: 'ack', id, result }` for a client's own command.
  - `static.ts`: `registerStatic(app, root)`.
- Only `server/index.ts` imports from `hono/bun` and uses `Bun.serve`. `createApp` receives `upgradeWebSocket` by injection so tests build the app without it.

- [ ] **Step 1: Write the failing test**

`server/api.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { createResolver } from '../src/chem/resolve';
import { createApp } from './app';
import { WorkspaceStore, createInitialWorkspace } from './workspace';

function make() {
  const resolver = createResolver({ pubchem: null });
  const store = new WorkspaceStore(createInitialWorkspace(), resolver);
  const { app } = createApp({ store, resolver, host: '127.0.0.1', port: 8140 });
  return { app, store };
}

describe('REST', () => {
  test('health, search, resolve, workspace', async () => {
    const { app } = make();
    expect((await (await app.request('/api/health')).json()).ok).toBe(true);
    const hits = await (await app.request('/api/search?q=eth')).json();
    expect(hits[0].name).toBe('Ethane');
    const r = await (await app.request('/api/resolve?q=water')).json();
    expect(r.species.formula).toBe('H2O');
    const ws = await (await app.request('/api/workspace')).json();
    expect(ws.version).toBe(1);
  });
  test('command applies and returns the workspace; errors carry status and details', async () => {
    const { app, store } = make();
    const res = await app.request('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'load', query: 'benzene' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.message).toMatch(/Benzene/);
    expect(body.workspace.version).toBe(2);
    expect(store.focused().name).toBe('Benzene');
    const missing = await app.request('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'load', query: 'benzeen' }) });
    expect(missing.status).toBe(404);
    expect((await missing.json()).suggestions).toContain('Benzene');
    const stale = await app.request('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'set_structure', smiles: 'C', baseVersion: 1 }) });
    expect(stale.status).toBe(409);
    const invalid = await app.request('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'nope' }) });
    expect(invalid.status).toBe(400);
  });
  test('species files and snapshot', async () => {
    const { app, store } = make();
    const id = store.focused().id;
    const svg = await app.request(`/api/species/${id}.svg?numbered=1`);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    expect(await svg.text()).toContain('O1');
    const png = await app.request(`/api/species/${id}.png?w=200`);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect((await png.arrayBuffer()).byteLength).toBeGreaterThan(100);
    expect(await (await app.request(`/api/species/${id}.sdf`)).text()).toContain('$$$$');
    expect((await app.request('/api/species/zzzzzz.svg')).status).toBe(404);
    const snap = await app.request('/api/snapshot.png');
    expect(snap.headers.get('content-type')).toBe('image/png');
  });
  test('formula info and connect snippet', async () => {
    const { app } = make();
    const f = await (await app.request('/api/formula?q=NaCl')).json();
    expect(f.molarMass).toBeCloseTo(58.44, 1);
    expect((await app.request('/api/formula?q=Xx')).status).toBe(400);
    const c = await (await app.request('/api/connect')).json();
    expect(c.claudeCode).toBe('claude mcp add --transport http chemtool http://127.0.0.1:8140/mcp');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test server/api.test.ts`
Expected: FAIL, cannot resolve `./app`.

- [ ] **Step 3: Write config and static serving**

`server/config.ts`:

```ts
import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8140),
  tunnelPort: Number(env.TUNNEL_PORT ?? 8141),
  host: env.HOST ?? '127.0.0.1',
  dataDir: path.resolve(env.DATA_DIR ?? '.data'),
  staticDir: path.resolve(env.STATIC_DIR ?? 'dist'),
  pubchemLive: env.PUBCHEM_LIVE === '1',
};
```

`server/static.ts`:

```ts
// Serves the built client. Hashed assets under /assets/ are immutable; everything else falls
// back to index.html so deep links work.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Hono } from 'hono';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain',
};

export function registerStatic(app: Hono, root: string): void {
  const base = path.resolve(root);
  app.get('/*', async (c) => {
    let p = decodeURIComponent(new URL(c.req.url).pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.resolve(base, '.' + p);
    if (!file.startsWith(base)) return c.text('Forbidden', 403);
    const ext = path.extname(file);
    try {
      const s = await stat(file);
      if (!s.isFile()) throw new Error('not a file');
      const body = await readFile(file);
      return new Response(new Uint8Array(body), {
        headers: {
          'content-type': MIME[ext] ?? 'application/octet-stream',
          'cache-control': p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        },
      });
    } catch {
      if (ext) return c.notFound();
      try {
        return c.html((await readFile(path.join(base, 'index.html'))).toString());
      } catch {
        return c.text('Client not built. Run: bun run build', 404);
      }
    }
  });
}
```

- [ ] **Step 4: Write the REST routes**

`server/api.ts`:

```ts
// REST routes under /api (spec 9.2). Errors: { error, ...details } with a matching status.

import { Hono } from 'hono';
import { z } from 'zod';
import { FormulaError, composition, hillFormula, molarMass, parseFormula } from '../src/chem/formula';
import { search } from '../src/chem/library';
import { svgToPng } from '../src/chem/png';
import { renderSnapshotSvg } from '../src/chem/render3d';
import { ResolveError } from '../src/chem/resolve';
import type { AppDeps } from './app';
import { CommandSchema } from './schemas';
import { CommandError } from './workspace';

export function connectInfo(deps: AppDeps): { mcpUrl: string; claudeCode: string; openapi: string; window: string } {
  const base = `http://${deps.host ?? '127.0.0.1'}:${deps.port ?? 8140}`;
  return { mcpUrl: `${base}/mcp`, claudeCode: `claude mcp add --transport http chemtool ${base}/mcp`, openapi: `${base}/openapi.json`, window: base };
}

const png = (bytes: Uint8Array) => new Response(bytes, { headers: { 'content-type': 'image/png' } });

export function registerApi(app: Hono, deps: AppDeps): void {
  const api = new Hono();

  api.onError((err, c) => {
    if (err instanceof CommandError) return c.json({ error: err.message, ...err.details }, err.status);
    if (err instanceof ResolveError) return c.json({ error: err.message, suggestions: err.suggestions, reason: err.reason }, 404);
    if (err instanceof FormulaError) return c.json({ error: err.message }, 400);
    if (err instanceof z.ZodError) return c.json({ error: 'Invalid request', issues: err.issues }, 400);
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  api.get('/health', (c) => c.json({ ok: true, version: deps.store.get().version, port: deps.port ?? null }));

  api.get('/search', (c) => {
    const hits = search(c.req.query('q') ?? '', Number(c.req.query('limit') ?? 20));
    return c.json(hits.map((e) => ({ name: e.name, formula: e.formula, category: e.category, smiles: e.smiles })));
  });

  api.get('/resolve', async (c) => {
    const q = c.req.query('q') ?? '';
    if (!q) throw new CommandError(400, 'Missing q');
    return c.json(await deps.resolver.resolve(q));
  });

  api.get('/workspace', (c) => c.json(deps.store.get()));

  api.post('/command', async (c) => {
    const cmd = CommandSchema.parse(await c.req.json());
    const result = await deps.store.dispatch(cmd, 'api');
    return c.json({ result, workspace: deps.store.get() });
  });

  api.get('/species/:file', async (c) => {
    const m = /^(.+)\.(svg|png|sdf|mol)$/.exec(c.req.param('file'));
    if (!m) return c.notFound();
    const { species } = deps.store.findSpecies(m[1]);
    const svg = c.req.query('numbered') === '1' ? species.svg2dNumbered : species.svg2d;
    switch (m[2]) {
      case 'svg': return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } });
      case 'png': return png(await svgToPng(svg, Number(c.req.query('w') ?? 800)));
      case 'mol': return new Response(species.molfile3d, { headers: { 'content-type': 'chemical/x-mdl-molfile' } });
      default: return new Response(`${species.molfile3d}\n> <NAME>\n${species.name}\n\n$$$$\n`, { headers: { 'content-type': 'chemical/x-mdl-sdfile' } });
    }
  });

  api.get('/snapshot.png', async (c) => {
    const scene = deps.store.scene(c.req.query('scene') || undefined);
    const species = deps.store.focused(scene.id);
    const width = Number(c.req.query('w') ?? 640);
    const [rx, ry, rz] = scene.view.camera.rotation;
    const svg = renderSnapshotSvg(species.atoms, species.bonds, {
      width, height: Number(c.req.query('h') ?? Math.round(width * 0.75)), style: scene.view.style,
      showHydrogens: scene.view.showHydrogens, highlight: scene.view.highlight, rotation: [20 + rx, 30 + ry, rz],
    });
    return png(await svgToPng(svg, width));
  });

  api.get('/formula', (c) => {
    const p = parseFormula(c.req.query('q') ?? '');
    return c.json({ hill: hillFormula(p.counts, p.charge), charge: p.charge, molarMass: molarMass(p.counts), composition: composition(p.counts) });
  });

  api.get('/connect', (c) => c.json(connectInfo(deps)));

  app.route('/api', api);
}
```

- [ ] **Step 5: Write the WebSocket layer and the app assembly**

`server/ws.ts`:

```ts
// WebSocket protocol (spec 9.3). Server -> client: state, ack, error, snapshot_request (phase 2).
// Client -> server: hello, command, snapshot_response (phase 2).

import type { Hono } from 'hono';
import type { UpgradeWebSocket, WSContext } from 'hono/ws';
import type { AppDeps } from './app';
import { CommandSchema } from './schemas';
import { CommandError } from './workspace';

export interface WindowClient { windowId: string }
export interface WsRegistry {
  clients: Map<WSContext, WindowClient>;
  broadcast(msg: unknown): void;
}

export function registerWs(app: Hono, deps: AppDeps, upgradeWebSocket: UpgradeWebSocket): WsRegistry {
  const clients = new Map<WSContext, WindowClient>();
  const send = (ws: WSContext, msg: unknown) => { try { ws.send(JSON.stringify(msg)); } catch { /* socket gone */ } };
  const registry: WsRegistry = {
    clients,
    broadcast(msg) { for (const ws of clients.keys()) send(ws, msg); },
  };

  deps.store.subscribe((workspace, actor) => registry.broadcast({ type: 'state', workspace, actor, version: workspace.version }));

  app.get('/ws', upgradeWebSocket(() => ({
    onOpen(_evt, ws) {
      clients.set(ws, { windowId: '' });
      const workspace = deps.store.get();
      send(ws, { type: 'state', workspace, actor: 'system', version: workspace.version });
      setTimeout(() => { if (clients.get(ws)?.windowId === '') ws.close(); }, 10_000);
    },
    async onMessage(evt, ws) {
      const client = clients.get(ws);
      if (!client) return;
      let msg: { type?: string; id?: string; windowId?: string; command?: unknown; pngBase64?: string };
      try { msg = JSON.parse(String(evt.data)); } catch { return send(ws, { type: 'error', message: 'Invalid JSON' }); }
      if (msg.type === 'hello') { client.windowId = String(msg.windowId ?? 'anon'); return; }
      if (msg.type === 'command') {
        try {
          const cmd = CommandSchema.parse(msg.command);
          const result = await deps.store.dispatch(cmd, `window:${client.windowId || 'anon'}`);
          send(ws, { type: 'ack', id: msg.id, result });
        } catch (err) {
          const status = err instanceof CommandError ? err.status : 400;
          const details = err instanceof CommandError ? err.details : {};
          send(ws, { type: 'error', id: msg.id, status, message: err instanceof Error ? err.message : String(err), ...details });
        }
        return;
      }
      deps.onWindowMessage?.(msg, client);
    },
    onClose(_evt, ws) { clients.delete(ws); },
  })));

  return registry;
}
```

`server/app.ts`:

```ts
// Assembles the Hono app. Bun-specific pieces (WebSocket upgrade) are injected by server/index.ts
// so tests can build the app under Node.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { UpgradeWebSocket } from 'hono/ws';
import type { Resolver } from '../src/chem/resolve';
import { registerApi } from './api';
import { registerStatic } from './static';
import { registerWs, type WindowClient, type WsRegistry } from './ws';
import type { WorkspaceStore } from './workspace';

export interface AppDeps {
  store: WorkspaceStore;
  resolver: Resolver;
  staticDir?: string;
  upgradeWebSocket?: UpgradeWebSocket;
  host?: string;
  port?: number;
  /** Messages from a window that are not hello/command (phase 2: snapshot_response). */
  onWindowMessage?: (msg: Record<string, unknown>, client: WindowClient) => void;
}

export function createApp(deps: AppDeps): { app: Hono; ws: WsRegistry | null } {
  const app = new Hono();
  app.use('*', cors());
  registerApi(app, deps);
  const ws = deps.upgradeWebSocket ? registerWs(app, deps, deps.upgradeWebSocket) : null;
  if (deps.staticDir) registerStatic(app, deps.staticDir);
  return { app, ws };
}
```

`server/index.ts`:

```ts
// Bun entry point. The only file that may use Bun APIs.

import path from 'node:path';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { PubChem } from '../src/chem/pubchem';
import { createResolver } from '../src/chem/resolve';
import { createApp } from './app';
import { config } from './config';
import { createSaver, loadWorkspace } from './persist';
import { WorkspaceStore, createInitialWorkspace } from './workspace';

const file = path.join(config.dataDir, 'workspace.json');
const saver = createSaver(file);
const resolver = createResolver({ pubchem: new PubChem({ cacheDir: path.join(config.dataDir, 'cache', 'pubchem') }) });
const store = new WorkspaceStore((await loadWorkspace(file)) ?? createInitialWorkspace(), resolver, saver.save);
const { app } = createApp({ store, resolver, staticDir: config.staticDir, upgradeWebSocket, host: config.host, port: config.port });

const server = Bun.serve({ port: config.port, hostname: config.host, fetch: app.fetch, websocket });
console.log(`ChemTool server: http://${config.host}:${server.port}  data: ${config.dataDir}  static: ${config.staticDir}`);

const shutdown = async () => {
  await saver.flush();
  server.stop(true);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun run test server/api.test.ts`
Expected: 4 passed.

- [ ] **Step 7: Smoke the real server**

Run in one terminal: `bun run dev:server`
Expected: `ChemTool server: http://127.0.0.1:8140 ...`

In another terminal:

```bash
curl -s http://127.0.0.1:8140/api/health
curl -s "http://127.0.0.1:8140/api/resolve?q=caffeine" | head -c 300
curl -s -X POST http://127.0.0.1:8140/api/command -H "content-type: application/json" -d "{\"type\":\"load\",\"query\":\"aspirin\"}" | head -c 200
```

Expected: `{"ok":true,...}`; a JSON species for caffeine (from the library); a result message mentioning Aspirin. A GET of `http://127.0.0.1:8140/` returns the "Client not built" text until Task 12. Stop the server with Ctrl+C and confirm `.data/workspace.json` exists.

- [ ] **Step 8: Commit**

```bash
git add server/config.ts server/static.ts server/api.ts server/ws.ts server/app.ts server/index.ts server/api.test.ts
git commit -m "feat(chem-tool): REST, WebSocket and static serving on Bun" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QiWkMqG7iGFc1gM4UJChdf" -- server/config.ts server/static.ts server/api.ts server/ws.ts server/app.ts server/index.ts server/api.test.ts
```

---

### Task 11: MCP server and `/mcp` mount

**Files:**
- Create: `server/mcp.ts`
- Modify: `server/app.ts` (call `mountMcp` after `registerApi`)
- Test: `server/mcp.test.ts`

**Interfaces:**
- Consumes: store, resolver, `connectInfo`, `svgToPng`, `renderSnapshotSvg`, formula helpers, `search`.
- Produces: `createMcpServer(deps: AppDeps): McpServer`; `mountMcp(app, deps)`; `speciesText(species, deps, scene?): string`; `render3dPng(deps, scene, species, width, style?): Promise<Uint8Array>` (software renderer now; phase 2 makes it prefer a live window).
- Phase 1 tools: `lookup_chemical`, `search_chemicals`, `get_current`, `set_molecule`, `render_2d`, `render_3d`, `get_structure`, `formula_info`, `new_scene`, `list_scenes`, `switch_scene`. Phase 2 adds `edit_molecule`, `set_view`, `undo`, `redo`.

The HTTP mount is stateless: every request gets a fresh `McpServer` and `StreamableHTTPTransport({ sessionIdGenerator: undefined })`, verified to work with the SDK client across repeated calls. State lives in the store, so this costs nothing. Tool failures return `isError: true` with the message and details rather than throwing, so the model can read suggestions and retry.

- [ ] **Step 1: Write the failing test**

`server/mcp.test.ts`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, test } from 'vitest';
import { createResolver } from '../src/chem/resolve';
import { createMcpServer } from './mcp';
import { WorkspaceStore, createInitialWorkspace } from './workspace';

type Content = { type: string; text?: string; mimeType?: string; data?: string }[];
let client: Client;
let store: WorkspaceStore;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { content: r.content as Content, isError: Boolean(r.isError), text: (r.content as Content).filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
};

beforeAll(async () => {
  const resolver = createResolver({ pubchem: null });
  store = new WorkspaceStore(createInitialWorkspace(), resolver);
  const server = createMcpServer({ store, resolver, host: '127.0.0.1', port: 8140 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
});

describe('MCP tools', () => {
  test('lists the phase 1 tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['lookup_chemical', 'search_chemicals', 'get_current', 'set_molecule', 'render_2d', 'render_3d', 'get_structure', 'formula_info', 'new_scene', 'list_scenes', 'switch_scene']) expect(names).toContain(n);
  });
  test('lookup_chemical loads into the window and returns a numbered atom list and an image', async () => {
    const r = await call('lookup_chemical', { query: 'ethanol' });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Ethanol/);
    expect(r.text).toMatch(/Atoms \(1-based, heavy first\): 1:C 2:C 3:O 4:H/);
    expect(r.content.some((c) => c.type === 'image' && c.mimeType === 'image/png')).toBe(true);
    expect(store.focused().name).toBe('Ethanol');
    expect(store.get().version).toBe(2);
  });
  test('lookup_chemical with load=false does not touch the workspace; unknown names fail with suggestions', async () => {
    const before = store.get().version;
    const r = await call('lookup_chemical', { query: 'acetone', load: false });
    expect(r.text).toMatch(/Acetone/);
    expect(store.get().version).toBe(before);
    const bad = await call('lookup_chemical', { query: 'acetoen' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Acetone/);
  });
  test('get_current, set_molecule, get_structure', async () => {
    const cur = await call('get_current');
    expect(cur.text).toMatch(/Ethanol/);
    expect(cur.text).toMatch(/"version"/);
    const set = await call('set_molecule', { smiles: 'CC(C)=O' });
    expect(set.text).toMatch(/C3H6O/);
    const s = await call('get_structure', { format: 'smiles' });
    expect(s.text.trim()).toMatch(/^(CC\(C\)=O|CC\(=O\)C)$/);   // OpenChemLib's canonical spelling of acetone
    const sdf = await call('get_structure', { format: 'sdf' });
    expect(sdf.text).toContain('V2000');
    const j = await call('get_structure', { format: 'json' });
    expect(j.text).toContain('"atoms"');
  });
  test('render_2d and render_3d return PNGs', async () => {
    for (const name of ['render_2d', 'render_3d']) {
      const r = await call(name, { width: 200 });
      expect(r.isError).toBe(false);
      const img = r.content.find((c) => c.type === 'image');
      expect(img?.mimeType).toBe('image/png');
      expect(Buffer.from(img!.data!, 'base64')[0]).toBe(0x89);
    }
  });
  test('search_chemicals and formula_info do not touch the workspace', async () => {
    const before = store.get().version;
    expect((await call('search_chemicals', { query: 'chlor' })).text).toMatch(/Chlorine/);
    const f = await call('formula_info', { formula: 'NaCl' });
    expect(f.text).toMatch(/58\.44/);
    expect(store.get().version).toBe(before);
  });
  test('scenes', async () => {
    const n = await call('new_scene', { title: 'Second', query: 'benzene' });
    expect(n.text).toMatch(/Second/);
    const list = await call('list_scenes');
    expect(list.text).toMatch(/Second/);
    const id = store.get().scenes[0].id;
    await call('switch_scene', { sceneId: id });
    expect(store.get().activeSceneId).toBe(id);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test server/mcp.test.ts`
Expected: FAIL, cannot resolve `./mcp`.

- [ ] **Step 3: Write the MCP server**

`server/mcp.ts`:

```ts
// MCP tool definitions (spec 9.4). One McpServer per connection, all sharing the workspace store.

import { StreamableHTTPTransport } from '@hono/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Hono } from 'hono';
import { z } from 'zod';
import { composition, hillFormula, molarMass, parseFormula } from '../src/chem/formula';
import { search } from '../src/chem/library';
import { svgToPng } from '../src/chem/png';
import { renderSnapshotSvg } from '../src/chem/render3d';
import type { Scene, Species, ViewState } from '../src/chem/types';
import { connectInfo } from './api';
import type { AppDeps } from './app';
import { CommandError, describe } from './workspace';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

const text = (t: string): Content => ({ type: 'text', text: t });
const json = (o: unknown): Content => ({ type: 'text', text: '```json\n' + JSON.stringify(o) + '\n```' });
async function image(svg: string, width: number): Promise<Content> {
  return { type: 'image', data: Buffer.from(await svgToPng(svg, width)).toString('base64'), mimeType: 'image/png' };
}

function atomList(s: Species): string {
  return s.atoms.map((a) => `${a.index}:${a.element}${a.charge ? (a.charge > 0 ? '+' : '') + a.charge : ''}`).join(' ');
}
function bondList(s: Species): string {
  return s.bonds.map((b) => `${b.a}-${b.b}${b.order > 1 ? `(${b.order})` : ''}${b.aromatic ? 'ar' : ''}`).join(' ');
}

export function speciesText(s: Species, deps: AppDeps, scene?: Scene): string {
  const geometryNote = s.geometry === 'conformer' ? '' : s.geometry === 'star'
    ? '3D geometry: ideal star geometry (the conformer generator does not handle this species).'
    : '3D geometry: flat 2D layout (no 3D available for this species).';
  return [
    `${s.name}: ${s.displayFormula}${s.iupacName ? ` (IUPAC: ${s.iupacName})` : ''}`,
    `Hill formula ${s.formula}; molar mass ${s.info.molarMass} g/mol; charge ${s.charge}; source ${s.source}${s.cid ? `; PubChem CID ${s.cid}` : ''}`,
    `SMILES ${s.smiles}`,
    `Atoms (1-based, heavy first): ${atomList(s)}`,
    `Bonds: ${bondList(s)}`,
    geometryNote,
    scene ? `Scene "${scene.title}" (id ${scene.id}). Open in the window: ${connectInfo(deps).window}/?scene=${scene.id}` : '',
  ].filter(Boolean).join('\n');
}

/** Software-rendered 3D PNG. Phase 2 asks a live window first. */
export async function render3dPng(deps: AppDeps, scene: Scene, species: Species, width: number, style?: ViewState['style']): Promise<Uint8Array> {
  const [rx, ry, rz] = scene.view.camera.rotation;
  const svg = renderSnapshotSvg(species.atoms, species.bonds, {
    width, height: Math.round(width * 0.75), style: style ?? scene.view.style, showHydrogens: scene.view.showHydrogens,
    highlight: scene.view.highlight, rotation: [20 + rx, 30 + ry, rz],
  });
  return svgToPng(svg, width);
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  const details = err instanceof CommandError ? err.details : err instanceof Error && 'suggestions' in err ? { suggestions: (err as { suggestions: unknown }).suggestions } : {};
  return { isError: true, content: [text(message), ...(Object.keys(details).length ? [json(details)] : [])] };
}

export function createMcpServer(deps: AppDeps): McpServer {
  const server = new McpServer({ name: 'chemtool', version: '0.1.0' });
  const store = deps.store;
  const run = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => { try { return await fn(); } catch (err) { return fail(err); } };
  const speciesIdArg = z.string().optional().describe('Species id from an earlier result. Defaults to the focused species of the active scene.');
  const widthArg = z.number().int().min(100).max(2000).default(640);
  const current = (id?: string) => store.findSpecies(id);
  const stateJson = () => ({ version: store.get().version, sceneId: store.get().activeSceneId });

  server.registerTool('lookup_chemical', {
    title: 'Look up a chemical',
    description: 'Resolve a name, formula, SMILES or CAS number to a compound. By default loads it into the ChemTool window and returns info, the numbered atom list (use these numbers in edit_molecule and set_view) and a 2D drawing. Set load=false to only read.',
    inputSchema: { query: z.string().min(1), load: z.boolean().default(true), newScene: z.boolean().default(false).describe('Open a new scene tab instead of replacing the current molecule.') },
  }, (args) => run(async () => {
    if (!args.load) {
      const r = await deps.resolver.resolve(args.query);
      return { content: [text(speciesText(r.species, deps)), json({ alternatives: r.alternatives, note: r.note }), await image(r.species.svg2dNumbered, 480)] };
    }
    const result = await store.dispatch({ type: 'load', query: args.query, newScene: args.newScene }, 'mcp');
    const scene = store.scene(result.sceneId);
    const species = store.focused(scene.id);
    return { content: [text(`${result.message}\n${speciesText(species, deps, scene)}`), json({ ...stateJson(), speciesId: species.id, alternatives: result.alternatives }), await image(species.svg2dNumbered, 480)] };
  }));

  server.registerTool('search_chemicals', {
    title: 'Search the library', description: 'Autocomplete-style search over the offline library by name, alias or formula. Does not change the window.',
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).default(10) },
  }, (args) => run(async () => {
    const hits = search(args.query, args.limit).map((e) => ({ name: e.name, formula: e.formula, category: e.category }));
    return { content: [text(hits.length ? hits.map((h) => `${h.name} (${h.formula}) - ${h.category}`).join('\n') : 'No matches'), json(hits)] };
  }));

  server.registerTool('get_current', {
    title: 'What is on screen', description: 'The active scene: its species with numbered atoms, the equation (for reactions), the view state and the workspace version. Cheap; call it to refresh atom numbers after edits.',
    inputSchema: {},
  }, () => run(async () => {
    const scene = store.activeScene();
    const focused = store.focused();
    const summary = scene.species.map((s) => (s.id === focused.id ? '[focused] ' : '') + speciesText(s, deps)).join('\n\n');
    return { content: [text(`Scene "${scene.title}" (id ${scene.id}, kind ${scene.kind})\n${summary}`), json({ ...stateJson(), kind: scene.kind, focusId: scene.focusId, equation: scene.equation ?? null, view: scene.view, species: scene.species.map((s) => ({ id: s.id, name: s.name, formula: s.formula, atoms: s.atoms, bonds: s.bonds })) })] };
  }));

  server.registerTool('set_molecule', {
    title: 'Replace the molecule', description: 'Replace the focused molecule from a SMILES string, a molfile, or a name/formula query. Returns the new numbered atom list and a 2D drawing.',
    inputSchema: { smiles: z.string().optional(), molfile: z.string().optional(), query: z.string().optional(), name: z.string().optional().describe('Display name for the new structure.') },
  }, (args) => run(async () => {
    const result = args.query
      ? await store.dispatch({ type: 'load', query: args.query }, 'mcp')
      : await store.dispatch({ type: 'set_structure', smiles: args.smiles, molfile: args.molfile, name: args.name }, 'mcp');
    const scene = store.scene(result.sceneId);
    const species = store.focused(scene.id);
    return { content: [text(`${result.message}\n${speciesText(species, deps, scene)}`), json({ ...stateJson(), speciesId: species.id }), await image(species.svg2dNumbered, 480)] };
  }));

  server.registerTool('render_2d', {
    title: 'Render 2D', description: 'PNG of the skeletal 2D structure. numbered=true labels heavy atoms with their indices.',
    inputSchema: { speciesId: speciesIdArg, numbered: z.boolean().default(false), width: widthArg },
  }, (args) => run(async () => {
    const { species } = current(args.speciesId);
    return { content: [text(`2D drawing of ${describe(species)}`), await image(args.numbered ? species.svg2dNumbered : species.svg2d, args.width)] };
  }));

  server.registerTool('render_3d', {
    title: 'Render 3D', description: 'PNG of the 3D model. Uses the live window when one is open, otherwise a software renderer.',
    inputSchema: { speciesId: speciesIdArg, style: z.enum(['ballstick', 'stick', 'spacefill', 'wireframe']).optional(), width: widthArg },
  }, (args) => run(async () => {
    const { scene, species } = current(args.speciesId);
    const bytes = await render3dPng(deps, scene, species, args.width, args.style);
    return { content: [text(`3D view of ${describe(species)} (software renderer)`), { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' }] };
  }));

  server.registerTool('get_structure', {
    title: 'Get structure data', description: 'The structure as SDF, molfile (3D, explicit hydrogens), SMILES, or JSON atoms and bonds.',
    inputSchema: { speciesId: speciesIdArg, format: z.enum(['sdf', 'molfile', 'smiles', 'json']).default('smiles') },
  }, (args) => run(async () => {
    const { species } = current(args.speciesId);
    const body = args.format === 'smiles' ? species.smiles
      : args.format === 'molfile' ? species.molfile3d
      : args.format === 'sdf' ? `${species.molfile3d}\n> <NAME>\n${species.name}\n\n$$$$\n`
      : JSON.stringify({ id: species.id, name: species.name, formula: species.formula, charge: species.charge, atoms: species.atoms, bonds: species.bonds });
    return { content: [text(body)] };
  }));

  server.registerTool('formula_info', {
    title: 'Formula info', description: 'Molar mass, Hill formula and mass percent composition of a formula. Pure calculation; does not change the window.',
    inputSchema: { formula: z.string().min(1) },
  }, (args) => run(async () => {
    const p = parseFormula(args.formula);
    const info = { hill: hillFormula(p.counts, p.charge), charge: p.charge, molarMass: Math.round(molarMass(p.counts) * 1000) / 1000, composition: composition(p.counts) };
    return { content: [text(`${args.formula}: Hill ${info.hill}, molar mass ${info.molarMass} g/mol\n${info.composition.map((c) => `${c.element}: ${c.count} atoms, ${c.massPercent}%`).join('\n')}`), json(info)] };
  }));

  server.registerTool('new_scene', {
    title: 'New scene', description: 'Open a new scene tab, optionally loading a compound into it. The new scene becomes active.',
    inputSchema: { title: z.string().optional(), query: z.string().optional() },
  }, (args) => run(async () => {
    const result = await store.dispatch({ type: 'new_scene', title: args.title, query: args.query }, 'mcp');
    return { content: [text(result.message), json({ ...stateJson(), speciesId: result.speciesId })] };
  }));

  server.registerTool('list_scenes', { title: 'List scenes', description: 'All scene tabs with their ids, titles and focused species.', inputSchema: {} }, () => run(async () => {
    const ws = store.get();
    const rows = ws.scenes.map((s) => ({ id: s.id, title: s.title, kind: s.kind, active: s.id === ws.activeSceneId, focused: describe(store.focused(s.id)) }));
    return { content: [text(rows.map((r) => `${r.active ? '* ' : '  '}${r.title} (id ${r.id}): ${r.focused}`).join('\n')), json(rows)] };
  }));

  server.registerTool('switch_scene', { title: 'Switch scene', description: 'Make a scene tab active in the window.', inputSchema: { sceneId: z.string() } }, (args) => run(async () => {
    const result = await store.dispatch({ type: 'switch_scene', sceneId: args.sceneId }, 'mcp');
    return { content: [text(result.message), json(stateJson())] };
  }));

  return server;
}

/** Stateless Streamable HTTP mount: a fresh server and transport per request. */
export function mountMcp(app: Hono, deps: AppDeps): void {
  app.all('/mcp', async (c) => {
    const server = createMcpServer(deps);
    const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return transport.handleRequest(c);
  });
}
```

Modify `server/app.ts`: add `import { mountMcp } from './mcp';` and call `mountMcp(app, deps);` on the line after `registerApi(app, deps);`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test server/mcp.test.ts`
Expected: 7 passed. If `registerTool` complains about the empty `inputSchema: {}`, pass `inputSchema: undefined` for the no-argument tools instead.

- [ ] **Step 5: Smoke the HTTP mount**

Run `bun run dev:server`, then:

```bash
curl -s -X POST http://127.0.0.1:8140/mcp -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"curl\",\"version\":\"0\"}}}"
```

Expected: a response (JSON or an SSE `data:` line) containing `"name":"chemtool"`.

- [ ] **Step 6: Commit**

```bash
git add server/mcp.ts server/mcp.test.ts server/app.ts
git commit -m "feat(chem-tool): MCP server with lookup, render and structure tools" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QiWkMqG7iGFc1gM4UJChdf" -- server/mcp.ts server/mcp.test.ts server/app.ts
```

---

### Task 12: React window: live state, search, scenes, 2D, info

**Files:**
- Create: `src/client/main.tsx`, `src/client/App.tsx`, `src/client/styles.css`, `src/client/store.ts`, `src/client/selectors.ts`, `src/client/ws.ts`, `src/client/commands.ts`, `src/client/api.ts`
- Create: `src/client/components/SearchBar.tsx`, `SceneTabs.tsx`, `SidePanel.tsx`, `Structure2D.tsx`, `InfoPanel.tsx`, `StatusBar.tsx`, `Toast.tsx`
- Test: `src/client/selectors.test.ts`, `src/client/ws.test.ts`

**Interfaces:**
- Consumes: types; `Command`, `ViewPatch` (type-only imports from `server/schemas`); `CommandResult` (type-only from `server/workspace`); REST and WebSocket protocol from Task 10.
- Produces:
  - `store.ts`: `useStore` (Zustand) with `workspace`, `connection: 'connecting' | 'open' | 'closed'`, `panel: Panel`, `toast`, `lastActor`, `alternatives`, and setters `setWorkspace(ws, actor)`, `setConnection`, `setPanel`, `showToast`, `setAlternatives`. `Panel = 'structure' | 'sketch' | 'info'` for now.
  - `selectors.ts`: `activeScene(ws)`, `focusedSpecies(scene)`.
  - `ws.ts`: `windowId`, `connect()`, `sendCommand(command): Promise<CommandResult>`, `handleMessage(msg)`, `extraHandlers: ((msg) => void)[]`, `class CommandFailed extends Error { status; details }`.
  - `commands.ts`: `load(query, newScene?)`, `setView(patch)`, `focus(id)`, `newScene(title?, query?)`, `switchScene(id)`, `closeScene(id)`, `renameScene(id, title)`, `setStructure(molfile, baseVersion)`.
  - `api.ts`: `searchLibrary(q): Promise<{ name; formula; category; smiles }[]>`.
- The centre of the window shows the 2D drawing until Task 13 replaces it with the 3D viewer.

- [ ] **Step 1: Write the failing tests**

`src/client/selectors.test.ts`:

```ts
import { expect, test } from 'vitest';
import { createInitialWorkspace } from '../../server/workspace';
import { activeScene, focusedSpecies } from './selectors';

test('selectors find the active scene and focused species, and tolerate null', () => {
  const ws = createInitialWorkspace();
  const scene = activeScene(ws);
  expect(scene?.id).toBe(ws.activeSceneId);
  expect(focusedSpecies(scene)?.name).toBe('Water');
  expect(activeScene(null)).toBeNull();
  expect(focusedSpecies(null)).toBeNull();
  expect(activeScene({ ...ws, activeSceneId: 'missing' })?.id).toBe(ws.scenes[0].id);
});
```

`src/client/ws.test.ts`:

```ts
import { expect, test } from 'vitest';
import { createInitialWorkspace } from '../../server/workspace';
import { useStore } from './store';
import { extraHandlers, handleMessage } from './ws';

test('handleMessage applies state, surfaces errors, forwards unknown messages', () => {
  const ws = createInitialWorkspace();
  handleMessage({ type: 'state', workspace: ws, actor: 'mcp', version: 1 });
  expect(useStore.getState().workspace?.version).toBe(1);
  expect(useStore.getState().lastActor).toBe('mcp');
  handleMessage({ type: 'error', message: 'boom' });
  expect(useStore.getState().toast).toBe('boom');
  const seen: unknown[] = [];
  extraHandlers.push((m) => seen.push(m));
  handleMessage({ type: 'snapshot_request', id: 'x' });
  expect(seen).toEqual([{ type: 'snapshot_request', id: 'x' }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test src/client`
Expected: FAIL, cannot resolve `./selectors` and `./ws`.

- [ ] **Step 3: Write store, selectors, connection and command helpers**

`src/client/store.ts`:

```ts
import { create } from 'zustand';
import type { Alternative } from '../chem/resolve';
import type { Workspace } from '../chem/types';

export type Panel = 'structure' | 'sketch' | 'info';
export type Connection = 'connecting' | 'open' | 'closed';

export interface ClientState {
  workspace: Workspace | null;
  connection: Connection;
  panel: Panel;
  toast: string | null;
  lastActor: string | null;
  alternatives: Alternative[];
  setWorkspace(ws: Workspace, actor: string): void;
  setConnection(c: Connection): void;
  setPanel(p: Panel): void;
  showToast(t: string | null): void;
  setAlternatives(a: Alternative[]): void;
}

export const useStore = create<ClientState>((set) => ({
  workspace: null,
  connection: 'connecting',
  panel: 'structure',
  toast: null,
  lastActor: null,
  alternatives: [],
  setWorkspace: (workspace, actor) => set({ workspace, lastActor: actor }),
  setConnection: (connection) => set({ connection }),
  setPanel: (panel) => set({ panel }),
  showToast: (toast) => set({ toast }),
  setAlternatives: (alternatives) => set({ alternatives }),
}));
```

`src/client/selectors.ts`:

```ts
import type { Scene, Species, Workspace } from '../chem/types';

export function activeScene(ws: Workspace | null): Scene | null {
  if (!ws) return null;
  return ws.scenes.find((s) => s.id === ws.activeSceneId) ?? ws.scenes[0] ?? null;
}

export function focusedSpecies(scene: Scene | null): Species | null {
  if (!scene) return null;
  return scene.species.find((s) => s.id === scene.focusId) ?? scene.species[0] ?? null;
}
```

`src/client/ws.ts`:

```ts
// Live connection to the server. Commands go over the socket and resolve on the server's ack;
// while reconnecting they fall back to POST /api/command.

import type { Command } from '../../server/schemas';
import type { CommandResult } from '../../server/workspace';
import { useStore } from './store';

export const windowId = Math.random().toString(36).slice(2, 10);

export class CommandFailed extends Error {
  constructor(message: string, public readonly status: number, public readonly details: Record<string, unknown>) { super(message); }
}

type Pending = { resolve: (r: CommandResult) => void; reject: (e: Error) => void };
const pending = new Map<string, Pending>();
let socket: WebSocket | null = null;
let attempt = 0;
let seq = 0;

/** Handlers for messages other than state/ack/error (phase 2: snapshot_request). */
export const extraHandlers: ((msg: Record<string, unknown>) => void)[] = [];

export function handleMessage(msg: Record<string, unknown>): void {
  const st = useStore.getState();
  if (msg.type === 'state') { st.setWorkspace(msg.workspace as never, String(msg.actor)); return; }
  if (msg.type === 'ack' && typeof msg.id === 'string') { pending.get(msg.id)?.resolve(msg.result as CommandResult); pending.delete(msg.id); return; }
  if (msg.type === 'error') {
    const { id, type: _t, message, status, ...details } = msg;
    if (typeof id === 'string') { pending.get(id)?.reject(new CommandFailed(String(message), Number(status ?? 400), details)); pending.delete(id); }
    else st.showToast(String(message));
    return;
  }
  for (const h of extraHandlers) h(msg);
}

export function connect(): void {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  useStore.getState().setConnection('connecting');
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => { attempt = 0; useStore.getState().setConnection('open'); ws.send(JSON.stringify({ type: 'hello', windowId })); };
  ws.onmessage = (e) => handleMessage(JSON.parse(String(e.data)));
  ws.onerror = () => ws.close();
  ws.onclose = () => {
    socket = null;
    useStore.getState().setConnection('closed');
    for (const p of pending.values()) p.reject(new CommandFailed('Connection lost', 0, {}));
    pending.clear();
    setTimeout(connect, Math.min(5000, 500 * 2 ** attempt++));
  };
}

export function sendRaw(msg: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

export async function sendCommand(command: Command): Promise<CommandResult> {
  if (socket?.readyState === WebSocket.OPEN) {
    const id = `c${++seq}`;
    const s = socket;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); s.send(JSON.stringify({ type: 'command', id, command })); });
  }
  const res = await fetch('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) });
  const body = await res.json();
  if (!res.ok) throw new CommandFailed(body.error ?? 'Command failed', res.status, body);
  useStore.getState().setWorkspace(body.workspace, `window:${windowId}`);
  return body.result;
}
```

`src/client/commands.ts`:

```ts
import type { ViewPatch } from '../../server/schemas';
import { useStore } from './store';
import { CommandFailed, sendCommand } from './ws';

function report(err: unknown): never {
  const e = err as CommandFailed;
  const suggestions = Array.isArray(e.details?.suggestions) ? ` Did you mean: ${(e.details.suggestions as string[]).join(', ')}?` : '';
  useStore.getState().showToast(`${e.message}${suggestions}`);
  throw err;
}

export async function load(query: string, newScene = false) {
  try {
    const r = await sendCommand({ type: 'load', query, newScene });
    useStore.getState().setAlternatives(r.alternatives ?? []);
    return r;
  } catch (err) { report(err); }
}
export const setView = (view: ViewPatch) => sendCommand({ type: 'set_view', view }).catch(report);
export const focus = (speciesId: string) => sendCommand({ type: 'focus', speciesId }).catch(report);
export const newScene = (title?: string, query?: string) => sendCommand({ type: 'new_scene', title, query }).catch(report);
export const switchScene = (sceneId: string) => sendCommand({ type: 'switch_scene', sceneId }).catch(report);
export const closeScene = (sceneId: string) => sendCommand({ type: 'close_scene', sceneId }).catch(report);
export const renameScene = (sceneId: string, title: string) => sendCommand({ type: 'rename_scene', sceneId, title }).catch(report);
export const setStructure = (molfile: string, baseVersion: number) => sendCommand({ type: 'set_structure', molfile, baseVersion });
```

`src/client/api.ts`:

```ts
export interface SearchHit { name: string; formula: string; category: string; smiles: string }

export async function searchLibrary(q: string, limit = 8): Promise<SearchHit[]> {
  if (!q.trim()) return [];
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  return res.ok ? res.json() : [];
}
```

- [ ] **Step 4: Write the components**

`src/client/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
```

`src/client/App.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { load } from './commands';
import { SceneTabs } from './components/SceneTabs';
import { SearchBar } from './components/SearchBar';
import { SidePanel } from './components/SidePanel';
import { StatusBar } from './components/StatusBar';
import { Structure2D } from './components/Structure2D';
import { Toast } from './components/Toast';
import { activeScene, focusedSpecies } from './selectors';
import { useStore } from './store';
import { connect } from './ws';

export default function App() {
  const workspace = useStore((s) => s.workspace);
  const scene = activeScene(workspace);
  const species = focusedSpecies(scene);
  const handledUrl = useRef(false);

  useEffect(() => { connect(); }, []);

  useEffect(() => {
    if (!workspace || handledUrl.current) return;
    handledUrl.current = true;
    const q = new URLSearchParams(location.search).get('q');
    if (q) { load(q).catch(() => {}); history.replaceState(null, '', location.pathname); }
  }, [workspace]);

  if (!workspace || !scene || !species) return <div className="loading">Connecting to ChemTool…</div>;

  return (
    <div className="app">
      <header className="topbar">
        <SearchBar />
        <SceneTabs />
        <StatusBar />
      </header>
      <main className="main">
        <div className="viewer-placeholder">
          <Structure2D species={species} large />
        </div>
      </main>
      <aside className="side">
        <SidePanel scene={scene} species={species} />
      </aside>
      <Toast />
    </div>
  );
}
```

`src/client/components/SearchBar.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { searchLibrary, type SearchHit } from '../api';
import { load } from '../commands';

export function SearchBar() {
  const [value, setValue] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { searchLibrary(value).then(setHits).catch(() => setHits([])); }, 150);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [value]);

  const submit = async (q: string) => {
    if (!q.trim()) return;
    setBusy(true); setOpen(false);
    try { await load(q); setValue(''); } catch { /* toast shown by commands.ts */ } finally { setBusy(false); }
  };

  return (
    <div className="search">
      <input
        value={value}
        placeholder="Name, formula, SMILES or CAS…  (e.g. caffeine, NaCl, CC(=O)O)"
        onChange={(e) => { setValue(e.target.value); setOpen(true); }}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(value); if (e.key === 'Escape') setOpen(false); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        disabled={busy}
      />
      {busy && <span className="spinner" aria-label="loading" />}
      {open && hits.length > 0 && (
        <ul className="suggestions">
          {hits.map((h) => (
            <li key={h.name} onMouseDown={() => submit(h.name)}>
              <span>{h.name}</span><span className="muted">{h.formula}</span><span className="muted small">{h.category}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

`src/client/components/SceneTabs.tsx`:

```tsx
import { closeScene, newScene, switchScene } from '../commands';
import { useStore } from '../store';

export function SceneTabs() {
  const ws = useStore((s) => s.workspace);
  if (!ws) return null;
  return (
    <nav className="tabs">
      {ws.scenes.map((s) => (
        <button key={s.id} className={s.id === ws.activeSceneId ? 'tab active' : 'tab'} onClick={() => switchScene(s.id)} title={s.id}>
          {s.title}
          {ws.scenes.length > 1 && <span className="close" onClick={(e) => { e.stopPropagation(); closeScene(s.id); }}>×</span>}
        </button>
      ))}
      <button className="tab add" onClick={() => newScene()} title="New scene">+</button>
    </nav>
  );
}
```

`src/client/components/SidePanel.tsx`:

```tsx
import type { Scene, Species } from '../../chem/types';
import { useStore, type Panel } from '../store';
import { InfoPanel } from './InfoPanel';
import { Structure2D } from './Structure2D';

const TABS: { id: Panel; label: string }[] = [
  { id: 'structure', label: '2D' },
  { id: 'info', label: 'Info' },
];

export function SidePanel({ scene, species }: { scene: Scene; species: Species }) {
  const panel = useStore((s) => s.panel);
  const setPanel = useStore((s) => s.setPanel);
  return (
    <div className="panel">
      <div className="panel-tabs">
        {TABS.map((t) => <button key={t.id} className={panel === t.id ? 'active' : ''} onClick={() => setPanel(t.id)}>{t.label}</button>)}
      </div>
      <div className="panel-body">
        {panel === 'structure' && <Structure2D species={species} />}
        {panel === 'info' && <InfoPanel species={species} scene={scene} />}
      </div>
    </div>
  );
}
```

`src/client/components/Structure2D.tsx`:

```tsx
import { useState } from 'react';
import type { Species } from '../../chem/types';

export function Structure2D({ species, large = false }: { species: Species; large?: boolean }) {
  const [numbered, setNumbered] = useState(false);
  return (
    <div className={large ? 'structure2d large' : 'structure2d'}>
      <div className="svg-host" dangerouslySetInnerHTML={{ __html: numbered ? species.svg2dNumbered : species.svg2d }} />
      <div className="row">
        <label><input type="checkbox" checked={numbered} onChange={(e) => setNumbered(e.target.checked)} /> atom numbers</label>
        <a href={`/api/species/${species.id}.png?w=1200${numbered ? '&numbered=1' : ''}`} download={`${species.name}.png`}>PNG</a>
        <a href={`/api/species/${species.id}.sdf`} download={`${species.name}.sdf`}>SDF</a>
      </div>
    </div>
  );
}
```

`src/client/components/InfoPanel.tsx`:

```tsx
import type { Scene, Species } from '../../chem/types';
import { load } from '../commands';
import { useStore } from '../store';

export function InfoPanel({ species, scene }: { species: Species; scene: Scene }) {
  const alternatives = useStore((s) => s.alternatives);
  return (
    <div className="info">
      <h2>{species.name}</h2>
      {species.iupacName && <div className="muted">{species.iupacName}</div>}
      <table>
        <tbody>
          <tr><th>Formula</th><td>{species.displayFormula}{species.displayFormula !== species.formula && <span className="muted"> (Hill: {species.formula})</span>}</td></tr>
          <tr><th>Molar mass</th><td>{species.info.molarMass} g/mol</td></tr>
          <tr><th>Charge</th><td>{species.charge}</td></tr>
          <tr><th>Atoms</th><td>{species.atoms.length} ({species.atoms.filter((a) => a.element !== 'H').length} heavy)</td></tr>
          <tr><th>Source</th><td>{species.source}{species.cid && <> · <a href={`https://pubchem.ncbi.nlm.nih.gov/compound/${species.cid}`} target="_blank" rel="noreferrer">PubChem {species.cid}</a></>}</td></tr>
          {species.category && <tr><th>Category</th><td>{species.category}</td></tr>}
          {species.geometry !== 'conformer' && <tr><th>3D</th><td>{species.geometry === 'star' ? 'ideal geometry' : 'flat layout (no 3D available)'}</td></tr>}
        </tbody>
      </table>
      {species.description && <p>{species.description}</p>}
      <h3>Composition</h3>
      <table>
        <thead><tr><th>Element</th><th>Count</th><th>Mass %</th></tr></thead>
        <tbody>{species.info.composition.map((c) => <tr key={c.element}><td>{c.element}</td><td>{c.count}</td><td>{c.massPercent.toFixed(2)}</td></tr>)}</tbody>
      </table>
      {alternatives.length > 0 && scene.kind === 'molecule' && (
        <>
          <h3>Same formula</h3>
          <ul className="alternatives">{alternatives.map((a) => <li key={a.name}><button className="link" onClick={() => load(a.name)}>{a.name}</button> <span className="muted">{a.formula}</span></li>)}</ul>
        </>
      )}
    </div>
  );
}
```

`src/client/components/StatusBar.tsx`:

```tsx
import { useStore } from '../store';

export function StatusBar() {
  const connection = useStore((s) => s.connection);
  const version = useStore((s) => s.workspace?.version);
  const actor = useStore((s) => s.lastActor);
  const who = actor === 'mcp' ? 'updated by AI' : actor === 'api' ? 'updated via API' : '';
  return (
    <div className="status">
      <span className={`dot ${connection}`} title={connection} />
      <span className="muted small">v{version ?? '-'} {who}</span>
    </div>
  );
}
```

`src/client/components/Toast.tsx`:

```tsx
import { useEffect } from 'react';
import { useStore } from '../store';

export function Toast() {
  const toast = useStore((s) => s.toast);
  const show = useStore((s) => s.showToast);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => show(null), 5000); return () => clearTimeout(t); }, [toast, show]);
  if (!toast) return null;
  return <div className="toast" onClick={() => show(null)}>{toast}</div>;
}
```

`src/client/styles.css`:

```css
:root { --bg: #f6f7f9; --panel: #ffffff; --line: #d9dde3; --text: #1c1f24; --muted: #6b7280; --accent: #2563eb; --warn: #b45309; }
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body { font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text); background: var(--bg); }
.loading { display: grid; place-items: center; height: 100%; color: var(--muted); }
.app { display: grid; grid-template-columns: 1fr 400px; grid-template-rows: 48px 1fr; height: 100%; }
.topbar { grid-column: 1 / 3; display: flex; align-items: center; gap: 12px; padding: 0 12px; background: var(--panel); border-bottom: 1px solid var(--line); }
.main { position: relative; min-width: 0; min-height: 0; }
.side { border-left: 1px solid var(--line); background: var(--panel); overflow: auto; min-height: 0; }
.search { position: relative; flex: 0 0 420px; }
.search input { width: 100%; padding: 7px 10px; border: 1px solid var(--line); border-radius: 6px; font: inherit; }
.search .spinner { position: absolute; right: 10px; top: 10px; width: 14px; height: 14px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.suggestions { position: absolute; top: 36px; left: 0; right: 0; z-index: 20; margin: 0; padding: 4px 0; list-style: none; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 6px 20px rgba(0,0,0,0.08); }
.suggestions li { display: flex; gap: 10px; padding: 6px 10px; cursor: pointer; }
.suggestions li:hover { background: var(--bg); }
.tabs { display: flex; gap: 4px; overflow-x: auto; flex: 1; min-width: 0; }
.tab { border: 1px solid var(--line); background: var(--bg); border-radius: 6px; padding: 5px 10px; font: inherit; cursor: pointer; white-space: nowrap; }
.tab.active { background: var(--panel); border-color: var(--accent); color: var(--accent); }
.tab .close { margin-left: 8px; color: var(--muted); }
.tab.add { font-weight: 600; }
.status { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: #9ca3af; }
.dot.open { background: #16a34a; } .dot.connecting { background: #f59e0b; } .dot.closed { background: #dc2626; }
.muted { color: var(--muted); } .small { font-size: 12px; }
.viewer-placeholder { display: grid; place-items: center; height: 100%; padding: 24px; }
.structure2d .svg-host { color: var(--text); display: flex; justify-content: center; }
.structure2d .svg-host svg { max-width: 100%; height: auto; }
.structure2d.large .svg-host svg { max-height: 70vh; }
.structure2d .row { display: flex; gap: 16px; align-items: center; margin-top: 8px; }
.panel-tabs { display: flex; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--panel); }
.panel-tabs button { flex: 1; padding: 10px; border: 0; background: none; font: inherit; cursor: pointer; border-bottom: 2px solid transparent; }
.panel-tabs button.active { border-bottom-color: var(--accent); color: var(--accent); }
.panel-body { padding: 12px; }
.info h2 { margin: 0 0 4px; } .info h3 { margin: 16px 0 6px; font-size: 13px; text-transform: uppercase; color: var(--muted); }
.info table { border-collapse: collapse; width: 100%; } .info th, .info td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
.info th { color: var(--muted); font-weight: 500; width: 110px; }
.alternatives { padding-left: 16px; } .link { border: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; padding: 0; }
.toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #1c1f24; color: #fff; padding: 10px 16px; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.2); max-width: 70vw; cursor: pointer; z-index: 50; }
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `bun run test src/client && bun run typecheck`
Expected: 2 tests pass; typecheck clean. Common fixes: `history.replaceState` needs the DOM lib (present in tsconfig); type-only imports from `server/` must use `import type`.

- [ ] **Step 6: Run it in the browser**

Terminal 1: `bun run dev:server`. Terminal 2: `bun run dev`. Open `http://localhost:5173`.

Expected: the window shows Water's 2D drawing, the Info tab lists formula and composition, the status dot is green. Type `caffeine` and press Enter: the drawing and info change. Type `C2H6O`: ethanol loads and the Info tab offers "Dimethyl ether" under "Same formula". Type `nonsense`: a toast with suggestions. Click "+" to add a scene and "×" to close it. In a third terminal run `curl -s -X POST http://127.0.0.1:8140/api/command -H "content-type: application/json" -d "{\"type\":\"load\",\"query\":\"benzene\"}"` and watch the window switch to benzene without a reload; the status shows "updated via API".

Then `bun run build` and open `http://127.0.0.1:8140/` directly: the built client must load from the Bun server with the same behaviour.

- [ ] **Step 7: Commit**

```bash
git add src/client
git commit -m "feat(chem-tool): React window with live state, search, scenes, 2D and info" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QiWkMqG7iGFc1gM4UJChdf" -- src/client
```

---

### Task 13: 3D viewer (3Dmol.js) and view toolbar

**Files:**
- Create: `src/client/viewer3d.ts`, `src/client/components/Viewer3D.tsx`
- Modify: `src/client/App.tsx` (replace the placeholder with `<Viewer3D>`), `src/client/styles.css` (append viewer rules)

**Interfaces:**
- Consumes: `Species`, `ViewState`; `setView` from `commands.ts`.
- Produces: `createViewer(container): Viewer3DApi` where `Viewer3DApi = { setSpecies(species, view); setView(view, species); snapshot(): string (PNG data URL); resize(); destroy() }`; `<Viewer3D species view />`. The module is imported dynamically so 3Dmol (about 1 MB) is a separate chunk loaded after the first paint.
- Camera rule: the viewer re-fits only when the species changes or `view.camera` changes; style, label, spin and highlight changes keep the user's current rotation.

3Dmol facts (from its type definitions, version 2.5): `createViewer(element, { backgroundColor, antialias })`, `addModel(text, 'sdf')`, `setStyle(sel, style)` where `{}` as a style hides atoms, `addStyle`, selection by `index` (0-based) or `elem`, `addLabel(text, { position, fontSize, fontColor, backgroundColor, backgroundOpacity, borderThickness, inFront })`, `removeAllLabels`, `zoomTo`, `getView`/`setView` (array: 3 translation, zoom, quaternion x y z w), `rotate(degrees, axis)`, `spin(axis | false)`, `pngURI()`, `resize()`, `clear()`.

- [ ] **Step 1: Write the viewer wrapper**

`src/client/viewer3d.ts`:

```ts
// 3Dmol.js wrapper. Loaded lazily from Viewer3D.tsx.

import * as $3Dmol from '3dmol';
import type { Species, ViewState } from '../chem/types';

export interface Viewer3DApi {
  setSpecies(species: Species, view: ViewState): void;
  setView(view: ViewState, species: Species): void;
  snapshot(): string;
  resize(): void;
  destroy(): void;
}

function styleSpec(style: ViewState['style']): Record<string, unknown> {
  switch (style) {
    case 'stick': return { stick: { radius: 0.22 } };
    case 'spacefill': return { sphere: {} };
    case 'wireframe': return { line: { linewidth: 2 } };
    default: return { stick: { radius: 0.15 }, sphere: { scale: 0.28 } };
  }
}

const PRESET_Q: Record<ViewState['camera']['preset'], [number, number, number, number]> = {
  fit: [0, 0, 0, 1],
  front: [0, 0, 0, 1],
  top: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
  side: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
};

export function createViewer(container: HTMLElement): Viewer3DApi {
  const viewer = $3Dmol.createViewer(container, { backgroundColor: 'white', antialias: true });
  let currentId: string | null = null;
  let lastCamera = '';

  function apply(view: ViewState, species: Species, resetCamera: boolean) {
    viewer.setStyle({}, styleSpec(view.style));
    if (!view.showHydrogens) viewer.setStyle({ elem: 'H' }, {});
    if (view.highlight.length) viewer.addStyle({ index: view.highlight.map((i) => i - 1) }, { sphere: { color: '#ffd400', scale: 0.42, opacity: 0.85 } });
    viewer.removeAllLabels();
    if (view.labels !== 'none') {
      for (const a of species.atoms) {
        if (a.element === 'H' && (!view.showHydrogens || view.labels === 'index')) continue;
        viewer.addLabel(view.labels === 'index' ? String(a.index) : a.element, {
          position: { x: a.x, y: a.y, z: a.z }, fontSize: 12, fontColor: 'white', backgroundColor: 'black', backgroundOpacity: 0.6, borderThickness: 0, inFront: true,
        });
      }
    }
    if (resetCamera) {
      viewer.zoomTo();
      const v = viewer.getView() as number[];
      viewer.setView([v[0], v[1], v[2], v[3], ...PRESET_Q[view.camera.preset]]);
      const [rx, ry, rz] = view.camera.rotation;
      if (rx) viewer.rotate(rx, 'x');
      if (ry) viewer.rotate(ry, 'y');
      if (rz) viewer.rotate(rz, 'z');
    }
    viewer.spin(view.spin ? 'y' : false);
    viewer.render();
  }

  const api: Viewer3DApi = {
    setSpecies(species, view) {
      viewer.removeAllModels();
      viewer.removeAllShapes();
      viewer.removeAllLabels();
      viewer.addModel(species.molfile3d, 'sdf');
      currentId = species.id;
      lastCamera = JSON.stringify(view.camera);
      apply(view, species, true);
    },
    setView(view, species) {
      if (species.id !== currentId) { api.setSpecies(species, view); return; }
      const cam = JSON.stringify(view.camera);
      const changed = cam !== lastCamera;
      lastCamera = cam;
      apply(view, species, changed);
    },
    snapshot: () => viewer.pngURI(),
    resize: () => viewer.resize(),
    destroy: () => viewer.clear(),
  };
  return api;
}
```

If Vite refuses the UMD entry (`import * as $3Dmol from '3dmol'` yields an empty object at runtime), import `'3dmol/build/3Dmol.es6.js'` instead and add `src/client/3dmol.d.ts` containing `declare module '3dmol/build/3Dmol.es6.js' { export * from '3dmol'; }`.

- [ ] **Step 2: Write the component and toolbar**

`src/client/components/Viewer3D.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import type { Species, ViewState } from '../../chem/types';
import { setView } from '../commands';
import type { Viewer3DApi } from '../viewer3d';

/** Set by the mounted viewer; used by the live snapshot responder (phase 2). */
export let snapshotProvider: (() => string | null) | null = null;

const STYLES: ViewState['style'][] = ['ballstick', 'stick', 'spacefill', 'wireframe'];
const LABELS: ViewState['labels'][] = ['none', 'element', 'index'];

export function Viewer3D({ species, view }: { species: Species; view: ViewState }) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer3DApi | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    import('../viewer3d').then((m) => {
      if (!alive || !host.current) return;
      viewer.current = m.createViewer(host.current);
      snapshotProvider = () => viewer.current?.snapshot() ?? null;
      setReady(true);
    });
    const onResize = () => viewer.current?.resize();
    window.addEventListener('resize', onResize);
    return () => { alive = false; window.removeEventListener('resize', onResize); snapshotProvider = null; viewer.current?.destroy(); viewer.current = null; };
  }, []);

  useEffect(() => { if (ready) viewer.current?.setView(view, species); }, [ready, species, view]);

  const download = () => {
    const url = viewer.current?.snapshot();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url; a.download = `${species.name}-3d.png`; a.click();
  };

  return (
    <div className="viewer">
      <div ref={host} className="viewer-canvas" />
      {!ready && <div className="viewer-loading">Loading 3D…</div>}
      <div className="toolbar">
        <div className="group">
          {STYLES.map((s) => <button key={s} className={view.style === s ? 'active' : ''} onClick={() => setView({ style: s })}>{s}</button>)}
        </div>
        <div className="group">
          {LABELS.map((l) => <button key={l} className={view.labels === l ? 'active' : ''} onClick={() => setView({ labels: l })}>{l === 'none' ? 'no labels' : l}</button>)}
        </div>
        <div className="group">
          <button className={view.spin ? 'active' : ''} onClick={() => setView({ spin: !view.spin })}>spin</button>
          <button className={view.showHydrogens ? 'active' : ''} onClick={() => setView({ showHydrogens: !view.showHydrogens })}>H</button>
          <button onClick={() => setView({ camera: { preset: 'fit', rotation: [0, 0, 0] }, highlight: [] })}>reset</button>
          <button onClick={download}>PNG</button>
        </div>
      </div>
      <div className="viewer-caption">{species.name} · {species.displayFormula} · {species.info.molarMass} g/mol</div>
    </div>
  );
}
```

Modify `src/client/App.tsx`: replace the `import { Structure2D } ...` line with `import { Viewer3D } from './components/Viewer3D';` and replace the `<div className="viewer-placeholder">…</div>` block inside `<main>` with `<Viewer3D species={species} view={scene.view} />`.

Append to `src/client/styles.css`:

```css
.viewer { position: relative; height: 100%; }
.viewer-canvas { position: absolute; inset: 0; }
.viewer-loading { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); pointer-events: none; }
.toolbar { position: absolute; top: 10px; left: 10px; display: flex; gap: 10px; flex-wrap: wrap; z-index: 5; }
.toolbar .group { display: flex; background: rgba(255,255,255,0.92); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.toolbar button { border: 0; background: none; padding: 5px 9px; font: inherit; font-size: 12px; cursor: pointer; }
.toolbar button.active { background: var(--accent); color: white; }
.viewer-caption { position: absolute; bottom: 10px; left: 12px; color: var(--muted); font-size: 12px; background: rgba(255,255,255,0.85); padding: 2px 6px; border-radius: 4px; }
```

- [ ] **Step 3: Typecheck and verify in the browser**

Run: `bun run typecheck`
Expected: clean. If `viewer.setView` complains about the tuple, cast: `viewer.setView([...] as unknown as never)`.

Run `bun run dev:server` and `bun run dev`, open `http://localhost:5173`:

- Water appears as a rotatable ball-and-stick model; drag to rotate, scroll to zoom.
- Each style button changes the rendering without resetting your rotation; "reset" refits.
- "element" labels show O and H; "index" labels show 1 (oxygen only, hydrogens are unlabeled).
- Load `caffeine` from the search box: the model changes and refits.
- From another terminal: `curl -s -X POST http://127.0.0.1:8140/api/command -H "content-type: application/json" -d "{\"type\":\"set_view\",\"view\":{\"style\":\"spacefill\",\"spin\":true,\"highlight\":[1,2]}}"`. The viewer switches to spacefill, spins, and atoms 1 and 2 glow yellow, with no page reload.
- Open the browser devtools Network tab and reload: the 3Dmol chunk loads after the main bundle.

- [ ] **Step 4: Commit**

```bash
git add src/client/viewer3d.ts src/client/components/Viewer3D.tsx src/client/App.tsx src/client/styles.css
git commit -m "feat(chem-tool): 3Dmol viewer with live view state" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QiWkMqG7iGFc1gM4UJChdf" -- src/client/viewer3d.ts src/client/components/Viewer3D.tsx src/client/App.tsx src/client/styles.css
```

---

### Task 14: Connect dialog and the Claude Code round trip

**Files:**
- Create: `src/client/components/ConnectDialog.tsx`
- Modify: `src/client/App.tsx` (Connect button in the top bar; open when the URL has `?connect=1`), `src/client/styles.css`

**Interfaces:**
- Consumes: `GET /api/connect` from Task 10.
- Produces: `<ConnectDialog open onClose />`. Phase 6 extends it with Claude Desktop, ChatGPT and the tunnel toggle.

- [ ] **Step 1: Write the dialog**

`src/client/components/ConnectDialog.tsx`:

```tsx
import { useEffect, useState } from 'react';

interface ConnectInfo { mcpUrl: string; claudeCode: string; openapi: string; window: string }

function Snippet({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="snippet">
      <div className="snippet-label">{label}</div>
      <pre>{value}</pre>
      <button onClick={() => { navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? 'copied' : 'copy'}</button>
    </div>
  );
}

export function ConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [info, setInfo] = useState<ConnectInfo | null>(null);
  useEffect(() => { if (open) fetch('/api/connect').then((r) => r.json()).then(setInfo).catch(() => setInfo(null)); }, [open]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Connect an AI client</h2>
        {!info && <div className="muted">Loading…</div>}
        {info && (
          <>
            <Snippet label="Claude Code (run once in any terminal)" value={info.claudeCode} />
            <Snippet label="MCP endpoint (Streamable HTTP)" value={info.mcpUrl} />
            <Snippet label="OpenAPI document" value={info.openapi} />
            <p className="muted small">Claude Desktop and ChatGPT connections arrive with the desktop build.</p>
          </>
        )}
        <button className="primary" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
```

Modify `src/client/App.tsx`:

- Add `import { useState } from 'react'` to the existing React import and `import { ConnectDialog } from './components/ConnectDialog';`.
- Inside `App`, add `const [connectOpen, setConnectOpen] = useState(new URLSearchParams(location.search).get('connect') === '1');`.
- In the header, after `<SceneTabs />`, add `<button className="tab" onClick={() => setConnectOpen(true)}>Connect</button>`.
- Before `<Toast />`, add `<ConnectDialog open={connectOpen} onClose={() => setConnectOpen(false)} />`.

Append to `src/client/styles.css`:

```css
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.35); display: grid; place-items: center; z-index: 40; }
.modal { background: var(--panel); border-radius: 10px; padding: 20px 24px; width: min(640px, 92vw); max-height: 85vh; overflow: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.25); }
.modal h2 { margin-top: 0; }
.snippet { margin: 12px 0; } .snippet-label { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.snippet pre { margin: 0; padding: 8px 10px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; white-space: pre-wrap; word-break: break-all; }
.snippet button { margin-top: 4px; font: inherit; font-size: 12px; }
button.primary { margin-top: 8px; background: var(--accent); color: white; border: 0; border-radius: 6px; padding: 8px 14px; font: inherit; cursor: pointer; }
```

- [ ] **Step 2: Typecheck, build, and run the Claude Code round trip**

Run: `bun run typecheck && bun run build && bun run start`
Expected: server on 8140 serving the built client. Open `http://127.0.0.1:8140/?connect=1`: the dialog shows the `claude mcp add` command.

In a terminal, run the printed command:

```bash
claude mcp add --transport http chemtool http://127.0.0.1:8140/mcp
claude mcp list
```

Expected: `chemtool` listed as connected. Then start `claude` in any directory and ask: "Use chemtool to look up caffeine, then render it in 3D and tell me its molar mass." Expected: Claude calls `lookup_chemical` and `render_3d`; the ChemTool window switches to caffeine within a second without a reload, the status bar shows "updated by AI", and Claude reports 194.19 g/mol and shows the image it received.

Then ask: "Switch the view to spacefill and highlight atoms 1 and 2." Expected in phase 1: Claude has no `set_view` tool yet and says so, or uses `set_molecule`; that is fine. Phase 2 adds `set_view`.

- [ ] **Step 3: Run the full test suite**

Run: `bun run test`
Expected: all files pass (elements, formula, structure, species, library, pubchem, resolve, png, render3d, workspace, persist, api, mcp, selectors, ws).

- [ ] **Step 4: Commit**

```bash
git add src/client/components/ConnectDialog.tsx src/client/App.tsx src/client/styles.css
git commit -m "feat(chem-tool): connect dialog with Claude Code snippet" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QiWkMqG7iGFc1gM4UJChdf" -- src/client/components/ConnectDialog.tsx src/client/App.tsx src/client/styles.css
```

Phase 1 is complete at this point: lookup, 2D, 3D, info, live window, MCP over HTTP with Claude Code.

---

## Phase 2

### Task 15: Edit engine

**Files:**
- Create: `src/chem/edit.ts`
- Test: `src/chem/edit.test.ts`

**Interfaces:**
- Consumes: `bySymbol`; `heavyAtomCount`, `reorderHeavyFirst` (Task 3).
- Produces: `type EditOp` (union of the nine ops below); `class EditError extends Error`; `GROUPS: Record<string, string>` (named group to SMILES fragment); `applyEdits(mol: OCL.Molecule, ops: EditOp[]): OCL.Molecule` (returns a new heavy-first molecule with hydrogens re-saturated; throws `EditError` with atom numbers on any invalid result; the input is never mutated).

Semantics. Op indices are the 1-based atom numbers of the molecule **as it was when the command started**; the engine keeps an old-to-current map so later ops in the same command still refer to the original numbering even after deletions. Atoms added during the command cannot be referenced by later ops in the same command. Before adding a bond to an atom that has no free valence, one of its explicit hydrogens is removed ("freeing up"); after all ops, explicit hydrogens are dropped and implicit hydrogens re-added, then every atom's free valence must be zero or more.

| Op | Fields | Effect |
|---|---|---|
| `add_atom` | `element`, `bondTo`, `order?` | New atom bonded to `bondTo`. |
| `remove_atom` | `index` | Removes the atom and its hydrogens. |
| `set_element` | `index`, `element` | Changes the element. |
| `set_charge` | `index`, `charge` | Formal charge. |
| `add_bond` | `a`, `b`, `order?` | New bond; error if one exists. |
| `remove_bond` | `a`, `b` | Deletes the bond. |
| `set_bond_order` | `a`, `b`, `order` | Frees hydrogens as needed when raising the order. |
| `attach_group` | `index`, `group` | Attaches a named group or SMILES fragment (first atom is the attachment point). |
| `replace_group` | `index`, `group` | `index` is a hydrogen or a leaf atom with one heavy neighbour; it and its hydrogens are removed and the group is attached to the neighbour. |

- [ ] **Step 1: Write the failing test**

`src/chem/edit.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/chem/edit.test.ts`
Expected: FAIL, cannot resolve `./edit`.

- [ ] **Step 3: Write the implementation**

`src/chem/edit.ts`:

```ts
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

  if (heavyAtomCount(mol) > 0) mol.removeExplicitHydrogens();
  mol.addImplicitHydrogens();
  mol.ensureHelperArrays(OCL.Molecule.cHelperNeighbours);
  for (let i = 0; i < mol.getAllAtoms(); i++) {
    if (mol.getFreeValence(i) < 0) {
      throw new EditError(`${elementName(mol, i)} ${i + 1} would have ${mol.getOccupiedValence(i)} bonds, more than its valence of ${mol.getMaxValence(i)}`);
    }
  }
  return reorderHeavyFirst(mol);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test src/chem/edit.test.ts`
Expected: 8 passed. If the overload test reports a different bond count wording, print `getOccupiedValence` and `getMaxValence` for the carbon and adjust the expected regex to the real numbers, keeping the "would have" phrasing.

- [ ] **Step 5: Commit**

```bash
git add src/chem/edit.ts src/chem/edit.test.ts
git commit -m "feat(chem-tool): atom-level edit engine with valence checking" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QiWkMqG7iGFc1gM4UJChdf" -- src/chem/edit.ts src/chem/edit.test.ts
```

---

### Task 16: `edit`, `undo`, `redo` commands

**Files:**
- Modify: `server/schemas.ts` (add `EditOpSchema`; add `edit`, `undo`, `redo` to `CommandSchema`), `server/workspace.ts` (three new cases)
- Test: `server/workspace-edit.test.ts`

**Interfaces:**
- Consumes: `applyEdits`, `EditError` (Task 15).
- Produces: `EditOpSchema`; commands `{ type: 'edit'; ops: EditOp[]; baseVersion?; name? }`, `{ type: 'undo' }`, `{ type: 'redo' }`. `edit` rejects with 422 and `details.atoms` (the current numbered atom list) on an `EditError`. `undo`/`redo` move snapshots between `history.past` and `history.future`; both throw 400 when empty; both clear `view.highlight`.

- [ ] **Step 1: Write the failing test**

`server/workspace-edit.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { createResolver } from '../src/chem/resolve';
import { CommandError, HISTORY_LIMIT, WorkspaceStore, createInitialWorkspace } from './workspace';

const make = () => new WorkspaceStore(createInitialWorkspace(), createResolver({ pubchem: null }));

describe('edit, undo, redo', () => {
  test('edit replaces the focused species and records history', async () => {
    const store = make();
    await store.dispatch({ type: 'load', query: 'ethanol' }, 'api');
    const r = await store.dispatch({ type: 'edit', ops: [{ op: 'replace_group', index: 3, group: 'NH2' }], baseVersion: 2 }, 'mcp');
    expect(r.message).toMatch(/1 edit/);
    expect(store.focused().formula).toBe('C2H7N');
    expect(store.focused().name).toBe('Ethanol (edited)');
    expect(store.focused().source).toBe('edit');
    expect(store.activeScene().history.past).toHaveLength(2);
  });
  test('invalid edits are 422 with the atom list; stale versions are 409', async () => {
    const store = make();
    const bad = await store.dispatch({ type: 'edit', ops: [{ op: 'add_atom', element: 'Cl', bondTo: 42 }] }, 'mcp').catch((e) => e);
    expect(bad).toBeInstanceOf(CommandError);
    expect(bad.status).toBe(422);
    expect(bad.details.atoms).toBe('1:O 2:H 3:H');
    const stale = await store.dispatch({ type: 'edit', ops: [{ op: 'set_element', index: 1, element: 'S' }], baseVersion: 99 }, 'mcp').catch((e) => e);
    expect(stale.status).toBe(409);
    expect(store.get().version).toBe(1);
  });
  test('undo and redo walk the history and clear highlights', async () => {
    const store = make();
    await store.dispatch({ type: 'load', query: 'methane' }, 'api');
    await store.dispatch({ type: 'edit', ops: [{ op: 'add_atom', element: 'Cl', bondTo: 1 }] }, 'mcp');
    await store.dispatch({ type: 'set_view', view: { highlight: [2] } }, 'mcp');
    expect(store.focused().formula).toBe('CH3Cl');
    await store.dispatch({ type: 'undo' }, 'mcp');
    expect(store.focused().formula).toBe('CH4');
    expect(store.activeScene().view.highlight).toEqual([]);
    await store.dispatch({ type: 'undo' }, 'mcp');
    expect(store.focused().name).toBe('Water');
    const empty = await store.dispatch({ type: 'undo' }, 'mcp').catch((e) => e);
    expect(empty.status).toBe(400);
    await store.dispatch({ type: 'redo' }, 'mcp');
    await store.dispatch({ type: 'redo' }, 'mcp');
    expect(store.focused().formula).toBe('CH3Cl');
    expect((await store.dispatch({ type: 'redo' }, 'mcp').catch((e) => e)).status).toBe(400);
  });
  test('a new structural change after undo discards the redo branch; history is capped', async () => {
    const store = make();
    await store.dispatch({ type: 'load', query: 'methane' }, 'api');
    await store.dispatch({ type: 'undo' }, 'mcp');
    expect(store.activeScene().history.future).toHaveLength(1);
    await store.dispatch({ type: 'load', query: 'ethane' }, 'api');
    expect(store.activeScene().history.future).toHaveLength(0);
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) await store.dispatch({ type: 'set_structure', smiles: i % 2 ? 'C' : 'CC' }, 'api');
    expect(store.activeScene().history.past).toHaveLength(HISTORY_LIMIT);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test server/workspace-edit.test.ts`
Expected: FAIL: `edit` is not a valid command type (zod rejects it or TypeScript refuses the literal).

- [ ] **Step 3: Extend the schemas and the store**

In `server/schemas.ts`, add before `CommandSchema`:

```ts
const atomIndex = z.number().int().min(1);
const bondOrder = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const EditOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_atom'), element: z.string().min(1), bondTo: atomIndex, order: bondOrder.optional() }),
  z.object({ op: z.literal('remove_atom'), index: atomIndex }),
  z.object({ op: z.literal('set_element'), index: atomIndex, element: z.string().min(1) }),
  z.object({ op: z.literal('set_charge'), index: atomIndex, charge: z.number().int().min(-4).max(4) }),
  z.object({ op: z.literal('add_bond'), a: atomIndex, b: atomIndex, order: bondOrder.optional() }),
  z.object({ op: z.literal('remove_bond'), a: atomIndex, b: atomIndex }),
  z.object({ op: z.literal('set_bond_order'), a: atomIndex, b: atomIndex, order: bondOrder }),
  z.object({ op: z.literal('attach_group'), index: atomIndex, group: z.string().min(1) }),
  z.object({ op: z.literal('replace_group'), index: atomIndex, group: z.string().min(1) }),
]);
export type EditOpInput = z.infer<typeof EditOpSchema>;
```

and add these members to the `CommandSchema` union:

```ts
  z.object({ type: z.literal('edit'), ops: z.array(EditOpSchema).min(1), baseVersion: z.number().int().optional(), name: z.string().optional() }),
  z.object({ type: z.literal('undo') }),
  z.object({ type: z.literal('redo') }),
```

In `server/workspace.ts`, add imports `import { EditError, applyEdits } from '../src/chem/edit';` and add these cases to `apply` before the closing of the `switch`:

```ts
      case 'edit': {
        this.checkVersion(cmd.baseVersion);
        const scene = this.activeScene();
        const current = this.focused();
        const mol = parseMolfile(current.molfile3d);
        if (!mol) throw new CommandError(422, 'The current structure cannot be parsed');
        let edited;
        try {
          edited = applyEdits(mol, cmd.ops);
        } catch (err) {
          if (err instanceof EditError) throw new CommandError(422, err.message, { atoms: current.atoms.map((a) => `${a.index}:${a.element}`).join(' ') });
          throw err;
        }
        const name = cmd.name ?? (current.name.endsWith('(edited)') ? current.name : `${current.name} (edited)`);
        const species = speciesFromMolecule(edited, { name, source: 'edit', category: current.category });
        this.replaceFocused(scene, species);
        return { message: `Applied ${cmd.ops.length} edit${cmd.ops.length === 1 ? '' : 's'}: now ${describe(species)}`, sceneId: scene.id, speciesId: species.id };
      }
      case 'undo':
      case 'redo': {
        const scene = this.activeScene();
        const from = cmd.type === 'undo' ? scene.history.past : scene.history.future;
        const to = cmd.type === 'undo' ? scene.history.future : scene.history.past;
        const target = from.pop();
        if (!target) throw new CommandError(400, cmd.type === 'undo' ? 'Nothing to undo' : 'Nothing to redo');
        to.push(snapshotOf(scene));
        scene.kind = target.kind;
        scene.species = target.species;
        scene.equation = target.equation;
        scene.focusId = target.focusId;
        scene.view = { ...scene.view, highlight: [] };
        const species = this.focused(scene.id);
        return { message: `${cmd.type === 'undo' ? 'Undid' : 'Redid'}: now ${describe(species)}`, sceneId: scene.id, speciesId: species.id };
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test server`
Expected: all server tests pass, including the earlier ones.

- [ ] **Step 5: Commit**

```bash
git add server/schemas.ts server/workspace.ts server/workspace-edit.test.ts
git commit -m "feat(chem-tool): edit, undo and redo commands" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QiWkMqG7iGFc1gM4UJChdf" -- server/schemas.ts server/workspace.ts server/workspace-edit.test.ts
```

---

### Task 17: MCP tools `edit_molecule`, `set_view`, `undo`, `redo`

**Files:**
- Modify: `server/mcp.ts`
- Test: `server/mcp-edit.test.ts`

**Interfaces:**
- Consumes: `EditOpSchema`, Task 16 commands.
- Produces: four more tools. `set_view` accepts the view fields plus `rotate: { axis: 'x' | 'y' | 'z'; degrees }`, which adds to the scene's camera rotation, and returns a 3D PNG (software now, live after Task 19).

- [ ] **Step 1: Write the failing test**

`server/mcp-edit.test.ts`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, test } from 'vitest';
import { createResolver } from '../src/chem/resolve';
import { createMcpServer } from './mcp';
import { WorkspaceStore, createInitialWorkspace } from './workspace';

type Content = { type: string; text?: string; mimeType?: string }[];
let client: Client;
let store: WorkspaceStore;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const content = r.content as Content;
  return { content, isError: Boolean(r.isError), text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
};

beforeAll(async () => {
  const resolver = createResolver({ pubchem: null });
  store = new WorkspaceStore(createInitialWorkspace(), resolver);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ store, resolver, host: '127.0.0.1', port: 8140 }).connect(a);
  client = new Client({ name: 't', version: '0' });
  await client.connect(b);
});

describe('edit tools', () => {
  test('edit_molecule applies ops and returns the new atom list', async () => {
    await call('lookup_chemical', { query: 'ethanol' });
    const r = await call('edit_molecule', { ops: [{ op: 'replace_group', index: 3, group: 'NH2' }] });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/C2H7N/);
    expect(r.text).toMatch(/Atoms \(1-based, heavy first\): 1:C 2:C 3:N/);
    expect(r.content.some((c) => c.type === 'image')).toBe(true);
  });
  test('rejected edits are isError with the reason and the unchanged atom list', async () => {
    const before = store.get().version;
    const r = await call('edit_molecule', { ops: [{ op: 'add_atom', element: 'Cl', bondTo: 42 }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Atom 42 does not exist/);
    expect(r.text).toMatch(/"atoms"/);
    expect(store.get().version).toBe(before);
  });
  test('set_view merges fields and accumulates rotation', async () => {
    const r = await call('set_view', { style: 'spacefill', highlight: [1, 3], rotate: { axis: 'y', degrees: 90 } });
    expect(r.isError).toBe(false);
    expect(r.content.some((c) => c.type === 'image')).toBe(true);
    expect(store.activeScene().view).toMatchObject({ style: 'spacefill', highlight: [1, 3], camera: { rotation: [0, 90, 0] } });
    await call('set_view', { rotate: { axis: 'y', degrees: 45 }, preset: 'top' });
    expect(store.activeScene().view.camera).toEqual({ preset: 'top', rotation: [0, 135, 0] });
  });
  test('undo and redo', async () => {
    const u = await call('undo');
    expect(u.text).toMatch(/Undid.*Ethanol/);
    expect(store.focused().formula).toBe('C2H6O');
    const r = await call('redo');
    expect(r.text).toMatch(/Redid/);
    expect(store.focused().formula).toBe('C2H7N');
    await call('redo');
    expect((await call('redo')).isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test server/mcp-edit.test.ts`
Expected: FAIL: tool `edit_molecule` not found.

- [ ] **Step 3: Add the tools**

In `server/mcp.ts`, add `import { EditOpSchema } from './schemas';` and, inside `createMcpServer` before `return server;`, register:

```ts
  server.registerTool('edit_molecule', {
    title: 'Edit the molecule',
    description: 'Apply atom-level edits to the focused molecule. Atom numbers come from the most recent result (call get_current to re-read them). Ops: add_atom {element, bondTo, order?}, remove_atom {index}, set_element {index, element}, set_charge {index, charge}, add_bond {a, b, order?}, remove_bond {a, b}, set_bond_order {a, b, order}, attach_group {index, group}, replace_group {index, group} where index is a hydrogen or a leaf atom. Named groups: H OH NH2 CH3 C2H5 COOH CHO CN NO2 SO3H OCH3 SH F Cl Br I phenyl, or any SMILES fragment. Hydrogens are re-saturated automatically. A rejected edit leaves the molecule unchanged.',
    inputSchema: { ops: z.array(EditOpSchema).min(1), name: z.string().optional().describe('Display name for the result.') },
  }, (args) => run(async () => {
    const result = await store.dispatch({ type: 'edit', ops: args.ops, name: args.name }, 'mcp');
    const scene = store.scene(result.sceneId);
    const species = store.focused(scene.id);
    return { content: [text(`${result.message}\n${speciesText(species, deps, scene)}`), json({ ...stateJson(), speciesId: species.id }), await image(species.svg2dNumbered, 480)] };
  }));

  server.registerTool('set_view', {
    title: 'Change the 3D view',
    description: 'Style, labels, highlighted atoms, spin, hydrogens, dipole arrow, camera preset, or a relative rotation. Returns a 3D image of the result.',
    inputSchema: {
      style: z.enum(['ballstick', 'stick', 'spacefill', 'wireframe']).optional(),
      labels: z.enum(['none', 'element', 'index']).optional(),
      highlight: z.array(z.number().int().min(1)).optional().describe('Atom numbers to highlight; [] clears.'),
      spin: z.boolean().optional(),
      showHydrogens: z.boolean().optional(),
      showDipole: z.boolean().optional(),
      preset: z.enum(['fit', 'front', 'top', 'side']).optional(),
      rotate: z.object({ axis: z.enum(['x', 'y', 'z']), degrees: z.number() }).optional().describe('Rotate relative to the current view.'),
      width: widthArg,
    },
  }, (args) => run(async () => {
    const scene = store.activeScene();
    const { preset, rotate, width, ...fields } = args;
    const rotation: [number, number, number] = [...scene.view.camera.rotation];
    if (rotate) rotation[{ x: 0, y: 1, z: 2 }[rotate.axis]] += rotate.degrees;
    const camera = preset || rotate ? { preset: preset ?? scene.view.camera.preset, rotation } : undefined;
    await store.dispatch({ type: 'set_view', view: { ...fields, ...(camera ? { camera } : {}) } }, 'mcp');
    const species = store.focused(scene.id);
    const bytes = await render3dPng(deps, store.activeScene(), species, width);
    return { content: [text(`View updated: ${JSON.stringify(store.activeScene().view)}`), { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' }] };
  }));

  for (const kind of ['undo', 'redo'] as const) {
    server.registerTool(kind, { title: kind === 'undo' ? 'Undo' : 'Redo', description: `${kind === 'undo' ? 'Undo' : 'Redo'} the last structural change in the active scene. View changes are not part of history.`, inputSchema: {} }, () => run(async () => {
      const result = await store.dispatch({ type: kind }, 'mcp');
      const species = store.focused(result.sceneId);
      return { content: [text(`${result.message}\n${speciesText(species, deps, store.scene(result.sceneId))}`), json({ ...stateJson(), speciesId: species.id })] };
    }));
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test server/mcp-edit.test.ts server/mcp.test.ts`
Expected: all pass.

- [ ] **Step 5: Try it from Claude Code**

With the server running (`bun run start` after `bun run build`) and `chemtool` registered, ask Claude Code: "Load ethanol in chemtool, replace the OH with an amine, highlight the nitrogen, rotate the view 90 degrees about y, then undo the edit." Expected: the window shows ethylamine with the nitrogen glowing, rotates, then returns to ethanol; every tool call returns an image.

- [ ] **Step 6: Commit**

```bash
git add server/mcp.ts server/mcp-edit.test.ts
git commit -m "feat(chem-tool): MCP edit, view, undo and redo tools" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QiWkMqG7iGFc1gM4UJChdf" -- server/mcp.ts server/mcp-edit.test.ts
```

---

### Task 18: Sketcher with two-way sync, undo/redo in the window

**Files:**
- Create: `src/client/sketchSync.ts`, `src/client/components/Sketch.tsx`
- Modify: `src/client/commands.ts` (add `undo`, `redo`, `edit`), `src/client/components/SidePanel.tsx` (Sketch tab), `src/client/App.tsx` (undo/redo buttons and keyboard shortcuts), `src/client/styles.css`
- Test: `src/client/sketchSync.test.ts`

**Interfaces:**
- Consumes: OpenChemLib `CanvasEditor` (`new CanvasEditor(element, { initialMode: 'molecule' })`, `setMolecule`, `getMolecule`, `setOnChangeListener(({ type, isUserEvent }) => ...)`, `destroy`); `setStructure` (Task 12); `windowId`, `lastActor` from the store.
- Produces: `shouldResetEditor(actor: string | null, ownWindowId: string, editorIdCode: string | null, incomingIdCode: string): boolean`; `<Sketch species />`; `undo()`, `redo()`, `edit(ops, baseVersion?)` command helpers.
- Sync rule: a user change is debounced 300 ms, then sent as `set_structure` with the molfile and the store's current version. Incoming state resets the editor only when it came from another actor **and** the molecule differs (compared by OpenChemLib ID code, which is equal for the same molecule regardless of source). A 409 from a stale version shows a toast and the editor takes the server's molecule.

- [ ] **Step 1: Write the failing test**

`src/client/sketchSync.test.ts`:

```ts
import { expect, test } from 'vitest';
import { shouldResetEditor } from './sketchSync';

test('editor is reset only for foreign changes to a different molecule', () => {
  expect(shouldResetEditor('window:me', 'me', 'idA', 'idB')).toBe(false);   // my own echo, never reset
  expect(shouldResetEditor('mcp', 'me', 'idA', 'idA')).toBe(false);         // same molecule already shown
  expect(shouldResetEditor('mcp', 'me', 'idA', 'idB')).toBe(true);          // Claude changed it
  expect(shouldResetEditor('window:other', 'me', 'idA', 'idB')).toBe(true); // another window changed it
  expect(shouldResetEditor(null, 'me', null, 'idB')).toBe(true);            // first state, empty editor
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/client/sketchSync.test.ts`
Expected: FAIL, cannot resolve `./sketchSync`.

- [ ] **Step 3: Write the sync rule, the component, and the command helpers**

`src/client/sketchSync.ts`:

```ts
/** Whether the sketcher must be reset to the incoming molecule. Our own pushes never reset it. */
export function shouldResetEditor(actor: string | null, ownWindowId: string, editorIdCode: string | null, incomingIdCode: string): boolean {
  if (actor === `window:${ownWindowId}`) return false;
  if (editorIdCode === incomingIdCode) return false;
  return true;
}
```

`src/client/components/Sketch.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import type { Species } from '../../chem/types';
import { setStructure } from '../commands';
import { shouldResetEditor } from '../sketchSync';
import { useStore } from '../store';
import { windowId } from '../ws';

type OCL = typeof import('openchemlib');
type Editor = InstanceType<OCL['CanvasEditor']>;
type Molecule = InstanceType<OCL['Molecule']>;

/** Canonical ID code without explicit hydrogens, so drawings and server molecules compare equal. */
function idCodeOf(mol: Molecule): string {
  const c = mol.getCompactCopy();
  let heavy = 0;
  for (let i = 0; i < c.getAllAtoms(); i++) if (c.getAtomicNo(i) !== 1) heavy++;
  if (heavy > 0) c.removeExplicitHydrogens();
  return c.getIDCode();
}

export function Sketch({ species }: { species: Species }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const ocl = useRef<OCL | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPushed = useRef<string | null>(null);
  const lastActor = useStore((s) => s.lastActor);
  const version = useStore((s) => s.workspace?.version ?? 0);
  const versionRef = useRef(version);
  versionRef.current = version;
  const speciesRef = useRef(species);
  speciesRef.current = species;

  useEffect(() => {
    let alive = true;
    import('openchemlib').then((m) => {
      if (!alive || !host.current) return;
      ocl.current = m;
      const ed = new m.CanvasEditor(host.current, { initialMode: 'molecule' });
      editor.current = ed;
      ed.setMolecule(m.Molecule.fromMolfile(speciesRef.current.molfile2d));
      ed.setOnChangeListener((ev) => {
        if (!ev.isUserEvent) return;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          const mol = ed.getMolecule();
          if (mol.getAllAtoms() === 0) return;
          const id = idCodeOf(mol);
          if (id === lastPushed.current || id === idCodeOf(m.Molecule.fromMolfile(speciesRef.current.molfile2d))) return;
          lastPushed.current = id;
          setStructure(mol.toMolfile(), versionRef.current).catch((err: Error) => {
            useStore.getState().showToast(`${err.message}. Your last stroke was discarded.`);
            ed.setMolecule(m.Molecule.fromMolfile(speciesRef.current.molfile2d));
          });
        }, 300);
      });
    });
    return () => { alive = false; if (timer.current) clearTimeout(timer.current); editor.current?.destroy(); editor.current = null; };
  }, []);

  useEffect(() => {
    const ed = editor.current;
    const m = ocl.current;
    if (!ed || !m) return;
    const incoming = m.Molecule.fromMolfile(species.molfile2d);
    if (shouldResetEditor(lastActor, windowId, idCodeOf(ed.getMolecule()), idCodeOf(incoming))) ed.setMolecule(incoming);
  }, [species.id, lastActor]);

  return (
    <div className="sketch">
      <div ref={host} className="sketch-host" />
      <p className="muted small">Draw or change the molecule. Changes reach the server after 300 ms and every connected AI sees them.</p>
    </div>
  );
}
```

Add to `src/client/commands.ts`:

```ts
import type { EditOpInput } from '../../server/schemas';
export const undo = () => sendCommand({ type: 'undo' }).catch(report);
export const redo = () => sendCommand({ type: 'redo' }).catch(report);
export const edit = (ops: EditOpInput[], baseVersion?: number) => sendCommand({ type: 'edit', ops, baseVersion });
```

In `src/client/components/SidePanel.tsx`: add `import { Sketch } from './Sketch';`, add `{ id: 'sketch', label: 'Sketch' }` to `TABS` between 2D and Info, and `{panel === 'sketch' && <Sketch species={species} />}` in the body.

In `src/client/App.tsx`:

- Add `import { load, redo, undo } from './commands';` (replacing the existing `load` import).
- After `<SceneTabs />` add:
  ```tsx
  <div className="history">
    <button className="tab" disabled={scene.history.past.length === 0} onClick={() => undo()} title="Undo (Ctrl+Z)">↶</button>
    <button className="tab" disabled={scene.history.future.length === 0} onClick={() => redo()} title="Redo (Ctrl+Y)">↷</button>
  </div>
  ```
- Add a keyboard effect:
  ```tsx
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest('.sketch-host'))) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  ```

Append to `src/client/styles.css`:

```css
.sketch-host { height: 440px; border: 1px solid var(--line); border-radius: 6px; background: white; }
.history { display: flex; gap: 4px; }
.history button:disabled { opacity: 0.4; cursor: default; }
```

- [ ] **Step 4: Run the tests, typecheck, and verify by hand**

Run: `bun run test src/client && bun run typecheck`
Expected: pass. If `CanvasEditor`'s change event type has no `isUserEvent` in your installed version's `.d.ts`, check `node_modules/openchemlib/dist/openchemlib.d.ts` for `OnChangeEvent` and use the field it declares.

Run `bun run dev:server` and `bun run dev`, open the window, load `ethanol`, open the Sketch tab:

- The editor shows ethanol. Change the O to N with the editor's atom tool. Within a second the 3D view shows ethylamine, the Info tab says C2H7N, and the status bar shows v+1 with no "updated by AI" text. The editor is not reset (your cursor and zoom stay).
- From a terminal: `curl -s -X POST http://127.0.0.1:8140/api/command -H "content-type: application/json" -d "{\"type\":\"load\",\"query\":\"benzene\"}"`. The editor switches to benzene.
- Click ↶: the workspace returns to ethylamine and the editor follows. Ctrl+Y redoes.
- Open a second browser tab on the same URL; draw in one; the other's editor and 3D view follow.
- Open the devtools Network tab and confirm the openchemlib chunk loads only when the Sketch tab is first opened.

- [ ] **Step 5: Commit**

```bash
git add src/client/sketchSync.ts src/client/sketchSync.test.ts src/client/components/Sketch.tsx src/client/components/SidePanel.tsx src/client/commands.ts src/client/App.tsx src/client/styles.css
git commit -m "feat(chem-tool): sketcher with two-way sync, undo and redo in the window" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QiWkMqG7iGFc1gM4UJChdf" -- src/client/sketchSync.ts src/client/sketchSync.test.ts src/client/components/Sketch.tsx src/client/components/SidePanel.tsx src/client/commands.ts src/client/App.tsx src/client/styles.css
```

---

### Task 19: Live WebGL snapshots

**Files:**
- Create: `server/snapshots.ts`
- Modify: `server/app.ts` (`snapshots?: SnapshotBroker` in `AppDeps`), `server/index.ts` (create the broker, wire `onWindowMessage`), `server/mcp.ts` (`render3dPng` asks the broker first), `server/api.ts` (`/snapshot.png` asks the broker first), `src/client/components/Viewer3D.tsx` (answer `snapshot_request`)
- Test: `server/snapshots.test.ts`

**Interfaces:**
- Produces: `class SnapshotBroker { constructor(windows: () => { send(msg: unknown): void }[], timeoutMs = 3000); request(sceneId, width, height): Promise<Uint8Array | null>; resolve(id, pngBase64: string | null): boolean }`. `render3dPng` now returns `{ bytes: Uint8Array; live: boolean }`; a `style` override in `render_3d` forces the software renderer because the window renders its own current view.
- Protocol: server sends `{ type: 'snapshot_request', id, sceneId, width, height }` to every window; the first `{ type: 'snapshot_response', id, pngBase64 }` wins; no answer within 3 s means the software renderer answers.

- [ ] **Step 1: Write the failing test**

`server/snapshots.test.ts`:

```ts
import { expect, test } from 'vitest';
import { SnapshotBroker } from './snapshots';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

test('no windows: null at once', async () => {
  const broker = new SnapshotBroker(() => [], 50);
  expect(await broker.request('s', 100, 75)).toBeNull();
});

test('first window answer wins; unknown ids are ignored', async () => {
  const sent: { type: string; id: string }[] = [];
  const broker = new SnapshotBroker(() => [{ send: (m) => sent.push(m as { type: string; id: string }) }], 500);
  const p = broker.request('s', 100, 75);
  expect(sent[0].type).toBe('snapshot_request');
  expect(broker.resolve('nope', PNG)).toBe(false);
  expect(broker.resolve(sent[0].id, PNG)).toBe(true);
  expect(broker.resolve(sent[0].id, PNG)).toBe(false);
  expect(Array.from((await p)!)).toEqual([0x89, 0x50, 0x4e, 0x47]);
});

test('silent window: null after the timeout', async () => {
  const broker = new SnapshotBroker(() => [{ send: () => {} }], 30);
  expect(await broker.request('s', 100, 75)).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test server/snapshots.test.ts`
Expected: FAIL, cannot resolve `./snapshots`.

- [ ] **Step 3: Write the broker and wire it**

`server/snapshots.ts`:

```ts
// Asks connected windows for a WebGL snapshot; the first answer wins, silence means fallback.

import { newId } from '../src/chem/species';

export interface SnapshotTarget { send(msg: unknown): void }

export class SnapshotBroker {
  private readonly pending = new Map<string, { resolve: (png: Uint8Array | null) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly windows: () => SnapshotTarget[], private readonly timeoutMs = 3000) {}

  request(sceneId: string, width: number, height: number): Promise<Uint8Array | null> {
    const targets = this.windows();
    if (targets.length === 0) return Promise.resolve(null);
    const id = newId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      for (const w of targets) w.send({ type: 'snapshot_request', id, sceneId, width, height });
    });
  }

  resolve(id: string, pngBase64: string | null): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(pngBase64 ? new Uint8Array(Buffer.from(pngBase64, 'base64')) : null);
    return true;
  }
}
```

`server/app.ts`: add `import type { SnapshotBroker } from './snapshots';` and `snapshots?: SnapshotBroker;` to `AppDeps`.

`server/index.ts`: replace the `createApp` line with:

```ts
import { SnapshotBroker } from './snapshots';
import type { WsRegistry } from './ws';

let registry: WsRegistry | null = null;
const snapshots = new SnapshotBroker(() => registry ? [...registry.clients.keys()].map((ws) => ({ send: (m: unknown) => { try { ws.send(JSON.stringify(m)); } catch { /* gone */ } } })) : []);
const { app, ws } = createApp({
  store, resolver, staticDir: config.staticDir, upgradeWebSocket, host: config.host, port: config.port, snapshots,
  onWindowMessage: (msg) => { if (msg.type === 'snapshot_response') snapshots.resolve(String(msg.id), typeof msg.pngBase64 === 'string' ? msg.pngBase64 : null); },
});
registry = ws;
```

(move the two imports to the top of the file with the others).

`server/mcp.ts`: replace `render3dPng` with:

```ts
/** 3D PNG: the live window's WebGL view when one answers, otherwise the software renderer. */
export async function render3dPng(deps: AppDeps, scene: Scene, species: Species, width: number, style?: ViewState['style']): Promise<{ bytes: Uint8Array; live: boolean }> {
  if (deps.snapshots && !style && scene.id === deps.store.get().activeSceneId && species.id === scene.focusId) {
    const live = await deps.snapshots.request(scene.id, width, Math.round(width * 0.75));
    if (live) return { bytes: live, live: true };
  }
  const [rx, ry, rz] = scene.view.camera.rotation;
  const svg = renderSnapshotSvg(species.atoms, species.bonds, {
    width, height: Math.round(width * 0.75), style: style ?? scene.view.style, showHydrogens: scene.view.showHydrogens,
    highlight: scene.view.highlight, rotation: [20 + rx, 30 + ry, rz],
  });
  return { bytes: await svgToPng(svg, width), live: false };
}
```

and update its two callers: in `render_3d` use `const { bytes, live } = await render3dPng(...)` and the text `3D view of ${describe(species)} (${live ? 'live window' : 'software renderer'})`; in `set_view` use `const { bytes } = await render3dPng(...)`.

`server/api.ts`: in `/snapshot.png`, before building the SVG, add:

```ts
    if (deps.snapshots) {
      const live = await deps.snapshots.request(scene.id, width, Number(c.req.query('h') ?? Math.round(width * 0.75)));
      if (live) return png(live);
    }
```

`src/client/components/Viewer3D.tsx`: add `import { extraHandlers, sendRaw } from '../ws';` and, at module scope after `snapshotProvider` is declared:

```ts
extraHandlers.push((msg) => {
  if (msg.type !== 'snapshot_request') return;
  const url = snapshotProvider?.() ?? null;
  sendRaw({ type: 'snapshot_response', id: msg.id, pngBase64: url ? url.split(',')[1] : null });
});
```

- [ ] **Step 4: Run the tests and verify live snapshots**

Run: `bun run test && bun run typecheck`
Expected: every test file passes; typecheck clean.

Run `bun run build && bun run start`, open the window, rotate caffeine to an unusual angle with the mouse. In Claude Code ask: "Render the current chemtool molecule in 3D." Expected: the image Claude receives is exactly the window's view, and the tool text says "live window". Close the browser tab and ask again: the text says "software renderer" and the image is the plain projection. Then open the window again and run `curl -s -o snap.png http://127.0.0.1:8140/api/snapshot.png` and open `snap.png`: it matches the window.

- [ ] **Step 5: Commit**

```bash
git add server/snapshots.ts server/snapshots.test.ts server/app.ts server/index.ts server/mcp.ts server/api.ts src/client/components/Viewer3D.tsx
git commit -m "feat(chem-tool): live WebGL snapshots for MCP and REST" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01QiWkMqG7iGFc1gM4UJChdf" -- server/snapshots.ts server/snapshots.test.ts server/app.ts server/index.ts server/mcp.ts server/api.ts src/client/components/Viewer3D.tsx
```

Phase 2 is complete: atom-level edits from MCP, the sketcher and the AI editing the same molecule, undo and redo, view commands, and live snapshots.

---

## Spec coverage check (phases 1 and 2)

| Spec section | Where |
|---|---|
| 4.1 stack, 4.2 env vars | Tasks 1, 10 |
| 5 data model, atom numbering, persistence | Tasks 1, 3, 4, 9 |
| 6 command layer, edit ops, valence errors, version conflicts, broadcast | Tasks 9, 15, 16 |
| 7 elements, formula, library, pubchem, resolve, structure, edit, render3d, png | Tasks 1 to 8, 15 |
| 7 lewis, lewis-svg, vsepr, polarity, reaction | Phase 3 and 4 plans (types reserved in Task 1) |
| 8 library build script, 400 entries | Phase 5 plan (Task 5 seeds about 120 with SMILES so lookups work offline now) |
| 9.2 REST | Task 10 (`/tunnel`, `/token/regenerate` are phase 6; `/openapi.json` is phase 6) |
| 9.3 WebSocket | Tasks 10, 19 |
| 9.4 MCP tools | Tasks 11, 17 (`show_reaction`, `focus_species`, `analyze`, `balance_equation` are phases 3 and 4) |
| 9.5 stdio proxy, 9.6 tunnel, 9.7 full snippets | Phase 6 plan; Task 14 ships the Claude Code snippet |
| 10 window layout, sync rule, lazy chunks, URL parameters | Tasks 12, 13, 14, 18 |
| 12 error handling | Tasks 7, 9, 10, 12, 18 |
| 13 tests | every task |

Known deviations from the spec, all deliberate: `displayFormula` added to `Species`; `geometry` added to `Species` to mark star and flat fallbacks; hydrogens re-saturated automatically instead of a `set_hydrogens` op; `new_scene` copies the focused species when no query is given because a scene always holds at least one species; the `focus` command also activates the scene that holds the species.

<!-- END OF PLAN -->

# 3D editor phase 4: high-fidelity part models — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The 3D editor draws the kit's chips, 7-way DIP switch, 5161BS display, resistors and LEDs with KiCad's real 3D bodies, recoloured to the kit, while legs and every live element stay code-drawn and the editor still works with no models.

**Architecture:** A hand-run build script exports each kit footprint from KiCad to GLB, strips the metal legs, normalises the model into the board's frame and records its pad positions in a manifest; the GLBs are committed under `public/models/`. Pure placement maths lives in `src/models/` and is unit-tested. At runtime `client/models.ts` loads the set once, `client/board3d-parts.ts` puts a model body where a part's pads are, and the workspace offers a Detail toggle that rebuilds with or without models.

**Tech Stack:** bun 1.3, TypeScript, three.js 0.185 (GLTFLoader + MeshoptDecoder), `@gltf-transform/core` / `functions` / `extensions` + `meshoptimizer` (MIT, dev only), KiCad 9 `kicad-cli` (dev only), headless-Chrome e2e in `scripts/e2e-3d.ts`.

**Spec:** `docs/superpowers/specs/2026-10-06-3d-high-fidelity-models-design.md`

## Global Constraints

- App in `circut-ai-tool/` (note the spelling) of the repo `C:\Users\rober\Desktop\university-tools`. Work on a branch `models3d` in a worktree `.worktrees/models3d` created from `main`.
- Conventional commits; **never** add `Co-Authored-By: Claude` or "Generated with Claude Code" lines.
- Other sessions edit `main` in parallel (e.g. `src/sim/*`): commit only the files your task touches.
- Kit parts and their KiCad footprints (exact keys used everywhere):
  - `dip14` → `Package_DIP:DIP-14_W7.62mm`
  - `dip16` → `Package_DIP:DIP-16_W7.62mm`
  - `dipswitch7` → `Button_Switch_THT:SW_DIP_SPSTx07_Slide_9.78x19.96mm_W7.62mm_P2.54mm`
  - `seg056` → `Display_7Segment:7SegmentLED_LTS6760_LTS6780` (spec said CA56-12EWA, which is a 4-digit part; corrected)
  - `led5` → `LED_THT:LED_D5.0mm`
  - `r0207` → `Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal`
- Models are committed; neither `bun test`, `bun run build` nor Docker may need KiCad. Only `bun run models` does.
- 1 mm = `MM` board units (`client/board3d-parts.ts:28`, `P / 2.54`, P = 18). The board frame is x along a row, y up (`TOP = 0` is the board surface), z across rows (larger z = rows further down the board, i.e. `ROWY` order).
- Fallback is never an error: a missing manifest, missing file or unknown key logs one `console.warn` and the part is drawn exactly as before.
- Models are CC-BY-SA 4.0; `public/models/LICENSE-KiCad-3D.md` carries the attribution.
- After every task: `bun run typecheck` and `bun test` clean; from Task 4 on also `bun run build && bun scripts/e2e-3d.ts` (all scenarios; Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe`; never two e2e runs at once — fixed ports).

## Review Focus

1. **A part placed rotated or mirrored** (a chip whose notch ends up at the wrong end, an LED flat on the wrong side): the body must follow pad 1 → pad 2 on the board. → Task 1 test `bodyPlacement turns the model to follow pad 1 → pad 2`, Task 2 self-check `chooseFrame` test.
2. **A resistor whose holes are not 10.16 mm apart** (lab 6's pull-ups): the body must sit centred between the holes, not anchored to one hole. → Task 1 test `a resistor body centres between its holes whatever their spacing`.
3. **Re-exporting with a different KiCad install** (axes or units differ): the script must refuse rather than write a wrongly oriented model. → Task 2 test `chooseFrame refuses when no frame matches the pads`.
4. **Switching Detail while a part is selected or a Show group is on**: the selection and fading must survive the rebuild. → Task 5 e2e `Detail toggle keeps the selection and the Show filter`.
5. **A model that fails to load** (404, corrupt file): the editor opens and that part is the old shape. → Task 5 e2e `a missing model falls back`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/models/manifest.ts` (create) | Pure: manifest types and validation, kit key for a part, leg-material rule, frame choice, body placement maths. |
| `scripts/build-models.ts` (create) | Hand-run pipeline: kicad-cli export → strip legs → normalise frame → compress → write GLB + manifest. |
| `public/models/*.glb`, `manifest.json`, `LICENSE-KiCad-3D.md` (create, generated) | Committed assets. |
| `client/models.ts` (create) | Load the manifest and GLBs once; `ModelSet`. |
| `client/board3d-parts.ts` (modify) | `buildPackage` / `buildPart` take an optional `ModelSet` and use model bodies for kit parts. |
| `client/board3d.ts` (modify) | `Board3DOptions.models`, `Board3D.setModels(models)` (rebuild with or without). |
| `client/editor3d/workspace.ts` (modify) | Load models before mounting; Detail toggle; e2e hooks. |
| `test/models-manifest.test.ts`, `test/models-assets.test.ts` (create) | Unit tests. |
| `docs/editor3d.md`, `README.md` (modify) | Docs. |

---

### Task 1: Pure model maths (`src/models/manifest.ts`)

**Files:** Create `src/models/manifest.ts`, `test/models-manifest.test.ts`.

**Interfaces — Produces:**
```ts
export type ModelKey = 'dip14' | 'dip16' | 'dipswitch7' | 'seg056' | 'led5' | 'r0207';
export const KIT_MODELS: Record<ModelKey, { footprint: string }>;   // the table in Global Constraints
export interface ModelInfo {
  file: string;                 // e.g. "dip14.glb"
  footprint: string;
  /** Pad positions in the model's own frame, millimetres, [x, z] (y is up). */
  pads: Record<string, [number, number]>;
  /** Bounding box of the leg-free body, millimetres, in the model frame. */
  box: { min: [number, number, number]; max: [number, number, number] };
}
export interface Manifest { version: 1; models: Partial<Record<ModelKey, ModelInfo>> }
export function validateManifest(x: unknown): Manifest;              // throws Error naming the bad field
export function modelKeyFor(kind: string, style: string | undefined, pins: number, positions?: number): ModelKey | null;
export function isLegMaterial(m: { color: [number, number, number]; metallic?: number }): boolean;
export type Frame = 'identity' | 'flipZ' | 'flipX' | 'rot180';
export function applyFrame(f: Frame, p: [number, number]): [number, number];
export function chooseFrame(found: Record<string, [number, number]>, expected: Record<string, [number, number]>, tol?: number): Frame;  // throws when none fits
export function bodyPlacement(info: ModelInfo, padA: string, padB: string, holeA: [number, number], holeB: [number, number], mm: number): { x: number; z: number; rotationY: number };
```

Rules:
- `modelKeyFor`: `('dip', _, 14) → 'dip14'`, `('dip', _, 16) → 'dip16'`, `('dipswitch', _, _, 7) → 'dipswitch7'`, `('sevenseg', _, _) → 'seg056'`, `('lead2', 'LED') → 'led5'`, `('lead2', 'R') → 'r0207'`, anything else `null`.
- `isLegMaterial`: true when `metallic >= 0.5`, or when the colour is light and grey: max channel ≥ 0.45 and (max − min) / max ≤ 0.15. (KiCad's DIP export: body `[0.019, 0.018, 0.018]` → false; legs `[0.645, 0.638, 0.572]` → true.)
- `applyFrame`: identity `[x,z]`, flipZ `[x,-z]`, flipX `[-x,z]`, rot180 `[-x,-z]`.
- `chooseFrame`: return the first frame for which every `expected` pad, after `applyFrame`, lies within `tol` (default 0.3 mm) of `found[pad]`; throw `Error('no frame fits the pads: …')` otherwise.
- `bodyPlacement`: the model's pad A→B direction is turned onto the board's hole A→B direction (rotation about y), and the midpoint of pads A and B (scaled by `mm`, rotated) lands on the midpoint of holes A and B. Returns the model origin's board position `x, z` and `rotationY` (radians). Midpoint, not pad A, so a resistor whose holes are further apart or closer than its pads is centred.

- [ ] **Step 1: Write the failing tests** (`test/models-manifest.test.ts`)

```ts
import { describe, expect, test } from 'bun:test';
import { applyFrame, bodyPlacement, chooseFrame, isLegMaterial, KIT_MODELS, modelKeyFor, validateManifest, type ModelInfo } from '../src/models/manifest.ts';

const info = (pads: Record<string, [number, number]>): ModelInfo => ({ file: 'x.glb', footprint: 'X', pads, box: { min: [0, 0, 0], max: [1, 1, 1] } });
const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);

describe('model keys', () => {
  test('kit parts map to their models; other parts to none', () => {
    expect(modelKeyFor('dip', undefined, 14)).toBe('dip14');
    expect(modelKeyFor('dip', undefined, 16)).toBe('dip16');
    expect(modelKeyFor('dipswitch', undefined, 14, 7)).toBe('dipswitch7');
    expect(modelKeyFor('sevenseg', undefined, 10)).toBe('seg056');
    expect(modelKeyFor('lead2', 'LED', 2)).toBe('led5');
    expect(modelKeyFor('lead2', 'R', 2)).toBe('r0207');
    expect(modelKeyFor('lead2', 'C', 2)).toBeNull();
    expect(modelKeyFor('dip', undefined, 8)).toBeNull();
    expect(Object.keys(KIT_MODELS).sort()).toEqual(['dip14', 'dip16', 'dipswitch7', 'led5', 'r0207', 'seg056']);
  });
});

describe('leg material', () => {
  test('the dark body is kept and the light metal is a leg', () => {
    expect(isLegMaterial({ color: [0.019, 0.018, 0.018] })).toBe(false);
    expect(isLegMaterial({ color: [0.645, 0.638, 0.572] })).toBe(true);
    expect(isLegMaterial({ color: [0.2, 0.2, 0.2], metallic: 0.9 })).toBe(true);
  });
  test('a coloured body (tan resistor, red switch, LED dome) is not a leg', () => {
    expect(isLegMaterial({ color: [0.85, 0.75, 0.55] })).toBe(false);
    expect(isLegMaterial({ color: [0.75, 0.1, 0.1] })).toBe(false);
  });
});

describe('frames', () => {
  test('chooseFrame finds the frame that puts the pads where the footprint says', () => {
    const expected = { '1': [0, 0] as [number, number], '2': [0, 2.54] as [number, number], '8': [7.62, 15.24] as [number, number] };
    const found = { '1': [0, 0] as [number, number], '2': [0, -2.54] as [number, number], '8': [7.62, -15.24] as [number, number] };
    expect(chooseFrame(found, expected)).toBe('flipZ');
    expect(applyFrame('flipZ', [7.62, 15.24])).toEqual([7.62, -15.24]);
  });
  test('chooseFrame refuses when no frame matches the pads', () => {
    expect(() => chooseFrame({ '1': [0, 0], '2': [5, 5] }, { '1': [0, 0], '2': [0, 2.54] })).toThrow(/no frame fits/);
  });
});

describe('bodyPlacement', () => {
  test('bodyPlacement turns the model to follow pad 1 → pad 2', () => {
    // Model pads along +z; board holes along +x: a quarter turn.
    // Pads away from the origin, so landing on the holes is a real check.
    const p = bodyPlacement(info({ '1': [1, 1], '2': [1, 3.54] }), '1', '2', [100, 50], [100 + 2.54 * 7, 50], 7);
    close(Math.abs(p.rotationY), Math.PI / 2);
    // three.js turns (x, z) about +y by θ to (x cosθ + z sinθ, −x sinθ + z cosθ).
    const c = Math.cos(p.rotationY), s = Math.sin(p.rotationY);
    const land = ([x, z]: [number, number]) => [p.x + (x * c + z * s) * 7, p.z + (-x * s + z * c) * 7];
    const [x1, z1] = land([1, 1]);
    const [x2, z2] = land([1, 3.54]);
    close(x1, 100);
    close(z1, 50);
    close(x2, 100 + 2.54 * 7);
    close(z2, 50);
  });
  test('a resistor body centres between its holes whatever their spacing', () => {
    const r = info({ '1': [0, 0], '2': [10.16, 0] });
    const p = bodyPlacement(r, '1', '2', [0, 0], [200, 0], 7);
    // The pads' midpoint (5.08 mm → 35.56 units) sits on the holes' midpoint (100).
    close(p.x + 5.08 * 7, 100);
    close(p.rotationY, 0);
  });
});

describe('validateManifest', () => {
  test('accepts a well-formed manifest and names the bad field otherwise', () => {
    const ok = { version: 1, models: { dip14: { file: 'dip14.glb', footprint: 'Package_DIP:DIP-14_W7.62mm', pads: { '1': [0, 0], '2': [0, 2.54] }, box: { min: [0, 0, 0], max: [1, 1, 1] } } } };
    expect(validateManifest(ok).models.dip14?.file).toBe('dip14.glb');
    expect(() => validateManifest({ version: 2, models: {} })).toThrow(/version/);
    expect(() => validateManifest({ version: 1, models: { dip14: { file: 3 } } })).toThrow(/dip14/);
    expect(() => validateManifest({ version: 1, models: { nope: ok.models.dip14 } })).toThrow(/nope/);
  });
});
```

- [ ] **Step 2: Run** `bun test test/models-manifest.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `src/models/manifest.ts` with exactly the interfaces above. `bodyPlacement` maths: let `a = pads[padA]`, `b = pads[padB]` (mm, model frame), `ha`, `hb` board holes. `angleModel = atan2(b[1]-a[1], b[0]-a[0])`, `angleBoard = atan2(hb[1]-ha[1], hb[0]-ha[0])`. three.js rotates a point `(x, z)` about +y by θ to `(x cosθ + z sinθ, −x sinθ + z cosθ)`, so the angle of a direction changes by −θ: `rotationY = angleModel − angleBoard`. Model midpoint `m = (a+b)/2` scaled by `mm` and rotated gives `m'`; board midpoint `h = (ha+hb)/2`; result `x = h.x − m'.x`, `z = h.z − m'.z`. The test uses the same rotation formula; both pads must land on their holes within 1e-6.

- [ ] **Step 4: Run** the test file, then `bun run typecheck && bun test` — PASS.

- [ ] **Step 5: Commit** `git add src/models/manifest.ts test/models-manifest.test.ts && git commit -m "feat(3d): pure maths for placing KiCad part models"`

---

### Task 2: The model build script and the committed models

**Files:** Create `scripts/build-models.ts`, `public/models/` (generated: six `.glb`, `manifest.json`), `public/models/LICENSE-KiCad-3D.md`, `test/models-assets.test.ts`. Modify `package.json` (script `"models": "bun scripts/build-models.ts"`, devDependencies `@gltf-transform/core`, `@gltf-transform/functions`, `@gltf-transform/extensions`, `meshoptimizer` at their current majors).

**Interfaces — Consumes:** `KIT_MODELS`, `isLegMaterial`, `chooseFrame`, `applyFrame`, `validateManifest`, `ModelInfo` (Task 1).

Script outline (write it in full; each numbered item is a function):
1. `padsOf(kicadModText): Record<string, [number, number]>` — every `(pad "N" … (at x y …))`, in mm, relative to the footprint origin, with **z = KiCad y** (so rows further down the board have larger z, matching the board frame).
2. `exportGlb(footprint, outDir): string` — copy the `.kicad_mod` from `${KICAD_FOOTPRINT_DIR}/<Lib>.pretty/<Name>.kicad_mod` into a scratch `.kicad_pcb` at `(at 100 100)` (template below), replacing `${KICAD9_3DMODEL_DIR}` with the models dir; run `kicad-cli pcb export glb --no-board-body --user-origin 100x100mm -f -o <out>.glb <board>`; throw with the footprint name and the CLI output on a non-zero exit. Defaults: `KICAD_CLI = C:/Users/rober/AppData/Local/Programs/KiCad/9.0/bin/kicad-cli.exe`, `KICAD_FOOTPRINT_DIR = …/9.0/share/kicad/footprints`, `KICAD_3DMODEL_DIR = …/9.0/share/kicad/3dmodels`, each overridable by env.

   ```ts
   const board = (fp: string) => `(kicad_pcb (version 20241229) (generator "benchmate-models") (generator_version "9.0")
    (general (thickness 1.6)) (paper "A4")
    (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user) (5 "F.SilkS" user) (1 "F.Mask" user) (3 "B.Mask" user) (31 "F.CrtYd" user) (35 "F.Fab" user) (7 "B.SilkS" user) (33 "B.CrtYd" user) (37 "B.Fab" user))
    (setup (pad_to_mask_clearance 0)) (net 0 "")
    ${fp})`;
   ```
   (The footprint text gets `(layer "F.Cu") (at 100 100)` inserted after its name, as the probe in the spec did.)
3. With gltf-transform (`NodeIO` registered with `ALL_EXTENSIONS` and `MeshoptEncoder`):
   - read the GLB; units are metres: multiply all positions by 1000 (mm) via a root scale transform then `flatten` + `dequantize`;
   - for each material decide `isLegMaterial({ color: baseColorFactor.rgb, metallic: metallicFactor })`;
   - **leg centroids**: group leg-material primitives into clusters by x/z proximity (≤ 0.8 mm); each cluster's centroid is a found pad; label found pads by nearest expected pad (from `padsOf`, pad 1 at the origin);
   - `frame = chooseFrame(found, expected)` — and apply that frame to the whole model (scale x and/or z by −1 and flip triangle winding via `reverse` of indices when exactly one axis is negated);
   - delete leg-material primitives; `join` + `weld` + `prune`; compute the remaining body's bounding box (mm);
   - write with `reorder` + `quantize` + `EXT_meshopt_compression` to `public/models/<key>.glb`.
4. Write `public/models/manifest.json` = `{ version: 1, models: { [key]: { file, footprint, pads: expected (padsOf), box } } }` and run `validateManifest` on it before writing.
5. Refuse to write anything if any part fails (collect into a temp dir, move on success).

- [ ] **Step 1: Failing asset test** `test/models-assets.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { KIT_MODELS, validateManifest } from '../src/models/manifest.ts';

const dir = new URL('../public/models/', import.meta.url);

describe('committed part models', () => {
  test('the manifest is valid and lists every kit model', () => {
    const m = validateManifest(JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')));
    expect(Object.keys(m.models).sort()).toEqual(Object.keys(KIT_MODELS).sort());
  });
  test('every listed model file exists, is a GLB and is small', () => {
    const m = validateManifest(JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')));
    for (const info of Object.values(m.models)) {
      const f = new URL(info!.file, dir);
      expect(existsSync(f)).toBe(true);
      expect(readFileSync(f).subarray(0, 4).toString()).toBe('glTF');
      expect(statSync(f).size).toBeLessThan(400_000);
    }
  });
  test('pad 1 is the origin and boxes are real bodies', () => {
    const m = validateManifest(JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')));
    for (const [key, info] of Object.entries(m.models)) {
      expect(info!.pads['1'], key).toEqual([0, 0]);
      const [x0, y0, z0] = info!.box.min, [x1, y1, z1] = info!.box.max;
      expect(x1 - x0 > 1 && y1 - y0 > 0.5 && z1 - z0 > 1, key).toBe(true);
    }
  });
  test('the KiCad license note ships with the models', () => {
    expect(readFileSync(new URL('LICENSE-KiCad-3D.md', dir), 'utf8')).toMatch(/CC-BY-SA 4\.0/);
  });
});
```

- [ ] **Step 2: Run** `bun test test/models-assets.test.ts` — FAIL (no manifest).
- [ ] **Step 3:** `bun add -d @gltf-transform/core @gltf-transform/functions @gltf-transform/extensions meshoptimizer`; write `scripts/build-models.ts`; add the `models` script; write `public/models/LICENSE-KiCad-3D.md`:

```md
# KiCad 3D models

The `.glb` files in this folder are converted from the KiCad 3D model library
(https://gitlab.com/kicad/libraries/kicad-packages3D), © the KiCad library
contributors, licensed under CC-BY-SA 4.0 with the KiCad libraries exception
(https://www.kicad.org/libraries/license/). The converted files keep that
license: the legs were removed, the models re-oriented and compressed by
`scripts/build-models.ts`. Regenerate with `bun run models`.
```

- [ ] **Step 4:** Run `bun run models` (needs the local KiCad 9). Then `bun test test/models-assets.test.ts` — PASS. Report each model's size and box in the task report. If `chooseFrame` throws for a part, do not loosen the tolerance silently: report the found vs expected pads.
- [ ] **Step 5:** `bun run typecheck && bun test`; commit `package.json`, `bun.lock`, the script, `public/models/*`, the test: `git commit -m "feat(3d): build and commit KiCad part models for the kit"`.

---

### Task 3: Loading models and the Board3D plumbing

**Files:** Create `client/models.ts`. Modify `client/board3d.ts` (`Board3DOptions`, `Board3D`, `build(doc)` calls at ~:487 and ~:500, `mount3d`), `client/board3d-parts.ts` (signatures only in this task).

**Interfaces — Produces:**
```ts
// client/models.ts
export interface ModelSet {
  readonly keys: ModelKey[];
  /** A fresh clone of the body (geometry shared), or null when the key is missing. */
  body(key: ModelKey): { object: THREE.Object3D; info: ModelInfo } | null;
}
export async function loadModels(base?: string, signal?: AbortSignal, drop?: ModelKey[]): Promise<ModelSet>;  // never rejects for a bad model: warns and leaves the key out
// client/board3d.ts
interface Board3DOptions { …; models?: ModelSet | null }
interface Board3D { …; setModels(models: ModelSet | null): void }   // rebuilds in place, keeping selection and highlight
// client/board3d-parts.ts
export function buildPackage(kit: Kit, pkg: Package, doc: LayoutDoc, models?: ModelSet | null): BuiltPackage;
export function buildPart(kit: Kit, part: PlacedPart, doc: LayoutDoc, models?: ModelSet | null): BuiltPart;
```

- `loadModels`: fetch `${base}manifest.json` (default `/models/`), `validateManifest`, then load every model in parallel with `GLTFLoader` + `loader.setMeshoptDecoder(MeshoptDecoder)` (`three/examples/jsm/loaders/GLTFLoader.js`, `three/examples/jsm/libs/meshopt_decoder.module.js`). A manifest failure resolves to an empty set with one warning. `drop` (test hook) leaves those keys out as if they failed.
- `body(key)`: `scene.clone(true)` (geometry shared); materials are shared too until a part tints them (the part clones the ones it changes).
- `setModels` stores the set and calls the existing `rebuild(c.doc)`; `build(doc)` passes the current set to `buildPackage` / `buildPart`. In this task the parts ignore it (Task 4 uses it), so behaviour is unchanged.

- [ ] **Step 1:** Write the code; there is no DOM-free unit test for GLTFLoader, so the test is the e2e in Task 5. Add a unit test only for anything pure you extract.
- [ ] **Step 2:** `bun run typecheck && bun test && bun run build && bun scripts/e2e-3d.ts` — all existing scenarios still pass (nothing visible changed).
- [ ] **Step 3:** Commit `git commit -m "feat(3d): load part models once and pass them into the board build"`.

---

### Task 4: Model bodies for chips, the DIP switch, the display, LEDs and resistors

**Files:** Modify `client/board3d-parts.ts` (`buildPackage` :382-425, `buildSevenSeg` :568+, `buildPart` :831, `ledPart` :900, `resistor` :870). Test: `test/board3d.test.ts` (pure leg helper).

**Interfaces — Consumes:** `ModelSet.body`, `modelKeyFor`, `bodyPlacement`, `MM`, `at`, `holeX`, `holeZ` (Tasks 1, 3).

Rules (from the spec table §3.3):
- Look up `key = modelKeyFor(…)` and `m = models?.body(key)`. No `m` → today's code path, unchanged.
- Place `m.object`: `const p = bodyPlacement(m.info, '1', '2', [holeX(h1), holeZ(h1)], [holeX(h2), holeZ(h2)], MM)` with pins `1` and `2` from `doc.pinHoles[ref]` (packages) or `part.pins/holes` (lead2); `object.scale.setScalar(MM)`, `object.rotation.y = p.rotationY`, `object.position.set(p.x, TOP, p.z)`.
- Body dimensions for the legs and obstacles come from the model box (`info.box`, mm × `MM`, rotated to the part's axis), replacing `BODY_HALF_Z`, `BODY_LIFT`, `BODY_H` / `DIP_SWITCH_HALF_Z` for that part. Extract a pure helper `dipLegPath(hole: {x:number; z:number}, cz: number, halfZ: number, yBottom: number, bodyH: number): [x, y, z][]` (shoulder → knee → `TOP - 5`) from the existing leg code and use it for both paths.
- Kit looks: chips — every mesh material set to `kit.M.epoxy`, plus the existing `chipMarking` plane on the model's top face (`y = box.max.y × MM + 0.15`); DIP switch — body materials set to `kit.M.dipCase` (red) and the existing `dipSwitchTop` toggles placed on its top; display — body `kit.M.dark`, face materials `kit.M.glass`, and the existing segment lamps (`SevenSegLamp`) positioned on the model's face; LED — every model material replaced by the LED's epoxy material (the one `ledPart` builds from `spec`), so the existing lamp emissive drives it; resistor — body material `metal ? kit.M.bodyMetal : kit.M.body`, the existing band rings sized to the model's body radius and length, legs still from `axialLeads`.
- `top` and obstacles use the model box height so jumpers clear the real body.

- [ ] **Step 1: Failing unit test** (append to `test/board3d.test.ts`):

```ts
import { dipLegPath } from '../client/board3d-parts.ts';
test('a DIP leg path ends in its hole, below the board surface', () => {
  const path = dipLegPath({ x: 120, z: 200 }, 180, 22, 2, 25);
  const end = path[path.length - 1];
  expect(end[0]).toBe(120);
  expect(end[2]).toBe(200);
  expect(end[1]).toBeLessThan(0);
  expect(path[0][2]).toBe(180 + 22); // leaves the body side facing its hole
});
```
(If importing `board3d-parts.ts` pulls in DOM-only code at module load, put `dipLegPath` in a new DOM-free `client/board3d-geometry.ts` and import from there.)

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the rules above, one part kind at a time, keeping the no-model path byte-for-byte the same.
- [ ] **Step 4:** `bun run typecheck && bun test && bun run build && bun scripts/e2e-3d.ts` — all pass (models are not loaded by the workspace yet, so e2e shows the old shapes; that is expected until Task 5).
- [ ] **Step 5:** Commit `git commit -m "feat(3d): kit parts use KiCad bodies with code-drawn legs and live parts"`.

---

### Task 5: Workspace loading, the Detail toggle, and e2e

**Files:** Modify `client/editor3d/workspace.ts` (`openWorkspace` ~:56-96 load before `mount3d`; toolbar markup ~:67; `[data-ws]` switch; `window.__e3d` hooks), `client/styles.css` (if the button needs a style), `scripts/e2e-3d.ts`.

**Interfaces — Consumes:** `loadModels`, `Board3D.setModels` (Task 3).

- `openWorkspace`: `const detail = readDetail()` (localStorage key `benchmate.3dDetail`, `'high'` default, try/catch); `const models = detail === 'high' ? await loadModels('/models/', signal, dropHook) : null`; pass `{ models }` into `mount3d`. Keep the loaded set in a module-level cache so reopening the editor does not refetch.
- Toolbar button `<button class="ws-btn" data-ws="detail">Detail: high</button>`; click toggles, saves, loads models if needed, calls `board.setModels(models | null)`, updates the label.
- e2e hooks: `__e3d.modelKeys()` → loaded keys (or `[]` in simple detail); `__e3d.dropModels(keys)` → sets the drop list used by the next open (test-only, like `failNextMove`).

- [ ] **Step 1: e2e scenarios first** in `scripts/e2e-3d.ts`:
  - `'the editor opens with the kit models loaded'` — open 3D; `__e3d.modelKeys()` sorted equals `['dip14','dip16','dipswitch7','led5','r0207','seg056']` (the fixture may not use every one; the set is loaded regardless).
  - `'Detail toggle swaps to simple shapes and back'` — click `[data-ws=detail]`; `modelKeys()` is `[]` and the label reads "Detail: simple"; click again; keys are back. Reload the page: the choice was remembered.
  - `'Detail toggle keeps the selection and the Show filter'` — select a part and pick Show → Resistors, toggle Detail; the same ref is still selected and the Show group is still on.
  - `'a missing model falls back'` — `__e3d.dropModels(['dip14'])`, reopen; editor opens, `modelKeys()` lacks `dip14`, chips are still pickable (existing pick helper).
  - Existing scenarios for picking a chip, flicking a DIP toggle and segments lighting must pass with models on.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `bun run typecheck && bun test && bun run build && bun scripts/e2e-3d.ts` — all PASS. Take two screenshots of lab 6 (high and simple) with the e2e page or a manual run and attach their paths in the report.
- [ ] **Step 5:** Commit `git commit -m "feat(3d): load kit models in the editor, with a Detail toggle"`.

---

### Task 6: Documentation

**Files:** `docs/editor3d.md` (new "Part models" section; Shortcuts/toolbar mention of Detail; "Coming next" updated), `README.md` (`bun run models`, KiCad only needed to re-export).

- [ ] **Step 1:** Write the section: which parts are modelled and from which KiCad footprints, what stays code-drawn and why (legs follow the holes; toggles, segments and LED glow are live), the Detail toggle and fallback, how to add a part (add a `KIT_MODELS` entry and a `modelKeyFor` rule, run `bun run models`, commit), and the license note.
- [ ] **Step 2:** `bun run typecheck`; commit `git commit -m "docs(3d): part models"`.

---

## Self-review notes

- Spec §3.1 → Task 2; §3.2 → Task 3; §3.3 → Task 4; §3.4 → Task 5; §4 errors → Tasks 2 (script refuses), 3 (loader never rejects), 5 (fallback e2e); §5 tests → Tasks 1, 2, 4, 5; §6 docs → Tasks 2 (license file), 6.
- Spec correction recorded in Global Constraints: display model is `7SegmentLED_LTS6760_LTS6780`, assets live in `public/models/` (Vite's public dir), both also fixed in the spec.
- Names used across tasks: `ModelKey`, `KIT_MODELS`, `ModelInfo`, `Manifest`, `validateManifest`, `modelKeyFor`, `isLegMaterial`, `Frame`, `applyFrame`, `chooseFrame`, `bodyPlacement`, `ModelSet`, `loadModels`, `setModels`, `dipLegPath` — each defined once.

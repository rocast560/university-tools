# 3D editor phase 4: high-fidelity part models — design

Date: 2026-10-06 · Branch: to be created from `main` · Status: approved in chat, awaiting spec review

## 1. Intent

The 3D editor draws every part from simple shapes built in code. The goal of
this phase is that the parts on screen **look like the parts in the user's
ECE 2300L kit**, so the 3D board can be compared with the physical board
while building it:

- 74LS chips (DIP-14 and DIP-16) with their part number and pin-1 notch;
- the red 7-way DIP switch with white toggles;
- the 5161BS 0.56" single-digit seven-segment display;
- ¼ W axial resistors, tan carbon film or blue metal film, with the right bands;
- 5 mm LEDs in their chosen colour.

Success: lab 6 opened in 3D shows those parts with their real shapes and
proportions, every editor feature from phases 1–3 still works, and the
editor still opens when a model cannot be loaded.

### Decisions the user made

| Question | Answer |
|---|---|
| What "high-fidelity" means | **Match the real kit** (not photoreal screenshots) |
| Approach | **KiCad 3D bodies, recoloured to the kit, legs still drawn in code** (approach A) |
| Photos of the kit | None supplied; colours and markings come from the datasheets and the standard lab kit |

### Out of scope

- The breadboard itself and the jumper wires (unchanged).
- Lighting, environment maps, post-processing.
- 3D thumbnails in the parts tray (the 2D pictures stay).
- Parts outside the kit list above (capacitors, buttons, transistors, …) keep
  their current shapes; adding one later is a manifest entry and a re-run.

## 2. Research summary

- KiCad 9 is installed locally and ships datasheet-accurate models in
  `share/kicad/3dmodels` for every kit part: `Package_DIP.3dshapes/DIP-14_W7.62mm`,
  `DIP-16_W7.62mm`, `Button_Switch_THT.3dshapes/SW_DIP_SPSTx07_Slide_9.78x19.96mm_W7.62mm_P2.54mm`,
  `LED_THT.3dshapes/LED_D5.0mm`,
  `Resistor_THT.3dshapes/R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal`,
  and `Display_7Segment.3dshapes/7SegmentLED_LTS6760_LTS6780` (a 0.56" single digit,
  the closest match to the 5161BS).
- `kicad-cli pcb export glb --no-board-body` turns a board holding one
  footprint into a GLB. A probe on DIP-14 took 0.6 s and produced 166 KB in
  ~250 primitives over **two materials: dark epoxy (body) and light metal
  (legs)**, so legs can be removed by material.
- License: the KiCad library is CC-BY-SA 4.0 with an exception that covers
  designs made with it, not redistribution of the models themselves. Shipping
  converted GLBs therefore needs attribution and the same license on those
  files; the app code is unaffected.
- `@gltf-transform/core` / `functions` / `extensions` (MIT) and `meshoptimizer`
  (MIT) merge primitives, weld and compress; three.js's `GLTFLoader` reads
  meshopt-compressed files with `MeshoptDecoder`.

## 3. Architecture

```
scripts/build-models.ts  (run by hand: `bun run models`)
   kicad-cli → raw GLB → strip legs → merge/weld → meshopt → public/models/<key>.glb
                                                           → public/models/manifest.json
public/models/LICENSE-KiCad-3D.md

client/models.ts          load manifest + GLBs once, cache, expose ModelSet
client/board3d-parts.ts   buildPart/buildPackage take an optional ModelSet;
                          a kit part uses its model body, everything live stays code-drawn
client/board3d.ts         mount3d(…, { models }) passes the set into every build
client/editor3d/workspace.ts  awaits loadModels() before mount3d; Detail toggle
```

### 3.1 Build script (`scripts/build-models.ts`)

- A table of kit parts: `key` (e.g. `dip14`, `dip16`, `dipswitch7`, `led5`,
  `r0207`, `seg056`), the KiCad footprint (`Package_DIP:DIP-14_W7.62mm`, …) and
  the pin that is pin 1.
- For each: write a scratch `.kicad_pcb` holding that footprint at the origin,
  run `kicad-cli pcb export glb --no-board-body -f`, then with gltf-transform:
  - drop every primitive whose material is the leg metal (the brightest,
    least saturated base colour; the rule is a pure function and is tested);
  - join primitives per remaining material, weld, prune;
  - translate so pin 1's hole is the origin and rotate to the board's axes
    (x along the row, z across it, y up); record the pin-1 offset and scale in
    the manifest;
  - write meshopt-compressed GLB.
- Output is committed. Neither the normal build, the tests nor Docker need
  KiCad. The script reads `KICAD_CLI` and the KiCad models directory from the
  environment, defaulting to the local KiCad 9 install.
- `manifest.json`: `{ version: 1, models: { [key]: { file, footprint, pin1: [x, y, z], scale, materials: string[] } } }`.

### 3.2 Loading (`client/models.ts`)

- `loadModels(base = '/models/'): Promise<ModelSet>` fetches the manifest and
  every listed GLB in parallel with `GLTFLoader` + `MeshoptDecoder`.
- `ModelSet.body(key): THREE.Object3D | null` returns a clone sharing geometry
  (materials cloned only where a part tints them). Unknown or failed keys
  return null and log one console warning per key.
- Loaded once per page and cached; rebuilds after edits never reload.

### 3.3 Parts (`client/board3d-parts.ts`)

Each kit part is the model body plus the pieces that must stay live:

| Part | From the model | Still drawn in code |
|---|---|---|
| DIP-14 / DIP-16 chip | body, in the existing epoxy material | part number and pin-1 notch on top, legs into the holes |
| 7-way DIP switch | body, tinted kit red | the white toggles (clickable, animated), legs |
| 5161BS display | body, grey case / black face | the 7 segments + DP on the face (lit by the simulator), legs |
| 5 mm LED | dome and flange, in the LED's colour (glows when lit) | legs |
| ¼ W resistor | body shape, tan or blue per the resistor setting | colour bands from the value, bent legs |

- The model is placed from the part's pin-1 hole (`at(hole)`) and its
  orientation, using the manifest's pin-1 offset, so it sits exactly where
  today's shape sits. Obstacles and `top` heights come from the model's
  bounding box so jumper routing clears it.
- A part is still one `THREE.Group` at the same place: picking, selection
  outlines, the Show filter's fading and focus work unchanged.
- With no `ModelSet`, or no model for the key, the part is built exactly as
  today.

### 3.4 Workspace

- `openWorkspace` awaits `loadModels()` (with the abort signal it already
  has) before `mount3d`. Failure to load the manifest is a warning, not an
  error: the editor opens in simple detail.
- A **Detail: high / simple** toolbar button rebuilds the scene with or without
  the models. The choice is remembered in localStorage (per viewer).

## 4. Error handling

- Manifest or model fetch fails: console warning, that part kind (or all)
  falls back to the code-drawn shape; never a thrown error into the editor.
- WebGL context loss: unchanged (phase 1 behaviour).
- Build script: any kicad-cli failure stops the script with the footprint
  name and the CLI's message; partial output is not written.

## 5. Testing

- Unit (bun):
  - leg-material detection on synthetic material lists shaped like the
    KiCad exports (a dark body plus a light metal, and the resistor's body,
    band and lead colours); manifest schema validation; pin-1 offset maths;
  - for every kit part kind, the code-drawn leg ends lie on the hole
    positions `at(hole)` gives, with and without a model body;
  - the committed `public/models/manifest.json` validates and every listed
    file exists (so a bad re-export fails the suite).
- e2e (`scripts/e2e-3d.ts`):
  - the editor opens with models loaded (a hook reports loaded keys);
  - a chip is still one pickable object; DIP toggles still flick; display
    segments still light from the simulator;
  - the Detail toggle swaps to simple shapes and back;
  - a missing model (hook that drops one key) falls back and the editor works;
  - all existing scenarios still pass.
- Manual: screenshots of lab 6 in both detail levels.

## 6. Documentation

- `docs/editor3d.md`: a "Part models" section (what is modelled, the Detail
  toggle, how to add a part to the pipeline, the license note).
- `README.md`: `bun run models` and that KiCad is only needed to re-export.
- `public/models/LICENSE-KiCad-3D.md`: attribution and CC-BY-SA 4.0 for the
  model files.

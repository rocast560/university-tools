# ChemTool: design

Date: 2026-09-03. Status: approved in conversation, awaiting written review.
Location: `chem-tool/` at the root of the `university-tools` monorepo.

## 1. The request and the decisions behind this design

Type the name or formula of a compound and see its 2D and 3D structure.
Connect Claude Desktop, Claude Code and the ChatGPT desktop app over MCP so
they can look up, change and annotate the molecule while the window updates
in real time. Ship it as a Windows desktop application.

Decisions taken with the user before writing this document:

| Question | Decision |
|---|---|
| Reuse the earlier "Chemistry Tool" build (recoverable from the git index)? | Start fresh. Individual modules may be borrowed. |
| What can the AI change? | Swap compound, structural edits, view and style, multiple molecules and reactions. |
| Editing in the window? | Yes: a 2D sketcher (OpenChemLib CanvasEditor) with two-way sync. |
| Desktop shape | Standalone Tauri 2 app now, built to fold into the shared three-app launcher later. |
| ChatGPT reachability | Built-in tunnel toggle (Cloudflare quick tunnel), off by default. |
| Info panel | Basics, Lewis structure, VSEPR and bonding, polarity. |
| Reactions | Equation strip with a 2D thumbnail per species; click one to focus it in 3D. |
| Offline library | About 400 curated compounds, formula-checked against PubChem at build time. |
| State ownership | Server-owned workspace, one command layer, broadcast over WebSocket. |
| Client stack | React 19 + Vite + TypeScript. |

## 2. Goals

1. `H2O`, `water`, `CH3COOH`, `acetic acid`, `NaCl`, a CAS number or a SMILES
   string resolves in well under a second (offline for the library, PubChem
   otherwise) to a skeletal 2D drawing, a rotatable 3D model, and an info
   panel with basics, Lewis structure, VSEPR geometry and polarity.
2. Any MCP client can read what is on screen, replace or edit the molecule
   atom by atom, change the view, and build a reaction. Every change appears
   in the open window within a frame or two of the tool call returning.
3. The window's sketcher and the AI edit the same molecule. Neither can
   silently overwrite the other.
4. One desktop executable with a tray icon. Closing the window keeps the
   server, and therefore the MCP endpoints, alive.
5. Connection snippets for Claude Code, Claude Desktop (config and one-click
   bundle), ChatGPT (tunnel URL) and any OpenAPI client, with real paths
   filled in.

## 3. Non-goals for v1

- Crystal lattices. Ionic formulas show the formula unit (ions side by side)
  with a note that the solid is a lattice.
- Quantum chemistry. 3D geometry is a force-field conformer (PubChem's where
  available, OpenChemLib's otherwise). Polarity is an electronegativity
  estimate, labelled as such.
- Enumerating resonance structures. Delocalised bonds are marked, not expanded.
- Accounts, cloud hosting, multi-user editing. The tunnel exists to let one
  ChatGPT account reach one laptop.
- ChatGPT Apps SDK widgets (custom UI inside ChatGPT). Tools return text and
  PNG images, which every client renders.
- macOS and Linux builds. The code is portable; only Windows is packaged and
  tested.

## 4. Architecture

```
                 +-------------------------------------------------------+
 Tauri window -->|  Bun server  (127.0.0.1:8140)                          |
 (WebView2)  <-->|   Hono: /  static client   /api/*   /openapi.json      |
   WebSocket     |         /mcp  (Streamable HTTP)      /ws  (WebSocket)  |
                 |   workspace.ts  <-- applyCommand() <-- api | mcp | ws  |
 Claude Code --->|        |  broadcast(state)  -->  every window          |
   (HTTP)        |        v                                               |
                 |   src/chem/*  (pure TypeScript, OpenChemLib, PubChem)  |
                 |   DATA_DIR/  workspace.json  cache/  token  cloudflared|
                 +-------------------------------------------------------+
                        ^                          ^
 Claude Desktop --stdio--> proxy/stdio.ts          |  127.0.0.1:8141
   (spawns server if down)                         |  /t/<token>/mcp only
                                                   |
 ChatGPT --HTTPS--> *.trycloudflare.com --> cloudflared child process
```

One Bun process owns the chemistry, the live workspace, REST, MCP and the
static client. The Tauri shell is a window plus process management. The stdio
proxy and cloudflared are thin helpers. There is exactly one place where the
molecule changes: `applyCommand` in `server/workspace.ts`.

### 4.1 Runtime and dependencies

| Layer | Choice | Why |
|---|---|---|
| Server runtime | Bun 1.3 | Native WebSocket in `Bun.serve`, single-file compile for the Tauri sidecar, already installed. |
| HTTP | Hono 4 | Fast, tiny, runs on Bun, has an MCP transport package. |
| MCP | `@modelcontextprotocol/sdk` + `@hono/mcp` | Official server SDK; `StreamableHTTPTransport` wired to a Hono route. Stdio transport from the same SDK. |
| Chemistry | OpenChemLib 9.25 (`openchemlib`) | SMILES and molfile parsing, 2D coordinates, SVG, 3D `ConformerGenerator`, and the `CanvasEditor` sketcher, all in one bundle. |
| PNG | `@resvg/resvg-wasm` | SVG to PNG without a native addon, so the Bun compile stays a plain single file. |
| Validation | zod 4 | Command and tool schemas, shared between REST, MCP and tests. |
| Client | React 19, Vite 8, TypeScript, Zustand | Familiar stack (same as the typst editor). Bundle size is irrelevant on loopback. |
| 3D view | 3Dmol.js 2.x | Styles, labels, highlights, arrows, `pngURI()` snapshots. Lazy chunk. |
| Sketcher | OpenChemLib `CanvasEditor` | `setMolecule`, `getMolecule`, `setOnChangeListener`, reaction mode. Lazy chunk. |
| Desktop | Tauri 2 (Rust) | WebView2 shell, sidecar, tray, single instance, NSIS installer. |
| Tunnel | cloudflared quick tunnel | No account, one command, random `*.trycloudflare.com` URL. |

### 4.2 Environment variables (server)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8140` | Loopback listener: client, REST, WebSocket, MCP. |
| `TUNNEL_PORT` | `8141` | Tunnel-facing listener: MCP only, token in path. Also bound to 127.0.0.1. |
| `HOST` | `127.0.0.1` | Bind address for both listeners. |
| `DATA_DIR` | `./.data` (dev), `%LOCALAPPDATA%\ChemTool` (desktop) | `workspace.json`, `cache/pubchem/`, `token`, `cloudflared/`. |
| `STATIC_DIR` | `./dist` | Built client. |
| `CLOUDFLARED` | unset | Path to an existing `cloudflared.exe`; skips the download. |
| `PUBCHEM_LIVE` | unset | Tests hit the real PubChem only when set to `1`. |

## 5. Workspace data model

Types live in `src/chem/types.ts` and are shared by server, client and tests.

```ts
interface Workspace {
  version: number;          // increments on every applied command
  scenes: Scene[];
  activeSceneId: string;
}

interface Scene {
  id: string;               // short random id
  title: string;
  kind: 'molecule' | 'reaction';
  species: Species[];       // exactly one for 'molecule'
  equation?: Equation;      // only for 'reaction'
  focusId: string;          // species shown in the main 3D view
  view: ViewState;
  history: { past: SceneSnapshot[]; future: SceneSnapshot[] }; // capped at 50
}

interface Equation {
  reactants: { coefficient: number; speciesId: string }[];
  products:  { coefficient: number; speciesId: string }[];
  balanced: boolean;
  text: string;             // "CH4 + 2 O2 -> CO2 + 2 H2O"
}

interface Species {
  id: string;
  name: string;             // display name ("water")
  iupacName?: string;
  formula: string;          // Hill order, charge suffix for ions ("SO4 2-")
  charge: number;
  source: 'library' | 'pubchem' | 'smiles' | 'edit';
  cid?: number; cas?: string; description?: string; category?: string;
  smiles: string;
  molfile2d: string;        // V2000 from OpenChemLib, 2D coordinates
  molfile3d: string;        // V2000 with 3D coordinates and explicit hydrogens
  atoms: Atom[];            // numbered 1..N heavy atoms first, then hydrogens
  bonds: Bond[];
  info: SpeciesInfo;
  svg2d: string;            // skeletal drawing, no numbers
  svg2dNumbered: string;    // same with heavy-atom indices
}

interface Atom { index: number; element: string; x: number; y: number; z: number; charge: number; }
interface Bond { a: number; b: number; order: 1 | 2 | 3; aromatic: boolean; }

interface SpeciesInfo {
  molarMass: number;                              // g/mol
  composition: { element: string; count: number; massPercent: number }[];
  lewis: LewisData;
  vsepr: VseprCenter[];
  polarity: PolarityData;
}

interface ViewState {
  style: 'ballstick' | 'stick' | 'spacefill' | 'wireframe';   // default 'ballstick'
  labels: 'none' | 'element' | 'index';                        // default 'none'
  highlight: number[];                                         // atom indices
  spin: boolean;
  showDipole: boolean;
  showHydrogens: boolean;                                      // default true
  camera: { preset: 'fit' | 'front' | 'top' | 'side'; rotation: [number, number, number] }; // degrees about x, y, z after the preset
}

// What undo restores: everything in a scene except view and history.
type SceneSnapshot = Pick<Scene, 'kind' | 'species' | 'equation' | 'focusId'>;

interface LewisData {
  valenceElectrons: number;
  atoms: { index: number; lonePairs: number; formalCharge: number; octet: 'ok' | 'incomplete' | 'expanded' | 'radical' }[];
  bonds: { a: number; b: number; order: 1 | 2 | 3; delocalised: boolean }[];
  hasResonance: boolean;
  svg: string;
}

interface VseprCenter {
  index: number; element: string;
  bondedGroups: number; lonePairs: number; stericNumber: number;
  electronGeometry: string; molecularGeometry: string; hybridisation: string;
  idealAngle: number;
  measuredAngles: { min: number; mean: number; max: number };
}

interface PolarityData {
  bonds: { a: number; b: number; deltaEN: number; kind: 'nonpolar' | 'polar' | 'ionic'; towards: number }[];
  netDipole: { x: number; y: number; z: number; magnitude: number };
  polar: boolean;
  reasoning: string;
  arrow?: { from: [number, number, number]; to: [number, number, number] };  // absent when nonpolar
  sigmaBonds: number; piBonds: number;
}
```

Atom numbering: 1-based, OpenChemLib atom order, heavy atoms first and
hydrogens appended. The numbered 2D drawing shows heavy-atom indices only.
Every structural edit renumbers, and every tool response that follows an edit
includes the new atom list so the AI never works from stale numbers.

Persistence: `DATA_DIR/workspace.json`, written at most every 250 ms after a
change. On start the server loads it, or creates one scene containing water.

## 6. Command layer

`applyCommand(workspace, command, actor) -> { workspace, result }` in
`server/workspace.ts` is the only mutation path. `actor` is `'window:<id>'`,
`'mcp'`, or `'api'`, and is echoed in the broadcast so a window can ignore its
own edits.

| Command | Payload | Effect |
|---|---|---|
| `load` | `query`, optional `sceneId`, `newScene?` | Resolve and replace the focused species (or create a scene). |
| `set_structure` | `smiles` or `molfile`, `baseVersion` | Replace the focused species from raw structure. Regenerates 2D, 3D, info. |
| `edit` | `ops: EditOp[]`, `baseVersion` | Apply atom-level edits in order; all-or-nothing. |
| `set_view` | partial `ViewState` | Merge into the active scene's view. |
| `show_reaction` | `equation` text | Parse, balance, resolve every species, create a reaction scene. |
| `focus` | `speciesId` | Change which species the 3D view shows. |
| `new_scene`, `close_scene`, `switch_scene`, `rename_scene` | ids, title | Scene management. |
| `undo`, `redo` | none | Per scene, structural and reaction changes only (view changes are not history). |

Edit ops (`src/chem/edit.ts`):

| Op | Fields |
|---|---|
| `add_atom` | `element`, `bondTo` (index), `order` |
| `remove_atom` | `index` (hydrogens on it are removed too) |
| `set_element` | `index`, `element` |
| `set_charge` | `index`, `charge` |
| `add_bond`, `remove_bond` | `a`, `b`, `order` |
| `set_bond_order` | `a`, `b`, `order` |
| `attach_group` | `index`, `group` (named or SMILES fragment) |
| `replace_group` | `index` (atom of the group to remove, must be a leaf or a hydrogen), `group` |
| `set_hydrogens` | `mode: 'auto'` (re-saturate every heavy atom after the edits) |

Named groups: `H`, `OH`, `NH2`, `CH3`, `C2H5`, `COOH`, `CHO`, `CN`, `NO2`,
`SO3H`, `OCH3`, `SH`, `F`, `Cl`, `Br`, `I`, `phenyl`. Anything else is parsed
as a SMILES fragment whose first atom is the attachment point.

Every op sequence is applied to a copy, then valence-checked with OpenChemLib
(free valence never negative, charges consistent). On failure the whole
command is rejected with a message that names the atoms involved
("carbon 3 would have 5 bonds"), and the workspace is unchanged.

Concurrency: `set_structure` and `edit` carry the `baseVersion` the caller
saw. If the workspace has moved on, the command is rejected with the current
state so the caller can retry from it. The sketcher uses this; MCP tools read
the version inside the same call and therefore never conflict with
themselves.

After every applied command the server recomputes derived data only for
species that changed, bumps `version`, schedules persistence, and broadcasts
`{ type: 'state', workspace, actor, version }` to every WebSocket client.

## 7. Chemistry modules (`src/chem/`)

All pure, no I/O except `pubchem.ts`. Each exports plain functions over the
types in section 5 and has a Vitest file beside it.

| Module | Does | Depends on |
|---|---|---|
| `elements.ts` | Periodic table: symbol, name, atomic mass, valence electrons, Pauling electronegativity, covalent radius, CPK colour. | nothing |
| `formula.ts` | Parse `Ca(OH)2`, `CuSO4.5H2O`, `CH3CH2OH`, unicode subscripts, charge suffixes. Hill order, molar mass, mass percent. | elements |
| `library.ts` | Load `data/library.json`, index by normalised name and alias, Hill formula, CAS, CID. `findByName`, `findByFormula`, `search` (prefix, then substring, ranked). | formula |
| `pubchem.ts` | PUG REST: name/formula/CID to properties, synonyms, 2D and 3D SDF. Rate limited to 5 requests/s, cached on disk under `DATA_DIR/cache/pubchem/`. | nothing |
| `resolve.ts` | Pipeline: normalise, library by name, library by formula, SMILES parse, PubChem by name, PubChem by formula. Returns `Species` plus `alternatives` (other library entries with the same formula) and `source`. | library, pubchem, structure |
| `structure.ts` | OpenChemLib wrappers: SMILES or molfile to `Molecule`; 2D coordinates; SVG (plain and numbered); 3D via `ConformerGenerator` with explicit hydrogens; `Molecule` to `atoms`/`bonds`; disconnected fragments laid out side by side. | elements |
| `edit.ts` | Edit ops from section 6 on a `Molecule`, group table, valence check with actionable errors. | structure |
| `lewis.ts` | Per atom: lone pairs, formal charge. Per bond: order, delocalised flag (aromatic or conjugated anion). Flags: expanded octet, incomplete octet, radical. Total valence electrons. | elements, structure |
| `lewis-svg.ts` | Draws the Lewis structure: 2D coordinates with hydrogens shown, element symbols, one to three lines per bond, lone pairs as dot pairs in free directions, charges as superscripts, delocalised bonds dashed with a "resonance" note. | lewis |
| `vsepr.ts` | For every non-hydrogen atom with two or more neighbours: bonded groups, lone pairs, steric number, electron geometry, molecular geometry, hybridisation (sp to sp3d2), ideal angle, and measured angles from the 3D coordinates (min, mean, max). Whole-molecule sigma and pi bond counts. | lewis, structure |
| `polarity.ts` | Bond polarity class from electronegativity difference (nonpolar below 0.4, polar to 1.7, ionic above). Bond dipole vectors along the 3D bond toward the more electronegative atom, magnitude equal to the difference. Net vector, polar verdict (magnitude above 0.3 and at least one polar bond), one-paragraph reasoning that mentions symmetry cancellation. Arrow endpoints for the 3D view. | elements, structure |
| `reaction.ts` | Parse equations with `->`, `→` or `=`, formulas or names, optional coefficients. Balance by integer nullspace. Returns species queries and coefficients. | formula |
| `render3d.ts` | Software 3D snapshot: rotate, depth sort, spheres as radial gradients, bonds as lines, to SVG. Used when no window can answer a snapshot request. | elements |
| `png.ts` | SVG to PNG via resvg-wasm, initialised once. | nothing |

## 8. Library and data pipeline

- `data/seed.ts`: about 400 entries `{ name, formula, aliases, category, note?, charge? }`.
  Categories: gases and diatomics, acids, bases, salts and ionic compounds,
  polyatomic ions, oxides, alkanes, alkenes and alkynes, aromatics,
  alcohols and ethers, aldehydes and ketones, carboxylic acids and esters,
  amines and amides, halides, sugars, amino acids, nucleobases, lipids,
  solvents and lab reagents, monomers and polymers, household chemicals.
- `scripts/build-library.ts`: for each seed, ask PubChem by name, verify the
  Hill formula matches the seed (mismatches are printed and skipped, never
  written), store CID, IUPAC name, SMILES, molar mass, description; fetch
  the PubChem 3D SDF, falling back to OpenChemLib's conformer when PubChem
  has none (salts, ions). Output `data/library.json` and
  `data/conformers/<cid or slug>.sdf`, both committed so the app works
  offline. Entries with a `charge` are stored as ions and rendered as such.
- Duplicated formulas (isomers) keep seed order: the first is the default
  match, the rest come back as `alternatives`.

## 9. Server (`server/`)

### 9.1 Files

| File | Role |
|---|---|
| `index.ts` | `Bun.serve` on `PORT` with Hono's fetch handler and the WebSocket handlers; second `Bun.serve` on `TUNNEL_PORT`. Graceful shutdown kills cloudflared. |
| `app.ts` | Hono app: static `STATIC_DIR` with immutable caching for hashed assets, `/api`, `/openapi.json`, `/mcp`, `/ws` upgrade. |
| `tunnel-app.ts` | Hono app for 8141: `/api/health` and `/t/:token/mcp` only. Wrong token: 404. |
| `workspace.ts` | In-memory workspace, `applyCommand`, derived-data recompute, persistence, broadcast, snapshot request broker. |
| `api.ts` | REST routes (9.2). |
| `ws.ts` | WebSocket protocol (9.3). |
| `mcp.ts` | `McpServer` factory with the tools in 9.4. One server instance per MCP session, all sharing the workspace. |
| `tunnel.ts` | cloudflared lifecycle (9.6). |
| `connect.ts` | Connection snippets (9.7). |
| `openapi.ts` | OpenAPI 3.1 document built from the same zod schemas as the routes. |

### 9.2 REST (`/api`)

| Method and path | Purpose |
|---|---|
| `GET /health` | `{ ok: true, version, port }`. Used by the Tauri shell and the stdio proxy. |
| `GET /search?q=` | Library search, at most 20 hits, for autocomplete. |
| `GET /resolve?q=` | Resolve without changing the workspace. Returns a `Species` and alternatives. |
| `GET /workspace` | Current workspace. |
| `POST /command` | Apply one command (section 6). Returns `{ workspace, result }` or a 409 with the current workspace on a version conflict, 422 on a rejected edit. |
| `GET /species/:id.svg`, `.png`, `.sdf`, `.mol` | Files for the species; `?numbered=1` for indices; `?w=` for PNG width. |
| `GET /snapshot.png?scene=` | 3D snapshot: live window if one answers within 3 s, software render otherwise. |
| `GET /tunnel`, `POST /tunnel` | Status; `{ enabled: boolean }` to start or stop. |
| `POST /token/regenerate` | New access token for the tunnel URL path; restarts the tunnel if running. |
| `GET /connect` | Snippets with real paths and the current tunnel URL. |

All JSON except the file routes. Errors are `{ error, suggestions? }`.

### 9.3 WebSocket (`/ws`)

Server to client:

- `{ type: 'state', workspace, actor, version }` on connect and after every change.
- `{ type: 'snapshot_request', id, sceneId, width, height }`.
- `{ type: 'error', message, command? }` when a client command is rejected.

Client to server:

- `{ type: 'hello', windowId }`.
- `{ type: 'command', command }` (the command carries `baseVersion` where required).
- `{ type: 'snapshot_response', id, pngBase64 }`.

The snapshot broker sends a request to every connected window and resolves
with the first response. Ten seconds without a `hello` closes the socket.

### 9.4 MCP tools

One `McpServer` definition in `server/mcp.ts`, used by the HTTP transport on
8140, the token-in-path transport on 8141, and the stdio proxy. Tool inputs
are zod schemas. Results are text (a short summary plus JSON) and, where
noted, a PNG image block.

| Tool | Input | Output |
|---|---|---|
| `lookup_chemical` | `query`, `load` (default true), `newScene` (default false) | Species summary, numbered atom list, alternatives, 2D PNG. Loads into the window when `load` is true. |
| `search_chemicals` | `query`, `limit` | Ranked matches from the library. |
| `get_current` | none | Active scene: kind, species with numbered atoms, equation, view state, workspace version. |
| `set_molecule` | `smiles` or `molfile` or `query` | Replaces the focused species. Returns the same as `lookup_chemical`. |
| `edit_molecule` | `ops` | Applies section 6 edit ops. Returns new atom list, warnings, 2D PNG. On rejection: the reason and the unchanged atom list. |
| `set_view` | partial view state, plus optional `rotate: { axis, degrees }` | Confirms the view. Returns a 3D PNG. |
| `show_reaction` | `equation` | Balanced equation, per-species summary, equation strip PNG. Creates a reaction scene. |
| `focus_species` | `speciesId` or `formula` | Confirms; 3D PNG. |
| `render_2d` | `speciesId?`, `numbered?`, `width?` | PNG. |
| `render_3d` | `speciesId?`, `style?`, `width?` | PNG from the live window, or the software renderer with a note saying which. |
| `get_structure` | `speciesId?`, `format: 'sdf' \| 'molfile' \| 'smiles' \| 'json'` | The structure as text. |
| `analyze` | `speciesId?`, `what: 'lewis' \| 'vsepr' \| 'polarity' \| 'all'` | The analysis data; Lewis includes its PNG. |
| `formula_info` | `formula` | Molar mass, composition, Hill formula. Does not touch the workspace. |
| `balance_equation` | `equation` | Balanced text and coefficients. Does not touch the workspace. |
| `undo`, `redo` | none | Confirms and returns the new atom list. |
| `new_scene`, `list_scenes`, `switch_scene` | `title` / none / `sceneId` | Scene control. |

Tool descriptions tell the model that atom numbers come from the most recent
response, that `get_current` is the cheap way to re-read them, and that a
rejected edit leaves the molecule unchanged.

### 9.5 Stdio proxy (`proxy/stdio.ts`)

For Claude Desktop, which launches local servers over stdio. The proxy:

1. Connects an MCP client over Streamable HTTP to `http://127.0.0.1:8140/mcp`.
2. If the connection is refused, starts the server (`CHEM_SERVER_EXE` if set,
   otherwise `bun server/index.ts` in the repo) detached, polls `/api/health`
   for up to 15 s, then connects.
3. Exposes the upstream tool list over `StdioServerTransport` and forwards
   every call, including image content, unchanged.

So Claude Desktop, Claude Code and ChatGPT all act on the same live
workspace. Built with `bun build --target=node` to a single JS file so it can
also ship inside a `.mcpb` bundle, whose manifest declares the Node runtime
and a `server_path` user setting for the installed server executable.

### 9.6 Tunnel (`server/tunnel.ts`)

- Enable: ensure `cloudflared.exe` exists (`CLOUDFLARED`, then PATH, then
  download the latest `cloudflared-windows-amd64.exe` from GitHub releases
  into `DATA_DIR/cloudflared/` and confirm `--version` runs). Spawn
  `cloudflared tunnel --url http://127.0.0.1:8141 --no-autoupdate`. Parse the
  first `https://*.trycloudflare.com` line from its output, within 30 s.
  Status becomes `{ enabled: true, url, startedAt }`.
- Disable, server exit, or crash of cloudflared: status `{ enabled: false }`.
  The tunnel never restarts on its own; the toggle is explicit.
- Token: 32 random bytes as hex, stored in `DATA_DIR/token`, created on
  first start. The public MCP URL is `<tunnel>/t/<token>/mcp`. The token
  travels in the path because ChatGPT and Claude custom connectors offer only
  OAuth or no authentication, not a bearer header. Regenerating the token
  invalidates the old URL immediately.
- The 8141 app serves nothing but that path and `/api/health`, so the client,
  REST and WebSocket are never exposed.

### 9.7 Connection snippets (`server/connect.ts`)

- Claude Code: `claude mcp add --transport http chemtool http://127.0.0.1:8140/mcp`.
- Claude Desktop: the `mcpServers` JSON entry pointing at the proxy
  executable, and the path of the generated `chemtool.mcpb`.
- ChatGPT: the tokenised tunnel URL, or "tunnel is off" with the toggle.
- Any OpenAPI client: `http://127.0.0.1:8140/openapi.json`.

## 10. Client (`src/client/`, React)

### 10.1 Layout

- Top bar: search box with debounced autocomplete from `/api/search`, scene
  tabs, Connect button, live-connection dot.
- Equation strip, shown only for reaction scenes: coefficients, formula and a
  small 2D drawing per species, arrow between sides, click to focus.
- Centre: 3D viewer (3Dmol.js) with a toolbar for style, labels, spin,
  dipole arrow, hydrogens, reset camera, download PNG and SDF.
- Right panel tabs: 2D (skeletal SVG, numbers toggle), Sketch (CanvasEditor),
  Lewis (SVG), Info (basics: names, formula, charge, molar mass, composition
  table, description, source, alternatives), Bonding (VSEPR table per
  centre, sigma and pi counts, hybridisation), Polarity (bond table, verdict,
  reasoning, arrow toggle).
- URL: `?scene=<id>` selects a scene; `?q=<query>` loads a query on open and
  is the link that tool results include; `?connect=1` opens the Connect
  dialog (used by the tray menu).

### 10.2 State and sync

- One Zustand store holding the workspace, connection status, and UI-only
  state (active panel tab, pending command).
- `ws.ts` connects to `/ws`, sends `hello`, applies every `state` message,
  reconnects with backoff, and refetches `/api/workspace` on reconnect.
- `commands.ts` wraps every command; commands go over the WebSocket, with a
  REST fallback while the socket is reconnecting.
- Sketcher: on user change, debounce 300 ms, send `set_structure` with the
  editor's molfile and the store's version. On incoming state, call
  `setMolecule` only when the focused species' molfile differs from what the
  editor last produced, so the user's cursor is never disturbed by their own
  edit echoing back.
- 3D viewer: re-applies `ViewState` on every state change, keeps the camera
  unless the species changed or a camera preset was set, draws highlights as
  per-atom style overrides, draws the dipole as an arrow from the polarity
  endpoints, answers `snapshot_request` with `viewer.pngURI()`.
- 3Dmol.js and CanvasEditor load in separate chunks after the first result.

## 11. Desktop shell (`desktop/`, Tauri 2)

- Sidecar `chem-server-x86_64-pc-windows-msvc.exe`, built by
  `bun build --compile --minify --target=bun-windows-x64 server/index.ts`.
  `dist/` and `data/` ship as resources; the shell passes `STATIC_DIR`,
  `DATA_DIR=%LOCALAPPDATA%\ChemTool`, `PORT=8140`, `TUNNEL_PORT=8141`,
  `HOST=127.0.0.1`.
- Start-up: spawn the sidecar inside a Windows job object with kill-on-close
  (`win32job`), poll `/api/health` every 100 ms for up to 20 s, then create
  the window at `http://127.0.0.1:8140/`. On timeout, show a bundled error
  page with the sidecar's last log lines.
- Tray menu: Open ChemTool, Connect info (opens the window with `?connect=1`),
  Quit. Closing the window hides it; `RunEvent::ExitRequested` is prevented
  so the server survives with no window. Quit kills the sidecar and exits.
- `tauri-plugin-single-instance`: a second launch focuses the existing
  window. `--minimized` starts without a window, for use with autostart.
- Bundle: NSIS installer with a desktop and Start menu shortcut. The
  installer also writes `chemtool.mcpb` and the stdio proxy next to the
  executable, so the Connect page can point at them.
- If the port is already in use by a healthy ChemTool server (for example
  the dev server), the shell attaches to it instead of spawning.

## 12. Error handling

| Situation | Behaviour |
|---|---|
| Unknown chemical | 404 (REST) or a tool result with `suggestions`: closest library names by prefix and edit distance. Workspace unchanged. |
| Invalid edit | 422 or a tool result with the reason and atom numbers. Workspace unchanged. |
| Version conflict | 409 with the current workspace; the sketcher reloads and shows a toast "updated by Claude". |
| PubChem down or offline | Library answers still work; the response includes `source` and, on a miss, the network error. |
| WebSocket drop | Status dot turns amber, reconnect with backoff, refetch state on reconnect. |
| No window for a live snapshot | Software renderer answers; the result says so. |
| cloudflared missing, download fails, or no URL within 30 s | Tunnel status carries the error; the toggle resets to off. |
| Server down when the stdio proxy starts | It starts the server; if health never comes up, the proxy reports the error to Claude Desktop and exits non-zero. |
| Port 8140 busy with something else | Server exits with a clear message; the shell shows its error page. |

## 13. Testing

- Vitest, `bun run test`, no network unless `PUBCHEM_LIVE=1`.
- `src/chem/*.test.ts`: formula parsing and molar mass against known values;
  library matching; resolve with a mocked PubChem; structure round trips;
  every edit op including rejections; Lewis lone pairs and formal charges for
  H2O, NH3, CO2, NO3-, SO4 2-, O3; VSEPR geometries for the standard table
  (linear through octahedral, with lone pairs); polarity verdicts for H2O,
  CO2, CCl4, CHCl3, NH3; balancing including redox-style equations; software
  renderer projection sanity.
- `server/*.test.ts`: `applyCommand` for every command, undo and redo depth,
  version conflicts, persistence round trip; REST via `app.request`; MCP
  tools via the SDK's in-memory transport; snapshot broker fallback.
- `src/client/**/*.test.ts`: store reducers and the sketcher echo-suppression
  logic with Testing Library, no WebGL.
- Manual checklist: 3D styles and highlights, sketcher two-way sync with a
  live Claude Code session, Claude Desktop through the proxy, ChatGPT through
  the tunnel, tray behaviour, no orphaned process after Quit, MCP connection
  survives closing the window.

## 14. Implementation phases

1. Core chemistry (elements, formula, structure, resolve, library with a
   starter seed of about 60), server with workspace, REST, WebSocket, MCP
   tools `lookup_chemical`, `search_chemicals`, `get_current`,
   `set_molecule`, `render_2d`, `render_3d` (software renderer only),
   `get_structure`, `formula_info`; React window with search, 2D, 3D, Info;
   Claude Code connected and updating the window live.
2. Editing: edit ops, `edit_molecule`, sketcher tab with two-way sync, undo
   and redo, `set_view` with highlights, live WebGL snapshots.
3. Analysis: Lewis, VSEPR, polarity modules, panels and `analyze`.
4. Reactions: `reaction.ts`, equation strip, `show_reaction`,
   `focus_species`, `balance_equation`.
5. Library to about 400 with the build script and committed data.
6. Desktop: Tauri shell, sidecar build, tray, installer; stdio proxy and
   `.mcpb`; tunnel toggle and Connect page.

Phases 1 and 2 form the first implementation plan; 3 to 5 the second; 6 the
third.

## 15. Directory layout

```
chem-tool/
  package.json  tsconfig.json  vite.config.ts  index.html
  data/           seed.ts  library.json  conformers/
  scripts/        build-library.ts
  src/chem/       elements.ts formula.ts library.ts pubchem.ts resolve.ts structure.ts
                  edit.ts lewis.ts lewis-svg.ts vsepr.ts polarity.ts reaction.ts
                  render3d.ts png.ts types.ts  (+ *.test.ts)
  src/client/     main.tsx App.tsx store.ts ws.ts commands.ts
                  components/  SearchBar SceneTabs EquationStrip Viewer3D SidePanel
                               Structure2D Sketch Lewis Info Bonding Polarity
                               ConnectDialog StatusBar
  server/         index.ts app.ts tunnel-app.ts workspace.ts api.ts ws.ts mcp.ts
                  tunnel.ts connect.ts openapi.ts  (+ *.test.ts)
  proxy/          stdio.ts  mcpb/manifest.json
  desktop/        src-tauri/  (Cargo.toml tauri.conf.json src/main.rs icons/ binaries/)
  docs/superpowers/specs/2026-09-03-chem-tool-design.md
```

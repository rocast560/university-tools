# Circuit AI Tool: design

Date: 2026-09-03. Status: approved in conversation, ready for an implementation plan.

## The request

"Make an application so that I can, or you can, adjust a KiCad schematic and
then turn it into a circuit diagram, like a breadboard, generated from that
schematic. It shows all the wiring and knows the parts commonly used in
Circuits 1, Circuits 2 and Digital Logic Design (LEDs, DIP switches, 74LS04
and the like). Connect it via MCP so modifications and questions can go
through Claude Desktop, ChatGPT Desktop or Claude Code."

Decisions taken with the user during brainstorming:

| Question | Decision |
|---|---|
| Stack | Bun + TypeScript. One engine runs in the browser and on the server. |
| Microcontroller boards | None. Everything lives on the breadboard. |
| Part families | Digital logic (74xx, LEDs, DIP switches, pushbuttons, resistors, 7-segment) plus capacitors, inductors, op-amps, 555 timers, transistors, potentiometers, diodes, Zeners. |
| Circuit edits over MCP | The app edits the schematic itself, so one server is enough for ChatGPT and Claude Desktop. |
| Breadboard editing | Auto layout, then drag to adjust. Placements persist. |
| Net source | `kicad-cli` netlist, cached by file hash. |
| Edit mechanism | Label-based: new symbols in free space, a global label per connected pin. |
| Project model | Open the real `.kicad_sch` in place, watch it, sidecar JSON for layout choices. |
| Art style | Clean, flat, colour-coded, theme-aware. |
| Carried over from the old tool | Build guide, logic simulation and truth table, checks, printable PDF. |

Prior art: the recovered Python `circuit-designer` (kicad-cli import, deterministic
DIP placer, checks, logic sim, guide, six MCP tools). Its layout rules are ported;
its Claude-API "designer" loop is dropped because the assistant now drives the tool
through MCP directly.

## Goals

1. Open a `.kicad_sch`, see a correct breadboard wiring diagram within a second,
   and see it update every time the file is saved.
2. Every part a Circuits 1/2 or Digital Logic student puts on a breadboard is
   placed with a real footprint and real hole coordinates.
3. Drag any part to another spot; wires follow; the choice survives re-imports.
4. An assistant connected over MCP can answer "which hole is pin 3 of U2 in",
   render the board as an image, change the layout, and change the circuit
   (add, connect, remove, set value) with the result verified by KiCad.
5. Copy-paste connection snippets for Claude Desktop, Claude Code, ChatGPT and
   any OpenAPI client.

## Non-goals

- No microcontroller boards, no PCB, no analog (SPICE) simulation in this version.
- No schematic wire routing. Edits use global labels.
- No hierarchical sheets or buses. Both produce a clear error.
- No accounts, no cloud, no persistence beyond the sidecar and a recent list.

## Architecture

```
KiCad GUI / kicad MCP / this app's edit tools  --write-->  NAME.kicad_sch
                                                             |  (fs.watch, debounced)
browser  <--SSE /api/events--  Bun + Hono server  <----------+
browser  --HTTP-->             /api/*, /openapi.json, /mcp, /mcp-server/mcp, dist/
Claude Desktop (stdio)  -->    server/mcp-stdio.ts  (same tools, in process)
ChatGPT / claude.ai     -->    /mcp through a tunnel (cloudflared or ngrok)
                                   |
                                   v
                       src/* pure TypeScript (browser and server)
   kicad parse -> netlist (kicad-cli, cached) -> catalog -> layout(design, sidecar)
              -> checks -> sim -> guide -> render (SVG; PNG on the server via resvg)
```

Runtime: Bun 1.3 runs `server/index.ts` directly (no server build step). The
client is built by Vite into `dist/`. Tests use `bun test`. Port 8765 and the
`/mcp-server/mcp` alias keep the existing Claude Code registration working.

Layout is a pure function `layout(design, sidecar) -> LayoutDoc`. The browser
runs it during drag for instant re-routing; the server runs it for MCP and
checks. Because both sides run the same code on the same inputs, they never
disagree.

## Directory layout

```
circut-ai-tool/
  package.json  tsconfig.json  vite.config.ts  index.html  README.md
  src/
    sexpr.ts            tokenizer, parser (with source spans), serializer
    kicad/
      schematic.ts      Schematic model from a .kicad_sch text
      transform.ts      pin position from symbol at/rot/mirror (KiCad y flip)
      writer.ts         span edits: addSymbol, addGlobalLabel, removeSymbol, setProperty
      libsymbol.ts      extract one symbol (resolving extends) from a .kicad_sym
    netlist.ts          kicadsexpr netlist -> Design
    parts/
      catalog.ts        lib_id + value -> Footprint
      gates.ts          74xx gate tables, 7447/7448, DC parameters
      values.ts         parse ohms, farads, henries
    layout/
      board.ts          hole geometry, strips, rails, split
      engine.ts         placement and routing
      types.ts          LayoutDoc, Sidecar, Options
    checks/index.ts     connectivity, power, polarity, drivers, DC
    sim/index.ts        logic simulation, truth table
    guide.ts            steps, parts list, pinouts
    render/
      board.ts  parts.ts  wires.ts  theme.ts  index.ts (renderSvg)
  server/
    config.ts  kicad-cli.ts  libraries.ts  projects.ts  watch.ts
    service.ts  api.ts  mcp.ts  mcp-stdio.ts  connect.ts  openapi.ts  app.ts  index.ts
  client/
    main.ts  board.ts  panels.ts  guide.ts  connect.ts  api.ts  styles.css  print.css
  test/
    fixtures/*.kicad_sch  and one *.test.ts per module
  docs/superpowers/specs/
```

## Data model

```ts
// src/kicad/schematic.ts
interface Schematic {
  text: string; uuid: string; project: string;
  libSymbols: Map<string, LibSymbol>;          // "74xx:74LS04" -> definition
  symbols: SymbolInstance[]; labels: Label[]; globalLabels: Label[];
  wires: Wire[]; junctions: Point[]; noConnects: Point[];
  span: (uuid: string) => [start, end];        // byte span of a top-level node
}
interface SymbolInstance { uuid; libId; at: Point; rot: 0|90|180|270; mirror?: "x"|"y";
  unit: number; ref: string; value: string; properties: Record<string,string>; pins: Map<string, uuid>; }
interface LibSymbol { id; extends?: string; units: Map<number, LibPin[]>; power: boolean; }
interface LibPin { number; name; type; at: Point; angle: 0|90|180|270; length: number; }

// src/netlist.ts (from kicad-cli)
interface Design { components: Map<ref, Component>; nets: Map<name, NetNode[]>; }
interface Component { ref; value; lib; part; pins: Map<num, { name; type; net }>; }

// src/layout/types.ts
type Row = "a"|"b"|"c"|"d"|"e"|"f"|"g"|"h"|"i"|"j"|"T+"|"T-"|"B+"|"B-";
type Hole = { col: number; row: Row };
interface Sidecar { version: 1; options: Options;
  pinned: Record<ref, { col: number; half: "T"|"B"; row?: Row; flip?: boolean }>;
  colors: Record<net, string>; }
interface Options { board: "auto"|"half"|"full"; railSplit: boolean|null;
  dipSwitchPositions: number; packageOrder: string[]; substitutions: Record<ref,string>; }
interface LayoutDoc { board; supply; packages[]; parts[]; wires[]; nets; pinHoles;
  unplaced: { ref; reason }[]; steps[]; sim; pinouts[]; partsList[]; checks[]; }
```

`pinHoles[ref][pin]` is the single source of truth for where every pin sits.
Checks, the simulator, the guide and the renderer all read it.

## Part catalog

Classification order: exact `lib_id` rules, then value patterns, then pin-count
fallbacks. Unknown parts with an even count of numeric pins (4 or more) become
generic DIPs; anything else is listed in `unplaced` with a reason.

| Footprint | Matches | Placement |
|---|---|---|
| `dip{n}` | `74xx:*`, `4xxx:*`, `Amplifier_Operational:*`, `Comparator:*`, `Timer:*`, values matching `74(LS, HC, HCT)?nnn`, generic even-pin parts | Across the gutter, pin 1 at row f, notch left |
| `lead2{style}` | `Device:R`, `C`, `C_Polarized`, `L`, `D`, `D_Zener`, `D_Schottky`, `LED`, `Switch:SW_SPST`, `SW_Push*`, any 2-pin part | Two holes; anchored to a placed net; to a rail when the other end is power |
| `to92` | `Transistor_BJT:*`, `Transistor_FET:*` (3 pins), `Device:Q_*` | Three adjacent columns in one half, leg order from pin names |
| `pot3` | `Device:R_Potentiometer*` | Three adjacent columns in one half, wiper in the middle |
| `dipswitch{n}` | `Switch:SW_DIP_xNN`, or N single switches folded by option | Across the gutter, n columns |
| `sevenseg` | `Display_Character:*` with 7 to 10 pins and segment pin names | 10-pin package across the gutter; common pin(s) from names |
| `power` | `power:*`, `#PWR*`, `PWR_FLAG` | Not placed; defines nets |
| `supply` | `Connector:*` whose pins are all power nets, `Simulation_SPICE:VDC` | Bench supply leads into rails |

Power nets: `+` if the name starts with `+` or is VCC/VDD/5V/3V3; `-` if it starts
with `-`; `GND` for GND, GNDREF, GNDD, GNDA, 0. Rail plan: T+ = first positive,
T- = GND, B+ = second non-ground supply (negative or positive), B- = GND. A third
non-ground supply is an error naming the nets.

Values: `values.ts` parses `1k`, `4k7`, `330R`, `10uF`, `100n`, `2.2mH` for the DC
checks and the parts list.

## Layout engine

Ported from the recovered `layout.py` and extended. Order of operations:

1. **Pinned first.** Every sidecar `pinned` entry claims its holes. A pin that no
   longer matches the design (part gone, pin count changed) is dropped with a warning.
2. **Packages** left to right from column 3: DIP switch (folded or real), then
   DIPs in `packageOrder` then by reference, then 7-segment displays. Two free
   columns between packages.
3. **Board size.** Half (30 columns) when the packages fit, else full (63). Rails
   split at column 30 on full boards unless `railSplit` is false.
4. **Supply** leads: `+` into T+ column 1, GND into T- column 2, second supply into B+.
5. **Three-lead parts** (TO-92, pots): find three consecutive free columns near a
   placed net they touch, else the first free block. Each leg registers its strip
   as a home for its net.
6. **Two-lead parts**, repeated until no progress: anchor one leg in a strip already
   holding the part's net; the other leg goes to the rail (if power), to a strip of
   its net within two columns, or to a fresh column. Decoupling capacitors get a
   column of their own. LEDs record cathode and anode.
7. **Power wires**: every strip with a power net gets one jumper to the nearest
   free hole on the right rail.
8. **Signal wires**: strips of a net sorted by column, each joined to the next.
   Same row on both ends when free.
9. **Bridges**: one jumper per rail pair top to bottom, and across the split.
10. **Colours**: red for positives, black for GND, blue for negatives, then a
    twelve-colour palette by input, LED and remaining nets; sidecar overrides win.

Every hole has one owner. A conflict throws `LayoutError` with both owners; a
full board throws with the part that did not fit and the suggestion to switch to
full size or unpin.

## Rendering

`renderSvg(doc, opts)` returns an SVG string. Layers: board (holes, rail lines,
column numbers, row letters, split marks), packages, parts, wires, labels,
highlight. Parts are drawn by footprint: DIP body with notch and pin-1 dot,
resistor with a value label, capacitor plates (polarised one with a minus
stripe), inductor coil, diode band, LED dome with flat side, TO-92 half circle,
pot with wiper mark, DIP switch with numbered sliders, 7-segment face. Wires are
quadratic curves between hole centres with end dots in the net colour. All
colours come from `theme.ts` CSS variables so the client's light and dark themes
apply; the server injects the light palette for PNG output. `opts.highlight`
takes a net name or a step number and dims everything else. The server rasterises
with `@resvg/resvg-js`.

## Checks and simulation

Checks read `LayoutDoc` and `Design` only:

- **Hole conflicts** (defensive; the engine should already prevent them).
- **Connectivity**: union-find over strips, rails (split-aware), wires, part legs
  and folded DIP switch positions. Every design net must map to exactly one hole
  group and every group to at most one net. Reports missing joins and shorts by name.
- **Power**: each package's VCC and GND pins reach the supply; supply present.
- **LED polarity**: cathode toward the sinking side (gate output or GND).
- **Drivers**: two outputs on one net; floating inputs on placed chips.
- **DC** (74LS/HC tables from `gates.ts`): fan-out, LED series current, total ICC.
- **Unplaced parts** and dropped pins as warnings.

Simulation covers combinational 74xx gates (00, 02, 04, 08, 10, 11, 20, 21, 27,
30, 32, 86) and BCD to 7-segment decoders (47, 48) driving a display. Inputs are
switch-controlled nets (active low through pull-ups, as in the labs). The truth
table enumerates up to six inputs. Chips outside the table are placed and
checked and marked "not simulated"; the truth table is then omitted.

## Guide

Steps grouped Chips, Power, Inputs, Signals, Outputs, Other, each with the holes
named (`f12`, "top + rail, column 3") and the chip pin they touch. The client
shows checkboxes with progress in `localStorage` and highlights the step on the
board. Pinouts list every pin of every package with function, net and hole. The
parts list counts parts by value plus jumpers, supply and board size.

## Server

- `config.ts`: `CIRCUIT_PORT` (8765), `CIRCUIT_HOST` (127.0.0.1), `CIRCUIT_PUBLIC_URL`,
  `KICAD_CLI` (default `%LOCALAPPDATA%\Programs\KiCad\9.0\bin\kicad-cli.exe`, then PATH),
  `KICAD_SYMBOL_DIR`, `DATA_DIR` (`%LOCALAPPDATA%\UniversityTools\circuit`),
  `PROJECTS_DIR` (`%USERPROFILE%\Documents\KiCad\9.0\projects`).
- `kicad-cli.ts`: spawn with a 60 s timeout; `netlist(sch)`, `svg(sch)`, `erc(sch)`;
  results cached on disk under `DATA_DIR/cache/<sha256 of file>.*`.
- `libraries.ts`: read the global `sym-lib-table`, find a `.kicad_sym` by nickname,
  return the symbol text for `lib_symbols` insertion (with `extends` flattened).
- `projects.ts`: project id = first 10 hex of sha256(absolute path); recent list
  in `DATA_DIR/projects.json`; sidecar read/write next to the schematic; scan
  `PROJECTS_DIR` for `*.kicad_sch` (depth 2).
- `watch.ts`: `fs.watch` per open project, 300 ms debounce, emits `changed`;
  `/api/events` is an SSE stream of `{projectId, type}`.
- `service.ts`: `open`, `rebuild`, `getDoc`, `moveParts`, `setOptions`,
  `edit(kind, args)`. Edits: read file, check mtime equals the last read, copy to
  `.circuit-ai-backups/NAME-YYYYMMDD-HHMMSS.kicad_sch` (keep 20), apply span edits,
  write, re-run the pipeline, return the new doc plus the backup path.

## API and MCP

REST under `/api` (GET unless noted), documented by `/openapi.json`:

```
GET  /projects                      recent + scanned
POST /projects/open   {path}        -> {id, summary}
GET  /projects/:id                  summary
GET  /projects/:id/layout           LayoutDoc
GET  /projects/:id/board.svg|png    ?highlight=net|step
GET  /projects/:id/schematic.svg    via kicad-cli
GET  /projects/:id/steps | checks | truth-table | pinouts
POST /projects/:id/sim   {inputs}
POST /projects/:id/layout/options | move | colors | reset
POST /projects/:id/edit/add | connect | disconnect | remove | value
POST /projects/:id/erc
GET  /events                        SSE
GET  /connect                       snippets
GET  /parts                         supported catalog
```

MCP tools, one `McpServer` per request (stateless) and the same set over stdio:

| Tool | Purpose |
|---|---|
| `list_projects`, `open_schematic`, `refresh` | Find and open schematics by path |
| `get_summary` | Components, nets, board, check status, unplaced parts |
| `get_layout` | Full LayoutDoc JSON |
| `render_breadboard` | PNG image plus a text caption; optional net or step highlight |
| `render_schematic` | PNG of the KiCad schematic |
| `get_build_steps`, `get_checks`, `get_truth_table`, `get_pinout`, `explain_net` | Questions |
| `simulate` | Outputs and LED states for a set of input levels |
| `list_supported_parts` | Catalog with lib_ids the edit tools accept |
| `set_layout_options`, `move_part`, `set_net_color`, `reset_layout` | Layout edits |
| `add_component`, `connect`, `disconnect`, `remove_component`, `set_value` | Schematic edits |
| `run_erc` | KiCad ERC as JSON |

Every edit tool returns the new checks and the backup path, and ends with
"KiCad does not reload files changed on disk: use File > Revert if the project is
open". The server `instructions` string explains hole naming (`a1`..`j63`, rails
`T+ T- B+ B-`) and that layout edits never change the circuit.

### Schematic edit semantics

- `add_component(lib_id | name, value?, ref?, connections?: {pin: net})`. `name`
  may be a catalog alias ("74LS00", "LED", "10k resistor"). The symbol definition
  is copied into `lib_symbols` if absent. Placement: bounding box of existing
  content, then a grid to the right at 25.4 mm pitch, 1.27 mm snapped. The
  reference is the next free number of the prefix. For multi-unit chips a gate
  request first reuses a spare unit of an existing chip with the same value;
  otherwise a new chip is added with unit 1 and its power unit.
- `connect(ref, pin, net)`: a global label named `net` at the pin's end point,
  rotated to point away from the body. If `net` currently has only an automatic
  name (`Net-(R1-Pad1)`), a label is first placed on an existing pin of that net
  so the name becomes real. Power nets connect by adding a `power:*` symbol on the
  pin instead of a label.
- `disconnect(ref, pin)`: remove labels or power symbols that the app placed on
  that pin (tracked in the sidecar by uuid); labels drawn by hand are reported,
  not removed.
- `remove_component(ref)`: remove every unit of the symbol and app-placed labels
  on it.
- `set_value(ref, value)`: property edit in place.

After every edit the pipeline runs and the returned checks show whether the
intended nets exist. Pin positions are computed with the same transform the
tests validate against PL1_1's hand-placed labels.

## Client

Vanilla TypeScript, no framework. Routes: `#/` (recent projects, open box,
folder scan, connect link) and `#/p/<id>`. The board view mounts the SVG,
supports wheel zoom, drag to pan, drag a part to move it (snapped to holes, live
re-layout, drop saves the sidecar), hover to highlight a net, click a switch to
toggle it in the simulator. Panels: Guide, Parts, Pinouts, Checks, Truth table,
Options, Unplaced. A toolbar has board size, rail split, DIP switch folding, reset
layout, print, and download SVG/PNG. Light and dark themes through CSS variables.
`print.css` lays out the board and the guide for PDF via the browser.

## Error handling

- `kicad-cli` missing or failing: the message includes the command and `KICAD_CLI`.
- Hierarchical sheets or buses: "not supported" naming the sheet or bus.
- Layout failure: the doc still returns with `unplaced` filled and the error text;
  the board shows what could be placed.
- Stale write: refuse, ask to `refresh`.
- Path outside `PROJECTS_DIR` or the recent list: allowed only for absolute paths
  the user or assistant passes explicitly; the app never scans elsewhere.

## Efficiency

- Bun runs TypeScript directly; the compiled build (`bun build --compile`) is the
  packaging path from `desktop-packaging.md`.
- kicad-cli results are cached by file hash, so reopening costs nothing.
- The engine and renderer are pure and synchronous; a 60-part board lays out and
  renders in a few milliseconds, which is what makes browser-side drag possible.
- Hashed assets are served immutable; the SVG is inline, no fonts are loaded.

## Testing

`bun test`, fixtures under `test/fixtures/`:

- `sexpr`: parse and re-serialise KiCad files byte-identically for untouched spans.
- `transform`: for PL1_1, every hand-placed label sits on a computed pin end, and
  the netlist's pin to net mapping agrees.
- `netlist`: components, units merged, unconnected pins from libparts.
- `catalog`: each fixture part classifies as expected; unknown parts fall back.
- `engine`: for six fixtures (PL1_1, inverting op-amp with split 12 V supply, 555
  astable, transistor LED driver, 7447 + 7-segment + DIP switch, RC/RL filter): no
  hole conflicts, every design net connected per the checks, deterministic output,
  pinned placements honoured and dropped correctly.
- `sim`: PL1_1's XOR/NAND circuit produces the known truth table.
- `render`: valid SVG, one element per part and wire, highlight dims others.
- `writer`: add, connect, remove round-trip; when `kicad-cli` is installed, the
  exported netlist contains the intended nets (skipped otherwise).
- `api` and `mcp`: `app.request` and an in-memory MCP client exercise every route
  and tool against a fixture.

## Later improvements (not in this version)

- Native connectivity engine for sub-10 ms refresh without KiCad.
- Sequential logic in the simulator (74LS74, 74LS76, counters).
- SPICE operating point through KiCad's ngspice for the Circuits labs.
- Tauri launcher integration from `desktop-packaging.md`.

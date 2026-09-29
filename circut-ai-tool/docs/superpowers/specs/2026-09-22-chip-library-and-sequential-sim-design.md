# Chip library, unified logic dispatch and sequential simulation

Date: 2026-09-22
Status: approved, ready for implementation planning

## Problem

The tool places 30 `74LS` parts but only simulates 15 of them. The rest are
accepted by `add_component`, drawn on the breadboard and then silently reported
as "not simulated", which the user only discovers when the truth table comes
back empty.

Three specific gaps motivated this work:

1. **74LS151, 74LS153 and 74LS283 have no logic model.** They are placeable and
   unsimulated.
2. **74LS73 is not in the parts list at all**, and it is sequential: neither
   simulator has any notion of state or a clock edge.
3. **74LS73's supply pins are VCC 4 / GND 11**, not the 14/7 that
   `icInfo()` assumes for any unrecognised 14-pin part. Today the build guide
   would route its power rails to the wrong holes.

A fourth, structural problem makes all of the above more expensive than it
should be: **chip behaviour is dispatched twice.** `src/sim/index.ts` (boolean
fixed point) and `src/sim/analog/mixed.ts` (`driveNodes`) each carry their own
`gates` / `decoder` / `demux` branches, so every new chip kind must be written
twice and kept in step forever.

## Goals

- Functional simulation for 74LS151, 74LS153, 74LS283 and 74LS73.
- One definition per chip, consumed by both simulators.
- Correct supply pins and per-pin functions for every chip the tool knows.
- Sequential support good enough to run a ripple counter.
- A browsable catalogue of supported parts, for both a human and the MCP client.

## Non-goals

- Modelling the remaining unsimulated `74LS` parts (74, 76, 90, 93, 139, 157,
  161, 164, 165, 174, 175, 193). The mechanism this spec introduces makes each
  of them a single-entry addition later.
- Timing: propagation delay, setup/hold, metastability. Edges are instantaneous.
- Analog behaviour of the new chips beyond the existing `DRIVE` output model.

---

## 1. Unified chip logic

One interface in `src/parts/gates.ts` replaces the two hand-written dispatch
sites.

```ts
export type PinLevels = (pin: number) => 0 | 1;
export type ChipState = (0 | 1)[];        // one Q per sequential element

export interface ChipModel {
  inputs:  number[];                       // pins read (drives the analog input load)
  outputs: number[];                       // pins driven
  eval(read: PinLevels, state: ChipState): Record<number, 0 | 1>;
  sequential?: {
    clock: number[];                       // clock pin for element i
    reset(): ChipState;
    step(read: PinLevels, state: ChipState, edges: boolean[]): ChipState;
  };
}
```

### The existing 15 chips are not rewritten

`logicOf(spec: ChipSpec): ChipModel` **derives** a model from the data those
specs already carry. `74LS00` still gets its behaviour from `QUAD2` plus
`kind: 'nand'`; `74LS47` from `DECODER_PINS` plus `decoder: '7447'`; `74LS138`
from `DEMUX_PINS` plus `demuxOutputs()`. Nothing about their definitions
changes — only the interface through which they are consumed.

This is the core risk control: the 301 existing tests are a faithful
description of those 15 chips' behaviour, so if `logicOf()` derives any of them
incorrectly the suite fails. Only the four new chips hand-write an `eval`.

### Both simulators collapse

- `src/sim/index.ts`: the three loops over `model.gates`, `model.decoders` and
  `model.demuxes` become one loop over chips calling `eval`.
- `src/sim/analog/mixed.ts`: `driveNodes()` becomes the same single call.
  `AnalogChip` carries a `ChipModel` plus a pin → node map in place of its
  `gates` / `decoder` / `demux` fields.

A new chip afterwards is one entry in one file, and cannot drift between the
two paths.

---

## 2. Sequential simulation

### Three pure functions

- `settle(model, levels, state)` — combinational fixed point with each
  flip-flop's Q driven from `state`. No edge detection, no mutation.
- `advance(model, levels, state)` — settles; compares every chip's **clock pin
  level** against the level recorded in `state`; steps the elements that saw
  1 → 0; re-settles; repeats until no new edge appears (cap 64 iterations).
- `simulate(model, levels, state?)` — a thin wrapper over `settle`.
  Observational only.

Edge detection reads the chip's clock **pin**, not an externally driven net.
That is what makes a ripple counter work: FF1's Q falling clocks FF2 inside the
same `advance` call, because the loop re-settles and re-checks.

### Contract

> `simulate` observes. `pulse` advances. `reset_state` clears.

`simulate` reports `ffState` but never commits it. If it did, calling it twice
with identical arguments would return different answers — the reproducibility
problem that ruled out implicit edge detection.

### Asynchronous clear

`CLR̄` is not an edge event. A low `CLR̄` forces Q = 0 *during* `settle`,
continuously, so a held clear pins the outputs at 0 regardless of the clock,
matching the real part.

### State shape

```ts
interface SimState {
  q:   Record<string, ChipState>;   // ref -> per-element Q
  clk: Record<string, (0 | 1)[]>;   // ref -> last seen clock pin levels
}
```

`state` is optional everywhere and defaults to all-Q-zero with clocks high, so
all three non-test call sites (`client/simstate.ts`, `server/service.ts`,
`src/pipeline.ts`) and all 301 tests keep working unchanged.

### Truth table

When a model contains sequential chips, `truthTable()` sweeps the non-clock
switch inputs (J, K, CLR̄) and reports the characteristic table — Q before and
Q after one pulse — rather than a combinational sweep that would be meaningless.
Purely combinational designs are unaffected.

### Server and MCP surface

The server holds one `SimState` per open project, alongside the existing
`p.doc.sim.model`, so the MCP tools read naturally without the caller threading
state by hand.

| Tool | Signature | Effect on stored state |
|---|---|---|
| `simulate` | `(project, levels)` → `{ nets, leds, segments, ffState }` | none — observes at the current state |
| `pulse` | `(project, { clock, n = 1, levels? })` → `{ cycles: [{ nets, leds, ffState }] }` | commits after each edge |
| `reset_state` | `(project)` → `{ ffState }` | all Q = 0, clocks high |

`pulse` drives the named net high, then low — the active edge for a
negative-edge part — then high again, running `advance` at each step, and
returns the state after every cycle. `clock` is a net name, so it addresses the
board the way the rest of the API does.

Projects with no sequential chips return an empty `ffState`, and `pulse`
reports a clear error rather than silently doing nothing.

---

## 3. Chip data

Pinouts are DIP package pins, to be confirmed against the manufacturer
datasheet during implementation. `iccMax` values in particular feed the
supply-current check and must be read off the datasheet rather than recalled.

### 74LS151 — 8:1 multiplexer, DIP-16, VCC 16 / GND 8

| Signal | Pins |
|---|---|
| `D0`–`D3` | 4, 3, 2, 1 |
| `D4`–`D7` | 15, 14, 13, 12 |
| select `A`, `B`, `C` | 11, 10, 9 |
| `Y` | 5 |
| `W̄` | 6 |
| strobe `Ḡ` | 7 |

`sel = A + 2B + 4C`; `Y = Ḡ ? 0 : D[sel]`; `W̄ = ¬Y`.

### 74LS153 — dual 4:1 multiplexer, DIP-16, VCC 16 / GND 8

| Signal | Pins |
|---|---|
| `1C0`–`1C3` | 6, 5, 4, 3 |
| `2C0`–`2C3` | 10, 11, 12, 13 |
| select `A`, `B` (shared) | 15, 2 |
| `1Y`, `2Y` | 7, 9 |
| `1Ḡ`, `2Ḡ` | 1, 14 |

`sel = A + 2B`; `nY = nḠ ? 0 : nC[sel]`. Two independent muxes on one select
pair; each enable affects only its own output.

### 74LS283 — 4-bit binary adder with fast carry, DIP-16, VCC 16 / GND 8

| Signal | Pins |
|---|---|
| `A1`–`A4` | 5, 3, 13, 11 |
| `B1`–`B4` | 6, 2, 14, 10 |
| `Σ1`–`Σ4` | 4, 1, 12, 9 |
| `C0` | 7 |
| `C4` | 15 |

`A + B + C0` as a 5-bit result; `A1` is the LSB. This is the 283 pinout, which
differs from the 7483 — do not substitute one for the other.

### 74LS73 — dual JK flip-flop with clear, DIP-14, **VCC 4 / GND 11**

| Signal | Pins |
|---|---|
| `1CLK`, `1CLR̄`, `1K` | 1, 2, 3 |
| `1J` | 14 |
| `1Q`, `1Q̄` | 12, 13 |
| `2CLK`, `2CLR̄`, `2J` | 5, 6, 7 |
| `2K` | 10 |
| `2Q`, `2Q̄` | 9, 8 |

Negative-edge triggered. JK: `00` hold, `01` reset, `10` set, `11` toggle.
`CLR̄` low forces Q = 0 asynchronously.

The non-standard supply pins are why this chip needs a real `ChipSpec` rather
than the `icInfo()` fallback: `vcc: pinCount, gnd: pinCount / 2` yields 14/7,
which would route the power rails to the wrong breadboard holes in the build
guide and misreport the pinout table.

---

## 4. Parts library

One source of truth, three consumers. A new `src/parts/library.ts` joins
`PART_ALIASES` with the `CHIPS` specs:

```ts
interface LibraryPart {
  alias: string;
  libId: string;
  description: string;
  package: string;                        // 'DIP-16', 'TO-92', '2-lead', …
  vcc?: number;
  gnd?: number;
  simulated: boolean;                     // does it have a ChipModel?
  function: string;                       // '8:1 multiplexer, active-low strobe'
  pins?: { num: number; name: string; kind: 'in' | 'out' | 'power' | 'nc' }[];
}
```

- **Human** — a new `library` tab beside Guide / Simulate / Parts / Pinouts /
  Checks / Truth table / Options, rendering a grouped, searchable table: logic
  ICs, passives, switches, displays. Each row shows function, package, VCC/GND
  pins and a **Simulated** / **Placement only** badge.
- **AI** — `list_supported_parts` returns these records instead of the current
  `"74LS138 logic IC"` filler.
- **REST** — `GET /api/parts` backs both.

The `simulated` badge exists specifically to make the gap that motivated this
spec visible up front, rather than something discovered when a truth table
comes back empty.

Implementation touches `ProjectState['panel']` in `client/state.ts` and the
`TABS` array in `client/panels.ts`.

---

## 5. Testing

Written test-first.

**Gate 1 — the refactor is faithful.** All 301 existing tests pass unchanged
after `logicOf()` replaces the two dispatch sites, before any new chip is added.

**Gate 2 — the new chips.**

| Test | Coverage |
|---|---|
| 74LS151 | all 8 select codes route the right `D`; strobe high forces `Y=0, W̄=1`; `W̄ = ¬Y` always |
| 74LS153 | the two muxes are independent on a shared select; `1Ḡ` must not affect `2Y` |
| 74LS283 | exhaustive: all 16 × 16 × 2 = 512 combinations of A, B, C0 assert the 5-bit result equals `A + B + C0` |
| 74LS73 | characteristic table on a falling edge; **no** change on a rising edge; `CLR̄` asynchronous; `Q̄ = ¬Q` |
| ripple counter | both halves of a 73, Q1 clocking FF2, pulsed 4 times, walks 00 → 01 → 10 → 11 |
| parity | for each new chip, the boolean path and the mixed-signal path produce identical levels |
| power pins | 74LS73 pinned to VCC 4 / GND 11, and the build guide places its rails accordingly |
| library | `list_supported_parts` reports `simulated: true` for 151/153/283/73; the new tab renders |

The parity test is the structural one: it is what mechanically enforces the
"two simulators cannot drift" property that section 1 exists to create.

## Risks

- **`logicOf()` derivation is subtly wrong for an existing chip.** Mitigated by
  gate 1: the refactor lands and goes green before any new behaviour is added.
- **`advance()` fails to terminate** on a circuit with combinational feedback
  around a flip-flop. Mitigated by the 64-iteration cap, matching the existing
  fixed-point loop's cap, and reported as a warning rather than a hang.
- **Datasheet values taken from recall rather than the datasheet.** Mitigated by
  an explicit verification pass on every pin number and `iccMax` before the
  chip data lands.

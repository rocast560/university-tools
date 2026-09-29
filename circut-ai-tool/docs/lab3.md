# Lab 3 auxiliary board and prelab example

Open the home page and select **Create Lab 3 prelab example**. Each click
creates a separate editable KiCad project. The part picker also contains
**L3 Auxiliary** and **common anode 7-segment display**.

## What the instructor board does

The supplied `Lab3_Auxiliary_Circuit.pdf` identifies VCC, GND, W, X, Y, Z
inputs; inverted W, X, Y, Z outputs; and segment outputs a, b, c, d.
The lab requires the student to build e, f, g. WXYZ uses weights 8,4,2,1.
The display is common anode: an output of 0 lights its segment.
This polarity agrees with [TI's common-anode decoder documentation](https://www.ti.com/product/SN74LS47),
but the instructor board is not identified as a 7447 and is not modeled as one.

The tool counts header positions from top to bottom in the PDF:

| Position | Label | Function |
|---|---|---|
| 1–2 | VCC, GND | +5 V supply and ground |
| 3–6 | W, X, Y, Z | BCD inputs |
| 7 | Unlabeled separator | Reserved; leave unwired |
| 8–11 | ~W, ~X, ~Y, ~Z | Inverted inputs |
| 12–15 | a, b, c, d | Active-low segment outputs |

These are header-position identifiers, not the hidden IC's pin numbers.

## Mechanical model

The PDF gives no dimensions, so the tool measures its photo against the
header's own 0.1 inch pitch (`L3_BOARD` in `src/parts/lab3.ts`):

| Feature | Size |
|---|---|
| Board | about 18 by 13 pitches (46 x 33 mm) |
| Header | 15 positions in one row, half a pitch in from one long edge, two pitches of board past each end |
| Socket | wide DIP, pin rows 5.5 and 11.5 pitches beyond the header, 15 positions per row |

The header is the board's only breadboard connection, so the tool plugs it
into the outer row **a** (row j when pinned there) of 15 consecutive
columns and lets the body hang outward, over that side's supply rails and
off the edge of the breadboard. That leaves rows b-e of every header column
free for jumpers. The rail holes under the body, columns `col0-2` to
`col0+16`, are claimed by the board so no jumper or supply lead lands
beneath it; rail jumpers go to the next free rail hole outside that span.
The 2D and 3D views draw the board at this size, and the drawing grows
upward to hold the overhang.

## Expressions and complete circuit

`n` denotes NOT, juxtaposition denotes AND, and `+` denotes OR.
The a–d expressions follow `prelab-content-example.jpg`:

```
a = Wn Xn Yn Z + X Yn Zn
b = X (Y XOR Z)
c = Xn Y Zn
d = a + X Y Z
e = Z + X Yn
f = Wn Xn Z + Xn Y + Y Z
g = Wn Xn Yn + X Y Z
```

The example shares `t = Wn Xn` and `yz = Y Z`, using seven AND gates
(two 74LS08 packages) and four OR gates (one 74LS32) for e–g. U1 supplies a–d
and the complemented inputs. The unused AND gate has both inputs grounded.
Four 4.7 kΩ pull-ups hold the inputs high; closing a DIP switch pulls its
input low. Both display anodes connect to +5 V. Each segment has its own
330 Ω resistor, matching the whiteboard. Three 100 nF capacitors decouple
the discrete logic chips.

The example uses the stock KiCad **SA39-11EWA** symbol. Its segment pins are
a=10, b=9, c=7, d=5, e=4, f=2, g=1, with common anodes 3 and 8 and unused
decimal point 6. The instructor does not identify the actual display part;
verify its pinout before copying these numbers to hardware.

| Decimal | WXYZ | abcdefg (0 = on) |
|---|---|---|
| 0 | 0000 | 0000001 |
| 1 | 0001 | 1001111 |
| 2 | 0010 | 0010010 |
| 3 | 0011 | 0000110 |
| 4 | 0100 | 1001100 |
| 5 | 0101 | 0100100 |
| 6 | 0110 | 0100000 |
| 7 | 0111 | 0001111 |
| 8 | 1000 | 0000000 |
| 9 | 1001 | 0000100 |

Inputs 10–15 are don't-care cases. The simulator evaluates the chosen
equations for them; those results are not a claim about the instructor's
hardware. No minimum global gate-count claim is made.

## Simulation limits and verification

The digital model is verified against all ten decimal patterns, including
the four inverted outputs. Layout tests check a single-row header, reserved
position, and absence of wiring errors. KiCad exports the included schematic
and netlist, so these tests exercise actual schematic connections.

The instructor PDF does not identify the internal chip or its output-current
ratings. The analog simulation uses an approximate LS gate equivalent and
does not include the module's unknown supply current. It cannot validate the
module's load capacity or actual segment brightness. The existing analog
solver does not model the seven-segment package; use the logic display and
truth table to verify digits. The checks surface these model limits.

Sources: `ECE-2300L_Lab3.pdf`, `Lab3_Auxiliary_Circuit.pdf`,
`BCD-to-7-Segment_Reference.pdf`, and `prelab-content-example.jpg` in the
user-provided Lab 3 folder; the installed KiCad 9 display and logic symbols.

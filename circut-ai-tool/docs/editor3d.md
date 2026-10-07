# The 3D editor

A full-screen 3D view of the breadboard where you can add parts from a tray, select and move them, turn or flip them, duplicate or delete them, edit their values, draw jumpers, and shape the jumper wires by hand. It works on the same project as the flat board.

## Opening and closing

Press **3D** in the project toolbar. The button then reads **Exit 3D**. The editor closes on any of:

- Esc, when nothing is selected and no drag is in progress
- the **Exit** button in the editor's bar
- **Exit 3D** in the toolbar
- the browser's Back button

Closing while the 3D library is still loading is safe. Undo history is discarded on close, and so is the selection, so the flat board is not left dimmed around the part you last picked. On the flat board, clicking off any part also clears it.

## Moving around

- Drag on empty board, or on any part that is not selected, to orbit.
- Right-drag pans. Scroll zooms.
- **F** with a part or a wire selected flies the camera to frame it. Double-clicking a part selects it and does the same.
- **F** with nothing selected, or the **Fly through** button, enters fly mode: W, A, S, D move, the mouse looks, Space and C go up and down, Shift sprints. **F** or **Esc** returns to orbit.
- **F** is ignored while a drag is in progress.
- The **Wires** button in the bar switches jumpers between curved arcs and square-cornered runs, the same setting as the page toolbar's. The board rebuilds in place and the camera stays put.
- The **Detail** button switches parts between real KiCad bodies (**Detail: high**) and simple drawn shapes (**Detail: simple**). See Part models.

## Selecting and moving parts

Click a part to select it. Click empty board to deselect.

Only a part that is already selected can be dragged. A press anywhere else orbits, so the camera never fights a move. Drag the selected part; its legs snap to holes as you go. Chips move by columns only.

While dragging, the strips under each leg are tinted:

- green: the leg fits
- red: the placement is refused

The hint line at the top says why. Releasing on red leaves the part where it was and shows a "Not moved" message. Esc cancels a drag.

Refusal reasons:

| Reason | Example |
|---|---|
| The hole is taken | `hole d12 is taken by R2` |
| Off the board | `pin 2 would be off the board at j31` |
| Shorts two nets | `pin 1 would short VCC to GND at c10` |
| Shorts itself | `R1's pins would short each other in one strip`, or for a two-lead part `R1's legs would short each other in one strip at c10` (refused whatever its nets, since both legs in one strip do nothing) |
| Chip not across the channel | `U1 has to straddle the centre channel (rows e and f)` |

The layout engine also checks each drop. If it would refuse the pinned placement, its reason is shown instead.

## Turning and flipping

- **R** turns a two-lead part a quarter turn clockwise about pin 1.
- **Shift+R** flips a chip end for end.
- Holding the key does not repeat the action.

Placement is what-you-see-is-what-you-get: legs go exactly where the holes are, and nothing is rerouted around them. So a turn or flip is refused when the result would collide. Most quarter turns of a resistor lying inside one half are refused, because the turned leg lands in the same strip as the other leg and shorts the part to itself. A chip flip swaps which strips its pins use, so it is often refused until the parts sharing those strips have been moved. A message names the reason.

## The part card

Selecting a part shows a card beside it.

- **Value:** edit the box and press Enter. This rewrites the schematic value.
- **Pins:** each pin, its hole, and its net. Click a net to follow it on the board.
- **Rotate** and **Flip** buttons do the same as R and Shift+R. **Focus** is F.
- **Duplicate** is D; see Duplicate and delete.
- **Delete** (or the Delete or Backspace key) asks in the card: "Remove R1 from the schematic? A backup is kept." **Remove** deletes the part from the `.kicad_sch`; **Keep** cancels.

The Delete key only works when the card is visible on screen and you are not typing in the value box.

## Adding parts

The tray runs across the top of the editor. It has a search box, a row of group chips (Basic, Passives, Indicators, Inputs, Logic, All) and a tile for each part. Basic is the lab kit's everyday parts. Typing in the search box searches every part and ignores the chips. Press **/** to jump to the search box.

Tray pictures are flat 2D drawings of each part. 3D thumbnails are not in yet (see Coming next). The parts you drop use the same bodies as the rest of the board (see Part models).

There are two ways to place a part:

- Drag its tile onto the board and let go over a hole.
- Tap the tile to arm it, then click a hole. The tile stays armed until you place the part, press Esc, tap the tile again, or pick another tool. An armed click never selects or orbits.

Either way a ghost follows the pointer and shows where the legs would go. The strips under the legs are tinted with the same green and red as a move, and the hint line gives the reason when a spot is refused. A refused drop adds nothing. A chip has to straddle the centre channel, so its ghost is red anywhere but rows e and f.

A drop adds a real component to the schematic: the server saves a backup of the `.kicad_sch`, adds the part, and then moves it onto the holes you chose. A leg dropped into a strip that already carries one net joins that net. A leg in an empty strip stays unconnected. A chip is always a new package, even when a chip of the same kind on the board has a spare gate. Each chip leg that joins a net adds the gate it belongs to in the schematic. The new part is selected, and if it has a value, the value box in its card is focused so you can type one.

Displays, modules and kinds the board cannot draw as plain legs are placed automatically. The ghost shows a single marker, and the hint says "placed automatically". If the move onto your holes is refused after the part was added, the part stays in the schematic where the board put it and a message says so.

Adding a part is a schematic edit, so it is not on Ctrl+Z. See What changes what.

## Drawing a jumper

Press **W**, or the **Wire** button in the bar, to turn on the wire tool. The hint line reads "click a hole to start a jumper". Click a hole, then click a second one. You can also press on the first hole, drag, and release over the second. A ghost jumper follows the pointer, both strips are tinted, and the hint says what the jumper would do.

What a jumper does depends on the nets in the two strips:

| The two strips | Result |
|---|---|
| One has a net and the other holds legs that are on no net | Those legs join the net. This edits the schematic after a backup |
| Both are on the same net | No change. The router already lays the jumper that connects them |
| Each is on a different net | Refused: "would join A and B. Merge nets in the schematic" |
| Either strip already joins two nets | Refused: "that strip already joins two nets" |
| Both holes are in the same strip | Refused: "both ends are in the same strip" |
| Neither strip has a net, or the empty one has no legs in it | Refused: "nothing to connect yet. Place a part first" |

A chip leg whose gate the schematic does not use yet (U1 pin 13 when only gate A of a 74LS86 is drawn) can be joined too: the server adds that gate to the schematic first, then labels the pin. If a strip holds several loose legs and one cannot be joined, the message names the legs that were joined and the one that failed.

Two different nets are refused because a jumper between them would short them, and a jumper cannot say which net should win. Joining them is a decision about the circuit, so it is made in the schematic.

Esc or a right-click drops a jumper that is half drawn and keeps the tool on. Esc with nothing half drawn turns the tool off, and so does **W** a second time. A press that starts off the holes still orbits.

The tool does not take bends. The router lays the jumper, and you shape it afterwards from the wire card, as described under Wires.

The tray and the wire tool exclude each other: starting one stops the other.

## Duplicate and delete

**D**, or **Duplicate** in the part card, adds another part of the same kind and value as the selected one. It connects to nothing. A chip's copy is a new package, never a spare gate of the original. The copy goes to the nearest free spot to the right of the original, up to 20 columns away. If none is free, the board places it and a message says "placed automatically". The copy is selected.

Part kinds that are not in the tray cannot be duplicated, and a message says so.

**Delete** (or the Delete or Backspace key) asks in the card first; see The part card. Both are schematic edits and neither is on Ctrl+Z.

## Wires

The **Wires** button switches between curved arcs and square wires. Square wires are the ones you can shape.

Square wires lie flat on the board, the way a carefully hand-wired board looks: straight up out of each hole, down onto the plastic, along the gaps between the rows with tight square bends, and back down into the other hole. They never cross a chip. Stacked boards get the same treatment: each board's own wires are routed on that board. The wires that join two boards are routed after them, shortest first, across the whole stack, round everything already laid and a lane clear of every other wire, so most drop through the gap between the boards as a plain Z. Joining wires have no handles. Wires that share a gap run side by side in lanes, ordered so that a bundle does not cross itself where its wires peel off. Where two wires still meet, crossing, turning a corner on each other or sharing a stretch of one line, the one laid later hops over the other, joining wires last. The hump keeps one wire's thickness plus a little air between the two all round, not only straight above the crossing, and clears any hump the lower wire is making there. The flat board's square view draws exactly the same paths.

Click a wire to select it. Its net is followed softly, an accent line runs along it, and the wire card opens beside it:

- the net and the two holes it joins, and its length along the board;
- colour swatches. Colour belongs to the net, so every jumper of that net changes. Keys 1 to 9 do the same: 1 red, 2 black, 3 blue, 4 green, 5 orange, 6 yellow, 7 white, 8 violet, 9 grey;
- **Re-route** (only for a wire you have shaped, or one with no clean route) forgets its shape;
- **Tidy all wires** (when any wire has been shaped) forgets every shape.

With square wires, a selected wire has handles:

- a large disc at the middle of every run longer than about two pitches. Drag it to slide that run sideways. It snaps to the lanes between the rows (or between the columns), never onto a row or column of holes. The run coming out of a hole cannot leave its hole, so it gets a small jog half a pitch out;
- a small disc on every bend. Drag it to move the corner; the two runs either side follow.

Double-click a wire to put a small Z (two new bends) into the run under the pointer. Double-click a bend, or click it (it turns white) and press Delete, to take it out again. A bend that holds a wire's end straight out of its hole cannot be removed.

While you drag, the wire follows the pointer. It turns red, and the hint line says why, when the shape would cross a chip, leave the board, or lie over a leg or another jumper's end; releasing then leaves the wire as it was. When you release a valid shape it is saved and every other wire is routed again around it.

Deselecting a wire (Esc, or clicking off it) also lets go of the soft highlight on its net.

### Wires with no clean route

If the router cannot find a clean path in time, it draws that wire the simple way, which may pass over a chip. It shows red in 3D and dashed on the flat board, and the checks name it. Such a wire has no handles; its card says "No clean route: move nearby parts to make room, then Re-route." Shaping only works with square wires, so with arcs the card offers colour only.

### How shapes are kept

A shape is saved in the layout sidecar (`NAME.breadboard.json`, under `wirePaths`, at most 1024 of them), never in the schematic. It is keyed by the wire's net and its two holes, and it records only the bends, in board units (columns, the gap between two rows, and a lane within that gap), so it survives the board changing size. If a part moves so that the wire's holes change, the old shape no longer matches any wire. The wire is routed automatically, and the checks list a warning naming the net. The shape itself is kept in the sidecar, so moving the part back brings it back; **Tidy all wires** forgets it. If a shape still matches its wire but no longer fits (a part now stands where it runs), it is routed automatically too, and the checks say why. The server checks a shape with the same test the router uses and refuses one that is not square, leaves the board, crosses a chip or lies over a leg or another jumper's end.

## Undo

Ctrl+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes, and the bar has Undo and Redo buttons.

Covered: moves, turns and flips, and wire shapes (a drag, a new or removed bend, Re-route and Tidy all wires). They run one at a time, in order. Undoing Tidy all wires restores only the shapes whose wires still exist.

Not covered: wire colours, value edits, deletes, tray drops, wire tool joins and duplicates. The last five change the schematic, and the server saves a copy of the `.kicad_sch` before each one in a `.circuit-ai-backups` folder next to the schematic (the newest 20 are kept). Restore from there by hand.

The history is cleared when the project changes, when the schematic reloads (any value edit, delete, tray drop, joined jumper or duplicate, from the card, an agent or KiCad), and when the editor closes. If an undo or redo fails (the part is gone, the server refused), that step is dropped with a message and the next Ctrl+Z reaches the one before it.

## What changes what

| Action | Changes the layout sidecar | Changes the .kicad_sch |
|---|---|---|
| Move, turn, flip (and their undo) | Yes (`NAME.breadboard.json`, pinned holes) | No |
| Shape a wire, Re-route, Tidy all wires | Yes (`wirePaths`) | No |
| Wire colour (swatch or 1 to 9) | Yes (`colors`, per net) | No |
| Edit value | No | Yes, after a backup |
| Delete part | No | Yes, after a backup |
| Drop a part from the tray | Yes, pinned holes (if the move is accepted) | Yes, after a backup |
| Wire tool joining legs to a net | No | Yes, after a backup |
| Duplicate | Yes, pinned holes | Yes, after a backup |
| Wire tool, same net or refused | No | No |
| Select, orbit, fly, focus | No | No |
| Toggle a switch, walk-through steps | No | No |

Tray drops, wire tool joins, duplicates and deletes are not on Ctrl+Z. The backup is how you go back.

## Shortcuts

| Key | Action |
|---|---|
| Click | Select a part or a wire |
| Drag (on the selected part) | Move it |
| Drag (elsewhere) | Orbit |
| Right-drag, scroll | Pan, zoom |
| Double-click a part | Select and focus |
| F | Focus the selection; with none, enter fly mode; in fly mode, back to orbit |
| W A S D, Space, C, Shift | Fly mode movement |
| / | Focus the tray search |
| W | Turn the wire tool on or off |
| D | Duplicate the selected part |
| R | Turn a two-lead part |
| Shift+R | Flip a chip |
| Drag a wire handle | Slide a run, or move a bend |
| Double-click a wire | Add a pair of bends |
| Double-click a bend | Remove it |
| 1 to 9 | Recolour the selected wire's net |
| Delete, Backspace | With a bend picked, remove it; otherwise open the delete confirm in the part card |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z, Ctrl+Y | Redo |
| Esc | Cancel a tray drag or armed part, or a half-drawn jumper (then turn the wire tool off); cancel a move drag; else unpick a bend; else deselect the wire or part; else close. In fly mode, back to orbit |

Ctrl, Cmd and Alt chords other than the undo and redo ones are left to the browser, so Ctrl+F finds and Ctrl+R reloads as usual.

## Part models

With **Detail: high**, six parts of the lab kit are drawn on the real KiCad 3D bodies instead of simple shapes:

| Part | Model key | KiCad footprint |
|---|---|---|
| 14-pin chip | `dip14` | `Package_DIP:DIP-14_W7.62mm` |
| 16-pin chip | `dip16` | `Package_DIP:DIP-16_W7.62mm` |
| 7-position DIP switch | `dipswitch7` | `Button_Switch_THT:SW_DIP_SPSTx07_Slide_9.78x19.96mm_W7.62mm_P2.54mm` |
| Seven-segment display | `seg056` | `Display_7Segment:7SegmentLED_LTS6760_LTS6780` |
| 5 mm LED | `led5` | `LED_THT:LED_D5.0mm` |
| Axial resistor | `r0207` | `Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` |

Every other part (modules, and chips or switches of other sizes) keeps its simple shape.

Some things stay drawn in code on top of the body, because they follow the board or change while it runs:

- Every leg. Legs run from the body to whichever hole the part is on, so they follow a move. The model files have their own legs removed.
- The chip's printed label and pin-1 notch.
- The DIP switch's sliders, which toggle.
- The display's segments.
- The LED's glow.
- The resistor's colour bands and leads.

A body sits where the simple shape would. Pins 1 and 2 set which way it faces, and the middle of all its pins goes on the middle of all its holes. The board draws the centre channel narrower than it is, so rows e and f are 5.08 mm apart where a chip's rows are 7.62 mm. Each body is squeezed across its pin rows by the same ratio, as the simple shapes always were, so its far row lands on its holes and it covers no hole a jumper uses. Along the rows it keeps its real size. The display still stands 2.5 mm off the board on its pins.

The bodies are GLB files in `public/models/`, listed in `manifest.json`, which records each model's file, footprint, pad positions and bounding box. The client loads them once when the editor opens. The flat board does not use them.

### Detail: high and simple

**Detail** in the editor's bar switches the whole board between the two looks. The choice is remembered in the browser (`localStorage`, key `benchmate.3dDetail`) and defaults to high. Simple shapes are also used for any part whose model is missing: if the manifest or a file cannot be fetched or parsed, the editor logs one warning in the console for it and draws that part the simple way. If the model loader itself cannot be fetched (after a redeploy, say), every part is drawn the simple way, with one warning, and the next open tries again. The editor always opens.

### Adding or changing a model

1. Add an entry to `KIT_MODELS` in `src/models/manifest.ts` with the KiCad footprint id, and extend `modelKeyFor` in the same file so the right parts map to the new key.
2. Run `bun run models`.
3. Commit the changed files in `public/models/`.

`bun run models` needs a local KiCad 9, since it exports each footprint's 3D model with `kicad-cli`. The default paths are KiCad's per-user Windows install, `%LOCALAPPDATA%\Programs\KiCad\9.0`; set `KICAD_CLI`, `KICAD_FOOTPRINT_DIR` and `KICAD_3DMODEL_DIR` to point elsewhere. The script removes the legs by material: a material is treated as legs only when it looks like metal and every cluster of it below the board sits on a pad. KiCad marks every material as metallic, so the pad test is what keeps light body parts, such as a display case, from being stripped. It prints each material and whether it was stripped. If any model fails (a footprint is missing, no orientation fits the pads), it writes nothing and exits with the reason, so `public/models/` is never left half updated. KiCad is not needed to run the app, only to regenerate the models.

### License

The models come from the KiCad 3D library, CC-BY-SA 4.0 with the KiCad libraries exception. The converted files keep that license. See `public/models/LICENSE-KiCad-3D.md`.

## Troubleshooting

- **Parts look like plain shapes.** Detail is set to simple, or a model failed to load. Press **Detail** to switch to high; the browser console names any model that could not be loaded.
- **3D is blank.** WebGL is off or unavailable. Enable hardware acceleration in the browser, or try another browser.
- **A tray part will not drop.** Read the hint line: it names why the spot is refused (a taken hole, off the board, or a chip not across the channel). Try another spot.
- **The wire tool refused a jumper.** Two different nets cannot be joined from 3D. Merge them in the schematic. A jumper between strips already on one net changes nothing.
- **A part will not move.** Read the hint line while dragging; it gives the reason. Select the part first: an unselected part orbits instead of moving.
- **A wire is red in 3D, or dashed on the flat board.** The router could not find a clean path for it in time and drew it the simple way, which may pass over a chip. The checks name it. Moving a part to open up room usually fixes it; such a wire cannot be shaped until it has a clean route.
- **A wire's shape went back to the automatic one.** One of its holes changed (a part moved), so the saved shape no longer matched the wire, or a part now stands where the shape ran. The checks list which one and why.
- **The 3D view closed with a "graphics context" message.** The browser took WebGL away (a GPU reset, or too many 3D pages open). Press 3D to open it again.
- **The board reloaded by itself.** Any schematic change reloads the board: a value edit or delete from the card, an agent's edit over MCP or the REST API, or a save in KiCad. The selection, switches, running simulation, walk-through step and followed net carry over where they still exist in the new design; the undo history does not. Only a change made outside the tool (KiCad, another program) shows the "Schematic changed on disk" notice.

## Coming next

- 3D tray thumbnails. Tray tiles are flat 2D pictures until then. High-fidelity part models are done (see Part models).

## References

- Tinkercad Circuits workspace: https://www.tinkercad.com/help-center/circuits-workspace
- Fritzing keyboard and mouse reference: https://fritzing.org/learning/full_reference/keyboard-mouse
- Wokwi diagram editor: https://docs.wokwi.com/guides/diagram-editor
- Wybrow, Marriott and Stuckey, libavoid (2009): https://users.monash.edu/~mwybrow/papers/wybrow-gd-2009.pdf
- three.js OutlinePass: https://threejs.org/docs/pages/OutlinePass.html
- three.js TransformControls: https://threejs.org/docs/pages/TransformControls.html
- WCAG 2.2 SC 2.5.7 Dragging Movements: https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html

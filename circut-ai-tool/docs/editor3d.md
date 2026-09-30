# The 3D editor

A full-screen 3D view of the breadboard where you can select parts, move them, turn or flip them, edit their values, and shape the jumper wires by hand. It works on the same project as the flat board.

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
- **F** with a part selected flies the camera to frame it. Double-clicking a part selects it and does the same.
- **F** with nothing selected, or the **Fly through** button, enters fly mode: W, A, S, D move, the mouse looks, Space and C go up and down, Shift sprints. **F** or **Esc** returns to orbit.
- **F** is ignored while a drag is in progress.
- The **Wires** button in the bar switches jumpers between curved arcs and square-cornered runs, the same setting as the page toolbar's. The board rebuilds in place and the camera stays put.

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
- **Delete** (or the Delete or Backspace key) asks in the card: "Remove R1 from the schematic? A backup is kept." **Remove** deletes the part from the `.kicad_sch`; **Keep** cancels.

The Delete key only works when the card is visible on screen and you are not typing in the value box.

## Wires

The **Wires** button switches between curved arcs and square wires. Square wires are the ones you can shape.

Square wires lie flat on the board, the way a carefully hand-wired board looks: straight up out of each hole, down onto the plastic, along the gaps between the rows with tight square bends, and back down into the other hole. They never cross a chip. Wires that share a gap run side by side in lanes, ordered so that a bundle does not cross itself where its wires peel off. Where two wires still cross, the one laid later hops over the other, clear of any hop the lower one is making there. The flat board's square view draws exactly the same paths.

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

A shape is saved in the layout sidecar (`NAME.breadboard.json`, under `wirePaths`, at most 1024 of them), never in the schematic. It is keyed by the wire's net and its two holes, and it records only the bends, in board units (columns, the gap between two rows, and a lane within that gap), so it survives the board changing size. If a part moves so that the wire's holes change, the old shape no longer matches any wire: it is dropped, and the checks list a warning naming the net. The server checks a shape with the same test the router uses and refuses one that is not square, leaves the board, crosses a chip or lies over a leg or another jumper's end.

## Undo

Ctrl+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes, and the bar has Undo and Redo buttons.

Covered: moves, turns and flips, and wire shapes (a drag, a new or removed bend, Re-route and Tidy all wires). They run one at a time, in order. Undoing Tidy all wires restores only the shapes whose wires still exist.

Not covered: wire colours, value edits and deletes. They change the schematic, and the server saves a copy of the `.kicad_sch` before each one in a `.circuit-ai-backups` folder next to the schematic (the newest 20 are kept). Restore from there by hand.

The history is cleared when the project changes, when the schematic reloads (any value edit or delete, from the card, an agent or KiCad), and when the editor closes. If an undo or redo fails (the part is gone, the server refused), that step is dropped with a message and the next Ctrl+Z reaches the one before it.

## What changes what

| Action | Changes the layout sidecar | Changes the .kicad_sch |
|---|---|---|
| Move, turn, flip (and their undo) | Yes (`NAME.breadboard.json`, pinned holes) | No |
| Shape a wire, Re-route, Tidy all wires | Yes (`wirePaths`) | No |
| Wire colour (swatch or 1 to 9) | Yes (`colors`, per net) | No |
| Edit value | No | Yes, after a backup |
| Delete part | No | Yes, after a backup |
| Select, orbit, fly, focus | No | No |
| Toggle a switch, walk-through steps | No | No |

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
| R | Turn a two-lead part |
| Shift+R | Flip a chip |
| Drag a wire handle | Slide a run, or move a bend |
| Double-click a wire | Add a pair of bends |
| Double-click a bend | Remove it |
| 1 to 9 | Recolour the selected wire's net |
| Delete, Backspace | With a bend picked, remove it; otherwise open the delete confirm in the part card |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z, Ctrl+Y | Redo |
| Esc | Cancel a drag; else unpick a bend; else deselect the wire or part; else close. In fly mode, back to orbit |

Ctrl, Cmd and Alt chords other than the undo and redo ones are left to the browser, so Ctrl+F finds and Ctrl+R reloads as usual.

## Troubleshooting

- **3D is blank.** WebGL is off or unavailable. Enable hardware acceleration in the browser, or try another browser.
- **A part will not move.** Read the hint line while dragging; it gives the reason. Select the part first: an unselected part orbits instead of moving.
- **A wire is red in 3D, or dashed on the flat board.** The router could not find a clean path for it in time and drew it the simple way, which may pass over a chip. The checks name it. Moving a part to open up room usually fixes it; such a wire cannot be shaped until it has a clean route.
- **A wire's shape went back to the automatic one.** One of its holes changed (a part moved), so the saved shape no longer matched the wire. The checks list which one.
- **The 3D view closed with a "graphics context" message.** The browser took WebGL away (a GPU reset, or too many 3D pages open). Press 3D to open it again.
- **The board reloaded by itself.** Any schematic change reloads the board: a value edit or delete from the card, an agent's edit over MCP or the REST API, or a save in KiCad. The selection, switches, running simulation, walk-through step and followed net carry over where they still exist in the new design; the undo history does not. Only a change made outside the tool (KiCad, another program) shows the "Schematic changed on disk" notice.

## Coming next

- Phase 3: a parts tray, dragging new parts and jumpers onto the board, and Duplicate.

## References

- Tinkercad Circuits workspace: https://www.tinkercad.com/help-center/circuits-workspace
- Fritzing keyboard and mouse reference: https://fritzing.org/learning/full_reference/keyboard-mouse
- Wokwi diagram editor: https://docs.wokwi.com/guides/diagram-editor
- Wybrow, Marriott and Stuckey, libavoid (2009): https://users.monash.edu/~mwybrow/papers/wybrow-gd-2009.pdf
- three.js OutlinePass: https://threejs.org/docs/pages/OutlinePass.html
- three.js TransformControls: https://threejs.org/docs/pages/TransformControls.html
- WCAG 2.2 SC 2.5.7 Dragging Movements: https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html

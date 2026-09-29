# The 3D editor

A full-screen 3D view of the breadboard where you can select parts, move them, turn or flip them, and edit their values. It works on the same project as the flat board.

## Opening and closing

Press **3D** in the project toolbar. The button then reads **Exit 3D**. The editor closes on any of:

- Esc, when nothing is selected and no drag is in progress
- the **Exit** button in the editor's bar
- **Exit 3D** in the toolbar
- the browser's Back button

Closing while the 3D library is still loading is safe. Undo history is discarded on close.

## Moving around

- Drag on empty board, or on any part that is not selected, to orbit.
- Right-drag pans. Scroll zooms.
- **F** with a part selected flies the camera to frame it. Double-clicking a part selects it and does the same.
- **F** with nothing selected, or the **Fly through** button, enters fly mode: W, A, S, D move, the mouse looks, Space and C go up and down, Shift sprints. **F** or **Esc** returns to orbit.
- **F** is ignored while a drag is in progress.

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
| Shorts itself | `R1's pins would short each other in one strip` |
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

## Undo

Ctrl+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes, and the bar has Undo and Redo buttons.

Covered: moves, turns and flips. They run one at a time, in order.

Not covered: value edits and deletes. They change the schematic, and the server saves a copy of the `.kicad_sch` before each one in a `.circuit-ai-backups` folder next to the schematic (the newest 20 are kept). Restore from there by hand.

The history is cleared when the project changes or the editor closes.

## What changes what

| Action | Changes the layout sidecar | Changes the .kicad_sch |
|---|---|---|
| Move, turn, flip (and their undo) | Yes (`NAME.breadboard.json`, pinned holes) | No |
| Edit value | No | Yes, after a backup |
| Delete part | No | Yes, after a backup |
| Select, orbit, fly, focus | No | No |
| Toggle a switch, walk-through steps | No | No |

## Shortcuts

| Key | Action |
|---|---|
| Click | Select a part |
| Drag (on the selected part) | Move it |
| Drag (elsewhere) | Orbit |
| Right-drag, scroll | Pan, zoom |
| Double-click a part | Select and focus |
| F | Focus the selection; with none, enter fly mode; in fly mode, back to orbit |
| W A S D, Space, C, Shift | Fly mode movement |
| R | Turn a two-lead part |
| Shift+R | Flip a chip |
| Delete, Backspace | Open the delete confirm in the card |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z, Ctrl+Y | Redo |
| Esc | Cancel a drag; else deselect; else close. In fly mode, back to orbit |

Ctrl, Cmd and Alt chords other than the undo and redo ones are left to the browser, so Ctrl+F finds and Ctrl+R reloads as usual.

## Troubleshooting

- **3D is blank.** WebGL is off or unavailable. Enable hardware acceleration in the browser, or try another browser.
- **A part will not move.** Read the hint line while dragging; it gives the reason. Select the part first: an unselected part orbits instead of moving.
- **My change vanished.** When the `.kicad_sch` is changed on disk by something else (KiCad, an agent), the board reloads. That resets the selection and the undo history. Edits made from the card do not trigger this.

## Coming next

- Phase 2: clean wire routing and hand-shaped wires.
- Phase 3: a parts tray, dragging new parts and jumpers onto the board, and Duplicate.

## References

- Tinkercad Circuits workspace: https://www.tinkercad.com/help-center/circuits-workspace
- Fritzing keyboard and mouse reference: https://fritzing.org/learning/full_reference/keyboard-mouse
- Wokwi diagram editor: https://docs.wokwi.com/guides/diagram-editor
- Wybrow, Marriott and Stuckey, libavoid (2009): https://users.monash.edu/~mwybrow/papers/wybrow-gd-2009.pdf
- three.js OutlinePass: https://threejs.org/docs/pages/OutlinePass.html
- three.js TransformControls: https://threejs.org/docs/pages/TransformControls.html
- WCAG 2.2 SC 2.5.7 Dragging Movements: https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html

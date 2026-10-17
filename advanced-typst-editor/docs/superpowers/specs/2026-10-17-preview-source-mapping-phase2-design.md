# Preview-to-source mapping, phase 2: selection to source range

Date: 2026-10-17. Status: requested by the user ("start phase 2"). Builds on phase 1 (commit `1254659`). The design comes from the research doc's section "5. Selection to range (G)"; this file adds the lead's calls.

**Read first:**
- `docs/research/2026-10-17-preview-source-mapping.md`, section 5 and "Phase 1 results";
- `docs/superpowers/specs/2026-10-17-preview-source-mapping-phase1-design.md`;
- the phase 1 code in `src/lib/typst-source-map.ts`: `projectSource`, `resolveClick`, `ClickTarget`, `SourceHint`.

## Why

This is the user's original ask: highlight text in the rendered preview and have it map accurately to the Typst source. Phase 1 made single clicks accurate (98.7% on the corpus, and verified in the browser on a real 23-page report). Phase 2 maps a highlighted **range**.

The user mainly uses the preview with an AI editing the document, often with the preview **locked** so clicks never open the code pane.

## Decided here (lead's calls)

### Mapping

`rangeFromSelection(source, start, end, hint)` in `src/lib/typst-source-map.ts`:
- **Inputs.** `start` and `end` are each `{ target: ClickTarget, offset: number }`, where `offset` is a character offset inside that run's text.
- **Character precision.** Map each end through the phase 1 alignment to a precise source offset: the aligned projection characters already carry source offsets. Expose whatever internal step that needs; don't duplicate the aligner. If an end can't be mapped to a character, use its whole run's range (the start of the start run, the end of the end run).
- **Result.** `{ from, to, approximate }`. Both ends get their own context window and use the hint.
- **Sanity checks** (research section 5):
  - if `to < from`, swap only when both ends sit in the same run; otherwise mark it approximate and fall back to the shorter end's run range;
  - if the source span is more than 3 times the rendered selection length plus 200 characters, mark it approximate and fall back to the shorter anchor match.
  Never return a huge block.
- **Pure and DOM-free.** No CodeMirror import, the same rule as phase 1.

### Reading the selection (`src/components/typst/TypstPreview.tsx`)

- **When to map.** After a drag ends (`mouseup` in the page area), and after keyboard selection (`keyup` with Shift), map once, debounced about 120 ms. Never during the drag, never per `selectionchange` tick.
- **What counts as a preview selection.** Reuse the phase 1 guard's idea: a selection counts only when it's non-empty and anchored inside the preview. Chrome's `ShadowRoot.getSelection()` stringifies the *editor's* selection even when its anchor is null (see the phase 1 guard and its test). Read both the shadow root's and the document's selection.
- **Resolving each end.** Anchor and focus node → the closest `.tsel` → its run index on that page card (document order) → character offset in the run text. A focus before the anchor (a backwards drag) is normalised.
- **Cross-page.** A selection spanning pages works through `runsOf` (phase 1 already caches per-page runs, including unmounted pages).
- **Clearing.** A collapsed or empty selection clears the mapped state and the editor highlight.
- **Clicks stay as they are.** A plain click still reveals, unlocked, exactly as in phase 1. A finished drag must not also reveal (the guard already handles this).

### UI: transient highlight plus a small selection toolbar

1. **Editor highlight.** A transient CodeMirror mark ("preview selection") styled with existing tokens (accent tint plus outline), distinct from the real selection.
   - It scrolls the editor so the range is visible (using phase 1's settle-after-render reveal logic) but **never moves the caret, never changes the editor selection, and never takes focus**. Focus stays in the preview, so Ctrl+C still copies the preview text.
   - It's shown only when the code pane is open. A hidden pane is not opened.
   - All CodeMirror code stays in `TypstEditor.tsx`; the bridge (`typst-editor-bridge.ts`) gains `showTypstPreviewHighlight(range | null)`.
2. **Selection toolbar.** A small floating bar near the end of the selection, inside the preview pane (not in the shadow root's page content), in the Ember look with sentence-case labels:
   - **Copy:** the rendered text, same as Ctrl+C.
   - **Copy Typst source:** `source.slice(from, to)`. This is the AI workflow: paste the exact markup for a passage. If the result is approximate, the button's title says so.
   - **Select in code:** turns the mapped range into the real editor selection, opening the code pane if hidden and focusing the editor (`revealTypstRange`).
   - It's dismissed by Escape, a click elsewhere, or the selection collapsing. It never covers the selected text: place it below the selection, or above it near the bottom edge.
3. **Locked preview.**
   - The toolbar shows **Copy** and **Copy Typst source** only. Select in code is hidden, because the lock promises the code pane never opens from the preview.
   - The passive editor highlight still appears when the code pane is already open, since it never moves the caret or opens anything.
4. **Approximate results** show a quiet "approximate" note in the toolbar. They never show silently as exact.

### Tests (vitest, failing first)

- **Mapper:**
  - Extend the phase 1 corpus with hand-labelled **selections** (start run and offset, end run and offset, expected source range by line): within one run, across runs, across a table row, across a page break, a backwards drag, and a selection over generated or placeholder text that should come back approximate.
  - Print a hit-rate table like phase 1's.
  - Assert the sanity checks and that no result exceeds the size bound.
- **Preview** (jsdom, stubbing selections as phase 1's tests do, including a Chrome-shaped shadow `getSelection`):
  - a drag selection maps once after mouseup;
  - a collapsed selection clears;
  - Copy Typst source writes the slice;
  - Select in code calls `revealTypstRange`;
  - a locked preview hides Select in code and never calls reveal;
  - a plain click still reveals.
- **Editor:** the bridge highlight adds and clears the mark without changing the selection or focus.
- **Performance:** mapping a selection on the largest fixture stays under 25 ms at p95. Use p95, not max, as phase 1 learned.

## Files

- Mapper: `src/lib/typst-source-map.ts`.
- Preview and wiring: `src/components/typst/TypstPreview.tsx`, `TypstView.tsx`.
- Editor: `TypstEditor.tsx` and `typst-editor-bridge.ts`.
- New tests, plus extra corpus labels under `src/test/fixtures/source-map/`.

## Out of scope

Phase 3 (exact spans from a custom wasm), mapping selections in an exported PDF, and editing from the preview.

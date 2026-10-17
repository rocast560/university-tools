# Preview-to-source mapping, phase 1: context-aware alignment

Date: 2026-10-17. Status: requested by the user ("start the preview-to-source mapping phase 1"). The design comes from the research doc; this file adds the lead's calls.

**Read first:** `docs/research/2026-10-17-preview-source-mapping.md`, sections "4. Better text-alignment fallback (F)" and "Phased plan, Phase 1". This spec does not repeat them.

## Why

Clicking the preview should land the editor on the source that produced the clicked text. Today `TypstPreview.textRunAtPoint` takes one rendered run and an occurrence count, and `findSourceRange` (`src/lib/typst-source-map.ts`) searches for that run's text. It misses or mis-lands in these cases:

- repeated strings: a table header like "Severity" on every finding, or a recurring label;
- rendered text that isn't literal in the source: headings, `--`, quotes, `*strong*`, lines split by markup;
- occurrence counts that drift across pages and floats.

The user's end goal (phase 2, not now) is selecting text in the preview and getting the matching source range. Phase 1 builds the shared machinery and fixes clicks.

## Decided here (lead's calls)

- **Algorithm:** as in research section 4.
  1. Build a per-page rendered stream from the `tsel` runs.
  2. Build a source projection: text-bearing characters only, each carrying its source offset in a parallel `Int32Array`. Length-changing rules (`--` to an en dash, quotes, markup stripping) are now fine.
  3. Run a fuzzy alignment of a context window (the clicked run plus neighbours) against the projection.
  4. Use a position prior from the last successful match.
  5. Fall back to today's `findSourceRange` below a score threshold.
- **No CodeMirror or Lezer in the mapper.** CLAUDE.md says only `TypstEditor.tsx` imports CodeMirror. The projection uses a small hand-written scanner in `src/lib/`. It stays pure and DOM-free like the rest of `typst-source-map.ts`.
- **What the projection keeps and drops:**
  - **Drop:** `#set`, `#show`, `#import` and `#include` statements, and `#let` definitions at statement level (reuse `designRegions`), plus comments.
  - **Keep:** content inside `[...]` and string literals passed as content (table cells, `figure` captions, `text(...)[...]`).
  - **Strip markup marks**, keeping the text: `=` headings, `*`, `_`, backticks, list markers.
  - **Normalise** dashes, ellipsis and quotes.
  - **Placeholders:** `#ident` and `{{PLACEHOLDER}}` are projected as a wildcard token that matches any rendered text up to the next literal.
- **Generated text** (only in a helper's output, or from an `#include`d file) stays fuzzy by design. When the best match lands inside a design region, prefer a call site of that helper if one exists in the body. Otherwise keep today's behaviour.
- **Locked preview is untouched.** A locked click still does nothing; this is only about where an unlocked click lands.
- **Test corpus (no private data):**
  - Write 4 to 6 realistic fixture documents under `src/test/fixtures/source-map/`: a security-assessment report with repeated finding blocks and Severity/CVSS tables, a lab report with headings, a figure and a table, prose with quotes and dashes, `#let` helpers and `{{PLACEHOLDER}}` variables, and a multi-page document.
  - Generate each fixture's rendered runs once with the project's own typst.ts in Node, the way the research spike did. Use a small script under `scripts/` and commit the runs as JSON next to each fixture, so tests never need wasm.
  - **Never read the user's documents in `data/`.**
- **Ground truth and metric:**
  - For each fixture, hand-label a set of clicks: page, run index, and the expected source line or construct. About 15 to 30 per fixture, deliberately including the hard cases above.
  - A **hit** means the returned range lies on the expected source line(s).
  - A test prints a hit-rate table, old mapper vs new, per fixture and overall, and asserts that new is greater than or equal to old on every fixture and higher overall.
  - Put the measured numbers in the research doc, replacing its "90-95%" estimate.
- **Performance budget:**
  - The projection is computed once per source text (memoised on the string).
  - A click resolves in under 5 ms on the largest fixture, measured in a test with a generous CI margin; assert under 25 ms.
  - Nothing new runs per keystroke beyond the memoised projection when a click happens. Nothing touches the worker, the per-page SVG split or the shadow root.
- **API shape:**
  - `onRevealSource` gets what the new resolver needs: page index, run index and the page's runs, or a context window object. `TypstView.revealSource` calls the new resolver, and falls back through the candidates exactly as today when the resolver returns nothing.
  - Keep `findSourceRange` exported, tested and used as the fallback.

## Files (from the research phased plan)

- `src/lib/typst-source-map.ts`: `projectSource`, `alignRuns` (or `resolveClick`), the hint, and the fallback wiring.
- `src/lib/typst-pages.ts`: per-page run lists with stable offsets (extends `extractTextRuns`).
- `src/components/typst/TypstPreview.tsx`: `textRunAtPoint` returns the run index and context instead of counting occurrences, and `onPageClick` passes the last match as a hint.
- `src/components/typst/TypstView.tsx`: `revealSource` uses the new resolver.
- Tests and fixtures as above, plus the fixture-generation script.

## Out of scope

Phase 2 (selection to range, the transient highlight in the editor) and phase 3 (custom wasm spans).

# Mapping preview clicks and selections to Typst source

Date: 2026-10-17. Scope: the rendered pages in the studio preview. The exported PDF is covered briefly at the end.

## Recommendation

1. **Do not wait on typst.ts for spans.** Debug spans can't be turned on in the browser compile path today. I ran the spike against both 0.7.0 and 0.8.0-rc3. `setAttachDebugInfo(true)` changes nothing: the vector output is byte-identical, and `getSourceLoc` throws on every path. The `@myriaddreamin/typst-ts-node-compiler` has no span or jump API either.
2. **Ship a better text-alignment mapper now (Phase 1).** Replace "search one run, count occurrences" with this:
   - Walk the whole rendered text stream.
   - Align it against a "rendered-ish" projection of the source, where every projected character keeps its source offset.
   - Choose the match by context, not by a raw count.
   - Use the same machinery for multi-run selections.

   It is pure TypeScript, adds no bundle weight, and fits the lazy per-page preview. Measured on the Phase 1 corpus (see "Phase 1 results"): 98.7% of 226 hand-labelled clicks land on the right source line, against 86.7% for the old search. Generated text such as `#let` helpers, `{{PLACEHOLDER}}` variables and `#include`d content will stay fuzzy.
3. **Treat exact spans as a separate, optional project (Phase 3).** The route is a custom build of `typst-ts-web-compiler` that exports glyph spans from the document, plus a small span-to-offset resolver. The Rust source and the cause of the no-op debug flag were not read (see "What I did not verify"). Do it only if Phase 1 accuracy is not enough. Don't upgrade to 0.8.0-rc3 for this, because it gains nothing here.

## Options at a glance

| # | Option | Accuracy | Effort | Risk | Fit |
|---|---|---|---|---|---|
| A | Turn on debug spans in the 0.7.0 worker via the incremental server | Would be exact, but **does not work** (spike) | n/a | n/a | n/a |
| B | Upgrade to typst.ts 0.8.0-rc3 | Same as 0.7.0 for spans (spike) | M: rc build, Typst 0.15 migration | Medium to high: rc, 28-30 MB wasm | Good, but no gain for this problem |
| C | Custom wasm build exporting spans (typst-ide style `jump_from_click`) | Exact: glyph span to source range | L: Rust toolchain, wasm build, new bridge | High: fork maintenance, bundle size, wasm rebuild per Typst bump | Fits the worker, but the SVG per-page split loses element identity unless tagged |
| D | typst.ts node compiler on the Bun server | No span API (read d.ts, ran `svg()`: 0 `data-span`) | n/a | n/a | Not useful, and would add a network round trip |
| E | Rewrite typst-ide `jump_from_click` on a server-side Typst CLI/library | Exact | L | Needs `typstCli` or a Rust service, and a round trip per click | Poor: loses the offline in-browser design |
| F | **Sequence alignment of the rendered text stream against a source projection** | Good on prose, headings, quotes, dashes. Weak on generated text | S to M | Low | Excellent: pure TS, per-page, no wasm change |
| G | Selection mapping via F (start and end anchors) | Same as F, plus a sanity check on the range | S | Low | Excellent |
| H | Use `getAst` / the CodeMirror Lezer tree to build the projection | Improves F's projection of markup | S | Low | Good: the editor already parses Typst |

## Details

### 1. typst.ts 0.7.0 (what is actually there)

- **The APIs exist.** `IncrementalServer.setAttachDebugInfo()` (`node_modules/@myriaddreamin/typst.ts/dist/esm/compiler.mjs:14-43`) and `RenderSession.getSourceLoc(path: Uint32Array)` (`renderer.mjs:119-121`, `renderer.d.mts:78`) are both in 0.7.0. `compiler.compile({ incrementalServer })` runs `world.incr_compile` (`compiler.mjs:188-189`). `withIncrementalServer` is at `compiler.mjs:217-224`. The wasm exports are at `typst-ts-web-compiler/pkg/typst_ts_web_compiler.d.ts:8, 61-62` and `typst-ts-renderer/pkg/typst_ts_renderer.d.ts:65`.
- **The flag does nothing in the shipped wasm.** The spike shows this (details below). The renderer wasm contains the `SourceMappingData` / `page_sources` machinery, but the compiler wasm has no source-mapping strings. The spike compiled with the flag on and got identical bytes.
- **There is no document-side span in the SVG.** The SVG has `data-tid` (a content hash per group), not `data-span`. My compile of a small test document produced 0 `data-span` attributes. The runtime script embedded in the SVG reads `data-span` on click, but nothing sets it. If your summary of "one `data-span` per page" came from a different document, it does not change the conclusion.
- **The app's compile path.** `src/lib/typst-compiler.driver.ts:101-110` and `:142-150` use `compiler.compile({ format: 0 })`, `manipulateData('reset')` and `renderSvg`. Switching it to the incremental server is a small change, but it would not add spans.
- **Newer releases.** npm has `0.8.0-rc1` to `rc3` (tag `rc`; `latest` is 0.7.0). The rc3 release notes mention "fixed source span resolution by falling back to `vpath`" and Typst 0.15.0-rc.1, which suggests span work is happening upstream. The spike on rc3 showed no change (below). The compiler wasm is 30.2 MB against 28.3 MB for 0.7.0.

### 2. tinymist / typst-preview

- The preview server holds the compiled `Document`. The browser frontend renders a span-annotated vector/SVG stream and, on click, sends an element path to the server. The server resolves it to a span (`source_span`, the same function exposed here as `getSourceLoc`), then to a file and range, and sends an editor "scroll to" message (read in `tinymist/src/tool/preview.rs`: `EditorScrollTo`, `DocToSrcJumpInfo`).
- Editor to preview goes through `jump_from_cursor` (below).
- **It does not transplant to the in-browser compile.** The frontend only works because the server keeps debug info next to the document. In this app the same data would have to come out of the compile wasm, which is exactly the part the published build omits.

### 3. Typst's own tooling

- tinymist's `jump_from_click(world, frame, click)` (`crates/tinymist-query/src/jump.rs`) walks the frame in reverse. Groups recurse with the click shifted. For text it checks each glyph's rectangle and resolves `glyph.span` with `source.find(span)`. Past the glyph midpoint on a `Text` node it advances by the glyph's length. Shapes and images return their span directly. It returns a `(span, offset)` pair.
- `jump_from_cursor` finds the leaf at the cursor, then searches pages for the glyph whose span equals the node's span. If none matches, it takes the glyph with the numerically closest span.
- **Custom wasm (C).** Both functions need the compiled `Document` plus a `World`. The compile wasm owns both, so adding an export there is the natural place. In-browser, the cost is a Rust build of the fork and keeping it in step with Typst releases. The doc does not give a bundle-size figure; expect the delta to be small next to a 28 MB module, but this is an estimate, not measured.
- **Node compiler / server (D, E).** `NodeCompiler` exposes `compile`, `query`, `svg`, `pdf`, `html`, `vector` and nothing for spans (`index-napi.d.ts:24-100`). Running `svg()` produced 0 `data-span`. A Typst CLI on the server has no click-to-span command either. Both would also mean a request per click and sending the project to the server.
- **Also available: `getAst` (H).** `compiler.getAst(path)` returns an HTML-ish debug dump of the syntax tree with `line:col~line:col` ranges (spike ran it). It works but is a formatted string, so parse it only if Lezer isn't enough.

### 4. Better text-alignment fallback (F)

Today's mapper handles one run at a time and reasons by occurrence count. The runs are whole lines ("Hello Alice – it's “quoted” text. Hello Alice again." is one run in the spike), and substituted values like `#who` already differ from the source.

Proposed design:

1. **Rendered stream.** Per page, collect the `tsel` runs in order (the app already has `extractTextRuns`). Join them into one normalized string, remembering each run's start offset in that string. Cache per page by markup hash, as the preview already does for its other per-page work.
2. **Source projection.** Walk the source (Lezer tree or a small scanner) and emit a string of text-bearing characters only. Each emitted character keeps its source offset in a parallel `Int32Array`.
   - Drop `#set` / `#show` / `#let` statements, comments and call syntax.
   - Keep the content inside `[...]` and string literals that are passed as content.
   - Strip markup (`=`, `*`, `_`, `` ` ``) and map `--` to an en dash, `---` to an em dash, `...` to an ellipsis, straight quotes to curly. Because each emitted character remembers its offset, length-changing rules are no longer a problem (the current 1:1 constraint disappears).
   - Treat `#variable` references as wildcards that can match any run of text up to the next literal anchor.
3. **Alignment.** Run a banded/Hirschberg-style or diff-match-patch-style fuzzy match of a window of the rendered stream (the clicked run plus a few neighbours each side) against the projection. Pick the highest-scoring location. Because neighbouring text is part of the key, a repeated "Severity" resolves by what is around it.
4. **Anchor prior.** Use the previous successful match as a hint so the search starts near it. Document order mostly equals source order, so scoring locations by distance from the expected position fixes most drift across pages and floats.
5. **Fallback.** If the score is below a threshold, fall back to the current progressive search.

Weak spots remain by construction: text that exists only in a `#let` helper's output, `{{PLACEHOLDER}}` content that is substituted before compile, text from other files via `#include`, and math (rendered as glyph runs, not source text). For these, jump to the call site of the construct rather than nowhere. Tables work better than today because cell text is a plain `[...]` argument and neighbouring cells give context.

Performance: the projection is O(source length) and rebuilt only when the source changes, not per click. Alignment runs on a window of a few hundred characters, not the document, so a click on a 20+ page report stays in the low milliseconds. Nothing touches the per-page SVG split, the shadow root or the worker.

### 5. Selection to range (G)

- On `selectionchange` in the shadow root (the code already uses `getSelection` there), read the anchor and focus nodes. Resolve each to a run index and a character offset within it. The `tsel` runs are inline text, so offsets are character offsets in the run text.
- Map the start point and the end point separately through step F, each with its own context window (the first and last few words of the selection). Take `from = start.from` and `to = end.to`.
- Sanity checks: reject the pair if `to < from` or if the source span is wildly longer than the rendered selection (for example more than 3x its length plus a margin). In that case select the shorter of the two anchor matches and say so in the UI, rather than selecting a huge block.
- Cross-page selections work because the stream is per page and the preceding-runs data already exists. A selection spanning a lazily unmounted page needs that page's cached runs, not its DOM.
- Show the mapped range in CodeMirror as a transient highlight first, and only move the real selection on an explicit action (click, shortcut). That makes a wrong guess cheap.

### 6. The exported PDF (brief)

Typst's PDF output has no source spans. Mapping a PDF selection back to source would need the same text alignment (F) applied to text extracted from the PDF, so nothing beyond Phase 1 is needed. Exact mapping from a PDF is not practical.

## What the spike proved

All in `C:\Users\rober\AppData\Local\Temp\claude\C--Users-rober\4f27e5d0-a8ec-495a-ac2e-380162368c81\scratchpad\mapping-spike` (scripts `spike.mjs`, `probe.mjs`, `probe2.mjs`, `ast.mjs`, `rc3\p3.mjs`, `nc\t.mjs`). I ran them with Node 24 (Git Bash only), loading the project's `node_modules` by absolute path. The app and Docker were not started.

Test document: a small page with a heading, a `#let who = "Alice"` helper, a `--`, smart quotes, a table, math and a link.

| Check | Result |
|---|---|
| 0.7.0 transient compile then `renderSvg` (the app's path) | 51,804 byte SVG, 0 `data-span` |
| 0.7.0 incremental server with `setAttachDebugInfo(true)` | SVG byte-identical to the transient one. Vector 28,748 B with the flag on or off |
| `getSourceLoc` over 8,232 candidate paths, flag on and off | Every call throws `out of bound access ... page_sources`. No path resolves |
| Second (delta) compile, flag on | Delta is 1,348 B. The current buffer contains no `source_mapping` or `span` strings |
| typst.ts 0.8.0-rc3 (installed to its own scratch dir) | Same: 2,000 of 2,000 probed paths throw the same error with the flag on. 0 `data-span` |
| `typst-ts-node-compiler` 0.7.0 `svg()` | 0 `data-span`, 12 foreignObject text runs |
| `compiler.getAst()` | Works. Returns an HTML-ish tree dump with `line:col` ranges |
| SVG text layer | One `foreignObject > div.tsel` per rendered line, e.g. "Hello Alice – it's “quoted” text. Hello Alice again." as a single run, with the `#who` value already substituted |

### What I did not verify

- Why the flag is a no-op (a build-time feature flag or an unimplemented path). I did not read the typst.ts Rust source (the one URL I tried returned 404).
- Whether a custom wasm build would work, its size, or its build effort. The effort and risk for option C are estimates from the architecture.
- tinymist and typst-preview behaviour is from reading `jump.rs` and `preview.rs` summaries (via fetch), not from running them.
- ~~Accuracy figures for the alignment approach (the "90-95%" ceiling) are an estimate, not measured.~~ Measured on 2026-10-17, see "Phase 1 results".
- I did not test the alignment algorithm. Only the inputs it relies on (the `tsel` run structure and `getAst`) were checked.

## Phase 1 results

Measured 2026-10-17 by `src/test/typst-source-map-corpus.test.ts`, which replaced the earlier "90-95%" estimate. The corpus is six fixture documents written for this (`src/test/fixtures/source-map/`: a pentest report with repeated finding blocks, a lab report with math, a prose page with quotes and dashes, a helpers-and-variables page, a multi-page report with a contents list, and a 25-heading report with uppercase headings, repeated sub-headings and a generated contents list), rendered once with the project's typst.ts 0.7 (`scripts/gen-source-map-fixtures.mjs`), and 226 hand-labelled clicks, many of them deliberately hard. A hit means the returned range lies on the expected source line.

| fixture | clicks | old (candidate search) | new (alignment, then the same fallback) |
|---|---|---|---|
| helpers-vars | 31 | 26 (83.9%) | 31 (100.0%) |
| lab-report | 35 | 31 (88.6%) | 33 (94.3%) |
| long-report | 50 | 43 (86.0%) | 50 (100.0%) |
| pentest-report | 32 | 20 (62.5%) | 32 (100.0%) |
| prose-quotes | 28 | 27 (96.4%) | 27 (96.4%) |
| toc-report | 50 | 49 (98.0%) | 50 (100.0%) |
| **overall** | **226** | **196 (86.7%)** | **223 (98.7%)** |

Caveats: the thresholds were tuned against this same corpus, so treat 99% as an upper bound for real documents and spot-check in the browser. The three misses are the known weak spots: a math digit (`2` inside `$f_c = 1 / (2 pi R C)$`, math projects as one wildcard), a page number whose only source is `numbering:` in `#set page` (no text to align), and a footnote marker whose footnote text sits elsewhere in the source than where the marker renders. The old search's 62.5% on the pentest fixture is mostly "Severity" and "Open" repeated in every finding table.

Cost, on the 8-page, 724-run, 7.9K-character multi-page fixture: median 0.4 ms, p95 1.5 ms, max 2.8 ms per click once the projection exists (budget: under 5 ms, asserted under 25). The projection plus gram index is built once per source text on the first click (about 15 ms for 79K characters). A stress copy ten times larger, whose ten copies are identical so every click widens its window, takes a median of 4.5 ms and a worst case of about 37 ms.

## Phase 2 results

Measured 2026-10-17 by `src/test/typst-source-selection.test.ts` on the same synthetic fixtures. 52 hand-labelled selections (labels in `<fixture>.selections.json`, written before the mapper ran and not changed to fit it): within one run, across runs, across list items, across an equation, across table rows, across page breaks, over a variable, over generated text, a heading counter, a footnote, a backwards drag. A hit on lines means the range lies on the labelled line(s); exact means `source.slice(from, to)` equals the labelled source text (given for the 40 selections whose text is literal).

| fixture | selections | on the right lines | exact source text | flagged approximate (where generated) | not flagged (where literal) |
|---|---|---|---|---|---|
| helpers-vars | 11 | 11 (100%) | 7 of 7 | 5 of 5 | 6 of 6 |
| lab-report | 16 | 16 (100%) | 13 of 13 | 2 of 2 | 14 of 14 |
| long-report | 2 | 2 (100%) | 1 of 1 | n/a | 2 of 2 |
| pentest-report | 11 | 11 (100%) | 9 of 9 | 1 of 1 | 10 of 10 |
| prose-quotes | 12 | 12 (100%) | 10 of 10 | 2 of 2 | 10 of 10 |
| **overall** | **52** | **52 (100%)** | **40 of 40** | **10 of 10** | **42 of 42** |

Caveats: 100% is an upper bound for the same reason as phase 1 (the mapper was built and tuned while reading these fixtures, and the labels are mine), so spot-check on real documents. The approximate cases are the ones that cannot be exact by construction: an end inside variable, `#lorem` or helper output (the whole generated passage is used), a header or footer from `#set`, a generated heading counter (the heading text is used), and a selection into a footnote body (it renders at the foot of the page but sits mid-paragraph in the source, so the span inverts and the shorter end's run is returned).

Cost on the largest fixture (the 1792-run contents report, 8.3K source characters, 172 two-run selections, warm): median 3.2 ms, p95 8.1 ms, max 13.6 ms per selection, which is two click-sized alignments (a click is a 1.1 ms median there). The test asserts p95 under 25 ms. The projection is shared with click mapping and built once per source text.

## Phased plan

**Phase 1: context-aware alignment (about 1-2 days).**
- `src/lib/typst-source-map.ts`: add `projectSource(source)` returning the projected string and its offset array. Add `alignRuns(projection, stream, window, hint)`. Keep `findSourceRange` as the fallback.
- `src/lib/typst-pages.ts`: expose the per-page run list with stable offsets (extends `extractTextRuns`).
- `src/components/typst/TypstPreview.tsx`: `textRunAtPoint` returns the run index plus a context window instead of counting occurrences. `onPageClick` passes the previous match as a hint.
- Tests: extend the source-map tests with a corpus of real reports (headings, tables, repeated words, `#let` helpers). Record the hit rate before and after.

**Phase 2: selection mapping (about 1 day).**
- `TypstPreview.tsx`: a `selectionchange` handler that resolves anchor and focus to run and offset, then maps both ends and applies the sanity checks.
- `src/lib/typst-source-map.ts`: `rangeFromSelection`.
- The editor side (a transient highlight, then an explicit "select in source") touches the code that calls `onRevealSource`. That code lives under `src/` where another agent is working, so coordinate before editing.

**Phase 3 (optional, only if Phase 1 accuracy is insufficient): exact spans.**
- Fork and build `typst-ts-web-compiler` with a span export, or find the reason the debug flag is inert first (read the Rust source). Measure the wasm size and compile time.
- `src/lib/typst-compiler.driver.ts`, `typst-compiler.worker.ts`, `typst-compiler-types.ts`: a new driver op returning a per-page glyph list with spans and rectangles, so the main thread hit-tests geometry without any new DOM.
- Do this only after a one-day prototype shows the span data really can be exported.

**Not recommended:** upgrading to 0.8.0-rc3 for this purpose, or routing clicks through the Bun server.

## Sources

URLs:
- https://github.com/Myriad-Dreamin/typst.ts (releases: v0.8.0-rc2, v0.8.0-rc3)
- https://api.github.com/repos/Myriad-Dreamin/typst.ts/releases
- https://raw.githubusercontent.com/Myriad-Dreamin/typst.ts/main/packages/typst.ts/src/renderer.mts
- https://raw.githubusercontent.com/Myriad-Dreamin/tinymist/main/crates/tinymist-query/src/jump.rs
- https://raw.githubusercontent.com/Myriad-Dreamin/tinymist/main/crates/tinymist/src/tool/preview.rs
- https://www.npmjs.com/package/@myriaddreamin/typst.ts (dist-tags: latest 0.7.0, rc 0.8.0-rc3)
- https://www.npmjs.com/package/@myriaddreamin/typst-ts-node-compiler

Project files (`C:\Users\rober\Desktop\university-tools\advanced-typst-editor`):
- `src/lib/typst-source-map.ts:1-23` (why spans are not used), `:207-249` (`findSourceRange`), `:258-265` (`occurrenceIndex`)
- `src/components/typst/TypstPreview.tsx:1-16` (perf header), `:67-125` (`textRunAtPoint`), `:455-497` (`onPageClick`)
- `src/lib/typst-pages.ts:205-208` (`extractTextRuns`)
- `src/lib/typst-compiler.driver.ts:101-110`, `:142-150`

node_modules (`...\advanced-typst-editor\node_modules\@myriaddreamin`):
- `typst.ts/dist/esm/compiler.mjs:14-43` (`IncrementalServer`, `setAttachDebugInfo`), `:188-189` (`incr_compile`), `:217-224` (`withIncrementalServer`)
- `typst.ts/dist/esm/renderer.mjs:119-121` (`getSourceLoc`)
- `typst.ts/dist/esm/compiler.d.mts:88-125, 326-333`
- `typst-ts-web-compiler/pkg/typst_ts_web_compiler.d.ts:4-10, 39, 61-62`
- `typst-ts-renderer/pkg/typst_ts_renderer.d.ts:65`
- Scratch installs (not in the project): `...\mapping-spike\rc3\node_modules\@myriaddreamin\*` (0.8.0-rc3) and `...\mapping-spike\nc\node_modules\@myriaddreamin\typst-ts-node-compiler\index-napi.d.ts:24-100`

# UI redesign: Calm Console with the Turtle palette — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every BenchMate screen uses a neutral dark-gray "Calm Console" look with the Turtle palette, apply-pilot-style line icons and tabs, and the cleaner project-page arrangement, in dark and light mode, with behaviour unchanged.

**Architecture:** Colours move into one token table at the top of `client/styles.css` (dark default, light override), checked by a contrast test. A new `client/icons.ts` provides inline line icons. Markup changes stay in the existing renderers (`client/main.ts`, `client/panels.ts`, `client/showbar.ts`, `client/fschrome.ts`, `client/lights.ts`, `client/editor3d/*`); every `data-*` hook stays, so handlers and e2e tests keep working.

**Tech Stack:** bun 1.3, TypeScript, plain DOM + CSS (no framework), `bun test`, headless-Chrome e2e in `scripts/e2e-3d.ts`.

**Spec:** `docs/superpowers/specs/2026-10-06-ui-turtle-redesign-design.md` (tokens §3.1, icons §3.2, layout §3.3, other screens §3.4, tests §5). The approved mockups are `layout-v2.html` and `visual-style.html` (option B) under `C:\Users\rober\Desktop\university-tools\.superpowers\brainstorm\2421-1791325215\content\`.

## Global Constraints

- Repo `C:\Users\rober\Desktop\university-tools`, app in `circut-ai-tool/`. Branch `ui-turtle` in worktree `.worktrees/ui-turtle`, created from `main` **after** the phase-4 branch `models3d` has merged (it also touches the 3D toolbar and `styles.css`).
- Conventional commits; **never** add `Co-Authored-By: Claude` or "Generated with Claude Code" lines. Other sessions edit `main`; commit only your task's files.
- Palette: cream `#E5EFC1`, mint `#A2D5AB`, teal `#39AEA9`, slate `#557B83`. Token values exactly as in spec §3.1 (dark) and its light-mode paragraph.
- Never recolour wires, LEDs, the board, or the dark board well (`--well`). The 2D board keeps rendering with the DARK render theme.
- Keep every `data-tab`, `data-action`, `data-opt`, `data-show`, `data-legend`, `data-ws`, `data-card` attribute and its handler; e2e and handlers depend on them.
- Icon-only buttons carry `title` and `aria-label`.
- After every task: `bun run typecheck && bun test && bun run build`; from Task 5 on also `CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe" bun scripts/e2e-3d.ts` (never two e2e runs at once).

## Review Focus

1. **Light mode** on every screen: no leftover dark-only colour makes text unreadable. → Task 1 contrast test (both modes) + Task 7 screenshot checklist includes light mode.
2. **Long project or net names** in the app bar and net strip: truncate with an ellipsis and keep the full name in the tooltip, never push buttons off-screen. → Task 3 test for `shortNet` + Task 4 CSS `min-width:0; text-overflow: ellipsis` rule checked in Task 7 screenshots with lab 6's long path.
3. **Narrow windows / collapsed panel**: tabs stay one row (icon-over-label, icon-only under 380px) and the toolbar scrolls sideways rather than wrapping into the board. → Task 5 e2e `the side-panel tabs stay on one row at 900px wide`.
4. **Keyboard users**: every tab and toolbar button reachable with Tab, visible teal focus ring, Export menu opens with Enter/Space and closes with Esc. → Task 4 e2e `Export menu works from the keyboard`.
5. **Print** still produces a white, readable board page. → Task 7 manual print-preview check.

---

### Task 1: Tokens and the contrast test

**Files:** Modify `client/styles.css` (`:root`, `:root[data-theme="dark"]`, the `prefers-color-scheme` block, and the second dark block near line 1224). Create `src/ui/contrast.ts`, `test/ui-contrast.test.ts`.

**Interfaces — Produces:** `contrast(a: string, b: string): number` (WCAG 2.x ratio for `#rrggbb`), `parseTokens(css: string, selector: ':root' | ':root[data-theme="dark"]'): Record<string, string>`.

Steps:
- [ ] **Step 1: Failing test** `test/ui-contrast.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { contrast, parseTokens } from '../src/ui/contrast.ts';

const css = readFileSync(new URL('../client/styles.css', import.meta.url), 'utf8');

describe('contrast()', () => {
  test('black on white is 21, white on white is 1', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });
});

for (const mode of [':root', ':root[data-theme="dark"]'] as const) {
  describe(`tokens ${mode}`, () => {
    const t = parseTokens(css, mode);
    const text: [string, string][] = [['--ink', '--card'], ['--ink-2', '--card'], ['--ink', '--bg'], ['--accent-ink', '--accent'], ['--bad', '--card']];
    for (const [fg, bg] of text) test(`${fg} on ${bg} is at least 4.5:1`, () => expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5));
    const ui: [string, string][] = [['--accent', '--card'], ['--ok', '--card'], ['--line', '--bg']];
    for (const [fg, bg] of ui) test(`${fg} on ${bg} is at least 3:1 (UI)`, () => expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(fg === '--line' ? 1.2 : 3));
  });
}
```
(`--line` on `--bg` is a hairline, not text: it only has to be visible, so 1.2:1.)

- [ ] **Step 2:** run — FAIL.
- [ ] **Step 3:** implement `src/ui/contrast.ts` (relative luminance with the sRGB transfer function; ratio `(L1+0.05)/(L2+0.05)`; `parseTokens` reads `--name: #rrggbb;` lines inside the first block whose selector matches exactly). Rewrite the token blocks: light `:root` and dark `:root[data-theme="dark"]` (and the `prefers-color-scheme` copy) with the spec §3.1 values; add the new tokens `--quiet`, `--ok`, `--highlight`, `--bad`, `--warn`; keep the old names that other rules use (`--glass*`, `--shadow-*`, `--tint-*`) but point them at the new values (glass → card, shadows → `none` except `--shadow-2` for menus/toasts, tints → transparent). If a pair fails, adjust the light-mode value (never the palette hues' dark-mode roles) and say so in the report.
- [ ] **Step 4:** tests, typecheck, build pass. Commit `feat(ui): Calm Console tokens with the Turtle palette, contrast-tested`.

### Task 2: Line icons (`client/icons.ts`)

**Files:** Create `client/icons.ts`, `test/icons.test.ts`.

**Interfaces — Produces:** `type IconName = 'guide' | 'simulate' | 'parts' | 'pinouts' | 'checks' | 'truth' | 'options' | 'run' | 'step' | 'reset' | 'fit' | 'fullscreen' | 'wires' | 'cube' | 'export' | 'connect' | 'moon' | 'sun' | 'close' | 'chevron' | 'plus' | 'search' | 'wire' | 'duplicate' | 'trash' | 'eye' | 'undo' | 'redo' | 'exit' | 'check' | 'brand'`; `icon(name: IconName, cls = 'i'): string`.

- Paths: copy the 24×24 path data used in the approved mockup `layout-v2.html` for guide, simulate, parts, pinouts, checks, truth, options, run, step, reset, fit, fullscreen, wires, cube, export, connect, moon, check, chevron, brand; draw the rest in the same style (Lucide-like, stroke 2, round).
- Output: `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">…</svg>`; CSS in `styles.css`: `.i { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; }`.

- [ ] **Step 1: Failing test:** every `IconName` returns a string starting `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"`, containing at least one `<path`, `<rect` or `<circle`, and no `fill="` other than `none`; `icon('run','i big')` uses that class.
- [ ] **Step 2–4:** RED, implement, GREEN; commit `feat(ui): line icons in the apply-pilot style`.

### Task 3: Short net names and the net strip

**Files:** Create `src/ui/netname.ts`, `test/netname.test.ts`. Modify `client/panels.ts` (legend rendering ~line 285-288), `client/styles.css` (`.legend` rules).

**Interfaces — Produces:** `shortNet(net: string, nets: string[]): string`.

Rules: `displayName` first (strip leading `/`). A name `Net-(REF-PIN)`: if no other net in `nets` has the same `REF`, return `REF`; else `REF-PIN`. Power and labelled names (`+5V`, `GND`, `A0`) unchanged. `unconnected-(…)` unchanged.

- [ ] **Step 1: Failing test:**

```ts
import { expect, test } from 'bun:test';
import { shortNet } from '../src/ui/netname.ts';
const nets = ['+5V', 'GND', 'Net-(R7-Pad1)', 'Net-(U1-A1)', 'Net-(U1-A2)', '/A0'];
test('short net names', () => {
  expect(shortNet('Net-(R7-Pad1)', nets)).toBe('R7');
  expect(shortNet('Net-(U1-A1)', nets)).toBe('U1-A1');
  expect(shortNet('+5V', nets)).toBe('+5V');
  expect(shortNet('/A0', nets)).toBe('A0');
});
```
- [ ] **Step 3:** implement; the legend renders one strip: a "Nets" label with a chevron icon, then chips `<span data-legend="${net}" title="${full name}">` with the short name. CSS: in normal mode the strip is `display:flex; overflow-x:auto; flex-wrap:nowrap` with a thin scrollbar (the full-screen compact rules from `fschrome` stay compatible); chips `flex:none; max-width: 14ch; overflow:hidden; text-overflow:ellipsis`. Hover/click handlers unchanged.
- [ ] **Step 4:** tests; commit `feat(ui): one-row net strip with short names`.

### Task 4: App bar, toolbar and Export menu

**Files:** Modify `client/main.ts` (project app bar ~line 175, home header ~line 97), `client/lights.ts` (agent status → compact count with a popover listing each agent), `client/panels.ts` (toolbar ~lines 278-284), `client/showbar.ts` (Show filter → floating on the board), `client/styles.css`; e2e in `scripts/e2e-3d.ts`.

Layout per spec §3.3 / mockup `layout-v2`:
- App bar: `icon('brand')` + `Bench<span>Mate</span>` (Mate in `--accent`), project name with the full path in `title`, agent count (mint dot + "N agents"; click opens the existing per-agent list as a popover), Connect (`icon('connect')`), theme toggle (moon in dark, sun in light; `aria-label` "Switch to light/dark theme"). Keep `#theme` id.
- Toolbar groups separated by `<span class="tsep" aria-hidden="true"></span>`: [Run (primary, `data-action` unchanged), Step, Reset (icon-only)] | [Fit (icon-only), Full screen (icon-only), Square wires (toggle, `.is-on` uses `--quiet` border + `--ok` text), 3D] | [Export ▾] | spacer | status (`icon('check')` + "0 errors" in `--ok`, or count in `--bad`; then wires and board kind in `--ink-2`).
- Export menu: a `<button data-action="export" aria-haspopup="menu" aria-expanded>` opening `<div role="menu">` with the existing SVG/PNG/Schematic links and the Print action as `role="menuitem"` items; Enter/Space/ArrowDown open, Esc and outside click close, focus returns to the button.
- Show filter: rendered into a `.board-float` element positioned bottom-left over `#board` (absolute, `--card` background with 1px `--line` border, 7px radius); same `data-show` buttons and handlers.

- [ ] **Step 1:** add e2e `'Export menu works from the keyboard'` (focus the Export button, press Enter, menu visible with 4 items, ArrowDown moves focus, Esc closes and focus is back on the button). Run — FAIL.
- [ ] **Step 2:** implement. **Step 3:** typecheck/test/build/e2e — PASS. Commit `feat(ui): app bar, grouped toolbar with Export menu, floating Show filter`.

### Task 5: Side-panel tabs with icons

**Files:** Modify `client/panels.ts` (`TABS` line 21 and the tab bar markup in `renderPanels` ~line 265), `client/styles.css`, `scripts/e2e-3d.ts`.

- `TABS` gains an icon per tab: guide, simulate, parts, pinouts, checks, truth, options. Labels: Guide, Simulate, Parts, Pinouts, Checks, Truth, Options (tooltip "Truth table").
- Markup: `<nav class="tabs" role="tablist">` with buttons `role="tab" data-tab=… aria-selected` containing `icon()` over `<span class="tl">label</span>`; a `<span class="tabs-gap">` before Options which has class `util` and a divider (`::before` 1px `--line`). Checks shows `<span class="tab-badge">N</span>` when errors + warnings > 0 (replaces today's ⚠ marker; keep the same data source).
- CSS (from apply-pilot, adapted to tokens): tabs `display:flex; justify-content:space-between`, button column layout, 10.5–12px label, idle `--ink-2`, hover `--ink` on `--sunken`, selected `--accent` text + 2px `--accent` underline + 700 weight; under 380px panel width labels hide (`.tl` display none) and tooltips carry the name.
- [ ] **Step 1:** e2e `'the side-panel tabs stay on one row at 900px wide'` (resize the page to 900×800 through CDP, all `[role=tab]` share one `offsetTop`). Run — FAIL (labels wrap today).
- [ ] **Step 2–3:** implement; all checks pass. Commit `feat(ui): icon tabs for the side panel`.

### Task 6: Sweep the remaining colours; home, connect, toasts, menus, full screen, 3D workspace

**Files:** `client/styles.css` (all remaining hard-coded colours outside wire/LED/board/well), `client/main.ts` (home markup polish), `client/fschrome.ts` (switcher icons), `client/editor3d/workspace.ts`, `client/editor3d/tray-tiles.ts`, `client/editor3d/card.ts`, `client/editor3d/wireEdit.ts` (class names/icons only).

- Replace every literal colour in `styles.css` that is not a wire, LED, board, well or segment colour with a token. The 3D workspace always uses the dark token set: wrap its rules under `.ws` with the dark values (`.ws { --bg: …; --card: …; }`) so it stays dark in light mode, as today.
- Home: project cards and folders become bordered cards (`--card`, 1px `--line`, 8px radius, border turns `--quiet` on hover); primary "Open" uses `--accent`; drop zone dashed `--line`, teal border on drag-over.
- 3D toolbar buttons (`.ws-btn`) get icons (exit, wire, undo, redo, cube for Detail when phase 4 is merged), same shapes as the 2D toolbar.
- [ ] **Step 1:** add a unit test that scans `client/styles.css` for `#rrggbb`/`rgb(`/`rgba(` literals outside token blocks and outside an allow-list of selectors (wire, LED, board, segment, well, print, `.callout*`), and fails listing them. Run — FAIL (many).
- [ ] **Step 2–3:** sweep until GREEN; full checks + e2e. Commit `feat(ui): tokens everywhere; home, connect, 3D workspace restyled`.

### Task 7: Visual check and docs

**Files:** `README.md` ("Look and feel": palette, where tokens and icons live, light/dark), screenshots under `docs/img/ui/` (home, lab 6 2D dark, lab 6 2D light, lab 6 3D editor, full screen compact, print preview).

- [ ] **Step 1:** rebuild the container (`docker compose build && docker compose up -d` in `circut-ai-tool`), open each screen, take the screenshots, check Review Focus 1, 2 and 5 by eye (light mode text, long names truncated with tooltips, print is white). Record findings in the report; fix anything broken in this task.
- [ ] **Step 2:** write the README section; commit `docs(ui): look and feel`.

## Self-review notes

- Spec §3.1 → Task 1; §3.2 → Task 2; §3.3 → Tasks 3, 4, 5; §3.4 → Task 6; §5 tests → Tasks 1, 2, 3 (+ e2e in 4, 5, 6); §6 docs → Task 7.
- Ordering: this branch starts after `models3d` merges, so the Detail button exists for Task 6.
- Names: `contrast`, `parseTokens`, `IconName`, `icon`, `shortNet` — each defined once.

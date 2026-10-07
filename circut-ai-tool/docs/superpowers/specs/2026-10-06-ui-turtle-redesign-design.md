# BenchMate UI redesign: "Calm Console" with the Turtle palette — design

Date: 2026-10-06 · Branch: `ui-turtle` from `main` (merged after the phase 4 `models3d` branch) · Status: approved in chat and in the visual companion, awaiting spec review

## 1. Intent

The current "Lab Bench" look uses a blue-tinted dark theme and a violet
accent. The user wants:

- a **neutral dark-gray** background with no blue tint;
- a **cleaner, friendlier, more modern** interface;
- the **Turtle palette** in place of purple: cream `#E5EFC1`, mint `#A2D5AB`,
  teal `#39AEA9`, slate `#557B83`;
- the **tab and icon treatment of the user's apply-pilot project**
  (`C:\Users\rober\Desktop\apply-pilot\src\dashboard\ui`): line icons, an
  accented underline on the selected tab, utilities set apart, count badges,
  icon-over-label tabs in narrow panels.

Success: every screen (home, project page, side panel, 3D editor, connect
page, full screen) uses the new look in dark and light mode, wire and LED
colours keep their meaning, and all existing tests still pass.

### Decisions the user made (visual companion, 2026-10-06)

| Question | Answer |
|---|---|
| Style direction | **B · Calm Console**: flat surfaces, 1px borders, 6–8px corners, underline tabs, teal as the one strong colour |
| Project-page layout | **Cleaner arrangement** with **icon-over-label tabs** (mockup `layout-v2`) |
| Light mode | **Keep it**, same style and accents on off-white |

### Out of scope

- Wire colours, LED colours, the board's own colours and the dark board
  "well" (they carry meaning or are calibrated for lit LEDs).
- The 2D/3D rendering of parts and wires (phase 4 and the wire-clipping work
  cover those).
- New features. Only arrangement, styling and icons change.

## 2. Research summary

- Dark UI practice: very dark grays (#121212–#1E1E1E) rather than black,
  off-white text, desaturated accents, elevation by lighter surfaces instead
  of shadows ([UX Planet](https://uxplanet.org/dark-mode-ui-design-best-practices-8d3a00a83924),
  [UX Design Institute](https://www.uxdesigninstitute.com/blog/dark-mode/)).
- Clean, friendly web apps: one accent used for primary actions only (~10%
  of the surface), one corner-radius system, generous spacing
  ([daisyUI clean UI](https://trends.daisyui.com/trend/clean-ui/)).
- apply-pilot: inline 24×24 line SVG icons (stroke 2, round caps/joins,
  `currentColor`); tabs with icon + label, selected = accent text + 3px
  accent underline; utilities after a spacer with a 1px divider; red count
  badge; at narrow widths icon-over-label (a mobile nav bar), very narrow
  icons only with tooltips.

## 3. Design

### 3.1 Tokens (`client/styles.css` `:root` blocks)

Dark (default):

| Token | Value | Use |
|---|---|---|
| `--bg` | `#18191B` | page |
| `--card`, `--raised` | `#1F2022` | panels, app bar, toolbar, menus |
| `--sunken` | `#141516` | inputs, tracks |
| `--line` | `#2C2E31` | 1px borders, dividers |
| `--line-soft` | `#26282B` | inner separators |
| `--ink` | `#E8E9EB` | text |
| `--ink-2` | `#8B8F96` | secondary text, idle icons |
| `--accent` | `#39AEA9` | primary buttons, selected tab, focus, progress |
| `--accent-hover` | `#45BFBA` | |
| `--accent-ink` | `#0D1F1E` | text on accent |
| `--accent-soft` | `#1F2B2B` | "on" backgrounds |
| `--quiet` | `#557B83` | outlines of toggled-on buttons, secondary marks |
| `--ok` | `#A2D5AB` | success text, "on" text, 0 errors |
| `--highlight` | `#E5EFC1` | rare emphasis (wordmark detail, notices) |
| `--bad` | `#E8636F` | errors, badges (was `#E0525F`, which measured 4.30:1 on `--card` and failed §5's 4.5:1) |
| `--warn` | `#E7B14D` | warnings |
| `--focus` | `#39AEA9` | focus ring |

Light mode: off-white page `#F6F7F7`, white cards, `#DDE1E3` lines, ink
`#16191B`, secondary `#5B6268`, accent darkened to `#1F7C78` so text and
white-on-accent meet WCAG AA (≥ 4.5:1), `--ok` `#26704A`, `--quiet` `#557B83`.
Exact contrast ratios are checked by a test (§5).

Shape and spacing: radius 6px controls, 8px cards; 1px borders; no drop
shadows except menus/toasts (one soft shadow); spacing scale 4/8/12/16/24.
Old glass/blur variables are removed and their uses replaced.

### 3.2 Icons (`client/icons.ts`)

- `icon(name, opts?) → string` returns an inline `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">`
  with `fill:none; stroke:currentColor; stroke-width:2; round` caps/joins.
- Set: guide (checklist), simulate (pulse), parts (chip), pinouts (pin),
  checks (shield-check), truth (table), options (gear), run (play), step
  (step), reset (rotate), fit (corners), fullscreen, wires (square path),
  cube (3D), export (download), connect (link), moon, sun, close, chevron,
  plus, search, wire, duplicate, trash, eye, undo, redo, exit.
- Icon-only buttons always carry `title` and `aria-label`.

### 3.3 Project page (mockup `layout-v2`)

- **App bar**: brand mark + "Bench**Mate**" (Mate in accent), project name
  (full path in its tooltip), connected-agent count with a mint dot, Connect,
  theme toggle (moon/sun icon).
- **Toolbar** (one row, groups split by 1px dividers): Run (primary), Step,
  Reset (icon) | Fit (icon), Full screen (icon), Square wires (toggle), 3D |
  Export ▾ (menu: SVG, PNG, Schematic, Print) | right side: ✓ N errors
  (mint when 0, red otherwise), wires, board kind.
- **Show filter** floats in the board's bottom-left corner.
- **Net legend** is one horizontally scrolling strip with short names (the
  part of a `Net-(X-Pin)` name inside the brackets, e.g. `R7-Pad1` → `R7`
  where the pin is the only connection, else `U1-A1`); the full name is in
  the tooltip. Hover and click behaviour unchanged.
- **Side panel tabs**: icon-over-label (Guide, Simulate, Parts, Pinouts,
  Checks, Truth), spacer, divider, Options; selected = accent text + 2px
  underline; Checks shows a red count of errors+warnings when > 0. Tab
  `data-tab` attributes are unchanged.
- Full-screen controls (`fschrome.ts`), the Show bar, callouts and the
  Detail toggle (phase 4) use the same tokens and icons.

### 3.4 Other screens

- **Home**: same app bar; project cards and folders as bordered cards with
  hover lift by border colour, primary "Open" in accent, drop zone with a
  dashed `--line` border and teal on drag-over.
- **3D editor workspace**: its hard-coded dark rgba values become tokens
  (it always uses the dark set, as now); tray tiles, toolbar buttons
  (`.ws-btn`), card, wire card and legend get the same shapes and icons.
- **Connect page, toasts, menus, dialogs**: same tokens.

## 4. Implementation notes

- Replace the ~166 hard-coded colours in `styles.css` with tokens, keeping
  the well, wire and LED colours literal.
- Markup changes stay inside `client/panels.ts` (toolbar, tabs, legend),
  `client/main.ts` (app bar), `client/showbar.ts`, `client/fschrome.ts`,
  `client/editor3d/*` (workspace, tray tiles, cards) and the home/connect
  renderers. Behaviour, `data-*` hooks and handlers are unchanged.
- The `Theme` used by the 2D SVG renderer (`src/render/theme.ts`) only
  changes where it draws chrome-like ink outside the board, if any; board
  colours are untouched.

## 5. Testing

- Unit: a contrast test computes WCAG ratios for the token pairs in both
  modes (ink/card, ink-2/card, accent text/card, accent-ink/accent,
  ok/card, bad/card) and requires ≥ 4.5:1 for text pairs and ≥ 3:1 for
  large text / UI components.
- Unit: the short net-name function (`Net-(R7-Pad1)` → `R7`, ambiguous →
  `U1-A1`, power names unchanged).
- Existing unit tests and the 3D e2e suite pass unchanged.
- Manual: before/after screenshots of home, lab 6 in 2D (dark and light),
  lab 6 in the 3D editor, full screen compact.

## 6. Documentation

- `README.md` screenshot references (if any) and a short "Look and feel"
  note listing the palette and where tokens live.

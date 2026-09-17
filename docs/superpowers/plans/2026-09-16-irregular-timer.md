# Irregular Timer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a static web app that runs a sequential chain of countdown timers (irregular, user-entered durations, each with an optional message revealed at zero), beeping at each boundary and pausing for a manual "Next" click between intervals, shipped as a Docker container.

**Architecture:** A dependency-free static site (`index.html` + `style.css` + ES modules under `src/`) with three isolated modules — interval/message parsing, a timestamp-based timer state machine, and a Web Audio beeper — wired together by a thin DOM controller. Served in production by `nginx:alpine` via Docker Compose.

**Tech Stack:** Vanilla JS (ES modules, no bundler, no framework), Web Audio API, `bun:test` for unit tests (pure-logic modules only), `nginx:alpine` + Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-16-irregular-timer-design.md`

## Global Constraints

- No backend, no build step, no `package.json` — the shipped app is static files only (per spec "Directory layout" and "Docker"). No data persists across reloads or restarts.
- Timers run as a **sequential chain**, one interval at a time — never in parallel (per spec "Purpose" and "Non-goals").
- Each line is `duration` or `duration | message`. `duration` accepts plain seconds, `mm:ss`, or combinable unit suffixes `h`/`m`/`s` in that order (e.g. `1h5m`, `1m30s`, `45s`, `2m`); `message` is everything after the first `|`, trimmed, and may be omitted — per spec "Interval parsing". Zero and negative durations are parse errors.
- When an interval hits zero, the chain **stops and reveals that line's message** — it never auto-advances, even if multiple intervals' worth of time passed while the tab was backgrounded. Advancing always requires an explicit **Next** click (per spec "Timer engine" and "UI").
- Countdown must be computed from wall-clock timestamps (`Date.now()`), never a decrementing counter, so backgrounding a tab doesn't cause drift — per spec "Timer engine".
- All sound is generated at runtime via the Web Audio API — no bundled audio files (per spec "Sound").
- The textarea is only editable while idle (before Start, or after all timers complete) — per spec "UI".
- Docker: `nginx:alpine` serving the static files, `docker-compose.yml` mapping host `8080` to container `80` (per spec "Docker").

---

### Task 1: Interval + message parser (`src/parser.js`)

**Files:**
- Create: `irregular-timer/src/parser.js`
- Test: `irregular-timer/test/parser.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `parseIntervalLine(line: string): { seconds: number, message: string } | { error: string }`
  - `parseIntervals(text: string): { queue: Array<{ seconds: number, message: string }> } | { error: string, lineNumber: number, lineText: string }`

- [ ] **Step 1: Write the failing tests**

Create `irregular-timer/test/parser.test.js`:

```js
import { test, expect } from "bun:test";
import { parseIntervalLine, parseIntervals } from "../src/parser.js";

test("parseIntervalLine accepts plain seconds with no message", () => {
  expect(parseIntervalLine("90")).toEqual({ seconds: 90, message: "" });
});

test("parseIntervalLine accepts mm:ss", () => {
  expect(parseIntervalLine("1:30")).toEqual({ seconds: 90, message: "" });
});

test("parseIntervalLine accepts combined unit suffixes", () => {
  expect(parseIntervalLine("1m30s")).toEqual({ seconds: 90, message: "" });
  expect(parseIntervalLine("1h5m")).toEqual({ seconds: 3900, message: "" });
  expect(parseIntervalLine("45s")).toEqual({ seconds: 45, message: "" });
  expect(parseIntervalLine("2m")).toEqual({ seconds: 120, message: "" });
});

test("parseIntervalLine splits duration and message on the first pipe", () => {
  expect(parseIntervalLine("90 | Stretch break")).toEqual({ seconds: 90, message: "Stretch break" });
  expect(parseIntervalLine("30|Go|again")).toEqual({ seconds: 30, message: "Go|again" });
});

test("parseIntervalLine rejects zero and garbage durations", () => {
  expect(parseIntervalLine("0").error).toBeDefined();
  expect(parseIntervalLine("not-a-time").error).toBeDefined();
  expect(parseIntervalLine("banana | some message").error).toBeDefined();
});

test("parseIntervals builds a queue and skips blank lines", () => {
  const result = parseIntervals("30 | Stretch\n\n1:30\n2m | Water\n");
  expect(result).toEqual({
    queue: [
      { seconds: 30, message: "Stretch" },
      { seconds: 90, message: "" },
      { seconds: 120, message: "Water" },
    ],
  });
});

test("parseIntervals reports the failing line number and text", () => {
  const result = parseIntervals("30\nbanana\n90");
  expect(result.error).toBeDefined();
  expect(result.lineNumber).toBe(2);
  expect(result.lineText).toBe("banana");
});

test("parseIntervals rejects an empty or all-blank textarea", () => {
  expect(parseIntervals("").error).toBeDefined();
  expect(parseIntervals("\n\n  \n").error).toBeDefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd irregular-timer && bun test test/parser.test.js`
Expected: FAIL — `src/parser.js` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `irregular-timer/src/parser.js`:

```js
const CLOCK_PATTERN = /^(\d+):(\d{1,2})$/;
const UNIT_PATTERN = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
const PLAIN_SECONDS_PATTERN = /^\d+$/;

function parseDuration(text) {
  const trimmed = text.trim();

  const clockMatch = trimmed.match(CLOCK_PATTERN);
  if (clockMatch) {
    return finish(Number(clockMatch[1]) * 60 + Number(clockMatch[2]));
  }

  const unitMatch = trimmed.match(UNIT_PATTERN);
  if (unitMatch && (unitMatch[1] || unitMatch[2] || unitMatch[3])) {
    const hours = Number(unitMatch[1] || 0);
    const minutes = Number(unitMatch[2] || 0);
    const seconds = Number(unitMatch[3] || 0);
    return finish(hours * 3600 + minutes * 60 + seconds);
  }

  if (PLAIN_SECONDS_PATTERN.test(trimmed)) {
    return finish(Number(trimmed));
  }

  return {
    error: `"${text}" is not a valid interval (use seconds, mm:ss, or Xh Ym Zs)`,
  };
}

function finish(seconds) {
  if (seconds <= 0) {
    return { error: "Interval must be greater than zero" };
  }
  return { seconds };
}

export function parseIntervalLine(line) {
  const separatorIndex = line.indexOf("|");
  const durationText = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
  const message = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1).trim();

  const duration = parseDuration(durationText);
  if (duration.error) return duration;

  return { seconds: duration.seconds, message };
}

export function parseIntervals(text) {
  const lines = text.split(/\r?\n/);
  const queue = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === "") continue;

    const result = parseIntervalLine(raw);
    if (result.error) {
      return { error: result.error, lineNumber: i + 1, lineText: raw };
    }
    queue.push({ seconds: result.seconds, message: result.message });
  }

  if (queue.length === 0) {
    return { error: "Enter at least one interval", lineNumber: 0, lineText: "" };
  }

  return { queue };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd irregular-timer && bun test test/parser.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add irregular-timer/src/parser.js irregular-timer/test/parser.test.js
git commit -m "feat(irregular-timer): add interval and message line parser"
```

---

### Task 2: Timer state machine (`src/timer.js`)

**Files:**
- Create: `irregular-timer/src/timer.js`
- Test: `irregular-timer/test/timer.test.js`

**Interfaces:**
- Consumes: nothing (pure module, no dependency on Task 1 — takes plain `{ seconds, message }` objects, not parser output specifically).
- Produces:
  - `createTimerEngine(items: Array<{ seconds: number, message: string }>): { start(now?), pause(now?), resume(now?), tick(now?): string[], next(now?): string[], reset(), getState(now?): { state: "idle"|"running"|"paused"|"revealed"|"done", currentIndex: number, total: number, remainingMs: number, message: string } }`
  - `formatDuration(ms: number): string` — renders as `MM:SS`.

- [ ] **Step 1: Write the failing tests**

Create `irregular-timer/test/timer.test.js`:

```js
import { test, expect } from "bun:test";
import { createTimerEngine, formatDuration } from "../src/timer.js";

const ITEMS = [
  { seconds: 30, message: "First" },
  { seconds: 60, message: "Second" },
  { seconds: 10, message: "" },
];

test("start begins the first interval and getState reports remaining time", () => {
  const engine = createTimerEngine(ITEMS);
  engine.start(0);
  expect(engine.getState(0)).toEqual({ state: "running", currentIndex: 0, total: 3, remainingMs: 30000, message: "" });
  expect(engine.getState(10000)).toEqual({ state: "running", currentIndex: 0, total: 3, remainingMs: 20000, message: "" });
});

test("tick reveals the current message at zero and does not auto-advance", () => {
  const engine = createTimerEngine(ITEMS);
  engine.start(0);
  const events = engine.tick(30000);
  expect(events).toEqual(["boundary"]);
  expect(engine.getState(30000)).toEqual({ state: "revealed", currentIndex: 0, total: 3, remainingMs: 0, message: "First" });

  // Ticking again later (e.g. tab backgrounded past this point) must not advance further.
  expect(engine.tick(90000)).toEqual([]);
  expect(engine.getState(90000).currentIndex).toBe(0);
});

test("next advances through the chain and finishes after the last message", () => {
  const engine = createTimerEngine(ITEMS);
  engine.start(0);

  engine.tick(30000);
  expect(engine.getState(30000).message).toBe("First");
  expect(engine.next(30000)).toEqual([]);
  expect(engine.getState(30000)).toEqual({ state: "running", currentIndex: 1, total: 3, remainingMs: 60000, message: "" });

  engine.tick(90000);
  expect(engine.getState(90000).message).toBe("Second");
  expect(engine.next(90000)).toEqual([]);
  expect(engine.getState(90000)).toEqual({ state: "running", currentIndex: 2, total: 3, remainingMs: 10000, message: "" });

  engine.tick(100000);
  expect(engine.getState(100000)).toEqual({ state: "revealed", currentIndex: 2, total: 3, remainingMs: 0, message: "" });
  expect(engine.next(100000)).toEqual(["complete"]);
  expect(engine.getState(100000).state).toBe("done");
});

test("pause freezes remaining time and resume continues from it", () => {
  const engine = createTimerEngine(ITEMS);
  engine.start(0);
  engine.pause(10000);
  expect(engine.getState(99999)).toEqual({ state: "paused", currentIndex: 0, total: 3, remainingMs: 20000, message: "" });
  engine.resume(20000);
  expect(engine.getState(25000)).toEqual({ state: "running", currentIndex: 0, total: 3, remainingMs: 15000, message: "" });
});

test("reset returns to idle", () => {
  const engine = createTimerEngine(ITEMS);
  engine.start(0);
  engine.tick(30000);
  engine.reset();
  expect(engine.getState(0)).toEqual({ state: "idle", currentIndex: 0, total: 3, remainingMs: 30000, message: "" });
});

test("formatDuration renders mm:ss and rounds up to the next full second", () => {
  expect(formatDuration(90000)).toBe("01:30");
  expect(formatDuration(59000)).toBe("00:59");
  expect(formatDuration(250)).toBe("00:01");
  expect(formatDuration(0)).toBe("00:00");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd irregular-timer && bun test test/timer.test.js`
Expected: FAIL — `src/timer.js` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `irregular-timer/src/timer.js`:

```js
export function createTimerEngine(items) {
  let state = "idle";
  let currentIndex = 0;
  let intervalEndAt = null;
  let frozenRemainingMs = null;

  function start(now = Date.now()) {
    if (items.length === 0) throw new Error("items is empty");
    currentIndex = 0;
    intervalEndAt = now + items[0].seconds * 1000;
    frozenRemainingMs = null;
    state = "running";
  }

  function pause(now = Date.now()) {
    if (state !== "running") return;
    frozenRemainingMs = intervalEndAt - now;
    state = "paused";
  }

  function resume(now = Date.now()) {
    if (state !== "paused") return;
    intervalEndAt = now + frozenRemainingMs;
    frozenRemainingMs = null;
    state = "running";
  }

  function tick(now = Date.now()) {
    if (state !== "running" || intervalEndAt > now) return [];
    state = "revealed";
    return ["boundary"];
  }

  function next(now = Date.now()) {
    if (state !== "revealed") return [];
    if (currentIndex + 1 < items.length) {
      currentIndex += 1;
      intervalEndAt = now + items[currentIndex].seconds * 1000;
      state = "running";
      return [];
    }
    state = "done";
    return ["complete"];
  }

  function reset() {
    state = "idle";
    currentIndex = 0;
    intervalEndAt = null;
    frozenRemainingMs = null;
  }

  function getState(now = Date.now()) {
    let remainingMs;
    if (state === "running") {
      remainingMs = Math.max(0, intervalEndAt - now);
    } else if (state === "paused") {
      remainingMs = frozenRemainingMs;
    } else if (state === "idle") {
      remainingMs = (items[0]?.seconds ?? 0) * 1000;
    } else {
      remainingMs = 0;
    }
    const message = state === "revealed" ? items[currentIndex].message : "";
    return { state, currentIndex, total: items.length, remainingMs, message };
  }

  return { start, pause, resume, tick, next, reset, getState };
}

export function formatDuration(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
```

Note on `tick`: it only ever transitions `running → revealed`, once, for the *current* interval — it never loops through multiple elapsed intervals. That's intentional: the chain always stops and waits for an explicit `next()` call, even if the tab was backgrounded long enough that several intervals' worth of time has passed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd irregular-timer && bun test test/timer.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add irregular-timer/src/timer.js irregular-timer/test/timer.test.js
git commit -m "feat(irregular-timer): add timestamp-based timer state machine with reveal/next"
```

---

### Task 3: Beeper (`src/sound.js`)

**Files:**
- Create: `irregular-timer/src/sound.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `createBeeper(): { playBoundary(): void, playComplete(): void }`

No automated test for this task: it requires a browser `AudioContext`, which the spec's testing section scopes to manual browser verification. Verify manually once wired up in Task 5.

- [ ] **Step 1: Write the implementation**

Create `irregular-timer/src/sound.js`:

```js
export function createBeeper() {
  let ctx = null;

  function ensureContext() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return ctx;
  }

  function tone(context, startTime, frequency, duration) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    gain.connect(context.destination);
    gain.gain.setValueAtTime(0.2, startTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
    oscillator.start(startTime);
    oscillator.stop(startTime + duration);
  }

  function playBoundary() {
    const context = ensureContext();
    tone(context, context.currentTime, 880, 0.15);
  }

  function playComplete() {
    const context = ensureContext();
    const now = context.currentTime;
    tone(context, now, 880, 0.12);
    tone(context, now + 0.18, 880, 0.12);
    tone(context, now + 0.36, 880, 0.12);
  }

  return { playBoundary, playComplete };
}
```

- [ ] **Step 2: Commit**

```bash
git add irregular-timer/src/sound.js
git commit -m "feat(irregular-timer): add Web Audio beeper"
```

---

### Task 4: Static page shell (`index.html`, `style.css`)

**Files:**
- Create: `irregular-timer/index.html`
- Create: `irregular-timer/style.css`

**Interfaces:**
- Consumes: nothing yet (references `src/app.js`, built in Task 5).
- Produces: DOM element ids that Task 5 depends on: `intervals-input`, `countdown-display`, `reveal-message`, `status-message`, `start-btn`, `pause-resume-btn`, `next-btn`, `reset-btn`.

- [ ] **Step 1: Create `irregular-timer/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Irregular Timer</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <main class="app">
    <h1>Irregular Timer</h1>
    <textarea
      id="intervals-input"
      placeholder="One interval per line, e.g.&#10;30 | Stretch break&#10;1:30&#10;2m | Refill water"
    ></textarea>
    <div id="countdown-display" class="countdown">00:00</div>
    <div id="reveal-message" class="reveal" hidden></div>
    <div id="status-message" class="status"></div>
    <div class="controls">
      <button id="start-btn" type="button">Start</button>
      <button id="pause-resume-btn" type="button" disabled>Pause</button>
      <button id="next-btn" type="button" disabled>Next</button>
      <button id="reset-btn" type="button" disabled>Reset</button>
    </div>
  </main>
  <script type="module" src="src/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `irregular-timer/style.css`**

```css
:root {
  color-scheme: light dark;
  font-family: system-ui, sans-serif;
}

body {
  display: flex;
  justify-content: center;
  padding: 2rem 1rem;
}

.app {
  width: 100%;
  max-width: 28rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

textarea {
  width: 100%;
  min-height: 8rem;
  font: inherit;
  padding: 0.5rem;
  box-sizing: border-box;
}

textarea:disabled {
  opacity: 0.6;
}

.countdown {
  font-size: 3.5rem;
  font-weight: 700;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.reveal {
  font-size: 1.25rem;
  text-align: center;
  padding: 1rem;
  border: 1px solid currentColor;
  border-radius: 0.5rem;
  min-height: 2rem;
}

.reveal:empty::before {
  content: "(no message for this interval)";
  opacity: 0.6;
}

.status {
  min-height: 1.5rem;
  text-align: center;
}

.status.error {
  color: #c0392b;
}

.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.controls button {
  flex: 1;
  min-width: 6rem;
  padding: 0.6rem;
  font: inherit;
  cursor: pointer;
}

.controls button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
```

- [ ] **Step 3: Verify manually**

Run: `cd irregular-timer && python -m http.server 8000`, then open `http://localhost:8000` in a browser.
Expected: the page renders a title, textarea, "00:00" display, and four buttons (Pause, Next, and Reset disabled). A console error about `src/app.js` failing to load is expected until Task 5 — that's fine, this task only verifies the shell.

- [ ] **Step 4: Commit**

```bash
git add irregular-timer/index.html irregular-timer/style.css
git commit -m "feat(irregular-timer): add static page shell with reveal area and Next button"
```

---

### Task 5: Wire up the app (`src/app.js`)

**Files:**
- Create: `irregular-timer/src/app.js`

**Interfaces:**
- Consumes:
  - `parseIntervals` from `./parser.js` (Task 1)
  - `createTimerEngine`, `formatDuration` from `./timer.js` (Task 2)
  - `createBeeper` from `./sound.js` (Task 3)
  - DOM ids from `index.html` (Task 4): `intervals-input`, `countdown-display`, `reveal-message`, `status-message`, `start-btn`, `pause-resume-btn`, `next-btn`, `reset-btn`
- Produces: the fully working app (no further tasks depend on this one).

No automated test: this module is pure DOM wiring with no logic of its own to unit test (the logic it calls is already covered by Tasks 1–2). Verified manually below.

- [ ] **Step 1: Write the implementation**

Create `irregular-timer/src/app.js`:

```js
import { parseIntervals } from "./parser.js";
import { createTimerEngine, formatDuration } from "./timer.js";
import { createBeeper } from "./sound.js";

const textarea = document.getElementById("intervals-input");
const display = document.getElementById("countdown-display");
const revealEl = document.getElementById("reveal-message");
const statusEl = document.getElementById("status-message");
const startBtn = document.getElementById("start-btn");
const pauseResumeBtn = document.getElementById("pause-resume-btn");
const nextBtn = document.getElementById("next-btn");
const resetBtn = document.getElementById("reset-btn");

const beeper = createBeeper();
let engine = null;
let tickHandle = null;

function validate() {
  const result = parseIntervals(textarea.value);
  if (result.error) {
    statusEl.textContent =
      result.lineNumber > 0 ? `Line ${result.lineNumber}: ${result.error}` : result.error;
    statusEl.classList.add("error");
    startBtn.disabled = true;
    return null;
  }
  statusEl.textContent = "";
  statusEl.classList.remove("error");
  startBtn.disabled = false;
  return result.queue;
}

function render() {
  if (!engine) return;
  const state = engine.getState();

  if (state.state === "revealed") {
    display.hidden = true;
    revealEl.hidden = false;
    revealEl.textContent = state.message;
    statusEl.textContent = `Interval ${state.currentIndex + 1} of ${state.total} — click Next to continue`;
  } else {
    display.hidden = false;
    revealEl.hidden = true;
    display.textContent = formatDuration(state.remainingMs);
    if (state.state === "running" || state.state === "paused") {
      statusEl.textContent = `Interval ${state.currentIndex + 1} of ${state.total}`;
    } else if (state.state === "done") {
      statusEl.textContent = "All timers complete";
    }
  }

  pauseResumeBtn.disabled = state.state !== "running" && state.state !== "paused";
  nextBtn.disabled = state.state !== "revealed";
}

function startTicking() {
  stopTicking();
  tickHandle = setInterval(handleTick, 250);
}

function stopTicking() {
  if (tickHandle !== null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

function handleTick() {
  const events = engine.tick();
  for (const event of events) {
    if (event === "boundary") beeper.playBoundary();
  }
  render();
}

textarea.addEventListener("input", validate);

startBtn.addEventListener("click", () => {
  const queue = validate();
  if (!queue) return;
  engine = createTimerEngine(queue);
  engine.start();
  textarea.disabled = true;
  startBtn.disabled = true;
  resetBtn.disabled = false;
  pauseResumeBtn.textContent = "Pause";
  startTicking();
  render();
});

pauseResumeBtn.addEventListener("click", () => {
  if (!engine) return;
  const state = engine.getState();
  if (state.state === "running") {
    engine.pause();
    pauseResumeBtn.textContent = "Resume";
  } else if (state.state === "paused") {
    engine.resume();
    pauseResumeBtn.textContent = "Pause";
  }
  render();
});

nextBtn.addEventListener("click", () => {
  if (!engine) return;
  const events = engine.next();
  for (const event of events) {
    if (event === "complete") beeper.playComplete();
  }
  render();
  if (engine.getState().state === "done") {
    stopTicking();
    textarea.disabled = false;
    startBtn.disabled = false;
  }
});

resetBtn.addEventListener("click", () => {
  stopTicking();
  engine = null;
  textarea.disabled = false;
  display.hidden = false;
  revealEl.hidden = true;
  display.textContent = "00:00";
  pauseResumeBtn.disabled = true;
  pauseResumeBtn.textContent = "Pause";
  nextBtn.disabled = true;
  resetBtn.disabled = true;
  validate();
});

validate();
```

- [ ] **Step 2: Verify manually**

Run: `cd irregular-timer && python -m http.server 8000`, then open `http://localhost:8000`.

Walk through every scenario from the spec's testing section:
- Enter `2 | Stretch break\n1:05\n3 | Refill water` (mixed formats, one line with no message), click Start: countdown runs down from `00:02`, beeps, the countdown is replaced by the revealed box showing "Stretch break", status shows "Interval 1 of 3 — click Next to continue", and only Next is enabled. Click Next: countdown resumes at `01:05`. When it hits zero, beeps and reveals the placeholder text "(no message for this interval)" — because line 2 has no `|`. Click Next: countdown resumes at `00:03`, hits zero, beeps, reveals "Refill water". Click Next: plays the triple completion beep, shows "All timers complete", re-enables Start and the textarea.
- Clear the textarea entirely, or type `banana`: Start stays disabled and an inline error appears.
- Start a run, click Pause mid-interval, wait a few seconds, click Resume: the remaining time should reflect only the time elapsed *after* resuming, not the paused duration.
- Start a run with a short interval (e.g. `2 | Look up`), switch to another browser tab for 8+ seconds, switch back: the beep and reveal for that interval should have fired once, immediately, and the chain should be sitting at that reveal waiting for Next — not having skipped ahead.
- Click Reset mid-run (whether counting down or on a revealed message): controls return to the idle state and the textarea keeps its contents and is editable again.

- [ ] **Step 3: Commit**

```bash
git add irregular-timer/src/app.js
git commit -m "feat(irregular-timer): wire up DOM controller with reveal/Next flow"
```

---

### Task 6: Docker packaging

**Files:**
- Create: `irregular-timer/Dockerfile`
- Create: `irregular-timer/docker-compose.yml`

**Interfaces:**
- Consumes: the complete static site from Tasks 1–5 (`index.html`, `style.css`, `src/`).
- Produces: a running container serving the app on `http://localhost:8080`.

- [ ] **Step 1: Create `irregular-timer/Dockerfile`**

```dockerfile
FROM nginx:alpine

COPY index.html /usr/share/nginx/html/index.html
COPY style.css /usr/share/nginx/html/style.css
COPY src /usr/share/nginx/html/src

EXPOSE 80
```

- [ ] **Step 2: Create `irregular-timer/docker-compose.yml`**

```yaml
services:
  irregular-timer:
    build: .
    ports:
      - "8080:80"
```

- [ ] **Step 3: Build and run the container**

Run: `cd irregular-timer && docker compose up --build -d`
Expected: image builds successfully and the container starts.

- [ ] **Step 4: Verify manually**

Open `http://localhost:8080` in a browser and re-run the golden-path scenario from Task 5, Step 2 (mixed-format intervals with and without messages; confirm countdown, beep, reveal, Next, and completion all work identically to the `python -m http.server` run).

Run: `docker compose logs` if the page fails to load, to check for nginx errors.

- [ ] **Step 5: Stop the container**

Run: `cd irregular-timer && docker compose down`

- [ ] **Step 6: Commit**

```bash
git add irregular-timer/Dockerfile irregular-timer/docker-compose.yml
git commit -m "feat(irregular-timer): add Docker packaging"
```

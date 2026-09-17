# irregular-timer — Design

## Purpose

A small web app for running a sequence of countdown timers with irregular
(non-uniform) durations, entered as free text, one interval per line. Each
line may optionally carry a message. When an interval elapses, the app
plays a beep and reveals that line's message; the user reviews it and
clicks **Next** to start the following interval. Ships as a static site,
launched via Docker.

## Non-goals

- No backend logic, accounts, or persistence across sessions or restarts.
  The revealed messages are a display feature of the already-entered text,
  not stored data — nothing needs to survive a page reload.
- No parallel/independent timers — intervals run one at a time, in order.
- No custom/uploaded sound files — the beep is generated in-browser.
- No automatic advance past a revealed message — advancing always requires
  an explicit Next click, even for lines with no message.

## Directory layout

```
irregular-timer/
  index.html
  style.css
  src/
    parser.js
    timer.js
    sound.js
    app.js
  test/
    parser.test.js
    timer.test.js
  Dockerfile
  docker-compose.yml
```

Static site, no build step, no package.json. `parser.js` and `timer.js`
are pure logic (no DOM), so they're unit-tested directly; `sound.js` and
`app.js` depend on browser APIs (`AudioContext`, the DOM) and are verified
manually. The Docker image copies only `index.html`, `style.css`, and
`src/` — `test/` never ships.

## UI

- A `<textarea>` for entering intervals, one per line.
- A large countdown display (`MM:SS`), shown while an interval is counting
  down.
- A message reveal area: hidden while counting down, shown (with that
  line's message, or blank if none was given) once the interval hits zero.
- A status line: `Interval N of M` while running or revealed, `All timers
  complete` when finished, or a parse error message when a line is invalid.
- Buttons: **Start**, **Pause/Resume**, **Next**, **Reset**.
  - Start: enabled only while idle and the textarea is valid; parses the
    textarea and begins the chain.
  - Pause/Resume: enabled only while an interval is counting down; toggles
    and its label reflects the current action.
  - Next: enabled only once an interval has hit zero and its message is
    revealed; starts the following interval's countdown, or — after the
    last interval's message — finishes the chain (completion sound,
    "All timers complete").
  - Reset: stops the chain from any state and returns to the editable
    idle state (textarea contents are preserved so the same list can be
    replayed).
- The textarea is editable only while idle (before Start, or after the
  chain finishes) — never while an interval is counting down or a message
  is revealed.

## Interval parsing

Each non-blank line has the form `duration` or `duration | message`. The
`message` half is everything after the first `|`, trimmed as-is (it may
contain further `|` characters, spaces, or be omitted entirely, in which
case that interval reveals a blank message).

The `duration` half is parsed into a whole number of seconds using, in
order:

1. `mm:ss` — e.g. `1:30` → 90.
2. Unit-suffixed tokens, combinable and in any order — e.g. `2m`, `45s`,
   `1m30s`, `1h5m` → sum of `h`(3600) + `m`(60) + `s`(1) components.
3. A bare integer — e.g. `90` → treated as seconds.

Blank lines are ignored. A line whose duration half matches none of the
above is a parse error: the offending line is highlighted and its text
shown in the status line, and Start is blocked until the textarea is
corrected. Parsing runs on every Start press (and on input, to show live
errors), not once at load, since the textarea is only editable while idle.

Zero and negative durations are rejected as parse errors (a `0` line would
never visibly play a countdown).

## Timer engine

State machine: `idle → running ⇄ paused → revealed → running (next) → … →
revealed → done`.

- On Start: parse into `queue: Array<{ seconds: number, message: string }>`,
  set `currentIndex = 0`, `intervalEndAt = Date.now() + queue[0].seconds *
  1000`, state = `running`.
- A `setInterval` tick (every 250ms) while `running` computes
  `remainingMs = intervalEndAt - Date.now()` and updates the display from
  that, rather than decrementing a counter — this avoids drift if the tab
  is backgrounded/throttled, since the next tick simply recomputes from
  wall-clock time.
- When `remainingMs <= 0`: play the interval-boundary beep, move to
  `revealed` (display `queue[currentIndex].message`), and stop the tick —
  the chain does **not** auto-advance, even if the tab was backgrounded
  long enough to have crossed further boundaries; it always stops at the
  first one and waits for Next.
- Next (only actionable while `revealed`): if
  `currentIndex + 1 < queue.length`, increment `currentIndex`, set a new
  `intervalEndAt = Date.now() + queue[currentIndex].seconds * 1000`, and
  return to `running`. Otherwise play a distinct completion sound (triple
  beep) and move to `done`.
- Pause (only actionable while `running`): stores `remainingMs` at the
  moment of pausing, stops the tick. Resume: recomputes
  `intervalEndAt = Date.now() + remainingMs` and restarts the tick.
- Reset: clears all timer state and returns to `idle` without altering
  the textarea's contents.

## Sound

Web Audio API, generated at runtime — no audio asset files:

- Interval-boundary beep: one short oscillator tone, played when an
  interval hits zero and its message is revealed.
- Completion sound: three short tones in quick succession, played when
  Next is clicked on the last interval's revealed message — distinguishing
  "one interval done" from "whole sequence done".

A single shared `AudioContext` is created lazily on the first Start press
(browsers block autoplay of audio contexts created before a user
gesture).

## Error handling

- Invalid interval line → parse error shown inline, Start blocked (see
  above). This is the only validation surface; there is no other input.
- No intervals entered (empty/all-blank textarea) → treated the same as a
  parse error ("enter at least one interval").

## Docker

`Dockerfile` based on `nginx:alpine`, copying the static files into
`/usr/share/nginx/html`. `docker-compose.yml` maps host port `8080` to
container port `80` so the whole app launches with a single
`docker compose up`.

## Testing

No backend, so no server-side test suite. Verify manually in a browser
against:

- Golden path: several valid lines in mixed formats, some with messages
  and some without (`90 | Stretch break`, `1:30`, `2m | Refill water`),
  Start, confirm sequential countdown, beep + message reveal at each
  boundary, Next advances to the following countdown.
- Empty textarea and a line with an invalid duration both block Start
  with a clear error; a line with no `|` (no message) is valid.
- Pause mid-interval, wait, Resume — remaining time should reflect actual
  elapsed time, not have kept counting down while paused.
- Backgrounding the tab past when an interval would hit zero, then
  returning — the beep and reveal should fire once, immediately, rather
  than having stalled; the chain still waits at that reveal for Next
  rather than skipping ahead to later intervals.
- Clicking Next on the last interval's revealed message shows "All timers
  complete" and pressing Start again replays the same list.
- `docker compose up` serves the app at `http://localhost:8080` with no
  build step required beyond the image pull.

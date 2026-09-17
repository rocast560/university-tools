# irregular-timer — Design

## Purpose

A small web app for running a sequence of countdown timers with irregular
(non-uniform) durations, entered as free text, one interval per line. When
each interval elapses, the app plays a beep and automatically advances to
the next one. Ships as a static site, launched via Docker.

## Non-goals

- No backend logic, accounts, or persistence across sessions.
- No parallel/independent timers — intervals run one at a time, in order.
- No custom/uploaded sound files — the beep is generated in-browser.

## Directory layout

```
irregular-timer/
  index.html
  style.css
  app.js
  Dockerfile
  docker-compose.yml
```

Static site, no build step, no package.json.

## UI

- A `<textarea>` for entering intervals, one per line.
- A large countdown display (`MM:SS`).
- A status line: `Interval N of M` while running, `All timers complete`
  when finished, or a parse error message when a line is invalid.
- Buttons: **Start**, **Pause/Resume**, **Reset**.
  - Start: disabled while running; parses the textarea and begins the chain.
  - Pause/Resume: toggles; label reflects current action.
  - Reset: stops any running chain and returns to the editable idle state
    (textarea contents are preserved so the same list can be replayed).

## Interval parsing

Each non-blank line is parsed into a whole number of seconds using, in
order:

1. `mm:ss` — e.g. `1:30` → 90.
2. Unit-suffixed tokens, combinable and in any order — e.g. `2m`, `45s`,
   `1m30s`, `1h5m` → sum of `h`(3600) + `m`(60) + `s`(1) components.
3. A bare integer — e.g. `90` → treated as seconds.

Blank lines are ignored. A line matching none of the above is a parse
error: the offending line is highlighted and its text shown in the status
line, and Start is blocked until the textarea is corrected. Parsing runs
on every Start press (and on input, to show live errors), not once at
load, since the textarea is only editable while idle.

Zero and negative durations are rejected as parse errors (a `0` line would
never visibly play a countdown).

## Timer engine

State machine: `idle → running ⇄ paused → done → idle`.

- On Start: parse into `queue: number[]` (seconds), set
  `currentIndex = 0`, `intervalEndAt = Date.now() + queue[0] * 1000`,
  state = `running`.
- A `setInterval` tick (every 250ms) while `running` computes
  `remainingMs = intervalEndAt - Date.now()` and updates the display from
  that, rather than decrementing a counter — this avoids drift if the tab
  is backgrounded/throttled, since the next tick simply recomputes from
  wall-clock time.
- When `remainingMs <= 0`: play the interval-boundary beep, increment
  `currentIndex`. If `currentIndex < queue.length`, set a new
  `intervalEndAt` from `Date.now()` and continue running. Otherwise play a
  distinct completion sound (triple beep) and move to `done`.
- Pause: stores `remainingMs` at the moment of pausing, stops the tick.
  Resume: recomputes `intervalEndAt = Date.now() + remainingMs` and
  restarts the tick.
- Reset: clears all timer state and returns to `idle` without altering
  the textarea's contents.

## Sound

Web Audio API, generated at runtime — no audio asset files:

- Interval-boundary beep: one short oscillator tone.
- Completion sound: three short tones in quick succession, distinguishing
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

- Golden path: several valid lines in mixed formats (`90`, `1:30`, `2m`,
  `1m30s`), Start, confirm sequential countdown, beep, and advance.
- Empty textarea and a line with garbage text both block Start with a
  clear error.
- Pause mid-interval, wait, Resume — remaining time should reflect actual
  elapsed time, not have kept counting down while paused.
- Backgrounding the tab for longer than one interval, then returning —
  the engine should reflect real elapsed wall-clock time rather than
  having stalled or drifted.
- Full sequence completion shows "All timers complete" and pressing Start
  again replays the same list.
- `docker compose up` serves the app at `http://localhost:8080` with no
  build step required beyond the image pull.

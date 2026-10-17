---
type: working-agreement
status: active
updated: 2026-10-17
source: the user's instructions on 2026-10-17; docs/superpowers specs and plans; git log of university-tools@fde194f
description: How work on Typst Studio is done: superpowers specs then plans, test-driven development with vitest, plan execution handed to Sonnet subagents, never commit or push without asking, keep the brain current.
---
# How we work

## Workflow

1. **Spec first.** A new feature or behaviour change starts as a dated spec in `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`: goal, non-goals, findings, architecture, testing, risks. The user approves it in chat. Existing specs: [features](features.md).
2. **Then a plan.** `docs/superpowers/plans/YYYY-MM-DD-<topic>.md` breaks the spec into tasks with checkbox steps, code and the exact test to write. Plans open with the superpowers header (`REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans`).
3. **Test-driven.** For each task: write a failing vitest test, see it fail, write the code, see it pass. Pure logic goes in `src/lib/` (DOM-free) with a test in `src/test/`; server code gets a test beside it in `server/`. Never mark a task done without the passing output.
4. **Execution by subagents.** The user hands plan execution to several Sonnet subagents to save tokens. The lead (Opus or Sonnet) writes the spec and plan, gives each subagent one task or a set of independent tasks with the plan path, reviews the result, and fixes the plan when it was wrong (the git log shows many `docs(plan): ...` corrections made mid-execution). Use the `superpowers:subagent-driven-development` skill. Subagents do not load `CLAUDE.md` or memory; tell them to read `brain/index.md`.
5. **Verify before claiming done.** `bun run test` and `bun run typecheck`, then `bun run build`. For visible changes, check in a browser against the dev server, then rebuild the container and check there ([environment](environment.md)). Performance claims need numbers (the instant-switching spec measured before and after).

## Rules

- **Never commit or push without asking.** The git root is shared with other apps ([gotchas](gotchas.md)). Stage explicit paths. If asked to commit, end the message with the attribution line from the session instructions.
- **Do not open the user's documents in `data/`.** They are private reports. Folder listings are fine.
- **Don't edit files another agent is working on.** Check `git status` and [now](now.md) first.
- **Don't run a dev backend on 8090 while the container is up.**
- **Keep the server importing only `types`, `template` and `src/lib`** ([codemap](codemap.md)).
- **Write plainly.** Short sentences, concrete paths. No em dashes in notes.

## Keep the brain current

- Every change gets a line in `brain/daily/<date>.md` and an update to the note that owns the area, in the same session.
- Rewrite [now](now.md) when a task finishes.
- New decisions are appended to [decisions](decisions.md); traps go in [gotchas](gotchas.md); questions for the user in [open questions](open-questions.md).
- Re-read the code before bumping a note's `verified` date.

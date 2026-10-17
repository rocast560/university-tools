---
type: index
status: active
updated: 2026-10-17
description: Entry point to the Typst Studio brain; what each note answers and which one to open for a given question (architecture, file map, features, decisions, gotchas, Docker, MCP tools, backups).
---
# Typst Studio brain

Working memory for the Typst Studio app (`advanced-typst-editor/`): a local Typst editor with a live in-browser preview, an assets rail for screenshots and fonts, backups, and an MCP server so Claude can edit documents. Read this page, then [now](now.md). Open other notes only when the task needs them. How the brain is kept: [brain method](brain-method.md).

## Start here

- [now](now.md): current state, work in flight, uncommitted work to protect, next steps. Overwritten each task.
- [gotchas](gotchas.md): traps already hit. Read before touching Docker, the registry, fonts or the MCP tools.
- [how we work](how-we-work.md): specs and plans, TDD, subagent execution, no commit without asking.
- [data safety](data-safety.md): the never-lose-user-data rule of thumb, delete and overwrite audit, checklist, when to run the `typst-data-guard` agent. Read before touching disk, registry or backup code.

## Find it fast

| If you need... | Open |
|---|---|
| processes, data flow, the event bus, compile paths, MCP, backup | [architecture](architecture.md) |
| which file does what, and which test covers it | [codemap](codemap.md) |
| a user-facing feature, its files and its spec | [features](features.md) |
| why something is the way it is | [decisions](decisions.md) |
| how to run, test, build, deploy, or reach the container | [environment](environment.md) |
| something failed, or before retrying anything | [gotchas](gotchas.md) |
| a choice only the user can make, or a proposed hook | [open questions](open-questions.md) |
| what happened on a given day | [daily](daily/2026-10-17.md) |

Routing by grep: `grep -r "^description:" brain` prints one line per note.

## Sources the brain points to

The brain is the map; these are the territory.
- Code: `server/` (Bun backend), `src/` (React frontend). Start from [codemap](codemap.md).
- Design history: `docs/superpowers/specs/` (what and why) and `docs/superpowers/plans/` (how, task by task). Each is linked from [features](features.md) and [decisions](decisions.md).
- User docs: [README](../README.md).
- Shared repo: this app lives inside the `university-tools` git repo next to `circut-ai-tool`, `study-app`, `launcher` and others. See [gotchas](gotchas.md).

## Logs

- [decisions](decisions.md): D1 onward, append-only.
- [open questions](open-questions.md).
- Daily log: [2026-10-17](daily/2026-10-17.md).

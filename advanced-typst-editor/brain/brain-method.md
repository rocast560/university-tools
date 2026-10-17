---
type: explanation
status: active
updated: 2026-10-17
description: Brain rules and upkeep for Typst Studio: how notes are written, sized, linked and kept fresh; the one-writer rule; how this brain differs from the user's other brains; Claude Code loading behaviour that matters here.
---
# How this brain works

Contents: The idea, Rules for notes, Anti-loop rules, Agents, Layout, Differences from the other brains, Writing style, Claude Code specifics.

This is the user's brain method (BenchStack, Pool Cleaning Robot, NGCP; the fullest copy is `C:\Users\rober\Desktop\ngcp-dev\brain\brain-method.md`) adapted to one codebase. An agent starts each session knowing nothing. The aim is to get it to the right file fast and to record what the code can't show: why a thing is the way it is, what failed, what is in flight.

## Rules for notes

1. **Start small.** Read [index](index.md), then [now](now.md). Open other notes only when the task needs them.
2. **Route in one hop.** The index links every note directly. No note is reachable only through another.
3. **One home per fact.** Each fact lives in one note; others link to it.
4. **Point, don't paste.** Link to code and to `docs/superpowers/` specs and plans. The code and specs are the territory; the brain is the map.
5. **Don't restate what the code shows.** No dependency lists or full directory dumps. Say where to look and why.
6. **Name symbols, not line numbers.** `service.ts` -> `createWorkspaceService()`, not `service.ts:212`.
7. **Size: under about 200 lines per note.** Any note over 100 lines starts with a `Contents:` line under its H1.
8. **Frontmatter is flat:** `type`, `status`, `updated`, `description` on every note (daily notes skip `description`). Notes built from code add `verified` (date checked against source) and `source` (`repo@commit`). `covers` lists repo paths a note describes.
9. **`description` is a router line.** It leads with the keywords a request would contain. `grep "^description:" -r brain` lists them all.
10. **Mark what's verified.** Never bump `verified` without re-reading the source. Say "unconfirmed" or "inference" where that is true.
11. **Links are relative markdown links** with forward slashes. No wikilinks, no anchors. Paths into the app use `../` from `brain/`.
12. **Cite paths that exist.** Check new paths with Glob before writing them down.

## Anti-loop rules

- **[now](now.md) is overwritten** when a task finishes: focus, next steps each with a done-check, blockers, uncommitted work, work in flight.
- **Done means evidence.** Mark a step done only with the command or test that shows it, and the date.
- **[gotchas](gotchas.md) holds traps and "tried and failed" entries** with the exact error text. Check it before retrying anything.
- **Stop rule:** past about 10 tool calls on one lookup, or two failed attempts, stop, write what you found into the owning note, and ask or add an [open question](open-questions.md).
- **[decisions](decisions.md) is append-only** (Dn, date, decision, why, source, status). A reversal is a new entry; the old one says "replaced by Dn".
- **Daily notes** in `daily/YYYY-MM-DD.md` log concrete things: commands, results, commits. Add to today's; leave older days alone.

## Agents

- **One writer per file.** The lead gives each agent the notes it owns. Shared logs (index, now, decisions, gotchas, open questions, today's daily note) are written by the lead only.
- Every delegation prompt says: read `brain/index.md` first (Explore and Plan agents skip `CLAUDE.md`), the objective, the notes the agent owns, the output size, and a stop condition.
- Long reports go to a scratchpad file; agent replies get truncated in transit.

## Layout

| Path | What lives there |
|---|---|
| `index.md`, `now.md` | Entry point and routing table; current state |
| `architecture.md`, `codemap.md`, `features.md` | How it fits together; file-by-file map with tests; feature to files to spec |
| `environment.md`, `how-we-work.md` | Run, test, build, deploy; workflow and rules |
| `decisions.md`, `gotchas.md`, `open-questions.md` | Shared logs |
| `daily/` | Dated work log |

Two folder levels at most. File names are kebab-case nouns people would search for.

## Differences from the other brains

- **No `project-overview.md`.** The README and `architecture.md` cover it.
- **`codemap.md` and `features.md` replace the per-system notes.** This is one app, so a table of file to job to tests is the useful map.
- **No lint script yet.** NGCP has `scripts/brain-lint.mjs`; see [open questions](open-questions.md).
- **Decisions come from dated specs.** Each links its source spec or plan.

## Writing style

Plain, short sentences. Say what a thing is and where it lives. No filler, no hype, no em dashes. Tables for maps and lookups.

## Claude Code specifics

As recorded in the NGCP research (`ngcp-dev/brain/research/brain-methods-2026-10.md`, checked 2026-10-16). Not re-checked for this brain.

- `advanced-typst-editor/CLAUDE.md` loads for sessions started in this folder. Ancestors load too; `university-tools` has no `CLAUDE.md` or `AGENTS.md` today.
- `CLAUDE.md` names brain paths as plain text, not `@` imports, because imports load whole files at launch and save nothing.
- `AGENTS.md` is ignored when a `CLAUDE.md` exists in the directory or above. The `AGENTS.md` here is a pointer for other tools.
- Project `.claude/settings.json` is read only from the starting directory. This folder sits inside the shared `university-tools` repo, so a hook belongs in user settings with a path guard. See the proposal in [open questions](open-questions.md).
- Rules that must always hold belong in hooks or scripts. Notes are context, not enforcement.

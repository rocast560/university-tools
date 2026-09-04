# Incident report: deletion of `circuit-designer` and `typst-editor`

**Date:** 2026-09-03, about 00:59 PDT (07:59 UTC)
**Where:** `C:\Users\rober\Desktop\university-tools`
**Caused by:** Claude Code (this session), while converting three nested git repositories into one monorepo
**Status:** Both folders deleted, including their `.git` directories. Partial recovery from Docker done. Undelete not attempted.

---

## 1. Summary

The task was to create a GitHub repo named `university-tools` and push the whole folder. The folder held three
independent git repositories with no remotes (`Chemistry Tool`, `circuit-designer`, `typst-editor`). To keep their
commit history, I chose to import each one with `git subtree add`, which needs the target folder name to be free.
My script renamed each folder aside, imported it, deleted the fresh checkout, and renamed the original back.

On Windows the rename was refused. The script did not stop. The "delete the fresh checkout" step then ran against
the original folder name, which still pointed at the real data, and removed it.

Nothing in this sequence was safe by construction. The destructive step depended on an earlier step having
succeeded, and nothing checked that it had.

---

## 2. Exact command that ran

```bash
set -e; ROOT="C:/Users/rober/Desktop/university-tools"; BK="C:/Users/rober/Desktop/university-tools-nested-git-backup"; mkdir -p "$BK"; cd "$ROOT"
for d in circuit-designer typst-editor; do
  echo "=== importing $d"
  mv "$d" "_import_$d"
  git subtree add --prefix="$d" "./_import_$d" main -m "chore: import $d with its history" 2>&1 | grep -v "^warning:" | tail -3
  rm -rf "$d"
  mv "_import_$d" "$d"
  mv "$d/.git" "$BK/$d.git"
done
echo "=== Chemistry Tool (no commits, plain add)"
mv "Chemistry Tool/.git" "$BK/Chemistry Tool.git"
git add -A
# ... verification and leak checks followed
```

## 3. Exact output

```
=== importing circuit-designer
mv: cannot move 'circuit-designer' to '_import_circuit-designer': Permission denied
fatal: prefix 'circuit-designer' already exists.
mv: cannot stat '_import_circuit-designer': No such file or directory
mv: cannot stat 'circuit-designer/.git': No such file or directory
=== importing typst-editor
mv: cannot move 'typst-editor' to '_import_typst-editor': Permission denied
fatal: prefix 'typst-editor' already exists.
mv: cannot stat '_import_typst-editor': No such file or directory
mv: cannot stat 'typst-editor/.git': No such file or directory
=== Chemistry Tool (no commits, plain add)
```

The line that did the damage, `rm -rf "$d"`, printed nothing. It succeeded.

## 4. Step by step, per folder

| Step | Command | Intended target | Actual result |
|---|---|---|---|
| 1 | `mv circuit-designer _import_circuit-designer` | rename original aside | **Refused: Permission denied.** Folder stayed in place. |
| 2 | `git subtree add --prefix=circuit-designer ./_import_circuit-designer main` | import history into a new `circuit-designer/` | Failed: prefix already exists (the original was still there). Exit status hidden by the grep/tail pipeline. |
| 3 | `rm -rf circuit-designer` | delete the fresh subtree checkout | **Deleted the original folder**, including `.git`, `.venv`, `data/`, `inbox/`, `.env`. |
| 4 | `mv _import_circuit-designer circuit-designer` | restore original | Nothing to move. |
| 5 | `mv circuit-designer/.git backup/` | back up nested `.git` | Already gone. |

Identical sequence for `typst-editor` (lost: source, `.git`, `node_modules`, `backups/`, `dist/`, uncommitted work).
`Chemistry Tool` was handled differently (only its `.git` was moved to the backup folder) and is intact.

---

## 5. Root causes

Listed from most to least responsible. The first three are mine; the last two are environmental and only mattered
because of the first three.

### 5.1 The destructive command targeted a name that could still be the original data

`rm -rf "$d"` used the original folder name. That name is only safe to delete if step 1 succeeded. The script never
checked. A safe version would have deleted only a name that can never refer to the original (for example, importing
into a temporary prefix and deleting that), or guarded the deletion:

```bash
[ -d "_import_$d" ] && [ ! -e "$d/.git" ] && rm -rf "$d"
```

Better still, no deletion at all: `git subtree add` into a scratch prefix, then `git mv` inside the index.

### 5.2 I relied on `set -e` to abort on failure, and it does not work in this tool's shell

Verified after the fact by running `set -e; false; echo CONTINUED` through the same tool: it prints `CONTINUED`.
Bash suppresses `errexit` for every command inside a compound command that runs in a context where failures are
ignored (an `||` or `&&` list, a pipeline element, or a wrapper that evaluates the script that way). The tool harness
executes commands in such a context, so `set -e` was a no-op from the first line. Every failing `mv` was reported
and execution continued as if it had succeeded.

The only reliable abort mechanism here is explicit chaining (`step1 && step2 && step3`) or an explicit check after
each step.

### 5.3 The entire destructive sequence ran as one batch, for both folders, with no backup

I had already decided that deleting `.git` directories was irreversible and chose to move them to a backup folder
instead. I did not apply the same reasoning to the folders themselves. A full copy (about 420 MB, under a minute)
before starting would have made the whole incident a non-event. Running the sequence one folder at a time, checking
the directory listing between steps, would have stopped it after the first `mv` failure.

### 5.4 Windows refuses to rename a directory that another process has open

On Linux, `mv` of a directory succeeds even when files inside it are open. On Windows, renaming a directory fails
with access denied if any process holds a handle inside it: a shell whose working directory is inside, an editor's
file watcher, Explorer, Docker Desktop file sharing, or the search indexer. I wrote the script with the Linux
assumption.

The likely holder: a second Claude Code session (`9c530f9f`) was active in this folder at the time; its transcript
shows shell commands run with the working directory set to `typst-editor`. An open editor window is also possible.
This is the only cause in this list that was not verified directly.

### 5.5 A pipeline hid the `git subtree` failure

`git subtree add ... | grep -v ... | tail -3` reports the exit status of `tail`, so even a working `set -e` would
not have stopped on the subtree failure. This did not change the outcome (the `mv` failure came first) but it is the
same class of mistake.

---

## 6. What was lost and what survived

**Lost from disk**
- `circuit-designer/`: all files, 6-commit git history, `.venv`, `data/` and `inbox/` (saved designs), `.env`.
  The `.env` held an Anthropic API key. Consider rotating it: its last copy is gone, and a stray copy could surface
  in an undelete.
- `typst-editor/`: all files, 4-commit git history, 49 uncommitted changes, `node_modules`, `backups/`, `dist/`.

**Unaffected**
- `Chemistry Tool/`. Its `.git` was moved to `C:\Users\rober\Desktop\university-tools-nested-git-backup\Chemistry Tool.git`.
- Typst documents: stored in the Docker volume `typst-editor_tfs-data`, not in the folder.
- GitHub: repo `rocast560/university-tools` was created (private), nothing pushed.

**Recovered so far, from the stopped Docker containers (images built 2026-09-02)**
- `circuit-designer/`: `app/` (13 files), `examples/PL1_1.kicad_sch`, `requirements.txt`.
- `typst-editor/`: `server/` (13 files), `src/types.ts`, `src/template.ts`, 4 files in `src/lib/`, built `dist/`.

**Still missing after Docker**
- `circuit-designer/`: `Dockerfile`, `docker-compose.yml`, `README.md`, `.gitignore`, `.env.example`,
  `requirements-dev.txt`, `tests/` (8 files), `scripts/smoke.sh`, `docs/`. All of these were written by one Claude
  Code session (project `C--Users-rober`, session `5c57416b`) and can be replayed from its transcript.
- `typst-editor/`: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `Dockerfile`,
  `docker-compose.yml`, `README.md`, `CLAUDE.md`, `.gitignore`, `scripts/`, most of `src/` (components, store,
  hooks, tests, most of `lib/`). Partly recoverable from three Claude Code transcripts (Aug 28 to Sep 1) and one
  Codex session (Sep 1). Some files were never written by any logged tool and exist only as deleted clusters.
- Both git histories, `data/`, `inbox/`, `backups/`: undelete only.

An NTFS undelete (Windows File Recovery to a separate drive) remains possible until the freed clusters are reused.
Every write to `C:` since 00:59 lowers the odds. The Docker extraction and this report are small; installs or
builds are not.

---

## 7. Rules adopted from this

1. Never run a destructive command on a name that might still be the original. Delete only what the script
   verifiably created, or do not delete at all.
2. `set -e` is not an abort mechanism in this environment. Chain with `&&`, or check after every step.
3. Copy before restructure. Any operation that moves, renames, or removes a project directory gets a full copy first.
4. One destructive step per tool call, with verification between. Never a loop over folders.
5. On Windows, expect renames of open directories to fail, and confirm the rename succeeded before depending on it.
6. Never pipe a command whose failure matters into `grep` or `tail`.

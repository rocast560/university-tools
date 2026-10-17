---
type: open-questions
status: active
updated: 2026-10-17
description: Questions only the user can answer for Typst Studio (launcher status, branch for commits, brain lint script) and a proposed SessionStart stale-check hook, not installed.
---
# Open questions

When one is answered, write the answer into the note that owns the topic (and [decisions](decisions.md) if it is a decision), then delete it here. Ask the user one at a time, most important first.

## For the user

1. **Which branch should this app's commits go on?** The working tree was on `feat/74ls151-sim` on 2026-10-17 (see [gotchas](gotchas.md)). Three files of earlier work are uncommitted ([now](now.md)).
2. **Is the Tauri launcher (`../launcher`) in use, or is Docker the only deployment?** The design and plan 3 built it; the README documents only Docker. If unused, [architecture](architecture.md) and [features](features.md) should say "retired".
3. **Does the preview lock persist across reloads, and is it per workspace or global?** Wait for the in-progress work to land, then record the answer in [features](features.md).
4. **Which preview-to-source approach, once the research doc exists?** `docs/research/2026-10-17-preview-source-mapping.md` is being written. A choice supersedes [decisions](decisions.md) D11.
5. **Should the stale `POST /api/documents` comment in `src/template.ts` be fixed?** Not touched here (no source edits). Trivial.
6. **Add a brain lint script?** NGCP has `scripts/brain-lint.mjs` (broken links, orphans, frontmatter, size). A copy adapted to this folder would keep the notes honest. Source: `C:\Users\rober\Desktop\ngcp-dev\scripts\brain-lint.mjs`.

## Proposed hook (not installed)

The user's brains use SessionStart hooks that print how far the code has moved since the brain last checked it. NGCP: `C:\Users\rober\.claude\hooks\ngcp-brain-check.sh`, registered in `~/.claude/settings.json`, path-guarded to `ngcp-dev`. Pool Robot: a project-level `.claude/hooks/now-check.sh` in its own folder.

Proposal for this app, written for review only; no settings file was touched:

- **Where:** a user-level script, `C:\Users\rober\.claude\hooks\typst-brain-check.sh`, registered beside the NGCP entry in `~/.claude/settings.json`. User-level, because project `.claude/settings.json` is read only from the session's starting directory, and this folder sits inside the shared `university-tools` repo, so a project file would also fire for the other apps' sessions or not at all.
- **Guard:** exit 0 unless `CLAUDE_PROJECT_DIR` (or the cwd) is under `C:/Users/rober/Desktop/university-tools/advanced-typst-editor`.
- **Output (keep under 10,000 characters):**
  1. when `brain/now.md` was last written;
  2. `git branch --show-current` and `git status --short -- advanced-typst-editor` (uncommitted work to protect);
  3. for each `source: university-tools@<sha>` in the notes, the count of commits since that sha touching `advanced-typst-editor/` (`git rev-list --count <sha>..HEAD -- advanced-typst-editor`), with the notes that cite it;
  4. files under `server/`, `src/` and `docs/` newer than `now.md`;
  5. one closing line: read `brain/index.md` then `brain/now.md`.
- **Matchers:** all SessionStart sources, so state is re-injected after compaction.
- **Risk:** the hook runs `git` in a big shared repo; limit it to path-scoped commands to stay fast.

## Data safety (from the 2026-10-17 audit)

Details and the full table: [data safety](data-safety.md). Items 1 to 3 were **resolved the same day** (the lead judged them inside the user's "nothing gets deleted" rule): corrupt registry kept as `.corrupt-*` plus a rolling `.bak` that an empty registry never refreshes; asset and file delete move to `data/trash/<stamp>/<workspace>/`; `export_pdf` only writes `.pdf` and never into the trash. Reviewed by `typst-data-guard`: SAFE WITH NOTES. Item 4 is still open.

1. **(resolved)** A corrupt `settings.json` reads as an empty registry and the next write saves it.** (`server/settings.ts:135`, then `write` at `:139`.) Folders, folder icons and colours, and backup destinations would be lost; no copy of the registry exists. Smallest fix: when the file exists but fails to parse, keep a `settings.json.corrupt-<stamp>` copy and refuse to overwrite it, or keep `settings.json.bak` on each write. Want it?
2. **(resolved)** **`delete_asset`, REST asset delete and file delete are permanent unlinks** (`server/workspace.ts:295`, `:410`). Should they move to a per-workspace `.trash/` instead, like workspace delete does? Without a backup destination there is no way back today.
3. **(resolved)** **`export_pdf` `to` can overwrite any absolute path, including `/data/settings.json`** (`server/compile.ts:150`). Should it refuse existing files, or paths inside `DATA_DIR`?
4. **`data/trash/` and `data/pre-restore-*` are never pruned and have no restore button.** Add a "restore from trash" action, or leave it manual?
5. **(resolved 2026-10-17)** **Logos are not in backups.** Uploaded logos live in `data/logos/`, outside workspace folders, and `settings.json` is not mirrored either, so a backup restore brings back documents but not logos, nesting or folder looks. Resolved: the mirror and snapshots now carry both under `.typst-studio/` (see [data safety](data-safety.md)); restore brings back missing logos, and `settings.json` is restored by hand.

## Theme

1. **(resolved 2026-10-17)** JetBrains Mono is bundled in `public/ui-fonts/` (user approved the download).

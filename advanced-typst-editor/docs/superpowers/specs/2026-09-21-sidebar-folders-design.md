# Sidebar folders: nesting, drag-and-drop, icons and colors

Date: 2026-09-21. Status: approved in conversation, ready for an implementation plan.

## 1. Goal

The sidebar's folders ("groups") are a flat list of strings. A workspace belongs
to at most one of them, every folder looks identical, and the only way to move a
workspace is to drag it onto a folder header or type a group name into a
`window.prompt`. With eight workspaces across `CPTC` and `ECE-2300L` that is
already thin; it does not survive a second semester.

This adds four things to the sidebar, and only the sidebar:

- **Subfolders** — folders nest, up to four levels (`School/ECE-2300L/Labs/Lab3`).
- **Drag-and-drop** — drag a workspace into any folder, and drag a folder into
  another folder to nest it, with a visible drop target.
- **Folder icons** — one of ~40 curated Lucide icons per folder.
- **Folder colors** — one of ten theme-aware colors per folder.

### Non-goals

The asset folders inside a workspace (`TypstAssetsPanel`, `AssetFolder`) are
untouched; they already nest and already accept drags. No manual sort order:
folders stay A–Z and workspaces stay most-recently-opened, so there is no
ordering field to maintain and no question about where a new workspace lands.
No multi-select drag. No folder sharing between workspaces.

## 2. Data model

A folder's identity **is its path**: `CPTC`, `CPTC/inject`. This is the pattern
the repository already uses for asset folders — `src/lib/folder-paths.ts` opens
with "a folder id IS its path relative to `assets/`" — and it is what keeps this
change small. `WorkspaceEntry.group` keeps its `string | null` type; only its
contents gain slashes. Existing values are already valid one-segment paths, so
**no migration of `data/settings.json` is required**.

The alternative considered and rejected was a record model
(`folders: [{ id, name, parentId, icon, color }]` with `WorkspaceEntry.folderId`).
It makes renames a one-field edit, but it forces a settings migration, changes
the backup snapshot manifest shape so that pre-existing snapshots restore into
no folder, and turns the `move_workspace` MCP argument from a readable name into
an opaque UUID that a caller must first look up. The path model costs one piece
of string surgery on rename, contained in a tested pure function.

### 2.1 Types (`src/types.ts`)

```ts
/** Appearance of one sidebar folder, keyed by its path in Settings. */
export interface FolderMeta { icon?: string | null; color?: string | null }

export interface Settings {
  version: 1;
  workspaces: WorkspaceEntry[];
  /** Folder paths. Every ancestor of a stored path is itself stored. */
  groups: string[];
  /** Keyed by folder path; absent means the default look. */
  folderMeta: Record<string, FolderMeta>;
  backup: BackupSettings;
  typstCli: string | null;
  redaction: RedactionDefaults;
}
```

`icon` is a Lucide icon name (`"flask-conical"`); an unrecognised name falls back
to the plain folder icon rather than throwing. `color` is one of ten named
tokens (`"blue"`, `"amber"`, …), never raw hex, so it resolves through the
existing `hsl(var(--…))` theme and stays legible in both light and dark.

### 2.2 Invariants

1. **Ancestors exist.** Every prefix of a stored path is itself in `groups`, so
   an empty parent folder never disappears from the tree. `normalise()` in
   `server/settings.ts` back-fills missing ancestors, which also self-heals a
   hand-edited `settings.json`.
2. **Depth <= 4.** `depth("CPTC")` is 1, so a path holds at most four segments.
   Deep enough for `School/ECE-2300L/Labs/Lab3`, shallow enough that a 280px
   sidebar does not run out of indent.
3. **Unique siblings.** Two folders in the same parent cannot share a name; the
   path model enforces this for free.
4. **No separators in a segment.** `/` and `\` in a folder name become `_`,
   matching `folderPathFor` in `src/lib/folder-paths.ts`.
5. **No orphaned appearance.** `folderMeta` holds no key that is not a current
   folder path. `removeGroup` drops the subtree's entries, and `normalise()`
   prunes any that survive a hand edit.

### 2.3 `src/lib/folder-tree.ts` (new, pure)

DOM-free and Node-free, so both the browser and the server import it, like
`src/types.ts`:

| Function | Purpose |
|---|---|
| `parentPath(p)` / `folderName(p)` / `depth(p)` | Path arithmetic |
| `childPaths(groups, parent)` | Direct children, sorted, for one tree level |
| `descendantsOf(groups, p)` | The subtree, for rename and delete cascades |
| `isDescendant(p, ancestor)` | Cycle guard for re-parenting |
| `renamePath(all, from, to)` | The full rewrite map: groups, member workspaces, `folderMeta` keys |
| `sanitiseSegment(name)` | Invariant 4 |

## 3. Server

### 3.1 `SettingsStore` (`server/settings.ts`)

| Method | Behaviour |
|---|---|
| `addGroup(path)` | Back-fills every missing ancestor; idempotent |
| `renameGroup(from, to)` | Rewrites `from` and every descendant path, re-keys `folderMeta`, updates member workspaces — one atomic `update()` |
| `moveGroup(path, newParent)` | The same cascade, expressed as a rename to `newParent + "/" + name` |
| `removeGroup(path)` | Drops the folder, its subfolders and their `folderMeta` entries; every workspace inside any of them becomes loose at the top level. Nothing on disk is touched |
| `setFolderMeta(path, patch)` | Writes icon/color; `null` clears a field back to the default |

`listGroups()` keeps returning `string[]`; a new `folderMeta()` returns the map.

### 3.2 Validation (`server/service.ts`)

Each of these throws an `HttpError` whose message the sidebar can show verbatim:

- empty name or empty segment → 400
- resulting depth > 4 → 400
- a sibling of that name already exists → 409
- moving a folder into itself or a descendant → 400
- renaming or moving an unknown path → 404

### 3.3 Routes (`server/router.ts`)

No new endpoints. `server/router.ts` splits the raw pathname and decodes each
segment individually, so `/api/groups/CPTC%2Finject` already arrives as the
single segment `CPTC/inject`; nested paths need no URL scheme change.

| Route | Change |
|---|---|
| `GET /api/groups` | Returns `{ groups, folderMeta }` (was `{ groups }`) |
| `POST /api/groups` | Body gains `parent?`, `icon?`, `color?` |
| `PATCH /api/groups/:path` | Rename, re-parent and appearance share the route. `name` and `parent` are mutually exclusive in one request; `icon` and `color` may be sent together, and either may be `null` to clear it |
| `DELETE /api/groups/:path` | Unchanged; returns the new `{ groups, folderMeta }` |

`src/api/client.ts` and the store (`src/stores/index.ts`) follow: `groups` stays
`string[]`, a new `folderMeta` slice is added, and `createGroup(name, parent)`,
`moveGroup(path, parent)` and `setFolderAppearance(path, patch)` join the
existing group actions.

### 3.4 MCP (`server/mcp-tools.ts`)

`move_workspace` keeps its schema (`group: z.string().nullable()`). Its
description gains: use `/` to nest, for example `School/ECE-2300L`. No new
tools.

## 4. Backup mirror (`server/backup/mirror.ts`)

`planMirror` currently maps one group to one root-level directory. It becomes a
tree walk: each path segment passes through `safeDirName` **separately** — that
function replaces `/` with `_`, so splitting before sanitising is precisely what
makes nesting possible — with the uniqueness counter scoped per directory level
rather than globally. Loose workspaces and top-level folders keep sharing the
root namespace, as today.

A workspace in `School/ECE-2300L` mirrors to
`<destination>/School/ECE-2300L/<workspace>/`.

**A one-segment group plans the identical path it plans today.** Existing
top-level folders do not move on the first run after this change; only a folder
that is actually nested relocates, and the mirror's normal reconcile handles
that by moving the stale directory to `_trash/<timestamp>/`. The mirror deletes
nothing, and `README.txt` gains a sentence about nesting.

Snapshots are unaffected: `ManifestWorkspace.group` stays `string | null`, so
snapshots taken before this change still restore correctly — into a one-segment
folder.

## 5. User interface

### 5.1 File layout

`Sidebar.tsx` is 222 lines and would roughly triple. It splits:

```
src/components/sidebar/
  Sidebar.tsx            shell: header, rail, footer, dialogs
  FolderTree.tsx         recursive render of one level
  FolderRow.tsx          chevron · icon · name · count · drop target
  WorkspaceRow.tsx       one workspace, the drag source
  FolderAppearance.tsx   color + icon popover, lazy-loaded
  folder-icons.ts        the curated Lucide allow-list
src/lib/
  folder-tree.ts         pure path helpers (section 2.3)
  sidebar-dnd.ts         pure drop-legality rules
```

### 5.2 Drag and drop

The payload stays a single `text/plain` string, now tagged: `workspace:<id>` or
`folder:<path>`. Parsing and legality live in `src/lib/sidebar-dnd.ts` as pure
functions so the rules unit-test without a DOM.

- A workspace drops onto any folder, or onto the list background for top level.
  Always legal.
- A folder drops onto another folder or the background. Rejected when the target
  is itself or one of its descendants, when the resulting depth would exceed 4,
  or when a sibling of that name already exists at the destination.
- An illegal target does not highlight and ignores the drop. No error is shown
  for something the user can already see is not allowed.

A legal hovered target draws a ring in its folder color. Resting on a collapsed
folder for 600ms expands it, so a drag can reach a subfolder without dropping
first; a collapsed folder still accepts a direct drop, as it does today.

### 5.3 Icons and colors

Right-clicking a folder offers: **New subfolder** · **Rename** ·
**Appearance…** · **Delete**. Appearance opens a popover with ten color
swatches plus "no color", and a grid of ~40 curated Lucide icons. Both apply
immediately; there is no OK button.

The icon list is an explicit map in `folder-icons.ts` — name to component — so
a typo is a typecheck failure rather than a runtime blank. The exact roster is
validated against the installed `lucide-react` during implementation; the intent
is study-and-lab vocabulary: book, graduation-cap, flask-conical, cpu, shield,
terminal, clipboard-list, presentation, and so on.

Colors are added as `--folder-*` tokens in `src/index.css` beside the existing
`--status-*` set, defined once per theme. A folder's color tints its icon, its
collapsed-count badge, and a 2px left stripe on the row — enough to scan by, not
enough to shout.

### 5.4 Other sidebar changes

- The workspace context menu's `window.prompt("Group")` is replaced by a
  **Move to…** submenu listing every folder path plus "Top level". This is the
  keyboard-reachable way to move a workspace, since drag-and-drop is mouse-only,
  and it is faster than typing a path by hand.
- **New subfolder** shows an inline name input under the folder, mirroring the
  existing top-level folder input.
- A collapsed folder's count becomes its **total** descendants — workspaces in
  subfolders included — rather than direct children only.
- Empty folders render, including empty parents; that is how a subfolder gets
  created inside one.
- Within one level, subfolders are listed first (A–Z), then that folder's own
  workspaces (most-recently-opened first), which is the order
  `groupWorkspaces` already produces for the flat list.
- Collapse state needs no migration: `collapsed-groups.ts` keys on the folder
  string and `"CPTC"` is already its own path.

### 5.5 Accepted cost

The ~40 icons are statically imported so the bundler can resolve them, and the
sidebar is on the first-paint chunk: roughly 8–12 KB gzipped added. The picker
itself is lazy-loaded, as `FolderBrowserDialog` and `ConfirmDialog` already are,
but the icon map cannot be. Measured against `bun run build`; the set trims to
~20 if it lands badly.

## 6. Testing

Test-driven throughout, per the repository's existing workflow: a failing test,
then the code. Pure logic in `src/lib/` gets node-free unit tests, React gets
Testing Library, server code runs under the `server` vitest project.

**New**

- `src/test/folder-tree.test.ts` — path arithmetic, `childPaths`,
  `descendantsOf`, `isDescendant`, the `renamePath` rewrite map, segment
  sanitising, ancestor back-fill, the depth limit.
- `src/test/sidebar-dnd.test.ts` — payload parse round-trip and the `canDrop`
  matrix: workspace→folder, folder→itself, folder→own descendant, depth
  overflow, sibling collision, drop on root.

**Extended**

- `server/settings.test.ts` — `addGroup` back-fills ancestors; `renameGroup`
  cascades to descendants, member workspaces and `folderMeta` keys in one write;
  `removeGroup` drops the subtree and loosens its workspaces; `moveGroup`
  rejects a cycle; `normalise()` repairs a file missing an ancestor.
- `server/router.test.ts` — `POST` with `parent`; `PATCH` for each of rename,
  parent, icon, color; a percent-encoded nested path round-tripping through the
  segment decode; 409 on collision; 400 past depth 4.
- `server/backup/mirror.test.ts` — a nested group produces nested directories;
  two folders both named `Labs` under different parents each keep `Labs`; and a
  regression guard that a one-segment group plans the same path as today.
- `src/test/sidebar.test.tsx` — nested render, folder-onto-folder drag, illegal
  drop is a no-op, the appearance popover writes icon and color, New subfolder,
  the Move to… submenu, the descendant-counting badge. One existing assertion
  changes: `createGroup` is now called as `('CPTC', null)`.
- `src/test/store.test.ts` — `folderMeta` loads; the `moveGroup` action.

## 7. Risks

| Risk | Containment |
|---|---|
| A rename cascade corrupts group assignments | One atomic `update()`; the rewrite map is a pure function with direct tests |
| Backup tree churn on the first run after nesting | Stale directories move to `_trash/<timestamp>/`; the mirror never deletes. A top-level-only layout plans a byte-identical tree (regression test, section 6) |
| A hand-edited `settings.json` with an orphaned path | `normalise()` back-fills the missing ancestor instead of dropping the folder |
| ~40 icons on the first-paint chunk | Measured against `bun run build`; trimmable to ~20 |
| Deleting a folder feels destructive | The confirm dialog names the count of workspaces that will move to the top level, and states that nothing on disk is removed |

## 8. Verification

`bunx vitest run` (both projects) and `bun run typecheck` green, `bun run build`
clean. Then the dev server against the real `data/`: nest `ECE-2300L` under a
new `School` folder, drag a workspace between folders, set an icon and a color,
restart the server to confirm both persisted, and run a backup to a scratch
destination to confirm the nested tree and that `CPTC/` did not move.

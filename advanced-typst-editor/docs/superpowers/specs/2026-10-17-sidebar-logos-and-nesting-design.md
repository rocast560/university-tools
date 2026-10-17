# Sidebar logos and nested documents

Date: 2026-10-17. Status: approved direction (user answers below), details are the lead's calls.

## Why

The user wants the sidebar to carry more identity and structure: a logo on a folder or a document (a client's or team's mark, or an icon), and documents nested under documents by dragging, like pages within pages. Folders already nest (up to 4 levels, by drag) and already have an icon and colour picker ("Appearance…" on right-click). Documents have neither, and nothing can be uploaded.

## Decided by the user (2026-10-17)

- **Logo = both.** The built-in icon set and colours (`src/components/sidebar/folder-icons.ts`) *or* an uploaded image. Folders and documents get the same picker.
- **Nesting is sidebar-only.** Dragging document A onto document B shows A indented under B. Nothing moves on disk; each stays its own workspace folder with its own `main.typ`.

## Rules that shape everything (from `brain/data-safety.md`)

- Nothing here may lose user data. Every new settings field is optional and additive. An old `settings.json` loads unchanged, and a new one still loads in an older build (unknown fields are ignored there).
- Deleting a parent document never takes its children with it. They move up one level (to the parent's parent, or loose in the parent's folder).
- Clearing or replacing a logo never deletes the image file. Logos are small; they stay in `data/logos/`.

## Data model

`src/types.ts`:

- `FolderMeta` gains `logo?: string | null`: the file name of an uploaded image in `data/logos/`. Rename the type only if it stays cheap. The same shape now describes a document's appearance too.
- `WorkspaceEntry` gains optional fields:
  - `parent?: ID | null`: the document this one is nested under.
  - `appearance?: FolderMeta`: icon, colour and logo for the document row.

`server/settings.ts` `normalise()`:

- Keep `appearance` only when it holds a known icon name, a known colour or a safe logo file name (`^[a-z0-9-]+\.(png|jpe?g|webp|svg)$`).
- Drop a `parent` that names no existing workspace, that names itself, or that would form a cycle (walk up; cut at the first repeat).
- A child always carries its parent's `group`. On load, if they differ, the parent's group wins, so the backup mirror tree (which follows `group`) stays coherent.

## Behaviour

**Nesting**
- Drop a document on another document's row: it becomes that row's child.
  - Refuse (no highlight) when the target is the document itself or one of its descendants, or when the drop would exceed 4 levels of document nesting. Put this in `canDrop` in `src/lib/sidebar-dnd.ts`.
  - This replaces today's behaviour, where a drop on a row files the document into that row's folder.
- Drop a document on a folder header or the list background: `parent = null`, and `group` is that folder (or null). That's how you un-nest.
- "Move to…" in the right-click menu also clears `parent`.
- Moving a parent to another folder moves its whole subtree's `group` with it (server side, one registry write).
- Parents get a chevron. Their collapsed state is remembered like folders' (`src/lib/collapsed-groups.ts`, keys prefixed `ws:` so they can't clash with folder paths).
- Removing a workspace (single or bulk, see the multi-select delete work) re-parents its children to its own parent, in the same registry write. The confirm dialog says "N nested documents move up a level" when there are any.

**Appearance and logos**
- The document right-click menu gains "Appearance…", which opens the same popover as folders (`src/components/sidebar/FolderAppearance.tsx`, generalised), plus a "Logo" section:
  - "Upload image…": PNG, JPEG, WebP or SVG, at most 512 KB, rejected with a clear message otherwise.
  - a preview of the current logo;
  - "Remove logo", which unlinks it only.
- Row rendering: logo > icon > today's default (the folder glyph for folders, the dot for documents). A logo renders at 14px, `object-contain`, slightly rounded. The colour tints icons, not logos.

## API

- `POST /api/logos`: raw body with the image `Content-Type`. Returns `{ logo: "<random>.<ext>" }`. Size and type limits are enforced server-side. Files are written to `data/logos/` with `writeAtomic` from `server/fsx.ts`.
- `GET /api/logos/:file`: serves the file with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`. SVGs are only ever shown through `<img>`, so their scripts never run, but they are served sandboxed regardless.
- `PATCH /api/workspaces/:id` accepts `parent` (ID or null) and `appearance` (`{icon, color, logo}`, each nullable). Invalid values get a 400 naming the field.
- The folder appearance `PATCH` accepts `logo`.
- MCP:
  - `move_workspace` gains an optional `parent_id` (null clears; setting it also adopts the parent's folder).
  - `list_workspaces` / `get_workspace` show `parent` and `appearance` automatically.
  - Update tool descriptions in `server/mcp-tools.ts`. That file has an uncommitted one-line edit to `move_workspace`'s description; build on it.

## Tests (vitest, failing first)

- **Server:**
  - `normalise` keeps valid and drops invalid `parent` / `appearance` (unknown id, self, cycle, bad logo name);
  - the group follows the parent;
  - the subtree's group moves with the parent;
  - remove re-parents children;
  - logo upload accepts the four types, rejects other types and anything over 512 KB, and serves files back with the right headers.
- **UI:**
  - `canDrop` nesting rules (self, descendant, depth);
  - the sidebar renders a child under its parent and collapses it;
  - a drop on a row nests and a drop on a folder un-nests;
  - the appearance popover uploads and sets a logo, and removing it unlinks it;
  - row priority is logo > icon > default.

## Left to the builder

The exact popover layout, the chevron placement, whether `FolderMeta` is renamed, how the upload button shows progress, and the indent per nesting level (match folders: 12px).

## Out of scope

Reordering by drag within a level (order stays as today), moving folders on disk, and logos in backups (they live outside workspace folders; listed in `brain/open-questions.md`).

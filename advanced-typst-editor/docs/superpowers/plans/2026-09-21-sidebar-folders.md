# Sidebar Folders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Typst Studio sidebar nested folders, drag-and-drop for workspaces and folders, and a per-folder icon and color.

**Architecture:** A folder's identity is its path (`CPTC`, `CPTC/inject`), exactly as `src/lib/folder-paths.ts` already treats asset folders. `WorkspaceEntry.group` keeps its `string | null` type and merely gains slashes, so `data/settings.json` needs no migration and the `move_workspace` MCP tool and backup snapshot manifests keep working unchanged. Appearance lives in a parallel `folderMeta` map keyed by the same paths. All path arithmetic and all drop-legality rules are pure functions in `src/lib/`, unit-tested without a DOM; the React layer only renders them.

**Tech Stack:** Bun + TypeScript server, React 19, Zustand 5, Tailwind 4, lucide-react 1.40, Vitest 4 (two projects: `ui` with jsdom, `server` with node).

**Spec:** `docs/superpowers/specs/2026-09-21-sidebar-folders-design.md`

## Global Constraints

- **Git root is `C:/Users/rober/Desktop/university-tools`, not this project.** At the time of writing, 59 files under `circut-ai-tool/` are modified by unrelated work, and the branch is `main`. **Every commit in this plan must be path-scoped** — `git add advanced-typst-editor/<paths>`. Never `git add -A`, never `git add .`, never `git commit -a`.
- Run commands from `C:/Users/rober/Desktop/university-tools/advanced-typst-editor`.
- Tests: `bunx vitest run --project ui` and `bunx vitest run --project server`. Typecheck: `bun run typecheck` (checks both `tsconfig.json` and `tsconfig.server.json`). Both must pass before every commit.
- `src/types.ts` and `src/lib/folder-tree.ts` are shared by browser and server: **no DOM, no Node imports**.
- Maximum folder depth is **4**, where `depth('CPTC') === 1`.
- Folder colors are the ten names in `FOLDER_COLORS`; never raw hex.
- Folder icons are keys of `FOLDER_ICONS`; an unknown key falls back to the plain folder icon and must never throw.
- Path separators in a folder *name* are replaced with `_` (matches `folderPathFor` in `src/lib/folder-paths.ts`).

---

### Task 1: Pure folder-path helpers

**Files:**
- Create: `src/lib/folder-tree.ts`
- Test: `src/test/folder-tree.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_FOLDER_DEPTH: 4`, `sanitiseSegment(name: string): string`, `depth(p: string): number`, `folderName(p: string): string`, `parentPath(p: string): string | null`, `joinPath(parent: string | null, name: string): string`, `childPaths(groups: string[], parent: string | null): string[]`, `descendantsOf(groups: string[], p: string): string[]`, `isDescendant(p: string, ancestor: string): boolean`, `withAncestors(groups: string[]): string[]`, `renamePath(groups: string[], from: string, to: string): Map<string, string>`. Every later task uses these.

- [ ] **Step 1: Write the failing test**

Create `src/test/folder-tree.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  MAX_FOLDER_DEPTH, sanitiseSegment, depth, folderName, parentPath, joinPath,
  childPaths, descendantsOf, isDescendant, withAncestors, renamePath,
} from '@/lib/folder-tree';

describe('folder path arithmetic', () => {
  it('reads depth, name and parent off a path', () => {
    expect(MAX_FOLDER_DEPTH).toBe(4);
    expect(depth('CPTC')).toBe(1);
    expect(depth('School/ECE-2300L/Labs')).toBe(3);
    expect(folderName('School/ECE-2300L')).toBe('ECE-2300L');
    expect(folderName('CPTC')).toBe('CPTC');
    expect(parentPath('School/ECE-2300L')).toBe('School');
    expect(parentPath('CPTC')).toBeNull();
  });

  it('joins a parent and a name, sanitising separators', () => {
    expect(joinPath(null, 'CPTC')).toBe('CPTC');
    expect(joinPath('School', 'ECE-2300L')).toBe('School/ECE-2300L');
    expect(joinPath('School', ' Labs ')).toBe('School/Labs');
    expect(joinPath(null, 'a/b')).toBe('a_b');
    expect(joinPath(null, 'a\\b')).toBe('a_b');
  });

  it('sanitises a segment down to something storable', () => {
    expect(sanitiseSegment('  Lab 3  ')).toBe('Lab 3');
    expect(sanitiseSegment('a/b\\c')).toBe('a_b_c');
    expect(sanitiseSegment('   ')).toBe('');
  });
});

describe('tree queries', () => {
  const groups = ['CPTC', 'CPTC/inject', 'CPTC/report', 'School', 'School/ECE-2300L'];

  it('lists direct children only, sorted, for one level', () => {
    expect(childPaths(groups, null)).toEqual(['CPTC', 'School']);
    expect(childPaths(groups, 'CPTC')).toEqual(['CPTC/inject', 'CPTC/report']);
    expect(childPaths(groups, 'School/ECE-2300L')).toEqual([]);
  });

  it('sorts children by name, not by full path', () => {
    expect(childPaths(['B/a', 'B', 'B/Z', 'B/m'], 'B')).toEqual(['B/a', 'B/m', 'B/Z']);
  });

  it('collects a subtree without the folder itself', () => {
    expect(descendantsOf(groups, 'CPTC')).toEqual(['CPTC/inject', 'CPTC/report']);
    expect(descendantsOf(groups, 'School/ECE-2300L')).toEqual([]);
  });

  it('does not mistake a name prefix for a descendant', () => {
    expect(descendantsOf(['CPTC', 'CPTC-old', 'CPTC-old/x'], 'CPTC')).toEqual([]);
    expect(isDescendant('CPTC-old/x', 'CPTC')).toBe(false);
  });

  it('treats a folder as its own descendant, for the cycle guard', () => {
    expect(isDescendant('CPTC', 'CPTC')).toBe(true);
    expect(isDescendant('CPTC/inject', 'CPTC')).toBe(true);
    expect(isDescendant('CPTC', 'CPTC/inject')).toBe(false);
  });

  it('back-fills every missing ancestor, deduped and sorted', () => {
    expect(withAncestors(['School/ECE-2300L/Labs'])).toEqual(['School', 'School/ECE-2300L', 'School/ECE-2300L/Labs']);
    expect(withAncestors(['CPTC', 'CPTC'])).toEqual(['CPTC']);
  });
});

describe('renamePath', () => {
  const groups = ['CPTC', 'CPTC/inject', 'CPTC/inject/2026', 'CPTC-old', 'School'];

  it('maps the folder and every descendant to its new path', () => {
    expect([...renamePath(groups, 'CPTC', 'Comp')]).toEqual([
      ['CPTC', 'Comp'],
      ['CPTC/inject', 'Comp/inject'],
      ['CPTC/inject/2026', 'Comp/inject/2026'],
    ]);
  });

  it('leaves prefix look-alikes and unrelated folders alone', () => {
    const map = renamePath(groups, 'CPTC', 'Comp');
    expect(map.has('CPTC-old')).toBe(false);
    expect(map.has('School')).toBe(false);
  });

  it('expresses a re-parent as a rename to a deeper path', () => {
    expect([...renamePath(groups, 'CPTC', 'School/CPTC')]).toEqual([
      ['CPTC', 'School/CPTC'],
      ['CPTC/inject', 'School/CPTC/inject'],
      ['CPTC/inject/2026', 'School/CPTC/inject/2026'],
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run --project ui src/test/folder-tree.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/folder-tree"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/folder-tree.ts`:

```ts
// Shared by the browser (src/) and the server (server/): no DOM, no Node.
//
// A sidebar folder's id IS its path: "CPTC", "CPTC/inject". This mirrors the
// asset-folder model in `folder-paths.ts`, and it is what lets nesting arrive
// without migrating settings.json: every existing group name is already a
// valid one-segment path.

/** `depth('CPTC')` is 1, so a path holds at most four segments. */
export const MAX_FOLDER_DEPTH = 4;

const SEP = '/';

/** A folder name reduced to something storable in one path segment. */
export function sanitiseSegment(name: string): string {
  return name.replace(/[\\/]/g, '_').trim();
}

export function depth(p: string): number {
  return p ? p.split(SEP).length : 0;
}

export function folderName(p: string): string {
  const i = p.lastIndexOf(SEP);
  return i === -1 ? p : p.slice(i + 1);
}

export function parentPath(p: string): string | null {
  const i = p.lastIndexOf(SEP);
  return i === -1 ? null : p.slice(0, i);
}

export function joinPath(parent: string | null, name: string): string {
  const clean = sanitiseSegment(name);
  return parent ? `${parent}${SEP}${clean}` : clean;
}

/** Direct children of `parent` (null = root), sorted by name, case-insensitive. */
export function childPaths(groups: string[], parent: string | null): string[] {
  return groups
    .filter((g) => parentPath(g) === parent)
    .sort((a, b) => folderName(a).localeCompare(folderName(b), undefined, { sensitivity: 'base' }));
}

/**
 * True when `p` sits inside `ancestor`'s subtree, or is it. The separator in
 * the prefix test is what stops "CPTC-old" from counting as a child of "CPTC".
 */
export function isDescendant(p: string, ancestor: string): boolean {
  return p === ancestor || p.startsWith(`${ancestor}${SEP}`);
}

/** The subtree under `p`, excluding `p` itself, in stored order. */
export function descendantsOf(groups: string[], p: string): string[] {
  return groups.filter((g) => g !== p && isDescendant(g, p));
}

/**
 * Every path plus every missing ancestor, deduped and sorted. Keeping
 * ancestors stored is what makes an empty parent folder survive in the tree.
 */
export function withAncestors(groups: string[]): string[] {
  const out = new Set<string>();
  for (const g of groups) {
    const parts = g.split(SEP);
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join(SEP));
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * The full rewrite map for renaming or re-parenting `from` to `to`: the folder
 * itself plus every descendant, old path to new path. Callers apply it to
 * `groups`, to member workspaces' `group`, and to `folderMeta` keys in one go,
 * which is what keeps a rename atomic.
 */
export function renamePath(groups: string[], from: string, to: string): Map<string, string> {
  const map = new Map<string, string>();
  map.set(from, to);
  for (const g of descendantsOf(groups, from)) map.set(g, to + g.slice(from.length));
  return map;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run --project ui src/test/folder-tree.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add advanced-typst-editor/src/lib/folder-tree.ts advanced-typst-editor/src/test/folder-tree.test.ts
git commit -m "feat(sidebar): add pure folder-path helpers for nested groups"
```

---

### Task 2: Path-aware group storage

**Files:**
- Modify: `src/types.ts` (add `FolderMeta`, add `folderMeta` to `Settings`)
- Modify: `server/settings.ts` (`DEFAULT_SETTINGS`, `normalise`, `SettingsStore` interface and implementation)
- Test: `server/settings.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `withAncestors`, `renamePath`, `descendantsOf`, `isDescendant`, `parentPath`, `folderName`.
- Produces: `FolderMeta { icon?: string | null; color?: string | null }`; `Settings.folderMeta: Record<string, FolderMeta>`; store methods `folderMeta(): Record<string, FolderMeta>`, `addGroup(path: string): string[]`, `renameGroup(from: string, to: string): string[]` (**`to` is a full path**), `moveGroup(path: string, newParent: string | null): string[]`, `removeGroup(path: string): string[]`, `setFolderMeta(path: string, patch: FolderMeta): Record<string, FolderMeta>`.

- [ ] **Step 1: Write the failing tests**

Append to `server/settings.test.ts`, inside the existing `describe('settings store', ...)` block:

```ts
  it('back-fills missing ancestors when a nested group is added', () => {
    const d = tmpDir(); dirs.push(d);
    const s = createSettingsStore(d);
    expect(s.addGroup('School/ECE-2300L/Labs')).toEqual(['School', 'School/ECE-2300L', 'School/ECE-2300L/Labs']);
    expect(s.addGroup('School')).toEqual(['School', 'School/ECE-2300L', 'School/ECE-2300L/Labs']);
  });

  it('repairs a hand-edited file whose ancestor is missing', () => {
    const d = tmpDir(); dirs.push(d);
    const file = path.join(d, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, groups: ['School/ECE-2300L'], workspaces: [] }));
    const s = createSettingsStore(d);
    expect(s.listGroups()).toEqual(['School', 'School/ECE-2300L']);
  });

  it('renames a folder, its subtree, its members and its appearance in one write', () => {
    const d = tmpDir(); dirs.push(d);
    const s = createSettingsStore(d);
    s.addGroup('CPTC/inject');
    s.addGroup('CPTC-old');
    s.setFolderMeta('CPTC', { icon: 'shield', color: 'blue' });
    s.setFolderMeta('CPTC/inject', { color: 'red' });
    const w = s.addWorkspace({ path: path.join(d, 'ws', 'A'), name: 'A', group: 'CPTC/inject', library: true });

    expect(s.renameGroup('CPTC', 'Comp')).toEqual(['CPTC-old', 'Comp', 'Comp/inject']);
    expect(s.getWorkspace(w.id)?.group).toBe('Comp/inject');
    expect(s.folderMeta()).toEqual({ Comp: { icon: 'shield', color: 'blue' }, 'Comp/inject': { color: 'red' } });
  });

  it('re-parents a folder, keeping its own name', () => {
    const d = tmpDir(); dirs.push(d);
    const s = createSettingsStore(d);
    s.addGroup('CPTC/inject');
    s.addGroup('School');
    const w = s.addWorkspace({ path: path.join(d, 'ws', 'A'), name: 'A', group: 'CPTC', library: true });

    expect(s.moveGroup('CPTC', 'School')).toEqual(['School', 'School/CPTC', 'School/CPTC/inject']);
    expect(s.getWorkspace(w.id)?.group).toBe('School/CPTC');
    expect(s.moveGroup('School/CPTC', null)).toEqual(['CPTC', 'CPTC/inject', 'School']);
  });

  it('deleting a folder drops its subtree and appearance and loosens its workspaces', () => {
    const d = tmpDir(); dirs.push(d);
    const s = createSettingsStore(d);
    s.addGroup('CPTC/inject');
    s.addGroup('CPTC-old');
    s.setFolderMeta('CPTC/inject', { icon: 'bug' });
    const a = s.addWorkspace({ path: path.join(d, 'ws', 'A'), name: 'A', group: 'CPTC', library: true });
    const b = s.addWorkspace({ path: path.join(d, 'ws', 'B'), name: 'B', group: 'CPTC/inject', library: true });

    expect(s.removeGroup('CPTC')).toEqual(['CPTC-old']);
    expect(s.getWorkspace(a.id)?.group).toBeNull();
    expect(s.getWorkspace(b.id)?.group).toBeNull();
    expect(s.folderMeta()).toEqual({});
  });

  it('stores and clears folder appearance, and drops orphaned entries on load', () => {
    const d = tmpDir(); dirs.push(d);
    const s = createSettingsStore(d);
    s.addGroup('CPTC');
    expect(s.setFolderMeta('CPTC', { icon: 'shield', color: 'blue' })).toEqual({ CPTC: { icon: 'shield', color: 'blue' } });
    expect(s.setFolderMeta('CPTC', { color: null })).toEqual({ CPTC: { icon: 'shield' } });

    const file = path.join(d, 'settings.json');
    const edited = { ...JSON.parse(fs.readFileSync(file, 'utf8')) as object, folderMeta: { CPTC: { icon: 'shield' }, Ghost: { icon: 'bug' } } };
    fs.writeFileSync(file, JSON.stringify(edited));
    fs.utimesSync(file, new Date(20_000_000), new Date(20_000_000));
    const fresh = createSettingsStore(d);
    expect(fresh.folderMeta()).toEqual({ CPTC: { icon: 'shield' } });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run --project server server/settings.test.ts`
Expected: FAIL — `s.setFolderMeta is not a function`, `s.moveGroup is not a function`, and the ancestor tests report the un-back-filled list.

- [ ] **Step 3: Add the types**

In `src/types.ts`, add above `export interface Settings`:

```ts
/** Appearance of one sidebar folder, keyed by its path in Settings.folderMeta. */
export interface FolderMeta { icon?: string | null; color?: string | null }
```

and add the field to `Settings`, leaving every other field as it is:

```ts
export interface Settings {
  version: 1;
  workspaces: WorkspaceEntry[];
  /** Folder paths ("CPTC", "CPTC/inject"). Every ancestor is itself stored. */
  groups: string[];
  /** Keyed by folder path; an absent key means the default look. */
  folderMeta: Record<string, FolderMeta>;
  backup: BackupSettings;
  typstCli: string | null;
  redaction: RedactionDefaults;
}
```

- [ ] **Step 4: Update `DEFAULT_SETTINGS` and `normalise`**

In `server/settings.ts`, add the import:

```ts
import { descendantsOf, folderName, renamePath, withAncestors } from '../src/lib/folder-tree';
import type { FolderMeta, Settings, WorkspaceEntry } from '../src/types';
```

These four are exactly what this file uses. `tsconfig` sets `noUnusedLocals`, so an extra import fails the typecheck — the validation helpers (`isDescendant`, `parentPath`) belong to `service.ts` in Task 3, not here.

Add `folderMeta: {}` to `DEFAULT_SETTINGS` (after `groups: []`).

In `normalise`, replace the `groups:` line with a groups-then-meta pair. `withAncestors` both sorts and dedupes, so it replaces the old `new Set(...)`:

```ts
  const groups = withAncestors(
    Array.isArray(raw.groups)
      ? raw.groups
          .filter((g): g is string => typeof g === 'string')
          .map((g) => g.split('/').map((s) => s.trim()).filter(Boolean).join('/'))
          .filter((g) => g.length > 0)
      : [],
  );
  const known = new Set(groups);
  const folderMeta: Record<string, FolderMeta> = {};
  for (const [k, v] of Object.entries(raw.folderMeta ?? {})) {
    // Appearance for a folder that no longer exists is dropped, so a hand
    // edit or a crashed rename cannot leave the map growing forever.
    if (!known.has(k) || !v || typeof v !== 'object') continue;
    const meta: FolderMeta = {};
    if (typeof v.icon === 'string' && v.icon) meta.icon = v.icon;
    if (typeof v.color === 'string' && v.color) meta.color = v.color;
    if (meta.icon || meta.color) folderMeta[k] = meta;
  }
```

and return `groups,` and `folderMeta,` in place of the old inline `groups:` entry.

- [ ] **Step 5: Extend the `SettingsStore` interface**

In `server/settings.ts`, replace the four group declarations in `interface SettingsStore` with:

```ts
  listGroups(): string[];
  /** Appearance by folder path; only folders that have one appear. */
  folderMeta(): Record<string, FolderMeta>;
  /** Adds a folder path and every missing ancestor. Idempotent. */
  addGroup(path: string): string[];
  /** Renames `from` to the full path `to`, cascading to its subtree, its member workspaces and its appearance. No-op if `from` is unknown. */
  renameGroup(from: string, to: string): string[];
  /** Re-parents a folder, keeping its own name. `null` moves it to the top level. */
  moveGroup(path: string, newParent: string | null): string[];
  /** Removes the folder and its subtree; members become loose. No-op if unknown. */
  removeGroup(path: string): string[];
  /** Merges icon/color for a folder; an explicit `null` clears that field. */
  setFolderMeta(path: string, patch: FolderMeta): Record<string, FolderMeta>;
```

- [ ] **Step 6: Implement the store methods**

In `server/settings.ts`, replace the `listGroups` / `addGroup` / `renameGroup` / `removeGroup` implementations at the bottom of `createSettingsStore` with:

```ts
    listGroups: () => get().groups,
    folderMeta: () => get().folderMeta,
    addGroup(path) {
      update((s) => (s.groups.includes(path) ? s : { ...s, groups: withAncestors([...s.groups, path]) }));
      return get().groups;
    },
    renameGroup(from, to) {
      update((s) => {
        if (!s.groups.includes(from)) return s;
        const map = renamePath(s.groups, from, to);
        const moved = (g: string | null): string | null => (g && map.get(g)) ?? g;
        const folderMeta: Record<string, FolderMeta> = {};
        for (const [k, v] of Object.entries(s.folderMeta)) folderMeta[map.get(k) ?? k] = v;
        return {
          ...s,
          groups: withAncestors(s.groups.map((g) => map.get(g) ?? g)),
          workspaces: s.workspaces.map((w) => (w.group && map.has(w.group) ? { ...w, group: moved(w.group) } : w)),
          folderMeta,
        };
      });
      return get().groups;
    },
    moveGroup(path, newParent) {
      const name = folderName(path);
      return store.renameGroup(path, newParent ? `${newParent}/${name}` : name);
    },
    removeGroup(path) {
      update((s) => {
        const gone = new Set([path, ...descendantsOf(s.groups, path)]);
        return {
          ...s,
          groups: s.groups.filter((g) => !gone.has(g)),
          workspaces: s.workspaces.map((w) => (w.group && gone.has(w.group) ? { ...w, group: null } : w)),
          folderMeta: Object.fromEntries(Object.entries(s.folderMeta).filter(([k]) => !gone.has(k))),
        };
      });
      return get().groups;
    },
    setFolderMeta(path, patch) {
      update((s) => {
        const next: FolderMeta = { ...s.folderMeta[path] };
        if ('icon' in patch) { if (patch.icon) next.icon = patch.icon; else delete next.icon; }
        if ('color' in patch) { if (patch.color) next.color = patch.color; else delete next.color; }
        const folderMeta = { ...s.folderMeta };
        if (next.icon || next.color) folderMeta[path] = next; else delete folderMeta[path];
        return { ...s, folderMeta };
      });
      return get().folderMeta;
    },
```

Note `moveGroup` calls `store.renameGroup`, so it must sit inside the same `const store: SettingsStore = { ... }` object literal that already exists — `scanLibrary` already uses `store.addWorkspace` the same way.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bunx vitest run --project server server/settings.test.ts`
Expected: PASS, including the pre-existing `returns defaults when the file is missing or corrupt` (it compares against `DEFAULT_SETTINGS`, which now carries `folderMeta: {}` on both sides) and `creates, renames and removes groups, keeping member workspaces in sync` (its `renameGroup('CPTC', 'CPTC 2026')` is a top-level path either way).

- [ ] **Step 8: Typecheck and commit**

```bash
bun run typecheck
git add advanced-typst-editor/src/types.ts advanced-typst-editor/server/settings.ts advanced-typst-editor/server/settings.test.ts
git commit -m "feat(server): store sidebar folders as paths with icon and color"
```

---

### Task 3: Group validation and HTTP routes

**Files:**
- Modify: `server/service.ts` (group section, ~lines 190–215)
- Modify: `server/router.ts` (the `seg[1] === 'groups'` block, ~lines 101–110)
- Test: `server/router.test.ts` (extend; one existing assertion changes)

**Interfaces:**
- Consumes: Task 2's store methods; Task 1's `MAX_FOLDER_DEPTH`, `depth`, `isDescendant`, `joinPath`, `parentPath`, `sanitiseSegment`.
- Produces: service methods `listGroups()`, `folderMeta()`, `createGroup(name: string, parent: string | null): string[]`, `renameGroup(path: string, name: string): string[]`, `moveGroup(path: string, parent: string | null): string[]`, `deleteGroup(path: string): string[]`, `setFolderAppearance(path: string, patch: FolderMeta): Record<string, FolderMeta>`. HTTP: `GET /api/groups` returns `{ groups, folderMeta }`.

- [ ] **Step 1: Write the failing tests**

In `server/router.test.ts`, first **update the existing assertion** on line 159 from `toEqual({ groups: [] })` to:

```ts
    expect(await (await call('GET', '/api/groups')).json()).toEqual({ groups: [], folderMeta: {} });
```

Then add a new `describe` block at the end of the file:

```ts
describe('nested sidebar folders', () => {
  it('creates a subfolder, back-filling the parent', async () => {
    const { call } = app();
    await call('POST', '/api/groups', { name: 'School' });
    const made = await call('POST', '/api/groups', { name: 'ECE-2300L', parent: 'School' });
    expect(made.status).toBe(201);
    expect(await made.json()).toEqual({ groups: ['School', 'School/ECE-2300L'], folderMeta: {} });

    const deep = await call('POST', '/api/groups', { name: 'Lab3', parent: 'School/ECE-2300L/Labs' });
    expect(deep.status).toBe(201);
    expect(((await deep.json()) as { groups: string[] }).groups).toContain('School/ECE-2300L/Labs/Lab3');
  });

  it('refuses a fifth level, a duplicate sibling and an empty name', async () => {
    const { call } = app();
    await call('POST', '/api/groups', { name: 'Lab3', parent: 'School/ECE-2300L/Labs' });
    expect((await call('POST', '/api/groups', { name: 'Deep', parent: 'School/ECE-2300L/Labs/Lab3' })).status).toBe(400);
    expect((await call('POST', '/api/groups', { name: 'Labs', parent: 'School/ECE-2300L' })).status).toBe(409);
    expect((await call('POST', '/api/groups', { name: '  ', parent: 'School' })).status).toBe(400);
  });

  it('renames a nested folder through a percent-encoded path', async () => {
    const { call } = app();
    await call('POST', '/api/groups', { name: 'inject', parent: 'CPTC' });
    const res = await call('PATCH', `/api/groups/${encodeURIComponent('CPTC/inject')}`, { name: 'inject-2026' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { groups: string[] }).groups).toEqual(['CPTC', 'CPTC/inject-2026']);
  });

  it('re-parents a folder and refuses a move into its own subtree', async () => {
    const { call } = app();
    await call('POST', '/api/groups', { name: 'inject', parent: 'CPTC' });
    await call('POST', '/api/groups', { name: 'School' });
    const moved = await call('PATCH', '/api/groups/CPTC', { parent: 'School' });
    expect(((await moved.json()) as { groups: string[] }).groups).toEqual(['School', 'School/CPTC', 'School/CPTC/inject']);

    expect((await call('PATCH', `/api/groups/${encodeURIComponent('School/CPTC')}`, { parent: 'School/CPTC/inject' })).status).toBe(400);
    expect((await call('PATCH', '/api/groups/nope', { parent: null })).status).toBe(404);
  });

  it('sets and clears icon and color together', async () => {
    const { call } = app();
    await call('POST', '/api/groups', { name: 'CPTC' });
    const set = await call('PATCH', '/api/groups/CPTC', { icon: 'shield', color: 'blue' });
    expect(await set.json()).toEqual({ groups: ['CPTC'], folderMeta: { CPTC: { icon: 'shield', color: 'blue' } } });

    const cleared = await call('PATCH', '/api/groups/CPTC', { color: null });
    expect(await cleared.json()).toEqual({ groups: ['CPTC'], folderMeta: { CPTC: { icon: 'shield' } } });
  });

  it('refuses name and parent in the same request', async () => {
    const { call } = app();
    await call('POST', '/api/groups', { name: 'CPTC' });
    expect((await call('PATCH', '/api/groups/CPTC', { name: 'X', parent: null })).status).toBe(400);
  });

  it('deleting a parent loosens every workspace in its subtree', async () => {
    const { call } = app();
    await call('POST', '/api/groups', { name: 'inject', parent: 'CPTC' });
    const made = await (await call('POST', '/api/workspaces', { name: 'R', group: 'CPTC/inject' })).json() as { workspace: { id: string } };
    const res = await call('DELETE', '/api/groups/CPTC');
    expect(await res.json()).toEqual({ groups: [], folderMeta: {} });
    const list = await (await call('GET', '/api/workspaces')).json() as { workspaces: Array<{ id: string; group: string | null }> };
    expect(list.workspaces.find((w) => w.id === made.workspace.id)?.group).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run --project server server/router.test.ts`
Expected: FAIL — the `GET /api/groups` shape assertion, and every new test (`parent` is ignored, so `POST` creates a top-level folder).

- [ ] **Step 3: Update the service interface and implementation**

In `server/service.ts`, add to the imports:

```ts
import { MAX_FOLDER_DEPTH, depth, descendantsOf, folderName, isDescendant, joinPath, parentPath, sanitiseSegment } from '../src/lib/folder-tree';
import type { FolderMeta } from '../src/types';
```

All eight are used below (`folderName` and `descendantsOf` by `moveGroup`'s depth check); `noUnusedLocals` rejects any extras.

Replace the group declarations in the `WorkspaceService` interface with:

```ts
  listGroups(): string[];
  folderMeta(): Record<string, FolderMeta>;
  createGroup(name: string, parent: string | null): string[];
  renameGroup(path: string, name: string): string[];
  moveGroup(path: string, parent: string | null): string[];
  deleteGroup(path: string): string[];
  setFolderAppearance(path: string, patch: FolderMeta): Record<string, FolderMeta>;
```

Replace the `listGroups` / `createGroup` / `renameGroup` / `deleteGroup` implementations with:

```ts
    listGroups: () => settings.listGroups(),
    folderMeta: () => settings.folderMeta(),
    createGroup(name, parent) {
      const target = joinPath(parent, name);
      if (!sanitiseSegment(name)) throw new HttpError(400, 'folder name cannot be empty');
      if (depth(target) > MAX_FOLDER_DEPTH) throw new HttpError(400, `folders nest at most ${MAX_FOLDER_DEPTH} levels deep`);
      if (settings.listGroups().includes(target)) throw new HttpError(409, `a folder named "${sanitiseSegment(name)}" already exists here`);
      const out = settings.addGroup(target);
      registryChanged();
      return out;
    },
    renameGroup(path, name) {
      const clean = sanitiseSegment(name);
      if (!clean) throw new HttpError(400, 'folder name cannot be empty');
      if (!settings.listGroups().includes(path)) throw new HttpError(404, `no folder at "${path}"`);
      const target = joinPath(parentPath(path), clean);
      if (target !== path && settings.listGroups().includes(target)) throw new HttpError(409, `a folder named "${clean}" already exists here`);
      const out = settings.renameGroup(path, target);
      registryChanged();
      return out;
    },
    moveGroup(path, parent) {
      if (!settings.listGroups().includes(path)) throw new HttpError(404, `no folder at "${path}"`);
      if (parent !== null && !settings.listGroups().includes(parent)) throw new HttpError(404, `no folder at "${parent}"`);
      if (parent !== null && isDescendant(parent, path)) throw new HttpError(400, 'a folder cannot move inside itself');
      const target = joinPath(parent, folderName(path));
      if (target === path) return settings.listGroups();
      if (settings.listGroups().includes(target)) throw new HttpError(409, `a folder named "${folderName(path)}" already exists there`);
      // The subtree travels with it, so the deepest descendant sets the limit.
      const deepest = Math.max(...[path, ...descendantsOf(settings.listGroups(), path)].map(depth));
      if (deepest - depth(path) + depth(target) > MAX_FOLDER_DEPTH) throw new HttpError(400, `folders nest at most ${MAX_FOLDER_DEPTH} levels deep`);
      const out = settings.moveGroup(path, parent);
      registryChanged();
      return out;
    },
    deleteGroup(path) {
      const out = settings.removeGroup(path);
      registryChanged();
      return out;
    },
    setFolderAppearance(path, patch) {
      if (!settings.listGroups().includes(path)) throw new HttpError(404, `no folder at "${path}"`);
      const out = settings.setFolderMeta(path, patch);
      registryChanged();
      return out;
    },
```

`registryChanged()` is the existing private helper in this file that broadcasts `workspaces.changed`; every group mutation must keep calling it, or open browsers will not resync.

- [ ] **Step 4: Rewrite the router's groups block**

In `server/router.ts`, replace the whole `if (seg[1] === 'groups') { ... }` block with:

```ts
    if (seg[1] === 'groups') {
      const state = () => ({ groups: service.listGroups(), folderMeta: service.folderMeta() });
      if (seg.length === 2) {
        if (method === 'GET') return json(200, state());
        if (method === 'POST') {
          const body = await readJsonObject(req);
          const parent = body.parent === undefined || body.parent === null ? null : requireString(body, 'parent');
          service.createGroup(requireString(body, 'name'), parent);
          return json(201, state());
        }
      }
      if (seg.length === 3) {
        const path = seg[2]!;
        if (method === 'PATCH') {
          const body = await readJsonObject(req);
          if ('name' in body && 'parent' in body) throw new HttpError(400, 'send either name or parent, not both');
          if ('name' in body) service.renameGroup(path, requireString(body, 'name'));
          else if ('parent' in body) service.moveGroup(path, body.parent === null ? null : requireString(body, 'parent'));
          const appearance: FolderMeta = {};
          if ('icon' in body) appearance.icon = body.icon === null ? null : requireString(body, 'icon');
          if ('color' in body) appearance.color = body.color === null ? null : requireString(body, 'color');
          if ('icon' in body || 'color' in body) {
            // A rename above moved the folder, so apply appearance at its new path.
            const at = 'name' in body ? joinPath(parentPath(path), requireString(body, 'name')) : path;
            service.setFolderAppearance(at, appearance);
          }
          return json(200, state());
        }
        if (method === 'DELETE') { service.deleteGroup(path); return json(200, state()); }
      }
    }
```

Add to `server/router.ts`'s imports:

```ts
import { joinPath, parentPath } from '../src/lib/folder-tree';
import type { FolderMeta } from '../src/types';
```

(`FolderMeta` joins the existing `import type { BackupState, ... } from '../src/types';` line.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run --project server`
Expected: PASS, all server tests including the updated `lists, creates, renames and deletes sidebar groups`.

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add advanced-typst-editor/server/service.ts advanced-typst-editor/server/router.ts advanced-typst-editor/server/router.test.ts
git commit -m "feat(api): nest, re-parent and style sidebar folders"
```

---

### Task 4: Nest the backup mirror

**Files:**
- Modify: `server/backup/mirror.ts` (`planMirror`, `readme`)
- Test: `server/backup/mirror.test.ts` (extend)

**Interfaces:**
- Consumes: `WorkspaceEntry.group` now holding a path.
- Produces: no signature change — `planMirror(items: MirrorItem[]): MirrorPlan` keeps its shape.

- [ ] **Step 1: Write the failing tests**

Add to `server/backup/mirror.test.ts`, inside `describe('planMirror', ...)`:

```ts
  it('plans an unchanged tree for a one-segment group', () => {
    const plan = planMirror([item('Report', 'CPTC', { 'main.typ': 'a' })]);
    expect(plan.files.map((f) => f.path).sort()).toEqual(['CPTC/Report/main.typ', 'README.txt']);
    expect(plan.dirs).toContain('CPTC');
  });

  it('nests a folder path into nested directories', () => {
    const plan = planMirror([item('Lab1', 'School/ECE-2300L', { 'main.typ': 'a' })]);
    expect(plan.files.map((f) => f.path).sort()).toEqual(['README.txt', 'School/ECE-2300L/Lab1/main.typ']);
    expect(plan.dirs).toContain('School');
    expect(plan.dirs).toContain('School/ECE-2300L');
    expect(plan.dirOf.get('Lab1')).toBe('School/ECE-2300L/Lab1');
  });

  it('scopes name collisions per level, not globally', () => {
    const plan = planMirror([
      item('A', 'School/Labs', { 'main.typ': 'a' }, 'a'),
      item('B', 'CPTC/Labs', { 'main.typ': 'b' }, 'b'),
    ]);
    expect(plan.dirOf.get('a')).toBe('School/Labs/A');
    expect(plan.dirOf.get('b')).toBe('CPTC/Labs/B');
  });

  it('sanitises each segment separately so a separator cannot escape', () => {
    const plan = planMirror([item('R', 'A:B/C*D', { 'main.typ': 'a' })]);
    expect(plan.dirOf.get('R')).toBe('A_B/C_D');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run --project server server/backup/mirror.test.ts`
Expected: FAIL — the nested cases produce `School_ECE-2300L/Lab1/...`, because `safeDirName` currently sees the whole path and rewrites `/` to `_`.

- [ ] **Step 3: Rewrite the group layout in `planMirror`**

In `server/backup/mirror.ts`, replace these four lines:

```ts
  const groups = [...new Set(sorted.map((i) => i.entry.group).filter((g): g is string => !!g))].sort();
  const groupDirs = uniqueNames(groups, (g) => g, taken);
```

with a per-level walk. Each segment is sanitised on its own — that is what makes nesting possible — and each directory level keeps its own `taken` set, so `School/Labs` and `CPTC/Labs` can both be `Labs`:

```ts
  const groups = [...new Set(sorted.map((i) => i.entry.group).filter((g): g is string => !!g))].sort();
  // Directory name chosen for each group path, resolved one segment at a time.
  const groupDirs = new Map<string, string>();
  // Names already used inside a given parent directory ('' = the mirror root).
  const takenIn = new Map<string, Set<string>>([['', taken]]);
  const dirFor = (groupPath: string): string => {
    const cached = groupDirs.get(groupPath);
    if (cached) return cached;
    const parent = groupPath.includes('/') ? groupPath.slice(0, groupPath.lastIndexOf('/')) : '';
    const parentDir = parent ? dirFor(parent) : '';
    const siblings = takenIn.get(parentDir) ?? new Set<string>();
    takenIn.set(parentDir, siblings);
    const base = safeDirName(groupPath.slice(groupPath.lastIndexOf('/') + 1));
    let candidate = base;
    for (let n = 2; siblings.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})`;
    siblings.add(candidate.toLowerCase());
    const full = parentDir ? `${parentDir}/${candidate}` : candidate;
    groupDirs.set(groupPath, full);
    return full;
  };
  // Ancestors first, so a parent claims its name before a child asks for one.
  for (const g of groups) dirFor(g);
```

Then replace the two later uses of `groupDirs.get(...)`:

- `const dirs: string[] = [...groupDirs.values()];` stays as it is — it now lists nested paths, which is what `runMirror` needs in order to create them.
- In the final loop, `emit(it, `${groupDirs.get(g)!}/${memberDirs.get(it)!}`)` stays as it is too; `groupDirs.get(g)` is now the full nested directory.

The only other change is the `loose` block, which must run **after** the group directories are claimed so a loose workspace cannot steal a top-level folder's name. Move these two lines to sit directly below the `for (const g of groups) dirFor(g);` line:

```ts
  const loose = sorted.filter((i) => !i.entry.group);
  const looseDirs = uniqueNames(loose, (i) => i.entry.name, taken);
```

- [ ] **Step 4: Update the README text**

In `server/backup/mirror.ts`, in `readme`, replace the line

```ts
    'grouped by the groups you made in the app. Loose workspaces sit at the top level.',
```

with

```ts
    'filed under the folders you made in the app, nested exactly as the sidebar',
    'shows them. Loose workspaces sit at the top level.',
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run --project server server/backup/mirror.test.ts`
Expected: PASS, including the pre-existing `lays out groups, loose workspaces, and unique names`.

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add advanced-typst-editor/server/backup/mirror.ts advanced-typst-editor/server/backup/mirror.test.ts
git commit -m "feat(backup): mirror nested sidebar folders as nested directories"
```

---

### Task 5: API client and store

**Files:**
- Modify: `src/api/client.ts` (the four group calls)
- Modify: `src/stores/index.ts` (`AppState`, initial state, group actions)
- Test: `src/test/store.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3's routes.
- Produces: store fields `groups: string[]`, `folderMeta: Record<string, FolderMeta>`; store actions `createGroup(name: string, parent?: string | null): Promise<void>`, `renameGroup(path: string, name: string): Promise<void>`, `moveGroup(path: string, parent: string | null): Promise<void>`, `deleteGroup(path: string): Promise<void>`, `setFolderAppearance(path: string, patch: FolderMeta): Promise<void>`. Tasks 8–10 call exactly these.

- [ ] **Step 1: Write the failing test**

Add to `src/test/store.test.ts`:

```ts
  it('loads folders with their appearance and moves one under a new parent', async () => {
    const listGroups = vi.fn().mockResolvedValue({ groups: ['CPTC', 'School'], folderMeta: { CPTC: { icon: 'shield' } } });
    const moveGroup = vi.fn().mockResolvedValue({ groups: ['School', 'School/CPTC'], folderMeta: { 'School/CPTC': { icon: 'shield' } } });
    vi.spyOn(api, 'listGroups').mockImplementation(listGroups);
    vi.spyOn(api, 'moveGroup').mockImplementation(moveGroup);
    vi.spyOn(api, 'listWorkspaces').mockResolvedValue([]);

    await useAppStore.getState().loadGroups();
    expect(useAppStore.getState().groups).toEqual(['CPTC', 'School']);
    expect(useAppStore.getState().folderMeta).toEqual({ CPTC: { icon: 'shield' } });

    await useAppStore.getState().moveGroup('CPTC', 'School');
    expect(moveGroup).toHaveBeenCalledWith('CPTC', 'School');
    expect(useAppStore.getState().groups).toEqual(['School', 'School/CPTC']);
    expect(useAppStore.getState().folderMeta).toEqual({ 'School/CPTC': { icon: 'shield' } });
  });
```

Match the file's existing import style; it already imports `api` from `@/api/client` and `useAppStore` from `@/stores`. Add `import type { FolderMeta } from '@/types';` only if you reference the type directly.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run --project ui src/test/store.test.ts`
Expected: FAIL — `api.moveGroup is not a function`.

- [ ] **Step 3: Update the API client**

In `src/api/client.ts`, add `FolderMeta` to the type import, then replace the four group lines with:

```ts
  listGroups: () => req<GroupState>('GET', '/api/groups'),
  createGroup: (name: string, parent: string | null = null) => req<GroupState>('POST', '/api/groups', { name, parent }),
  renameGroup: (path: string, name: string) => req<GroupState>('PATCH', `/api/groups/${enc(path)}`, { name }),
  moveGroup: (path: string, parent: string | null) => req<GroupState>('PATCH', `/api/groups/${enc(path)}`, { parent }),
  setFolderAppearance: (path: string, patch: FolderMeta) => req<GroupState>('PATCH', `/api/groups/${enc(path)}`, patch),
  deleteGroup: (path: string) => req<GroupState>('DELETE', `/api/groups/${enc(path)}`),
```

and declare the shared response type above `export const api = {`:

```ts
/** Every folder route answers with the whole folder state, so one call resyncs both. */
export interface GroupState { groups: string[]; folderMeta: Record<string, FolderMeta> }
```

`enc` is `encodeURIComponent`, so a nested path arrives as one percent-encoded segment — which `server/router.ts` decodes per segment.

- [ ] **Step 4: Update the store**

In `src/stores/index.ts`, add `FolderMeta` to the type import. In `AppState`, add the field beside `groups`:

```ts
  folderMeta: Record<string, FolderMeta>;
```

and replace the three group action declarations with:

```ts
  loadGroups(): Promise<void>;
  createGroup(name: string, parent?: string | null): Promise<void>;
  renameGroup(path: string, name: string): Promise<void>;
  moveGroup(path: string, parent: string | null): Promise<void>;
  deleteGroup(path: string): Promise<void>;
  setFolderAppearance(path: string, patch: FolderMeta): Promise<void>;
```

Add `folderMeta: {},` to the initial state object (beside `groups: []`), and replace the four group implementations with:

```ts
    async loadGroups() { set(await api.listGroups()); },
    async createGroup(name, parent) { set(await api.createGroup(name, parent ?? null)); },
    async renameGroup(path, name) { set(await api.renameGroup(path, name)); await get().loadWorkspaces(); },
    async moveGroup(path, parent) { set(await api.moveGroup(path, parent)); await get().loadWorkspaces(); },
    async deleteGroup(path) { set(await api.deleteGroup(path)); await get().loadWorkspaces(); },
    async setFolderAppearance(path, patch) { set(await api.setFolderAppearance(path, patch)); },
```

`set(await api.…)` works because `GroupState`'s two keys are exactly the two store fields; `loadWorkspaces` follows the calls that can change a workspace's group.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bunx vitest run --project ui src/test/store.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add advanced-typst-editor/src/api/client.ts advanced-typst-editor/src/stores/index.ts advanced-typst-editor/src/test/store.test.ts
git commit -m "feat(ui): carry folder paths and appearance through the store"
```

---

### Task 6: Drop-legality rules

**Files:**
- Create: `src/lib/sidebar-dnd.ts`
- Test: `src/test/sidebar-dnd.test.ts`

**Interfaces:**
- Consumes: Task 1's `MAX_FOLDER_DEPTH`, `depth`, `descendantsOf`, `folderName`, `isDescendant`, `joinPath`, `parentPath`.
- Produces: `type DragPayload = { kind: 'workspace'; id: string } | { kind: 'folder'; path: string }`, `SIDEBAR_DRAG_MIME = 'text/plain'`, `encodeDrag(p: DragPayload): string`, `parseDrag(raw: string): DragPayload | null`, `canDrop(payload: DragPayload, target: string | null, groups: string[]): boolean`. Task 9 wires these to events.

- [ ] **Step 1: Write the failing test**

Create `src/test/sidebar-dnd.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { canDrop, encodeDrag, parseDrag, type DragPayload } from '@/lib/sidebar-dnd';

const groups = ['CPTC', 'CPTC/inject', 'CPTC/inject/2026', 'School', 'School/ECE-2300L'];

describe('drag payloads', () => {
  it('round-trips a workspace and a folder', () => {
    const ws: DragPayload = { kind: 'workspace', id: 'abc-123' };
    const folder: DragPayload = { kind: 'folder', path: 'CPTC/inject' };
    expect(parseDrag(encodeDrag(ws))).toEqual(ws);
    expect(parseDrag(encodeDrag(folder))).toEqual(folder);
  });

  it('returns null for anything else dropped on the sidebar', () => {
    expect(parseDrag('')).toBeNull();
    expect(parseDrag('https://example.com')).toBeNull();
    expect(parseDrag('workspace:')).toBeNull();
  });
});

describe('canDrop', () => {
  const ws: DragPayload = { kind: 'workspace', id: 'a' };

  it('lets a workspace go anywhere', () => {
    expect(canDrop(ws, null, groups)).toBe(true);
    expect(canDrop(ws, 'CPTC', groups)).toBe(true);
    expect(canDrop(ws, 'CPTC/inject/2026', groups)).toBe(true);
  });

  it('refuses a folder onto itself or its own descendant', () => {
    expect(canDrop({ kind: 'folder', path: 'CPTC' }, 'CPTC', groups)).toBe(false);
    expect(canDrop({ kind: 'folder', path: 'CPTC' }, 'CPTC/inject', groups)).toBe(false);
  });

  it('refuses a no-op move into the parent it already has', () => {
    expect(canDrop({ kind: 'folder', path: 'CPTC/inject' }, 'CPTC', groups)).toBe(false);
    expect(canDrop({ kind: 'folder', path: 'CPTC' }, null, groups)).toBe(false);
  });

  it('allows a real move, including back to the top level', () => {
    expect(canDrop({ kind: 'folder', path: 'CPTC' }, 'School', groups)).toBe(true);
    expect(canDrop({ kind: 'folder', path: 'School/ECE-2300L' }, null, groups)).toBe(true);
  });

  it('refuses a move whose deepest descendant would pass the depth cap', () => {
    // CPTC carries a 3-deep subtree; under School/ECE-2300L it would reach 5.
    expect(canDrop({ kind: 'folder', path: 'CPTC' }, 'School/ECE-2300L', groups)).toBe(false);
    expect(canDrop({ kind: 'folder', path: 'CPTC/inject/2026' }, 'School/ECE-2300L', groups)).toBe(true);
  });

  it('refuses a move onto a parent that already has that name', () => {
    expect(canDrop({ kind: 'folder', path: 'CPTC/inject' }, 'School', ['CPTC', 'CPTC/inject', 'School', 'School/inject'])).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run --project ui src/test/sidebar-dnd.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/sidebar-dnd"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/sidebar-dnd.ts`:

```ts
// What the sidebar allows to be dropped where. Pure and DOM-free, so the rules
// are unit-tested directly and the components only render the verdict.

import { MAX_FOLDER_DEPTH, depth, descendantsOf, folderName, isDescendant, joinPath, parentPath } from '@/lib/folder-tree';

/** A folder drop target; null is the list background, meaning the top level. */
export type DropTarget = string | null;
export type DragPayload = { kind: 'workspace'; id: string } | { kind: 'folder'; path: string };

/**
 * `text/plain` rather than a custom type: the browser sets it for free on a
 * plain drag, and jsdom's DataTransfer stand-in in the tests keeps it simple.
 */
export const SIDEBAR_DRAG_MIME = 'text/plain';

export function encodeDrag(p: DragPayload): string {
  return p.kind === 'workspace' ? `workspace:${p.id}` : `folder:${p.path}`;
}

/** The payload, or null for a drag that did not start in this sidebar. */
export function parseDrag(raw: string): DragPayload | null {
  const i = raw.indexOf(':');
  if (i === -1) return null;
  const kind = raw.slice(0, i);
  const rest = raw.slice(i + 1);
  if (!rest) return null;
  if (kind === 'workspace') return { kind: 'workspace', id: rest };
  if (kind === 'folder') return { kind: 'folder', path: rest };
  return null;
}

export function canDrop(payload: DragPayload, target: DropTarget, groups: string[]): boolean {
  // A workspace belongs to exactly one folder; every folder is a valid home.
  if (payload.kind === 'workspace') return true;

  const { path } = payload;
  // Into itself or its own subtree would orphan the subtree.
  if (target !== null && isDescendant(target, path)) return false;
  // Already there: nothing to do, so nothing to highlight.
  if (parentPath(path) === target) return false;
  // A sibling of that name at the destination would collide.
  if (groups.includes(joinPath(target, folderName(path)))) return false;
  // The whole subtree travels, so its deepest folder sets the limit.
  const subtree = [path, ...descendantsOf(groups, path)];
  const deepest = Math.max(...subtree.map(depth));
  return deepest - depth(path) + depth(joinPath(target, folderName(path))) <= MAX_FOLDER_DEPTH;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run --project ui src/test/sidebar-dnd.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add advanced-typst-editor/src/lib/sidebar-dnd.ts advanced-typst-editor/src/test/sidebar-dnd.test.ts
git commit -m "feat(sidebar): add pure drop-legality rules for folder drag"
```

---

### Task 7: Folder colors and the icon roster

**Files:**
- Create: `src/components/sidebar/folder-icons.ts`
- Modify: `src/index.css` (add `--folder-*` to the `:root` block and the `.dark` block)
- Test: `src/test/folder-icons.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FOLDER_COLORS: readonly string[]` (ten names), `folderColorVar(color: string | null | undefined): string | null` returning e.g. `hsl(var(--folder-blue))`, `FOLDER_ICON_NAMES: readonly string[]` (40 keys), `folderIcon(name: string | null | undefined): LucideIcon`. Tasks 8 and 10 render these.

- [ ] **Step 1: Write the failing test**

Create `src/test/folder-icons.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Folder, Shield } from 'lucide-react';
import { FOLDER_COLORS, FOLDER_ICON_NAMES, folderColorVar, folderIcon } from '@/components/sidebar/folder-icons';

describe('folder colors', () => {
  it('offers ten names and maps them to theme variables', () => {
    expect(FOLDER_COLORS).toHaveLength(10);
    expect(new Set(FOLDER_COLORS).size).toBe(10);
    expect(folderColorVar('blue')).toBe('hsl(var(--folder-blue))');
  });

  it('treats no color and an unknown color as the default', () => {
    expect(folderColorVar(null)).toBeNull();
    expect(folderColorVar(undefined)).toBeNull();
    expect(folderColorVar('chartreuse')).toBeNull();
  });

  it('defines every color in both themes', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf8');
    const light = css.slice(css.indexOf(':root {'), css.indexOf('.dark {'));
    const dark = css.slice(css.indexOf('.dark {'));
    for (const c of FOLDER_COLORS) {
      expect(light, `--folder-${c} missing from :root`).toContain(`--folder-${c}:`);
      expect(dark, `--folder-${c} missing from .dark`).toContain(`--folder-${c}:`);
    }
  });
});

describe('folder icons', () => {
  it('offers forty distinct icons and resolves them', () => {
    expect(FOLDER_ICON_NAMES).toHaveLength(40);
    expect(new Set(FOLDER_ICON_NAMES).size).toBe(40);
    expect(folderIcon('shield')).toBe(Shield);
  });

  it('falls back to a plain folder rather than throwing', () => {
    expect(folderIcon(null)).toBe(Folder);
    expect(folderIcon(undefined)).toBe(Folder);
    expect(folderIcon('not-an-icon')).toBe(Folder);
  });

  it('resolves every advertised name', () => {
    for (const n of FOLDER_ICON_NAMES) expect(folderIcon(n), n).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run --project ui src/test/folder-icons.test.ts`
Expected: FAIL — `Failed to resolve import "@/components/sidebar/folder-icons"`.

- [ ] **Step 3: Add the CSS tokens**

In `src/index.css`, in the `:root {` block, directly under the `--status-red:` line, add:

```css
  /* Sidebar folder tints. Same hues as --status-*, extended to ten, so a
     folder colour is theme-aware rather than a hard-coded hex. */
  --folder-slate:      215 16% 52%;
  --folder-blue:       213 87% 55%;
  --folder-teal:       174 62% 40%;
  --folder-green:      142 60% 42%;
  --folder-amber:       38 91% 50%;
  --folder-orange:      25 90% 52%;
  --folder-red:          0 76% 56%;
  --folder-pink:       330 75% 58%;
  --folder-purple:     258 70% 60%;
  --folder-indigo:     243 62% 60%;
```

In the `.dark {` block, directly under its `--status-red:` line, add the lifted variants (dark surfaces need more lightness for the same legibility):

```css
  --folder-slate:      215 18% 65%;
  --folder-blue:       213 87% 68%;
  --folder-teal:       174 55% 55%;
  --folder-green:      142 52% 58%;
  --folder-amber:       38 91% 62%;
  --folder-orange:      25 90% 64%;
  --folder-red:          0 76% 66%;
  --folder-pink:       330 75% 68%;
  --folder-purple:     258 70% 72%;
  --folder-indigo:     243 70% 72%;
```

- [ ] **Step 4: Write the icon and color module**

Create `src/components/sidebar/folder-icons.ts`:

```ts
// The folder appearance roster: ten theme-aware colours and forty icons.
//
// The icon map is explicit rather than a dynamic `lucide-react` lookup so a
// typo is a typecheck failure instead of a blank square, and so the bundler
// can see exactly which icons to include. Stored values are these keys, never
// component references.

import {
  Archive, Atom, Beaker, Binary, Book, BookOpen, Bug, Calculator, Camera, CircuitBoard,
  ClipboardList, Code, Cpu, Database, FileText, FlaskConical, Flag, Folder, FolderOpen,
  GraduationCap, Hammer, Image, Key, Lock, Microscope, Network, NotebookPen, Palette, Pi,
  Presentation, Rocket, Ruler, Server, Shield, Sigma, Star, Target, Terminal, Wrench, Zap,
  type LucideIcon,
} from 'lucide-react';

export const FOLDER_COLORS = [
  'slate', 'blue', 'teal', 'green', 'amber', 'orange', 'red', 'pink', 'purple', 'indigo',
] as const;
export type FolderColor = (typeof FOLDER_COLORS)[number];

/** A CSS colour for a stored colour name, or null for the default tint. */
export function folderColorVar(color: string | null | undefined): string | null {
  return color && (FOLDER_COLORS as readonly string[]).includes(color) ? `hsl(var(--folder-${color}))` : null;
}

const ICONS = {
  folder: Folder, 'folder-open': FolderOpen, book: Book, 'book-open': BookOpen,
  'graduation-cap': GraduationCap, 'flask-conical': FlaskConical, beaker: Beaker,
  microscope: Microscope, atom: Atom, cpu: Cpu, 'circuit-board': CircuitBoard,
  binary: Binary, network: Network, server: Server, database: Database,
  terminal: Terminal, code: Code, bug: Bug, shield: Shield, lock: Lock, key: Key,
  zap: Zap, wrench: Wrench, hammer: Hammer, ruler: Ruler, calculator: Calculator,
  sigma: Sigma, pi: Pi, 'file-text': FileText, 'notebook-pen': NotebookPen,
  'clipboard-list': ClipboardList, presentation: Presentation, image: Image,
  camera: Camera, palette: Palette, rocket: Rocket, target: Target, flag: Flag,
  star: Star, archive: Archive,
} satisfies Record<string, LucideIcon>;

export const FOLDER_ICON_NAMES = Object.keys(ICONS) as ReadonlyArray<keyof typeof ICONS>;

/** The icon for a stored name; anything unknown renders as a plain folder. */
export function folderIcon(name: string | null | undefined): LucideIcon {
  return (name && (ICONS as Record<string, LucideIcon>)[name]) || Folder;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bunx vitest run --project ui src/test/folder-icons.test.ts`
Expected: PASS, 6 tests. If the count assertion fails, the `ICONS` map has drifted from 40 entries — fix the map, not the test.

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add advanced-typst-editor/src/components/sidebar/folder-icons.ts advanced-typst-editor/src/index.css advanced-typst-editor/src/test/folder-icons.test.ts
git commit -m "feat(sidebar): add folder colour tokens and the icon roster"
```

---

### Task 8: Render the folder tree

**Files:**
- Create: `src/components/sidebar/WorkspaceRow.tsx`
- Create: `src/components/sidebar/FolderRow.tsx`
- Create: `src/components/sidebar/FolderTree.tsx`
- Modify: `src/components/sidebar/Sidebar.tsx` (replace the flat `grouped.map` list with `<FolderTree />`)
- Modify: `src/lib/workspace-groups.ts` (add a by-folder index; keep `groupWorkspaces` for now)
- Test: `src/test/sidebar.test.tsx` (extend), `src/test/workspace-groups.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `childPaths`, `folderName`, `isDescendant`; Task 5's store fields; Task 7's `folderIcon`, `folderColorVar`.
- Produces: `workspacesByFolder(list: WorkspaceStatus[]): Map<string, WorkspaceStatus[]>` (key `''` = top level, each list already sorted); `subtreeCount(counts: Map<string, WorkspaceStatus[]>, path: string): number`; components `<WorkspaceRow ws … />`, `<FolderRow path … />`, `<FolderTree parent={null} depth={0} />`. Tasks 9 and 10 add props to these same components.

- [ ] **Step 1: Write the failing tests**

Add to `src/test/workspace-groups.test.ts`:

```ts
import { subtreeCount, workspacesByFolder } from '@/lib/workspace-groups';

describe('workspacesByFolder', () => {
  const ws = (id: string, group: string | null, openedAt = 0): WorkspaceStatus =>
    ({ id, name: id, group, path: `C:/${id}`, library: true, createdAt: 0, openedAt, status: 'ok' });

  it('indexes by exact folder path, most-recently-opened first', () => {
    const by = workspacesByFolder([ws('a', 'CPTC', 1), ws('b', 'CPTC', 2), ws('c', null), ws('d', 'CPTC/inject')]);
    expect(by.get('CPTC')!.map((w) => w.id)).toEqual(['b', 'a']);
    expect(by.get('')!.map((w) => w.id)).toEqual(['c']);
    expect(by.get('CPTC/inject')!.map((w) => w.id)).toEqual(['d']);
  });

  it('counts a whole subtree, not just direct members', () => {
    const by = workspacesByFolder([ws('a', 'CPTC'), ws('b', 'CPTC/inject'), ws('c', 'CPTC/inject/2026'), ws('d', 'CPTC-old')]);
    expect(subtreeCount(by, 'CPTC')).toBe(3);
    expect(subtreeCount(by, 'CPTC/inject')).toBe(2);
    expect(subtreeCount(by, 'CPTC-old')).toBe(1);
  });
});
```

Add to `src/test/sidebar.test.tsx`, inside `describe('Sidebar', ...)`:

```ts
  it('renders subfolders under their parent, indented', () => {
    useAppStore.setState({ workspaces: [ws('a', 'CPTC/inject')], groups: ['CPTC', 'CPTC/inject'] });
    render(<Sidebar />);
    expect(screen.getByText('CPTC')).toBeInTheDocument();
    expect(screen.getByText('inject')).toBeInTheDocument();
    expect(screen.getByText('a')).toBeInTheDocument();
    expect(screen.getByTestId('folder-CPTC/inject')).toHaveStyle({ paddingLeft: '16px' });
  });

  it('shows a folder icon and colour from folderMeta', () => {
    useAppStore.setState({ workspaces: [], groups: ['CPTC'], folderMeta: { CPTC: { icon: 'shield', color: 'blue' } } });
    render(<Sidebar />);
    const row = screen.getByTestId('folder-CPTC');
    expect(row.querySelector('[data-folder-icon="shield"]')).toBeTruthy();
    expect(row.querySelector('[data-folder-stripe]')).toHaveStyle({ backgroundColor: 'hsl(var(--folder-blue))' });
  });

  it('counts the whole subtree on a collapsed folder', () => {
    useAppStore.setState({ workspaces: [ws('a', 'CPTC'), ws('b', 'CPTC/inject')], groups: ['CPTC', 'CPTC/inject'] });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: /CPTC/ }));
    expect(screen.getByText('2')).toBeInTheDocument();
  });
```

and extend the `beforeEach` store reset to include `folderMeta: {}`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run --project ui src/test/sidebar.test.tsx src/test/workspace-groups.test.ts`
Expected: FAIL — `workspacesByFolder` is not exported, and `folder-CPTC` is not in the document.

- [ ] **Step 3: Add the folder index helpers**

Append to `src/lib/workspace-groups.ts`:

```ts
import { isDescendant } from '@/lib/folder-tree';

/**
 * Workspaces keyed by their exact folder path; '' holds the top level. Each
 * list is sorted most-recently-opened first, then by name, which is the order
 * the flat sidebar already used.
 */
export function workspacesByFolder(list: WorkspaceStatus[]): Map<string, WorkspaceStatus[]> {
  const by = new Map<string, WorkspaceStatus[]>();
  for (const ws of list) {
    const k = ws.group ?? '';
    const arr = by.get(k) ?? [];
    arr.push(ws);
    by.set(k, arr);
  }
  for (const arr of by.values()) arr.sort((a, b) => b.openedAt - a.openedAt || a.name.localeCompare(b.name));
  return by;
}

/** How many workspaces sit in `path` or anywhere beneath it. */
export function subtreeCount(by: Map<string, WorkspaceStatus[]>, path: string): number {
  let n = 0;
  for (const [k, arr] of by) if (k && isDescendant(k, path)) n += arr.length;
  return n;
}
```

- [ ] **Step 4: Write `WorkspaceRow`**

Create `src/components/sidebar/WorkspaceRow.tsx`:

```tsx
import { AlertTriangle, Circle } from 'lucide-react';
import { cancelHoverPrefetch, hoverPrefetch } from '@/lib/prefetch';
import { encodeDrag, SIDEBAR_DRAG_MIME } from '@/lib/sidebar-dnd';
import type { WorkspaceStatus } from '@/types';

export function WorkspaceRow({ ws, active, indent, onSelect, onMenu }: {
  ws: WorkspaceStatus;
  active: boolean;
  indent: number;
  onSelect: (id: string) => void;
  onMenu: (ws: WorkspaceStatus, x: number, y: number) => void;
}) {
  return (
    <button
      type="button"
      draggable
      data-testid={`workspace-${ws.id}`}
      style={{ paddingLeft: `${8 + indent * 12}px` }}
      onDragStart={(e) => e.dataTransfer.setData(SIDEBAR_DRAG_MIME, encodeDrag({ kind: 'workspace', id: ws.id }))}
      onClick={() => onSelect(ws.id)}
      onContextMenu={(e) => { e.preventDefault(); onMenu(ws, e.clientX, e.clientY); }}
      onPointerEnter={() => { if (ws.status === 'ok' && !active) hoverPrefetch(ws.id); }}
      onPointerLeave={cancelHoverPrefetch}
      className={`flex w-full items-center gap-2 rounded-md py-1 pr-2 text-left text-xs hover:bg-[hsl(var(--accent))] ${active ? 'bg-[hsl(var(--accent))] font-medium' : ''}`}
    >
      {ws.status === 'missing'
        ? <AlertTriangle size={12} className="text-[hsl(var(--status-amber))]" />
        : <Circle size={6} className={ws.library ? 'fill-current text-[hsl(var(--muted-foreground))]' : 'text-[hsl(var(--status-blue))]'} />}
      <span className="flex-1 truncate" title={ws.path}>{ws.name}</span>
    </button>
  );
}
```

- [ ] **Step 5: Write `FolderRow`**

Create `src/components/sidebar/FolderRow.tsx`:

```tsx
import { ChevronDown, ChevronRight } from 'lucide-react';
import { folderColorVar, folderIcon } from '@/components/sidebar/folder-icons';
import { folderName } from '@/lib/folder-tree';
import { encodeDrag, SIDEBAR_DRAG_MIME } from '@/lib/sidebar-dnd';
import type { FolderMeta } from '@/types';

export function FolderRow({ path, meta, collapsed, count, indent, onToggle, onMenu }: {
  path: string;
  meta: FolderMeta | undefined;
  collapsed: boolean;
  count: number;
  indent: number;
  onToggle: (path: string) => void;
  onMenu: (path: string, x: number, y: number) => void;
}) {
  const Icon = folderIcon(meta?.icon);
  const color = folderColorVar(meta?.color);
  return (
    <button
      type="button"
      draggable
      data-testid={`folder-${path}`}
      aria-expanded={!collapsed}
      style={{ paddingLeft: `${4 + indent * 12}px` }}
      onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData(SIDEBAR_DRAG_MIME, encodeDrag({ kind: 'folder', path })); }}
      onClick={() => onToggle(path)}
      onContextMenu={(e) => { e.preventDefault(); onMenu(path, e.clientX, e.clientY); }}
      className="flex w-full items-center gap-1 rounded py-1 pr-1 text-left text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
    >
      <span data-folder-stripe className="mr-0.5 h-3.5 w-0.5 shrink-0 rounded-full" style={{ backgroundColor: color ?? 'transparent' }} />
      {collapsed ? <ChevronRight size={12} className="shrink-0" aria-hidden="true" /> : <ChevronDown size={12} className="shrink-0" aria-hidden="true" />}
      <Icon size={12} data-folder-icon={meta?.icon ?? 'folder'} className="shrink-0" style={color ? { color } : undefined} aria-hidden="true" />
      <span className="flex-1 truncate">{folderName(path)}</span>
      {collapsed && count > 0 && (
        <span className="text-[9px] font-normal normal-case tracking-normal" style={color ? { color } : undefined}>{count}</span>
      )}
    </button>
  );
}
```

- [ ] **Step 6: Write `FolderTree`**

Create `src/components/sidebar/FolderTree.tsx`:

```tsx
import { FolderRow } from '@/components/sidebar/FolderRow';
import { WorkspaceRow } from '@/components/sidebar/WorkspaceRow';
import { childPaths } from '@/lib/folder-tree';
import { subtreeCount } from '@/lib/workspace-groups';
import type { WorkspaceStatus, FolderMeta } from '@/types';

export interface FolderTreeProps {
  parent: string | null;
  depth: number;
  groups: string[];
  folderMeta: Record<string, FolderMeta>;
  byFolder: Map<string, WorkspaceStatus[]>;
  collapsed: Set<string>;
  activeId: string | null;
  onToggle: (path: string) => void;
  onSelect: (id: string) => void;
  onFolderMenu: (path: string, x: number, y: number) => void;
  onWorkspaceMenu: (ws: WorkspaceStatus, x: number, y: number) => void;
}

/**
 * One level of the sidebar: this folder's subfolders first (A-Z), then the
 * workspaces filed directly in it (most recently opened first).
 */
export function FolderTree(props: FolderTreeProps) {
  const { parent, depth, groups, folderMeta, byFolder, collapsed, activeId } = props;
  return (
    <>
      {childPaths(groups, parent).map((path) => {
        const isCollapsed = collapsed.has(path);
        return (
          <div key={path}>
            <FolderRow
              path={path}
              meta={folderMeta[path]}
              collapsed={isCollapsed}
              count={subtreeCount(byFolder, path)}
              indent={depth}
              onToggle={props.onToggle}
              onMenu={props.onFolderMenu}
            />
            {!isCollapsed && <FolderTree {...props} parent={path} depth={depth + 1} />}
          </div>
        );
      })}
      {(byFolder.get(parent ?? '') ?? []).map((ws) => (
        <WorkspaceRow
          key={ws.id}
          ws={ws}
          active={ws.id === activeId}
          indent={depth}
          onSelect={props.onSelect}
          onMenu={props.onWorkspaceMenu}
        />
      ))}
    </>
  );
}
```

- [ ] **Step 7: Use the tree in `Sidebar`**

In `src/components/sidebar/Sidebar.tsx`:

Replace the `groupWorkspaces` import with:

```ts
import { workspacesByFolder } from '@/lib/workspace-groups';
import { FolderTree } from '@/components/sidebar/FolderTree';
```

Add the `folderMeta` selector beside the `knownGroups` one:

```ts
  const folderMeta = useAppStore((s) => s.folderMeta);
```

Replace `const grouped = groupWorkspaces(workspaces, knownGroups);` with:

```ts
  const byFolder = workspacesByFolder(workspaces);
```

Replace the entire `{grouped.map(({ group, items }) => { ... })}` expression inside the `sidebar-workspace-list` div with:

```tsx
        <FolderTree
          parent={null}
          depth={0}
          groups={knownGroups}
          folderMeta={folderMeta}
          byFolder={byFolder}
          collapsed={collapsed}
          activeId={active}
          onToggle={toggle}
          onSelect={(id) => void select(id)}
          onFolderMenu={(name, x, y) => setFolderMenu({ name, x, y })}
          onWorkspaceMenu={(w, x, y) => setMenu({ ws: w, x, y })}
        />
```

Remove the now-unused imports (`AlertTriangle`, `ChevronDown`, `ChevronRight`, `Circle`, `hoverPrefetch`, `cancelHoverPrefetch`) — `bun run typecheck` names any you miss, and `noUnusedLocals` makes each one fatal.

`WorkspaceRow` now writes a tagged payload (`workspace:<id>`), so `Sidebar`'s existing drop handler must read it back through `parseDrag` or the pre-existing drag tests break. Replace `dropOnGroup` and the `DRAG_MIME` constant with:

```tsx
  const dropOnGroup = (e: React.DragEvent, group: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    const payload = parseDrag(e.dataTransfer.getData(SIDEBAR_DRAG_MIME));
    if (payload?.kind === 'workspace') void setGroup(payload.id, group);
  };
```

with `import { parseDrag, SIDEBAR_DRAG_MIME } from '@/lib/sidebar-dnd';`. Task 9 replaces this handler wholesale; it exists here only so this commit is green on its own.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bunx vitest run --project ui`
Expected: PASS, the whole ui project. The pre-existing drag tests keep working because they locate rows by their text (`getByText('a')`, `getByText('CPTC')`), which the new rows still render, and the drop event bubbles from that span to the row's button.

- [ ] **Step 9: Typecheck and commit**

```bash
bun run typecheck
git add advanced-typst-editor/src/components/sidebar advanced-typst-editor/src/lib/workspace-groups.ts advanced-typst-editor/src/test/sidebar.test.tsx advanced-typst-editor/src/test/workspace-groups.test.ts
git commit -m "feat(sidebar): render folders as a nested tree with icon and colour"
```

---

### Task 9: Drag workspaces and folders

**Files:**
- Modify: `src/components/sidebar/FolderRow.tsx` (drop target, highlight, spring-load)
- Modify: `src/components/sidebar/WorkspaceRow.tsx` (report drag start)
- Modify: `src/components/sidebar/FolderTree.tsx` (pass drop props through)
- Modify: `src/components/sidebar/Sidebar.tsx` (drop handling, drag state)
- Test: `src/test/sidebar.test.tsx` (extend; three existing tests change)

**Interfaces:**
- Consumes: Task 6's `parseDrag`, `canDrop`, `encodeDrag`, `SIDEBAR_DRAG_MIME`, `DragPayload`; Task 5's `setWorkspaceGroup`, `moveGroup`.
- Produces: no new exports. Both rows gain `onDragStart: (p: DragPayload) => void`; `FolderRow` also gains `dropActive: boolean`, `onDragOver`, `onDragLeave`, `onDrop`.

**Why the payload lives in React state:** browsers deliberately withhold
`dataTransfer.getData()` during `dragover` — it only returns a value on `drop`.
Reading it to decide the highlight would therefore work in jsdom and silently
highlight illegal targets in Chrome. So each row reports its payload to
`Sidebar` on `dragstart`, and `dragover` consults that state instead.

- [ ] **Step 1: Write the failing tests**

In `src/test/sidebar.test.tsx`, **update the two existing drag tests** so their payload goes through `encodeDrag` (add `import { encodeDrag } from '@/lib/sidebar-dnd';` at the top):

```ts
  it('dragging a workspace onto a folder files it there', () => {
    const setWorkspaceGroup = vi.fn();
    useAppStore.setState({ workspaces: [ws('a', null)], groups: ['CPTC'], setWorkspaceGroup });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId('workspace-a'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('folder-CPTC'), { dataTransfer: dt });
    expect(setWorkspaceGroup).toHaveBeenCalledWith('a', 'CPTC');
  });

  it('dragging a workspace out of its folder onto the loose area clears its group', () => {
    const setWorkspaceGroup = vi.fn();
    useAppStore.setState({ workspaces: [ws('a', 'CPTC')], groups: ['CPTC'], setWorkspaceGroup });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId('workspace-a'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('sidebar-workspace-list'), { dataTransfer: dt });
    expect(setWorkspaceGroup).toHaveBeenCalledWith('a', null);
  });
```

Likewise change `still files a dragged workspace when dropped on a collapsed folder` to use `getByTestId('workspace-a')` and `getByTestId('folder-CPTC')`.

Then add the new tests:

```ts
  it('dragging a folder onto another folder nests it', () => {
    const moveGroup = vi.fn();
    useAppStore.setState({ workspaces: [], groups: ['CPTC', 'School'], moveGroup });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId('folder-CPTC'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('folder-School'), { dataTransfer: dt });
    expect(moveGroup).toHaveBeenCalledWith('CPTC', 'School');
  });

  it('ignores a folder dropped into its own subtree', () => {
    const moveGroup = vi.fn();
    useAppStore.setState({ workspaces: [], groups: ['CPTC', 'CPTC/inject'], moveGroup });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId('folder-CPTC'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('folder-CPTC/inject'), { dataTransfer: dt });
    expect(moveGroup).not.toHaveBeenCalled();
  });

  it('dragging a folder onto the loose area lifts it to the top level', () => {
    const moveGroup = vi.fn();
    useAppStore.setState({ workspaces: [], groups: ['CPTC', 'CPTC/inject'], moveGroup });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId('folder-CPTC/inject'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('sidebar-workspace-list'), { dataTransfer: dt });
    expect(moveGroup).toHaveBeenCalledWith('CPTC/inject', null);
  });

  it('marks a legal hovered target and not an illegal one', () => {
    useAppStore.setState({ workspaces: [], groups: ['CPTC', 'CPTC/inject', 'School'] });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByTestId('folder-CPTC'), { dataTransfer: dt });

    fireEvent.dragOver(screen.getByTestId('folder-School'), { dataTransfer: dt });
    expect(screen.getByTestId('folder-School')).toHaveAttribute('data-drop-active', 'true');

    fireEvent.dragOver(screen.getByTestId('folder-CPTC/inject'), { dataTransfer: dt });
    expect(screen.getByTestId('folder-CPTC/inject')).not.toHaveAttribute('data-drop-active', 'true');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run --project ui src/test/sidebar.test.tsx`
Expected: FAIL — `moveGroup` is never called and `data-drop-active` is absent.

- [ ] **Step 3: Give the rows their drag and drop behaviour**

In `src/components/sidebar/WorkspaceRow.tsx`, add `onDragStart: (p: DragPayload) => void` to the props (and `import type { DragPayload }` from `@/lib/sidebar-dnd`), then report the payload as well as writing it:

```tsx
      onDragStart={(e) => {
        const payload = { kind: 'workspace', id: ws.id } as const;
        e.dataTransfer.setData(SIDEBAR_DRAG_MIME, encodeDrag(payload));
        onDragStart(payload);
      }}
```

In `src/components/sidebar/FolderRow.tsx`, add the five props to the signature and destructure them:

```tsx
export function FolderRow({ path, meta, collapsed, count, indent, dropActive, onToggle, onMenu, onDragStart, onDragOver, onDragLeave, onDrop }: {
  path: string;
  meta: FolderMeta | undefined;
  collapsed: boolean;
  count: number;
  indent: number;
  dropActive: boolean;
  onToggle: (path: string) => void;
  onMenu: (path: string, x: number, y: number) => void;
  onDragStart: (p: DragPayload) => void;
  onDragOver: (e: React.DragEvent, path: string) => void;
  onDragLeave: (path: string) => void;
  onDrop: (e: React.DragEvent, path: string) => void;
}) {
```

Replace its `onDragStart` handler and add the three drop attributes to the `<button>`, keeping everything already there:

```tsx
      onDragStart={(e) => {
        e.stopPropagation();
        const payload = { kind: 'folder', path } as const;
        e.dataTransfer.setData(SIDEBAR_DRAG_MIME, encodeDrag(payload));
        onDragStart(payload);
      }}
      data-drop-active={dropActive ? 'true' : undefined}
      onDragOver={(e) => onDragOver(e, path)}
      onDragLeave={() => onDragLeave(path)}
      onDrop={(e) => onDrop(e, path)}
```

Add `DragPayload` to the `@/lib/sidebar-dnd` type import in both files.

Finally add the ring to the `className`, using the folder's own colour:

```tsx
      style={{ paddingLeft: `${4 + indent * 12}px`, boxShadow: dropActive ? `inset 0 0 0 2px ${color ?? 'hsl(var(--ring))'}` : undefined }}
```

(replacing the existing `style` prop, which only set `paddingLeft`).

- [ ] **Step 4: Thread the props through `FolderTree`**

In `src/components/sidebar/FolderTree.tsx`, add to `FolderTreeProps`:

```ts
  dropTarget: string | null;
  onDragStart: (p: DragPayload) => void;
  onDragOver: (e: React.DragEvent, path: string) => void;
  onDragLeave: (path: string) => void;
  onDrop: (e: React.DragEvent, path: string) => void;
```

pass them to `FolderRow`:

```tsx
              dropActive={props.dropTarget === path}
              onDragStart={props.onDragStart}
              onDragOver={props.onDragOver}
              onDragLeave={props.onDragLeave}
              onDrop={props.onDrop}
```

and add `onDragStart={props.onDragStart}` to `<WorkspaceRow>` as well. Import the type: `import type { DragPayload } from '@/lib/sidebar-dnd';`.

- [ ] **Step 5: Handle drops in `Sidebar`**

In `src/components/sidebar/Sidebar.tsx`, replace the `DRAG_MIME` constant and the `dropOnGroup` function with:

```tsx
  // What is being dragged right now. Held here rather than read back from the
  // DataTransfer because browsers only expose its data on drop, never on
  // dragover -- and dragover is what decides the highlight.
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const springTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSpring = () => { if (springTimer.current) { clearTimeout(springTimer.current); springTimer.current = null; } };

  /** Apply a drop onto `target` (null = the top level), if the rules allow it. */
  const applyDrop = (e: React.DragEvent, target: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    clearSpring();
    setDropTarget(null);
    // On drop the DataTransfer is readable, so prefer it; `dragging` covers a
    // drag whose payload another handler already consumed.
    const payload = parseDrag(e.dataTransfer.getData(SIDEBAR_DRAG_MIME)) ?? dragging;
    setDragging(null);
    if (!payload || !canDrop(payload, target, knownGroups)) return;
    if (payload.kind === 'workspace') void setGroup(payload.id, target);
    else void moveGroup(payload.path, target);
  };

  const onFolderDragOver = (e: React.DragEvent, path: string) => {
    if (dragging && !canDrop(dragging, path, knownGroups)) return; // no preventDefault: refuses the drop
    e.preventDefault();
    e.stopPropagation();
    if (dropTarget === path) return;
    setDropTarget(path);
    clearSpring();
    // Spring-loaded: resting on a shut folder opens it, so a drag can reach a
    // subfolder without being dropped first.
    if (collapsed.has(path)) springTimer.current = setTimeout(() => toggle(path), 600);
  };

  const onFolderDragLeave = (path: string) => {
    clearSpring();
    setDropTarget((cur) => (cur === path ? null : cur));
  };

  useEffect(() => clearSpring, []);
```

Extend the existing React import to `import { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react';` and add:

```ts
import { canDrop, parseDrag, SIDEBAR_DRAG_MIME, type DragPayload } from '@/lib/sidebar-dnd';
```

Add the store selector beside the others:

```ts
  const moveGroup = useAppStore((s) => s.moveGroup);
```

Update the list container's handlers:

```tsx
      <div data-testid="sidebar-workspace-list" className="min-h-0 flex-1 overflow-auto px-2 pb-2"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => applyDrop(e, null)}>
```

and pass the new props to `<FolderTree>`:

```tsx
          dropTarget={dropTarget}
          onDragStart={setDragging}
          onDragOver={onFolderDragOver}
          onDragLeave={onFolderDragLeave}
          onDrop={applyDrop}
```

`applyDrop`'s signature is `(e, target)` and `FolderRow` calls `onDrop(e, path)`, so it fits directly. Delete the old `dropOnGroup` added in Task 8 — `applyDrop` replaces it, and the list container now calls `onDrop={(e) => applyDrop(e, null)}`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bunx vitest run --project ui src/test/sidebar.test.tsx`
Expected: PASS, including the three updated drag tests.

- [ ] **Step 7: Typecheck and commit**

```bash
bun run typecheck
git add advanced-typst-editor/src/components/sidebar advanced-typst-editor/src/test/sidebar.test.tsx
git commit -m "feat(sidebar): drag workspaces and folders between folders"
```

---

### Task 10: Subfolders, Move to…, and the appearance picker

**Files:**
- Create: `src/components/sidebar/FolderAppearance.tsx`
- Modify: `src/components/sidebar/Sidebar.tsx` (folder menu, workspace menu, subfolder input)
- Test: `src/test/sidebar.test.tsx` (extend; one existing test changes)

**Interfaces:**
- Consumes: Task 5's `createGroup`, `setFolderAppearance`, `setWorkspaceGroup`; Task 7's `FOLDER_COLORS`, `FOLDER_ICON_NAMES`, `folderIcon`, `folderColorVar`.
- Produces: `<FolderAppearance path meta x y onPick onClose />`.

- [ ] **Step 1: Write the failing tests**

In `src/test/sidebar.test.tsx`, **update** `creates a folder from the New Folder button` — `createGroup` now takes a parent:

```ts
    expect(createGroup).toHaveBeenCalledWith('CPTC', null);
```

Then add:

```ts
  it('creates a subfolder from a folder context menu', async () => {
    const createGroup = vi.fn();
    useAppStore.setState({ workspaces: [], groups: ['CPTC'], createGroup });
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByTestId('folder-CPTC'));
    fireEvent.click(screen.getByText('New subfolder'));
    fireEvent.change(screen.getByPlaceholderText('Subfolder name'), { target: { value: 'inject' } });
    fireEvent.submit(screen.getByPlaceholderText('Subfolder name').closest('form')!);
    expect(createGroup).toHaveBeenCalledWith('inject', 'CPTC');
  });

  it('moves a workspace from its context menu without a prompt', () => {
    const setWorkspaceGroup = vi.fn();
    const promptSpy = vi.spyOn(window, 'prompt');
    useAppStore.setState({ workspaces: [ws('a', null)], groups: ['CPTC', 'CPTC/inject'], setWorkspaceGroup });
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByTestId('workspace-a'));
    fireEvent.click(screen.getByText('Move to…'));
    fireEvent.click(screen.getByText('CPTC/inject'));
    expect(setWorkspaceGroup).toHaveBeenCalledWith('a', 'CPTC/inject');
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it('sets an icon and a colour from the appearance popover', async () => {
    const setFolderAppearance = vi.fn();
    useAppStore.setState({ workspaces: [], groups: ['CPTC'], setFolderAppearance });
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByTestId('folder-CPTC'));
    fireEvent.click(screen.getByText('Appearance…'));
    fireEvent.click(await screen.findByTitle('blue'));
    expect(setFolderAppearance).toHaveBeenCalledWith('CPTC', { color: 'blue' });
    fireEvent.click(screen.getByTitle('shield'));
    expect(setFolderAppearance).toHaveBeenCalledWith('CPTC', { icon: 'shield' });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run --project ui src/test/sidebar.test.tsx`
Expected: FAIL — `New subfolder`, `Move to…` and `Appearance…` are not in the document.

- [ ] **Step 3: Write the appearance popover**

Create `src/components/sidebar/FolderAppearance.tsx`:

```tsx
import { FOLDER_COLORS, FOLDER_ICON_NAMES, folderColorVar, folderIcon } from '@/components/sidebar/folder-icons';
import type { FolderMeta } from '@/types';

/**
 * Colour swatches and the icon grid for one folder. Every choice applies at
 * once -- there is nothing to confirm, and picking again is the undo.
 */
export function FolderAppearance({ meta, x, y, onPick, onClose }: {
  meta: FolderMeta | undefined;
  x: number;
  y: number;
  onPick: (patch: FolderMeta) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div
        className="absolute w-56 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--popover))] p-2 text-xs shadow-lg"
        style={{ left: x, top: y }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Colour</div>
        <div className="mb-2 flex flex-wrap gap-1">
          <button type="button" title="no colour" onClick={() => onPick({ color: null })}
            className={`h-5 w-5 rounded-full border border-[hsl(var(--border))] ${!meta?.color ? 'ring-2 ring-[hsl(var(--ring))]' : ''}`} />
          {FOLDER_COLORS.map((c) => (
            <button key={c} type="button" title={c} onClick={() => onPick({ color: c })}
              style={{ backgroundColor: folderColorVar(c)! }}
              className={`h-5 w-5 rounded-full ${meta?.color === c ? 'ring-2 ring-[hsl(var(--ring))]' : ''}`} />
          ))}
        </div>
        <div className="mb-1 text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Icon</div>
        <div className="grid max-h-40 grid-cols-8 gap-0.5 overflow-auto">
          {FOLDER_ICON_NAMES.map((name) => {
            const Icon = folderIcon(name);
            return (
              <button key={name} type="button" title={name} onClick={() => onPick({ icon: name })}
                className={`flex h-6 w-6 items-center justify-center rounded hover:bg-[hsl(var(--accent))] ${meta?.icon === name ? 'bg-[hsl(var(--accent))] ring-1 ring-[hsl(var(--ring))]' : ''}`}>
                <Icon size={13} style={folderColorVar(meta?.color) ? { color: folderColorVar(meta?.color)! } : undefined} />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire the menus in `Sidebar`**

In `src/components/sidebar/Sidebar.tsx`, add the lazy import beside the other two:

```ts
const FolderAppearance = lazy(() => import('@/components/sidebar/FolderAppearance').then((m) => ({ default: m.FolderAppearance })));
```

Add the state and selectors:

```ts
  const setFolderAppearance = useAppStore((s) => s.setFolderAppearance);
  const [appearance, setAppearance] = useState<{ path: string; x: number; y: number } | null>(null);
  const [subfolderOf, setSubfolderOf] = useState<string | null>(null);
  const [subfolderDraft, setSubfolderDraft] = useState('');
  const [movingWs, setMovingWs] = useState<WorkspaceStatus | null>(null);
```

Change the top-level folder creation call to pass a parent:

```tsx
        <form className="px-3 pb-2" onSubmit={(e) => { e.preventDefault(); if (folderDraft.trim()) void createGroup(folderDraft.trim(), null); setCreatingFolder(false); }}>
```

Add the subfolder input directly above the `sidebar-workspace-list` div:

```tsx
      {subfolderOf && (
        <form className="px-3 pb-2" onSubmit={(e) => { e.preventDefault(); if (subfolderDraft.trim()) void createGroup(subfolderDraft.trim(), subfolderOf); setSubfolderOf(null); }}>
          <input autoFocus value={subfolderDraft} onChange={(e) => setSubfolderDraft(e.target.value)} onBlur={() => setSubfolderOf(null)} placeholder="Subfolder name" className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-2 py-1 text-xs" />
        </form>
      )}
```

Replace the folder context menu's inner `<div>` contents with four items (note the existing labels `Rename folder` and `Delete folder` stay, so their tests keep passing):

```tsx
            <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => { setSubfolderOf(folderMenu.name); setSubfolderDraft(''); setFolderMenu(null); }}>New subfolder</button>
            <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => { const n = window.prompt('Rename folder', folderName(folderMenu.name)); if (n && n.trim()) void renameGroup(folderMenu.name, n.trim()); }}>Rename folder</button>
            <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => { setAppearance({ path: folderMenu.name, x: folderMenu.x, y: folderMenu.y }); setFolderMenu(null); }}>Appearance…</button>
            <button type="button" className="block w-full rounded px-2 py-1 text-left text-[hsl(var(--status-red))] hover:bg-[hsl(var(--accent))]" onClick={() => void deleteGroup(folderMenu.name)}>Delete folder</button>
```

Add `import { folderName } from '@/lib/folder-tree';` for the rename prompt's default.

In the workspace context menu, replace the `Set group` button with a **Move to…** toggle and its list:

```tsx
            <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => setMovingWs(menu.ws)}>Move to…</button>
            {movingWs?.id === menu.ws.id && (
              <div className="max-h-48 overflow-auto border-t border-[hsl(var(--border))] pt-1">
                <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => { void setGroup(menu.ws.id, null); setMovingWs(null); setMenu(null); }}>Top level</button>
                {knownGroups.map((g) => (
                  <button key={g} type="button" className="block w-full truncate rounded px-2 py-1 text-left hover:bg-[hsl(var(--accent))]" onClick={() => { void setGroup(menu.ws.id, g); setMovingWs(null); setMenu(null); }}>{g}</button>
                ))}
              </div>
            )}
```

and clear `movingWs` wherever the menu closes: change the outer overlay's `onClick={() => setMenu(null)}` to `onClick={() => { setMenu(null); setMovingWs(null); }}`.

Finally render the popover beside the other dialogs:

```tsx
      {appearance && (
        <Suspense fallback={null}>
          <FolderAppearance
            meta={folderMeta[appearance.path]}
            x={appearance.x}
            y={appearance.y}
            onPick={(patch) => void setFolderAppearance(appearance.path, patch)}
            onClose={() => setAppearance(null)}
          />
        </Suspense>
      )}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run --project ui src/test/sidebar.test.tsx`
Expected: PASS, including the updated `creates a folder from the New Folder button`.

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add advanced-typst-editor/src/components/sidebar advanced-typst-editor/src/test/sidebar.test.tsx
git commit -m "feat(sidebar): add subfolders, Move to menu and the appearance picker"
```

---

### Task 11: Delete confirmation, MCP wording, and full verification

**Files:**
- Modify: `src/components/sidebar/Sidebar.tsx` (confirm before deleting a folder)
- Modify: `server/mcp-tools.ts:67` (`move_workspace` description)
- Test: `src/test/sidebar.test.tsx` (extend; one existing test changes)

**Interfaces:**
- Consumes: everything above. Produces: nothing new.

- [ ] **Step 1: Write the failing test**

In `src/test/sidebar.test.tsx`, **update** `offers rename and delete on a folder via its context menu` so delete goes through the confirm dialog:

```ts
  it('offers rename and delete on a folder via its context menu', async () => {
    const renameGroup = vi.fn();
    const deleteGroup = vi.fn();
    useAppStore.setState({ workspaces: [], groups: ['CPTC'], renameGroup, deleteGroup });
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('CPTC 2026');
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByTestId('folder-CPTC'));
    fireEvent.click(screen.getByText('Rename folder'));
    expect(renameGroup).toHaveBeenCalledWith('CPTC', 'CPTC 2026');

    fireEvent.contextMenu(screen.getByTestId('folder-CPTC'));
    fireEvent.click(screen.getByText('Delete folder'));
    fireEvent.click(await screen.findByText('Delete folder', { selector: 'button' }));
    expect(deleteGroup).toHaveBeenCalledWith('CPTC');
    promptSpy.mockRestore();
  });

  it('warns how many workspaces a folder delete will loosen', async () => {
    useAppStore.setState({ workspaces: [ws('a', 'CPTC'), ws('b', 'CPTC/inject')], groups: ['CPTC', 'CPTC/inject'] });
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByTestId('folder-CPTC'));
    fireEvent.click(screen.getByText('Delete folder'));
    expect(await screen.findByText(/2 workspaces move to the top level/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing on disk is deleted/)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run --project ui src/test/sidebar.test.tsx`
Expected: FAIL — deleting fires immediately, so no dialog text is found.

- [ ] **Step 3: Add the confirmation**

In `src/components/sidebar/Sidebar.tsx`, add state:

```ts
  const [removingFolder, setRemovingFolder] = useState<string | null>(null);
```

Change the `Delete folder` menu item to open it instead of deleting:

```tsx
            <button type="button" className="block w-full rounded px-2 py-1 text-left text-[hsl(var(--status-red))] hover:bg-[hsl(var(--accent))]" onClick={() => { setRemovingFolder(folderMenu.name); setFolderMenu(null); }}>Delete folder</button>
```

and render the dialog beside the others, reusing `subtreeCount` (already imported for the tree — if not, add it to the `@/lib/workspace-groups` import):

```tsx
      {removingFolder && (
        <Suspense fallback={null}>
          <ConfirmDialog
            title="Delete this folder?"
            message={`${folderName(removingFolder)} and its subfolders are removed from the sidebar. ${subtreeCount(byFolder, removingFolder)} workspaces move to the top level. Nothing on disk is deleted.`}
            confirmLabel="Delete folder"
            destructive
            onConfirm={() => { void deleteGroup(removingFolder); setRemovingFolder(null); }}
            onCancel={() => setRemovingFolder(null)}
          />
        </Suspense>
      )}
```

- [ ] **Step 4: Update the MCP tool description**

In `server/mcp-tools.ts`, in the `move_workspace` entry, replace the description string with:

```ts
description: 'Set or clear the sidebar folder of a workspace (null = loose at the top level). Use "/" to nest, e.g. "School/ECE-2300L"; missing parent folders are created. Folders also shape the backup mirror tree.',
```

- [ ] **Step 5: Run the whole suite**

Run: `bunx vitest run` then `bun run typecheck` then `bun run build`
Expected: every test passes in both projects, typecheck is clean, and the build succeeds. Note the sidebar chunk's reported size — the spec budgets 8–12 KB gzipped for the icons; if it is materially worse, trim `ICONS` in `folder-icons.ts` to ~20 entries and update the two count assertions in `src/test/folder-icons.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add advanced-typst-editor/src/components/sidebar advanced-typst-editor/server/mcp-tools.ts advanced-typst-editor/src/test/sidebar.test.tsx
git commit -m "feat(sidebar): confirm folder deletes and document nesting for MCP"
```

- [ ] **Step 7: Verify against the real data**

Start the app: `bun run dev:server` in one terminal, `bun run dev` in another, then open `http://127.0.0.1:5173`.

Confirm, against the eight real workspaces in `data/settings.json`:

1. Create a `School` folder; drag `ECE-2300L` onto it — the four lab workspaces travel with it and the tree shows `School > ECE-2300L > …`.
2. Drag a workspace from `CPTC` into `School/ECE-2300L`, then back out onto the empty area below the list.
3. Right-click `School` → Appearance… → pick a colour and the graduation-cap icon.
4. Collapse `School`; the badge counts every workspace beneath it, not just direct members.
5. Restart `bun run dev:server` and reload: nesting, icon and colour all survive, and `data/settings.json` shows `"groups": ["CPTC", "School", "School/ECE-2300L"]` with a matching `folderMeta`.
6. Settings → Backup → add a scratch destination (an empty folder) → Run backup. Confirm `<destination>/School/ECE-2300L/<workspace>/main.typ` exists and that `CPTC/` sits at the root exactly where it was.

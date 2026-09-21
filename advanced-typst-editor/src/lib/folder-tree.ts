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

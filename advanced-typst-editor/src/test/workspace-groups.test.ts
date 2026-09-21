import { describe, it, expect } from 'vitest';
import { groupWorkspaces, subtreeCount, workspacesByFolder } from '@/lib/workspace-groups';
import type { WorkspaceStatus } from '@/types';
const w = (name: string, group: string | null, openedAt = 0): WorkspaceStatus => ({ id: name, name, group, path: '', library: true, createdAt: 0, openedAt, status: 'ok' });

describe('groupWorkspaces', () => {
  it('puts loose workspaces first, groups alphabetically, items by recent use', () => {
    const out = groupWorkspaces([w('b', 'Z'), w('a', null, 5), w('c', 'A'), w('d', null, 9), w('e', 'A', 3)]);
    expect(out.map((g) => g.group)).toEqual([null, 'A', 'Z']);
    expect(out[0]!.items.map((i) => i.name)).toEqual(['d', 'a']);
    expect(out[1]!.items.map((i) => i.name)).toEqual(['e', 'c']);
  });

  it('includes an empty known group (created but no members yet)', () => {
    const out = groupWorkspaces([w('a', 'A')], ['A', 'Empty']);
    expect(out.map((g) => g.group)).toEqual(['A', 'Empty']);
    expect(out.find((g) => g.group === 'Empty')!.items).toEqual([]);
  });
});

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

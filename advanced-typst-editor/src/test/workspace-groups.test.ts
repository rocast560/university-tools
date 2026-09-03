import { describe, it, expect } from 'vitest';
import { groupWorkspaces } from '@/lib/workspace-groups';
import type { WorkspaceStatus } from '@/types';
const w = (name: string, group: string | null, openedAt = 0): WorkspaceStatus => ({ id: name, name, group, path: '', library: true, createdAt: 0, openedAt, status: 'ok' });

describe('groupWorkspaces', () => {
  it('puts loose workspaces first, groups alphabetically, items by recent use', () => {
    const out = groupWorkspaces([w('b', 'Z'), w('a', null, 5), w('c', 'A'), w('d', null, 9), w('e', 'A', 3)]);
    expect(out.map((g) => g.group)).toEqual([null, 'A', 'Z']);
    expect(out[0]!.items.map((i) => i.name)).toEqual(['d', 'a']);
    expect(out[1]!.items.map((i) => i.name)).toEqual(['e', 'c']);
  });
});

import { describe, it, expect } from 'vitest';
import {
  MAX_DOC_DEPTH, buildNesting, docDepth, nestError, orphansMovedUp, subtreeHeight, subtreeIds,
} from '@/lib/workspace-nesting';
import type { WorkspaceStatus } from '@/types';

const w = (id: string, parent?: string | null, openedAt = 0): WorkspaceStatus => ({
  id, name: id, group: null, path: `C:/${id}`, library: true, createdAt: 0, openedAt, status: 'ok', ...(parent === undefined ? {} : { parent }),
});

// a > b > c, a > d, e alone
const list = [w('a'), w('b', 'a'), w('c', 'b'), w('d', 'a'), w('e')];

describe('workspace nesting math', () => {
  it('measures depth and subtree', () => {
    expect(docDepth(list, 'a')).toBe(1);
    expect(docDepth(list, 'c')).toBe(3);
    expect(subtreeIds(list, 'a').sort()).toEqual(['b', 'c', 'd']);
    expect(subtreeIds(list, 'e')).toEqual([]);
    expect(subtreeHeight(list, 'a')).toBe(3);
    expect(subtreeHeight(list, 'e')).toBe(1);
  });

  it('survives a cycle in bad data without looping', () => {
    const bad = [w('x', 'y'), w('y', 'x')];
    expect(docDepth(bad, 'x')).toBeGreaterThan(0);
    expect(subtreeIds(bad, 'x').length).toBeLessThanOrEqual(2);
  });

  it('refuses nesting under itself or a descendant', () => {
    expect(nestError(list, 'a', 'a')).toMatch(/itself/);
    expect(nestError(list, 'a', 'c')).toMatch(/inside/);
    expect(nestError(list, 'b', 'c')).toMatch(/inside/);
  });

  it('refuses a no-op and an unknown target', () => {
    expect(nestError(list, 'b', 'a')).toMatch(/already/);
    expect(nestError(list, 'e', 'nope')).toMatch(/no document/);
  });

  it('allows a leaf at the last level; refuses past the cap, counting the whole subtree', () => {
    expect(MAX_DOC_DEPTH).toBe(4);
    const chain = [w('1'), w('2', '1'), w('3', '2'), w('4', '3'), w('leaf'), w('x'), w('y', 'x')];
    expect(nestError(chain, 'leaf', '3')).toBeNull();
    expect(nestError(chain, 'leaf', '4')).toMatch(/levels/);
    expect(nestError(chain, 'x', '3')).toMatch(/levels/);
    expect(nestError(chain, 'x', '2')).toBeNull();
  });

  it('builds children lists in recent-first order and finds roots', () => {
    const n = buildNesting([w('a'), w('b', 'a', 1), w('c', 'a', 5), w('orphan', 'gone')]);
    expect(n.childrenOf.get('a')!.map((x) => x.id)).toEqual(['c', 'b']);
    expect(n.isRoot(w('a'))).toBe(true);
    expect(n.isRoot(w('b', 'a'))).toBe(false);
    expect(n.isRoot(w('orphan', 'gone'))).toBe(true);
  });

  it('counts the nested documents that would move up when some are removed', () => {
    expect(orphansMovedUp(list, ['a'])).toBe(2); // b and d move up; c stays under b
    expect(orphansMovedUp(list, ['a', 'b'])).toBe(2); // d and c
    expect(orphansMovedUp(list, ['a', 'b', 'c', 'd'])).toBe(0);
    expect(orphansMovedUp(list, ['e'])).toBe(0);
  });
});

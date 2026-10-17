import { describe, it, expect } from 'vitest';
import { canDrop, type DragPayload } from '@/lib/sidebar-dnd';
import { docKey, loadCollapsedGroups, saveCollapsedGroups, toggleGroup } from '@/lib/collapsed-groups';
import { buildNesting } from '@/lib/workspace-nesting';
import { visibleOrder } from '@/lib/sidebar-selection';
import { workspacesByFolder } from '@/lib/workspace-groups';
import { logoUrl } from '@/api/client';
import type { WorkspaceStatus } from '@/types';

const ws = (id: string, group: string | null, parent?: string, openedAt = 0): WorkspaceStatus => ({
  id, name: id, group, path: `C:/${id}`, library: true, createdAt: 0, openedAt, status: 'ok', ...(parent ? { parent } : {}),
});

describe('canDrop onto a document row', () => {
  // a > b > c > d (4 levels), plus e, f alone, g with child h
  const docs = [ws('a', null), ws('b', null, 'a'), ws('c', null, 'b'), ws('d', null, 'c'), ws('e', null), ws('f', null), ws('g', null), ws('h', null, 'g')];
  const drag = (id: string): DragPayload => ({ kind: 'workspace', id });
  const onto = (id: string) => ({ workspace: id });

  it('refuses a document dropped on itself', () => {
    expect(canDrop(drag('e'), onto('e'), [], docs)).toBe(false);
  });

  it('refuses a drop on one of its own descendants', () => {
    expect(canDrop(drag('a'), onto('b'), [], docs)).toBe(false);
    expect(canDrop(drag('a'), onto('d'), [], docs)).toBe(false);
  });

  it('refuses a drop on the parent it already has', () => {
    expect(canDrop(drag('b'), onto('a'), [], docs)).toBe(false);
  });

  it('refuses a drop that would pass 4 levels, counting the subtree', () => {
    expect(canDrop(drag('e'), onto('d'), [], docs)).toBe(false); // would be level 5
    expect(canDrop(drag('g'), onto('c'), [], docs)).toBe(false); // g carries h: levels 4 and 5
    expect(canDrop(drag('e'), onto('c'), [], docs)).toBe(true); // level 4
    expect(canDrop(drag('g'), onto('b'), [], docs)).toBe(true); // g at 3, h at 4
  });

  it('allows an ordinary nest, and moving a nested document under another', () => {
    expect(canDrop(drag('e'), onto('f'), [], docs)).toBe(true);
    expect(canDrop(drag('h'), onto('e'), [], docs)).toBe(true);
  });

  it('refuses a folder dropped on a document row (the caller resolves it to that row folder)', () => {
    expect(canDrop({ kind: 'folder', path: 'X' }, onto('e'), ['X'], docs)).toBe(false);
  });

  it('still lets a document go to any folder or the top level, nested or not', () => {
    expect(canDrop(drag('h'), 'CPTC', ['CPTC'], docs)).toBe(true);
    expect(canDrop(drag('h'), null, ['CPTC'], docs)).toBe(true);
  });
});

describe('collapsed document keys', () => {
  it('prefixes ids so they cannot clash with folder paths, and persists like folders', () => {
    expect(docKey('abc')).toBe('ws:abc');
    localStorage.clear();
    saveCollapsedGroups(toggleGroup(new Set(['CPTC']), docKey('abc')));
    expect(loadCollapsedGroups()).toEqual(new Set(['CPTC', 'ws:abc']));
  });
});

describe('visibleOrder with nesting', () => {
  const list = [ws('p', 'A', undefined, 2), ws('c1', 'A', 'p', 5), ws('c2', 'A', 'p', 1), ws('g', 'A', 'c1'), ws('solo', null)];
  const by = workspacesByFolder(list);
  const nesting = buildNesting(list);

  it('lists each parent followed by its children, depth first', () => {
    expect(visibleOrder(['A'], by, new Set(), null, nesting)).toEqual(['p', 'c1', 'g', 'c2', 'solo']);
  });

  it('drops the children of a collapsed parent', () => {
    expect(visibleOrder(['A'], by, new Set([docKey('p')]), null, nesting)).toEqual(['p', 'solo']);
    expect(visibleOrder(['A'], by, new Set([docKey('c1')]), null, nesting)).toEqual(['p', 'c1', 'c2', 'solo']);
  });

  it('behaves as before without a nesting argument', () => {
    expect(visibleOrder(['A'], by, new Set())).toEqual(['c1', 'p', 'c2', 'g', 'solo']);
  });
});

describe('logoUrl', () => {
  it('points at the logo route', () => {
    expect(logoUrl('ab12.png')).toBe('/api/logos/ab12.png');
  });
});

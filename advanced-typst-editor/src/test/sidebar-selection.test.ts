import { describe, it, expect } from 'vitest';
import { EMPTY_SELECTION, resetTo, toggle, rangeTo, pruneSelection, visibleOrder, selectedList } from '@/lib/sidebar-selection';
import type { WorkspaceStatus } from '@/types';

const ws = (id: string, group: string | null): WorkspaceStatus => ({ id, name: id, group, path: `C:/${id}`, library: true, createdAt: 0, openedAt: 0, status: 'ok' });
const ids = (s: { ids: ReadonlySet<string> }) => [...s.ids].sort();

describe('sidebar selection', () => {
  it('resetTo selects exactly one row and anchors it', () => {
    const s = resetTo('a');
    expect(ids(s)).toEqual(['a']);
    expect(s.anchor).toBe('a');
  });

  it('toggle adds and removes a row without touching the others', () => {
    let s = toggle(resetTo('a'), 'b');
    expect(ids(s)).toEqual(['a', 'b']);
    expect(s.anchor).toBe('b');
    s = toggle(s, 'a');
    expect(ids(s)).toEqual(['b']);
  });

  it('toggle does not mutate its input', () => {
    const s = resetTo('a');
    toggle(s, 'b');
    expect(ids(s)).toEqual(['a']);
  });

  it('rangeTo selects the visible rows between the anchor and the target, either direction', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];
    expect(ids(rangeTo(resetTo('b'), order, 'd'))).toEqual(['b', 'c', 'd']);
    expect(ids(rangeTo(resetTo('d'), order, 'b'))).toEqual(['b', 'c', 'd']);
  });

  it('rangeTo keeps the anchor so the range can be re-extended', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];
    const s = rangeTo(resetTo('b'), order, 'e');
    expect(s.anchor).toBe('b');
    expect(ids(rangeTo(s, order, 'c'))).toEqual(['b', 'c']);
  });

  it('rangeTo with no usable anchor selects just the target', () => {
    const order = ['a', 'b', 'c'];
    expect(ids(rangeTo(EMPTY_SELECTION, order, 'b'))).toEqual(['b']);
    // an anchor that has since scrolled out of the visible order (folder collapsed)
    expect(ids(rangeTo(resetTo('gone'), order, 'c'))).toEqual(['c']);
  });

  it('pruneSelection drops rows that no longer exist', () => {
    const s = pruneSelection(toggle(resetTo('a'), 'b'), new Set(['b', 'c']));
    expect(ids(s)).toEqual(['b']);
    expect(pruneSelection(resetTo('a'), new Set(['a']))).toEqual(resetTo('a'));
  });

  it('selectedList returns the selection in visible order', () => {
    const s = toggle(toggle(resetTo('c'), 'a'), 'e');
    expect(selectedList(s, ['a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'c', 'e']);
  });
});

describe('visibleOrder', () => {
  const groups = ['B', 'A', 'A/sub'];
  const list = [ws('top1', null), ws('inA', 'A'), ws('inSub', 'A/sub'), ws('inB', 'B')];
  const byFolder = new Map<string, WorkspaceStatus[]>();
  for (const w of list) { const k = w.group ?? ''; byFolder.set(k, [...(byFolder.get(k) ?? []), w]); }

  it('follows the rendered tree: folders A-Z with their contents, then loose rows', () => {
    expect(visibleOrder(groups, byFolder, new Set())).toEqual(['inSub', 'inA', 'inB', 'top1']);
  });

  it('skips the contents of collapsed folders, including nested ones', () => {
    expect(visibleOrder(groups, byFolder, new Set(['A']))).toEqual(['inB', 'top1']);
    expect(visibleOrder(groups, byFolder, new Set(['A/sub']))).toEqual(['inA', 'inB', 'top1']);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { loadCollapsedGroups, saveCollapsedGroups, toggleGroup, COLLAPSED_GROUPS_KEY } from '@/lib/collapsed-groups';

describe('collapsed groups', () => {
  beforeEach(() => localStorage.clear());

  it('starts empty and round-trips through localStorage', () => {
    expect(loadCollapsedGroups()).toEqual(new Set());
    saveCollapsedGroups(new Set(['CPTC', 'ECE-2300L']));
    expect(JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY)!)).toEqual(['CPTC', 'ECE-2300L']);
    expect(loadCollapsedGroups()).toEqual(new Set(['CPTC', 'ECE-2300L']));
  });

  it('toggles without mutating the input', () => {
    const a = new Set(['CPTC']);
    const b = toggleGroup(a, 'CPTC');
    expect(b.has('CPTC')).toBe(false);
    expect(a.has('CPTC')).toBe(true);
    expect(toggleGroup(b, 'X')).toEqual(new Set(['X']));
  });

  it('ignores corrupt storage', () => {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, '{not json');
    expect(loadCollapsedGroups()).toEqual(new Set());
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([1, 'ok', null]));
    expect(loadCollapsedGroups()).toEqual(new Set(['ok']));
  });

  it('survives a storage that throws', () => {
    const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } as unknown as Storage;
    expect(loadCollapsedGroups(throwing)).toEqual(new Set());
    expect(() => saveCollapsedGroups(new Set(['a']), throwing)).not.toThrow();
  });
});

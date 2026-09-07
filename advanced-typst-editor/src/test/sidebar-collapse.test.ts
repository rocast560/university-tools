import { describe, it, expect, beforeEach } from 'vitest';
import {
  SIDEBAR_COLLAPSED_KEY,
  loadSidebarCollapsed,
  saveSidebarCollapsed,
} from '@/lib/sidebar-collapse';

beforeEach(() => localStorage.clear());

describe('sidebar-collapse', () => {
  it('defaults to expanded when nothing is stored', () => {
    expect(loadSidebarCollapsed()).toBe(false);
  });

  it('round-trips both states', () => {
    saveSidebarCollapsed(true);
    expect(loadSidebarCollapsed()).toBe(true);
    saveSidebarCollapsed(false);
    expect(loadSidebarCollapsed()).toBe(false);
  });

  it('treats anything unparseable as expanded rather than throwing', () => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '{not json');
    expect(loadSidebarCollapsed()).toBe(false);
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '"yes"');
    expect(loadSidebarCollapsed()).toBe(false);
  });

  it('survives storage being unavailable (private mode, quota)', () => {
    const denied: Storage = {
      get length(): number { throw new Error('denied'); },
      clear() { throw new Error('denied'); },
      getItem() { throw new Error('denied'); },
      key() { throw new Error('denied'); },
      removeItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
    };
    expect(loadSidebarCollapsed(denied)).toBe(false);
    expect(() => saveSidebarCollapsed(true, denied)).not.toThrow();
  });
});

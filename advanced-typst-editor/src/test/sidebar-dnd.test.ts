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

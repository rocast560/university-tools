import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { normalizeRel, resolveInside } from './paths';

describe('normalizeRel', () => {
  it('normalises slashes and dots', () => {
    expect(normalizeRel('assets\\a\\./b.png')).toBe('assets/a/b.png');
    expect(normalizeRel('')).toBe('');
    expect(normalizeRel('/x')).toBeNull();
    expect(normalizeRel('C:\\x')).toBeNull();
    expect(normalizeRel('a/../b')).toBeNull();
    expect(normalizeRel('a\0b')).toBeNull();
    expect(normalizeRel(42)).toBeNull();
  });
});

describe('resolveInside', () => {
  it('stays under the root', () => {
    const root = path.resolve('C:/tmp/ws');
    expect(resolveInside(root, 'main.typ')).toBe(path.join(root, 'main.typ'));
    expect(resolveInside(root, '')).toBe(root);
    expect(resolveInside(root, '../x')).toBeNull();
  });
});

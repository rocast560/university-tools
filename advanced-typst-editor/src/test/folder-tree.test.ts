import { describe, it, expect } from 'vitest';
import {
  MAX_FOLDER_DEPTH, sanitiseSegment, depth, folderName, parentPath, joinPath,
  childPaths, descendantsOf, isDescendant, withAncestors, renamePath,
} from '@/lib/folder-tree';

describe('folder path arithmetic', () => {
  it('reads depth, name and parent off a path', () => {
    expect(MAX_FOLDER_DEPTH).toBe(4);
    expect(depth('CPTC')).toBe(1);
    expect(depth('School/ECE-2300L/Labs')).toBe(3);
    expect(folderName('School/ECE-2300L')).toBe('ECE-2300L');
    expect(folderName('CPTC')).toBe('CPTC');
    expect(parentPath('School/ECE-2300L')).toBe('School');
    expect(parentPath('CPTC')).toBeNull();
  });

  it('joins a parent and a name, sanitising separators', () => {
    expect(joinPath(null, 'CPTC')).toBe('CPTC');
    expect(joinPath('School', 'ECE-2300L')).toBe('School/ECE-2300L');
    expect(joinPath('School', ' Labs ')).toBe('School/Labs');
    expect(joinPath(null, 'a/b')).toBe('a_b');
    expect(joinPath(null, 'a\\b')).toBe('a_b');
  });

  it('sanitises a segment down to something storable', () => {
    expect(sanitiseSegment('  Lab 3  ')).toBe('Lab 3');
    expect(sanitiseSegment('a/b\\c')).toBe('a_b_c');
    expect(sanitiseSegment('   ')).toBe('');
  });
});

describe('tree queries', () => {
  const groups = ['CPTC', 'CPTC/inject', 'CPTC/report', 'School', 'School/ECE-2300L'];

  it('lists direct children only, sorted, for one level', () => {
    expect(childPaths(groups, null)).toEqual(['CPTC', 'School']);
    expect(childPaths(groups, 'CPTC')).toEqual(['CPTC/inject', 'CPTC/report']);
    expect(childPaths(groups, 'School/ECE-2300L')).toEqual([]);
  });

  it('sorts children by name, not by full path', () => {
    expect(childPaths(['B/a', 'B', 'B/Z', 'B/m'], 'B')).toEqual(['B/a', 'B/m', 'B/Z']);
  });

  it('collects a subtree without the folder itself', () => {
    expect(descendantsOf(groups, 'CPTC')).toEqual(['CPTC/inject', 'CPTC/report']);
    expect(descendantsOf(groups, 'School/ECE-2300L')).toEqual([]);
  });

  it('does not mistake a name prefix for a descendant', () => {
    expect(descendantsOf(['CPTC', 'CPTC-old', 'CPTC-old/x'], 'CPTC')).toEqual([]);
    expect(isDescendant('CPTC-old/x', 'CPTC')).toBe(false);
  });

  it('treats a folder as its own descendant, for the cycle guard', () => {
    expect(isDescendant('CPTC', 'CPTC')).toBe(true);
    expect(isDescendant('CPTC/inject', 'CPTC')).toBe(true);
    expect(isDescendant('CPTC', 'CPTC/inject')).toBe(false);
  });

  it('back-fills every missing ancestor, deduped and sorted', () => {
    expect(withAncestors(['School/ECE-2300L/Labs'])).toEqual(['School', 'School/ECE-2300L', 'School/ECE-2300L/Labs']);
    expect(withAncestors(['CPTC', 'CPTC'])).toEqual(['CPTC']);
  });
});

describe('renamePath', () => {
  const groups = ['CPTC', 'CPTC/inject', 'CPTC/inject/2026', 'CPTC-old', 'School'];

  it('maps the folder and every descendant to its new path', () => {
    expect([...renamePath(groups, 'CPTC', 'Comp')]).toEqual([
      ['CPTC', 'Comp'],
      ['CPTC/inject', 'Comp/inject'],
      ['CPTC/inject/2026', 'Comp/inject/2026'],
    ]);
  });

  it('leaves prefix look-alikes and unrelated folders alone', () => {
    const map = renamePath(groups, 'CPTC', 'Comp');
    expect(map.has('CPTC-old')).toBe(false);
    expect(map.has('School')).toBe(false);
  });

  it('expresses a re-parent as a rename to a deeper path', () => {
    expect([...renamePath(groups, 'CPTC', 'School/CPTC')]).toEqual([
      ['CPTC', 'School/CPTC'],
      ['CPTC/inject', 'School/CPTC/inject'],
      ['CPTC/inject/2026', 'School/CPTC/inject/2026'],
    ]);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { browse } from './fs-browse';
import { MARKER_FILE } from './backup/mirror';
import { tmpDir, rmDir, put } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

describe('browse', () => {
  it('lists drives at the root', () => {
    const root = browse('');
    expect(root.path).toBe('');
    expect(root.parent).toBeNull();
    expect(root.entries.some((e) => /^[A-Z]:\\$/.test(e.path))).toBe(true);
  });
  it('lists subdirectories with emptiness and marker flags, skipping hidden', () => {
    const d = tmpDir(); dirs.push(d);
    fs.mkdirSync(path.join(d, 'empty'));
    put(d, 'used/x.txt', 'x');
    put(d, `ours/${MARKER_FILE}`, '{}');
    fs.mkdirSync(path.join(d, '.hidden'));
    put(d, 'file.txt', 'not a dir');
    const l = browse(d);
    expect(l.parent).toBe(path.dirname(d));
    expect(l.entries.map((e) => [e.name, e.isEmpty, e.isBackupRoot])).toEqual([['empty', true, false], ['ours', false, true], ['used', false, false]]);
    expect(() => browse('relative/path')).toThrow(/absolute/);
    expect(() => browse(path.join(d, 'nope'))).toThrow(/no such folder/);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FileEntry, TypstAsset } from '@/types';

const readBytes = vi.fn();
vi.mock('@/api/client', () => ({ api: { readBytes: (...a: unknown[]) => readBytes(...a) } }));
const resolveAssetBytes = vi.fn();
const fetchAssetBytesFor = vi.fn();
vi.mock('@/lib/typst-assets', () => ({
  assetPath: (a: { id: string }) => `/${a.id}`,
  resolveAssetBytes: (...a: unknown[]) => resolveAssetBytes(...a),
  fetchAssetBytesFor: (...a: unknown[]) => fetchAssetBytesFor(...a),
}));

import { collectMounts, defaultTypFile, mountablePlainFiles, readPlainFile } from '@/lib/typst-mount';

const file = (path: string, size = 10, mtime = 1): FileEntry => ({ path, size, mtime });
const asset = (id: string, kind: 'image' | 'font' = 'image'): TypstAsset => ({ id, kind, filename: id.split('/').pop()!, mime: 'x', size: 1, etag: 'e', folderId: null, createdAt: 0, updatedAt: 0 });

beforeEach(() => { readBytes.mockReset(); resolveAssetBytes.mockReset(); fetchAssetBytesFor.mockReset(); });

describe('mountablePlainFiles', () => {
  it('keeps document inputs, skips assets, the main file, huge files and unknown types', () => {
    const files = [file('main.typ'), file('chapters/intro.typ'), file('refs.bib'), file('assets/a.png'), file('notes.docx'), file('big.csv', 30 * 1024 * 1024)];
    expect(mountablePlainFiles(files, [asset('assets/a.png')], 'main.typ').map((f) => f.path)).toEqual(['chapters/intro.typ', 'refs.bib']);
    expect(mountablePlainFiles(files, [], null).map((f) => f.path)).toEqual(['main.typ', 'chapters/intro.typ', 'refs.bib']);
  });
});

describe('defaultTypFile', () => {
  it('prefers main.typ, else the first .typ, else main.typ', () => {
    expect(defaultTypFile([file('b.typ'), file('main.typ')])).toBe('main.typ');
    expect(defaultTypFile([file('b.typ'), file('a.typ')])).toBe('b.typ');
    expect(defaultTypFile([])).toBe('main.typ');
    expect(defaultTypFile(undefined)).toBe('main.typ');
  });
});

describe('readPlainFile and collectMounts', () => {
  it('memoizes plain files by workspace, path and mtime', async () => {
    readBytes.mockResolvedValue(new Uint8Array([1]));
    await readPlainFile('w1', file('refs.bib', 1, 5));
    await readPlainFile('w1', file('refs.bib', 1, 5));
    await readPlainFile('w1', file('refs.bib', 1, 6));
    await readPlainFile('w2', file('refs.bib', 1, 5));
    expect(readBytes).toHaveBeenCalledTimes(3);
  });

  it('resolves images through the crop pipeline, fonts raw, plain files verbatim, and survives one failure', async () => {
    resolveAssetBytes.mockImplementation(async (a: TypstAsset) => { if (a.id.endsWith('gone.png')) throw new Error('404'); return new Uint8Array(3); });
    fetchAssetBytesFor.mockResolvedValue(new Uint8Array(5));
    readBytes.mockResolvedValue(new Uint8Array(7));
    const assets = [asset('assets/a.png'), asset('assets/gone.png'), asset('fonts/f.ttf', 'font')];
    const files = [file('main.typ'), file('chapters/intro.typ'), file('assets/a.png'), file('assets/gone.png'), file('fonts/f.ttf')];
    const m = await collectMounts('w9', assets, files, 'main.typ');
    expect(m.shadow.map((f) => f.path)).toEqual(['/assets/a.png', '/chapters/intro.typ']);
    expect(m.fonts).toHaveLength(1);
    expect(m.bytes).toBe(3 + 7 + 5);
    expect(resolveAssetBytes).toHaveBeenCalledWith(assets[0], 'w9');
    expect(fetchAssetBytesFor).toHaveBeenCalledWith('w9', assets[2]);
  });
});

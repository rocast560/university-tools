// ─────────────────────────────────────────────────────────────────────────
// What a workspace mounts into the compiler, and the bytes for it.
//
// Shared by the Typst tab's asset sync (which installs the result) and the
// prefetcher (which only wants the byte caches warm), so the two can never
// disagree about which files a document sees.
// ─────────────────────────────────────────────────────────────────────────

import { api } from '@/api/client';
import type { FileEntry, TypstAsset } from '@/types';
import type { TypstShadowFile } from '@/lib/typst-compiler-types';
import { assetPath, fetchAssetBytesFor, resolveAssetBytes } from './typst-assets';

/**
 * Files that are not assets but the document may still pull in: chapters it
 * `#include`s, a bibliography, data tables, a logo it never cropped.
 */
export const MOUNTABLE_EXTS = ['.typ', '.bib', '.csv', '.json', '.yaml', '.yml', '.toml', '.txt', '.svg', '.pdf'];

/**
 * Anything larger than this is a stray download that happens to live in the
 * folder, not a document input: reading it and pushing it through wasm on
 * every workspace switch would cost more than the document itself.
 */
export const MAX_MOUNT_BYTES = 25 * 1024 * 1024;

/**
 * Bytes of the workspace's plain (non-asset) files, keyed by workspace, path
 * and mtime. The server's mtime is the only thing that can make a mounted
 * file stale, so re-running the sync after an unrelated change hands back the
 * exact same arrays and `setTypstShadowFiles` sees no change at all.
 */
const plainFileCache = new Map<string, Promise<Uint8Array>>();

export function readPlainFile(workspaceId: string, f: FileEntry): Promise<Uint8Array> {
  const key = `${workspaceId}:${f.path}:${f.mtime}`;
  const hit = plainFileCache.get(key);
  if (hit) return hit;
  const bytes = api.readBytes(workspaceId, f.path);
  // Don't cache a rejection: a transient blip shouldn't unmount the file for
  // the rest of the session.
  bytes.catch(() => { plainFileCache.delete(key); });
  plainFileCache.set(key, bytes);
  return bytes;
}

/**
 * The plain files worth mounting. `mainFile` is skipped: what gets compiled
 * at that path is the editor's live, possibly-unsaved text, not the copy on
 * disk.
 */
export function mountablePlainFiles(files: readonly FileEntry[] | undefined, assets: readonly TypstAsset[], mainFile: string | null): FileEntry[] {
  const assetIds = new Set(assets.map((a) => a.id));
  return (files ?? []).filter(
    (f) => !assetIds.has(f.path)
      && f.path !== mainFile
      && f.size <= MAX_MOUNT_BYTES
      && MOUNTABLE_EXTS.some((e) => f.path.toLowerCase().endsWith(e)),
  );
}

/** The .typ file the tab opens for a workspace: main.typ, else the first .typ, else main.typ. */
export function defaultTypFile(files: readonly FileEntry[] | undefined): string {
  const typ = (files ?? []).filter((f) => f.path.endsWith('.typ')).map((f) => f.path);
  return typ.includes('main.typ') || typ.length === 0 ? 'main.typ' : typ[0]!;
}

export interface Mounts {
  shadow: TypstShadowFile[];
  fonts: Uint8Array[];
  /** Total bytes across both lists. */
  bytes: number;
}

/**
 * Resolve every byte the compiler needs for a workspace. Images go through
 * `resolveAssetBytes`, which applies the crop rectangle before the bytes ever
 * reach Typst; every other file is mounted verbatim at `/<path>`, so
 * `#include "/chapters/intro.typ"` and `#bibliography("/refs.bib")` resolve.
 * Everything is memoized (assets by id + crop, plain files by mtime), so a
 * second call with the same inputs costs no request.
 *
 * allSettled: one file whose bytes went missing (deleted out-of-band, renamed
 * between the listing and the read) must not take down every other image in
 * the document. Failures are simply left unmounted, and Typst reports the
 * unresolved path against the exact line that referenced it.
 */
export async function collectMounts(
  workspaceId: string,
  assets: readonly TypstAsset[],
  files: readonly FileEntry[] | undefined,
  mainFile: string | null,
): Promise<Mounts> {
  const images = assets.filter((a) => a.kind === 'image');
  const fonts = assets.filter((a) => a.kind === 'font');
  const plain = mountablePlainFiles(files, assets, mainFile);
  const [imageResults, fontResults, plainResults] = await Promise.all([
    Promise.allSettled(images.map(async (a) => ({ path: assetPath(a), bytes: await resolveAssetBytes(a, workspaceId) }))),
    Promise.allSettled(fonts.map((a) => fetchAssetBytesFor(workspaceId, a))),
    Promise.allSettled(plain.map(async (f) => ({ path: `/${f.path}`, bytes: await readPlainFile(workspaceId, f) }))),
  ]);
  const mounted = (results: PromiseSettledResult<TypstShadowFile>[]): TypstShadowFile[] =>
    results.filter((r): r is PromiseFulfilledResult<TypstShadowFile> => r.status === 'fulfilled').map((r) => r.value);
  const shadow = [...mounted(imageResults), ...mounted(plainResults)];
  const fontBytes = fontResults.filter((r): r is PromiseFulfilledResult<Uint8Array> => r.status === 'fulfilled').map((r) => r.value);
  const bytes = shadow.reduce((n, f) => n + f.bytes.byteLength, 0) + fontBytes.reduce((n, b) => n + b.byteLength, 0);
  return { shadow, fonts: fontBytes, bytes };
}

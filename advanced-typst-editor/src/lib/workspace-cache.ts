// ─────────────────────────────────────────────────────────────────────────
// What the client keeps about workspaces it has seen this session, so a
// sidebar click renders from memory and only revalidates in the background.
//
// Three caches, all keyed by workspace id (and file path for the two
// per-document ones):
//
//  - detailCache: the workspace detail (files, assets, folders, meta, etag).
//  - textCache:   the text of every .typ file opened, with the etag the
//                 server reported for it (null while a save is pending).
//  - renderCache: the last good preview of each document, bounded by
//                 characters of SVG since a long report is a few MB.
//
// `mergeDetail` gives a fresh detail structural sharing with the previous
// one: records that did not change keep their object identity, so React
// memoization and the asset sync see "nothing changed" when nothing did.
// ─────────────────────────────────────────────────────────────────────────

import type { WorkspaceDetail } from '@/types';
import type { TypstDiagnostic } from '@/lib/typst-compiler-types';

export const docKeyOf = (workspaceId: string, path: string): string => `${workspaceId}:${path}`;

export const detailCache = new Map<string, WorkspaceDetail>();

export interface CachedText {
  text: string;
  /** The server's etag for this text, or null while the text is newer than any etag we hold. */
  etag: string | null;
}
export const textCache = new Map<string, CachedText>();

export interface RenderSnapshot {
  svg: string;
  diagnostics: TypstDiagnostic[];
  scrollTop: number;
}

// ── bounded LRU ──────────────────────────────────────────────────────────

export interface Lru<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): void;
  deleteWhere(pred: (key: string) => boolean): void;
  readonly size: number;
  /** Sum of `sizeOf` over the entries. */
  readonly weight: number;
}

/**
 * Insertion-ordered LRU: a read moves the entry to the back, an insert that
 * pushes the total weight over `maxWeight` evicts from the front. A single
 * entry larger than the budget is still kept (it is the one being shown).
 */
export function createLru<T>(opts: { maxWeight: number; sizeOf: (v: T) => number }): Lru<T> {
  const map = new Map<string, T>();
  let weight = 0;
  return {
    get size() { return map.size; },
    get weight() { return weight; },
    get(key) {
      const v = map.get(key);
      if (v === undefined) return undefined;
      map.delete(key);
      map.set(key, v);
      return v;
    },
    set(key, value) {
      const prev = map.get(key);
      if (prev !== undefined) { weight -= opts.sizeOf(prev); map.delete(key); }
      map.set(key, value);
      weight += opts.sizeOf(value);
      for (const [k, v] of map) {
        if (weight <= opts.maxWeight || map.size <= 1) break;
        map.delete(k);
        weight -= opts.sizeOf(v);
      }
    },
    delete(key) {
      const v = map.get(key);
      if (v === undefined) return;
      map.delete(key);
      weight -= opts.sizeOf(v);
    },
    deleteWhere(pred) {
      for (const k of [...map.keys()]) if (pred(k)) this.delete(k);
    },
  };
}

/** About ten long reports' worth of SVG. */
export const RENDER_CACHE_MAX_CHARS = 32_000_000;

export const renderCache: Lru<RenderSnapshot> = createLru<RenderSnapshot>({
  maxWeight: RENDER_CACHE_MAX_CHARS,
  sizeOf: (s) => s.svg.length,
});

// ── structural sharing ───────────────────────────────────────────────────

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function shareList<T extends object, K extends keyof T>(prev: T[], next: T[], key: K): T[] {
  const byKey = new Map<T[K], T>();
  for (const p of prev) byKey.set(p[key], p);
  let allSame = prev.length === next.length;
  const out = next.map((n, i) => {
    const p = byKey.get(n[key]);
    const shared = p !== undefined && sameJson(p, n) ? p : n;
    if (shared !== prev[i]) allSame = false;
    return shared;
  });
  return allSame ? prev : out;
}

/**
 * `next` with every unchanged part borrowed from `prev`. The result is `prev`
 * itself when nothing but `entry.openedAt` (which moves on every read)
 * differs, so a background revalidation that found nothing new leaves every
 * consumer's memoization intact.
 */
export function mergeDetail(prev: WorkspaceDetail | undefined, next: WorkspaceDetail): WorkspaceDetail {
  if (!prev) return next;
  const files = shareList(prev.files, next.files, 'path');
  const assets = shareList(prev.assets, next.assets, 'id');
  const folders = shareList(prev.folders, next.folders, 'id');
  const meta = sameJson(prev.meta, next.meta) ? prev.meta : next.meta;
  const entry = sameJson({ ...prev.entry, openedAt: 0 }, { ...next.entry, openedAt: 0 }) ? prev.entry : next.entry;
  const untouched = files === prev.files && assets === prev.assets && folders === prev.folders && meta === prev.meta && entry === prev.entry && prev.etag === next.etag;
  if (untouched) return prev;
  return { entry, files, assets, folders, meta, etag: next.etag };
}

/** Drop everything cached for a workspace (it changed while it was not on screen). */
export function forgetWorkspace(id: string): void {
  detailCache.delete(id);
  const prefix = `${id}:`;
  for (const k of [...textCache.keys()]) if (k.startsWith(prefix)) textCache.delete(k);
  renderCache.deleteWhere((k) => k.startsWith(prefix));
}

/** Tests only. */
export function clearWorkspaceCaches(): void {
  detailCache.clear();
  textCache.clear();
  renderCache.deleteWhere(() => true);
}

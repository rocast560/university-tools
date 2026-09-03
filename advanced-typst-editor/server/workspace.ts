import fs from 'node:fs';
import path from 'node:path';
import type { AssetFolder, FileEntry, TypstAsset, TypstAssetKind, WorkspaceJson } from '../src/types';
import { countAssetReferences, retargetAssetPath } from '../src/lib/typst-placeholders';
import { ALLOWED_EXTENSIONS, extensionOf, mimeFor, MAX_ASSET_BYTES, reconcileImageName, sanitizeFilename, sanitizeStem, uniqueFilename, validateBlurs, validateCrop } from './assets';
import { readJson, writeAtomic } from './fsx';
import { HttpError } from './http';
import { normalizeRel, resolveInside } from './paths';

export const META_FILE = 'workspace.json';
export const ASSETS_DIR = 'assets';
export const FONTS_DIR = 'fonts';
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', '__pycache__']);

export const EMPTY_META: WorkspaceJson = { version: 1, assets: {}, fonts: {} };

export function etagOf(st: fs.Stats): string {
  return `${Math.round(st.mtimeMs)}-${st.size}`;
}

export interface WorkspaceFs {
  readonly root: string;
  listFiles(): FileEntry[];
  typFiles(): string[];
  readFile(rel: string): { bytes: Uint8Array; etag: string } | null;
  /** Throws HttpError(400) on a bad path; never writes workspace.json (use writeMeta). */
  writeFile(rel: string, bytes: Uint8Array): FileEntry;
  deleteFile(rel: string): boolean;
  readMeta(): WorkspaceJson;
  writeMeta(meta: WorkspaceJson): void;
  listAssets(): TypstAsset[];
  listFolders(): AssetFolder[];
  /** Absolute path for a validated relative path, or throws HttpError(400). */
  abs(rel: string): string;
  getAsset(id: string): TypstAsset;
  addAsset(input: { kind: TypstAssetKind; filename: string; bytes: Uint8Array; folder: string | null; family?: string | null }): TypstAsset;
  patchAsset(id: string, patch: { crop?: unknown; blurs?: unknown; width?: unknown; height?: unknown; family?: unknown }): TypstAsset;
  /** `files`: the relative paths of the .typ files actually rewritten (a subset of every .typ file). */
  renameAsset(id: string, stem: string): { asset: TypstAsset; references: number; files: string[] };
  moveAsset(id: string, folder: string | null): { asset: TypstAsset; references: number; files: string[] };
  deleteAsset(id: string): void;
  createFolder(rel: string): AssetFolder;
  renameFolder(rel: string, newRel: string): { references: number; files: string[] };
  deleteFolder(rel: string): { references: number; moved: number; files: string[] };
  /** Rewrite `"<oldTypstPath>"` to `"<newTypstPath>"` in every .typ file; returns how many references changed. */
  rewriteReferences(oldTypstPath: string, newTypstPath: string): number;
}

function walk(root: string, rel: string, out: FileEntry[]): void {
  const dir = rel ? path.join(root, ...rel.split('/')) : root;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    if (e.name.endsWith('.tmp')) continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, child, out);
    else if (e.isFile()) {
      if (child.toLowerCase() === META_FILE) continue;
      try {
        const st = fs.statSync(path.join(dir, e.name));
        out.push({ path: child, size: st.size, mtime: Math.round(st.mtimeMs) });
      } catch { /* vanished mid-walk */ }
    }
  }
}

function normaliseMeta(raw: Partial<WorkspaceJson>): WorkspaceJson {
  return {
    version: 1,
    assets: raw.assets && typeof raw.assets === 'object' ? raw.assets : {},
    fonts: raw.fonts && typeof raw.fonts === 'object' ? raw.fonts : {},
  };
}

export function openWorkspace(root: string, opts: { now?: () => number } = {}): WorkspaceFs {
  const now = opts.now ?? (() => Date.now());
  const rootAbs = path.resolve(root);

  const abs = (rel: string): string => {
    const n = normalizeRel(rel);
    if (n === null || n === '') throw new HttpError(400, `invalid path: ${rel}`);
    const a = resolveInside(rootAbs, n);
    if (!a) throw new HttpError(400, `path escapes the workspace: ${rel}`);
    return a;
  };

  const readMeta = (): WorkspaceJson => normaliseMeta(readJson<Partial<WorkspaceJson>>(path.join(rootAbs, META_FILE), {}));

  const listFiles = (): FileEntry[] => { const out: FileEntry[] = []; walk(rootAbs, '', out); return out; };

  const listAssets = (): TypstAsset[] => {
    const meta = readMeta();
    const out: TypstAsset[] = [];
    for (const f of listFiles()) {
      const top = f.path.split('/')[0];
      const kind = top === ASSETS_DIR ? 'image' : top === FONTS_DIR ? 'font' : null;
      if (!kind) continue;
      const ext = extensionOf(f.path);
      if (!ALLOWED_EXTENSIONS[kind].includes(ext)) continue;
      const filename = path.posix.basename(f.path);
      const dirRel = path.posix.dirname(f.path);
      const folderId = kind === 'image' && dirRel !== ASSETS_DIR ? dirRel.slice(ASSETS_DIR.length + 1) : null;
      let createdAt = f.mtime;
      try { createdAt = Math.round(fs.statSync(path.join(rootAbs, ...f.path.split('/'))).birthtimeMs) || f.mtime; } catch { /* keep mtime */ }
      const m = kind === 'image' ? meta.assets[f.path] : undefined;
      const fm = kind === 'font' ? meta.fonts[f.path] : undefined;
      out.push({
        id: f.path,
        kind,
        filename,
        mime: mimeFor(kind, filename) ?? 'application/octet-stream',
        size: f.size,
        etag: `${f.mtime}-${f.size}`,
        width: m?.width ?? null,
        height: m?.height ?? null,
        crop: m?.crop ?? null,
        blurs: m?.blurs ?? null,
        fontFamily: fm?.family ?? null,
        folderId,
        createdAt,
        updatedAt: f.mtime,
      });
    }
    return out;
  };

  const listFolders = (): AssetFolder[] => {
    const out: AssetFolder[] = [];
    const base = path.join(rootAbs, ASSETS_DIR);
    const visit = (rel: string) => {
      const dir = rel ? path.join(base, ...rel.split('/')) : base;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const id = rel ? `${rel}/${e.name}` : e.name;
        let t = now();
        try { t = Math.round(fs.statSync(path.join(dir, e.name)).mtimeMs); } catch { /* keep now */ }
        out.push({ id, name: e.name, parentId: rel || null, createdAt: t, updatedAt: t });
        visit(id);
      }
    };
    visit('');
    return out;
  };

  const getAsset = (id: string): TypstAsset => {
    const hit = listAssets().find((a) => a.id === id);
    if (!hit) throw new HttpError(404, `asset not found: ${id}`);
    return hit;
  };

  /** Directory (relative to assets/) => absolute, creating it. '' or null = assets/ itself. */
  const assetDir = (folder: string | null): { abs: string; rel: string } => {
    const n = folder ? normalizeRel(folder) : '';
    if (n === null) throw new HttpError(400, `invalid folder: ${folder}`);
    const rel = n ? `${ASSETS_DIR}/${n}` : ASSETS_DIR;
    const a = resolveInside(rootAbs, rel);
    if (!a) throw new HttpError(400, `folder escapes the workspace: ${folder}`);
    fs.mkdirSync(a, { recursive: true });
    return { abs: a, rel };
  };

  const namesIn = (dirAbs: string): string[] => { try { return fs.readdirSync(dirAbs); } catch { return []; } };

  /** Rewrites in place and reports which .typ files were actually changed, for own-write marking. */
  const rewriteReferencesTracked = (oldTypstPath: string, newTypstPath: string): { total: number; files: string[] } => {
    let total = 0;
    const files: string[] = [];
    for (const rel of listFiles().map((f) => f.path).filter((p) => p.endsWith('.typ'))) {
      const a = path.join(rootAbs, ...rel.split('/'));
      const src = fs.readFileSync(a, 'utf8');
      const n = countAssetReferences(src, oldTypstPath);
      if (n === 0) continue;
      writeAtomic(a, retargetAssetPath(src, oldTypstPath, newTypstPath));
      total += n;
      files.push(rel);
    }
    return { total, files };
  };
  const rewriteReferences: WorkspaceFs['rewriteReferences'] = (oldTypstPath, newTypstPath) => rewriteReferencesTracked(oldTypstPath, newTypstPath).total;

  /** Move a meta record from one id to another (no-op when absent). */
  const moveMeta = (kind: TypstAssetKind, from: string, to: string): void => {
    const meta = readMeta();
    const table = kind === 'image' ? meta.assets : meta.fonts;
    const rec = (table as Record<string, unknown>)[from];
    if (rec === undefined) return;
    delete (table as Record<string, unknown>)[from];
    (table as Record<string, unknown>)[to] = rec;
    writeMetaRaw(meta);
  };
  const writeMetaRaw = (meta: WorkspaceJson) => writeAtomic(path.join(rootAbs, META_FILE), JSON.stringify(normaliseMeta(meta), null, 2));

  /** Rename/move one asset file to a new directory + filename, rewriting references and meta. */
  const relocate = (asset: TypstAsset, dirRel: string, filename: string): { asset: TypstAsset; references: number; files: string[] } => {
    const newId = `${dirRel}/${filename}`;
    if (newId === asset.id) return { asset, references: 0, files: [] };
    const from = path.join(rootAbs, ...asset.id.split('/'));
    const to = path.join(rootAbs, ...newId.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    moveMeta(asset.kind, asset.id, newId);
    const { total: references, files } = rewriteReferencesTracked(`/${asset.id}`, `/${newId}`);
    return { asset: getAsset(newId), references, files };
  };

  const addAsset: WorkspaceFs['addAsset'] = ({ kind, filename, bytes, folder, family }) => {
    if (bytes.length === 0) throw new HttpError(400, 'empty upload');
    if (bytes.length > MAX_ASSET_BYTES) throw new HttpError(413, `file exceeds ${MAX_ASSET_BYTES} bytes`);
    let name = sanitizeFilename(filename);
    // Only reconcile a mismatched-but-otherwise-allowed image extension (e.g. a PNG
    // saved as .jpg) against the sniffed bytes; a disallowed extension (e.g. .exe)
    // must still be rejected below rather than getting "corrected" into a valid one.
    if (kind === 'image' && mimeFor(kind, name)) name = reconcileImageName(name, bytes).filename;
    if (!mimeFor(kind, name)) throw new HttpError(400, `file type not allowed for ${kind}: ${name}`);
    const dir = kind === 'image' ? assetDir(folder) : { abs: path.join(rootAbs, FONTS_DIR), rel: FONTS_DIR };
    fs.mkdirSync(dir.abs, { recursive: true });
    name = uniqueFilename(namesIn(dir.abs), name);
    writeAtomic(path.join(dir.abs, name), bytes);
    const id = `${dir.rel}/${name}`;
    if (kind === 'font') {
      const meta = readMeta();
      meta.fonts[id] = { family: family ?? null };
      writeMetaRaw(meta);
    }
    return getAsset(id);
  };

  const patchAsset: WorkspaceFs['patchAsset'] = (id, patch) => {
    const asset = getAsset(id);
    const meta = readMeta();
    if (asset.kind === 'font') {
      if ('family' in patch) {
        if (patch.family !== null && typeof patch.family !== 'string') throw new HttpError(400, 'family must be a string or null');
        meta.fonts[id] = { family: (patch.family as string | null) ?? null };
      }
    } else {
      const rec = { ...(meta.assets[id] ?? {}) };
      if ('crop' in patch) {
        const crop = validateCrop(patch.crop);
        if (crop === undefined) throw new HttpError(400, 'crop must be {x, y, w, h} with positive w and h, or null');
        rec.crop = crop;
      }
      if ('blurs' in patch) {
        const blurs = validateBlurs(patch.blurs);
        if (blurs === undefined) throw new HttpError(400, 'blurs must be regions inside 0..1 with positive size, or null');
        rec.blurs = blurs;
      }
      for (const key of ['width', 'height'] as const) {
        if (!(key in patch)) continue;
        const v = patch[key];
        if (v === null) { rec[key] = null; continue; }
        if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new HttpError(400, `${key} must be a positive integer`);
        rec[key] = v;
      }
      meta.assets[id] = rec;
    }
    writeMetaRaw(meta);
    return getAsset(id);
  };

  const renameAsset: WorkspaceFs['renameAsset'] = (id, stem) => {
    const asset = getAsset(id);
    const ext = extensionOf(asset.filename);
    const safe = sanitizeStem(stem.replace(/\.[A-Za-z0-9]+$/, ''));
    if (!safe) throw new HttpError(400, 'name cannot be empty');
    const dirRel = path.posix.dirname(asset.id);
    const dirAbs = path.join(rootAbs, ...dirRel.split('/'));
    const filename = uniqueFilename(namesIn(dirAbs).filter((n) => n.toLowerCase() !== asset.filename.toLowerCase()), safe + ext);
    return relocate(asset, dirRel, filename);
  };

  const moveAsset: WorkspaceFs['moveAsset'] = (id, folder) => {
    const asset = getAsset(id);
    if (asset.kind !== 'image') throw new HttpError(400, 'only images live in folders');
    const dir = assetDir(folder);
    const filename = uniqueFilename(namesIn(dir.abs), asset.filename);
    return relocate(asset, dir.rel, filename);
  };

  const deleteAsset: WorkspaceFs['deleteAsset'] = (id) => {
    const asset = getAsset(id);
    fs.unlinkSync(path.join(rootAbs, ...asset.id.split('/')));
    const meta = readMeta();
    delete meta.assets[id];
    delete meta.fonts[id];
    writeMetaRaw(meta);
  };

  const createFolder: WorkspaceFs['createFolder'] = (rel) => {
    const n = normalizeRel(rel);
    if (!n) throw new HttpError(400, `invalid folder: ${rel}`);
    assetDir(n);
    const hit = listFolders().find((f) => f.id === n);
    if (!hit) throw new HttpError(500, 'folder was not created');
    return hit;
  };

  /** Every image asset whose id starts with assets/<folderRel>/ */
  const assetsUnder = (folderRel: string): TypstAsset[] =>
    listAssets().filter((a) => a.kind === 'image' && a.id.startsWith(`${ASSETS_DIR}/${folderRel}/`));

  const renameFolder: WorkspaceFs['renameFolder'] = (rel, newRel) => {
    const from = normalizeRel(rel);
    const to = normalizeRel(newRel);
    if (!from || !to) throw new HttpError(400, 'invalid folder path');
    const fromAbs = resolveInside(rootAbs, `${ASSETS_DIR}/${from}`);
    const toAbs = resolveInside(rootAbs, `${ASSETS_DIR}/${to}`);
    if (!fromAbs || !toAbs || !fs.existsSync(fromAbs)) throw new HttpError(404, `folder not found: ${rel}`);
    if (fs.existsSync(toAbs)) throw new HttpError(409, `a folder named ${to} already exists`);
    const before = assetsUnder(from);
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    fs.renameSync(fromAbs, toAbs);
    let references = 0;
    const files = new Set<string>();
    for (const a of before) {
      const newId = `${ASSETS_DIR}/${to}/${a.id.slice(`${ASSETS_DIR}/${from}/`.length)}`;
      moveMeta('image', a.id, newId);
      const r = rewriteReferencesTracked(`/${a.id}`, `/${newId}`);
      references += r.total;
      for (const f of r.files) files.add(f);
    }
    return { references, files: [...files] };
  };

  const deleteFolder: WorkspaceFs['deleteFolder'] = (rel) => {
    const n = normalizeRel(rel);
    if (!n) throw new HttpError(400, `invalid folder: ${rel}`);
    const dirAbs = resolveInside(rootAbs, `${ASSETS_DIR}/${n}`);
    if (!dirAbs || !fs.existsSync(dirAbs)) throw new HttpError(404, `folder not found: ${rel}`);
    const parentRel = n.includes('/') ? n.slice(0, n.lastIndexOf('/')) : null;
    const parent = assetDir(parentRel);
    let references = 0;
    let moved = 0;
    const files = new Set<string>();
    for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
      const target = uniqueFilename(namesIn(parent.abs), entry.name);
      const fromId = `${ASSETS_DIR}/${n}/${entry.name}`;
      const toId = `${parent.rel}/${target}`;
      const under = entry.isDirectory() ? assetsUnder(`${n}/${entry.name}`) : [];
      fs.renameSync(path.join(dirAbs, entry.name), path.join(parent.abs, target));
      moved += 1;
      if (entry.isDirectory()) {
        for (const a of under) {
          const newId = toId + a.id.slice(fromId.length);
          moveMeta('image', a.id, newId);
          const r = rewriteReferencesTracked(`/${a.id}`, `/${newId}`);
          references += r.total;
          for (const f of r.files) files.add(f);
        }
      } else {
        moveMeta('image', fromId, toId);
        const r = rewriteReferencesTracked(`/${fromId}`, `/${toId}`);
        references += r.total;
        for (const f of r.files) files.add(f);
      }
    }
    fs.rmdirSync(dirAbs);
    return { references, moved, files: [...files] };
  };

  return {
    root: rootAbs,
    abs,
    getAsset,
    addAsset,
    patchAsset,
    renameAsset,
    moveAsset,
    deleteAsset,
    createFolder,
    renameFolder,
    deleteFolder,
    rewriteReferences,
    listFiles,
    typFiles: () => listFiles().map((f) => f.path).filter((p) => p.endsWith('.typ')).sort(),
    readFile(rel) {
      const n = normalizeRel(rel);
      if (n === null || n === '') return null;
      const a = resolveInside(rootAbs, n);
      if (!a) return null;
      try {
        const st = fs.statSync(a);
        if (!st.isFile()) return null;
        return { bytes: new Uint8Array(fs.readFileSync(a)), etag: etagOf(st) };
      } catch { return null; }
    },
    writeFile(rel, bytes) {
      const n = normalizeRel(rel);
      if (n && n.toLowerCase() === META_FILE) throw new HttpError(400, 'workspace.json is managed by the app');
      const a = abs(rel);
      writeAtomic(a, bytes);
      const st = fs.statSync(a);
      return { path: n as string, size: st.size, mtime: Math.round(st.mtimeMs) };
    },
    deleteFile(rel) {
      const a = abs(rel);
      try { fs.unlinkSync(a); return true; } catch { return false; }
    },
    readMeta,
    writeMeta(meta) { writeAtomic(path.join(rootAbs, META_FILE), JSON.stringify(normaliseMeta(meta), null, 2)); },
    listAssets,
    listFolders,
  };
}

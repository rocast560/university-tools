import fs from 'node:fs';
import path from 'node:path';
import type { AssetMeta, WorkspaceJson } from '../src/types';
import { sanitizeFilename, uniqueFilename } from './assets';
import { ensureDir, readJson, safeDirName, uniqueDirName } from './fsx';
import { fontFamily } from './fonts';
import { createSettingsStore } from './settings';
import { openWorkspace } from './workspace';

interface LegacyAsset { id: string; kind: 'image' | 'font'; filename: string; width?: number | null; height?: number | null; crop?: AssetMeta['crop']; blurs?: AssetMeta['blurs']; fontFamily?: string | null }
interface LegacyDoc { id: string; name: string; folderId: string | null; source: string; assets: LegacyAsset[]; createdAt: number }

export function importLegacy(opts: { legacyDir: string; dataDir: string; log?: (...a: unknown[]) => void }) {
  const log = opts.log ?? ((...a: unknown[]) => console.log('[import-legacy]', ...a));
  const settings = createSettingsStore(opts.dataDir);
  const workspacesDir = path.join(opts.dataDir, 'workspaces');
  ensureDir(workspacesDir);
  const folders = readJson<{ folders?: Array<{ id: string; name: string }> }>(path.join(opts.legacyDir, 'folders.json'), {}).folders ?? [];
  const groupOf = (id: string | null) => folders.find((f) => f.id === id)?.name ?? null;
  const docsDir = path.join(opts.legacyDir, 'documents');
  const imported: Array<{ name: string; group: string | null; path: string; assets: number }> = [];
  // Only names registered *before* this run are skipped for idempotence; a name collision
  // between two legacy documents within the same run instead falls through to
  // uniqueDirName below, which suffixes the second one (e.g. "Dup (2)").
  const preexisting = new Set(settings.listWorkspaces().map((w) => w.name));

  for (const file of fs.readdirSync(docsDir).filter((f) => f.endsWith('.json')).sort()) {
    const doc = readJson<LegacyDoc | null>(path.join(docsDir, file), null);
    if (!doc || typeof doc.source !== 'string') { log('skipping unreadable', file); continue; }
    if (preexisting.has(doc.name)) { log('already imported', doc.name); continue; }
    const dir = path.join(workspacesDir, uniqueDirName(workspacesDir, safeDirName(doc.name)));
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, 'main.typ'), doc.source);
    const meta: WorkspaceJson = { version: 1, assets: {}, fonts: {} };
    const usedAssetNames = new Set<string>();
    const usedFontNames = new Set<string>();
    let count = 0;
    for (const a of doc.assets ?? []) {
      const blob = path.join(opts.legacyDir, 'blobs', a.id);
      if (!fs.existsSync(blob)) { log(`missing blob for ${doc.name}/${a.filename}`); continue; }
      const sub = a.kind === 'font' ? 'fonts' : 'assets';
      ensureDir(path.join(dir, sub));
      // Sanitise (strip any directory components, e.g. "../evil.png") and
      // de-duplicate against sibling assets of the same kind in this
      // document, so two legacy assets sharing a filename don't overwrite
      // one another on disk or in workspace.json.
      const used = a.kind === 'font' ? usedFontNames : usedAssetNames;
      const name0 = sanitizeFilename(a.filename);
      const name = uniqueFilename(used, name0);
      used.add(name);
      if (name !== a.filename) log(`renamed ${doc.name}/${a.filename} -> ${sub}/${name}`);
      fs.copyFileSync(blob, path.join(dir, sub, name));
      const id = `${sub}/${name}`;
      if (a.kind === 'font') {
        // R5: a legacy font record with no fontFamily falls back to sniffing
        // the SFNT name table from the blob's bytes.
        const family = a.fontFamily && a.fontFamily.trim() ? a.fontFamily : fontFamily(fs.readFileSync(blob));
        meta.fonts[id] = { family: family ?? null };
      } else if (a.crop || (a.blurs && a.blurs.length) || a.width || a.height) {
        meta.assets[id] = { crop: a.crop ?? null, blurs: a.blurs ?? null, width: a.width ?? null, height: a.height ?? null };
      }
      count += 1;
    }
    if (Object.keys(meta.assets).length || Object.keys(meta.fonts).length) openWorkspace(dir).writeMeta(meta);
    settings.addWorkspace({ path: dir, name: doc.name, group: groupOf(doc.folderId), library: true });
    imported.push({ name: doc.name, group: groupOf(doc.folderId), path: dir, assets: count });
    log(`imported ${doc.name} (${count} assets)`);
  }
  return { imported };
}

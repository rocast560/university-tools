import fs from 'node:fs';
import path from 'node:path';
import { z, type ZodRawShape } from 'zod';
import type { TypstAsset, WorkspaceEntry } from '../src/types';
import { parseLength } from '../src/lib/typst-geometry';
import { ensureHelper, findScreenshotSlots, newSlotSnippet, setSlotHeight, setSlotPath, type ScreenshotSlot } from '../src/lib/typst-placeholders';
import type { Backup } from './backup/index';
import { extensionOf } from './assets';
import { fontFamily, fontFamilyViaTypst } from './fonts';
import { HttpError } from './http';
import { normalizeRel } from './paths';
import type { CompileApi } from './router';
import type { WorkspaceService } from './service';
import type { SettingsStore } from './settings';

export const MCP_ORIGIN = 'mcp';

export interface ToolDeps { service: WorkspaceService; compile: CompileApi; backup: Backup; settings: SettingsStore }
export interface ToolDef { name: string; description: string; schema: ZodRawShape; run: (args: Record<string, unknown>, deps: ToolDeps) => Promise<unknown> | unknown }

const WS = z.string().describe('Workspace id from list_workspaces.');
const SLOT = z.number().int().min(0).describe('Slot index from list_slots / get_workspace (0-based, in document order).');
const FILE = z.string().optional().describe('A .typ path inside the workspace. Defaults to main.typ.');

const entryFile = (f: unknown): string => {
  const n = normalizeRel(typeof f === 'string' && f ? f : 'main.typ');
  if (!n || !n.endsWith('.typ')) throw new HttpError(400, 'file must be a .typ path inside the workspace');
  return n;
};
const readSource = (deps: ToolDeps, id: string, file: string): string => {
  const f = deps.service.fs(id).readFile(file);
  if (!f) throw new HttpError(404, `${file} not found in workspace`);
  return new TextDecoder().decode(f.bytes);
};
const writeSource = (deps: ToolDeps, id: string, file: string, source: string) => deps.service.writeFile(id, file, new TextEncoder().encode(source), MCP_ORIGIN);
const slotsOf = (source: string) => findScreenshotSlots(source).map((s, index) => ({ ...s, index }));
const withSlots = (deps: ToolDeps, e: WorkspaceEntry) => ({ ...e, slots: slotsOf(readSource(deps, e.id, 'main.typ')) });
const decodeBase64 = (s: string): Uint8Array => { const clean = s.replace(/^data:[^,]*,/, ''); return new Uint8Array(Buffer.from(clean, 'base64')); };
const bytesFrom = (args: Record<string, unknown>): { bytes: Uint8Array; name: string } => {
  if (typeof args.path === 'string' && args.path) {
    if (!path.isAbsolute(args.path)) throw new HttpError(400, 'path must be absolute');
    try { return { bytes: new Uint8Array(fs.readFileSync(args.path)), name: path.basename(args.path) }; } catch { throw new HttpError(404, `cannot read ${args.path}`); }
  }
  if (typeof args.data_base64 === 'string' && args.data_base64) return { bytes: decodeBase64(args.data_base64), name: typeof args.filename === 'string' ? args.filename : 'asset' };
  throw new HttpError(400, 'pass path (absolute, on this machine) or data_base64');
};
const rewriteSlot = (deps: ToolDeps, id: string, index: number, fn: (source: string, slot: ScreenshotSlot) => string) => {
  const source = readSource(deps, id, 'main.typ');
  const slot = findScreenshotSlots(source)[index];
  if (!slot) throw new HttpError(404, `no slot ${index}; the document has ${findScreenshotSlots(source).length}`);
  const next = fn(source, slot);
  if (next !== source) writeSource(deps, id, 'main.typ', next);
  return { slots: slotsOf(next) };
};
const heightPt = (h: unknown): number | null => {
  if (h === undefined || h === null) return null;
  const pt = parseLength(String(h));
  if (pt === null || pt <= 0) throw new HttpError(400, `height must be a Typst length such as "3in", "8cm" or "200pt" (got "${String(h)}")`);
  return pt;
};

export const TOOLS: ToolDef[] = [
  { name: 'list_workspaces', description: 'List every workspace: id, name, group, folder path, whether it is in the app library or an external folder, and whether its folder currently exists.', schema: {}, run: (_a, d) => d.service.list() },
  { name: 'get_workspace', description: 'One workspace in full: entry, file tree, images and fonts with their framing, asset folders, and the figure slots in main.typ (index, line, caption, placed path, height in points).', schema: { workspace_id: WS }, run: (a, d) => { const det = d.service.detail(a.workspace_id as string); return { ...det, slots: slotsOf(readSource(d, det.entry.id, 'main.typ')) }; } },
  { name: 'create_workspace', description: 'Create a workspace folder in the app library. Without a source it starts from the starter template, which defines the image-placeholder helper and two empty figure slots.', schema: { name: z.string().optional().describe('Display name; also the folder name. Defaults to "Untitled report".'), group: z.string().optional().describe('Sidebar group label.'), source: z.string().optional().describe('Initial main.typ contents.') }, run: (a, d) => withSlots(d, d.service.create({ name: (a.name as string | undefined) ?? '', group: (a.group as string | undefined) ?? null, source: a.source as string | undefined })) },
  { name: 'rename_workspace', description: 'Rename a workspace. A library workspace\'s folder is renamed too; an external folder is left alone.', schema: { workspace_id: WS, name: z.string() }, run: (a, d) => d.service.rename(a.workspace_id as string, a.name as string) },
  { name: 'move_workspace', description: 'Set or clear the sidebar group of a workspace (null = loose at the top level). Groups also shape the backup mirror tree.', schema: { workspace_id: WS, group: z.string().nullable() }, run: (a, d) => d.service.setGroup(a.workspace_id as string, a.group as string | null) },
  { name: 'delete_workspace', description: 'Remove a workspace from the app. A library workspace\'s folder moves to the app trash (never deleted); an external folder is only forgotten.', schema: { workspace_id: WS }, run: (a, d) => { d.service.remove(a.workspace_id as string); return { ok: true }; } },

  { name: 'get_source', description: 'Read a Typst file from the workspace (main.typ by default).', schema: { workspace_id: WS, file: FILE }, run: (a, d) => { const f = entryFile(a.file); return { file: f, source: readSource(d, a.workspace_id as string, f) }; } },
  { name: 'set_source', description: 'Replace the entire contents of a Typst file. For a small change prefer edit_source.', schema: { workspace_id: WS, source: z.string(), file: FILE }, run: (a, d) => { const f = entryFile(a.file); writeSource(d, a.workspace_id as string, f, a.source as string); return { file: f, slots: slotsOf(a.source as string) }; } },
  { name: 'edit_source', description: 'Replace an exact string in a Typst file. old_string must occur exactly once (add surrounding lines to disambiguate) unless replace_all is true. Returns the replacement count and the slots afterwards.', schema: { workspace_id: WS, old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional(), file: FILE }, run: (a, d) => {
    const f = entryFile(a.file); const src = readSource(d, a.workspace_id as string, f); const oldS = a.old_string as string;
    if (!oldS) throw new HttpError(400, 'old_string cannot be empty');
    const count = src.split(oldS).length - 1;
    if (count === 0) throw new HttpError(400, 'old_string not found');
    if (count > 1 && !a.replace_all) throw new HttpError(400, `old_string occurs ${count} times; include more context or pass replace_all: true`);
    const next = a.replace_all ? src.split(oldS).join(a.new_string as string) : src.replace(oldS, () => a.new_string as string);
    writeSource(d, a.workspace_id as string, f, next);
    return { replacements: count, file: f, slots: slotsOf(next) };
  } },

  { name: 'list_slots', description: 'The figure slots (#image-placeholder calls) in main.typ, in document order, with caption, placed path and height.', schema: { workspace_id: WS }, run: (a, d) => slotsOf(readSource(d, a.workspace_id as string, 'main.typ')) },
  { name: 'add_slot', description: 'Append an empty figure slot to main.typ, adding the image-placeholder helper if the document lacks it.', schema: { workspace_id: WS, caption: z.string() }, run: (a, d) => {
    const id = a.workspace_id as string; const ensured = ensureHelper(readSource(d, id, 'main.typ'));
    const base = ensured.source.endsWith('\n') ? ensured.source : `${ensured.source}\n`;
    const next = `${base}\n${newSlotSnippet(a.caption as string)}`; writeSource(d, id, 'main.typ', next);
    const slots = slotsOf(next); return { slot: slots[slots.length - 1], slotCount: slots.length, helperChanged: ensured.changed };
  } },
  { name: 'place_image', description: 'Put an image asset into a figure slot by writing path: "/<asset id>" onto that #image-placeholder call. Optionally set the figure height.', schema: { workspace_id: WS, slot_index: SLOT, asset_id: z.string().describe('Asset id from list_assets, e.g. "assets/findings/login.png".'), height: z.string().optional().describe('Typst length, e.g. "3in".') }, run: (a, d) => {
    const asset = d.service.fs(a.workspace_id as string).getAsset(a.asset_id as string);
    if (asset.kind !== 'image') throw new HttpError(400, 'only images can be placed');
    const pt = heightPt(a.height);
    return rewriteSlot(d, a.workspace_id as string, a.slot_index as number, (src, slot) => { let next = setSlotPath(src, slot, `/${asset.id}`); if (pt !== null) { const s2 = findScreenshotSlots(next)[a.slot_index as number]!; next = setSlotHeight(next, s2, pt); } return next; });
  } },
  { name: 'clear_slot', description: 'Remove the image from a figure slot, leaving the empty placeholder box and its caption.', schema: { workspace_id: WS, slot_index: SLOT }, run: (a, d) => rewriteSlot(d, a.workspace_id as string, a.slot_index as number, (src, slot) => setSlotPath(src, slot, null)) },
  { name: 'set_slot_height', description: 'Set (or with null, reset) the height of one figure slot.', schema: { workspace_id: WS, slot_index: SLOT, height: z.string().nullable() }, run: (a, d) => rewriteSlot(d, a.workspace_id as string, a.slot_index as number, (src, slot) => setSlotHeight(src, slot, heightPt(a.height))) },

  { name: 'list_assets', description: 'Images and fonts in the workspace with ids, folders, sizes, crop/blur framing and font families.', schema: { workspace_id: WS }, run: (a, d) => d.service.fs(a.workspace_id as string).listAssets() },
  { name: 'upload_asset', description: 'Add an image (png, jpg, gif, webp, svg) from an absolute path on this machine or from base64. The stored name may differ (sanitised, extension corrected to the bytes, de-duplicated): use the returned id.', schema: { workspace_id: WS, path: z.string().optional(), data_base64: z.string().optional(), filename: z.string().optional(), folder: z.string().optional().describe('Folder under assets/, created if missing.') }, run: (a, d) => { const { bytes, name } = bytesFrom(a); return d.service.addAsset(a.workspace_id as string, { kind: 'image', filename: (a.filename as string | undefined) ?? name, bytes, folder: (a.folder as string | undefined) ?? null }, MCP_ORIGIN); } },
  { name: 'add_font', description: 'Add a font file (ttf, otf, woff, woff2, ttc) to fonts/. The family name is read from the file when possible; pass family for woff/woff2.', schema: { workspace_id: WS, path: z.string().optional(), data_base64: z.string().optional(), filename: z.string().optional(), family: z.string().optional() }, run: async (a, d) => {
    const { bytes, name } = bytesFrom(a);
    const filename = (a.filename as string | undefined) ?? name;
    // R11: the extension has to come from the source file's own name (the
    // real basename for a `path` upload), not a caller-supplied `filename`
    // override, since that's what the bytes actually are.
    const ext = extensionOf(name) || extensionOf(filename);
    const family = (a.family as string | undefined) ?? (await fontFamilyViaTypst(d.compile.available(), bytes, ext)) ?? fontFamily(bytes);
    return d.service.addAsset(a.workspace_id as string, { kind: 'font', filename, bytes, folder: null, family }, MCP_ORIGIN);
  } },
  { name: 'rename_asset', description: 'Rename an asset (extension kept) and rewrite every reference in every .typ file.', schema: { workspace_id: WS, asset_id: z.string(), stem: z.string().describe('New name without extension.') }, run: (a, d) => d.service.renameAsset(a.workspace_id as string, a.asset_id as string, a.stem as string, MCP_ORIGIN) },
  { name: 'move_asset', description: 'Move an image into a folder under assets/ (null = the root), rewriting references.', schema: { workspace_id: WS, asset_id: z.string(), folder: z.string().nullable() }, run: (a, d) => d.service.moveAsset(a.workspace_id as string, a.asset_id as string, a.folder as string | null, MCP_ORIGIN) },
  { name: 'update_asset', description: 'Set render-time framing: crop {x,y,w,h} normalised to the original (may extend past 0..1 to letterbox), blurs (inside 0..1; style gaussian|pixelate; strength 0.25..3), natural width/height. null clears. The file is never modified.', schema: { workspace_id: WS, asset_id: z.string(), crop: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable().optional(), blurs: z.array(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number(), style: z.enum(['gaussian', 'pixelate']).optional(), strength: z.number().optional() })).nullable().optional(), width: z.number().int().optional(), height: z.number().int().optional() }, run: (a, d) => { const { workspace_id, asset_id, ...patch } = a; if (Object.keys(patch).length === 0) throw new HttpError(400, 'pass at least one of crop, blurs, width, height'); return d.service.patchAsset(workspace_id as string, asset_id as string, patch, MCP_ORIGIN); } },
  { name: 'delete_asset', description: 'Delete an image or font file. References left in the source fail to compile until cleared.', schema: { workspace_id: WS, asset_id: z.string() }, run: (a, d) => { d.service.deleteAsset(a.workspace_id as string, a.asset_id as string, MCP_ORIGIN); return { ok: true }; } },

  { name: 'compile', description: 'Compile with the typst CLI and return diagnostics (errors and warnings with file, line, column). No PDF is kept.', schema: { workspace_id: WS, file: FILE }, run: (a, d) => d.compile.compile(a.workspace_id as string, a.file as string | undefined) },
  { name: 'export_pdf', description: 'Compile to a PDF at an absolute path on this machine. Crop and blur redactions are baked into the images first; the result reports how many were baked.', schema: { workspace_id: WS, to: z.string().describe('Absolute output path ending in .pdf'), file: FILE }, run: async (a, d) => { const out = await d.compile.exportPdf(a.workspace_id as string, a.file as string | undefined, a.to as string); return { path: out.path, baked: out.baked }; } },
  { name: 'render_preview', description: 'Render one page of the workspace to a PNG image, so you can see the compiled layout instead of only error diagnostics or a PDF path on disk.', schema: { workspace_id: WS, file: FILE, page: z.number().int().min(1).optional().describe('1-indexed page to render; defaults to 1.'), ppi: z.number().int().min(36).max(600).optional().describe('Pixels per inch; defaults to 144.') }, run: async (a, d) => {
    const res = await d.compile.renderPreview(a.workspace_id as string, a.file as string | undefined, a.page as number | undefined, a.ppi as number | undefined);
    if (!res.ok) return { ok: false, page: res.page, diagnostics: res.diagnostics };
    return { ok: true, page: res.page, image: { data: Buffer.from(res.png!).toString('base64'), mimeType: 'image/png' } };
  } },

  { name: 'backup_status', description: 'Backup destinations, snapshot interval and retention, and how the last run went.', schema: {}, run: (_a, d) => d.backup.state() },
  { name: 'run_backup', description: 'Mirror and snapshot to every destination now.', schema: {}, run: (_a, d) => d.backup.run() },
  { name: 'list_snapshots', description: 'Snapshots in one destination, newest first.', schema: { destination_id: z.string() }, run: (a, d) => d.backup.listSnapshots(a.destination_id as string) },
];

export async function callTool(name: string, args: Record<string, unknown>, deps: ToolDeps): Promise<unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new HttpError(404, `unknown tool: ${name}`);
  const parsed = z.object(tool.schema).safeParse(args);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return tool.run(parsed.data as Record<string, unknown>, deps);
}

export type { TypstAsset };

import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import type { BackupState, DirListing, McpStatus, SnapshotInfo, CompileResult, Diagnostic, FolderMeta } from '../src/types';
import type { EventBus } from './events';
import { HttpError, json, optionalString, readJsonObject, requireString } from './http';
import { folderName, joinPath, parentPath } from '../src/lib/folder-tree';
import { LOGO_TYPES, MAX_LOGO_BYTES, isLogoName, logoContentType } from '../src/lib/logo';
import { createLogoStore } from './logos';
import type { SettingsStore } from './settings';
import type { WorkspaceService } from './service';
import { serveStatic } from './static';
import { MAX_ASSET_BYTES, extensionOf } from './assets';
import { fontFamily, fontFamilyViaTypst } from './fonts';
import { etagOf } from './workspace';

/** Filled in by later tasks; null => the route answers 503. */
export interface BackupApi {
  state(): BackupState;
  configure(patch: Record<string, unknown>): BackupState;
  run(): Promise<BackupState>;
  listSnapshots(destinationId: string): SnapshotInfo[];
  restore(destinationId: string, name: string): Promise<{ restored: number }>;
}
export interface CompileApi {
  available(): string | null;
  compile(workspaceId: string, file: string | undefined): Promise<CompileResult>;
  exportPdf(workspaceId: string, file: string | undefined, to: string | undefined): Promise<{ path: string | null; bytes: Uint8Array | null; baked: number }>;
  renderPreview(workspaceId: string, file: string | undefined, page: number | undefined, ppi: number | undefined): Promise<{ ok: boolean; diagnostics: Diagnostic[]; png: Uint8Array | null; page: number }>;
}
export interface McpApi {
  handle(req: Request): Promise<Response>;
  status(): McpStatus;
}
export type BrowseApi = (p: string) => DirListing;

export interface HandlerDeps {
  settings: SettingsStore;
  service: WorkspaceService;
  bus: EventBus;
  token: string | null;
  staticDir: string | null;
  dataDir: string;
  backup: BackupApi | null;
  compile: CompileApi | null;
  mcp: McpApi | null;
  browse: BrowseApi | null;
}

const KEEPALIVE_MS = 25_000;

function authorised(req: Request, token: string | null): boolean {
  if (!token) return true;
  const h = req.headers.get('authorization') ?? '';
  const provided = h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
  if (!provided || provided.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(token));
}

function openEventStream(bus: EventBus): Response {
  const enc = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ }
      };
      send('hello', { at: Date.now() });
      unsubscribe = bus.subscribe((ev) => send(ev.type, ev));
      timer = setInterval(() => { try { controller.enqueue(enc.encode(': keepalive\n\n')); } catch { /* closed */ } }, KEEPALIVE_MS);
    },
    cancel() { unsubscribe?.(); if (timer) clearInterval(timer); },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
}

async function readBody(req: Request): Promise<Uint8Array> {
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > MAX_ASSET_BYTES + 1024) throw new HttpError(413, 'body too large');
  return buf;
}

/**
 * The icon / colour / logo fields of `src`, each a string or null (null clears).
 * `prefix` names the field in a 400: "" for a folder PATCH body, "appearance."
 * for a document's nested object. Only the keys present are returned.
 */
function parseAppearance(src: Record<string, unknown>, prefix: string): FolderMeta {
  const out: FolderMeta = {};
  for (const key of ['icon', 'color', 'logo'] as const) {
    if (!(key in src)) continue;
    const v = src[key];
    if (v === null) { out[key] = null; continue; }
    if (typeof v !== 'string') throw new HttpError(400, `${prefix}${key} must be a string or null`);
    if (key === 'logo' && !isLogoName(v)) throw new HttpError(400, `${prefix}logo must be a file name returned by POST /api/logos`);
    out[key] = v;
  }
  return out;
}

export function createHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const { service } = deps;
  const logos = createLogoStore(deps.dataDir);
  const need = <T>(v: T | null, what: string): T => { if (!v) throw new HttpError(503, `${what} not available`); return v; };

  async function route(req: Request, url: URL): Promise<Response> {
    const method = req.method.toUpperCase();
    // ['api', 'workspaces', id, ...]; the client (encodeURIComponent per segment) and the
    // browser's own URL parsing both leave percent-escapes in url.pathname, so every
    // segment -- and anything sliced/joined from it, like `rest` below -- must be decoded
    // before it reaches the service.
    let seg: string[];
    try {
      seg = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    } catch {
      return json(400, { error: 'bad path encoding' });
    }
    const origin = req.headers.get('x-client-id');

    if (seg[1] === 'health' && seg.length === 2) return json(200, { ok: true, version: '0.1.0' });
    if (seg[1] === 'events' && seg.length === 2 && method === 'GET') return openEventStream(deps.bus);

    if (seg[1] === 'logos') {
      if (seg.length === 2 && method === 'POST') {
        // Refuse on the declared size first, so a huge body is never read into memory.
        if (Number(req.headers.get('content-length') ?? 0) > MAX_LOGO_BYTES + 1024) throw new HttpError(413, `A logo can be at most ${MAX_LOGO_BYTES / 1024} KB.`);
        const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
        if (!(type in LOGO_TYPES)) throw new HttpError(415, 'A logo must be a PNG, JPEG, WebP or SVG image.');
        const bytes = new Uint8Array(await req.arrayBuffer());
        return json(201, { logo: logos.save(bytes, type) });
      }
      if (seg.length === 3 && (method === 'GET' || method === 'HEAD') && isLogoName(seg[2])) {
        const bytes = logos.read(seg[2]);
        if (!bytes) return json(404, { error: 'logo not found' });
        // Names are random and never reused, so the bytes behind one never change. The
        // sandbox and nosniff headers keep an SVG's scripts from ever running if it is opened directly.
        return new Response(method === 'HEAD' ? null : new Uint8Array(bytes), {
          status: 200,
          headers: {
            'content-type': logoContentType(seg[2]),
            'x-content-type-options': 'nosniff',
            'content-security-policy': 'sandbox',
            'cache-control': 'public, max-age=31536000, immutable',
          },
        });
      }
      return json(404, { error: 'logo not found' });
    }

    if (seg[1] === 'groups') {
      const state = () => ({ groups: service.listGroups(), folderMeta: service.folderMeta() });
      if (seg.length === 2) {
        if (method === 'GET') return json(200, state());
        if (method === 'POST') {
          const body = await readJsonObject(req);
          const parent = body.parent === undefined || body.parent === null ? null : requireString(body, 'parent');
          service.createGroup(requireString(body, 'name'), parent);
          return json(201, state());
        }
      }
      if (seg.length === 3) {
        const path = seg[2]!;
        if (method === 'PATCH') {
          const body = await readJsonObject(req);
          if ('name' in body && 'parent' in body) throw new HttpError(400, 'send either name or parent, not both');
          if ('name' in body) service.renameGroup(path, requireString(body, 'name'));
          else if ('parent' in body) service.moveGroup(path, body.parent === null ? null : requireString(body, 'parent'));
          const appearance = parseAppearance(body, '');
          if ('icon' in body || 'color' in body || 'logo' in body) {
            // A rename or move above relocated the folder, so apply appearance at its new path.
            const at = 'name' in body
              ? joinPath(parentPath(path), requireString(body, 'name'))
              : 'parent' in body
                ? joinPath(body.parent === null ? null : requireString(body, 'parent'), folderName(path))
                : path;
            service.setFolderAppearance(at, appearance);
          }
          return json(200, state());
        }
        if (method === 'DELETE') { service.deleteGroup(path); return json(200, state()); }
      }
    }

    if (seg[1] === 'workspaces') {
      if (seg.length === 2) {
        if (method === 'GET') return json(200, { workspaces: service.list() });
        if (method === 'POST') {
          const body = await readJsonObject(req);
          const g = body.group;
          if (g !== undefined && g !== null && typeof g !== 'string') throw new HttpError(400, 'group must be a string or null');
          return json(201, { workspace: service.create({ name: optionalString(body, 'name') ?? '', group: (g as string | null | undefined) ?? null, source: optionalString(body, 'source') }) });
        }
      }
      if (seg.length === 3 && seg[2] === 'open' && method === 'POST') {
        const body = await readJsonObject(req);
        return json(201, { workspace: service.openFolder(requireString(body, 'path'), optionalString(body, 'name')) });
      }
      const id = seg[2]!;
      if (seg.length === 3) {
        if (method === 'GET') {
          // A prefetch reads the workspace without "opening" it: the sidebar
          // orders by openedAt, and warming a cache must not reorder it.
          const detail = await service.detail(id, { touch: req.headers.get('x-tfs-prefetch') !== '1' });
          const etag = `"${detail.etag}"`;
          if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
          return json(200, detail, { etag, 'cache-control': 'no-cache' });
        }
        if (method === 'PATCH') {
          const body = await readJsonObject(req);
          let entry = service.entry(id);
          const name = optionalString(body, 'name');
          if (name !== undefined) entry = service.rename(id, name);
          if ('group' in body) {
            const g = body.group;
            if (g !== null && typeof g !== 'string') throw new HttpError(400, 'group must be a string or null');
            if (typeof body.parent === 'string') throw new HttpError(400, 'send either group or parent, not both');
            entry = service.setGroup(id, g as string | null);
          }
          if ('parent' in body) {
            const p = body.parent;
            if (p !== null && typeof p !== 'string') throw new HttpError(400, 'parent must be a string or null');
            entry = service.setParent(id, p as string | null);
          }
          if ('appearance' in body) {
            const a = body.appearance;
            if (!a || typeof a !== 'object' || Array.isArray(a)) throw new HttpError(400, 'appearance must be an object');
            entry = service.setAppearance(id, parseAppearance(a as Record<string, unknown>, 'appearance.'));
          }
          return json(200, { workspace: entry });
        }
        if (method === 'DELETE') { service.remove(id); return json(200, { ok: true }); }
      }
      const rest = seg.slice(4).join('/');
      if (seg[3] === 'files' && rest) {
        if (method === 'GET' || method === 'HEAD') {
          // Read without blocking the loop: on a bind mount a single read can
          // take tens of milliseconds, and every other request would wait.
          const abs = service.fs(id).abs(rest);
          let st: Awaited<ReturnType<typeof fsp.stat>>;
          try { st = await fsp.stat(abs); } catch { return json(404, { error: 'file not found' }); }
          if (!st.isFile()) return json(404, { error: 'file not found' });
          const etag = `"${etagOf(st)}"`;
          if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
          const bytes = method === 'HEAD' ? null : new Uint8Array(await fsp.readFile(abs));
          return new Response(bytes, { status: 200, headers: { etag, 'cache-control': 'no-cache', 'content-type': 'application/octet-stream' } });
        }
        if (method === 'PUT') { const { etag } = service.writeFile(id, rest, await readBody(req), origin); return json(200, { ok: true, etag }); }
        if (method === 'DELETE') return json(service.deleteFile(id, rest, origin) ? 200 : 404, { ok: true });
      }
      if (seg[3] === 'assets') {
        if (seg.length === 4 && method === 'POST') {
          const kind = url.searchParams.get('kind') === 'font' ? 'font' : 'image';
          const filename = url.searchParams.get('filename') ?? 'asset';
          const bytes = await readBody(req);
          let family = url.searchParams.get('family');
          if (!family && kind === 'font') {
            const ext = extensionOf(filename);
            family = (await fontFamilyViaTypst(deps.compile?.available() ?? null, bytes, ext)) ?? fontFamily(bytes);
          }
          const asset = service.addAsset(id, { kind, filename, bytes, folder: url.searchParams.get('folder') || null, family }, origin);
          return json(201, { asset });
        }
        if (rest && method === 'PATCH') {
          const body = await readJsonObject(req);
          const stem = optionalString(body, 'stem');
          if (stem !== undefined) return json(200, service.renameAsset(id, rest, stem, origin));
          if ('folder' in body) {
            const folder = body.folder;
            if (folder !== null && typeof folder !== 'string') throw new HttpError(400, 'folder must be a string or null');
            return json(200, service.moveAsset(id, rest, folder as string | null, origin));
          }
          return json(200, { asset: service.patchAsset(id, rest, body, origin) });
        }
        if (rest && method === 'DELETE') { service.deleteAsset(id, rest, origin); return json(200, { ok: true }); }
      }
      if (seg[3] === 'asset-folders' && seg.length === 4) {
        if (method === 'POST') { const b = await readJsonObject(req); return json(201, { folder: service.createFolder(id, requireString(b, 'path'), origin) }); }
        if (method === 'PATCH') { const b = await readJsonObject(req); return json(200, service.renameFolder(id, requireString(b, 'path'), requireString(b, 'newPath'), origin)); }
        if (method === 'DELETE') return json(200, service.deleteFolder(id, url.searchParams.get('path') ?? '', origin));
      }
      if (seg[3] === 'compile' && seg.length === 4 && method === 'POST') {
        const b = await readJsonObject(req);
        return json(200, await need(deps.compile, 'typst CLI').compile(id, optionalString(b, 'file')));
      }
      if (seg[3] === 'export-pdf' && seg.length === 4 && method === 'POST') {
        const b = await readJsonObject(req);
        const out = await need(deps.compile, 'typst CLI').exportPdf(id, optionalString(b, 'file'), optionalString(b, 'to'));
        if (out.bytes) return new Response(out.bytes, { status: 200, headers: { 'content-type': 'application/pdf', 'x-baked': String(out.baked) } });
        return json(200, { path: out.path, baked: out.baked });
      }
    }

    if (seg[1] === 'settings' && seg.length === 2) {
      if (method === 'GET') { const s = deps.settings.get(); return json(200, { typstCli: s.typstCli, redaction: s.redaction }); }
      if (method === 'PATCH') {
        const b = await readJsonObject(req);
        const s = deps.settings.update((cur) => ({
          ...cur,
          typstCli: 'typstCli' in b ? (typeof b.typstCli === 'string' && b.typstCli ? b.typstCli : null) : cur.typstCli,
          redaction: b.redaction && typeof b.redaction === 'object' ? { ...cur.redaction, ...(b.redaction as object) } : cur.redaction,
        }));
        return json(200, { typstCli: s.typstCli, redaction: s.redaction });
      }
    }
    if (seg[1] === 'backup') {
      const backup = need(deps.backup, 'backup');
      if (seg.length === 2 && method === 'GET') return json(200, { backup: backup.state() });
      if (seg.length === 2 && method === 'PATCH') return json(200, { backup: backup.configure(await readJsonObject(req)) });
      if (seg.length === 3 && seg[2] === 'run' && method === 'POST') return json(200, { backup: await backup.run() });
      if (seg.length === 3 && seg[2] === 'snapshots' && method === 'GET') return json(200, { snapshots: backup.listSnapshots(url.searchParams.get('destination') ?? '') });
      if (seg.length === 3 && seg[2] === 'restore' && method === 'POST') { const b = await readJsonObject(req); return json(200, await backup.restore(requireString(b, 'destination'), requireString(b, 'snapshot'))); }
    }
    if (seg[1] === 'fs' && seg[2] === 'browse' && seg.length === 3 && method === 'GET') return json(200, need(deps.browse, 'folder browser')(url.searchParams.get('path') ?? ''));
    if (seg[1] === 'mcp' && seg[2] === 'status' && seg.length === 3 && method === 'GET') return json(200, need(deps.mcp, 'MCP').status());
    return json(404, { error: `no route: ${method} ${url.pathname}` });
  }

  return async (req) => {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        if (!url.pathname.startsWith('/api/health') && !authorised(req, deps.token)) return json(401, { error: 'unauthorised' });
        return await route(req, url);
      }
      if (url.pathname === '/mcp') {
        if (!authorised(req, deps.token)) return json(401, { error: 'unauthorised' });
        return await need(deps.mcp, 'MCP').handle(req);
      }
      if (deps.staticDir && (req.method === 'GET' || req.method === 'HEAD')) {
        const res = serveStatic(deps.staticDir, url.pathname, req.headers.get('accept-encoding'));
        if (res) return res;
      }
      return json(404, { error: 'not found' });
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      console.error('[router]', err);
      return json(500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

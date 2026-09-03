import crypto from 'node:crypto';
import type { BackupState, DirListing, McpStatus, SnapshotInfo, CompileResult } from '../src/types';
import type { EventBus } from './events';
import { HttpError, json, optionalString, readJsonObject, requireString } from './http';
import type { SettingsStore } from './settings';
import type { WorkspaceService } from './service';
import { serveStatic } from './static';
import { MAX_ASSET_BYTES } from './assets';

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

export function createHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const { service } = deps;
  const need = <T>(v: T | null, what: string): T => { if (!v) throw new HttpError(503, `${what} not available`); return v; };

  async function route(req: Request, url: URL): Promise<Response> {
    const method = req.method.toUpperCase();
    const seg = url.pathname.split('/').filter(Boolean); // ['api', 'workspaces', id, ...]
    const origin = req.headers.get('x-client-id');

    if (seg[1] === 'health' && seg.length === 2) return json(200, { ok: true, version: '0.1.0' });
    if (seg[1] === 'events' && seg.length === 2 && method === 'GET') return openEventStream(deps.bus);

    if (seg[1] === 'workspaces') {
      if (seg.length === 2) {
        if (method === 'GET') return json(200, { workspaces: service.list() });
        if (method === 'POST') {
          const body = await readJsonObject(req);
          return json(201, { workspace: service.create({ name: optionalString(body, 'name') ?? '', group: optionalString(body, 'group') ?? null, source: optionalString(body, 'source') }) });
        }
      }
      if (seg.length === 3 && seg[2] === 'open' && method === 'POST') {
        const body = await readJsonObject(req);
        return json(201, { workspace: service.openFolder(requireString(body, 'path'), optionalString(body, 'name')) });
      }
      const id = seg[2]!;
      if (seg.length === 3) {
        if (method === 'GET') return json(200, service.detail(id));
        if (method === 'PATCH') {
          const body = await readJsonObject(req);
          let entry = service.entry(id);
          const name = optionalString(body, 'name');
          if (name !== undefined) entry = service.rename(id, name);
          if ('group' in body) {
            const g = body.group;
            if (g !== null && typeof g !== 'string') throw new HttpError(400, 'group must be a string or null');
            entry = service.setGroup(id, g as string | null);
          }
          return json(200, { workspace: entry });
        }
        if (method === 'DELETE') { service.remove(id); return json(200, { ok: true }); }
      }
      const rest = seg.slice(4).join('/');
      if (seg[3] === 'files' && rest) {
        if (method === 'GET' || method === 'HEAD') {
          const f = service.fs(id).readFile(rest);
          if (!f) return json(404, { error: 'file not found' });
          const etag = `"${f.etag}"`;
          if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
          return new Response(method === 'HEAD' ? null : f.bytes, { status: 200, headers: { etag, 'cache-control': 'no-cache', 'content-type': 'application/octet-stream' } });
        }
        if (method === 'PUT') { service.writeFile(id, rest, await readBody(req), origin); return json(200, { ok: true }); }
        if (method === 'DELETE') return json(service.deleteFile(id, rest, origin) ? 200 : 404, { ok: true });
      }
      if (seg[3] === 'assets') {
        if (seg.length === 4 && method === 'POST') {
          const kind = url.searchParams.get('kind') === 'font' ? 'font' : 'image';
          const asset = service.addAsset(id, { kind, filename: url.searchParams.get('filename') ?? 'asset', bytes: await readBody(req), folder: url.searchParams.get('folder') || null, family: url.searchParams.get('family') }, origin);
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

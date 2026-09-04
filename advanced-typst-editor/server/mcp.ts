import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { McpClientStatus, McpStatus } from '../src/types';
import type { Backup } from './backup/index';
import type { EventBus } from './events';
import { HttpError } from './http';
import { TOOLS, type ToolDeps } from './mcp-tools';
import type { CompileApi, McpApi } from './router';
import type { WorkspaceService } from './service';
import type { SettingsStore } from './settings';

export const SERVER_INFO = { name: 'typst-figure-studio', version: '0.1.0' };
const SESSION_TTL_MS = 30 * 60_000;

interface Session { id: string; server: McpServer; transport: WebStandardStreamableHTTPServerTransport; clientName: string; clientVersion: string | null; lastSeenAt: number; streamOpen: boolean }

export interface McpDeps { service: WorkspaceService; compile: CompileApi; backup: Backup; settings: SettingsStore; bus: EventBus; token: string | null; now?: () => number }

type ImageContent = { type: 'image'; data: string; mimeType: string };
type TextContent = { type: 'text'; text: string };

function hasImage(out: unknown): out is { image: { data: string; mimeType: string } } {
  if (!out || typeof out !== 'object' || !('image' in out)) return false;
  const img = (out as { image: unknown }).image;
  return !!img && typeof img === 'object' && typeof (img as { data: unknown }).data === 'string' && typeof (img as { mimeType: unknown }).mimeType === 'string';
}

/** A tool result carrying `{ image: { data, mimeType } }` becomes a real MCP image block (plus any other fields as text); everything else stays the plain JSON-text wrapping every other tool already used. */
function toContent(out: unknown): Array<ImageContent | TextContent> {
  if (!hasImage(out)) return [{ type: 'text', text: JSON.stringify(out ?? null, null, 2) }];
  const { image, ...rest } = out as { image: { data: string; mimeType: string } } & Record<string, unknown>;
  const content: Array<ImageContent | TextContent> = [{ type: 'image', data: image.data, mimeType: image.mimeType }];
  if (Object.keys(rest).length) content.push({ type: 'text', text: JSON.stringify(rest, null, 2) });
  return content;
}

export function createMcp(deps: McpDeps): McpApi & { close(): void } {
  const now = deps.now ?? (() => Date.now());
  const sessions = new Map<string, Session>();
  const toolDeps: ToolDeps = { service: deps.service, compile: deps.compile, backup: deps.backup, settings: deps.settings };

  const status = (): McpStatus => {
    const byName = new Map<string, McpClientStatus>();
    for (const s of sessions.values()) {
      const cur = byName.get(s.clientName);
      const connected = s.streamOpen || now() - s.lastSeenAt < 60_000;
      if (cur) { cur.sessions += 1; cur.connected ||= connected; cur.lastSeenAt = Math.max(cur.lastSeenAt, s.lastSeenAt); }
      else byName.set(s.clientName, { name: s.clientName, version: s.clientVersion, connected, lastSeenAt: s.lastSeenAt, sessions: 1 });
    }
    return { endpoint: '/mcp', authRequired: !!deps.token, clients: [...byName.values()] };
  };
  const publish = () => deps.bus.emit({ type: 'mcp.clients', clients: status().clients });

  // R4: onsessioninitialized can fire before the server has finished handling
  // the initialize message (clientInfo not yet recorded on server.server), so
  // every handled request also refreshes clientName/clientVersion.
  const refreshClientInfo = (session: Session) => {
    const info = session.server.server.getClientVersion();
    if (info) { session.clientName = info.name; session.clientVersion = info.version ?? null; }
  };

  /** Mark a session's standalone/GET stream as gone and publish, idempotently. */
  const closeStream = (session: Session) => {
    if (!session.streamOpen) return;
    session.streamOpen = false;
    publish();
  };

  const buildServer = (): McpServer => {
    const server = new McpServer(SERVER_INFO);
    for (const t of TOOLS) {
      server.registerTool(t.name, { description: t.description, inputSchema: t.schema }, async (args) => {
        try {
          const out = await t.run((args ?? {}) as Record<string, unknown>, toolDeps);
          return { content: toContent(out) };
        } catch (e) {
          const msg = e instanceof HttpError ? e.message : e instanceof Error ? e.message : String(e);
          return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
        }
      });
    }
    return server;
  };

  const newSession = async (): Promise<Session> => {
    const server = buildServer();
    const session: Session = { id: '', server, transport: null as unknown as WebStandardStreamableHTTPServerTransport, clientName: 'unknown', clientVersion: null, lastSeenAt: now(), streamOpen: false };
    session.transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        session.id = id;
        refreshClientInfo(session);
        sessions.set(id, session);
        publish();
      },
      onsessionclosed: (id) => { sessions.delete(id); publish(); },
    });
    // Belt-and-braces: however a transport ends up closed (TTL sweep, a
    // protocol-level failure inside the SDK), the standalone stream it was
    // holding open is gone too.
    session.transport.onclose = () => closeStream(session);
    await server.connect(session.transport);
    return session;
  };

  const sweep = () => {
    let removed = false;
    for (const [id, s] of sessions) {
      if (!s.streamOpen && now() - s.lastSeenAt > SESSION_TTL_MS) {
        sessions.delete(id);
        void s.transport.close();
        removed = true;
      }
    }
    if (removed) publish();
  };

  return {
    status,
    async handle(req) {
      sweep();
      const sid = req.headers.get('mcp-session-id');
      let found = sid ? sessions.get(sid) : undefined;
      if (!found) {
        if (req.method !== 'POST') return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unknown session' }, id: null }), { status: 404, headers: { 'content-type': 'application/json' } });
        found = await newSession();
      }
      const session = found;
      session.lastSeenAt = now();
      if (req.method === 'GET') {
        session.streamOpen = true;
        publish();
        const res = await session.transport.handleRequest(req);
        // R4: refresh client info on every handled request, GET included,
        // before the stream-wrapping below returns.
        refreshClientInfo(session);
        if (!res.body) { closeStream(session); return res; }
        // The transport's body resolves as soon as the SSE stream opens, not
        // when it ends -- `streamOpen` has to be cleared from the stream's
        // own lifecycle (normal completion or the client cancelling), or it
        // would stick forever and `sweep()` (which requires `!streamOpen`)
        // could never reap the session.
        const ts = new TransformStream<Uint8Array, Uint8Array>({
          flush() { closeStream(session); },
          cancel() { closeStream(session); },
        });
        return new Response(res.body.pipeThrough(ts), { status: res.status, headers: res.headers });
      }
      const res = await session.transport.handleRequest(req);
      // R4: the transport may have just processed initialize -- refresh the
      // client info now that the server has actually handled the request.
      if (sessions.has(session.id)) refreshClientInfo(session);
      if (req.method === 'DELETE') { sessions.delete(session.id); publish(); }
      return res;
    },
    close() { for (const s of sessions.values()) void s.transport.close(); sessions.clear(); },
  };
}

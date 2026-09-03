// Assembles the Hono app. Bun-specific pieces (WebSocket upgrade) are injected by server/index.ts
// so tests can build the app under Node.

import { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { Resolver } from '../src/chem/resolve';
import { registerApi } from './api';
import { mountMcp } from './mcp';
import type { SnapshotBroker } from './snapshots';
import { registerStatic } from './static';
import { registerWs, type WindowClient, type WsRegistry } from './ws';
import type { WorkspaceStore } from './workspace';

export interface AppDeps {
  store: WorkspaceStore;
  resolver: Resolver;
  staticDir?: string;
  upgradeWebSocket?: UpgradeWebSocket;
  host?: string;
  port?: number;
  snapshots?: SnapshotBroker;
  /** Messages from a window that are not hello/command (phase 2: snapshot_response). */
  onWindowMessage?: (msg: Record<string, unknown>, client: WindowClient) => void;
}

const VITE_DEV_PORT = 5173;

/** Loopback origins a browser may use: the server itself, and the Vite dev server, which proxies
 *  /api and /ws while forwarding its own Origin header. */
export function allowedOrigins(deps: AppDeps): string[] {
  const port = deps.port ?? 8140;
  const hosts = new Set(['127.0.0.1', 'localhost', deps.host ?? '127.0.0.1']);
  return [...hosts].flatMap((h) => [`http://${h}:${port}`, `http://${h}:${VITE_DEV_PORT}`]);
}

export function createApp(deps: AppDeps): { app: Hono; ws: WsRegistry | null } {
  const app = new Hono();

  // No CORS: the client is same-origin. Instead reject any request carrying a foreign Origin, which
  // stops both cross-origin reads and cross-origin writes (a simple POST needs no preflight), and
  // satisfies the MCP spec's Origin check for Streamable HTTP on localhost (DNS rebinding). Requests
  // with no Origin — curl, Claude Code, any non-browser MCP client — are allowed through.
  const origins = allowedOrigins(deps);
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && !origins.includes(origin)) return c.json({ error: 'Forbidden origin' }, 403);
    await next();
  });

  registerApi(app, deps);
  mountMcp(app, deps);
  const ws = deps.upgradeWebSocket ? registerWs(app, deps, deps.upgradeWebSocket) : null;
  if (deps.staticDir) registerStatic(app, deps.staticDir);
  return { app, ws };
}

// Assembles the Hono app. Bun-specific pieces (WebSocket upgrade) are injected by server/index.ts
// so tests can build the app under Node.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { UpgradeWebSocket } from 'hono/ws';
import type { Resolver } from '../src/chem/resolve';
import { registerApi } from './api';
import { mountMcp } from './mcp';
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
  /** Messages from a window that are not hello/command (phase 2: snapshot_response). */
  onWindowMessage?: (msg: Record<string, unknown>, client: WindowClient) => void;
}

export function createApp(deps: AppDeps): { app: Hono; ws: WsRegistry | null } {
  const app = new Hono();
  app.use('*', cors());
  registerApi(app, deps);
  mountMcp(app, deps);
  const ws = deps.upgradeWebSocket ? registerWs(app, deps, deps.upgradeWebSocket) : null;
  if (deps.staticDir) registerStatic(app, deps.staticDir);
  return { app, ws };
}

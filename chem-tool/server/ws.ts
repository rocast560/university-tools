// WebSocket protocol (spec 9.3). Server -> client: state, ack, error, snapshot_request (phase 2).
// Client -> server: hello, command, snapshot_response (phase 2).

import type { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { SceneSnapshot, Workspace } from '../src/chem/types';
import type { AppDeps } from './app';
import { CommandSchema } from './schemas';
import { CommandError } from './workspace';

/** Anything we can push a frame to: a Hono WSContext or Bun's native ServerWebSocket. */
interface Sendable { send(data: string): void }

export interface WindowClient { windowId: string }
export interface WsRegistry {
  clients: Map<unknown, WindowClient>;
  broadcast(msg: unknown): void;
}

/**
 * History snapshots hold whole Species records (molfile3d, both SVGs), so a scene with a deep
 * history serialises to hundreds of KB — re-sent on every command, including view changes. The
 * window only ever reads `history.past.length` / `history.future.length`, never the snapshots
 * themselves, so nulls of the right length carry everything it needs over the wire.
 */
export function toBroadcastWorkspace(ws: Workspace): Workspace {
  return {
    ...ws,
    scenes: ws.scenes.map((s) => ({
      ...s,
      history: {
        past: Array(s.history.past.length).fill(null) as unknown as SceneSnapshot[],
        future: Array(s.history.future.length).fill(null) as unknown as SceneSnapshot[],
      },
    })),
  };
}

export function registerWs(app: Hono, deps: AppDeps, upgradeWebSocket: UpgradeWebSocket): WsRegistry {
  // Keyed by `ws.raw` (the native socket), NOT by the WSContext wrapper: Hono's Bun adapter builds a
  // brand-new WSContext instance for every callback, so onOpen/onMessage/onClose each receive a
  // different object for the same connection. Keying by the wrapper makes every lookup miss, which
  // silently drops `hello` and every `command`. `ws.raw` is the only identity stable across a
  // connection's lifetime — do not "simplify" this back to keying by `ws`.
  const clients = new Map<unknown, WindowClient>();
  const send = (target: Sendable, msg: unknown) => { try { target.send(JSON.stringify(msg)); } catch { /* socket gone */ } };
  const registry: WsRegistry = {
    clients,
    broadcast(msg) { for (const raw of clients.keys()) send(raw as Sendable, msg); },
  };

  deps.store.subscribe((workspace, actor) => registry.broadcast({ type: 'state', workspace: toBroadcastWorkspace(workspace), actor, version: workspace.version }));

  app.get('/ws', upgradeWebSocket(() => ({
    onOpen(_evt, ws) {
      clients.set(ws.raw, { windowId: '' });
      const workspace = deps.store.get();
      send(ws, { type: 'state', workspace: toBroadcastWorkspace(workspace), actor: 'system', version: workspace.version });
      setTimeout(() => { if (clients.get(ws.raw)?.windowId === '') ws.close(); }, 10_000);
    },
    async onMessage(evt, ws) {
      const client = clients.get(ws.raw);
      if (!client) return;
      let msg: { type?: string; id?: string; windowId?: string; command?: unknown; pngBase64?: string };
      try { msg = JSON.parse(String(evt.data)); } catch { return send(ws, { type: 'error', message: 'Invalid JSON' }); }
      if (msg.type === 'hello') { client.windowId = String(msg.windowId ?? 'anon'); return; }
      if (msg.type === 'command') {
        try {
          const cmd = CommandSchema.parse(msg.command);
          const result = await deps.store.dispatch(cmd, `window:${client.windowId || 'anon'}`);
          send(ws, { type: 'ack', id: msg.id, result });
        } catch (err) {
          const status = err instanceof CommandError ? err.status : 400;
          const details = err instanceof CommandError ? err.details : {};
          send(ws, { type: 'error', id: msg.id, status, message: err instanceof Error ? err.message : String(err), ...details });
        }
        return;
      }
      deps.onWindowMessage?.(msg, client);
    },
    onClose(_evt, ws) { clients.delete(ws.raw); },
  })));

  return registry;
}

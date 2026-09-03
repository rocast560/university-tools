// Live connection to the server. Commands go over the socket and resolve on the server's ack;
// while reconnecting they fall back to POST /api/command.

import type { Command } from '../../server/schemas';
import type { CommandResult } from '../../server/workspace';
import { useStore } from './store';

export const windowId = Math.random().toString(36).slice(2, 10);

export class CommandFailed extends Error {
  constructor(message: string, public readonly status: number, public readonly details: Record<string, unknown>) { super(message); }
}

type Pending = { resolve: (r: CommandResult) => void; reject: (e: Error) => void };
const pending = new Map<string, Pending>();
let socket: WebSocket | null = null;
let attempt = 0;
let seq = 0;

/** Handlers for messages other than state/ack/error (phase 2: snapshot_request). */
export const extraHandlers: ((msg: Record<string, unknown>) => void)[] = [];

export function handleMessage(msg: Record<string, unknown>): void {
  const st = useStore.getState();
  if (msg.type === 'state') { st.setWorkspace(msg.workspace as never, String(msg.actor)); return; }
  if (msg.type === 'ack' && typeof msg.id === 'string') { pending.get(msg.id)?.resolve(msg.result as CommandResult); pending.delete(msg.id); return; }
  if (msg.type === 'error') {
    const { id, type: _t, message, status, ...details } = msg;
    if (typeof id === 'string') { pending.get(id)?.reject(new CommandFailed(String(message), Number(status ?? 400), details)); pending.delete(id); }
    else st.showToast(String(message));
    return;
  }
  for (const h of extraHandlers) h(msg);
}

export function connect(): void {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  useStore.getState().setConnection('connecting');
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => { attempt = 0; useStore.getState().setConnection('open'); ws.send(JSON.stringify({ type: 'hello', windowId })); };
  ws.onmessage = (e) => handleMessage(JSON.parse(String(e.data)));
  ws.onerror = () => ws.close();
  ws.onclose = () => {
    socket = null;
    useStore.getState().setConnection('closed');
    for (const p of pending.values()) p.reject(new CommandFailed('Connection lost', 0, {}));
    pending.clear();
    setTimeout(connect, Math.min(5000, 500 * 2 ** attempt++));
  };
}

export function sendRaw(msg: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

export async function sendCommand(command: Command): Promise<CommandResult> {
  if (socket?.readyState === WebSocket.OPEN) {
    const id = `c${++seq}`;
    const s = socket;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); s.send(JSON.stringify({ type: 'command', id, command })); });
  }
  const res = await fetch('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) });
  const body = await res.json();
  if (!res.ok) throw new CommandFailed(body.error ?? 'Command failed', res.status, body);
  useStore.getState().setWorkspace(body.workspace, `window:${windowId}`);
  return body.result;
}

import { WSContext, createWSMessageEvent, type UpgradeWebSocket, type WSEvents } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createResolver } from '../src/chem/resolve';
import { createApp } from './app';
import { WorkspaceStore, createInitialWorkspace } from './workspace';

/** Captures the event handlers registerWs hands to Hono, so tests drive the real protocol. */
function fakeUpgrade(): { upgrade: UpgradeWebSocket; events: () => WSEvents } {
  let events: WSEvents | null = null;
  const upgrade = ((createEvents: (c: never) => WSEvents) => {
    events = createEvents(undefined as never);
    return async () => new Response(null, { status: 101 });
  }) as unknown as UpgradeWebSocket;
  return { upgrade, events: () => events! };
}

/**
 * Hono's Bun adapter wraps the one native socket in a *fresh* WSContext on every onOpen/onMessage/
 * onClose call, so the fake mints a new context per call over a stable `raw` identity. A fake that
 * reuses one WSContext hides any code that keys client state by the wrapper instead of `raw`.
 */
function fakeSocket() {
  const sent: Record<string, unknown>[] = [];
  const state = { closed: false };
  const push = (data: unknown) => { sent.push(JSON.parse(String(data)) as Record<string, unknown>); };
  const raw = { send: push };
  const makeCtx = () => new WSContext({
    send: (data) => { push(data); },
    close: () => { state.closed = true; },
    readyState: 1,
    raw,
  });
  return { makeCtx, sent, state };
}

function make() {
  const { upgrade, events } = fakeUpgrade();
  const resolver = createResolver({ pubchem: null });
  const store = new WorkspaceStore(createInitialWorkspace(), resolver);
  const windowMessages: Record<string, unknown>[] = [];
  createApp({ store, resolver, upgradeWebSocket: upgrade, onWindowMessage: (m) => { windowMessages.push(m); } });
  const socket = fakeSocket();
  events().onOpen?.(new Event('open'), socket.makeCtx());
  const deliver = (msg: unknown) => events().onMessage?.(createWSMessageEvent(typeof msg === 'string' ? msg : JSON.stringify(msg)), socket.makeCtx());
  return { events, store, socket, windowMessages, deliver };
}

describe('server WebSocket', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test('opens with a state frame and closes a client that never says hello', () => {
    const { socket } = make();
    expect(socket.sent[0]).toMatchObject({ type: 'state', actor: 'system', version: 1 });
    vi.advanceTimersByTime(10_000);
    expect(socket.state.closed).toBe(true);
  });

  test('hello then command is dispatched and acknowledged', async () => {
    const { socket, store, deliver } = make();
    deliver({ type: 'hello', windowId: 'w1' });
    await deliver({ type: 'command', id: 'c1', command: { type: 'load', query: 'benzene' } });
    expect(store.focused().name).toBe('Benzene');
    const ack = socket.sent.find((m) => m.type === 'ack');
    expect(ack).toMatchObject({ id: 'c1', result: { message: expect.stringMatching(/Benzene/) } });
  });

  test('client state survives a different WSContext instance per callback', async () => {
    const { events, socket } = make();
    const helloCtx = socket.makeCtx();
    const commandCtx = socket.makeCtx();
    expect(helloCtx).not.toBe(commandCtx);
    events().onMessage?.(createWSMessageEvent(JSON.stringify({ type: 'hello', windowId: 'w1' })), helloCtx);
    await events().onMessage?.(createWSMessageEvent(JSON.stringify({ type: 'command', id: 'c1', command: { type: 'load', query: 'benzene' } })), commandCtx);
    expect(socket.sent.find((m) => m.type === 'ack')).toMatchObject({ id: 'c1' });
    vi.advanceTimersByTime(10_000);
    expect(socket.state.closed).toBe(false);
  });

  test('unparseable JSON and an invalid command shape both answer with an error frame', async () => {
    const { socket, deliver } = make();
    deliver({ type: 'hello', windowId: 'w1' });
    deliver('not json');
    expect(socket.sent.at(-1)).toMatchObject({ type: 'error', message: 'Invalid JSON' });
    await deliver({ type: 'command', id: 'c2', command: { type: 'nope' } });
    expect(socket.sent.at(-1)).toMatchObject({ type: 'error', id: 'c2', status: 400 });
    await deliver({ type: 'command', id: 'c3', command: { type: 'load', query: 'benzeen' } });
    expect(socket.sent.at(-1)).toMatchObject({ type: 'error', id: 'c3', status: 404, suggestions: ['Benzene'] });
  });

  test('other frames are routed to onWindowMessage', () => {
    const { windowMessages, deliver } = make();
    deliver({ type: 'hello', windowId: 'w1' });
    deliver({ type: 'snapshot_response', id: 'snap1', pngBase64: 'AAAA' });
    expect(windowMessages).toEqual([{ type: 'snapshot_response', id: 'snap1', pngBase64: 'AAAA' }]);
  });

  test('broadcast keeps history depth but not the snapshots themselves', async () => {
    const { socket, store, deliver } = make();
    deliver({ type: 'hello', windowId: 'w1' });
    await deliver({ type: 'command', id: 'c1', command: { type: 'load', query: 'benzene' } });
    const state = socket.sent.filter((m) => m.type === 'state').at(-1) as { workspace: { scenes: { history: { past: unknown[]; future: unknown[] } }[] } };
    expect(state.workspace.scenes[0].history).toEqual({ past: [null], future: [] });
    expect(store.get().scenes[0].history.past[0].species[0].svg2d).toContain('<svg');
    expect(JSON.stringify(state.workspace).length).toBeLessThan(JSON.stringify(store.get()).length);
  });
});

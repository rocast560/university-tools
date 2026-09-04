// ─────────────────────────────────────────────────────────────────────────
// The studio as a stdio MCP server, for clients that launch a command
// instead of dialling a URL (Claude Desktop, and anything else that only
// speaks the stdio transport).
//
// This is a transport shim, not a second implementation. It reads
// newline-delimited JSON-RPC on stdin, POSTs each message to the running
// server's `/mcp` (the Docker container, or `bun run dev:server`), and
// writes the reply back on stdout. Tools, storage, auth and the write bus
// stay in one place, so a document edited from Claude Desktop travels the
// exact path an HTTP client takes: same slot helpers, same `origin: 'mcp'`
// events, same live refresh in open tabs.
//
// After `initialize` it also holds the standalone `GET /mcp` event stream
// open, which is what the header light in the app counts as "connected"
// (see mcp-sessions.ts). Nothing but keepalives comes down it today.
//
// Configuration is environment-only:
//
//   TFS_MCP_URL   http://127.0.0.1:8090/mcp
//   APP_TOKEN     the token the server was started with (unset = open)
//
// stdout carries the protocol and nothing else. Diagnostics go to stderr.
// ─────────────────────────────────────────────────────────────────────────

import process from 'node:process';

const ENDPOINT = process.env.TFS_MCP_URL ?? 'http://127.0.0.1:8090/mcp';
const PASSWORD = process.env.APP_TOKEN ?? '';

/** How long to wait before re-opening the standalone event stream. */
const RETRY_MS = 3_000;

type Json = Record<string, unknown>;

let sessionId: string | null = null;
let shuttingDown = false;
const streamAbort = new AbortController();

/**
 * The forwarding chain. One message at a time, because initialize has to
 * bank its session id before the calls queued behind it go out, and because
 * closing stdin must not cut a call that is still in flight.
 */
let queue: Promise<void> = Promise.resolve();

function log(...parts: unknown[]): void {
  console.error('[typst-studio-stdio]', ...parts);
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One JSON-RPC message out, newline-delimited, on the protocol channel. */
function send(msg: Json): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function requestHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (PASSWORD) headers.authorization = `Bearer ${PASSWORD}`;
  if (sessionId) headers['mcp-session-id'] = sessionId;
  return headers;
}

// ── parsing (pure, exported for the tests) ───────────────────────────────

/** Pull the `data:` payloads out of an SSE body. Comments and keepalives drop. */
export function sseMessages(chunk: string): Json[] {
  const out: Json[] = [];
  for (const line of chunk.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const body = line.slice(5).trim();
    if (!body) continue;
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === 'object') out.push(parsed as Json);
    } catch {
      log('ignoring an unparsable event payload');
    }
  }
  return out;
}

/**
 * The messages in one HTTP reply. The server answers JSON today, but the
 * Streamable HTTP transport allows an SSE body for the same POST, so both
 * are read.
 */
export function payloads(text: string, contentType: string): Json[] {
  if (/text\/event-stream/i.test(contentType)) return sseMessages(text);
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? [parsed as Json] : [];
  } catch {
    return [];
  }
}

// ── the bridge ───────────────────────────────────────────────────────────

async function forward(msg: Json): Promise<void> {
  const id = msg.id;

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: requestHeaders({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      }),
      body: JSON.stringify(msg),
    });
  } catch (err) {
    log(`cannot reach ${ENDPOINT}:`, reason(err));
    if (id !== undefined) {
      send({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32001,
          message: `Typst Studio is not reachable at ${ENDPOINT}. Start it from the desktop icon or with "bun run dev:server".`,
        },
      });
    }
    return;
  }

  // initialize is what hands out the session; bank it before anything else
  // goes out, then hold the stream open so the app shows a live client.
  if (msg.method === 'initialize') {
    const granted = res.headers.get('mcp-session-id');
    if (granted) {
      sessionId = granted;
      void holdStream();
    }
  }

  // Notifications and client-to-server responses get 202 with no body.
  if (res.status === 202 || res.status === 204) return;

  const text = await res.text();
  const replies = payloads(text, res.headers.get('content-type') ?? '');

  if (replies.length === 0) {
    if (id !== undefined) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: `unreadable reply (HTTP ${res.status}): ${text.slice(0, 200)}` },
      });
    }
    return;
  }

  for (const reply of replies) {
    // Auth and protocol errors come back with a null id. Give the client
    // back the id it asked with, so the call settles instead of hanging.
    if (id !== undefined && reply.id === null) reply.id = id;
    send(reply);
  }
}

/**
 * The standalone event stream, re-opened until shutdown. Its only job is to
 * exist: it is how `GET /api/mcp/status` knows a client is attached. A
 * refusal is logged and dropped, because tool calls work without it.
 */
async function holdStream(): Promise<void> {
  while (!shuttingDown && sessionId) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'GET',
        headers: requestHeaders({ accept: 'text/event-stream' }),
        signal: streamAbort.signal,
      });
      if (!res.ok || !res.body) {
        log(`event stream refused (HTTP ${res.status}); the status light will stay dark`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const cut = buffer.lastIndexOf('\n');
        if (cut === -1) continue;
        for (const reply of sseMessages(buffer.slice(0, cut))) send(reply);
        buffer = buffer.slice(cut + 1);
      }
    } catch (err) {
      if (shuttingDown) return;
      log('event stream dropped:', reason(err));
    }
    if (shuttingDown) return;
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}

/**
 * `drain` is the difference between the two ways this ends. Losing stdin is
 * an orderly goodbye, so the queued calls are finished first (a client that
 * pipes a script in and closes the pipe still gets its answers). A signal is
 * not, so it takes the short path.
 */
async function shutdown(drain: boolean): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (drain) await queue.catch(() => undefined);
  streamAbort.abort();
  if (sessionId) {
    try {
      await fetch(ENDPOINT, { method: 'DELETE', headers: requestHeaders() });
    } catch {
      /* the server is already gone; there is nothing left to forget */
    }
  }
  process.exit(0);
}

function main(): void {
  let pending = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    pending += chunk;
    for (;;) {
      const nl = pending.indexOf('\n');
      if (nl === -1) break;
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        log('dropping an unparsable line from stdin');
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;

      const msg = parsed as Json;
      queue = queue
        .then(() => forward(msg))
        .catch((err: unknown) => {
          log('forward failed:', reason(err));
        });
    }
  });

  process.stdin.on('end', () => void shutdown(true));
  process.on('SIGINT', () => void shutdown(false));
  process.on('SIGTERM', () => void shutdown(false));

  log(`bridging stdio to ${ENDPOINT}${PASSWORD ? ' (password set)' : ''}`);
}

// Run only when launched directly, so the tests can import the parsers
// without the process latching onto stdin.
const entry = process.argv[1] ?? '';
if (/mcp-stdio\.(ts|js|mjs)$/.test(entry)) main();

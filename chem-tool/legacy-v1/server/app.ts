// The Hono application: static client from dist/, /api, /openapi.json and
// /mcp. Exported without listening so tests can call app.request().

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { DIST_DIR } from '../src/chem/paths.ts';
import { api } from './api.ts';
import { createMcpServer } from './mcp.ts';
import { openapiDocument } from './openapi.ts';

export const app = new Hono();

app.use('*', cors({ origin: '*', allowHeaders: ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'authorization'], exposeHeaders: ['mcp-session-id'] }));
app.use('/api/*', compress());

app.route('/api', api);

app.get('/openapi.json', (c) => c.json(openapiDocument()));

// One server and transport per request: the transport is stateless, so a
// client never needs a session id and any number of clients can talk at
// once. Building the server costs well under a millisecond.
app.all('/mcp', async (c) => {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    c.req.raw.signal.addEventListener('abort', () => void server.close().catch(() => {}));
  }
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

const fileCache = new Map<string, { body: Uint8Array<ArrayBuffer>; type: string }>();

/** Static files from dist/ (Vite output). Hashed assets are immutable. */
app.get('*', async (c) => {
  const url = new URL(c.req.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(DIST_DIR, rel));
  if (!file.startsWith(DIST_DIR)) return c.text('Not found', 404);
  const ext = path.extname(file).toLowerCase();
  const immutable = rel.startsWith('/assets/');
  try {
    let cached = immutable ? fileCache.get(file) : undefined;
    if (!cached) {
      const s = await stat(file);
      if (!s.isFile()) throw new Error('not a file');
      cached = { body: new Uint8Array(await readFile(file)), type: MIME[ext] ?? 'application/octet-stream' };
      if (immutable) fileCache.set(file, cached);
    }
    return new Response(cached.body, {
      headers: {
        'content-type': cached.type,
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    });
  } catch {
    if (rel === '/index.html') {
      return c.html(
        '<!doctype html><meta charset="utf-8"><title>Chemistry Tool</title><body style="font-family:system-ui;padding:2rem"><h1>Chemistry Tool</h1><p>The web client has not been built yet. Run <code>npm run build</code> in the project folder, then reload.</p><p>The API is up: try <a href="/api/molecule?q=water">/api/molecule?q=water</a> or <a href="/openapi.json">/openapi.json</a>.</p></body>',
        503,
      );
    }
    return c.text('Not found', 404);
  }
});

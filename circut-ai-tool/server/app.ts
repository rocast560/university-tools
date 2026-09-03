// The Hono application: /api, /openapi.json, /mcp (+ alias) and the built
// client from dist/. Exported without listening so tests use app.request().

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createApi } from './api.ts';
import { DIST_DIR } from './config.ts';
import { openapiDocument } from './openapi.ts';
import type { ProjectEvent, Service } from './service.ts';
import type { Events } from './watch.ts';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.map': 'application/json' };

export function createApp(deps: { service: Service; events: Events<ProjectEvent>; mcp: () => McpServer }): Hono {
  const app = new Hono();
  app.route('/api', createApi(deps.service, deps.events));
  app.get('/openapi.json', (c) => c.json(openapiDocument()));
  app.get('/api/health', (c) => c.json({ ok: true }));

  // CORS is scoped to the MCP endpoints only: they're meant to be reached by
  // external MCP clients (a tunneled ChatGPT/claude.ai client, etc.) via
  // server-to-server fetches. The /api/* REST routes read/write real
  // schematic files on disk and must stay same-origin (no CORS middleware),
  // since a browser page could otherwise use a normal cross-origin fetch to
  // read or destroy the user's files. See final-review Finding 1.
  const mcpCors = cors({ origin: '*', allowHeaders: ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'authorization'], exposeHeaders: ['mcp-session-id'] });
  app.use('/mcp', mcpCors);
  app.use('/mcp-server/mcp', mcpCors);

  const mcpHandler = async (c: { req: { raw: Request } }) => {
    const server = deps.mcp();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      c.req.raw.signal.addEventListener('abort', () => void server.close().catch(() => {}));
    }
  };
  app.all('/mcp', mcpHandler);
  app.all('/mcp-server/mcp', mcpHandler);

  const cache = new Map<string, { body: Uint8Array; type: string }>();
  app.get('*', async (c) => {
    let rel = decodeURIComponent(new URL(c.req.url).pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(DIST_DIR, rel));
    if (!file.startsWith(DIST_DIR)) return c.text('Not found', 404);
    const immutable = rel.startsWith('/assets/');
    try {
      let hit = immutable ? cache.get(file) : undefined;
      if (!hit) {
        if (!(await stat(file)).isFile()) throw new Error('not a file');
        hit = { body: new Uint8Array(await readFile(file)), type: MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' };
        if (immutable) cache.set(file, hit);
      }
      // node:fs always backs this with a real ArrayBuffer; TS's stricter
      // Uint8Array<ArrayBufferLike> vs <ArrayBuffer> split needs a nudge here.
      return new Response(hit.body as Uint8Array<ArrayBuffer>, { headers: { 'content-type': hit.type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' } });
    } catch {
      if (rel === '/index.html') return c.html('<!doctype html><meta charset="utf-8"><title>Circuit AI Tool</title><body style="font-family:system-ui;padding:2rem"><h1>Circuit AI Tool</h1><p>The web client is not built yet. Run <code>bun run build</code> in the project folder and reload.</p><p>The API is up: <a href="/api/projects">/api/projects</a>, <a href="/openapi.json">/openapi.json</a>, MCP at <code>/mcp</code>.</p></body>', 503);
      return c.text('Not found', 404);
    }
  });
  return app;
}

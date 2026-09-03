// Serves the built client. Hashed assets under /assets/ are immutable; everything else falls
// back to index.html so deep links work.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Hono } from 'hono';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain',
};

export function registerStatic(app: Hono, root: string): void {
  const base = path.resolve(root);
  app.get('/*', async (c) => {
    let p = decodeURIComponent(new URL(c.req.url).pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.resolve(base, '.' + p);
    if (!file.startsWith(base)) return c.text('Forbidden', 403);
    const ext = path.extname(file);
    try {
      const s = await stat(file);
      if (!s.isFile()) throw new Error('not a file');
      const body = await readFile(file);
      return new Response(new Uint8Array(body), {
        headers: {
          'content-type': MIME[ext] ?? 'application/octet-stream',
          'cache-control': p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        },
      });
    } catch {
      if (ext) return c.notFound();
      try {
        return c.html((await readFile(path.join(base, 'index.html'))).toString());
      } catch {
        return c.text('Client not built. Run: bun run build', 404);
      }
    }
  });
}

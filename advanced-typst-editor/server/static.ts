// ─────────────────────────────────────────────────────────────────────────
// Static hosting for the built client.
//
// Serves files out of `dist/`, preferring a precompressed `.gz` sibling
// when the client accepts gzip (the Dockerfile gzips the bundle and the
// 28 MB Typst compiler wasm at build time, so no CPU is spent compressing
// per request). Anything without an extension falls back to `index.html`
// so client-side routes survive a reload. Paths are resolved against the
// static root and checked to stay inside it.
// ─────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
};

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Vite writes hashed filenames under /assets, so those can be cached
 * forever. The compiler's default fonts under /fonts keep their upstream
 * names (see scripts/fetch-fonts.ts), so they get a long but finite life.
 */
function cacheControlFor(root: string, file: string): string {
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (rel === 'index.html') return 'no-cache';
  if (rel.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  if (rel.startsWith('fonts/')) return 'public, max-age=604800';
  return 'public, max-age=3600';
}

function fileResponse(root: string, file: string, acceptEncoding: string | null): Response {
  const ext = path.extname(file).toLowerCase();
  const headers: Record<string, string> = {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': cacheControlFor(root, file),
  };
  const gz = `${file}.gz`;
  const wantsGzip = /\bgzip\b/i.test(acceptEncoding ?? '');
  if (wantsGzip && isFile(gz)) {
    headers['content-encoding'] = 'gzip';
    headers['vary'] = 'Accept-Encoding';
    return new Response(fs.readFileSync(gz), { status: 200, headers });
  }
  return new Response(fs.readFileSync(file), { status: 200, headers });
}

/**
 * Resolve `pathname` inside `staticDir`. Returns null only when there is no
 * `index.html` at all (the client was never built), so the caller can
 * explain that rather than 404 every route.
 */
export function serveStatic(
  staticDir: string,
  pathname: string,
  acceptEncoding: string | null,
): Response | null {
  const root = path.resolve(staticDir);

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  // Normalize away `.`/`..` segments (anchored at the URL root so they can't
  // climb), then strip the leading separator so resolve() stays under root.
  const rel = path.normalize(decoded).replace(/^[/\\]+/, '');
  const file = path.resolve(root, rel);
  const inside = file === root || file.startsWith(root + path.sep);
  const ext = path.extname(file).toLowerCase();

  if (inside && ext) {
    if (isFile(file)) return fileResponse(root, file, acceptEncoding);
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }

  const index = path.join(root, 'index.html');
  if (!isFile(index)) return null;
  return fileResponse(root, index, acceptEncoding);
}

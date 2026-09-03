// ─────────────────────────────────────────────────────────────────────────
// Pure helpers for the asset routes: filename hygiene, MIME allow-lists,
// extension reconciliation, and validation of the framing JSON a client may
// PATCH onto an asset record.
//
// The server is deliberately dumb about *meaning*: it takes bytes, names
// them safely, and stores whatever crop/blur geometry the client sends, as
// long as the shapes are sane. All the interesting work (framing, blurring,
// compiling) happens in the browser.
// ─────────────────────────────────────────────────────────────────────────

import type { BlurRegion, BlurStyle, CropRect, TypstAssetKind } from '../src/types';
import { extensionForFormat, sniffImageFormat } from '../src/lib/image-format';

/**
 * 25 MB. Comfortably fits a 4K PNG screenshot or any real-world font file
 * while bounding what a single request can write to the volume.
 */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const FONT_MIME: Record<string, string> = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttc': 'font/collection',
};

export const ALLOWED_EXTENSIONS: Record<TypstAssetKind, string[]> = {
  image: Object.keys(IMAGE_MIME),
  font: Object.keys(FONT_MIME),
};

/** Extension (with the dot, lowercased) when it looks like one; else ''. */
export function extensionOf(name: string): string {
  return extOf(name);
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  const ext = name.slice(dot).toLowerCase();
  return /^\.[a-z0-9]+$/.test(ext) ? ext : '';
}

/** Stem rules shared by uploads and renames. */
export function sanitizeStem(stem: string): string {
  return stem.trim().replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[.]+/, '').slice(0, 80);
}

/**
 * Reduce an arbitrary client-supplied name to something safe to use both as
 * a path segment and as a Typst virtual-FS filename. Strips directories,
 * collapses anything outside [A-Za-z0-9._-] to '_', and guarantees a
 * non-empty result with the original extension preserved.
 *
 * Defence-in-depth only: the on-disk file is named by uuid, so even a
 * malicious name can't escape the data dir. The sanitized name matters
 * because it becomes the path the document references in `#image("...")`.
 */
export function sanitizeFilename(raw: string, fallbackExt = ''): string {
  const base = String(raw ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  const ext = extOf(base) || fallbackExt.toLowerCase();
  const stem = extOf(base) ? base.slice(0, base.length - extOf(base).length) : base;
  const safeStem = sanitizeStem(stem);
  const safeExt = ext.replace(/[^A-Za-z0-9.]/g, '');
  return (safeStem || 'asset') + safeExt;
}

/** MIME type for an upload, or null if the extension isn't allowed for `kind`. */
export function mimeFor(kind: TypstAssetKind, filename: string): string | null {
  const table = kind === 'font' ? FONT_MIME : IMAGE_MIME;
  return table[extOf(filename)] ?? null;
}

/**
 * Force an image's extension to match its actual contents.
 *
 * Typst chooses its decoder from the file extension, so a PNG that someone
 * saved as `screenshot.jpg` would fail to decode at upload. Correcting
 * the name at upload, before any document references it, means that
 * mismatch can never reach a document in the first place.
 */
export function reconcileImageName(
  filename: string,
  bytes: Uint8Array,
): { filename: string; mime: string | null; corrected: boolean } {
  const actual = sniffImageFormat(bytes);
  if (!actual) return { filename, mime: mimeFor('image', filename), corrected: false };

  const wantExt = extensionForFormat(actual);
  const currentExt = extOf(filename);
  const alreadyCorrect =
    currentExt === wantExt ||
    (actual === 'jpeg' && (currentExt === '.jpeg' || currentExt === '.jfif'));
  if (alreadyCorrect) return { filename, mime: mimeFor('image', filename), corrected: false };

  const stem = filename.slice(0, filename.length - currentExt.length) || 'image';
  return { filename: stem + wantExt, mime: IMAGE_MIME[wantExt] ?? null, corrected: true };
}

/**
 * Append `-2`, `-3`, ... until `filename` is free among `taken`
 * (case-insensitive, since the virtual FS path is what collides).
 */
export function uniqueFilename(taken: Iterable<string>, filename: string): string {
  const used = new Set<string>();
  for (const t of taken) used.add(t.toLowerCase());
  if (!used.has(filename.toLowerCase())) return filename;
  const ext = extOf(filename);
  const stem = ext ? filename.slice(0, filename.length - ext.length) : filename;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * A crop rect from client JSON. `null`/`undefined` mean "no crop" and map to
 * null; a malformed value yields `undefined` so the route can 400.
 *
 * The rect may extend outside the unit square (an image scaled smaller than
 * its figure box); only degenerate sizes are rejected.
 */
export function validateCrop(v: unknown): CropRect | null | undefined {
  if (v === null || v === undefined) return null;
  if (!v || typeof v !== 'object') return undefined;
  const { x, y, w, h } = v as Record<string, unknown>;
  if (!finite(x) || !finite(y) || !finite(w) || !finite(h)) return undefined;
  if (w <= 0 || h <= 0) return undefined;
  return { x, y, w, h };
}

const BLUR_STYLES: ReadonlySet<string> = new Set<BlurStyle>(['gaussian', 'pixelate']);
const EDGE_EPS = 1e-6;

/**
 * Blur regions from client JSON. Regions must sit inside the original image
 * (blurring pixels that don't exist is meaningless). An empty list maps to
 * null, matching "no blurs".
 */
export function validateBlurs(v: unknown): BlurRegion[] | null | undefined {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) return undefined;
  const out: BlurRegion[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') return undefined;
    const { x, y, w, h, style, strength } = item as Record<string, unknown>;
    if (!finite(x) || !finite(y) || !finite(w) || !finite(h)) return undefined;
    if (x < 0 || y < 0 || w <= 0 || h <= 0) return undefined;
    if (x + w > 1 + EDGE_EPS || y + h > 1 + EDGE_EPS) return undefined;
    const region: BlurRegion = { x, y, w, h };
    if (style !== undefined) {
      if (typeof style !== 'string' || !BLUR_STYLES.has(style)) return undefined;
      region.style = style as BlurStyle;
    }
    if (strength !== undefined) {
      if (!finite(strength) || strength <= 0) return undefined;
      region.strength = strength;
    }
    out.push(region);
  }
  return out.length > 0 ? out : null;
}

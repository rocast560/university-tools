// Rules for an uploaded sidebar logo, shared by the browser (to reject a bad
// file before sending it) and the server (which enforces them again). No DOM,
// no Node.

export const MAX_LOGO_BYTES = 512 * 1024;

/** Accepted content types and the extension each is stored under. */
export const LOGO_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/** A stored logo is only ever a plain generated name: no path, no upper case, one of four extensions. */
const LOGO_NAME = /^[a-z0-9-]+\.(png|jpe?g|webp|svg)$/;

export function isLogoName(v: unknown): v is string {
  return typeof v === 'string' && LOGO_NAME.test(v);
}

/** The reason a file cannot be a logo, or null when it can. `type` is the bare MIME type. */
export function logoTypeError(type: string, size: number): string | null {
  if (!(type in LOGO_TYPES)) return 'A logo must be a PNG, JPEG, WebP or SVG image.';
  if (size <= 0) return 'That image is empty.';
  if (size > MAX_LOGO_BYTES) return `A logo can be at most ${MAX_LOGO_BYTES / 1024} KB.`;
  return null;
}

export function logoContentType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1);
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'svg') return 'image/svg+xml';
  return `image/${ext}`;
}

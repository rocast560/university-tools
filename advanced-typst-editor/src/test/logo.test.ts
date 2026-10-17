import { describe, it, expect } from 'vitest';
import { LOGO_TYPES, MAX_LOGO_BYTES, isLogoName, logoContentType, logoTypeError } from '@/lib/logo';

describe('logo rules', () => {
  it('accepts exactly four image types', () => {
    expect(Object.keys(LOGO_TYPES).sort()).toEqual(['image/jpeg', 'image/png', 'image/svg+xml', 'image/webp']);
    for (const t of Object.keys(LOGO_TYPES)) expect(logoTypeError(t, 100)).toBeNull();
  });

  it('rejects other types and sizes over 512 KB with a message', () => {
    expect(MAX_LOGO_BYTES).toBe(512 * 1024);
    expect(logoTypeError('image/gif', 100)).toMatch(/PNG, JPEG, WebP or SVG/);
    expect(logoTypeError('text/html', 100)).toMatch(/PNG, JPEG, WebP or SVG/);
    expect(logoTypeError('image/png', MAX_LOGO_BYTES + 1)).toMatch(/512 KB/);
    expect(logoTypeError('image/png', MAX_LOGO_BYTES)).toBeNull();
    expect(logoTypeError('image/png', 0)).toMatch(/empty/);
  });

  it('only treats plain generated file names as safe', () => {
    for (const ok of ['ab12.png', 'ab-12.jpg', 'x.jpeg', 'x.webp', 'x.svg']) expect(isLogoName(ok)).toBe(true);
    for (const bad of ['../x.png', 'a/b.png', 'x.gif', 'X.png', 'x.png.exe', '', '.png', 'x.PNG']) expect(isLogoName(bad)).toBe(false);
    expect(isLogoName(42)).toBe(false);
    expect(isLogoName(null)).toBe(false);
  });

  it('maps a file name back to its content type', () => {
    expect(logoContentType('a.png')).toBe('image/png');
    expect(logoContentType('a.jpg')).toBe('image/jpeg');
    expect(logoContentType('a.jpeg')).toBe('image/jpeg');
    expect(logoContentType('a.webp')).toBe('image/webp');
    expect(logoContentType('a.svg')).toBe('image/svg+xml');
  });
});

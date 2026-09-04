import { describe, it, expect } from 'vitest';
import { assetPath } from '@/lib/typst-assets';

describe('assetPath', () => {
  it('is the id with a leading slash', () => {
    expect(assetPath({ id: 'assets/findings/login.png' })).toBe('/assets/findings/login.png');
    expect(assetPath({ id: 'fonts/Inter.ttf' })).toBe('/fonts/Inter.ttf');
  });
});

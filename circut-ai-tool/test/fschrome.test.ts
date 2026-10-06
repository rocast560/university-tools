import { describe, expect, test } from 'bun:test';
import { readChromeSize, toggleHidden } from '../client/fschrome.ts';

describe('full-screen controls size', () => {
  test('a stored size is kept; anything else opens compact', () => {
    expect(readChromeSize('full')).toBe('full');
    expect(readChromeSize('hidden')).toBe('hidden');
    expect(readChromeSize(null)).toBe('compact');
    expect(readChromeSize('huge')).toBe('compact');
  });

  test('H hides the controls and brings back the size they were hidden from', () => {
    expect(toggleHidden('full', 'compact')).toEqual({ size: 'hidden', before: 'full' });
    expect(toggleHidden('hidden', 'full')).toEqual({ size: 'full', before: 'full' });
    // Hidden with nothing to go back to opens compact.
    expect(toggleHidden('hidden', 'hidden')).toEqual({ size: 'compact', before: 'compact' });
  });
});

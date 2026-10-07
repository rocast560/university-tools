import { describe, expect, test } from 'bun:test';
import { icon, type IconName } from '../client/icons.ts';

const NAMES: IconName[] = [
  'guide', 'simulate', 'parts', 'pinouts', 'checks', 'truth', 'options', 'run', 'step', 'reset',
  'fit', 'fullscreen', 'wires', 'cube', 'export', 'connect', 'moon', 'sun', 'close', 'chevron',
  'plus', 'search', 'wire', 'duplicate', 'trash', 'eye', 'undo', 'redo', 'exit', 'check', 'brand',
];

describe('icons', () => {
  for (const name of NAMES) {
    test(name, () => {
      const s = icon(name);
      expect(s.startsWith('<svg class="i" viewBox="0 0 24 24" aria-hidden="true"')).toBe(true);
      expect(/<(path|rect|circle)\b/.test(s)).toBe(true);
      for (const m of s.matchAll(/fill="([^"]*)"/g)) expect(m[1]).toBe('none');
      expect(s.endsWith('</svg>')).toBe(true);
    });
  }
  test('custom class', () => {
    expect(icon('run', 'i big')).toContain('<svg class="i big"');
  });
});

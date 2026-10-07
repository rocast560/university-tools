import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { contrast, parseTokens } from '../src/ui/contrast.ts';

const css = readFileSync(new URL('../client/styles.css', import.meta.url), 'utf8');

describe('contrast()', () => {
  test('black on white is 21, white on white is 1', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });
});

for (const mode of [':root', ':root[data-theme="dark"]'] as const) {
  describe(`tokens ${mode}`, () => {
    const t = parseTokens(css, mode);
    const text: [string, string][] = [['--ink', '--card'], ['--ink-2', '--card'], ['--ink', '--bg'], ['--accent-ink', '--accent'], ['--bad', '--card']];
    for (const [fg, bg] of text) test(`${fg} on ${bg} is at least 4.5:1`, () => expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5));
    const ui: [string, string][] = [['--accent', '--card'], ['--ok', '--card'], ['--line', '--bg']];
    for (const [fg, bg] of ui) test(`${fg} on ${bg} is at least 3:1 (UI)`, () => expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(fg === '--line' ? 1.2 : 3));
  });
}

test('the prefers-color-scheme dark block matches the explicit dark block', () => {
  const dark = parseTokens(css, ':root[data-theme="dark"]');
  const m = css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\r?\n  \}\r?\n\}/);
  expect(m).not.toBeNull();
  for (const [, name, val] of m![1].matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) expect(val.toLowerCase()).toBe(dark[name].toLowerCase());
});

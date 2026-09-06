import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FONT_FILES } from '../../scripts/fonts';
import { DEFAULT_FONT_FILES, DEFAULT_FONT_URL_PREFIX } from '@/lib/typst-default-fonts';

describe('default fonts', () => {
  it('lists the 17 faces typst.ts installs and they are staged locally', () => {
    expect(FONT_FILES).toHaveLength(17);
    const dir = path.resolve(__dirname, '..', '..', 'public', 'fonts');
    for (const f of FONT_FILES) expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
  });

  it('shares one manifest between the staging script and the browser compiler', () => {
    expect([...DEFAULT_FONT_FILES]).toEqual([...FONT_FILES]);
    expect(DEFAULT_FONT_URL_PREFIX).toBe('/fonts/');
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fontFamily } from './fonts';
import { OLD } from './test-util';

describe('fontFamily', () => {
  it('reads the family from OTF and TTF name tables', () => {
    expect(fontFamily(fs.readFileSync(path.join(OLD, 'fonts', 'NewCM10-Regular.otf')))).toBe('NewComputerModern10');
    expect(fontFamily(fs.readFileSync(path.join(OLD, 'fonts', 'DejaVuSansMono.ttf')))).toBe('DejaVu Sans Mono');
    expect(fontFamily(fs.readFileSync(path.join(OLD, 'fonts', 'LibertinusSerif-Semibold.otf')))).toBe('Libertinus Serif');
  });
  it('returns null for garbage and truncated input', () => {
    expect(fontFamily(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(fontFamily(fs.readFileSync(path.join(OLD, 'fonts', 'DejaVuSansMono.ttf')).subarray(0, 64))).toBeNull();
  });
});

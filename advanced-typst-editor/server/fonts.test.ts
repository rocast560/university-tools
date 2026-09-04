import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fontFamily, fontFamilyViaTypst, familyOfAddedFace } from './fonts';
import { OLD, TYPST_CLI } from './test-util';

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

describe('familyOfAddedFace', () => {
  it('returns new family name when a family header is added', () => {
    const base = `Family X
- Style: Normal, Weight: 400
Family Y
- Style: Normal, Weight: 400`;
    const withFont = `Family X
- Style: Normal, Weight: 400
Family Y
- Style: Normal, Weight: 400
Family Z
- Style: Normal, Weight: 400`;
    expect(familyOfAddedFace(base, withFont)).toBe('Family Z');
  });

  it('returns existing family name when it gains an extra style line', () => {
    const base = `Family X
- Style: Normal, Weight: 400
Family Y
- Style: Normal, Weight: 400`;
    const withFont = `Family X
- Style: Normal, Weight: 400
Family Y
- Style: Normal, Weight: 400
- Style: Bold, Weight: 700`;
    expect(familyOfAddedFace(base, withFont)).toBe('Family Y');
  });

  it('returns null when listings are identical', () => {
    const listing = `Family X
- Style: Normal, Weight: 400
Family Y
- Style: Normal, Weight: 400`;
    expect(familyOfAddedFace(listing, listing)).toBeNull();
  });

  it('treats family absent from base as having 0 faces', () => {
    const base = `Family X
- Style: Normal, Weight: 400`;
    const withFont = `Family X
- Style: Normal, Weight: 400
Family Y
- Style: Normal, Weight: 400
- Style: Bold, Weight: 700`;
    expect(familyOfAddedFace(base, withFont)).toBe('Family Y');
  });

  it('ignores non-Style dash-prefixed lines', () => {
    const base = `Family X
- Style: Normal, Weight: 400
- note: something
Family Y
- Style: Normal, Weight: 400`;
    const withFont = `Family X
- Style: Normal, Weight: 400
- note: something
Family Y
- Style: Normal, Weight: 400
- Style: Bold, Weight: 700`;
    expect(familyOfAddedFace(base, withFont)).toBe('Family Y');
  });
});

describe.skipIf(!fs.existsSync(TYPST_CLI))('fontFamilyViaTypst', () => {
  it('extracts New Computer Modern from NewCM10-Regular.otf', async () => {
    const result = await fontFamilyViaTypst(TYPST_CLI, fs.readFileSync(path.join(OLD, 'fonts', 'NewCM10-Regular.otf')), '.otf');
    expect(result).toBe('New Computer Modern');
  });

  it('extracts Libertinus Serif from LibertinusSerif-Semibold.otf', async () => {
    const result = await fontFamilyViaTypst(TYPST_CLI, fs.readFileSync(path.join(OLD, 'fonts', 'LibertinusSerif-Semibold.otf')), '.otf');
    expect(result).toBe('Libertinus Serif');
  });

  it('extracts DejaVu Sans Mono from DejaVuSansMono.ttf', async () => {
    const result = await fontFamilyViaTypst(TYPST_CLI, fs.readFileSync(path.join(OLD, 'fonts', 'DejaVuSansMono.ttf')), '.ttf');
    expect(result).toBe('DejaVu Sans Mono');
  });

  it('returns null when cli is null', async () => {
    const result = await fontFamilyViaTypst(null, fs.readFileSync(path.join(OLD, 'fonts', 'DejaVuSansMono.ttf')), '.ttf');
    expect(result).toBeNull();
  });
});

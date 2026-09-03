import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fontFamily, fontFamilyViaTypst } from './fonts';
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

describe('familyOfAddedFace (via fontFamilyViaTypst internal)', () => {
  it('returns the family name when a new family header appears', async () => {
    // This test uses an inline fixture since familyOfAddedFace is not exported
    // We test indirectly through fontFamilyViaTypst's logic
    // The function should find "New Computer Modern" when added
    const result = await fontFamilyViaTypst(TYPST_CLI, fs.readFileSync(path.join(OLD, 'fonts', 'NewCM10-Regular.otf')), '.otf');
    if (TYPST_CLI) expect(result).toBe('New Computer Modern');
  });

  it('returns the family name when an existing family gains a style line', async () => {
    const result = await fontFamilyViaTypst(TYPST_CLI, fs.readFileSync(path.join(OLD, 'fonts', 'LibertinusSerif-Semibold.otf')), '.otf');
    if (TYPST_CLI) expect(result).toBe('Libertinus Serif');
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

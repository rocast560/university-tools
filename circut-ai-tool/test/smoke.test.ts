import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const FIXTURES = path.join(import.meta.dir, 'fixtures');
export const readFixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');

describe('fixtures', () => {
  test('PL1_1 schematic and netlist are present', () => {
    expect(readFixture('PL1_1.kicad_sch').startsWith('(kicad_sch')).toBe(true);
    expect(readFixture('PL1_1.net').startsWith('(export')).toBe(true);
  });
});

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { KICAD_SYMBOL_DIR } from '../server/config.ts';
import { createLibraryLookup, findLibraryFile, parseSymLibTable } from '../server/libraries.ts';
import { extractLibSymbol } from '../src/kicad/libsymbol.ts';
import { parseLibSymbol, pinsOfUnit, powerUnit } from '../src/kicad/schematic.ts';
import { parse, isList } from '../src/sexpr.ts';

const have = existsSync(path.join(KICAD_SYMBOL_DIR, 'Device.kicad_sym'));
const lib = (name: string) => readFileSync(path.join(KICAD_SYMBOL_DIR, `${name}.kicad_sym`), 'utf8');
const parseOne = (text: string) => {
  const root = parse(text).items[0];
  if (!isList(root)) throw new Error('expected list');
  return parseLibSymbol(root);
};

describe('extractLibSymbol', () => {
  test.skipIf(!have)('plain symbol keeps its pins and gets the nickname prefix', () => {
    const text = extractLibSymbol(lib('Device'), 'R', 'Device');
    expect(text.startsWith('(symbol "Device:R"')).toBe(true);
    const s = parseOne(text);
    expect(s.id).toBe('Device:R');
    expect(pinsOfUnit(s, 1).map((p) => p.number).sort()).toEqual(['1', '2']);
    expect(text).toContain('(symbol "R_0_1"');
  });

  test.skipIf(!have)('derived symbol is flattened: parent body, child properties, renamed sub-symbols', () => {
    const text = extractLibSymbol(lib('Transistor_BJT'), '2N3904', 'Transistor_BJT');
    expect(text).not.toContain('(extends');
    expect(text).toContain('(symbol "2N3904_1_1"');
    expect(text).not.toContain('"Q_NPN_EBC_');
    const s = parseOne(text);
    expect(s.id).toBe('Transistor_BJT:2N3904');
    expect(pinsOfUnit(s, 1).map((p) => `${p.number}${p.name}`).sort()).toEqual(['1E', '2B', '3C']);
    expect(text).toMatch(/\(property "Value" "2N3904"/);
  });

  test.skipIf(!have)('multi-unit and power symbols', () => {
    const s = parseOne(extractLibSymbol(lib('74xx'), '74LS00', '74xx'));
    expect(s.unitCount).toBe(5);
    expect(powerUnit(s)).toBe(5);
    const p = parseOne(extractLibSymbol(lib('power'), '+5V', 'power'));
    expect(p.power).toBe(true);
  });

  test.skipIf(!have)('missing names throw', () => {
    expect(() => extractLibSymbol(lib('Device'), 'NoSuchPart', 'Device')).toThrow(/NoSuchPart/);
  });
});

describe('library lookup', () => {
  test('parses sym-lib-table uris', () => {
    const table = '(sym_lib_table (version 7) (lib (name "74xx")(type "KiCad")(uri "${KICAD9_SYMBOL_DIR}/74xx.kicad_sym")(options "")(descr "")) (lib (name "mine")(type "KiCad")(uri "C:/libs/mine.kicad_sym")(options "")(descr "")))';
    const m = parseSymLibTable(table, 'C:/kicad/symbols');
    expect(m.get('74xx')).toBe('C:/kicad/symbols/74xx.kicad_sym');
    expect(m.get('mine')).toBe('C:/libs/mine.kicad_sym');
  });
  test.skipIf(!have)('finds a global library and reports unknown ones', async () => {
    const lookup = createLibraryLookup({ symbolDir: KICAD_SYMBOL_DIR });
    expect((await lookup.symbolText('Device:LED')).startsWith('(symbol "Device:LED"')).toBe(true);
    await expect(lookup.symbolText('Nope:X')).rejects.toThrow(/library "Nope"/);
    await expect(lookup.symbolText('Device')).rejects.toThrow(/lib_id/);
  });

  test('rejects a path-traversal nickname instead of resolving outside symbolDir', async () => {
    // Regression for final-review Finding 4: a lib_id nickname is
    // assistant/user-supplied (e.g. add_component's libId), and previously
    // flowed straight into path.join(symbolDir, `${nickname}.kicad_sym`)
    // with no validation, letting "../../..." escape symbolDir.
    await expect(findLibraryFile('../../../../Windows/System32/drivers/etc/hosts', { symbolDir: KICAD_SYMBOL_DIR })).rejects.toThrow(/valid library nickname/);
    const lookup = createLibraryLookup({ symbolDir: KICAD_SYMBOL_DIR });
    await expect(lookup.symbolText('../../../../Windows/System32/drivers/etc/hosts:Foo')).rejects.toThrow(/valid library nickname/);
    // Backslashes, "..", and bare colons in the nickname must all be rejected too.
    await expect(findLibraryFile('..\\..\\secrets', { symbolDir: KICAD_SYMBOL_DIR })).rejects.toThrow(/valid library nickname/);
  });
});

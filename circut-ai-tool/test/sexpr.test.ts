import { describe, expect, test } from 'bun:test';
import { atom, child, children, head, isList, num, parse, q, serialize } from '../src/sexpr.ts';
import { readFixture } from './smoke.test.ts';

describe('sexpr parse', () => {
  test('parses atoms, quoted strings with escapes and nested lists with spans', () => {
    const text = '(a 1 "two \\"2\\"" (b -3.5 c))';
    const root = parse(text);
    expect(root.items).toHaveLength(1);
    const a = root.items[0];
    if (!isList(a)) throw new Error('expected list');
    expect(head(a)).toBe('a');
    expect(num(a, 1)).toBe(1);
    expect(atom(a, 2)).toBe('two "2"');
    const b = child(a, 'b');
    expect(b && num(b, 1)).toBe(-3.5);
    expect(a.start).toBe(0);
    expect(a.end).toBe(text.length);
    expect(text.slice(b!.start, b!.end)).toBe('(b -3.5 c)');
  });

  test('children returns every list with the given head', () => {
    const root = parse('(x (pin 1) (pin 2) (name n))');
    const x = root.items[0] as ReturnType<typeof parse>;
    expect(children(x, 'pin')).toHaveLength(2);
  });

  test('rejects unbalanced input', () => {
    expect(() => parse('(a (b)')).toThrow();
    expect(() => parse('a)')).toThrow();
  });

  test('parses the PL1_1 schematic', () => {
    const root = parse(readFixture('PL1_1.kicad_sch'));
    const sch = root.items[0];
    if (!isList(sch)) throw new Error('expected list');
    expect(head(sch)).toBe('kicad_sch');
    expect(children(sch, 'symbol')).toHaveLength(35);
    expect(children(sch, 'wire')).toHaveLength(53);
  });
});

describe('sexpr serialize', () => {
  test('writes quoted strings, numbers and nested lists KiCad style', () => {
    const out = serialize(['symbol', ['lib_id', q('Device:R')], ['at', 10, 20.5, 0], ['property', q('Value'), q('10k "ohm"')]]);
    expect(out).toBe(
      '(symbol\n\t(lib_id "Device:R")\n\t(at 10 20.5 0)\n\t(property "Value" "10k \\"ohm\\"")\n)',
    );
  });

  test('round-trips through parse', () => {
    const text = serialize(['a', q('b c'), ['d', 1]]);
    const root = parse(text);
    expect(atom(root.items[0] as ReturnType<typeof parse>, 1)).toBe('b c');
  });
});

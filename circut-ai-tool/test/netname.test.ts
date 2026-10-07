import { expect, test } from 'bun:test';
import { shortNet } from '../src/ui/netname.ts';

const nets = ['+5V', 'GND', 'Net-(R7-Pad1)', 'Net-(U1-A1)', 'Net-(U1-A2)', '/A0', 'unconnected-(U1-Pad3)', 'Net-(C2-Pad2)', '/Net-(R9-Pad1)'];

test('short net names', () => {
  expect(shortNet('Net-(R7-Pad1)', nets)).toBe('R7');
  expect(shortNet('Net-(U1-A1)', nets)).toBe('U1-A1');
  expect(shortNet('+5V', nets)).toBe('+5V');
  expect(shortNet('/A0', nets)).toBe('A0');
});

test('unconnected and unmatched names are unchanged', () => {
  expect(shortNet('unconnected-(U1-Pad3)', nets)).toBe('unconnected-(U1-Pad3)');
  expect(shortNet('Net-(C2-Pad2)', nets)).toBe('C2');
  expect(shortNet('Net-(Q1)', nets)).toBe('Net-(Q1)');
  expect(shortNet('/Net-(R9-Pad1)', nets)).toBe('R9');
});

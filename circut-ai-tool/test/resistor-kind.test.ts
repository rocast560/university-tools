import { describe, expect, test } from 'bun:test';
import { normalizeSidecar } from '../src/layout/types.ts';

describe('resistor kind option', () => {
  test('defaults to carbon film and keeps metal film across the sidecar round trip', () => {
    expect(normalizeSidecar({ version: 1 }).options.resistorKind).toBe('carbon');
    expect(normalizeSidecar({ version: 1, options: { resistorKind: 'metal' } }).options.resistorKind).toBe('metal');
    expect(normalizeSidecar({ version: 1, options: { resistorKind: 'plastic' } }).options.resistorKind).toBe('carbon');
  });
});

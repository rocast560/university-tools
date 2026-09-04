import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '@/api/client';

/**
 * `keepalive` is what makes the pagehide save survive the tab closing, but the
 * browser caps a keepalive body at ~64 KiB and rejects anything larger outright
 * -- which would be worse than the plain fetch it replaced. A large document
 * therefore falls back to an ordinary request instead of failing to save.
 */

let inits: RequestInit[] = [];

beforeEach(() => {
  inits = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    inits.push(init!);
    return new Response(null, { status: 204 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('api.writeText keepalive', () => {
  it('does not ask for keepalive unless the caller does', async () => {
    await api.writeText('w1', 'main.typ', '= small');
    expect(inits[0]!.keepalive).toBe(false);
  });

  it('passes keepalive through for a small body', async () => {
    await api.writeText('w1', 'main.typ', '= small', true);
    expect(inits[0]!.keepalive).toBe(true);
  });

  it('drops keepalive for a body over the browser cap', async () => {
    await api.writeText('w1', 'main.typ', 'x'.repeat(60_001), true);
    expect(inits[0]!.keepalive).toBe(false);
  });

  it('measures encoded bytes, not characters', async () => {
    // 30_001 three-byte characters encode to 90_003 bytes, well over the cap,
    // even though the string is half the character length of the case above.
    await api.writeText('w1', 'main.typ', '一'.repeat(30_001), true);
    expect(inits[0]!.keepalive).toBe(false);
    await api.writeText('w1', 'main.typ', '一'.repeat(10), true);
    expect(inits[1]!.keepalive).toBe(true);
  });
});

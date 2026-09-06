import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DriverCommand, DriverRequest, DriverResponse } from '@/lib/typst-compiler-types';

/**
 * Stands in for the compiler Worker: records what the client posts and
 * answers through `handler`, asynchronously like a real worker would.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  static handler: (cmd: DriverCommand) => unknown = () => undefined;
  posted: DriverRequest[] = [];
  onmessage: ((e: { data: DriverResponse }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  constructor() { FakeWorker.instances.push(this); }
  postMessage(req: DriverRequest) {
    this.posted.push(req);
    void Promise.resolve().then(async () => {
      try {
        const value = await FakeWorker.handler(req);
        this.onmessage?.({ data: { id: req.id, ok: true, value } });
      } catch (err) {
        this.onmessage?.({ data: { id: req.id, ok: false, error: String(err) } });
      }
    });
  }
  terminate() { /* nothing to stop */ }
  crash(message: string) { this.onerror?.({ message }); }
}

const ops = (w: FakeWorker) => w.posted.map((p) => p.op);
// Memoized so `bytes(1)` called twice yields the *same* array instance: the
// client tracks font/shadow changes by reference, so re-passing "the same"
// bytes must compare equal the way a caller reusing its own buffer would.
const byteCache = new Map<number, Uint8Array>();
const bytes = (n: number) => byteCache.get(n) ?? (byteCache.set(n, new Uint8Array([n])), byteCache.get(n)!);

async function loadClient() {
  vi.resetModules();
  return import('@/lib/typst-compiler');
}

describe('typst compiler client', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    FakeWorker.handler = (cmd) => (cmd.op === 'svg' ? { svg: '<svg/>', diagnostics: [] } : undefined);
    vi.stubGlobal('Worker', FakeWorker);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('starts one worker lazily and compiles through it', async () => {
    const c = await loadClient();
    expect(FakeWorker.instances).toHaveLength(0);
    const res = await c.compileTypstSvg('= hi', {}, '/main.typ');
    expect(res).toEqual({ svg: '<svg/>', diagnostics: [] });
    expect(FakeWorker.instances).toHaveLength(1);
    const w = FakeWorker.instances[0]!;
    expect(ops(w)).toEqual(['svg']);
    expect(w.posted[0]).toMatchObject({ op: 'svg', source: '= hi', mainPath: '/main.typ' });
  });

  it('pushes fonts and shadow files only when they change, before the compile that needs them', async () => {
    const c = await loadClient();
    expect(c.setTypstFonts([bytes(1)])).toBe(true);
    expect(c.setTypstFonts([bytes(1)])).toBe(false); // same reference: no change
    expect(c.setTypstShadowFiles([{ path: '/a.png', bytes: bytes(2) }])).toBe(true);
    await c.compileTypstSvg('a');
    await c.compileTypstSvg('b');
    const w = FakeWorker.instances[0]!;
    expect(ops(w)).toEqual(['setFonts', 'setShadow', 'svg', 'svg']);
    expect(w.posted[0]).toMatchObject({ op: 'setFonts', fonts: [bytes(1)] });
    expect(w.posted[1]).toMatchObject({ op: 'setShadow', files: [{ path: '/a.png', bytes: bytes(2) }] });
  });

  it('skips a coalesced preview that was superseded before it started', async () => {
    const c = await loadClient();
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((r) => { releaseFirst = r; });
    let svgCalls = 0;
    FakeWorker.handler = async (cmd) => {
      if (cmd.op !== 'svg') return undefined;
      svgCalls++;
      if (svgCalls === 1) await firstDone;
      return { svg: `<svg data-src="${cmd.source}"/>`, diagnostics: [] };
    };
    const a = c.compileTypstSvg('a', { coalesce: true });
    const b = c.compileTypstSvg('b', { coalesce: true });
    const d = c.compileTypstSvg('c', { coalesce: true });
    releaseFirst();
    const [ra, rb, rc] = await Promise.all([a, b, d]);
    expect(ra.svg).toContain('a');
    expect(rb).toEqual({ diagnostics: [], superseded: true });
    expect(rc.svg).toContain('c');
    expect(ops(FakeWorker.instances[0]!)).toEqual(['svg', 'svg']); // 'b' never reached the worker
  });

  it('turns a PDF compile with errors into a readable rejection', async () => {
    const c = await loadClient();
    FakeWorker.handler = () => ({ diagnostics: [{ severity: 'error', message: 'unknown variable: x' }] });
    await expect(c.compileTypstPdf('#x')).rejects.toThrow('Typst error: unknown variable: x');
  });

  it('recovers from a crashed worker and re-sends its state to the replacement', async () => {
    const c = await loadClient();
    c.setTypstFonts([bytes(7)]);
    await c.compileTypstSvg('a');
    const first = FakeWorker.instances[0]!;
    // Hang the next compile, then crash the worker under it.
    FakeWorker.handler = () => new Promise(() => {});
    const hung = c.compileTypstSvg('b');
    first.crash('boom');
    await expect(hung).rejects.toThrow('boom');

    FakeWorker.handler = (cmd) => (cmd.op === 'svg' ? { svg: '<svg/>', diagnostics: [] } : undefined);
    await c.compileTypstSvg('c');
    expect(FakeWorker.instances).toHaveLength(2);
    const second = FakeWorker.instances[1]!;
    expect(ops(second)).toEqual(['setFonts', 'setShadow', 'svg']);
    expect(second.posted[0]).toMatchObject({ op: 'setFonts', fonts: [bytes(7)] });
  });

  it('reads font info through the worker', async () => {
    const c = await loadClient();
    FakeWorker.handler = (cmd) => (cmd.op === 'fontInfo' ? { family: 'Poppins' } : undefined);
    expect(await c.getFontInfo(bytes(3))).toEqual({ family: 'Poppins' });
  });
});

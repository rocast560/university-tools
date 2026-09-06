# Docker packaging, compiler worker, sidebar and settings polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Typst Studio as a Docker container on port 8090 with the data folder bind-mounted, make workspace switching sub-second by keeping one compiler alive (fonts swapped with `setFonts`) and moving compilation into a Web Worker, and polish the sidebar (collapsible groups, pinned status footer) and Settings ("Connect Claude" with copy buttons).

**Architecture:** The wasm-facing code moves into a single driver module that runs inside a module Worker (with an inline fallback when `Worker` is missing); `src/lib/typst-compiler.ts` keeps its public API and becomes a thin RPC client that serializes calls and pushes font/shadow state only when it changes. The server's registry self-heals library workspace paths by folder name so the same `data/` works under Windows and under `/data` in the container. Docker is a two-stage `oven/bun` build with the typst 0.14.2 CLI, gzip-precompressed assets and a health check.

**Tech Stack:** Bun 1.3, Vite 8, React 19, TypeScript, vitest (jsdom for UI, node for server), typst.ts 0.7 (`@myriaddreamin/typst.ts`), Docker Desktop 28 with Compose v2.

**Spec:** `advanced-typst-editor/docs/superpowers/specs/2026-09-05-docker-and-performance-design.md`

## Global Constraints

- All paths below are relative to `advanced-typst-editor/` unless they start with `../`. Run every command from that folder.
- Branch: `docker-perf` (already created from `main`). Commit after every task. No `Co-Authored-By` or "Generated with" footers in commit messages (user preference).
- Public API of `src/lib/typst-compiler.ts` must not change: `compileTypstSvg`, `compileTypstPdf`, `setTypstFonts`, `setTypstShadowFiles`, `getFontInfo`, `typstErrorMessage`, and the types `TypstShadowFile`, `TypstSvgResult`, `TypstDiagnostic`.
- Container: `HOST=0.0.0.0 PORT=8080 STATIC_DIR=/app/dist DATA_DIR=/data`, host port `127.0.0.1:8090`, typst CLI `0.14.2`, base images `oven/bun:1.3` (build) and `oven/bun:1.3-slim` (runtime), user `bun`.
- MCP endpoint string shown to users: `http://localhost:8090/mcp`. MCP server name: `typst-figure-studio`.
- Tests: `bun run test:ui` (jsdom project), `bun run test:server` (node project), `bun run typecheck`. All three must pass at the end of every task that touches code.
- Files in this repo are written with LF; git normalizes on commit (warnings about CRLF are expected and harmless).

---

### Task 1: Shared default-font manifest

The worker needs the list of the 17 default font files at runtime; today it lives in `scripts/fonts.ts`, which imports `node:fs` and cannot be loaded in a browser.

**Files:**
- Create: `src/lib/typst-default-fonts.ts`
- Modify: `scripts/fonts.ts` (replace the inline `FONT_FILES` array)
- Test: `src/test/fonts-manifest.test.ts`

**Interfaces:**
- Produces: `DEFAULT_FONT_FILES: readonly string[]` (17 names) and `DEFAULT_FONT_URL_PREFIX = '/fonts/'`, imported by Task 2's driver.

- [ ] **Step 1: Extend the manifest test**

Replace the whole of `src/test/fonts-manifest.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FONT_FILES } from '../../scripts/fonts';
import { DEFAULT_FONT_FILES, DEFAULT_FONT_URL_PREFIX } from '@/lib/typst-default-fonts';

describe('default fonts', () => {
  it('lists the 17 faces typst.ts installs and they are staged locally', () => {
    expect(FONT_FILES).toHaveLength(17);
    const dir = path.resolve(__dirname, '..', '..', 'public', 'fonts');
    for (const f of FONT_FILES) expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
  });

  it('shares one manifest between the staging script and the browser compiler', () => {
    expect([...DEFAULT_FONT_FILES]).toEqual([...FONT_FILES]);
    expect(DEFAULT_FONT_URL_PREFIX).toBe('/fonts/');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun run test:ui -- src/test/fonts-manifest.test.ts`
Expected: FAIL, cannot resolve `@/lib/typst-default-fonts`.

- [ ] **Step 3: Create the manifest module and point the script at it**

`src/lib/typst-default-fonts.ts`:

```ts
// ─────────────────────────────────────────────────────────────────────────
// The 17 faces typst.ts installs by default (its `text` asset family).
//
// scripts/fonts.ts stages them under public/fonts so the app never touches
// the CDN, and the compiler driver (lib/typst-compiler.driver.ts) fetches
// them from there. One list, so the two can never drift apart.
// ─────────────────────────────────────────────────────────────────────────

export const DEFAULT_FONT_FILES: readonly string[] = [
  'DejaVuSansMono-Bold.ttf', 'DejaVuSansMono-BoldOblique.ttf', 'DejaVuSansMono-Oblique.ttf', 'DejaVuSansMono.ttf',
  'LibertinusSerif-Bold.otf', 'LibertinusSerif-BoldItalic.otf', 'LibertinusSerif-Italic.otf', 'LibertinusSerif-Regular.otf',
  'LibertinusSerif-Semibold.otf', 'LibertinusSerif-SemiboldItalic.otf',
  'NewCM10-Bold.otf', 'NewCM10-BoldItalic.otf', 'NewCM10-Italic.otf', 'NewCM10-Regular.otf',
  'NewCMMath-Bold.otf', 'NewCMMath-Book.otf', 'NewCMMath-Regular.otf',
];

/** Where the app serves them (Vite copies public/fonts to dist/fonts). */
export const DEFAULT_FONT_URL_PREFIX = '/fonts/';
```

In `scripts/fonts.ts`, replace the `export const FONT_FILES = [ ... ];` block (lines 7 to 13) with:

```ts
import { DEFAULT_FONT_FILES } from '../src/lib/typst-default-fonts';

export const FONT_FILES = DEFAULT_FONT_FILES;
```

Keep the import block at the top of the file together (move the new import up next to the other imports).

- [ ] **Step 4: Run the test and the typecheck**

Run: `bun run test:ui -- src/test/fonts-manifest.test.ts && bun run typecheck`
Expected: 2 tests pass; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/typst-default-fonts.ts scripts/fonts.ts src/test/fonts-manifest.test.ts
git commit -m "refactor(fonts): share the default font manifest with the browser"
```

---

### Task 2: Shared types and the wasm driver module

Everything that touches typst.ts moves into one driver object. It is not unit-testable in jsdom (wasm + fetch); Task 4 verifies it in the browser. This task must still typecheck and keep the existing tests green.

**Files:**
- Create: `src/lib/typst-compiler-types.ts`
- Create: `src/lib/typst-compiler.driver.ts`

**Interfaces:**
- Produces (types): `TypstDiagnostic`, `TypstSvgResult`, `TypstShadowFile`, `TypstFontInfo`, `SvgOutput`, `PdfOutput`, `DriverCommand`, `DriverRequest`, `DriverResponse`.
- Produces: `createTypstDriver(): TypstDriver` with `setFonts(fonts: Uint8Array[]): Promise<void>`, `setShadow(files: TypstShadowFile[]): Promise<void>`, `svg(source: string, mainPath: string): Promise<SvgOutput>`, `pdf(source: string, mainPath: string): Promise<PdfOutput>`, `fontInfo(bytes: Uint8Array): Promise<TypstFontInfo | null>`; and `dispatch(driver: TypstDriver, cmd: DriverCommand): Promise<unknown>`.

- [ ] **Step 1: Write the types module**

`src/lib/typst-compiler-types.ts`:

```ts
// Types shared by the compiler client (main thread), the worker and the
// driver. Kept dependency-free so the client never pulls the wasm code in.

/** A single Typst diagnostic (error/warning) from the compiler. */
export interface TypstDiagnostic {
  severity: string; // 'error' | 'warning' | …
  message: string;
  range?: string;
  path?: string;
}

export interface TypstSvgResult {
  svg?: string;
  diagnostics: TypstDiagnostic[];
  /**
   * True when a newer preview compile was requested before this one reached
   * the front of the queue, so it returned without doing any work. Callers
   * should ignore the result entirely rather than treating the absent `svg`
   * as "the document produced nothing".
   */
  superseded?: boolean;
}

/** A file mounted into the compiler's in-memory filesystem. */
export interface TypstShadowFile {
  /** Absolute virtual path, e.g. `/assets/screenshot.png`. */
  path: string;
  bytes: Uint8Array;
}

export interface TypstFontInfo { family: string }

/** What the driver returns for a preview compile. */
export interface SvgOutput { svg?: string; diagnostics: TypstDiagnostic[] }
/** What the driver returns for a PDF compile. `pdf` is absent on errors. */
export interface PdfOutput { pdf?: Uint8Array; diagnostics: TypstDiagnostic[] }

/** One request to the driver, without the correlation id. */
export type DriverCommand =
  | { op: 'setFonts'; fonts: Uint8Array[] }
  | { op: 'setShadow'; files: TypstShadowFile[] }
  | { op: 'svg'; source: string; mainPath: string }
  | { op: 'pdf'; source: string; mainPath: string }
  | { op: 'fontInfo'; bytes: Uint8Array };

export type DriverRequest = DriverCommand & { id: number };

export type DriverResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };
```

- [ ] **Step 2: Write the driver**

`src/lib/typst-compiler.driver.ts`:

```ts
// ─────────────────────────────────────────────────────────────────────────
// The wasm-facing half of the local Typst compiler.
//
// Wraps @myriaddreamin/typst.ts so documents render fully offline. This
// module runs inside the compiler Web Worker (typst-compiler.worker.ts) and,
// when Workers are unavailable, inline on the main thread. Either way there
// is exactly one instance per page: the compiler and renderer are built
// once and live for the session.
//
// Fonts used to be supplied only at init, which forced a full rebuild of
// the 28 MB wasm module (plus re-parsing every default font) whenever a
// workspace with its own fonts was opened, and leaked the old instance.
// typst.ts can swap fonts on a live compiler through `setFonts`, so that is
// what `setFonts` below does: build a font resolver from the cached default
// faces plus the workspace's, install it, and drop the compiler's font cache.
// ─────────────────────────────────────────────────────────────────────────

// `?url` yields the asset URL (a string); Vite emits the wasm as a hashed file
// and serves it locally. typst.ts fetches it lazily via `getModule`.
import compilerWasmUrl from '@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm?url';
import rendererWasmUrl from '@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm?url';
import { DEFAULT_FONT_FILES, DEFAULT_FONT_URL_PREFIX } from './typst-default-fonts';
import type {
  DriverCommand, PdfOutput, SvgOutput, TypstDiagnostic, TypstFontInfo, TypstShadowFile,
} from './typst-compiler-types';

// typst.ts's `format` discriminator (see CompileFormatEnum).
const FORMAT_VECTOR = 0;
const FORMAT_PDF = 1;

// typst.ts has no exported types we depend on here; treat the instances as
// structurally `any` to avoid coupling to its (less-stable) public surface.
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyCompiler = any;
type AnyRenderer = any;

export interface TypstDriver {
  /** Replace the workspace fonts. The default faces are always included. */
  setFonts(fonts: Uint8Array[]): Promise<void>;
  /** Replace the files mounted into the compiler's virtual filesystem. */
  setShadow(files: TypstShadowFile[]): Promise<void>;
  svg(source: string, mainPath: string): Promise<SvgOutput>;
  pdf(source: string, mainPath: string): Promise<PdfOutput>;
  fontInfo(bytes: Uint8Array): Promise<TypstFontInfo | null>;
}

export function createTypstDriver(): TypstDriver {
  let defaultFonts: Promise<Uint8Array[]> | null = null;
  let instance: Promise<{ compiler: AnyCompiler; renderer: AnyRenderer }> | null = null;
  let customFonts: Uint8Array[] = [];
  let shadow: TypstShadowFile[] = [];
  let shadowApplied = false;

  /** The 17 default faces, fetched once from the app's own /fonts/ folder. */
  const loadDefaultFonts = (): Promise<Uint8Array[]> => {
    if (!defaultFonts) {
      defaultFonts = Promise.all(DEFAULT_FONT_FILES.map(async (name) => {
        const res = await fetch(DEFAULT_FONT_URL_PREFIX + name);
        if (!res.ok) throw new Error(`default font ${name}: HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      }));
      // Don't cache a failure: a transient blip must not break the session.
      defaultFonts.catch(() => { defaultFonts = null; });
    }
    return defaultFonts;
  };

  /** Build (once) the compiler + renderer with the fonts known at that moment. */
  const getInstance = () => {
    if (!instance) {
      instance = (async () => {
        const { createTypstCompiler, createTypstRenderer, loadFonts } = await import('@myriaddreamin/typst.ts');
        const fonts = await loadDefaultFonts();
        const compiler = createTypstCompiler();
        // `assets: false`: we hand over the default faces ourselves, so
        // typst.ts must not try to fetch its own copy from the CDN.
        await compiler.init({
          getModule: () => compilerWasmUrl,
          beforeBuild: [loadFonts([...fonts, ...customFonts] as unknown as Uint8Array[], { assets: false })],
        });
        const renderer = createTypstRenderer();
        await renderer.init({ getModule: () => rendererWasmUrl });
        shadowApplied = false;
        return { compiler, renderer };
      })();
      // If init throws (e.g. wasm failed to load), let the next call retry.
      instance.catch(() => { instance = null; });
    }
    return instance;
  };

  /** Push the current shadow set into the compiler if it's out of date. */
  const syncShadow = (compiler: AnyCompiler): void => {
    if (shadowApplied) return;
    // resetShadow clears every mapped file, so removals take effect too.
    compiler.resetShadow();
    for (const f of shadow) compiler.mapShadow(f.path, f.bytes);
    shadowApplied = true;
  };

  const compile = async (source: string, mainPath: string, format: number) => {
    const { compiler, renderer } = await getInstance();
    syncShadow(compiler);
    // Map the latest source, then reset + compile (matches typst.ts's own
    // ordering in TypstSnippet.vector()).
    compiler.addSource(mainPath, source);
    await compiler.reset();
    const res = await compiler.compile({ mainFilePath: mainPath, format, diagnostics: 'full' });
    const diagnostics: TypstDiagnostic[] = (res?.diagnostics ?? []) as TypstDiagnostic[];
    return { res, diagnostics, renderer };
  };

  return {
    async setFonts(fonts) {
      customFonts = fonts;
      // Not built yet: the fonts go in at init, nothing else to do.
      if (!instance) return;
      const { compiler } = await getInstance();
      const { createTypstFontBuilder } = await import('@myriaddreamin/typst.ts');
      const builder = createTypstFontBuilder();
      await builder.init({ getModule: () => compilerWasmUrl });
      for (const bytes of [...(await loadDefaultFonts()), ...fonts]) {
        try {
          await builder.addFontData(bytes);
        } catch (err) {
          // One unreadable upload must not take the whole set down.
          console.warn('[typst] skipping a font the compiler cannot parse', err);
        }
      }
      // `build` frees the resolver after the callback; the compiler keeps
      // its own reference (typst.ts: "multiple compilers can share fonts").
      await builder.build(async (resolver: unknown) => { compiler.setFonts(resolver); });
      // Drop the font cache so the new set is what the next compile sees.
      await compiler.reset();
    },

    async setShadow(files) {
      shadow = files;
      shadowApplied = false;
    },

    async svg(source, mainPath) {
      const { res, diagnostics, renderer } = await compile(source, mainPath, FORMAT_VECTOR);
      if (!res?.result) return { diagnostics };
      const svg: string = await renderer.runWithSession(async (session: unknown) => {
        renderer.manipulateData({ renderSession: session, action: 'reset', data: res.result });
        return renderer.renderSvg({ renderSession: session });
      });
      return { svg, diagnostics };
    },

    async pdf(source, mainPath) {
      const { res, diagnostics } = await compile(source, mainPath, FORMAT_PDF);
      if (!res?.result) return { diagnostics };
      return { pdf: res.result as Uint8Array, diagnostics };
    },

    async fontInfo(bytes) {
      const { createTypstFontBuilder } = await import('@myriaddreamin/typst.ts');
      const fb = createTypstFontBuilder();
      await fb.init({ getModule: () => compilerWasmUrl });
      const info: any = await fb.getFontInfo(bytes);
      if (!info) return null;
      // The wasm returns a struct whose family field has varied across
      // versions; accept the known spellings rather than pinning to one.
      const family = info.family ?? info.family_name ?? info.familyName ?? null;
      return family ? { family: String(family) } : null;
    },
  };
}

/** Route one command to the driver method it names. Shared by the worker and the inline fallback. */
export function dispatch(driver: TypstDriver, cmd: DriverCommand): Promise<unknown> {
  switch (cmd.op) {
    case 'setFonts': return driver.setFonts(cmd.fonts);
    case 'setShadow': return driver.setShadow(cmd.files);
    case 'svg': return driver.svg(cmd.source, cmd.mainPath);
    case 'pdf': return driver.pdf(cmd.source, cmd.mainPath);
    case 'fontInfo': return driver.fontInfo(cmd.bytes);
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: exit 0. (Nothing imports the new modules yet; the old `typst-compiler.ts` still works.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/typst-compiler-types.ts src/lib/typst-compiler.driver.ts
git commit -m "feat(compiler): extract the wasm driver with setFonts-based font swapping"
```

---

### Task 3: The worker and the RPC client behind the existing API

**Files:**
- Create: `src/lib/typst-compiler.worker.ts`
- Rewrite: `src/lib/typst-compiler.ts`
- Modify: `vite.config.ts` (add `worker: { format: 'es' }`)
- Test: `src/test/typst-compiler-client.test.ts`

**Interfaces:**
- Consumes: `createTypstDriver`, `dispatch` (Task 2), the types (Task 2).
- Produces: the unchanged public API (see Global Constraints). Tests get a fresh module per case with `vi.resetModules()`, so no reset hook is needed.

- [ ] **Step 1: Write the failing client test**

`src/test/typst-compiler-client.test.ts`:

```ts
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
const bytes = (n: number) => new Uint8Array([n]);

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
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun run test:ui -- src/test/typst-compiler-client.test.ts`
Expected: FAIL (the current module builds a real compiler; the first test times out or throws on `import('@myriaddreamin/typst.ts')`).

- [ ] **Step 3: Write the worker entry**

`src/lib/typst-compiler.worker.ts`:

```ts
// ─────────────────────────────────────────────────────────────────────────
// Compiler Web Worker: owns the one typst.ts driver for the page and answers
// the client's requests one at a time, in order. Keeping the wasm here means
// a compile never blocks typing on the main thread.
// ─────────────────────────────────────────────────────────────────────────

import { createTypstDriver, dispatch } from './typst-compiler.driver';
import type { DriverRequest, DriverResponse } from './typst-compiler-types';

interface WorkerScope {
  onmessage: ((e: MessageEvent<DriverRequest>) => void) | null;
  postMessage(msg: DriverResponse): void;
}

const scope = self as unknown as WorkerScope;
const driver = createTypstDriver();

// Requests are handled strictly in arrival order: the driver carries
// per-compilation state, and the client relies on `setFonts` landing before
// the compile it was sent for.
let chain: Promise<void> = Promise.resolve();

scope.onmessage = (e) => {
  const req = e.data;
  chain = chain.then(async () => {
    try {
      const value = await dispatch(driver, req);
      scope.postMessage({ id: req.id, ok: true, value });
    } catch (err) {
      scope.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
};
```

- [ ] **Step 4: Rewrite the client**

Replace the whole of `src/lib/typst-compiler.ts` with:

```ts
// ─────────────────────────────────────────────────────────────────────────
// Local (in-browser) Typst compiler: the main-thread client.
//
// The wasm lives in a Web Worker (typst-compiler.worker.ts, running
// typst-compiler.driver.ts). This module keeps the API the rest of the app
// has always used and turns each call into a request to the worker:
//
//  - calls are serialized, because the compiler carries per-compilation
//    state and interleaving two compiles would corrupt output;
//  - fonts and shadow files are pushed only when they change, right before
//    the compile that needs them, so a keystroke never re-sends an image;
//  - superseded previews are dropped before they cost a round trip.
//
// When `Worker` does not exist (jsdom, very old browsers) the driver runs
// inline on the main thread through the same code path.
// ─────────────────────────────────────────────────────────────────────────

import type {
  DriverCommand, DriverRequest, DriverResponse, PdfOutput, SvgOutput, TypstFontInfo, TypstShadowFile, TypstSvgResult,
} from './typst-compiler-types';
import type { TypstDriver } from './typst-compiler.driver';

export type { TypstDiagnostic, TypstShadowFile, TypstSvgResult } from './typst-compiler-types';

// Default virtual path for the document inside the compiler's in-memory FS.
// Callers pass their own when the file being edited isn't main.typ: every
// other .typ in the workspace is mounted as a shadow file, so any of them can
// be compiled as the main one.
const MAIN_PATH = '/main.typ';

// ── transport ────────────────────────────────────────────────────────────

interface Transport {
  /** Bumps every time a fresh worker replaces a crashed one. */
  generation: number;
  call<T>(cmd: DriverCommand): Promise<T>;
}

function createWorkerTransport(): Transport {
  let worker: Worker | null = null;
  let started = false;
  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const transport: Transport = {
    generation: 0,
    call<T>(cmd: DriverCommand): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const w = worker ?? spawn();
        const id = ++seq;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        w.postMessage({ id, ...cmd } satisfies DriverRequest);
      });
    },
  };

  const spawn = (): Worker => {
    // A replacement worker starts with empty state; the generation bump
    // tells the client to push fonts and shadow files again.
    if (started) transport.generation++;
    started = true;
    const w = new Worker(new URL('./typst-compiler.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<DriverResponse>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.value);
      else p.reject(new Error(e.data.error));
    };
    w.onerror = (e) => {
      const err = new Error(e.message || 'Typst worker crashed');
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      w.terminate();
      if (worker === w) worker = null;
    };
    worker = w;
    return w;
  };

  return transport;
}

function createInlineTransport(): Transport {
  let driver: Promise<TypstDriver> | null = null;
  return {
    generation: 0,
    async call<T>(cmd: DriverCommand): Promise<T> {
      driver ??= import('./typst-compiler.driver').then((m) => m.createTypstDriver());
      const { dispatch } = await import('./typst-compiler.driver');
      return dispatch(await driver, cmd) as Promise<T>;
    },
  };
}

let transport: Transport | null = null;
function getTransport(): Transport {
  return (transport ??= typeof Worker === 'undefined' ? createInlineTransport() : createWorkerTransport());
}

// ── mutable inputs ───────────────────────────────────────────────────────
// Custom fonts and shadow files are set by the Typst tab (see
// components/typst/TypstView.tsx) whenever the workspace's assets change.

let customFonts: Uint8Array[] = [];
let fontGeneration = 0;
let sentFontGeneration = 0;

let shadowFiles: TypstShadowFile[] = [];
let shadowGeneration = 0;
let sentShadowGeneration = 0;

let sentOnTransport = 0;

/** Push fonts / shadow files if the worker doesn't have the current set. Runs inside the queue. */
async function syncState(t: Transport): Promise<void> {
  if (sentOnTransport !== t.generation) {
    sentOnTransport = t.generation;
    sentFontGeneration = -1;
    sentShadowGeneration = -1;
  }
  if (sentFontGeneration !== fontGeneration) {
    await t.call({ op: 'setFonts', fonts: customFonts });
    sentFontGeneration = fontGeneration;
  }
  if (sentShadowGeneration !== shadowGeneration) {
    await t.call({ op: 'setShadow', files: shadowFiles });
    sentShadowGeneration = shadowGeneration;
  }
}

/**
 * Replace the set of files mounted into the compiler's virtual filesystem.
 *
 * Callers pass the *final* bytes: an image with a crop rect has already
 * been cropped by `lib/typst-assets.ts`, so from Typst's point of view the
 * file simply is the cropped image.
 *
 * Cheap to call repeatedly: the bytes only travel to the worker when the set
 * actually changes, not on every keystroke-triggered recompile.
 *
 * Returns true if the set actually changed, so callers can skip forcing a
 * re-render when nothing did.
 */
export function setTypstShadowFiles(files: TypstShadowFile[]): boolean {
  const changed =
    files.length !== shadowFiles.length ||
    files.some((f, i) => {
      const prev = shadowFiles[i];
      return !prev || f.path !== prev.path || f.bytes !== prev.bytes;
    });
  if (!changed) return false;
  shadowFiles = files;
  shadowGeneration++;
  return true;
}

/**
 * Replace the set of custom fonts available to the compiler.
 *
 * The default faces are always present; these are added on top. The worker
 * installs them with typst.ts's `setFonts`, so a change costs one font
 * resolver build (a few hundred ms), not a compiler rebuild.
 *
 * Returns true if the set actually changed.
 */
export function setTypstFonts(fonts: Uint8Array[]): boolean {
  const changed =
    fonts.length !== customFonts.length || fonts.some((f, i) => f !== customFonts[i]);
  if (!changed) return false;
  customFonts = fonts;
  fontGeneration++;
  return true;
}

// Serialize all compiler access: the compiler holds state across calls.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  // Keep the chain alive even if a task rejects.
  queue = run.then(() => undefined, () => undefined);
  return run;
}

// Monotonic id for preview compiles, used to drop superseded ones before they
// do any work. Export compiles (PDF/SVG download) deliberately don't
// participate: an explicit export must always run.
let svgRequestSeq = 0;

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/**
 * Read a font file's metadata (family name, style, …) using typst.ts's own
 * parser, so the family name we show the operator is the one the compiler
 * will actually match in `#set text(font: "…")`.
 */
export function getFontInfo(bytes: Uint8Array): Promise<TypstFontInfo | null> {
  return enqueue(() => getTransport().call<TypstFontInfo | null>({ op: 'fontInfo', bytes }));
}

/**
 * Compile Typst source to an SVG string, fully locally.
 *
 * Returns the rendered SVG plus any diagnostics. On a compile error there is
 * no SVG and `diagnostics` carries the errors (with source ranges). The
 * promise rejects only on an unexpected/internal failure (e.g. the wasm
 * couldn't be loaded at all).
 *
 * `mainPath` is where `source` is mounted and which file the compiler is
 * pointed at, so a document that `#include`s its neighbours resolves them
 * relative to the right place.
 */
export function compileTypstSvg(
  source: string,
  opts: { coalesce?: boolean } = {},
  mainPath: string = MAIN_PATH,
): Promise<TypstSvgResult> {
  // Coalesce superseded previews. The preview already debounces typing, but a
  // document that takes longer to compile than the debounce window will still
  // queue up compiles whose output is discarded the moment they finish. Since
  // only the newest preview can ever be shown, an older one that hasn't
  // started yet should cost nothing rather than a full round trip.
  //
  // Opt-in, because an *export* must never be skipped: it isn't superseded by
  // a preview that happens to be requested while it waits in the queue.
  const seq = opts.coalesce ? ++svgRequestSeq : -1;
  return enqueue(async () => {
    if (seq !== -1 && seq !== svgRequestSeq) return { diagnostics: [], superseded: true };
    const t = getTransport();
    await syncState(t);
    return t.call<SvgOutput>({ op: 'svg', source, mainPath });
  });
}

/**
 * Compile Typst source to PDF bytes, fully locally. Throws (rejects) with a
 * readable message if the document has compile errors.
 *
 * Compiles the same `mainPath` as the preview so relative paths (notably
 * `#image("/assets/…")`) resolve identically in both.
 */
export function compileTypstPdf(source: string, mainPath: string = MAIN_PATH): Promise<Uint8Array> {
  return enqueue(async () => {
    const t = getTransport();
    await syncState(t);
    const res = await t.call<PdfOutput>({ op: 'pdf', source, mainPath });
    if (!res.pdf) {
      const first = res.diagnostics.find((d) => d.severity === 'error');
      throw new Error(
        first
          ? `Typst error: ${first.message}`
          : 'Typst document has errors: fix them before exporting a PDF.',
      );
    }
    return res.pdf;
  });
}

/** Re-export so callers can resolve the message of a thrown error uniformly. */
export { toMessage as typstErrorMessage };
```

- [ ] **Step 5: Tell Vite to emit an ES-module worker**

In `vite.config.ts`, add a `worker` entry to the `defineConfig({...})` object, after `optimizeDeps`:

```ts
  // The compiler worker uses dynamic imports (typst.ts loads its wasm shims
  // lazily); Vite's default iife worker format cannot code-split.
  worker: { format: 'es' },
```

- [ ] **Step 6: Run the client test, the whole UI suite and the typecheck**

Run: `bun run test:ui -- src/test/typst-compiler-client.test.ts`
Expected: 6 tests pass.

Run: `bun run test:ui && bun run typecheck`
Expected: every UI test passes (the preview tests mock this module and are unaffected); typecheck exits 0.

If the typecheck complains that `self` is not assignable in the worker file, keep the `as unknown as WorkerScope` cast; do not add `/// <reference lib="webworker" />` (it conflicts with the DOM lib the app needs).

- [ ] **Step 7: Build for production to prove the worker bundles**

Run: `bun run build`
Expected: `✓ built`, and `dist/assets/` now contains a `typst-compiler.worker-*.js` chunk next to the two wasm files. If Vite reports `UMD and IIFE output formats are not supported for code-splitting builds`, the `worker.format` setting from Step 5 is missing.

- [ ] **Step 8: Commit**

```bash
git add src/lib/typst-compiler.ts src/lib/typst-compiler.worker.ts vite.config.ts src/test/typst-compiler-client.test.ts
git commit -m "perf(compiler): run typst.ts in a Web Worker behind the existing API"
```

---

### Task 4: Verify switching and typing in the real browser

No code. This task produces the numbers that prove Tasks 2 and 3 did their job. Do it before moving on so a regression is caught while the change is small.

**Files:** none.

- [ ] **Step 1: Start the dev servers (if not already running)**

Run in two terminals from `advanced-typst-editor/`:

```bash
bun --watch server/index.ts
bun run dev
```

Expected: backend on `http://127.0.0.1:8090`, Vite on `http://127.0.0.1:5173`.

- [ ] **Step 2: Load the app and confirm the worker exists**

Open `http://127.0.0.1:5173/` in Chrome, open DevTools → Sources → Threads (or Application → Workers).
Expected: a worker whose script path contains `typst-compiler.worker`, and the preview renders the active workspace.

- [ ] **Step 3: Measure switching**

In the DevTools console, run (workspace ids come from `GET /api/workspaces`; these are the two used in the spec):

```js
const store = await import('/src/stores/index.ts');
const st = () => store.useAppStore.getState();
const CPTC = 'd205db10-f0aa-468a-b665-d1d039b3ae9b', CCDC = '2cb2e0ad-d6f9-4986-9ff2-b18744ceea31';
const ready = async (pages) => { for (let i = 0; i < 150; i++) { await new Promise(r => setTimeout(r, 50)); if (document.querySelectorAll('[data-page-index]').length === pages && !/Rendering/.test(document.querySelector('[data-page-index]')?.closest('.overflow-auto')?.parentElement?.textContent ?? '')) return true; } return false; };
const go = async (id, pages) => { performance.clearResourceTimings(); const t = performance.now(); await st().selectWorkspace(id); const ok = await ready(pages); const fonts = performance.getEntriesByType('resource').filter(e => e.name.includes('/fonts/')).length; return { ms: Math.round(performance.now() - t), ok, defaultFontFetches: fonts }; };
console.table({ toCcdc: await go(CCDC, 2), toCptc: await go(CPTC, 23), toCcdcAgain: await go(CCDC, 2), toCptcAgain: await go(CPTC, 23) });
```

Expected: every row `ok: true`, `ms` under 500 (was 2000 to 2700), and `defaultFontFetches` is 0 on every switch after the first page load (the worker fetched the 17 faces once).

- [ ] **Step 4: Measure typing with the 23-page report open**

With cptc-report active, run in the console:

```js
window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] });
```

Then click into the editor and type a sentence, pausing between words so several recompiles happen. After 10 seconds run `window.__lt`.
Expected: an empty array, or only entries under 100 ms. The compile itself no longer appears as a main-thread long task.

- [ ] **Step 5: Check the two paths that also go through the worker**

- Click the `PDF` button in the header. Expected: a PDF downloads.
- In the Assets rail, the font cards for cptc-report still read "Poppins" (font family detection goes through `getFontInfo` in the worker).

- [ ] **Step 6: Record the numbers**

Append the measured table (before/after) to the spec's section 2 as a short "Measured after" paragraph, and commit:

```bash
git add docs/superpowers/specs/2026-09-05-docker-and-performance-design.md
git commit -m "docs: record switching and typing measurements after the worker change"
```

---

### Task 5: Registry self-heal for moved library workspaces

**Files:**
- Modify: `server/settings.ts` (`scanLibrary`, around line 97)
- Test: `server/settings.test.ts`

**Interfaces:**
- Produces: `scanLibrary(workspacesDir)` keeps its signature; it now re-points or merges stale library entries before scanning.

- [ ] **Step 1: Write the failing tests**

Add to `server/settings.test.ts`, inside `describe('settings store', ...)` after the existing "scans the library for unknown folders" test:

```ts
  it('re-points a library workspace whose folder moved with the data dir, keeping its id and group', () => {
    const d = tmpDir(); dirs.push(d);
    const lib = path.join(d, 'workspaces');
    fs.mkdirSync(path.join(lib, 'report'), { recursive: true });
    const s = createSettingsStore(d);
    const stale = s.addWorkspace({ path: path.join(d, 'gone', 'workspaces', 'report'), name: 'report', group: 'CPTC', library: true });

    expect(s.scanLibrary(lib)).toEqual([]); // the folder is claimed by the healed entry, nothing new
    const list = s.listWorkspaces();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: stale.id, name: 'report', group: 'CPTC', path: path.resolve(lib, 'report') });
  });

  it('folds a stale duplicate into the entry that owns the folder and passes on its group', () => {
    const d = tmpDir(); dirs.push(d);
    const lib = path.join(d, 'workspaces');
    fs.mkdirSync(path.join(lib, 'report'), { recursive: true });
    const s = createSettingsStore(d);
    const live = s.addWorkspace({ path: path.join(lib, 'report'), name: 'report', group: null, library: true });
    s.addWorkspace({ path: path.join(d, 'gone', 'workspaces', 'report'), name: 'report', group: 'CPTC', library: true });

    s.scanLibrary(lib);
    const list = s.listWorkspaces();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: live.id, group: 'CPTC', path: path.resolve(lib, 'report') });
  });

  it('never re-points an external workspace, even when a library folder shares its name', () => {
    const d = tmpDir(); dirs.push(d);
    const lib = path.join(d, 'workspaces');
    fs.mkdirSync(path.join(lib, 'report'), { recursive: true });
    const s = createSettingsStore(d);
    const external = s.addWorkspace({ path: path.join(d, 'elsewhere', 'report'), name: 'report', group: null, library: false });

    const added = s.scanLibrary(lib);
    expect(added).toHaveLength(1); // the library folder is registered on its own
    expect(s.getWorkspace(external.id)?.path).toBe(path.resolve(d, 'elsewhere', 'report'));
  });
```

`fs` and `path` are already imported at the top of that test file (check lines 1 to 5; add `import fs from 'node:fs'; import path from 'node:path';` if either is missing).

- [ ] **Step 2: Run them to see them fail**

Run: `bun run test:server -- server/settings.test.ts`
Expected: the first two new tests FAIL (two entries instead of one, or the stale path unchanged); the third passes already.

- [ ] **Step 3: Implement the self-heal**

In `server/settings.ts`, replace the `scanLibrary(workspacesDir) { ... }` method with:

```ts
    scanLibrary(workspacesDir) {
      if (!isDir(workspacesDir)) return [];
      // Self-heal first. A library workspace lives at <workspacesDir>/<name>;
      // when the recorded folder is gone but that path exists, the data
      // folder moved (another machine, a container mount) and the entry
      // should follow it. If another entry already owns the folder, fold the
      // stale one into it, keeping the group the user had set.
      update((s) => {
        const workspaces = [...s.workspaces];
        for (let i = workspaces.length - 1; i >= 0; i--) {
          const w = workspaces[i]!;
          if (!w.library || isDir(w.path)) continue;
          const home = path.resolve(workspacesDir, w.name);
          if (!isDir(home)) continue;
          const ownerIndex = workspaces.findIndex((o) => o !== w && samePath(o.path, home));
          if (ownerIndex === -1) {
            workspaces[i] = { ...w, path: home };
          } else {
            const owner = workspaces[ownerIndex]!;
            if (owner.group === null && w.group !== null) workspaces[ownerIndex] = { ...owner, group: w.group };
            workspaces.splice(i, 1);
          }
        }
        return { ...s, workspaces };
      });
      const known = get().workspaces;
      const added: WorkspaceEntry[] = [];
      for (const entry of fs.readdirSync(workspacesDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('restored-')) continue;
        const abs = path.join(workspacesDir, entry.name);
        if (known.some((w) => samePath(w.path, abs))) continue;
        added.push(store.addWorkspace({ path: abs, name: entry.name, group: null, library: true }));
      }
      return added;
    },
```

- [ ] **Step 4: Run the server suite and typecheck**

Run: `bun run test:server && bun run typecheck`
Expected: all server tests pass (including the three new ones); typecheck exits 0.

- [ ] **Step 5: Confirm it heals the real registry**

With the backend running (`bun --watch server/index.ts` restarts on save), run:

```bash
curl -s http://127.0.0.1:8090/api/workspaces | python -c "import sys,json; [print(w['status'], w['group'], w['name']) for w in json.load(sys.stdin)['workspaces']]"
```

Expected: six lines, all `ok`, each name once, with `CPTC` on the four CPTC workspaces and `ECE-2300L` on the two lab ones (the stale `.worktrees` entries are gone). Refresh the browser: the sidebar shows each workspace once, under its group.

- [ ] **Step 6: Commit**

```bash
git add server/settings.ts server/settings.test.ts
git commit -m "fix(server): re-point library workspaces by name when the data folder moves"
```

---

### Task 6: `stdioBridge` in the MCP status

**Files:**
- Modify: `src/types.ts` (line 97, `McpStatus`)
- Modify: `server/mcp.ts` (add `resolveStdioBridge`, include it in `status()`)
- Modify: `src/stores/index.ts` (line 123, the `mcp.clients` event keeps the new field)
- Test: `server/stdio-bridge.test.ts`

**Interfaces:**
- Produces: `McpStatus.stdioBridge: string | null`; `resolveStdioBridge(serverDir: string, opts?: { inContainer: boolean }): string | null`.

- [ ] **Step 1: Write the failing test**

`server/stdio-bridge.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveStdioBridge } from './mcp';
import { tmpDir, rmDir } from './test-util';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmDir(d); });

describe('resolveStdioBridge', () => {
  it('returns the absolute path of mcp-stdio.ts next to the running server', () => {
    const d = tmpDir(); dirs.push(d);
    fs.writeFileSync(path.join(d, 'mcp-stdio.ts'), '// bridge');
    expect(resolveStdioBridge(d, { inContainer: false })).toBe(path.join(d, 'mcp-stdio.ts'));
  });

  it('returns null when the bridge script is not on disk (compiled sidecar)', () => {
    const d = tmpDir(); dirs.push(d);
    expect(resolveStdioBridge(d, { inContainer: false })).toBeNull();
  });

  it('returns null inside a container: the path would be meaningless on the host', () => {
    const d = tmpDir(); dirs.push(d);
    fs.writeFileSync(path.join(d, 'mcp-stdio.ts'), '// bridge');
    expect(resolveStdioBridge(d, { inContainer: true })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun run test:server -- server/stdio-bridge.test.ts`
Expected: FAIL, `resolveStdioBridge` is not exported.

- [ ] **Step 3: Implement**

`src/types.ts` line 97 becomes:

```ts
export interface McpStatus {
  endpoint: string;
  authRequired: boolean;
  clients: McpClientStatus[];
  /** Absolute path of server/mcp-stdio.ts for Claude Desktop, or null when it is not reachable from the host (container, compiled sidecar). */
  stdioBridge: string | null;
}
```

In `server/mcp.ts`, add to the imports at the top:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
```

Add after `const SESSION_TTL_MS = ...;`:

```ts
/**
 * Where Claude Desktop should point its stdio bridge. Only meaningful when
 * the script exists on the same machine as the client: null inside a
 * container (the path would be the container's) and in the compiled sidecar
 * (the script is not shipped).
 */
export function resolveStdioBridge(
  serverDir: string,
  opts: { inContainer: boolean } = { inContainer: fs.existsSync('/.dockerenv') },
): string | null {
  if (opts.inContainer) return null;
  const script = path.join(serverDir, 'mcp-stdio.ts');
  return fs.existsSync(script) ? script : null;
}
```

Inside `createMcp`, right after `const sessions = new Map<string, Session>();`, add:

```ts
  const stdioBridge = resolveStdioBridge(path.dirname(fileURLToPath(import.meta.url)));
```

and change the `return` of `status()` to:

```ts
    return { endpoint: '/mcp', authRequired: !!deps.token, clients: [...byName.values()], stdioBridge };
```

In `src/stores/index.ts` line 123, the `mcp.clients` case becomes:

```ts
        case 'mcp.clients': set((s) => ({ mcp: { endpoint: s.mcp?.endpoint ?? '/mcp', authRequired: s.mcp?.authRequired ?? false, stdioBridge: s.mcp?.stdioBridge ?? null, clients: ev.clients } })); break;
```

- [ ] **Step 4: Run both suites and the typecheck**

Run: `bun run test:server && bun run test:ui && bun run typecheck`
Expected: all pass. If a UI test constructs an `McpStatus` literal without `stdioBridge`, add `stdioBridge: null` to that literal.

- [ ] **Step 5: Check the live value**

Run: `curl -s http://127.0.0.1:8090/api/mcp/status`
Expected: JSON containing `"stdioBridge":"C:\\Users\\rober\\Desktop\\university-tools\\advanced-typst-editor\\server\\mcp-stdio.ts"`.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts server/mcp.ts server/stdio-bridge.test.ts src/stores/index.ts
git commit -m "feat(mcp): report the stdio bridge path in the MCP status"
```

---

### Task 7: Collapsible sidebar groups and the pinned status footer

**Files:**
- Create: `src/lib/collapsed-groups.ts`
- Modify: `src/components/sidebar/Sidebar.tsx`
- Test: `src/test/collapsed-groups.test.ts`, `src/test/sidebar.test.tsx`

**Interfaces:**
- Produces: `loadCollapsedGroups(storage?: Storage | null): Set<string>`, `saveCollapsedGroups(set: Set<string>, storage?: Storage | null): void`, `toggleGroup(set: Set<string>, group: string): Set<string>`, `COLLAPSED_GROUPS_KEY = 'tfs-collapsed-groups'`.

- [ ] **Step 1: Write the failing tests**

`src/test/collapsed-groups.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { loadCollapsedGroups, saveCollapsedGroups, toggleGroup, COLLAPSED_GROUPS_KEY } from '@/lib/collapsed-groups';

describe('collapsed groups', () => {
  beforeEach(() => localStorage.clear());

  it('starts empty and round-trips through localStorage', () => {
    expect(loadCollapsedGroups()).toEqual(new Set());
    saveCollapsedGroups(new Set(['CPTC', 'ECE-2300L']));
    expect(JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY)!)).toEqual(['CPTC', 'ECE-2300L']);
    expect(loadCollapsedGroups()).toEqual(new Set(['CPTC', 'ECE-2300L']));
  });

  it('toggles without mutating the input', () => {
    const a = new Set(['CPTC']);
    const b = toggleGroup(a, 'CPTC');
    expect(b.has('CPTC')).toBe(false);
    expect(a.has('CPTC')).toBe(true);
    expect(toggleGroup(b, 'X')).toEqual(new Set(['X']));
  });

  it('ignores corrupt storage', () => {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, '{not json');
    expect(loadCollapsedGroups()).toEqual(new Set());
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([1, 'ok', null]));
    expect(loadCollapsedGroups()).toEqual(new Set(['ok']));
  });

  it('survives a storage that throws', () => {
    const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } as unknown as Storage;
    expect(loadCollapsedGroups(throwing)).toEqual(new Set());
    expect(() => saveCollapsedGroups(new Set(['a']), throwing)).not.toThrow();
  });
});
```

Add to `src/test/sidebar.test.tsx`, inside `describe('Sidebar', ...)` (and add `localStorage.clear();` as the first line of the existing `beforeEach`):

```ts
  it('collapses a folder from its header, shows a count, and remembers it', () => {
    useAppStore.setState({ workspaces: [ws('a', 'CPTC'), ws('b', 'CPTC')], groups: ['CPTC'] });
    const { unmount } = render(<Sidebar />);
    expect(screen.getByText('a')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /CPTC/ }));
    expect(screen.queryByText('a')).not.toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('tfs-collapsed-groups')!)).toEqual(['CPTC']);

    unmount();
    render(<Sidebar />);
    expect(screen.queryByText('a')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /CPTC/ }));
    expect(screen.getByText('a')).toBeInTheDocument();
  });

  it('still files a dragged workspace when dropped on a collapsed folder', () => {
    const setWorkspaceGroup = vi.fn();
    localStorage.setItem('tfs-collapsed-groups', JSON.stringify(['CPTC']));
    useAppStore.setState({ workspaces: [ws('a', null)], groups: ['CPTC'], setWorkspaceGroup });
    render(<Sidebar />);
    const dt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByText('a'), { dataTransfer: dt });
    fireEvent.drop(screen.getByText('CPTC'), { dataTransfer: dt });
    expect(setWorkspaceGroup).toHaveBeenCalledWith('a', 'CPTC');
  });

  it('opens Settings from the status footer', () => {
    const setSettingsOpen = vi.fn();
    useAppStore.setState({ setSettingsOpen, mcp: null, backup: null });
    render(<Sidebar />);
    fireEvent.click(screen.getByText(/MCP: no client/));
    fireEvent.click(screen.getByText(/Backup: not set up/));
    expect(setSettingsOpen).toHaveBeenCalledTimes(2);
    expect(setSettingsOpen).toHaveBeenCalledWith(true);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun run test:ui -- src/test/collapsed-groups.test.ts src/test/sidebar.test.tsx`
Expected: the new tests FAIL (module missing; no button named CPTC; no "MCP: no client" text).

- [ ] **Step 3: Write the storage helper**

`src/lib/collapsed-groups.ts`:

```ts
// Which sidebar folders the user has collapsed. Per browser, never synced:
// it is a viewing preference, not workspace data.

export const COLLAPSED_GROUPS_KEY = 'tfs-collapsed-groups';

function defaultStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function loadCollapsedGroups(storage: Storage | null = defaultStorage()): Set<string> {
  try {
    const raw = storage?.getItem(COLLAPSED_GROUPS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsedGroups(groups: Set<string>, storage: Storage | null = defaultStorage()): void {
  try { storage?.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...groups])); } catch { /* private mode, quota: a preference is not worth an error */ }
}

/** A new set with `group` flipped; the input is left untouched. */
export function toggleGroup(groups: Set<string>, group: string): Set<string> {
  const next = new Set(groups);
  if (next.has(group)) next.delete(group); else next.add(group);
  return next;
}
```

- [ ] **Step 4: Update the sidebar**

In `src/components/sidebar/Sidebar.tsx`:

1. Change the lucide import to `import { AlertTriangle, ChevronDown, ChevronRight, FolderPlus, Plus, Settings, Circle } from 'lucide-react';` and add `import { loadCollapsedGroups, saveCollapsedGroups, toggleGroup } from '@/lib/collapsed-groups';` and `import type { BackupState, WorkspaceStatus } from '@/types';` (replace the existing `WorkspaceStatus` type import).

2. Add above `export function Sidebar()`:

```tsx
function backupLabel(b: BackupState | null): string {
  if (!b?.destinations.length) return 'Backup: not set up';
  if (b.lastError) return `Backup: error (${b.lastError})`;
  if (b.lastRunAt) return `Backup: ${new Date(b.lastRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return 'Backup: pending';
}
```

3. Inside `Sidebar()`, after the other `useState` lines, add:

```tsx
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsedGroups());
  const toggle = (group: string) => setCollapsed((prev) => { const next = toggleGroup(prev, group); saveCollapsedGroups(next); return next; });
```

4. Replace the group rendering block (`{grouped.map(({ group, items }) => ( ... ))}`) with:

```tsx
        {grouped.map(({ group, items }) => {
          const isCollapsed = group !== null && collapsed.has(group);
          return (
            <div key={group ?? '__loose'} className="mb-2">
              {group && (
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => dropOnGroup(e, group)}
                  onContextMenu={(e) => { e.preventDefault(); setFolderMenu({ name: group, x: e.clientX, y: e.clientY }); }}
                >
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggle(group)}
                    className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
                  >
                    {isCollapsed ? <ChevronRight size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
                    <span className="flex-1 truncate">{group}</span>
                    {isCollapsed && <span className="text-[9px] font-normal normal-case tracking-normal">{items.length}</span>}
                  </button>
                </div>
              )}
              {!isCollapsed && items.map((ws) => (
                <button key={ws.id} type="button" draggable onDragStart={(e) => e.dataTransfer.setData(DRAG_MIME, ws.id)} onClick={() => void select(ws.id)} onContextMenu={(e) => { e.preventDefault(); setMenu({ ws, x: e.clientX, y: e.clientY }); }}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-[hsl(var(--accent))] ${ws.id === active ? 'bg-[hsl(var(--accent))] font-medium' : ''}`}>
                  {ws.status === 'missing' ? <AlertTriangle size={12} className="text-[hsl(var(--status-amber))]" /> : <Circle size={6} className={ws.library ? 'fill-current text-[hsl(var(--muted-foreground))]' : 'text-[hsl(var(--status-blue))]'} />}
                  <span className="flex-1 truncate" title={ws.path}>{ws.name}</span>
                </button>
              ))}
            </div>
          );
        })}
```

5. Replace the footer `<div className="border-t ...">…</div>` (the block with the two status rows) with:

```tsx
      <div className="shrink-0 border-t border-[hsl(var(--border))] px-2 py-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">
        <button type="button" onClick={() => setSettingsOpen(true)} title="MCP status · open Settings" className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-[hsl(var(--accent))]">
          <span className={`h-2 w-2 shrink-0 rounded-full ${mcpConnected ? 'bg-[hsl(var(--status-green))]' : 'bg-[hsl(var(--muted-foreground))]/40'}`} />
          <span className="truncate">MCP: {mcpConnected ? `connected (${mcp!.clients.filter((c) => c.connected).map((c) => c.name).join(', ')})` : 'no client'}</span>
        </button>
        <button type="button" onClick={() => setSettingsOpen(true)} title="Backup status · open Settings" className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-[hsl(var(--accent))]">
          <span className={`h-2 w-2 shrink-0 rounded-full ${online ? 'bg-[hsl(var(--status-green))]' : 'bg-[hsl(var(--status-red))]'}`} />
          <span className="truncate">{backupLabel(backup)}</span>
        </button>
      </div>
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `bun run test:ui -- src/test/collapsed-groups.test.ts src/test/sidebar.test.tsx && bun run typecheck`
Expected: all sidebar tests pass (old and new); typecheck exits 0.

- [ ] **Step 6: Look at it**

Reload `http://127.0.0.1:5173/`. Expected: CPTC and ECE-2300L headers show a chevron; clicking collapses the list and shows the item count; the state survives a reload; the footer reads `MCP: …` and `Backup: …` and clicking either opens Settings.

- [ ] **Step 7: Commit**

```bash
git add src/lib/collapsed-groups.ts src/components/sidebar/Sidebar.tsx src/test/collapsed-groups.test.ts src/test/sidebar.test.tsx
git commit -m "feat(sidebar): collapsible folders with chevrons and a clickable status footer"
```

---

### Task 8: Settings "Connect Claude" section with copy buttons

**Files:**
- Create: `src/components/settings/CopyRow.tsx`
- Modify: `src/components/settings/SettingsView.tsx` (replace the `MCP (Claude Code, Claude Desktop)` section)
- Test: `src/test/settings-connect.test.tsx`

**Interfaces:**
- Consumes: `McpStatus.stdioBridge` (Task 6).
- Produces: `CopyRow({ label, value }: { label: string; value: string })`.

- [ ] **Step 1: Write the failing test**

`src/test/settings-connect.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useAppStore } from '@/stores';
import { SettingsView } from '@/components/settings/SettingsView';

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  writeText.mockClear();
  useAppStore.setState({
    backup: null,
    redaction: { style: 'gaussian', strength: 1 },
    typstCli: null,
    loadBackup: async () => {},
    saveSettings: async () => {},
    mcp: { endpoint: '/mcp', authRequired: false, clients: [], stdioBridge: 'C:\\repo\\advanced-typst-editor\\server\\mcp-stdio.ts' },
  });
});

describe('Settings › Connect Claude', () => {
  it('copies the Claude Code command', async () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy Claude Code' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('claude mcp add --transport http typst-figure-studio http://localhost:8090/mcp'));
  });

  it('copies a Claude Desktop config that launches the bridge with forward slashes', async () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole('button', { name: /Copy Claude Desktop/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const json = JSON.parse(writeText.mock.calls[0]![0] as string);
    expect(json).toEqual({ mcpServers: { 'typst-figure-studio': { command: 'bun', args: ['C:/repo/advanced-typst-editor/server/mcp-stdio.ts'] } } });
  });

  it('copies the endpoint', async () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy Endpoint' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('http://localhost:8090/mcp'));
  });

  it('shows a placeholder path and a hint when the server cannot name the bridge (Docker, sidecar)', () => {
    useAppStore.setState({ mcp: { endpoint: '/mcp', authRequired: false, clients: [], stdioBridge: null } });
    render(<SettingsView />);
    expect(screen.getByText(/<path to advanced-typst-editor>\/server\/mcp-stdio.ts/)).toBeInTheDocument();
    expect(screen.getByText(/machine that runs Claude Desktop/)).toBeInTheDocument();
  });

  it('no longer hardcodes a user path', () => {
    render(<SettingsView />);
    expect(document.body.textContent).not.toContain('C:/Users/rober');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun run test:ui -- src/test/settings-connect.test.tsx`
Expected: FAIL (no buttons named `Copy …`; the hardcoded path is present).

- [ ] **Step 3: Write `CopyRow`**

`src/components/settings/CopyRow.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * A labelled, selectable line of text with a copy button. The button shows
 * a check mark for a moment after a successful copy; if the clipboard is
 * blocked, the text stays selectable so it can still be copied by hand.
 */
export function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked: the text is selectable */ }
  };

  return (
    <div className="mb-2">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">{label}</div>
      <div className="flex items-start gap-2 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40 px-2 py-1.5">
        <pre className="min-w-0 flex-1 select-all overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">{value}</pre>
        <button type="button" aria-label={`Copy ${label}`} title="Copy" onClick={() => void copy()} className="shrink-0 rounded p-1 hover:bg-[hsl(var(--accent))]">
          {copied ? <Check size={12} className="text-[hsl(var(--status-green))]" /> : <Copy size={12} />}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Replace the MCP section in `SettingsView.tsx`**

Add `import { CopyRow } from './CopyRow';` to the imports, and above `function Section(...)` add:

```tsx
const MCP_ENDPOINT = 'http://localhost:8090/mcp';
const MCP_NAME = 'typst-figure-studio';
const BRIDGE_PLACEHOLDER = '<path to advanced-typst-editor>/server/mcp-stdio.ts';

function desktopConfig(bridge: string | null): string {
  const script = bridge ? bridge.replace(/\\/g, '/') : BRIDGE_PLACEHOLDER;
  return JSON.stringify({ mcpServers: { [MCP_NAME]: { command: 'bun', args: [script] } } }, null, 2);
}
```

Replace the whole `<Section title="MCP (Claude Code, Claude Desktop)"> … </Section>` block with:

```tsx
            <Section title="Connect Claude">
              <p className="mb-2 text-[hsl(var(--muted-foreground))]">The studio is an MCP server. Claude Code connects to it over HTTP; Claude Desktop launches a small bridge script that forwards to the same endpoint.</p>
              <CopyRow label="Endpoint" value={MCP_ENDPOINT} />
              {mcp?.authRequired && <p className="mb-2 text-[hsl(var(--status-amber))]">This server requires a bearer token: pass the APP_TOKEN it was started with.</p>}
              <CopyRow label="Claude Code" value={`claude mcp add --transport http ${MCP_NAME} ${MCP_ENDPOINT}`} />
              <CopyRow label="Claude Desktop (claude_desktop_config.json)" value={desktopConfig(mcp?.stdioBridge ?? null)} />
              {!mcp?.stdioBridge && (
                <p className="mb-2 text-[hsl(var(--muted-foreground))]">Running in Docker or as the packaged app: replace the path with where this repo lives on the machine that runs Claude Desktop.</p>
              )}
              <div className="mt-3 text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Connected clients</div>
              <ul className="mt-1">
                {(mcp?.clients ?? []).map((c) => <li key={c.name} className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${c.connected ? 'bg-[hsl(var(--status-green))]' : 'bg-[hsl(var(--muted-foreground))]/40'}`} />{c.name} {c.version ?? ''} · {c.sessions} session{c.sessions === 1 ? '' : 's'} · seen {new Date(c.lastSeenAt).toLocaleTimeString()}</li>)}
                {(mcp?.clients ?? []).length === 0 && <li className="text-[hsl(var(--muted-foreground))]">No client has connected yet.</li>}
              </ul>
            </Section>
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `bun run test:ui -- src/test/settings-connect.test.tsx && bun run typecheck`
Expected: 5 tests pass; typecheck exits 0.

- [ ] **Step 6: Look at it**

Reload the app, open Settings (gear icon). Expected: a "Connect Claude" section with three boxed rows, each with a copy icon that turns into a check mark when clicked; the Desktop JSON shows the real repo path with forward slashes.

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/CopyRow.tsx src/components/settings/SettingsView.tsx src/test/settings-connect.test.tsx
git commit -m "feat(settings): Connect Claude section with copy buttons for Code and Desktop"
```

---

### Task 9: Docker image, compose file, README

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `README.md`

**Interfaces:**
- Consumes: the server's env contract (`HOST`, `PORT`, `STATIC_DIR`, `DATA_DIR`, `APP_TOKEN`), `resolveTypstCli` finding `typst` on `PATH`, `serveStatic` preferring `.gz` siblings.

- [ ] **Step 1: Write `.dockerignore`**

```
node_modules
dist
data
docs
.vite
.git
*.md
*.tsbuildinfo
```

- [ ] **Step 2: Write the `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1

# ── build: deps, fonts, client bundle, typst CLI ───────────────────────────
FROM oven/bun:1.3 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
# Stage the default fonts (no-op when public/fonts is already in the
# context), typecheck + bundle the client, then precompress the big assets:
# server/static.ts serves a .gz sibling when the browser accepts gzip, so the
# 28 MB compiler wasm is never compressed at request time.
RUN bun scripts/fonts.ts \
 && bun run build \
 && find dist/assets -type f \( -name '*.js' -o -name '*.css' -o -name '*.wasm' \) -exec gzip -9 -k {} \;

# The server-side compiler (MCP PDF export) needs the typst CLI on PATH.
ARG TYPST_VERSION=0.14.2
ADD https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz /tmp/typst.tar.xz
RUN apt-get update && apt-get install -y --no-install-recommends xz-utils && rm -rf /var/lib/apt/lists/* \
 && tar -xJf /tmp/typst.tar.xz -C /tmp \
 && install -m 0755 /tmp/typst-x86_64-unknown-linux-musl/typst /usr/local/bin/typst \
 && /usr/local/bin/typst --version

# ── runtime ────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 STATIC_DIR=/app/dist DATA_DIR=/data
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=build /usr/local/bin/typst /usr/local/bin/typst
COPY tsconfig.json tsconfig.server.json ./
COPY server ./server
COPY src/types.ts src/template.ts ./src/
COPY src/lib ./src/lib
COPY --from=build /app/dist ./dist

RUN mkdir -p /data && chown -R bun:bun /data /app
USER bun
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["bun", "server/index.ts"]
```

- [ ] **Step 3: Write `docker-compose.yml`**

```yaml
services:
  typst-studio:
    build: .
    image: typst-studio:latest
    container_name: typst-studio
    ports:
      - "127.0.0.1:8090:8080"
    volumes:
      # Same documents as the dev server: the registry self-heals paths on both sides.
      - ./data:/data
      # Backup destination reachable from inside the container as /host.
      - C:/Users/rober/Desktop/typst-editor/backups:/host
    environment:
      - APP_TOKEN=${APP_TOKEN:-}
    restart: unless-stopped
```

- [ ] **Step 4: Write `README.md`**

```markdown
# Typst Studio

Local Typst editor with a live preview, an assets rail for screenshots and fonts, and an MCP server for Claude.

## Run in Docker (recommended)

    docker compose up --build -d

Open http://localhost:8090. Documents live in `./data` (bind-mounted, so the dev server sees the same workspaces). The container restarts with Docker Desktop. Stop it with `docker compose down`; rebuild after pulling changes with `docker compose up --build -d`.

Before starting the container, stop any dev backend on port 8090.

## Run from source

    bun install
    bun --watch server/index.ts     # API + MCP on http://127.0.0.1:8090
    bun run dev                     # UI on http://127.0.0.1:5173 (proxies /api and /mcp)

## Connect Claude

Settings → Connect Claude has copy buttons for the Claude Code command and the Claude Desktop config. The endpoint is `http://localhost:8090/mcp` in both setups.

## Tests

    bun run test:ui
    bun run test:server
    bun run typecheck
```

- [ ] **Step 5: Stop the dev backend on 8090, build and start the container**

Find and stop whatever listens on 8090 (the dev backend), then:

```bash
docker compose up --build -d
docker compose ps
```

Expected: the build finishes (first build takes a few minutes: `bun install`, Vite build, typst download); `docker compose ps` shows `typst-studio` `Up … (healthy)` within about 30 s. If it shows `(health: starting)`, wait and re-run.

- [ ] **Step 6: Smoke the container**

```bash
curl -s http://127.0.0.1:8090/api/health
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:8090/
curl -s -H 'Accept-Encoding: gzip' -o /dev/null -w 'wasm gz: %{http_code} enc=%header{content-encoding}\n' "http://127.0.0.1:8090/$(curl -s http://127.0.0.1:8090/ | grep -o 'assets/index-[^"]*\.js' | head -1)"
curl -s http://127.0.0.1:8090/api/workspaces | python -c "import sys,json; [print(w['status'], w['group'], w['name'], w['path']) for w in json.load(sys.stdin)['workspaces']]"
curl -s http://127.0.0.1:8090/api/mcp/status
docker compose exec typst-studio typst --version
```

Expected: `{"ok":true,...}`; `200 text/html`; the JS asset served with `enc=gzip`; six workspaces, all `ok`, each once, paths under `/data/workspaces/...`, groups intact; MCP status with `"stdioBridge":null`; `typst 0.14.2`.

- [ ] **Step 7: Use it in the browser**

Open `http://localhost:8090/` in Chrome. Expected: the sidebar lists the six workspaces under their groups, cptc-report renders its 23 pages, switching workspaces is quick, Settings → Connect Claude shows the Docker placeholder line. Check that a change made here shows up on disk under `advanced-typst-editor/data/workspaces/<name>/main.typ` (bind mount works both ways), and that starting the dev backend again later still lists every workspace once (self-heal re-points `/data/...` back to Windows paths).

- [ ] **Step 8: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml README.md
git commit -m "build: Docker image and compose for Typst Studio on port 8090"
```

---

### Task 10: Final verification and hand-off

**Files:** none new.

- [ ] **Step 1: Run everything**

```bash
bun run typecheck && bun run test:ui && bun run test:server && bun run build
```

Expected: all green.

- [ ] **Step 2: Confirm the tree is clean and the branch is complete**

```bash
git status --short
git log --oneline main..docker-perf
```

Expected: no uncommitted files; one commit per task above plus the two earlier commits (preview virtualization, spec).

- [ ] **Step 3: Hand off**

Use the `superpowers:finishing-a-development-branch` skill to decide between merging `docker-perf` into `main`, opening a PR, or leaving the branch. Report the measured before/after numbers from Task 4 and the container status from Task 9 in the summary.

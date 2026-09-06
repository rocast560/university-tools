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
  let seq = 0;
  // Set by a crash, for the *next* call only: a request that was already
  // committed to running when the worker died (but hadn't posted its
  // message yet, so it isn't in `pending`) still needs to see the failure
  // instead of silently sailing through on a freshly spawned worker.
  let crashError: Error | null = null;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const transport: Transport = {
    generation: 0,
    call<T>(cmd: DriverCommand): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (crashError) {
          const err = crashError;
          crashError = null;
          reject(err);
          return;
        }
        const w = worker ?? spawn();
        const id = ++seq;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        w.postMessage({ id, ...cmd } satisfies DriverRequest);
      });
    },
  };

  const spawn = (): Worker => {
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
      if (worker === w) {
        // A replacement worker starts with empty state; the generation
        // bump tells the client to push fonts and shadow files again.
        worker = null;
        crashError = err;
        transport.generation++;
      }
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

/** Actually talk to the transport for one SVG compile: fonts/shadow sync, then the compile itself. */
function runSvgCompile(source: string, mainPath: string): Promise<TypstSvgResult> {
  return enqueue(async () => {
    const t = getTransport();
    await syncState(t);
    return t.call<SvgOutput>({ op: 'svg', source, mainPath });
  });
}

// Coalescing state for preview compiles: at most one coalesced compile is
// ever in flight against the transport, plus (at most) one waiting behind
// it. A further preview that arrives while one is already waiting replaces
// it outright, so only the newest preview ever pays for a round trip; the
// one it replaced is resolved as superseded without touching the transport.
let svgActive = false;
let svgPending: { source: string; mainPath: string; resolve: (r: TypstSvgResult) => void } | null = null;

function startSvg(source: string, mainPath: string, resolve: (r: TypstSvgResult) => void): void {
  svgActive = true;
  void runSvgCompile(source, mainPath).then((res) => {
    resolve(res);
    svgActive = false;
    if (svgPending) {
      const next = svgPending;
      svgPending = null;
      startSvg(next.source, next.mainPath, next.resolve);
    }
  });
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
 *
 * Coalescing (`opts.coalesce`) is opt-in: the preview debounces typing, but
 * a document that takes longer to compile than the debounce window can
 * still pile up requests. Since only the newest preview is ever shown, at
 * most one coalesced compile waits behind the one in flight; anything it
 * displaces resolves immediately as `{ diagnostics: [], superseded: true }`
 * rather than paying for a round trip. An *export* must never be skipped,
 * so it always goes through `runSvgCompile` directly instead.
 */
export function compileTypstSvg(
  source: string,
  opts: { coalesce?: boolean } = {},
  mainPath: string = MAIN_PATH,
): Promise<TypstSvgResult> {
  if (!opts.coalesce) return runSvgCompile(source, mainPath);
  return new Promise<TypstSvgResult>((resolve) => {
    if (!svgActive) {
      startSvg(source, mainPath, resolve);
      return;
    }
    svgPending?.resolve({ diagnostics: [], superseded: true });
    svgPending = { source, mainPath, resolve };
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

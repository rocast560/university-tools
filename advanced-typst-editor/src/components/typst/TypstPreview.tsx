// ─────────────────────────────────────────────────────────────────────────
// Live, locally-rendered Typst preview.
//
// Debounces the source, compiles it to SVG in-browser (see lib/typst-compiler)
// and shows the rendered pages. Compile errors surface as a banner with the
// Typst diagnostics (file:line ranges) while the last good render stays
// visible, so a transient typo doesn't blank the preview.
//
// Pages are mounted individually and lazily (see `PageCard`). typst.ts
// renders the whole document into one <svg>; for a long report that is tens
// of thousands of nodes (a <use> per glyph, a position:fixed <div> per text
// run), and committing all of it after every keystroke pause cost seconds of
// style/layout/paint on the main thread while the compile itself took tens
// of milliseconds. Splitting the SVG per page (lib/typst-pages) lets the
// preview keep only the pages near the viewport in the DOM, and leave a
// page's DOM untouched when its markup did not change between compiles.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, memo, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ZoomIn, ZoomOut, Maximize, Loader2, AlertTriangle, Lock } from 'lucide-react';
import { compileTypstSvg, typstErrorMessage, type TypstDiagnostic } from '@/lib/typst-compiler';
import { splitTypstPages, extractTextRuns, reconcileDefs, splitSharedStyle, DEFAULT_PAGE_GAP, type SplitTypstSvg } from '@/lib/typst-pages';
import {
  fallbackCandidates, rangeFromSelection,
  type ClickTarget, type SelectionRange, type SourceClick, type SourceHint, type SourceRange,
} from '@/lib/typst-source-map';
import { PreviewSelectionBar, type BarAnchor } from './PreviewSelectionBar';
import { renderCache } from '@/lib/workspace-cache';
import { switchTrace } from '@/lib/perf';

export type { SourceCandidate, SourceClick, SelectionRange } from '@/lib/typst-source-map';

/** Where the rendered pages live: the shadow root, or one page card inside it. */
type Scope = Element | ShadowRoot;

/**
 * Which text run is under a click, and the runs of the page it is on.
 *
 * typst.ts emits a hidden selection layer: one `<foreignObject>` per text
 * run, containing a `.tsel` div with the literal characters. We hit-test
 * against those boxes geometrically rather than trusting `event.target`,
 * because the `.tsel` divs are `position: fixed` (typst.ts's trick for making
 * text selectable across the SVG), so whatever the browser reports as the
 * event target isn't reliably the run under the cursor.
 *
 * Falls back to the nearest box when the click lands in a margin or between
 * lines, so clicking roughly at something still works.
 *
 * Only the index and the page's texts are returned: the mapper
 * (lib/typst-source-map) takes it from there, using the runs around the
 * clicked one as context. Nothing is counted here any more.
 */
function textRunAtPoint(
  container: Scope,
  clientX: number,
  clientY: number,
): { index: number; texts: string[] } | null {
  const objects = Array.from(container.querySelectorAll('foreignObject'));
  if (objects.length === 0) return null;

  const texts = objects.map((o) => o.textContent ?? '');

  let bestIndex = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < objects.length; i++) {
    if (!texts[i]!.trim()) continue;
    const r = objects[i]!.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;

    // Distance to the box: zero when the point is inside it.
    const dx = Math.max(r.left - clientX, 0, clientX - r.right);
    const dy = Math.max(r.top - clientY, 0, clientY - r.bottom);
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
      if (distance === 0) break; // inside a run: can't do better
    }
  }

  if (bestIndex === -1) return null;
  // Ignore a click far from any text (empty page area) rather than yanking
  // the cursor to something arbitrary.
  if (bestDistance > 120) return null;
  return { index: bestIndex, texts };
}

/** The data-URI href of the rendered image under the pointer, if any. */
function imageHrefAtPoint(
  container: Scope,
  clientX: number,
  clientY: number,
): string | null {
  let best: { href: string; area: number } | null = null;
  for (const img of Array.from(container.querySelectorAll('svg image'))) {
    const r = img.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) continue;
    const href = img.getAttribute('href') || img.getAttribute('xlink:href');
    if (!href) continue;
    const area = r.width * r.height;
    // Prefer the smallest hit: a figure nested over a full-page background
    // image should win over the background.
    if (!best || area < best.area) best = { href, area };
  }
  return best?.href ?? null;
}

// ── Selection to source (phase 2) ──────────────────────────────────────────

/** A selection is mapped this long after the last mouseup / Shift release, never during a drag. */
const SELECTION_DEBOUNCE_MS = 120;

interface DomPoint { node: Node; offset: number }

/**
 * The ends of the user's selection, when it is a non-empty one anchored inside
 * the preview's pages; null for anything else (collapsed, or living in the
 * editor).
 *
 * Both the shadow root's selection and the document's are read. Chrome gives
 * ShadowRoot a getSelection() whose nodes are the real ones inside the pages,
 * while window.getSelection() reports the shadow host instead; but while the
 * selection lives in the *editor*, that same shadow getSelection() stringifies
 * to the editor's text with a null anchor (seen in the app on 2026-10-17), so
 * the text alone proves nothing: both ends must sit inside the pages.
 * Browsers without ShadowRoot.getSelection expose the real ends through
 * getComposedRanges.
 */
function previewSelection(root: ShadowRoot): { text: string; a: DomPoint; b: DomPoint } | null {
  const inside = (n: Node | null | undefined): n is Node => !!n && root.contains(n);
  const doc = window.getSelection();
  const own = (root as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.();
  for (const s of [own, doc]) {
    if (!s || !s.toString()) continue;
    if (inside(s.anchorNode) && inside(s.focusNode)) {
      return { text: s.toString(), a: { node: s.anchorNode, offset: s.anchorOffset }, b: { node: s.focusNode, offset: s.focusOffset } };
    }
  }
  const composed = (doc as (Selection & { getComposedRanges?: (o: { shadowRoots: ShadowRoot[] }) => StaticRange[] }) | null)?.getComposedRanges;
  if (doc && doc.toString() && composed) {
    try {
      const [r] = composed.call(doc, { shadowRoots: [root] });
      if (r && inside(r.startContainer) && inside(r.endContainer)) {
        return { text: doc.toString(), a: { node: r.startContainer, offset: r.startOffset }, b: { node: r.endContainer, offset: r.endOffset } };
      }
    } catch { /* an older shape of the API: no selection to read */ }
  }
  return null;
}

/** A selection end resolved to a text run of a page. */
interface RunPoint {
  page: number;
  run: number;
  /** Character offset inside the run's text. */
  offset: number;
  /** The run boxes of the page card (or of the whole document), and their texts. */
  boxes: Element[];
  texts: string[];
  pageCount: number;
  paged: boolean;
}

/** UTF-16 offset of `p` inside the text of `box`. */
function textOffsetIn(box: Element, p: DomPoint): number {
  try {
    const r = document.createRange();
    r.selectNodeContents(box);
    r.setEnd(p.node, p.offset);
    return r.toString().length;
  } catch { return 0; }
}

/**
 * The run a selection end is in, and where in it. An end that Chrome anchors
 * on a container instead of a text node (a triple-click, a drag from the
 * margin) snaps to the nearest run on the right side of the boundary.
 */
function runPointAt(root: ShadowRoot, p: DomPoint, side: 'start' | 'end'): RunPoint | null {
  const el = p.node.nodeType === 1 ? (p.node as Element) : p.node.parentElement;
  if (!el) return null;
  const card = el.closest<HTMLElement>('[data-page-index]');
  const scope: Scope = card ?? root;
  const boxes = Array.from(scope.querySelectorAll('foreignObject'));
  const texts = boxes.map((o) => o.textContent ?? '');
  const base = {
    page: card ? Number(card.dataset.pageIndex) : 0,
    boxes, texts,
    pageCount: 0, // filled by the caller, which knows the split
    paged: !!card,
  };
  const own = el.closest('foreignObject');
  if (own && boxes.includes(own)) return { ...base, run: boxes.indexOf(own), offset: textOffsetIn(own, p) };
  try {
    const at = document.createRange();
    at.setStart(p.node, p.offset);
    at.collapse(true);
    const usable = (i: number) => texts[i]!.trim().length > 0;
    if (side === 'start') {
      for (let i = 0; i < boxes.length; i++) if (usable(i) && at.comparePoint(boxes[i]!, 0) >= 0) return { ...base, run: i, offset: 0 };
    } else {
      for (let i = boxes.length - 1; i >= 0; i--) if (usable(i) && at.comparePoint(boxes[i]!, 0) <= 0) return { ...base, run: i, offset: texts[i]!.length };
    }
  } catch { /* no usable boundary point */ }
  return null;
}

const cmpRunPoints = (a: RunPoint, b: RunPoint) => a.page - b.page || a.run - b.run || a.offset - b.offset;

const DEBOUNCE_MS = 350;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;

/**
 * Pages mounted on first render without waiting for the observer: the
 * preview opens scrolled to the top, and a frame of empty cards there would
 * flash on every workspace switch.
 */
const EAGER_PAGES = 2;

/**
 * How far beyond the scroll viewport a page is kept mounted, as a multiple of
 * the viewport height on each side. Generous enough that ordinary scrolling
 * never reaches an empty card, small enough that a long report keeps only a
 * handful of pages in the DOM.
 */
const MOUNT_MARGIN = '150% 0px';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The pages render inside a shadow root, and this is the only stylesheet
 * that reaches them besides typst.ts's own. Measured on a 23-page report:
 * with the pages in the document, every full style recalculation (any
 * inherited property or stylesheet change anywhere on the page) cost 1.4 to
 * 1.6 s, because the app's global stylesheet is matched against the ~26 000
 * SVG nodes of two mounted pages; inside a shadow root the same recalc costs
 * 20 ms. Tailwind classes therefore do not apply in here.
 */
const SHADOW_CSS = `
:host { display: block; }
.stack { width: fit-content; margin: 0 auto; transform-origin: top center; will-change: transform; }
.pages { display: flex; flex-direction: column; align-items: center; gap: ${DEFAULT_PAGE_GAP}px; }
.page { background: #fff; border-radius: 2px; box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1); }
.page > svg { display: block; }
.whole { background: #fff; border-radius: 4px; box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1); }
.whole > svg { display: block; height: auto; max-width: none; }
.locked .pseudo-link { pointer-events: none; cursor: text; }
`;

/** The shadow root of `ref`'s element, created on mount. */
function useShadowRoot(): [RefObject<HTMLDivElement | null>, ShadowRoot | null] {
  const ref = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<ShadowRoot | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setRoot(el.shadowRoot ?? el.attachShadow({ mode: 'open' }));
  }, []);
  return [ref, root];
}

/**
 * typst.ts's stylesheet. It is the same text for every compile, and React
 * leaves a <style> alone while its text is unchanged, so the document's
 * styles are never invalidated by a compile (which, with a long report on
 * screen, costs a full second of style recalculation).
 */
const SharedStyle = memo(function SharedStyle({ css }: { css: string }) {
  return <style>{css}</style>;
});

/**
 * The glyph/clip-path <defs>, mounted once in a zero-size <svg>. Every
 * page's `<use href="#…">` resolves against the document, so the defs need
 * to exist exactly once, anywhere in it. Not `display: none`: a referenced
 * element inside a display:none subtree may still render through <use>, but
 * paint servers and clip paths are safer with the subtree merely hidden by
 * size. Updated by `reconcileDefs`, so a glyph still in use keeps its node.
 */
const SharedDefs = memo(function SharedDefs({ markup }: { markup: string }) {
  const ref = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => { if (ref.current) reconcileDefs(ref.current, markup); }, [markup]);
  return (
    <svg
      ref={ref}
      xmlns={SVG_NS}
      aria-hidden="true"
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
    />
  );
});

/**
 * One page: a white card of the page's exact size, whose SVG content is
 * mounted only while the card is within `MOUNT_MARGIN` of the scroll
 * viewport. Memoized on the fragment, so a compile that left this page's
 * markup unchanged never touches its DOM.
 */
const PageCard = memo(function PageCard({
  tid,
  width,
  height,
  body,
  index,
  scrollRoot,
}: {
  tid: string;
  width: number;
  height: number;
  body: string;
  index: number;
  scrollRoot: RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(index < EAGER_PAGES);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const observer = new IntersectionObserver(
      (entries) => { const entry = entries[entries.length - 1]; if (entry) setNear(entry.isIntersecting); },
      { root: scrollRoot.current, rootMargin: MOUNT_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollRoot]);

  return (
    <div
      ref={ref}
      data-page-index={index}
      className="page"
      // `content-visibility: auto`: a mounted page that has scrolled out of
      // view costs nothing in style and layout passes; its size is explicit,
      // so skipping it moves nothing.
      style={{ width: `${width}px`, height: `${height}px`, contain: 'layout', contentVisibility: 'auto', containIntrinsicSize: `${width}px ${height}px` }}
    >
      {near && (
        <svg
          xmlns={SVG_NS}
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          data-tid={tid}
          dangerouslySetInnerHTML={{ __html: body }}
        />
      )}
    </div>
  );
});

/**
 * The page card the click belongs to: the one containing the event target,
 * else (a click in the gap between pages) the nearest one vertically.
 */
function pageCardAt(host: Scope, target: Element | null, clientY: number): HTMLElement | null {
  const own = target?.closest<HTMLElement>('[data-page-index]');
  if (own) return own;
  let best: HTMLElement | null = null;
  let bestDistance = Infinity;
  for (const card of Array.from(host.querySelectorAll<HTMLElement>('[data-page-index]'))) {
    const r = card.getBoundingClientRect();
    const distance = Math.max(r.top - clientY, 0, clientY - r.bottom);
    if (distance < bestDistance) { bestDistance = distance; best = card; }
  }
  return best;
}

/** A highlight in the preview, mapped to the source (range is null when nothing aligned), and where its bar goes. */
interface MappedSelection {
  range: SelectionRange | null;
  text: string;
  anchor: BarAnchor;
}

/** What the preview shows for one document: its last good render. */
interface DocRender {
  key: string;
  svg: string;
  diagnostics: TypstDiagnostic[];
  /** Scroll offset to restore once the pages are mounted; consumed once. */
  restoreScroll: number | null;
}

/** The starting state for a document: its cached render, or nothing yet. */
function docFromCache(key: string): DocRender {
  const snap = renderCache.get(key);
  return { key, svg: snap?.svg ?? '', diagnostics: snap?.diagnostics ?? [], restoreScroll: snap ? snap.scrollTop : null };
}

// Memoized so it only re-renders when `source` (or the asset revision)
// actually changes: in particular it is skipped entirely while the user
// drags the editor/preview divider (which only changes the parent's width
// state).
//
// `revision` bumps whenever the workspace's images/fonts change. It isn't
// used in the render, only as a compile trigger: a crop or a new screenshot
// changes what the *same* source renders to.
export const TypstPreview = memo(function TypstPreview({
  source,
  revision = 0,
  mainPath = '/main.typ',
  docKey = 'doc',
  ready = true,
  onRevealSource,
  onRevealImage,
  locked = false,
  onSelectionRange,
  onSelectInCode,
}: {
  source: string;
  revision?: number;
  /**
   * Identifies the document (`workspace:file`). A change means a switch: the
   * outgoing render is kept in `renderCache`, the incoming document's cached
   * render (if any) is shown at once, and the first compile runs without the
   * typing debounce.
   */
  docKey?: string;
  /**
   * False while the document's text or mounted files are still arriving. No
   * compile runs until it is true, so a switch never renders the previous
   * text under the new path or a document with its images missing.
   */
  ready?: boolean;
  /**
   * Where `source` is mounted in the compiler's virtual filesystem: the
   * workspace-relative path of the file open in the editor, so a document
   * that `#include`s its neighbours resolves them from the right directory.
   */
  mainPath?: string;
  /**
   * Click-to-source. Receives the clicked run's place in the document (page,
   * run, and the runs around it), the previous match as a position prior, and
   * the old candidate list as a lazy fallback. Returns the range it revealed
   * so the next click can use it as the hint.
   */
  onRevealSource?: (click: SourceClick) => SourceRange | null | void;
  /**
   * Click-to-asset: fires instead of click-to-source when the click lands
   * on a rendered image, with that `<image>`'s (data URI) href.
   */
  onRevealImage?: (href: string) => void;
  /**
   * Preview lock (lib/preview-lock): clicks never reveal source or assets, so
   * the operator can click, highlight and copy text without the code or
   * assets pane opening. A plain prop, so the memo and shadow root are
   * unaffected: only the handler and the page area's cursor/title change.
   */
  locked?: boolean;
  /**
   * Selection-to-source. Called with the source range a highlight in the
   * preview maps to (once, after the drag ends), or null when the highlight is
   * gone. The tab uses it to mark the passage in the editor, which never moves
   * the caret or takes focus, so it is also called while the preview is locked.
   */
  onSelectionRange?: (range: SelectionRange | null) => void;
  /**
   * "Select in code" in the selection bar: make the mapped range the editor's
   * real selection (opening the code pane). Never offered while locked.
   */
  onSelectInCode?: (range: SourceRange) => void;
}) {
  const [doc, setDoc] = useState<DocRender>(() => docFromCache(docKey));
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [firstLoad, setFirstLoad] = useState(true);
  const [compiling, setCompiling] = useState(false);
  const [zoom, setZoom] = useState(1);
  const pageAreaRef = useRef<HTMLDivElement>(null);
  const [shadowHostRef, shadowRoot] = useShadowRoot();
  // Where the user scrolled to, read without a layout query at switch time.
  const scrollTopRef = useRef(0);

  // A different document: remember what the outgoing one looked like and
  // show the incoming one's last render right away (derived state, so no
  // frame ever shows the old pages under the new key). Saving here rather
  // than in an effect keeps the scroll offset that belonged to the old pages.
  if (doc.key !== docKey) {
    if (doc.svg) renderCache.set(doc.key, { svg: doc.svg, diagnostics: doc.diagnostics, scrollTop: scrollTopRef.current });
    setDoc(docFromCache(docKey));
  }
  const shown = doc.key === docKey ? doc : docFromCache(docKey);
  const { svg, diagnostics } = shown;

  // Monotonic id so a slow compile that finishes after a newer one can't
  // overwrite the fresher result.
  const runId = useRef(0);
  // The document the last dispatched compile was for: a new one compiles at
  // once, the same one waits out the typing debounce.
  const compiledKey = useRef<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    const id = ++runId.current;
    setCompiling(true);
    const immediate = compiledKey.current !== docKey;
    const timer = setTimeout(() => {
      compiledKey.current = docKey;
      switchTrace.mark('compile');
      void compileTypstSvg(source, { coalesce: true }, mainPath)
        .then((res) => {
          if (id !== runId.current) return;
          // A superseded compile did no work and carries no diagnostics:
          // adopting its empty result would blank the error banner a moment
          // before the real one arrives.
          if (res.superseded) return;
          setFatalError(null);
          switchTrace.mark('compiled');
          // Keep the last good render on error; never write into another document's state.
          setDoc((d) => (d.key !== docKey ? d : { ...d, diagnostics: res.diagnostics, svg: res.svg ?? d.svg }));
        })
        .catch((err) => {
          if (id !== runId.current) return;
          setFatalError(typstErrorMessage(err));
        })
        .finally(() => {
          if (id !== runId.current) return;
          setCompiling(false);
          setFirstLoad(false);
        });
    }, immediate ? 0 : DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [source, revision, mainPath, docKey, ready]);

  // The pages of this render are in the DOM: restore the offset the user left
  // the document at (once), and close the switch trace.
  useLayoutEffect(() => {
    if (!svg) return;
    const el = pageAreaRef.current;
    if (el && shown.restoreScroll !== null) {
      el.scrollTop = shown.restoreScroll;
      scrollTopRef.current = shown.restoreScroll;
      setDoc((d) => (d.key === docKey ? { ...d, restoreScroll: null } : d));
    }
    const frame = requestAnimationFrame(() => switchTrace.mark('painted'));
    return () => cancelAnimationFrame(frame);
  }, [svg, docKey, shown.restoreScroll]);

  const errors = diagnostics.filter((d) => d.severity === 'error');

  // Per-page fragments (null: not a paged typst.ts document, mount as-is).
  // Recomputed only when the SVG changes; ~10 ms for a long report.
  const split: SplitTypstSvg | null = useMemo(() => splitTypstPages(svg), [svg]);
  const shared = useMemo(() => (split ? splitSharedStyle(split.shared) : null), [split]);

  // Text runs of each page, parsed from its fragment on demand: pages that
  // are not mounted have no DOM to read them from, and only the old
  // candidate fallback and the numbering of helper-generated runs ever look
  // at pages other than the clicked one. Lives with `split`, so a new compile
  // starts a fresh cache.
  const textRunCache = useMemo(() => new Map<number, string[]>(), [split]);
  const runsOfPage = useCallback((pageIndex: number): string[] => {
    if (!split) return [];
    const page = split.pages[pageIndex];
    if (!page) return [];
    let runs = textRunCache.get(pageIndex);
    if (!runs) { runs = extractTextRuns(page.body); textRunCache.set(pageIndex, runs); }
    return runs;
  }, [split, textRunCache]);
  const textRunsBefore = useCallback((pageIndex: number): string[] => {
    const out: string[] = [];
    for (let i = 0; i < pageIndex; i++) for (const run of runsOfPage(i)) out.push(run);
    return out;
  }, [runsOfPage]);

  // The previous match, handed to the mapper as a position prior. Document
  // order is mostly source order, so the next click is probably near it.
  const hintRef = useRef<{ docKey: string; hint: SourceHint } | null>(null);

  // ── Selection to source ──
  // The mapped selection, shown as a bar next to it. Mirrored in a ref so the
  // window listeners below (registered once) always see the current one.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<MappedSelection | null>(null);
  const selectionRef = useRef<MappedSelection | null>(null);
  const [copied, setCopied] = useState<'text' | 'source' | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const onSelectionRangeRef = useRef(onSelectionRange);
  onSelectionRangeRef.current = onSelectionRange;
  // What the bar is anchored to, so a scroll or zoom can move it with the text.
  const anchorSrc = useRef<{ range: Range | null; endBox: Element | null } | null>(null);

  const computeAnchor = useCallback((): BarAnchor | null => {
    const wrap = wrapRef.current;
    const src = anchorSrc.current;
    if (!wrap || !src) return null;
    const w = wrap.getBoundingClientRect();
    let rects: DOMRect[] = [];
    try { rects = src.range?.getClientRects ? Array.from(src.range.getClientRects()) : []; } catch { /* no layout */ }
    rects = rects.filter((r) => r.width > 0 || r.height > 0);
    const last = rects[rects.length - 1] ?? src.endBox?.getBoundingClientRect();
    const first = rects[0] ?? last;
    if (!last || !first) return null;
    return { x: last.right - w.left, below: last.bottom - w.top + 6, above: first.top - w.top - 6 };
  }, []);

  const clearSelection = useCallback(() => {
    if (!selectionRef.current) return;
    selectionRef.current = null;
    anchorSrc.current = null;
    setSelection(null);
    onSelectionRangeRef.current?.(null);
  }, []);

  /**
   * Read the selection and map it, once. Called a moment after a drag ends or
   * Shift is released, never from selectionchange: during a drag the selection
   * changes on every mouse move, and aligning each of those would be wasted
   * work on a text the user has not finished choosing.
   */
  const mapSelection = useCallback(() => {
    const root = shadowRoot;
    if (!root) return;
    const sel = previewSelection(root);
    if (!sel) { clearSelection(); return; }
    const pa = runPointAt(root, sel.a, 'start');
    const pb = runPointAt(root, sel.b, 'end');
    const pageCount = split ? split.pages.length : 1;
    let range: SelectionRange | null = null;
    let ends: [RunPoint, RunPoint] | null = null;
    if (pa && pb) {
      pa.pageCount = pb.pageCount = pageCount;
      let [s, e] = cmpRunPoints(pa, pb) <= 0 ? [pa, pb] : [pb, pa];
      // An end exactly on a run boundary (a triple-click ends at the start of the next block) belongs to
      // the neighbouring run: end the selection after the previous run, start it in the next one.
      const snapped = { s: { ...s }, e: { ...e } };
      for (let n = 0; snapped.e.offset === 0 && snapped.e.run > 0 && n < 4; n++) {
        snapped.e.run--;
        snapped.e.offset = snapped.e.texts[snapped.e.run]!.length;
        if (snapped.e.texts[snapped.e.run]!.trim()) break;
      }
      for (let n = 0; snapped.s.offset >= snapped.s.texts[snapped.s.run]!.length && snapped.s.run < snapped.s.texts.length - 1 && n < 4; n++) {
        snapped.s.run++;
        snapped.s.offset = 0;
        if (snapped.s.texts[snapped.s.run]!.trim()) break;
      }
      if (cmpRunPoints(snapped.s, snapped.e) < 0) { s = snapped.s; e = snapped.e; }
      const targetOf = (rp: RunPoint): ClickTarget => ({
        page: rp.page, run: rp.run, pageCount: rp.pageCount,
        runsOf: (p) => (p === rp.page ? rp.texts : runsOfPage(p)),
      });
      range = rangeFromSelection(
        sourceRef.current,
        { target: targetOf(s), offset: s.offset },
        { target: targetOf(e), offset: e.offset },
        hintRef.current?.docKey === docKey ? hintRef.current.hint : null,
      );
      if (range) hintRef.current = { docKey, hint: { page: s.page, run: s.run, from: range.from } };
      ends = [s, e];
    }

    // Where the bar sits: after the selection's last line, from the browser's own range rects.
    let domRange: Range | null = null;
    try {
      domRange = document.createRange();
      domRange.setStart(sel.a.node, sel.a.offset);
      domRange.setEnd(sel.b.node, sel.b.offset);
      if (domRange.collapsed) { domRange.setStart(sel.b.node, sel.b.offset); domRange.setEnd(sel.a.node, sel.a.offset); }
    } catch { domRange = null; }
    anchorSrc.current = { range: domRange, endBox: ends ? ends[1].boxes[ends[1].run] ?? null : null };
    const anchor = computeAnchor() ?? { x: 0, below: 0, above: 0 };

    const prev = selectionRef.current;
    const same = prev && prev.text === sel.text && prev.range?.from === range?.from && prev.range?.to === range?.to
      && prev.range?.approximate === range?.approximate;
    const next: MappedSelection = { range, text: sel.text, anchor };
    selectionRef.current = next;
    setSelection(next);
    if (!same) onSelectionRangeRef.current?.(range);
  }, [shadowRoot, split, runsOfPage, docKey, clearSelection, computeAnchor]);
  const mapRef = useRef(mapSelection);
  mapRef.current = mapSelection;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pressedInPreview = false;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => mapRef.current(), SELECTION_DEBOUNCE_MS); };
    const inPreview = (t: EventTarget | null) => !!pageAreaRef.current && t instanceof Node && pageAreaRef.current.contains(t);
    const inBar = (t: EventTarget | null) => t instanceof Node && !!wrapRef.current?.querySelector('[data-testid="preview-selection-bar"]')?.contains(t);
    // A new press on the pages starts a new selection: the old bar would only sit in the way of the drag.
    const onDown = (e: MouseEvent) => {
      pressedInPreview = inPreview(e.target);
      if (pressedInPreview && !inBar(e.target)) { clearTimeout(timer); clearSelection(); }
    };
    // A drag can end outside the pages, so this is on the window; mouseups elsewhere in the app are ignored
    // unless a selection is up (a click elsewhere then dismisses it, because the selection has collapsed).
    const onUp = (e: MouseEvent) => {
      if (!inPreview(e.target) && !pressedInPreview && !selectionRef.current) return;
      pressedInPreview = false;
      schedule();
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === 'Shift') schedule(); };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape' && selectionRef.current) { clearTimeout(timer); clearSelection(); } };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [clearSelection]);

  // Offsets belong to one source and one render: an edit, another document or a new compile ends the selection.
  useEffect(() => { clearSelection(); }, [source, docKey, svg, clearSelection]);

  // The bar follows the text it belongs to when the pages scroll or zoom.
  const moveBar = useCallback(() => {
    const anchor = computeAnchor();
    if (anchor) setSelection((s) => (s ? { ...s, anchor } : s));
  }, [computeAnchor]);
  const barFrame = useRef(0);
  const onPagesScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    scrollTopRef.current = e.currentTarget.scrollTop;
    if (!selectionRef.current) return;
    cancelAnimationFrame(barFrame.current);
    barFrame.current = requestAnimationFrame(moveBar);
  }, [moveBar]);
  useEffect(() => { if (selectionRef.current) moveBar(); }, [zoom, moveBar]);
  useEffect(() => () => cancelAnimationFrame(barFrame.current), []);

  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const copy = useCallback(async (kind: 'text' | 'source') => {
    const sel = selectionRef.current;
    if (!sel) return;
    const text = kind === 'text' ? sel.text : sel.range ? sourceRef.current.slice(sel.range.from, sel.range.to) : '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(null), 1200);
    } catch { /* clipboard blocked: the highlight is still there for Ctrl+C */ }
  }, []);
  const selectInCode = useCallback(() => {
    const sel = selectionRef.current;
    if (locked || !onSelectInCode || !sel?.range) return;
    onSelectInCode({ from: sel.range.from, to: sel.range.to });
    // The editor's own selection takes over from here: drop the bar and the transient mark.
    clearSelection();
  }, [locked, onSelectInCode, clearSelection]);

  const onPageClick = useCallback((e: React.MouseEvent) => {
    if (locked || (!onRevealSource && !onRevealImage)) return;
    const root = shadowRoot;
    if (!root) return;
    // React listens both on the shadow root (the portal container) and on the
    // document, so a click inside the pages reaches this handler twice: once
    // with the real target, once retargeted to the host. Take the first only.
    if (e.target === shadowHostRef.current) return;
    // Let a text selection drag stay a selection rather than also jumping.
    // Revealing a range selects it in the editor, and that selection shows up
    // here too: in the document's selection, and in Chrome even through the
    // shadow root's own getSelection(), which then reports type "None" with no
    // anchor yet still stringifies to the editor's text. Only a non-empty
    // selection anchored inside the preview is a drag over page text;
    // anything else must not swallow the click, or every click after the
    // first would be dropped.
    const area = pageAreaRef.current;
    const own = (root as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.();
    const insidePreview = (n: Node | null | undefined) => !!n && (root.contains(n) || (!!area && area.contains(n)));
    const isDrag = (s: Selection | null | undefined) =>
      !!s && !!s.toString() && (insidePreview(s.anchorNode) || insidePreview(s.focusNode));
    if (isDrag(own) || isDrag(window.getSelection())) return;
    // The event crossed the shadow boundary, so `e.target` is the host; the
    // real target is the first node on the composed path.
    const first = e.nativeEvent.composedPath?.()[0] as Node | undefined;
    const target = first ? (first.nodeType === 1 ? (first as Element) : first.parentElement) : (e.target as Element | null);
    const card = split ? pageCardAt(root, target, e.clientY) : null;
    const scope: Scope = card ?? root;
    if (onRevealImage) {
      const href = imageHrefAtPoint(scope, e.clientX, e.clientY);
      if (href) { onRevealImage(href); return; }
    }
    if (!onRevealSource) return;
    const hit = textRunAtPoint(scope, e.clientX, e.clientY);
    if (!hit) return;
    const page = card ? Number(card.dataset.pageIndex) : 0;
    // The clicked page's runs come from the DOM just hit-tested; any other
    // page's from the per-compile cache.
    const click: SourceClick = {
      target: {
        page,
        run: hit.index,
        pageCount: split && card ? split.pages.length : 1,
        runsOf: (p) => (p === page ? hit.texts : runsOfPage(p)),
      },
      hint: hintRef.current?.docKey === docKey ? hintRef.current.hint : null,
      candidates: () => fallbackCandidates(hit.texts, hit.index, card ? textRunsBefore(page) : []),
    };
    const range = onRevealSource(click);
    if (range) hintRef.current = { docKey, hint: { page, run: hit.index, from: range.from } };
  }, [locked, onRevealSource, onRevealImage, split, runsOfPage, textRunsBefore, shadowRoot, shadowHostRef, docKey]);

  const zoomIn = useCallback(() => setZoom((z) => Math.min(MAX_ZOOM, +(z + 0.1).toFixed(2))), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(MIN_ZOOM, +(z - 0.1).toFixed(2))), []);
  const resetZoom = useCallback(() => setZoom(1), []);

  return (
    <div ref={wrapRef} className="relative flex h-full flex-col bg-[hsl(var(--muted)/0.35)]">
      {/* Toolbar */}
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
          {compiling ? (
            <>
              <Loader2 size={11} className="animate-spin" /> Rendering
            </>
          ) : errors.length > 0 ? (
            <span className="text-[hsl(var(--status-red))]">{errors.length} error{errors.length > 1 ? 's' : ''}</span>
          ) : (
            'Preview'
          )}
          {locked && (
            <span className="flex items-center gap-1" title="Preview locked: clicks won't open the code">
              <Lock size={11} /> Locked
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={zoomOut} title="Zoom out" className="rounded p-1 hover:bg-[hsl(var(--accent))]">
            <ZoomOut size={13} />
          </button>
          <button onClick={resetZoom} title="Reset zoom" className="min-w-[42px] rounded px-1 py-0.5 text-center font-mono text-[10px] hover:bg-[hsl(var(--accent))]">
            {Math.round(zoom * 100)}%
          </button>
          <button onClick={zoomIn} title="Zoom in" className="rounded p-1 hover:bg-[hsl(var(--accent))]">
            <ZoomIn size={13} />
          </button>
          <button onClick={resetZoom} title="Fit width" className="rounded p-1 hover:bg-[hsl(var(--accent))]">
            <Maximize size={13} />
          </button>
        </div>
      </div>

      {/* Error banner (overlaps the last good render) */}
      {fatalError ? (
        <div className="flex items-start gap-2 border-b border-[hsl(var(--status-red))]/40 bg-[hsl(var(--status-red))]/10 px-3 py-2 text-[11px] text-[hsl(var(--status-red))]">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span className="font-mono">{fatalError}</span>
        </div>
      ) : errors.length > 0 ? (
        <div className="max-h-32 shrink-0 overflow-y-auto border-b border-[hsl(var(--status-red))]/40 bg-[hsl(var(--status-red))]/10 px-3 py-2">
          {errors.map((d, i) => (
            <div key={i} className="flex items-start gap-2 text-[11px] text-[hsl(var(--status-red))]">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span className="font-mono">
                {(d.path || d.range) && (
                  <span className="opacity-70">{[d.path, d.range].filter(Boolean).join(':')}: </span>
                )}
                {d.message}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Rendered document. `contain` isolates the page cards so resizing
          the pane doesn't relayout them beyond this box. */}
      <div
        ref={pageAreaRef}
        data-testid="preview-pages"
        onClick={onPageClick}
        onScroll={onPagesScroll}
        title={locked ? 'Locked: select and copy text freely. Unlock to jump to the code.' : onRevealSource ? 'Click the page to jump to that spot in the code' : undefined}
        className={`relative flex-1 overflow-auto p-6 ${locked ? 'cursor-text' : onRevealSource ? 'cursor-pointer' : ''}`}
        style={{ contain: 'layout paint' }}
      >
        {firstLoad && !svg ? (
          <div className="flex h-full items-center justify-center text-center text-xs text-[hsl(var(--muted-foreground))]">
            <div className="flex flex-col items-center gap-2">
              <Loader2 size={18} className="animate-spin" />
              {ready ? 'Loading the Typst compiler…' : 'Opening…'}
              {ready && <span className="text-[10px] opacity-70">(first render initializes the local WASM engine)</span>}
            </div>
          </div>
        ) : !svg && (compiling || !ready) ? (
          // A document never rendered this session: nothing to show until the
          // compile lands, and the previous document's pages must not stand in.
          <div className="flex h-full items-center justify-center text-xs text-[hsl(var(--muted-foreground))]">
            <div className="flex flex-col items-center gap-2"><Loader2 size={18} className="animate-spin" />Rendering…</div>
          </div>
        ) : svg ? null : (
          <div className="flex h-full items-center justify-center text-xs text-[hsl(var(--muted-foreground))]">
            Nothing to render yet: start typing Typst on the left.
          </div>
        )}
        {/* The pages live in this element's shadow root (see SHADOW_CSS). */}
        <div ref={shadowHostRef} data-testid="preview-shadow-host" />
        {shadowRoot && svg && createPortal(
          <>
            <style>{SHADOW_CSS}</style>
            {/* `will-change: transform` promotes the page stack to its own
                layer, so zooming and pane-resizing composite instead of
                repainting the document. */}
            {/* `locked`: typst.ts covers every link (TOC entries, cross-
                references) with a `.pseudo-link` rect that takes the pointer,
                so a drag starting on linked text would select nothing useful.
                Locked, the rect lets the pointer through to the text layer. */}
            <div className={locked ? 'stack locked' : 'stack'} style={{ transform: `scale(${zoom})` }}>
              {/* SVG is produced by the local WASM compiler from the operator's own
                  source (no remote input): consistent with the app's trusted-LAN
                  threat model. */}
              {split && shared ? (
                <>
                  <SharedStyle css={shared.css} />
                  <SharedDefs markup={shared.defs} />
                  <div className="pages">
                    {split.pages.map((page, i) => (
                      <PageCard
                        key={i}
                        index={i}
                        tid={page.tid}
                        width={page.width}
                        height={page.height}
                        body={page.body}
                        scrollRoot={pageAreaRef}
                      />
                    ))}
                  </div>
                </>
              ) : (
                // Not a paged typst.ts document: mount it whole on one card.
                <div className="whole" dangerouslySetInnerHTML={{ __html: svg }} />
              )}
            </div>
          </>,
          shadowRoot,
        )}
      </div>
      {selection && (
        <PreviewSelectionBar
          anchor={selection.anchor}
          bounds={{ w: wrapRef.current?.clientWidth ?? 0, h: wrapRef.current?.clientHeight ?? 0 }}
          approximate={!!selection.range?.approximate}
          canSource={!!selection.range}
          canSelect={!locked && !!onSelectInCode && !!selection.range}
          copied={copied}
          onCopy={() => void copy('text')}
          onCopySource={() => void copy('source')}
          onSelect={selectInCode}
        />
      )}
    </div>
  );
});

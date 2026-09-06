// ─────────────────────────────────────────────────────────────────────────
// Per-page handling of a rendered Typst document.
//
// typst.ts renders a multi-page document into ONE <svg> with each page as a
// `<g class="typst-page" transform="translate(x,y)" data-page-width=W
// data-page-height=H>` stacked vertically with ZERO gap and NO page background
// (pages are transparent). The preview shows them typst.app-style instead:
// each page on its own white card, separated by a gap, and mounted only
// while it is near the viewport (see `splitTypstPages`).
// ─────────────────────────────────────────────────────────────────────────

/** Gap between pages in the preview, in CSS px at 100% zoom. */
export const DEFAULT_PAGE_GAP = 24;

// Matches a top-level page group's opening tag as emitted by typst.ts 0.7.
// Attribute order is stable: class, transform, data-tid, data-page-width,
// data-page-height. If the format ever changes this simply matches nothing and
// the caller falls back to mounting the whole document.
const PAGE_TAG_RE =
  /<g class="typst-page" transform="translate\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)" data-tid="([^"]*)" data-page-width="([\d.]+)" data-page-height="([\d.]+)">/g;

// ─────────────────────────────────────────────────────────────────────────
// Splitting a rendered document into per-page fragments.
//
// The preview mounts pages individually (see components/typst/TypstPreview):
// only the pages near the viewport are in the DOM, and a page whose markup
// did not change between two compiles keeps the DOM it already has. Both
// depend on carving the single <svg> typst.ts emits into a shared prelude and
// one self-contained fragment per page.
//
// Why it matters: a long report renders to tens of thousands of SVG nodes
// (one <use> per glyph, one position:fixed <div> per text run). Committing
// that whole tree after every keystroke pause costs seconds of main-thread
// time in style/layout/paint, while the compile itself takes tens of ms.
// ─────────────────────────────────────────────────────────────────────────

/** One page of a split document. */
export interface TypstPageFragment {
  /** typst.ts's content id for the page; stable while the page is unchanged. */
  tid: string;
  /** Page size in SVG user units (pt). */
  width: number;
  height: number;
  /**
   * The page's `<g class="typst-page">…</g>`, with its translate reset to the
   * origin so it can be mounted in its own `<svg viewBox="0 0 w h">`.
   */
  body: string;
}

export interface SplitTypstSvg {
  /**
   * Everything the pages share: the stylesheet and the glyph/clip-path
   * <defs>. Mounted once, in a hidden <svg>; the pages' <use href="#…"> and
   * clip-path="url(#…)" references resolve document-wide.
   */
  shared: string;
  pages: TypstPageFragment[];
}

// Opening tags of every <g> (depth +1 unless self-closing) and every </g>.
const GROUP_TOKEN_RE = /<g\b[^>]*>|<\/g>/g;

/**
 * Offset just past the `</g>` that closes the group opening at `openStart`,
 * or -1 if it never closes.
 */
function findGroupEnd(svg: string, openStart: number): number {
  GROUP_TOKEN_RE.lastIndex = openStart;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = GROUP_TOKEN_RE.exec(svg)) !== null) {
    const tok = m[0];
    if (tok === '</g>') {
      depth--;
      if (depth === 0) return m.index + tok.length;
    } else if (!tok.endsWith('/>')) {
      depth++;
    }
  }
  return -1;
}

/**
 * Split a typst.ts document SVG into its shared prelude and per-page
 * fragments. Returns null when the input is not recognized (empty, not an
 * <svg>, no page groups, or a page group that never closes), in which case
 * the caller should fall back to mounting the whole string.
 *
 * Pure and deterministic: the same page markup always yields the same
 * fragment string, which is what lets the preview skip re-mounting it.
 */
export function splitTypstPages(svg: string): SplitTypstSvg | null {
  if (!svg.startsWith('<svg')) return null;
  const rootTagEnd = svg.indexOf('>');
  if (rootTagEnd === -1) return null;

  const pages: TypstPageFragment[] = [];
  let shared: string | null = null;
  const tagRe = new RegExp(PAGE_TAG_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(svg)) !== null) {
    const [tag, , , tid, w, h] = m;
    if (shared === null) shared = svg.slice(rootTagEnd + 1, m.index).trim();
    const end = findGroupEnd(svg, m.index);
    if (end === -1) return null;
    const inner = svg.slice(m.index + tag.length, end);
    pages.push({
      tid: tid!,
      width: parseFloat(w!),
      height: parseFloat(h!),
      body:
        `<g class="typst-page" transform="translate(0, 0)" data-tid="${tid}" ` +
        `data-page-width="${w}" data-page-height="${h}">` + inner,
    });
    tagRe.lastIndex = end;
  }
  if (shared === null || pages.length === 0) return null;
  return { shared, pages };
}

/**
 * The text of every selection run (`<foreignObject>` → `.tsel`) in a page
 * fragment, in document order, as the live DOM's `textContent` would report
 * it (entities decoded, nested spans flattened).
 *
 * Used for pages that are not mounted: click-to-source needs the runs of
 * every page *before* the clicked one to count which occurrence of a string
 * was clicked, and an off-screen page has no DOM to read them from. Parsing
 * with the HTML parser (not XML) matches how innerHTML parses the same
 * markup, so the two agree on things like `&nbsp;`.
 */
export function extractTextRuns(fragment: string): string[] {
  const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${fragment}</svg>`, 'text/html');
  return Array.from(doc.querySelectorAll('foreignObject')).map((o) => o.textContent ?? '');
}

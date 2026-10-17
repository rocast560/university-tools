// ─────────────────────────────────────────────────────────────────────────
// Mapping a click in the rendered preview back to a position in the source.
//
// typst.ts's SVG output carries a hidden text-selection layer: every rendered
// line of text appears verbatim inside a `<foreignObject><div class="tsel">`
// ("run"). That gives us the literal strings the user is looking at, and we
// find where they came from by aligning them against the source.
//
// Why not the "proper" route: the renderer exposes `session.getSourceLoc()`,
// which resolves an element path to a Typst span. But spans are only embedded
// when the compiler has debug info attached, and typst.ts's shipped wasm
// ignores that switch (see docs/research/2026-10-17-preview-source-mapping.md),
// so a rendered document carries no spans. Text alignment needs no compiler
// cooperation and degrades gracefully.
//
// How (phase 1, context-aware alignment):
//
//  1. `projectSource` turns the source into the text a reader would see: only
//     text-bearing characters, markup marks stripped, `--` / `...` / quotes
//     folded the way the renderer rewrites them, `#set`/`#show`/`#let`
//     statements and comments gone. Every projected character remembers the
//     source offset it came from (parallel `Int32Array`s), so length-changing
//     rules cost nothing. Generated text can't be known in advance, so
//     `#variable`, `#helper(...)`, `$math$`, `@ref` and `{{PLACEHOLDER}}`
//     project as a WILDCARD that absorbs whatever the renderer printed there.
//     Text inside design statements (a `#set page(header: [...])`, a helper's
//     body) goes to a second, "design" layer that is only consulted when the
//     body has no match, so styling never steals a click from prose.
//     Pure, DOM-free, memoised on the source string. It deliberately uses a
//     small hand-written scanner rather than CodeMirror/Lezer: CLAUDE.md keeps
//     CodeMirror inside TypstEditor.tsx so its chunk stays lazy.
//
//  2. `resolveClick` builds a window from the clicked run and its neighbours
//     (`buildWindow`), finds candidate places in the projection with a 4-gram
//     index (`seedWindows`), and scores each with a local, weighted
//     Smith-Waterman alignment (`alignDp`) in which wildcards are cheap gaps.
//     Context decides the place, not an occurrence count: a repeated "Severity"
//     is resolved by the cells around it, and when two places still tie the
//     window is widened and then the position prior (the previous match, else
//     the click's fraction of the document) picks one.
//
//  3. The traceback says which projected characters the clicked run aligned
//     to, hence a source range. A run that did not align (a heading counter,
//     a page number) hands over to its neighbours, as the old search did; a
//     run that exists only in the design layer lands on the helper's call
//     site when there is one.
//
//  4. If none of that works, `resolveSourceClick` falls back to the original
//     progressive text search, `findSourceRange`, so a click never does less
//     than it used to.
//
// Cost: the projection and its gram index are built once per source text; a
// click aligns a few hundred characters against a handful of 500-character
// windows. Nothing here runs per keystroke, and nothing touches the worker,
// the per-page SVG split or the shadow root.
// ─────────────────────────────────────────────────────────────────────────

export interface SourceRange {
  from: number;
  to: number;
}

/**
 * Canonicalize typographic variants so rendered text can be matched against
 * the source that produced it.
 *
 * Every rule here is strictly **one character in, one character out**. The
 * search runs on the normalized string but reports offsets into the original,
 * so any rule that changed the length would silently skew every result.
 * (That's why `--` → en dash isn't handled here: it's 2:1. The fallbacks
 * below cover it instead, and the alignment mapper's projection handles it
 * with per-character offsets.)
 */
export function normalizeForMatch(text: string): string {
  let out = '';
  for (const ch of text) {
    switch (ch) {
      // Smart quotes: Typst applies these automatically.
      case '‘': case '’': case '‚': case '‛':
        out += "'"; break;
      case '“': case '”': case '„': case '‟':
        out += '"'; break;
      // Spaces of every width.
      case '\u00a0': case '\u2002': case '\u2003': case '\u2004': case '\u2005':
      case '\u2006': case '\u2007': case '\u2008': case '\u2009': case '\u200a':
      case '\u202f': case '\u205f': case '\u3000':
        out += ' '; break;
      // Dashes and the non-breaking hyphen.
      case '‐': case '‑': case '‒': case '–': case '—':
      case '−':
        out += '-'; break;
      default:
        out += ch;
    }
  }
  return out;
}

/** All indices at which `needle` occurs in `haystack`. */
function allIndicesOf(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    out.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return out;
}

/** A line that opens a "design" statement: layout/config, not prose. */
const DESIGN_DIRECTIVE = /^#(set|show|let|import|include)\b/;

/**
 * Character ranges occupied by **design** statements: page setup, `#set`/`#show`
 * rules, imports, and helper `#let` definitions (e.g. the `image-placeholder`
 * helper). Text that lives *only* inside one of these controls how the document
 * looks, not what it says, so a click on rendered prose should never land
 * there when the same words also exist as editable body content.
 *
 * A region starts at a line that, at bracket depth 0, begins with a design
 * directive, and runs until the statement's brackets/braces have all closed:
 * the first line end at which depth has returned to 0. That one rule covers
 * every shape uniformly, because depth simply stays > 0 until the whole thing
 * is closed:
 *   - one-liners            `#set heading(numbering: "1.1")`
 *   - multi-line calls      `#set page(\n  header: [Confidential]\n)`
 *   - brace-bodied helpers  `#let ph(c, ..) = figure( ... )`
 *
 * Pure and offset-exact: because `normalizeForMatch` is 1:1 per character, the
 * offsets returned here index the normalized haystack and the original source
 * identically.
 */
export function designRegions(source: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  let depth = 0;
  let start = -1; // start offset of the region we're inside, or -1
  let lineStart = true;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;

    // At the first non-space of a fresh line, and only when we're not already
    // inside a region and all brackets are balanced, decide whether this line
    // opens a design statement.
    if (lineStart && start === -1 && depth === 0 && ch !== ' ' && ch !== '\t') {
      if (DESIGN_DIRECTIVE.test(source.slice(i, i + 9))) start = i;
      lineStart = false;
    } else if (ch !== ' ' && ch !== '\t') {
      lineStart = false;
    }

    switch (ch) {
      // Brackets only matter inside a region: a stray `(` in prose used to
      // leave the depth at 1 forever and hide every later design line.
      case '(': case '[': case '{': if (start !== -1) depth++; break;
      case ')': case ']': case '}': if (start !== -1 && depth > 0) depth--; break;
      case '\n':
        if (start !== -1 && depth === 0) {
          regions.push([start, i]);
          start = -1;
        }
        lineStart = true;
        break;
    }
  }
  if (start !== -1) regions.push([start, source.length]);
  return regions;
}

/** Whether `offset` falls inside any design region. */
function inDesignRegion(offset: number, regions: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [s, e] of regions) if (offset >= s && offset < e) return true;
  return false;
}

/**
 * Choose the match to jump to among every occurrence of `needle`.
 *
 * Body prose the user can edit is preferred over identical text buried in a
 * design region: clicking "Confidential" in the page body must not land in the
 * `#set page(header: [Confidential])` that also renders it. Filtering the
 * design occurrences out first *also* realigns the occurrence index: the
 * rendered runs we count against are (mostly) body content, so counting only
 * body matches makes the Nth click select the Nth body instance.
 *
 * Only when there is no body match at all do we fall back to the design
 * occurrences, so a click never dead-ends when the sole source is a directive.
 */
function chooseMatch(
  haystack: string,
  needle: string,
  occurrence: number,
  regions: ReadonlyArray<readonly [number, number]>,
): number | null {
  const all = allIndicesOf(haystack, needle);
  if (all.length === 0) return null;
  const body = all.filter((i) => !inDesignRegion(i, regions));
  return pickIndex(body.length > 0 ? body : all, occurrence);
}

/**
 * Pick the `occurrence`-th hit, clamping rather than failing.
 *
 * Render order and source order can diverge (a floating figure, a footnote),
 * so an out-of-range index means our count was off, not that there's no
 * match. Landing on the last plausible hit is far more useful than doing
 * nothing.
 */
function pickIndex(indices: number[], occurrence: number): number | null {
  if (indices.length === 0) return null;
  const i = Math.min(Math.max(occurrence, 0), indices.length - 1);
  return indices[i]!;
}

/** The longest word in `text`, used as a last-resort anchor. */
function longestWord(text: string): string | null {
  const words = text.split(/[^\p{L}\p{N}_-]+/u).filter((w) => w.length >= 4);
  if (words.length === 0) return null;
  return words.reduce((a, b) => (b.length > a.length ? b : a));
}

/**
 * Locate rendered `text` in `source`, returning the range to select.
 *
 * Tries progressively looser strategies, because rendered text is not always
 * a literal substring of what produced it:
 *
 *   1. the whole string,
 *   2. whitespace-collapsed (markup can introduce line breaks mid-sentence),
 *   3. the first clause, cut at a dash or punctuation Typst may have rewritten,
 *   4. the longest single word, which survives almost any transformation.
 *
 * Every strategy prefers an editable body match over one inside a design
 * region (see `chooseMatch`), so a click lands on the prose to edit rather
 * than on the styling that formats it.
 *
 * Returns null only when nothing recognizable is found, so the caller can
 * leave the cursor where it is rather than jumping somewhere wrong.
 *
 * This is the fallback of the alignment mapper (`resolveSourceClick`).
 */
export function findSourceRange(
  source: string,
  text: string,
  occurrence = 0,
): SourceRange | null {
  const haystack = normalizeForMatch(source);
  const needle = normalizeForMatch(text).trim();
  if (needle.length < 2) return null;

  const regions = designRegions(source);

  // 1. Exact.
  let at = chooseMatch(haystack, needle, occurrence, regions);
  if (at !== null) return { from: at, to: at + needle.length };

  // 2. Collapse runs of whitespace in the needle and retry against a source
  //    whose whitespace has been collapsed the same way. Both transforms are
  //    length-preserving per character, so offsets stay meaningful only if we
  //    search the *original* haystack, so instead, split on whitespace and
  //    anchor on the longest contiguous fragment.
  const fragments = needle.split(/\s+/).filter((f) => f.length >= 3);
  if (fragments.length > 1) {
    const anchor = fragments.reduce((a, b) => (b.length > a.length ? b : a));
    at = chooseMatch(haystack, anchor, occurrence, regions);
    if (at !== null) return { from: at, to: at + anchor.length };
  }

  // 3. First clause, before any character Typst commonly rewrites.
  const clause = needle.split(/[–—\-,;:]/)[0]?.trim() ?? '';
  if (clause.length >= 4) {
    at = chooseMatch(haystack, clause, occurrence, regions);
    if (at !== null) return { from: at, to: at + clause.length };
  }

  // 4. Longest word.
  const word = longestWord(needle);
  if (word) {
    at = chooseMatch(haystack, word, occurrence, regions);
    if (at !== null) return { from: at, to: at + word.length };
  }

  return null;
}

/**
 * Which occurrence of `text` this is, among `allTexts` in render order.
 *
 * Repeated strings ("Severity", a recurring table header) would otherwise all
 * jump to the first one in the source. Counting identical earlier runs lets
 * the Nth rendered instance select the Nth source instance.
 */
export function occurrenceIndex(allTexts: readonly string[], index: number): number {
  const target = normalizeForMatch(allTexts[index] ?? '').trim();
  let n = 0;
  for (let i = 0; i < index; i++) {
    if (normalizeForMatch(allTexts[i] ?? '').trim() === target) n++;
  }
  return n;
}

// ═════════════════════════════════════════════════════════════════════════
// The old search's inputs: candidates, best guess first.
// ═════════════════════════════════════════════════════════════════════════

/** One guess at what a preview click corresponds to in the source. */
export interface SourceCandidate {
  text: string;
  occurrence: number;
}

/**
 * A rendered run that Typst generated rather than the author typing it:
 * a heading number, a figure counter. These have no source text to jump to,
 * so they're tried *after* their neighbours.
 *
 * Deliberately narrow: a short run of digits and dots. Real content that
 * looks numeric (an IP like `10.0.0.5`, a CVSS score in a table) stays a
 * first-class candidate.
 */
export function looksAutoGenerated(text: string): boolean {
  return /^[\d.]{1,4}$/.test(text.trim());
}

/**
 * The candidates the original mapper tried for a click on run `index` of
 * `texts` (one page's runs), best guess first: the run, then its neighbours,
 * so a heading's counter lands on the heading and a run Typst transformed
 * beyond recognition doesn't dead-end when the run beside it would resolve.
 *
 * `precedingTexts` are the runs of every page before this one: an occurrence
 * index only means something counted from the start of the document.
 */
export function fallbackCandidates(
  texts: readonly string[],
  index: number,
  precedingTexts: readonly string[] = [],
): SourceCandidate[] {
  if (index < 0 || index >= texts.length) return [];
  const order = [index, index + 1, index - 1, index + 2];
  if (looksAutoGenerated(texts[index]!)) {
    // A counter has no source of its own: prefer the content it labels.
    order.splice(0, 1);
    order.push(index);
  }
  const allTexts = precedingTexts.length > 0 ? [...precedingTexts, ...texts] : texts;
  const offset = precedingTexts.length;
  const seen = new Set<number>();
  const candidates: SourceCandidate[] = [];
  for (const i of order) {
    if (i < 0 || i >= texts.length || seen.has(i)) continue;
    seen.add(i);
    if (!texts[i]!.trim()) continue;
    candidates.push({ text: texts[i]!, occurrence: occurrenceIndex(allTexts, offset + i) });
  }
  return candidates;
}

/** The first candidate `findSourceRange` can place: the original mapper. */
export function findByCandidates(source: string, candidates: readonly SourceCandidate[]): SourceRange | null {
  for (const c of candidates) {
    const hit = findSourceRange(source, c.text, c.occurrence);
    if (hit) return hit;
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════
// The source projection
// ═════════════════════════════════════════════════════════════════════════

/** Stands in the projection for text the renderer generates (a variable, a helper call, math, a reference). */
export const WILDCARD = '\u0001';
const WILD = 1;

/** A string of text-bearing characters, each tied to the source it came from. */
export interface ProjectionLayer {
  /** Folded (lowercase, straight quotes, plain dashes), single-spaced; WILDCARD for generated text. */
  text: string;
  codes: Uint16Array;
  /** Source offset of each character, and the exclusive end (a `--` is one character spanning two). */
  from: Int32Array;
  to: Int32Array;
  /** 4-gram index, built on first use. */
  grams?: GramIndex;
}

/** A `#let name` statement: the text of its body renders wherever `name` is used. */
export interface HelperDef {
  name: string;
  from: number;
  to: number;
}

export interface SourceProjection extends ProjectionLayer {
  /** Text that only lives in design statements (`#set page(header: ...)`, helper bodies). */
  design: ProjectionLayer;
  helpers: HelperDef[];
  /** Every `#name` use in the body, in source order. */
  sites: Map<string, SourceRange[]>;
}

/** One rendered or source character in the form both sides are compared in. */
function foldChar(ch: string): string {
  const c = ch.charCodeAt(0);
  if (ch.length === 1 && c < 128) {
    if (c >= 65 && c <= 90) return String.fromCharCode(c + 32);
    if (c === 9 || c === 10 || c === 13 || c === 12) return ' ';
    return ch;
  }
  switch (ch) {
    case '‘': case '’': case '‚': case '‛': return "'";
    case '“': case '”': case '„': case '‟': return '"';
    case '‐': case '‑': case '‒': case '–': case '—': case '−': return '-';
    case '…': return '.';
    case '\u00ad': case '\u2060': case '\u200b': case '\ufeff': return ''; // soft hyphen, word joiner, zero-width
  }
  // Math alphanumerics (𝐻), ligatures, no-break and thin spaces: NFKC folds them to what they stand for.
  const n = ch.normalize('NFKC');
  if (n === '' || n === ' ') return n === '' ? '' : ' ';
  const first = String.fromCodePoint(n.codePointAt(0)!);
  const low = first.toLowerCase();
  const out = low.length === first.length ? low : first;
  return /\s/.test(out) ? ' ' : out;
}

class LayerBuilder {
  private chars: string[] = [];
  private from: number[] = [];
  private to: number[] = [];
  /** Starts as a space so leading whitespace is dropped. */
  private last = ' ';

  push(ch: string, from: number, to: number): void {
    const f = foldChar(ch);
    if (f === '' || (f === ' ' && this.last === ' ')) return;
    this.chars.push(f);
    this.from.push(from);
    this.to.push(to);
    this.last = f;
  }

  space(at: number): void { this.push(' ', at, at); }

  /** Index of the wildcard entry; consecutive wildcards merge into one. */
  wildcard(from: number, to: number): number {
    if (this.last === WILDCARD) {
      this.to[this.to.length - 1] = to;
      return this.chars.length - 1;
    }
    this.chars.push(WILDCARD);
    this.from.push(from);
    this.to.push(to);
    this.last = WILDCARD;
    return this.chars.length - 1;
  }

  setEnd(index: number, to: number): void { this.to[index] = to; }

  build(): ProjectionLayer {
    const text = this.chars.join('');
    const codes = new Uint16Array(this.chars.length);
    for (let i = 0; i < this.chars.length; i++) codes[i] = this.chars[i]!.charCodeAt(0);
    return { text, codes, from: Int32Array.from(this.from), to: Int32Array.from(this.to) };
  }
}

/** Functions whose bare string arguments are not rendered text (paths, colours, formats...). */
const NON_TEXT_FUNCTIONS = new Set([
  'image', 'rgb', 'color', 'luma', 'cmyk', 'oklab', 'oklch', 'link', 'include', 'import', 'show', 'set', 'read',
  'csv', 'json', 'yaml', 'toml', 'xml', 'cbor', 'bibliography', 'cite', 'label', 'ref', 'numbering', 'datetime',
  'regex', 'version', 'str', 'int', 'float', 'calc', 'range', 'font', 'counter', 'state', 'query', 'metadata',
  'lorem', 'sym', 'symbol', 'selector', 'locate',
]);
/** Named arguments whose string value is rendered text. */
const TEXT_ARGUMENTS = new Set(['caption', 'title', 'body', 'header', 'footer', 'content', 'description', 'supplement', 'text']);
/** `#word` that prints nothing (or nothing we can predict) when used bare. */
const SILENT_WORDS = new Set(['none', 'auto', 'true', 'false', 'pagebreak', 'parbreak', 'linebreak', 'colbreak', 'hide', 'sym']);
const STATEMENTS = new Set(['set', 'show', 'let', 'import', 'include']);
const CONTROL = new Set(['if', 'for', 'while', 'else']);

const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdChar = (c: string) => /[A-Za-z0-9_-]/.test(c);
const isWordChar = (c: string) => c !== '' && /[\p{L}\p{N}]/u.test(c);

/** Walk the source once and build both layers. */
function buildProjection(src: string): SourceProjection {
  const n = src.length;
  const at = (i: number) => src.charAt(i);
  const body = new LayerBuilder();
  const design = new LayerBuilder();
  /** Sink for statements that render nothing (`#set` in the middle of a line). */
  const sink = new LayerBuilder();
  const helpers: HelperDef[] = [];
  const sites = new Map<string, SourceRange[]>();
  const helperFns = new Set<string>();
  for (const m of src.matchAll(/#let\s+([A-Za-z_][\w-]*)\s*\(/g)) helperFns.add(m[1]!);

  const atLineStart = (i: number): boolean => {
    let j = i - 1;
    while (j >= 0 && (src[j] === ' ' || src[j] === '\t')) j--;
    return j < 0 || src[j] === '\n';
  };

  const readIdent = (i: number): string => {
    let j = i;
    while (j < n && isIdChar(at(j))) j++;
    // A trailing hyphen is a minus or a dash, not part of the name.
    while (j > i + 1 && at(j - 1) === '-') j--;
    return src.slice(i, j);
  };

  /** `{{NAME}}` at `i`: the index just after it, else -1. */
  const placeholderEnd = (i: number): number => {
    if (at(i) !== '{' || at(i + 1) !== '{') return -1;
    const close = src.indexOf('}}', i + 2);
    if (close === -1 || close - i > 90 || src.slice(i, close).includes('\n')) return -1;
    return close + 2;
  };

  /** A string literal at `i` (the opening quote); index after the closing quote. */
  const readString = (i: number, out: LayerBuilder, keep: boolean): number => {
    let j = i + 1;
    while (j < n && at(j) !== '"') {
      const ch = at(j);
      if (ch === '\\' && j + 1 < n) {
        if (keep) {
          const e = at(j + 1);
          if (e === 'n' || e === 't' || e === 'r') out.space(j);
          else if (e === 'u' && at(j + 2) === '{') { const c = src.indexOf('}', j); if (c !== -1) { j = c + 1; continue; } }
          else out.push(e, j, j + 2);
        }
        j += 2;
        continue;
      }
      if (keep) {
        const pe = placeholderEnd(j);
        if (pe !== -1) { out.wildcard(j, pe); j = pe; continue; }
        out.push(ch, j, j + 1);
      }
      j++;
    }
    if (keep) out.space(j);
    return j + 1;
  };

  /** Skip a `//` or nested block comment at `i`; the index after it, or -1 if there is none. */
  const skipComment = (i: number): number => {
    if (at(i) !== '/') return -1;
    if (at(i + 1) === '/' && at(i - 1) !== ':') {
      const nl = src.indexOf('\n', i);
      return nl === -1 ? n : nl;
    }
    if (at(i + 1) === '*') {
      let depth = 1, j = i + 2;
      while (j < n && depth > 0) {
        if (at(j) === '/' && at(j + 1) === '*') { depth++; j += 2; }
        else if (at(j) === '*' && at(j + 1) === '/') { depth--; j += 2; }
        else j++;
      }
      return j;
    }
    return -1;
  };

  /**
   * Code mode: strings and content blocks are text, everything else is
   * structure. Runs to the `stop` bracket (consumed), `end`, or, with
   * `lineBound`, the end of the statement's line. `stopAtBlock` ends a control
   * flow head at its `[` or `{`, which is left for the caller.
   */
  function scanCode(
    i: number, end: number, out: LayerBuilder, stop: ')' | '}' | null, fname: string,
    lineBound = false, stopAtBlock = false,
  ): number {
    let j = i;
    let argName: string | null = null;
    let chain = '';
    let chainEnd = -1;
    while (j < end) {
      const ch = at(j);
      if (ch === '\n' && lineBound && stop === null) return j;
      if (ch === '"') {
        const keep = argName !== null ? TEXT_ARGUMENTS.has(argName) : !NON_TEXT_FUNCTIONS.has(fname.split('.')[0]!);
        j = readString(j, out, keep);
        continue;
      }
      if (ch === '[') {
        if (stopAtBlock && stop === null) return j;
        j = scanMarkup(j + 1, end, out, true);
        out.space(j);
        continue;
      }
      if (ch === '{') {
        if (stopAtBlock && stop === null) return j;
        j = scanCode(j + 1, end, out, '}', fname);
        continue;
      }
      if (ch === '(') {
        const name = chainEnd === j ? chain : '';
        j = scanCode(j + 1, end, out, ')', name || fname);
        continue;
      }
      if (ch === ')' || ch === '}') {
        j++;
        if (ch === stop) return j;
        continue;
      }
      if (ch === '/') {
        const c = skipComment(j);
        if (c !== -1) { j = c; continue; }
      }
      if (ch === '$') {
        const close = src.indexOf('$', j + 1);
        j = close === -1 ? end : close + 1;
        continue;
      }
      if (isIdStart(ch)) {
        const id = readIdent(j);
        const prevAdjacent = chainEnd === j - 1 && at(j - 1) === '.';
        chain = prevAdjacent ? `${chain}.${id}` : id;
        j += id.length;
        chainEnd = j;
        if (at(j) === ':' && at(j + 1) !== ':') argName = id;
        continue;
      }
      if (ch === '.' && chainEnd === j) { chainEnd = j + 1; j++; continue; } // keep the chain alive across the dot
      if (ch === ',' || ch === ';') argName = null;
      j++;
    }
    return j;
  }

  /** `#...` at `i`: the index after the expression. */
  function scanHash(i: number, end: number, out: LayerBuilder): number {
    const c = at(i + 1);
    if (c === '(' || c === '{') {
      const w = out.wildcard(i, i + 2);
      const j = scanCode(i + 2, end, out, c === '(' ? ')' : '}', '');
      out.setEnd(w, j);
      return j;
    }
    if (!isIdStart(c)) { out.push('#', i, i + 1); return i + 1; }
    const ident = readIdent(i + 1);
    let k = i + 1 + ident.length;

    if (STATEMENTS.has(ident)) {
      // A statement renders nothing. At the start of a line it runs to the end
      // of the line (or until its brackets close); in the middle of one it is
      // just its call.
      if (atLineStart(i)) return scanCode(k, end, sink, null, ident, true);
      while (k < end && (at(k) === '(' || at(k) === '.' || isIdChar(at(k)))) {
        if (at(k) === '(') k = scanCode(k + 1, end, sink, ')', ident);
        else k++;
      }
      return k;
    }

    if (CONTROL.has(ident)) {
      // `#if cond [..] else [..]`, `#for x in xs [..]`: the head's strings are
      // text (a loop over literals), the branches are content or code.
      let kw = ident;
      for (;;) {
        k = scanCode(k, end, out, null, kw, false, true);
        if (at(k) === '[') k = scanMarkup(k + 1, end, out, true);
        else if (at(k) === '{') k = scanCode(k + 1, end, out, '}', kw);
        else return k;
        if (kw === 'for' || kw === 'while') return k;
        let m = k;
        while (m < end && /\s/.test(at(m))) m++;
        if (src.startsWith('else', m) && !isIdChar(at(m + 4))) { k = m + 4; kw = 'else'; continue; }
        return k;
      }
    }

    let name = ident;
    let hasCall = false;
    let hasContent = false;
    // A user helper's output is generated text the arguments only hint at.
    const generated = (helperFns.has(ident) && at(k) === '(') || ident === 'lorem';
    const w = generated ? out.wildcard(i, k) : -1;
    for (;;) {
      const ch = at(k);
      if (ch === '.' && isIdStart(at(k + 1))) {
        const id2 = readIdent(k + 1);
        name += `.${id2}`;
        k += 1 + id2.length;
        continue;
      }
      if (ch === '(') { k = scanCode(k + 1, end, out, ')', name); hasCall = true; continue; }
      if (ch === '[') { k = scanMarkup(k + 1, end, out, true); hasContent = true; continue; }
      break;
    }
    if (w !== -1) out.setEnd(w, k);
    else if (!hasCall && !hasContent) { if (!SILENT_WORDS.has(ident)) out.wildcard(i, k); }
    else if ((ident === 'link' && !hasContent) || ident === 'context') out.wildcard(i, k);
    if (out === body) {
      const list = sites.get(ident);
      if (list) list.push({ from: i, to: k }); else sites.set(ident, [{ from: i, to: k }]);
    }
    return k;
  }

  /**
   * Markup mode: prose with marks. `inBlock` ends at the `]` that closes the
   * content block (nested brackets are literal text in Typst, so they count).
   */
  function scanMarkup(i: number, end: number, out: LayerBuilder, inBlock: boolean): number {
    let j = i;
    let depth = 0;
    while (j < end) {
      const ch = at(j);
      switch (ch) {
        case '\\': {
          const e = at(j + 1);
          if (e === '' || /\s/.test(e)) out.space(j);
          else if (e === 'u' && at(j + 2) === '{') { const c = src.indexOf('}', j); out.space(j); j = c === -1 ? end : c + 1; continue; }
          else out.push(e, j, j + 2);
          j += 2;
          continue;
        }
        case '/': {
          const c = skipComment(j);
          if (c !== -1) { j = c; continue; }
          if (atLineStart(j) && at(j + 1) === ' ') { j += 2; continue; } // `/ Term:` list marker
          out.push(ch, j, j + 1);
          break;
        }
        case '#': j = scanHash(j, end, out); continue;
        case '$': {
          let close = j + 1;
          while (close < n && at(close) !== '$') close += at(close) === '\\' ? 2 : 1;
          out.wildcard(j, Math.min(close + 1, n));
          j = Math.min(close + 1, n);
          continue;
        }
        case '`': {
          let ticks = 1;
          while (at(j + ticks) === '`') ticks++;
          const fence = '`'.repeat(ticks);
          const close = src.indexOf(fence, j + ticks);
          if (close === -1) { out.push(ch, j, j + 1); break; }
          let s = j + ticks;
          // ```lang\ncode```: the language tag is not rendered.
          if (ticks >= 3) { const m = /^[\w+-]*\n/.exec(src.slice(s, close + 1)); if (m) s += m[0].length; }
          for (let p = s; p < close; p++) out.push(at(p), p, p + 1);
          j = close + ticks;
          continue;
        }
        case '*': case '_':
          // A mark, unless it sits inside a word (snake_case, 2*3).
          if (isWordChar(at(j - 1)) && isWordChar(at(j + 1))) out.push(ch, j, j + 1);
          j++;
          continue;
        case '=':
          if (atLineStart(j)) {
            let e = j;
            while (at(e) === '=') e++;
            if (at(e) === ' ' || at(e) === '\t') { j = e + 1; continue; }
          }
          out.push(ch, j, j + 1);
          break;
        case '-':
          if (atLineStart(j) && at(j + 1) === ' ') { j += 2; continue; }
          if (at(j + 1) === '-') { const len = at(j + 2) === '-' ? 3 : 2; out.push('-', j, j + len); j += len; continue; }
          out.push(ch, j, j + 1);
          break;
        case '+':
          if (atLineStart(j) && at(j + 1) === ' ') { j += 2; continue; }
          out.push(ch, j, j + 1);
          break;
        case '.':
          if (at(j + 1) === '.' && at(j + 2) === '.') { out.push('.', j, j + 3); j += 3; continue; }
          out.push(ch, j, j + 1);
          break;
        case '<': {
          const m = /^<[A-Za-z_][\w:.-]*>/.exec(src.slice(j, j + 60));
          if (m) { j += m[0].length; continue; }
          out.push(ch, j, j + 1);
          break;
        }
        case '@': {
          if (!isWordChar(at(j - 1))) {
            const m = /^@[A-Za-z_][\w:.-]*/.exec(src.slice(j, j + 60));
            if (m) { const len = m[0].replace(/[.:-]+$/, '').length; out.wildcard(j, j + len); j += len; continue; }
          }
          out.push(ch, j, j + 1);
          break;
        }
        case '~': out.space(j); break;
        case '[': depth++; out.push(ch, j, j + 1); break;
        case ']':
          if (inBlock && depth === 0) return j + 1;
          if (depth > 0) depth--;
          out.push(ch, j, j + 1);
          break;
        case '{': {
          const pe = placeholderEnd(j);
          if (pe !== -1) { out.wildcard(j, pe); j = pe; continue; }
          out.push(ch, j, j + 1);
          break;
        }
        default:
          out.push(ch, j, j + 1);
      }
      j++;
    }
    return j;
  }

  let pos = 0;
  for (const [s, e] of designRegions(src)) {
    scanMarkup(pos, s, body, false);
    const head = /^#let\s+([A-Za-z_][\w-]*)/.exec(src.slice(s, s + 80));
    if (head) helpers.push({ name: head[1]!, from: s, to: e });
    const kw = /^#([a-z]+)/.exec(src.slice(s, s + 12))?.[1] ?? '';
    scanCode(s + 1 + kw.length, e, design, null, kw);
    pos = e;
  }
  scanMarkup(pos, n, body, false);

  const layer = body.build();
  return { ...layer, design: design.build(), helpers, sites };
}

const projectionCache = new Map<string, SourceProjection>();

/**
 * The projection of `source`, built once per text. Two entries are kept so
 * flipping between two open documents doesn't rebuild either.
 */
export function projectSource(source: string): SourceProjection {
  let p = projectionCache.get(source);
  if (p) return p;
  p = buildProjection(source);
  if (projectionCache.size >= 2) projectionCache.delete(projectionCache.keys().next().value!);
  projectionCache.set(source, p);
  return p;
}

// ═════════════════════════════════════════════════════════════════════════
// Seeding: a 4-gram index over a layer
// ═════════════════════════════════════════════════════════════════════════

const GRAM = 4;
const GRAM_BUCKETS = 1 << 16;
/** Seed grams that occur more often than this are too common to say where we are. */
const MAX_CHAIN = 400;
/** Seed votes are counted per bin of this many projected characters. */
const BIN = 64;

interface GramIndex {
  head: Int32Array;
  next: Int32Array;
  count: Uint16Array;
}

function gramHash(c: Uint16Array, i: number): number {
  let h = c[i]!;
  for (let k = 1; k < GRAM; k++) h = Math.imul(h, 0x2f0b4f35) + c[i + k]!;
  return (h ^ (h >>> 15)) & (GRAM_BUCKETS - 1);
}

/** Whether the gram at `i` can seed: no wildcard in it, and not just spaces. */
function seedable(c: Uint16Array, i: number): boolean {
  let letters = 0;
  for (let k = 0; k < GRAM; k++) {
    const x = c[i + k]!;
    if (x === WILD) return false;
    if (x !== 32) letters++;
  }
  return letters >= 2;
}

function gramIndex(layer: ProjectionLayer): GramIndex {
  if (layer.grams) return layer.grams;
  const c = layer.codes;
  const head = new Int32Array(GRAM_BUCKETS).fill(-1);
  const next = new Int32Array(Math.max(c.length, 1)).fill(-1);
  const count = new Uint16Array(GRAM_BUCKETS);
  for (let i = 0; i + GRAM <= c.length; i++) {
    if (!seedable(c, i)) continue;
    const h = gramHash(c, i);
    next[i] = head[h]!;
    head[h] = i;
    if (count[h]! < 0xffff) count[h]!++;
  }
  layer.grams = { head, next, count };
  return layer.grams;
}

// ═════════════════════════════════════════════════════════════════════════
// The rendered window
// ═════════════════════════════════════════════════════════════════════════

/** What a click hands the mapper: where it landed in the rendered runs. */
export interface ClickTarget {
  /** Index of the clicked page, and of the clicked run within it (document order of its `.tsel` runs). */
  page: number;
  run: number;
  pageCount: number;
  /**
   * The runs of any page. The window uses only the clicked page; earlier
   * pages are read only to number a run that a helper generated (the Nth
   * identical run is the helper's Nth call).
   */
  runsOf: (page: number) => readonly string[];
}

/** The previous successful match: document order is mostly source order, so the next click is probably near it. */
export interface SourceHint {
  page: number;
  run: number;
  from: number;
}

/** What the preview gives `onRevealSource`. */
export interface SourceClick {
  target: ClickTarget;
  hint: SourceHint | null;
  /** The original mapper's guesses, built only when the alignment mapper falls through. */
  candidates: () => SourceCandidate[];
}

interface Segment {
  /** Neighbour distance: 0 is the clicked run, +1 the next run with text, -1 the previous one. */
  rel: number;
  /** Half-open character range of the run inside the window. */
  a: number;
  b: number;
  text: string;
  /**
   * For each window character of the run (`a + k`), the UTF-16 offset in
   * `text` it was folded from. Folding drops and merges characters (soft
   * hyphens, doubled spaces), so a selection's character offset in the run
   * needs this to find its window character.
   */
  src: number[];
}

interface Window {
  q: Uint16Array;
  /** Match weight per character: the clicked run counts double. */
  w: Uint8Array;
  segs: Segment[];
}

/** Runs that are only leaders (a contents page prints one run per dot), bullets or spaces. */
const NOISE_RUN = /^[\s.\u00b7\u2026\u2060\u00ad\u2022\u2027]*$/;
const SOFT_HYPHEN_ONLY = /^\u00ad+$/;

/** Neighbours kept on each side: a few runs, within a character budget. */
const NEAR = { runs: 3, chars: 150 };
const FAR = { runs: 8, chars: 420 };

/**
 * The clicked run and the runs around it as one folded string, remembering
 * where each run sits in it. Runs join with a single space, except across a
 * run that is just a soft hyphen (Typst splits a hyphenated word into three
 * runs, and the word must stay whole).
 *
 * Neighbours come from the clicked page only. A page's header and footer runs
 * sit at its edges, and across an edge they would sit between two body runs
 * that are not adjacent in the source, where a wildcard could "explain" them.
 */
function buildWindow(target: ClickTarget, budget: { runs: number; chars: number }): Window | null {
  const runs = target.runsOf(target.page);
  const clicked = runs[target.run];
  if (clicked === undefined || NOISE_RUN.test(clicked)) return null;

  // `joined` means "glue to the previous run in window order".
  const items: Array<{ text: string; joined: boolean; rel: number }> = [];
  let clickedJoined = false;

  // Forward: a soft-hyphen run glues the run after it to the one before it.
  let chars = 0, n = 0, glue = false;
  for (let i = target.run + 1; i < runs.length && n < budget.runs && chars < budget.chars; i++) {
    const text = runs[i]!;
    if (SOFT_HYPHEN_ONLY.test(text)) { glue = true; continue; }
    if (NOISE_RUN.test(text)) continue;
    items.push({ text, joined: glue, rel: ++n });
    glue = false;
    chars += text.length;
  }

  // Backward: a soft-hyphen run glues the run nearer the click to the one beyond it.
  const before: Array<{ text: string; joined: boolean; rel: number }> = [];
  chars = 0; n = 0;
  for (let i = target.run - 1; i >= 0 && n < budget.runs && chars < budget.chars; i--) {
    const text = runs[i]!;
    if (SOFT_HYPHEN_ONLY.test(text)) {
      if (before.length > 0) before[before.length - 1]!.joined = true; else clickedJoined = true;
      continue;
    }
    if (NOISE_RUN.test(text)) continue;
    before.push({ text, joined: false, rel: -++n });
    chars += text.length;
  }
  before.reverse();

  const q: number[] = [];
  const w: number[] = [];
  const segs: Segment[] = [];
  const add = (text: string, rel: number, weight: number, glued: boolean) => {
    if (!glued && q.length > 0 && q[q.length - 1] !== 32) { q.push(32); w.push(1); }
    const a = q.length;
    const src: number[] = [];
    let pos = 0;
    for (const cp of text) {
      const at = pos;
      pos += cp.length;
      const f = foldChar(cp);
      if (f === '') continue;
      if (f === ' ' && (q.length === 0 || q[q.length - 1] === 32)) continue;
      q.push(f.charCodeAt(0));
      w.push(weight);
      src.push(at);
    }
    segs.push({ rel, a, b: q.length, text, src });
  };
  for (const r of before) add(r.text, r.rel, 1, r.joined);
  add(clicked, 0, 2, clickedJoined);
  for (const r of items) add(r.text, r.rel, 1, r.joined);
  if (q.length < GRAM) return null;
  return { q: Uint16Array.from(q), w: Uint8Array.from(w), segs };
}

// ═════════════════════════════════════════════════════════════════════════
// Alignment
// ═════════════════════════════════════════════════════════════════════════

// Scores are scaled by 8 so a wildcard can cost a fraction of a gap.
const MATCH = 8;
const MISMATCH = -12;
const GAP = 12;
/** A wildcard absorbing a rendered character: cheap, but not free, so a literal match beats it. */
const WILD_COST = 1;
/** Keep at most this many seed windows, and only those with at least this share of the best one's votes. */
const MAX_CANDIDATES = 5;
const MIN_VOTE_SHARE = 0.4;
/**
 * The alignment is searched in a band this many characters either side of the
 * seeds' diagonal: wide enough for the text a wildcard absorbs or a hyphenated
 * line adds, narrow enough that a window costs tens of thousands of cells, not
 * hundreds of thousands.
 */
const BAND = 96;
/** A whole alignment below this is noise (7 neighbour characters matched). */
const MIN_SCORE = 56;
/** The prior can only break near-ties. */
const PRIOR_MAX = 10;
/** Scores this close, at different places, are a tie worth widening the window for. */
const TIE = 8;
/** Aligned characters further apart than this in the projection are separate fragments. */
const FRAGMENT_GAP = 40;

const DIAG = 1, UP = 2, LEFT = 3;

/** A seed window: `d` is where the query's first character is expected in the layer. */
interface Candidate { d: number; lo: number; hi: number; votes: number }

/**
 * Places in the layer where the query's grams cluster. Hits are counted per
 * bin of the diagonal (`t - i`); rare grams also weigh in on the diagonal's
 * exact value, so a common word can't drag the band off the real match.
 */
function seedWindows(layer: ProjectionLayer, q: Uint16Array): Candidate[] {
  const idx = gramIndex(layer);
  const nBins = (layer.codes.length >> 6) + 3;
  const votes = new Int32Array(nBins);
  const wsum = new Float64Array(nBins);
  const dsum = new Float64Array(nBins);
  let any = false;
  for (let i = 0; i + GRAM <= q.length; i++) {
    if (!seedable(q, i)) continue;
    const h = gramHash(q, i);
    const n = idx.count[h]!;
    if (n > MAX_CHAIN) continue;
    for (let t = idx.head[h]!; t !== -1; t = idx.next[t]!) {
      let ok = true;
      for (let k = 0; k < GRAM; k++) if (layer.codes[t + k] !== q[i + k]) { ok = false; break; }
      if (!ok) continue;
      const bin = Math.max(0, t - i) >> 6;
      votes[bin]!++;
      wsum[bin]! += 1 / n;
      dsum[bin]! += (t - i) / n;
      any = true;
    }
  }
  if (!any) return [];
  const out: Candidate[] = [];
  const smooth = (b: number) => (votes[b - 1] ?? 0) + votes[b]! + (votes[b + 1] ?? 0);
  const m = q.length;
  let topVotes = 0;
  for (let pick = 0; pick < MAX_CANDIDATES; pick++) {
    let best = -1, bestV = 0;
    for (let b = 0; b < nBins; b++) {
      const v = smooth(b);
      if (v > bestV) { bestV = v; best = b; }
    }
    if (best === -1 || bestV < 2) break;
    if (pick === 0) topVotes = bestV;
    else if (bestV < topVotes * MIN_VOTE_SHARE) break;
    let w = 0, d = 0;
    for (let b = Math.max(0, best - 1); b <= Math.min(nBins - 1, best + 1); b++) { w += wsum[b]!; d += dsum[b]!; }
    for (let b = Math.max(0, best - 3); b <= Math.min(nBins - 1, best + 3); b++) { votes[b] = 0; wsum[b] = 0; dsum[b] = 0; }
    const d0 = Math.max(0, Math.round(w > 0 ? d / w : best * BIN));
    out.push({ d: d0, lo: Math.max(0, d0 - BAND), hi: Math.min(layer.codes.length, d0 + m + BAND), votes: bestV });
  }
  return out;
}

/** Two direction-byte buffers: the best candidate's survives while the next one is scored. */
const dirBufs: [Uint8Array, Uint8Array] = [new Uint8Array(0), new Uint8Array(0)];
let rowA = new Int32Array(0);
let rowB = new Int32Array(0);

function dirsFor(slot: 0 | 1, size: number): Uint8Array {
  if (dirBufs[slot].length < size) dirBufs[slot] = new Uint8Array(size);
  return dirBufs[slot];
}

interface DpResult { score: number; i: number; j: number }

/**
 * Local alignment of the query `q` against `T[c.lo, c.hi)`, restricted to a
 * band around the diagonal `c.d`: matches add (double for the clicked run),
 * mismatches and gaps subtract, and a WILDCARD column lets query characters
 * pass at `WILD_COST` each. Direction bytes go to `dirs` for `traceback`.
 *
 * Cells outside the band count as 0, which a local alignment treats as "start
 * fresh here", so a half-open band is still a valid (just restricted) search.
 */
function alignDp(T: Uint16Array, c: Candidate, q: Uint16Array, wt: Uint8Array, dirs: Uint8Array): DpResult {
  const lo = c.lo;
  const m = q.length;
  const w = c.hi - lo;
  const stride = w + 1;
  if (rowA.length < stride) { rowA = new Int32Array(stride); rowB = new Int32Array(stride); }
  let prev = rowA, cur = rowB;
  prev.fill(0, 0, stride);
  cur.fill(0, 0, stride);
  let best = 0, bi = 0, bj = 0;
  for (let i = 1; i <= m; i++) {
    const qc = q[i - 1]!;
    const gain = MATCH * wt[i - 1]!;
    // Column of query character i-1 on the seed diagonal.
    const jc = i + c.d - lo;
    const jmin = Math.max(1, jc - BAND);
    const jmax = Math.min(w, jc + BAND);
    if (jmin > jmax) break;
    cur[jmin - 1] = 0;
    const base = i * stride;
    for (let j = jmin; j <= jmax; j++) {
      const tc = T[lo + j - 1]!;
      let h: number, d: number;
      if (tc === WILD) {
        // Query characters pass through a wildcard cheaply; skipping it is free.
        const u = prev[j]! - WILD_COST, g = prev[j - 1]! - WILD_COST, l = cur[j - 1]!;
        if (l >= u && l >= g) { h = l; d = LEFT; } else if (u >= g) { h = u; d = UP; } else { h = g; d = DIAG; }
      } else {
        const diag = prev[j - 1]! + (qc === tc ? gain : MISMATCH);
        const up = prev[j]! - GAP;
        const left = cur[j - 1]! - GAP;
        if (diag >= up && diag >= left) { h = diag; d = DIAG; } else if (up >= left) { h = up; d = UP; } else { h = left; d = LEFT; }
      }
      if (h <= 0) { h = 0; d = 0; }
      cur[j] = h;
      dirs[base + j] = d;
      if (h > best) { best = h; bi = i; bj = j; }
    }
    // The next row's band reaches one column further right: that cell is outside this one.
    if (jmax < w) cur[jmax + 1] = 0;
    const t = prev; prev = cur; cur = t;
  }
  return { score: best, i: bi, j: bj };
}

interface Alignment {
  score: number;
  /** Projected index each window character aligned to, or -1. */
  qT: Int32Array;
  /** 0 none, 1 exact match, 2 mismatch, 3 absorbed by a wildcard. */
  kind: Uint8Array;
}

/**
 * Read the alignment path back. A wildcard that absorbs text before the
 * first or after the last exact match is dropped: it is free to start or end
 * a local alignment inside one, so without this a run that is not in the
 * source at all (a page footer) would be "explained" by whatever wildcard
 * sits beside the text around it.
 */
function traceback(T: Uint16Array, c: Candidate, q: Uint16Array, end: DpResult, dirs: Uint8Array): Alignment {
  const lo = c.lo;
  const stride = c.hi - lo + 1;
  const qT = new Int32Array(q.length).fill(-1);
  const kind = new Uint8Array(q.length);
  const w = stride - 1;
  let i = end.i, j = end.j;
  while (i > 0 && j > 0) {
    // Direction bytes outside the band are stale (the buffer is reused): the
    // DP treated those cells as 0, so the alignment starts here.
    const jc = i + c.d - lo;
    if (j < Math.max(1, jc - BAND) || j > Math.min(w, jc + BAND)) break;
    const d = dirs[i * stride + j]!;
    if (d === 0) break;
    const tc = T[lo + j - 1]!;
    if (d === DIAG) {
      qT[i - 1] = lo + j - 1;
      kind[i - 1] = tc === WILD ? 3 : q[i - 1] === tc ? 1 : 2;
      i--; j--;
    } else if (d === UP) {
      if (tc === WILD) { qT[i - 1] = lo + j - 1; kind[i - 1] = 3; }
      i--;
    } else {
      j--;
    }
  }
  let firstExact = -1, lastExact = -1;
  for (let k = 0; k < kind.length; k++) if (kind[k] === 1) { if (firstExact === -1) firstExact = k; lastExact = k; }
  for (let k = 0; k < kind.length; k++) {
    if (kind[k] === 3 && (k < firstExact || k > lastExact)) { kind[k] = 0; qT[k] = -1; }
  }
  return { score: end.score, qT, kind };
}

/** Index into `layer` that a source offset corresponds to (first character at or after it). */
function projectedIndexAt(layer: ProjectionLayer, offset: number): number {
  let lo = 0, hi = layer.from.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (layer.from[mid]! < offset) lo = mid + 1; else hi = mid;
  }
  return Math.min(lo, Math.max(layer.from.length - 1, 0));
}

/**
 * Where in the layer the click should be, before looking at its text: the
 * previous match if it was a few runs away on the same page, else the
 * click's fraction of the document. Only ever breaks ties.
 */
function expectedIndex(layer: ProjectionLayer, target: ClickTarget, hint: SourceHint | null): number {
  if (hint && hint.page === target.page && Math.abs(hint.run - target.run) <= 3) return projectedIndexAt(layer, hint.from);
  const n = Math.max(target.runsOf(target.page).length, 1);
  const frac = (target.page + (target.run + 0.5) / n) / Math.max(target.pageCount, 1);
  return Math.floor(layer.codes.length * Math.min(frac, 1));
}

/**
 * Align the window against the layer: seed, score every seed window, pick by
 * score with the prior as tie-break, and report whether the runner-up is
 * close enough that the window should be widened.
 */
function alignWindow(
  layer: ProjectionLayer, win: Window, expected: number, pick?: number,
): { best: Alignment; tied: boolean } | null {
  const T = layer.codes;
  const seeds = seedWindows(layer, win.q);
  if (seeds.length === 0) return null;
  const size = (win.q.length + 1) * (Math.max(...seeds.map((s) => s.hi - s.lo)) + 1);
  let slot: 0 | 1 = 0;
  let keep: { slot: 0 | 1; c: Candidate; r: DpResult } | null = null;
  let keepAdj = -Infinity;
  const places: Array<{ at: number; score: number; c: Candidate; r: DpResult }> = [];
  for (const c of seeds) {
    const r = alignDp(T, c, win.q, win.w, dirsFor(slot, size));
    if (r.score < MIN_SCORE) continue;
    const at = c.lo + r.j;
    places.push({ at, score: r.score, c, r });
    const adj = r.score - PRIOR_MAX * Math.min(1, Math.abs(at - expected) / Math.max(T.length, 1));
    if (adj > keepAdj) { keepAdj = adj; keep = { slot, c, r }; slot = slot === 0 ? 1 : 0; }
  }
  if (!keep) return null;
  const top = keep;
  const tied = places.some((p) => Math.abs(p.at - (top.c.lo + top.r.j)) > 60 && top.r.score - p.score <= TIE);
  if (tied && pick !== undefined) {
    // Context and the prior could not separate the places: take the Nth of
    // them, N being how many identical runs came before this one (the
    // second "KEY AREAS FOR IMPROVEMENT" row of a contents list is the
    // second such heading). Copies of a run beyond the places (the heading
    // itself, later) wrap around, which is what the same order implies.
    const group = places.filter((p) => top.r.score - p.score <= TIE).sort((a, b) => a.at - b.at);
    const distinct = group.filter((p, i) => i === 0 || p.at - group[i - 1]!.at > 60);
    const chosen = distinct[pick % distinct.length]!;
    if (chosen.c !== top.c) {
      const r = alignDp(T, chosen.c, win.q, win.w, dirsFor(slot, size));
      return { best: traceback(T, chosen.c, win.q, r, dirBufs[slot]), tied };
    }
  }
  return { best: traceback(T, top.c, win.q, top.r, dirBufs[top.slot]), tied };
}

/** An aligned character of a window segment: its place in the segment, in the layer, and how it aligned. */
interface Pt { k: number; t: number; kind: number }

/**
 * The source range a window segment aligned to, or null if it did not align
 * well enough. Only the densest cluster of aligned characters counts, and its
 * edges are trimmed back to solid ground: a stray match in a distant fragment,
 * or a lone coincidental letter just before the real match, must not stretch
 * the range.
 */
function segmentRange(layer: ProjectionLayer, win: Window, aln: Alignment, seg: Segment): SourceRange | null {
  let letters = 0;
  const pts: Pt[] = [];
  for (let k = seg.a; k < seg.b; k++) {
    if (win.q[k] === 32) continue;
    letters++;
    const kd = aln.kind[k]!;
    if (kd === 1 || kd === 3) pts.push({ k, t: aln.qT[k]!, kind: kd });
  }
  if (letters === 0 || pts.length === 0) return null;

  // Split into fragments wherever the projected index jumps; keep the largest.
  let best: Pt[] = [];
  let frag: Pt[] = [];
  for (const p of pts) {
    if (frag.length > 0 && Math.abs(p.t - frag[frag.length - 1]!.t) > FRAGMENT_GAP) {
      if (frag.length > best.length) best = frag;
      frag = [];
    }
    frag.push(p);
  }
  if (frag.length > best.length) best = frag;

  // An exact character counts as solid only beside another one (a word, not a coincidence).
  const solid = (a: Pt, b: Pt | undefined) => a.kind !== 1 || (!!b && b.kind === 1 && Math.abs(b.t - a.t) <= 2 && Math.abs(b.k - a.k) <= 2);
  let lo = 0, hi = best.length - 1;
  while (lo < hi && !solid(best[lo]!, best[lo + 1])) lo++;
  while (hi > lo && !solid(best[hi]!, best[hi - 1])) hi--;
  const core = best.slice(lo, hi + 1);

  const exact = core.filter((p) => p.kind === 1).length;
  const wild = core.length - exact;
  if (core.length < 0.6 * letters) return null;
  // Mostly-wildcard runs need real anchors elsewhere in the window (MIN_SCORE
  // covers that); a handful of exact characters is not enough on its own.
  if (exact < Math.min(3, letters) && wild < 0.8 * letters) return null;
  let first = core[0]!.t, last = core[0]!.t;
  for (const p of core) { if (p.t < first) first = p.t; if (p.t > last) last = p.t; }
  return { from: layer.from[first]!, to: layer.to[last]! };
}

/** The layer's offset range as it reads best for selecting: one run of text, no stray outer whitespace. */
function trimRange(source: string, r: SourceRange): SourceRange {
  let { from, to } = r;
  while (from < to && /\s/.test(source[from]!)) from++;
  while (to > from && /\s/.test(source[to - 1]!)) to--;
  return { from, to };
}

/** The number of runs before the clicked one, in document order, that read the same as `text`. */
function earlierIdentical(target: ClickTarget, text: string): number {
  const want = foldKey(text);
  let n = 0;
  for (let p = 0; p <= target.page; p++) {
    const runs = target.runsOf(p);
    const stop = p === target.page ? target.run : runs.length;
    for (let i = 0; i < stop; i++) if (foldKey(runs[i]!) === want) n++;
  }
  return n;
}

function foldKey(text: string): string {
  let s = '';
  for (const cp of text) s += foldChar(cp);
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * A run that lives only in the design layer: if it sits in a helper's
 * definition, send the click to the Nth call of that helper in the body (the
 * Nth identical run is the Nth call); otherwise to the design text itself.
 */
function designRange(proj: SourceProjection, r: SourceRange, target: ClickTarget, text: string): SourceRange {
  const helper = proj.helpers.find((h) => r.from >= h.from && r.from < h.to);
  const calls = helper ? proj.sites.get(helper.name) : undefined;
  if (!calls || calls.length === 0) return r;
  return calls[Math.min(earlierIdentical(target, text), calls.length - 1)]!;
}

/**
 * Where did the run the user clicked come from? Aligns it, with its
 * neighbours as context, against the projection of `source`.
 *
 * Tries the clicked run first and then its neighbours (a heading counter or a
 * page number has no source of its own); for each, the body text, then text
 * that only exists in design statements. Null means nothing aligned well
 * enough: the caller falls back to the text search.
 */
export function resolveClick(source: string, target: ClickTarget, hint: SourceHint | null = null): SourceRange | null {
  return resolveRun(source, target, hint)?.range ?? null;
}

/**
 * How a run's own characters aligned, kept so a selection can ask where *inside*
 * the run it starts or ends. Present only when the run itself (not a
 * neighbour, not the design layer) matched the body text.
 */
interface RunChars {
  proj: SourceProjection;
  aln: Alignment;
  seg: Segment;
  /** The source span the run's trusted characters cover (before trimming): characters outside it are stray matches. */
  bound: SourceRange;
}

interface RunResolution {
  range: SourceRange;
  chars: RunChars | null;
}

/** `resolveClick`, plus the alignment of the run's characters when it has one. */
function resolveRun(source: string, target: ClickTarget, hint: SourceHint | null): RunResolution | null {
  const clickedText = target.runsOf(target.page)[target.run];
  if (clickedText === undefined) return null;
  const proj = projectSource(source);
  if (proj.codes.length === 0 && proj.design.codes.length === 0) return null;

  let win = buildWindow(target, NEAR);
  if (!win) return null;
  const expected = expectedIndex(proj, target, hint);
  let result = alignWindow(proj, win, expected);
  if (result?.tied) {
    // Same text in two places: ask the runs further out which one this is.
    const wide = buildWindow(target, FAR);
    const second = wide && alignWindow(proj, wide, expected);
    if (wide && second && second.best.score >= result.best.score) { win = wide; result = second; }
  }
  // Still tied: a nearby previous match (the hint) decides if there is one, else the count of identical runs before.
  const hinted = !!hint && hint.page === target.page && Math.abs(hint.run - target.run) <= 3;
  if (result?.tied && !hinted) result = alignWindow(proj, win, expected, earlierIdentical(target, clickedText)) ?? result;

  // The clicked run first, always: a counter-looking run ("9.8" in a CVSS
  // cell) that sits exactly between its neighbours in the source is real
  // content, and a genuine counter ("2.1" before a heading) fails to align
  // and hands over to the next run by itself.
  for (const rel of [0, 1, -1, 2, -2]) {
    const seg = win.segs.find((s) => s.rel === rel);
    if (!seg) continue;
    if (result) {
      const hit = segmentRange(proj, win, result.best, seg);
      if (hit) {
        return { range: trimRange(source, hit), chars: rel === 0 ? { proj, aln: result.best, seg, bound: hit } : null };
      }
    }
    // Not in the body: perhaps in a header, a footer, or a helper's definition.
    const text = foldKey(seg.text);
    if (text.replace(/\s/g, '').length < 4) continue;
    const alone = soloWindow(seg.text);
    if (!alone) continue;
    const found = alignWindow(proj.design, alone, 0);
    if (!found) continue;
    const range = segmentRange(proj.design, alone, found.best, alone.segs[0]!);
    if (range) return { range: designRange(proj, trimRange(source, range), target, seg.text), chars: null };
  }
  return null;
}

/** A window of just one run (the design layer has no prose around it to use as context). */
function soloWindow(text: string): Window | null {
  const q: number[] = [];
  for (const cp of text) {
    const f = foldChar(cp);
    if (f === '' || (f === ' ' && (q.length === 0 || q[q.length - 1] === 32))) continue;
    q.push(f.charCodeAt(0));
  }
  while (q.length > 0 && q[q.length - 1] === 32) q.pop();
  if (q.length < GRAM) return null;
  return { q: Uint16Array.from(q), w: new Uint8Array(q.length).fill(2), segs: [{ rel: 0, a: 0, b: q.length, text, src: [] }] };
}

/**
 * The whole click-to-source resolution: alignment first, and when it finds
 * nothing, the original candidate search, so a click never does less than it
 * used to.
 */
export function resolveSourceClick(source: string, click: SourceClick): SourceRange | null {
  return resolveClick(source, click.target, click.hint) ?? findByCandidates(source, click.candidates());
}

// ═════════════════════════════════════════════════════════════════════════
// Phase 2: a highlighted selection to a source range
// ═════════════════════════════════════════════════════════════════════════

/** One end of a selection: a run, and a character offset (UTF-16) inside that run's text. */
export interface SelectionEnd {
  target: ClickTarget;
  offset: number;
}

export interface SelectionRange extends SourceRange {
  /**
   * True when the range could not be pinned to characters at both ends: an end
   * sits in generated text (a variable, a helper's output), in a header or
   * footer, or was matched only as a whole run, or a sanity check rejected the
   * first answer. The caller says so rather than presenting it as exact.
   */
  approximate: boolean;
}

/**
 * The source position of character offset `offset` of a run, between its
 * characters: `start` takes the character at or after the offset (a selection
 * begins at it), `end` the character before it (a selection finishes after
 * it), each falling back to the nearest aligned character on the other side.
 * Null when no character of the run aligned to the source.
 *
 * Only characters inside the run's trusted span count (see `RunChars.bound`),
 * so one stray coincidental match cannot drag an end across the document. The
 * aligner's own per-character offsets do the work: this is a read of the
 * traceback `resolveClick` already computed, not a second alignment.
 */
function charPosition(c: RunChars, offset: number, side: 'start' | 'end'): { pos: number; wild: boolean } | null {
  const { proj, aln, seg, bound } = c;
  const n = seg.src.length;
  const usable = (k: number): number => {
    const kind = aln.kind[seg.a + k]!;
    if (kind !== 1 && kind !== 3) return -1;
    const t = aln.qT[seg.a + k]!;
    return t >= 0 && proj.from[t]! >= bound.from && proj.to[t]! <= bound.to ? t : -1;
  };
  // First window character at or after the offset.
  let i = 0;
  while (i < n && seg.src[i]! < offset) i++;
  const after = (): { pos: number; wild: boolean } | null => {
    for (let k = i; k < n; k++) { const t = usable(k); if (t !== -1) return { pos: proj.from[t]!, wild: aln.kind[seg.a + k] === 3 }; }
    return null;
  };
  const before = (): { pos: number; wild: boolean } | null => {
    for (let k = i - 1; k >= 0; k--) { const t = usable(k); if (t !== -1) return { pos: proj.to[t]!, wild: aln.kind[seg.a + k] === 3 }; }
    return null;
  };
  return side === 'start' ? (after() ?? before()) : (before() ?? after());
}

/** Document order of two ends: page, then run, then offset. */
function compareEnds(a: SelectionEnd, b: SelectionEnd): number {
  return a.target.page - b.target.page || a.target.run - b.target.run || a.offset - b.offset;
}

/** Characters the selection covers in the rendered runs, each run boundary counting one (the space between lines). */
function selectedLength(s: SelectionEnd, e: SelectionEnd): number {
  const sp = s.target.page, ep = e.target.page;
  if (sp === ep && s.target.run === e.target.run) return Math.max(0, e.offset - s.offset);
  let n = 0;
  for (let p = sp; p <= ep; p++) {
    const runs = s.target.runsOf(p);
    const first = p === sp ? s.target.run : 0;
    const last = p === ep ? e.target.run : runs.length - 1;
    for (let r = first; r <= last; r++) {
      const len = runs[r]?.length ?? 0;
      const from = p === sp && r === s.target.run ? Math.min(s.offset, len) : 0;
      const to = p === ep && r === e.target.run ? Math.min(e.offset, len) : len;
      n += Math.max(0, to - from) + 1;
    }
  }
  return n;
}

/**
 * Where does a highlighted span of the preview come from in the source?
 *
 * Each end is placed with the click aligner (`resolveRun`: its own context
 * window, the hint as a position prior) and then read down to the character:
 * the aligned projection characters already carry their source offsets. An end
 * that cannot be placed that precisely (generated text, a header, a run that
 * did not align) uses its whole run, the start of the start run or the end of
 * the end run, and the result is flagged approximate.
 *
 * Sanity checks, so a bad match never becomes a surprising selection:
 *  - the ends are put in document order first (a backwards drag), and a result
 *    that still comes out reversed (a footnote renders far from where it is
 *    written) is swapped only inside one run; across runs it falls back to the
 *    shorter end's run and is approximate;
 *  - a source span longer than 3x the rendered selection plus 200 characters is
 *    approximate and falls back the same way. It is never returned as is.
 *
 * Null when the selection is empty or neither end aligns to the source.
 */
export function rangeFromSelection(
  source: string,
  a: SelectionEnd,
  b: SelectionEnd,
  hint: SourceHint | null = null,
): SelectionRange | null {
  const [s, e] = compareEnds(a, b) <= 0 ? [a, b] : [b, a];
  const same = s.target.page === e.target.page && s.target.run === e.target.run;
  if (same && s.offset === e.offset) return null;

  const rs = resolveRun(source, s.target, hint);
  const re = same ? rs : resolveRun(source, e.target, rs ? { page: s.target.page, run: s.target.run, from: rs.range.from } : hint);
  if (!rs && !re) return null;

  let approximate = false;
  const place = (res: RunResolution | null, end: SelectionEnd, side: 'start' | 'end'): number | null => {
    if (res?.chars) {
      const hit = charPosition(res.chars, end.offset, side);
      if (hit) { if (hit.wild) approximate = true; return hit.pos; }
    }
    approximate = true;
    return null;
  };
  const fromChar = place(rs, s, 'start');
  const toChar = place(re, e, 'end');
  let from = fromChar ?? rs?.range.from ?? re!.range.from;
  let to = toChar ?? re?.range.to ?? rs!.range.to;
  // Any run-level answer is one the user should treat as a guess about its extent.
  if (rs && !rs.chars) approximate = true;
  if (re && !re.chars) approximate = true;

  /** The shorter of the two ends' own run ranges: the safest thing to say when the span itself is not trusted. */
  const shorterRun = (): SourceRange => {
    const cands = [rs?.range, re?.range].filter((r): r is SourceRange => !!r);
    return cands.reduce((x, y) => (y.to - y.from < x.to - x.from ? y : x));
  };

  if (to < from) {
    if (same) { [from, to] = [to, from]; }
    else { approximate = true; ({ from, to } = shorterRun()); }
  }
  const limit = 3 * selectedLength(s, e) + 200;
  if (to - from > limit) {
    approximate = true;
    ({ from, to } = shorterRun());
    if (to - from > limit) to = from + limit;
  }

  const r = trimRange(source, { from, to });
  return r.to > r.from ? { ...r, approximate } : null;
}

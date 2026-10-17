import { describe, it, expect } from 'vitest';
import {
  projectSource,
  resolveClick,
  resolveSourceClick,
  fallbackCandidates,
  WILDCARD,
  type ClickTarget,
  type SourceClick,
} from '@/lib/typst-source-map';

/** A click on run `r` of page `p`, given each page's runs. */
function target(pages: string[][], p: number, r: number): ClickTarget {
  return { page: p, run: r, pageCount: pages.length, runsOf: (i) => pages[i] ?? [] };
}

const slice = (src: string, r: { from: number; to: number } | null) => (r ? src.slice(r.from, r.to) : null);

describe('projectSource', () => {
  it('keeps text, drops markup marks, and records exact source offsets', () => {
    const src = '= Hello *brave* _new_ world\n';
    const p = projectSource(src);
    expect(p.text.trim()).toBe('hello brave new world');
    // Every projected character points at the character it came from.
    for (let i = 0; i < p.text.length; i++) {
      if (p.text[i] === ' ') continue;
      expect(src[p.from[i]!]!.toLowerCase()).toBe(p.text[i]);
    }
  });

  it('drops #set, #show, #import and #let statements and comments', () => {
    const src = '#set text(size: 9pt)\n#show heading: it => it\n#let x = "hidden"\n// a comment\n/* block */ Visible words\n';
    expect(projectSource(src).text.trim()).toBe('visible words');
  });

  it('turns -- and --- and ... into one character each, with the full source extent', () => {
    const src = 'a -- b --- c... d';
    const p = projectSource(src);
    expect(p.text).toBe('a - b - c. d');
    const dash = p.text.indexOf('-');
    expect(src.slice(p.from[dash]!, p.to[dash]!)).toBe('--');
  });

  it('keeps content blocks and table cell strings, drops non-text strings', () => {
    const src = '#table(columns: 2, [Name], "Cell", fill: rgb("#fff"))\n#image("shot.png")\n#text(fill: red)[Red words]\n';
    expect(projectSource(src).text).toContain('name cell');
    expect(projectSource(src).text).toContain('red words');
    expect(projectSource(src).text).not.toContain('shot');
    expect(projectSource(src).text).not.toContain('#fff');
  });

  it('projects #variable and {{PLACEHOLDER}} as a wildcard', () => {
    const p = projectSource('Hello #who and {{NAME}} done');
    expect(p.text).toBe(`hello ${WILDCARD} and ${WILDCARD} done`);
  });

  it('keeps design-region text in its own layer, not in the body text', () => {
    const src = '#set page(header: [Draft Watermark])\nBody text\n';
    const p = projectSource(src);
    expect(p.text).not.toContain('draft');
    expect(p.design.text).toContain('draft watermark');
  });

  it('is memoised on the source string', () => {
    const src = 'Some words here\n';
    expect(projectSource(src)).toBe(projectSource(src));
    expect(projectSource(src + 'x')).not.toBe(projectSource(src));
  });
});

describe('resolveClick', () => {
  const SRC = `= Findings

== Alpha issue

#table(columns: 2, [*Severity*], [High], [*Status*], [Open])

Alpha text goes here.

== Beta issue

#table(columns: 2, [*Severity*], [Low], [*Status*], [Open])

Beta text goes there.
`;

  it('chooses between repeated strings by their neighbours, not by count', () => {
    // "Severity" appears under both findings; the run after it tells them apart.
    const pages = [['Findings', 'Alpha issue', 'Severity', 'High', 'Status', 'Open', 'Alpha text goes here.', 'Beta issue', 'Severity', 'Low', 'Status', 'Open', 'Beta text goes there.']];
    const second = resolveClick(SRC, target(pages, 0, 8))!;
    expect(slice(SRC, second)).toBe('Severity');
    expect(second.from).toBeGreaterThan(SRC.indexOf('Beta issue'));
    const first = resolveClick(SRC, target(pages, 0, 2))!;
    expect(slice(SRC, first)).toBe('Severity');
    expect(first.from).toBeLessThan(SRC.indexOf('Beta issue'));
  });

  it('maps rendered text that is not literal in the source (dash, quotes, markup)', () => {
    const src = 'The team said it\'s "ready" -- but *not* done.\n';
    const pages = [['The team said it’s “ready” – but not done.']];
    const r = resolveClick(src, target(pages, 0, 0))!;
    expect(r.from).toBe(0);
    expect(r.to).toBe(src.trimEnd().length);
  });

  it('lets a wildcard absorb generated text between literal anchors', () => {
    const src = 'Prepared for #client by the security team.\n';
    const pages = [['Prepared for Acme Industries by the security team.']];
    const r = resolveClick(src, target(pages, 0, 0))!;
    expect(slice(src, r)).toBe('Prepared for #client by the security team.');
  });

  it('returns null when nothing aligns well enough, so the caller can fall back', () => {
    expect(resolveClick('Alpha beta gamma\n', target([['zzzz qqqq wwww xxxx']], 0, 0))).toBeNull();
  });

  it('lands a counter-only run on the content it labels', () => {
    const src = '= Scope and Method\n\nBody words follow.\n';
    const pages = [['2.1', 'Scope and Method', 'Body words follow.']];
    expect(slice(src, resolveClick(src, target(pages, 0, 0))!)).toBe('Scope and Method');
  });

  it('prefers a call site of a helper when the text only exists in its definition', () => {
    // The helper prints its own bracketed text, then its argument.
    const src = '#let note(x) = block[\\[ generated filler text \\] #x]\n\nIntro words here.\n\n#note("one")\n\n#note("two")\n';
    const pages = [['Intro words here.', '[ generated filler text ]', 'one', '[ generated filler text ]', 'two']];
    const first = resolveClick(src, target(pages, 0, 1))!;
    const second = resolveClick(src, target(pages, 0, 3))!;
    expect(src.slice(first.from, first.to)).toContain('#note("one")');
    expect(src.slice(second.from, second.to)).toContain('#note("two")');
  });

  it('uses the last match as a prior when two spots are otherwise identical', () => {
    // Two copies far enough apart to be separate seed windows, and nothing around the run to tell them apart.
    const filler = 'Unrelated filler sentence about something else entirely. '.repeat(30);
    const src = `Same line of text here.\n\n${filler}\n\nSame line of text here.\n`;
    const second = src.lastIndexOf('Same');
    const pages = [['Same line of text here.']];
    const t = target(pages, 0, 0);
    expect(resolveClick(src, t, { page: 0, run: 0, from: second })!.from).toBe(second);
    expect(resolveClick(src, t, { page: 0, run: 0, from: 0 })!.from).toBe(0);
  });
});

describe('resolveClick: edges of the window', () => {
  it('does not let a neighbouring wildcard explain a run that is not in the body (a footer)', () => {
    const src = '#set page(footer: [Confidential])\nPrepared for #client\n\nSecond paragraph of body text.\n';
    const pages = [['Prepared for Acme', 'Second paragraph of body text.', 'Confidential']];
    const r = resolveClick(src, target(pages, 0, 2))!;
    expect(slice(src, r)).toBe('Confidential'); // the footer text in #set page, not #client
  });

  it('keeps a hyphenated word whole across its three runs', () => {
    const src = 'Social engineering and physical access were out of scope for this assessment.\n';
    const pages = [['Social engi', String.fromCharCode(0xad), 'neering and physical access were out of scope for this assessment.']];
    const a = resolveClick(src, target(pages, 0, 0))!;
    const b = resolveClick(src, target(pages, 0, 2))!;
    expect(a.from).toBe(0);
    expect(src.slice(b.from, b.to)).toContain('neering and physical access');
  });

  it('ignores the one-run-per-dot leaders of a contents list when building context', () => {
    const src = '= Executive Summary\n\nBody text that follows the heading.\n';
    const dots = Array.from({ length: 60 }, () => '.');
    const pages = [['Contents', 'Executive Summary ', ...dots, ' 3']];
    expect(slice(src, resolveClick(src, target(pages, 0, 1))!)).toBe('Executive Summary');
    expect(resolveClick(src, target(pages, 0, 10))).toBeNull(); // a dot has no source
  });
});

describe('resolveSourceClick', () => {
  it('falls back to the old candidate search when alignment finds nothing', () => {
    // A single short word: too little to align, but the old search finds it.
    const src = 'Intro.\n\nZyzzyva\n';
    const pages = [['Zyzzyva']];
    const click: SourceClick = {
      target: target(pages, 0, 0),
      hint: null,
      candidates: () => fallbackCandidates(pages[0]!, 0),
    };
    const r = resolveSourceClick(src, click)!;
    expect(slice(src, r)).toBe('Zyzzyva');
  });
});

describe('fallbackCandidates', () => {
  it('orders the clicked run first, then its neighbours, counting earlier duplicates', () => {
    const c = fallbackCandidates(['a run', 'dup', 'dup'], 2, ['dup']);
    expect(c[0]).toEqual({ text: 'dup', occurrence: 2 });
  });
  it('tries the content a counter labels before the counter itself', () => {
    const c = fallbackCandidates(['2.1', 'Scope'], 0);
    expect(c.map((x) => x.text)).toEqual(['Scope', '2.1']);
  });
});

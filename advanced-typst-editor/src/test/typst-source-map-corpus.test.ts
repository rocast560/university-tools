// The corpus for click-to-source: six realistic fixture documents under
// src/test/fixtures/source-map/, each with
//   <name>.typ          the source,
//   <name>.runs.json    the rendered `.tsel` runs per page, generated once with the
//                       project's own typst.ts (scripts/gen-source-map-fixtures.mjs),
//   <name>.clicks.json  hand-labelled clicks: page, run, the run's text (a guard
//                       against stale runs) and the source line it should land on.
// No wasm and no private documents: tests replay the labelled clicks through the
// old mapper (the candidate search) and the new one (alignment + the same
// fallback) and compare hit rates. A hit means the returned range lies on the
// expected source line(s).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  fallbackCandidates,
  findByCandidates,
  projectSource,
  resolveSourceClick,
  type SourceClick,
  type SourceRange,
} from '@/lib/typst-source-map';

const DIR = resolve(__dirname, 'fixtures/source-map');

interface Label { p: number; r: number; t: string; line: number | [number, number]; why?: string }
interface Fixture { name: string; source: string; pages: string[][]; labels: Label[]; runCount: number }

const fixtures: Fixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.typ'))
  .sort()
  .map((f) => {
    const name = f.replace(/\.typ$/, '');
    const pages = (JSON.parse(readFileSync(resolve(DIR, `${name}.runs.json`), 'utf8')) as { pages: string[][] }).pages;
    return {
      name,
      source: readFileSync(resolve(DIR, f), 'utf8'),
      pages,
      labels: JSON.parse(readFileSync(resolve(DIR, `${name}.clicks.json`), 'utf8')) as Label[],
      runCount: pages.reduce((n, p) => n + p.length, 0),
    };
  });

/** The click the preview would hand to `onRevealSource`. */
function clickFor(fx: Pick<Fixture, 'pages'>, p: number, r: number): SourceClick {
  return {
    target: { page: p, run: r, pageCount: fx.pages.length, runsOf: (i) => fx.pages[i] ?? [] },
    hint: null,
    candidates: () => fallbackCandidates(fx.pages[p]!, r, fx.pages.slice(0, p).flat()),
  };
}

const lineOf = (source: string, offset: number) => source.slice(0, offset).split('\n').length;

function isHit(source: string, range: SourceRange | null, line: Label['line']): boolean {
  if (!range) return false;
  const [lo, hi] = typeof line === 'number' ? [line, line] : line;
  const a = lineOf(source, range.from);
  const b = lineOf(source, Math.max(range.from, range.to - 1));
  return a >= lo && b <= hi;
}

describe('source-map corpus', () => {
  it('has the six fixtures, with 15 to 55 labelled clicks each', () => {
    expect(fixtures.map((f) => f.name)).toEqual(['helpers-vars', 'lab-report', 'long-report', 'pentest-report', 'prose-quotes', 'toc-report']);
    for (const f of fixtures) {
      expect(f.labels.length, f.name).toBeGreaterThanOrEqual(15);
      expect(f.labels.length, f.name).toBeLessThanOrEqual(55);
    }
  });

  it('every label points at the run it names (fixtures and labels are in step)', () => {
    for (const f of fixtures) {
      // typst.ts joins "Figure" and its number with a no-break space; the labels are typed with a plain one.
      const plain = (s: string | undefined) => s?.split(String.fromCharCode(160)).join(' ');
      for (const l of f.labels) expect(plain(f.pages[l.p]?.[l.r]), `${f.name} ${l.p}:${l.r}`).toBe(l.t);
    }
  });

  it('new mapper is at least as accurate as the old one on every fixture, and better overall', () => {
    const rows: Array<{ fixture: string; clicks: number; old: string; new: string; oldHits: number; newHits: number }> = [];
    const misses: string[] = [];
    let totalClicks = 0, totalOld = 0, totalNew = 0;
    for (const f of fixtures) {
      let oldHits = 0, newHits = 0;
      for (const l of f.labels) {
        const click = clickFor(f, l.p, l.r);
        const oldHit = isHit(f.source, findByCandidates(f.source, click.candidates()), l.line);
        const newRange = resolveSourceClick(f.source, click);
        const newHit = isHit(f.source, newRange, l.line);
        if (oldHit) oldHits++;
        if (newHit) newHits++;
        if (!newHit) {
          misses.push(`${f.name} ${l.p}:${l.r} ${JSON.stringify(l.t.slice(0, 40))} want line ${JSON.stringify(l.line)} got ${newRange ? `line ${lineOf(f.source, newRange.from)} ${JSON.stringify(f.source.slice(newRange.from, newRange.to).slice(0, 40))}` : 'nothing'} (${l.why ?? 'plain'})`);
        }
      }
      const n = f.labels.length;
      rows.push({ fixture: f.name, clicks: n, oldHits, newHits, old: `${((oldHits / n) * 100).toFixed(1)}%`, new: `${((newHits / n) * 100).toFixed(1)}%` });
      totalClicks += n; totalOld += oldHits; totalNew += newHits;
    }
    const pct = (h: number) => `${((h / totalClicks) * 100).toFixed(1)}%`;
    const table = [
      'fixture            clicks   old          new',
      ...rows.map((r) => `${r.fixture.padEnd(18)} ${String(r.clicks).padStart(5)}   ${`${r.oldHits} (${r.old})`.padEnd(12)} ${r.newHits} (${r.new})`),
      `${'OVERALL'.padEnd(18)} ${String(totalClicks).padStart(5)}   ${`${totalOld} (${pct(totalOld)})`.padEnd(12)} ${totalNew} (${pct(totalNew)})`,
    ].join('\n');
    // Printed on purpose: this is the measured hit rate the research doc quotes.
    console.log(`\nclick-to-source hit rate, old vs new\n${table}\n\nnew-mapper misses:\n${misses.join('\n')}\n`);

    for (const r of rows) expect(r.newHits, r.fixture).toBeGreaterThanOrEqual(r.oldHits);
    expect(totalNew).toBeGreaterThan(totalOld);
  });
});

describe('contents-list clicks in sequence', () => {
  // A real session: click a contents row, then another, each with the previous
  // match handed back as the hint. The second click used to land where the
  // first had (dot leaders and page numbers drove the match).
  it('every contents row lands on its own heading, whatever the order and the hint', () => {
    const fx = fixtures.find((f) => f.name === 'toc-report')!;
    const rows = fx.labels.filter((l) => l.p === 1);
    const order = [...rows.keys()].map((i) => (i * 7) % rows.length); // a scrambled walk through every row
    let hint: SourceClick['hint'] = null;
    for (const i of order) {
      const l = rows[i]!;
      const click = { ...clickFor(fx, l.p, l.r), hint };
      const r = resolveSourceClick(fx.source, click);
      expect(isHit(fx.source, r, l.line), `${l.t.trim()} (row ${i + 1})`).toBe(true);
      hint = r ? { page: l.p, run: l.r, from: r.from } : hint;
    }
  });
});

describe('source-map performance', () => {
  const largest = [...fixtures].sort((a, b) => b.runCount - a.runCount)[0]!;

  it('resolves a click in well under the budget on the largest fixture (projection memoised)', () => {
    projectSource(largest.source); // first click of a session pays this once
    const times: number[] = [];
    for (let pass = 0; pass < 3; pass++) {
      for (const l of largest.labels) {
        const click = clickFor(largest, l.p, l.r);
        const t0 = performance.now();
        resolveSourceClick(largest.source, click);
        times.push(performance.now() - t0);
      }
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    const max = times[times.length - 1]!;
    console.log(`click time on ${largest.name} (${largest.source.length} source chars, ${largest.runCount} runs): median ${median.toFixed(2)} ms, p95 ${times[Math.floor(times.length * 0.95)]!.toFixed(2)} ms, max ${max.toFixed(2)} ms`);
    // p95, not max: under the full parallel suite a single GC pause or JIT
    // warm-up can push one sample past any fixed budget (seen once in a
    // full-suite run), which says nothing about the mapper.
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(25);
  });

  it('stays inside the budget on a source ten times larger', () => {
    const times = 10;
    const big = largest.source.repeat(times);
    const pages = Array.from({ length: times }, () => largest.pages).flat();
    const fx = { pages };
    const t0 = performance.now();
    projectSource(big);
    resolveSourceClick(big, clickFor(fx, largest.pages.length * 7, 5)); // builds the gram index too
    const cold = performance.now() - t0;
    const samples: number[] = [];
    for (const l of largest.labels) {
      const p = l.p + largest.pages.length * 7; // the 8th copy
      const t1 = performance.now();
      resolveSourceClick(big, clickFor(fx, p, l.r));
      samples.push(performance.now() - t1);
    }
    samples.sort((a, b) => a - b);
    console.log(`10x stress (${big.length} source chars, ${pages.length} pages): projection ${cold.toFixed(1)} ms once, click median ${samples[Math.floor(samples.length / 2)]!.toFixed(2)} ms, max ${samples[samples.length - 1]!.toFixed(2)} ms`);
    // Ten identical copies tie everywhere, which is the slow path (every click widens its window).
    // Loose bounds: alone this runs at a ~4.5 ms median, but under the full
    // parallel suite it was seen at 27.6 ms. These only catch an algorithmic
    // blow-up (seconds), not machine load; the real budget is the test above.
    expect(samples[Math.floor(samples.length / 2)]!).toBeLessThan(60);
    expect(samples[Math.floor(samples.length * 0.95)]!).toBeLessThan(250);
  });
});

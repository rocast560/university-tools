// REST routes under /api. All GET, all JSON except the image and structure
// file routes. Every route is described in openapi.ts.

import { Hono } from 'hono';
import { FormulaError } from '../src/chem/formula.ts';
import { BalanceError } from '../src/chem/balance.ts';
import { library } from '../src/chem/library.ts';
import { pubchem } from '../src/chem/pubchem.ts';
import type { RenderStyle } from '../src/chem/render3d.ts';
import type { ResolveResult } from '../src/chem/resolve.ts';
import { buildConnectInfo } from './connect.ts';
import {
  balance,
  depiction2dPng,
  depiction2dSvg,
  formulaInfo,
  latticeFor,
  latticeList,
  latticeSummary,
  linksFor,
  resolveQuery,
  snapshotPng,
  snapshotSvg,
  structureOf,
  summary,
  toPdb,
  toXyz,
  type Theme,
} from './service.ts';

export const api = new Hono();

type Ok = Extract<ResolveResult, { ok: true }>;

function theme(v: string | undefined): Theme {
  return v === 'dark' ? 'dark' : 'light';
}

function num(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function style(v: string | undefined): RenderStyle {
  return v === 'stick' || v === 'spacefill' ? v : 'ballstick';
}

/** Resolve ?q= or answer with the right error status. */
async function resolved(c: { req: { query: (k: string) => string | undefined } }): Promise<Ok | Response> {
  const q = c.req.query('q')?.trim();
  if (!q) return Response.json({ ok: false, error: 'Missing ?q= (a name, formula, CAS number, CID or SMILES)' }, { status: 400 });
  const result = await resolveQuery(q);
  if (result.ok) return result;
  return Response.json(result, { status: result.pubchemDown ? 502 : 404 });
}

api.get('/health', (c) => c.json({ ok: true, library: library().size, generatedAt: null }));

api.get('/molecule', async (c) => {
  const r = await resolved(c);
  if (r instanceof Response) return r;
  const wantSvg = c.req.query('svg') !== '0';
  const wantStructure = c.req.query('structure') !== '0';
  const { resolved: res } = r;
  return c.json({
    ok: true,
    query: res.query,
    matchedOn: res.matchedOn,
    compound: res.compound,
    alternatives: res.alternatives,
    composition: res.composition,
    warnings: res.warnings,
    lattice: res.lattice ?? null,
    structureSource: res.structureSource,
    svg: wantSvg ? res.svg : undefined,
    molfile: wantStructure ? res.molfile : undefined,
    links: linksFor(res.query),
  });
});

api.get('/molecule/2d.svg', async (c) => {
  const r = await resolved(c);
  if (r instanceof Response) return r;
  if (!r.resolved.svg) return c.json({ ok: false, error: 'No 2D depiction for this compound' }, 404);
  return new Response(depiction2dSvg(r.resolved.svg, theme(c.req.query('theme'))), {
    headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
});

api.get('/molecule/2d.png', async (c) => {
  const r = await resolved(c);
  if (r instanceof Response) return r;
  if (!r.resolved.svg) return c.json({ ok: false, error: 'No 2D depiction for this compound' }, 404);
  const png = depiction2dPng(r.resolved.svg, theme(c.req.query('theme')), num(c.req.query('width'), 640, 64, 2048));
  return new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' } });
});

for (const [ext, make] of [
  ['sdf', (r: Ok) => r.resolved.molfile],
  ['xyz', (r: Ok) => { const s = structureOf(r.resolved.molfile); return s ? toXyz(s, r.resolved.compound.name) : null; }],
  ['pdb', (r: Ok) => { const s = structureOf(r.resolved.molfile); return s ? toPdb(s, r.resolved.compound.name) : null; }],
] as const) {
  api.get(`/molecule/3d.${ext}`, async (c) => {
    const r = await resolved(c);
    if (r instanceof Response) return r;
    const text = make(r);
    if (!text) return c.json({ ok: false, error: 'No 3D structure for this compound' }, 404);
    const types = { sdf: 'chemical/x-mdl-sdfile', xyz: 'chemical/x-xyz', pdb: 'chemical/x-pdb' };
    return new Response(text, {
      headers: {
        'content-type': `${types[ext]}; charset=utf-8`,
        'content-disposition': `inline; filename="${r.resolved.compound.id}.${ext}"`,
        'cache-control': 'public, max-age=3600',
      },
    });
  });
}

function snapshotOptions(c: { req: { query: (k: string) => string | undefined } }) {
  return {
    style: style(c.req.query('style')),
    labels: c.req.query('labels') === '1' || c.req.query('labels') === 'true',
    width: num(c.req.query('width'), 640, 64, 2048),
    height: num(c.req.query('height'), 480, 64, 2048),
    theme: theme(c.req.query('theme')),
    rotate: { x: num(c.req.query('rx'), 0, -360, 360), y: num(c.req.query('ry'), 0, -360, 360), z: num(c.req.query('rz'), 0, -360, 360) },
  };
}

api.get('/molecule/3d.svg', async (c) => {
  const r = await resolved(c);
  if (r instanceof Response) return r;
  const s = structureOf(r.resolved.molfile);
  if (!s) return c.json({ ok: false, error: 'No 3D structure for this compound' }, 404);
  return new Response(snapshotSvg(s, snapshotOptions(c)), {
    headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
});

api.get('/molecule/3d.png', async (c) => {
  const r = await resolved(c);
  if (r instanceof Response) return r;
  const s = structureOf(r.resolved.molfile);
  if (!s) return c.json({ ok: false, error: 'No 3D structure for this compound' }, 404);
  return new Response(snapshotPng(s, snapshotOptions(c)), {
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' },
  });
});

api.get('/search', async (c) => {
  const q = c.req.query('q')?.trim() ?? '';
  const limit = num(c.req.query('limit'), 10, 1, 50);
  const remote = c.req.query('remote') === '1';
  const hits = library().search(q, limit).map((h) => ({ ...summary(h.entry), matchedOn: h.matchedOn, matchedText: h.matchedText }));
  let pubchemNames: string[] = [];
  if (remote && q.length >= 3 && hits.length < limit) {
    try {
      const local = new Set(hits.map((h) => h.name.toLowerCase()));
      pubchemNames = (await pubchem.autocomplete(q, limit)).filter((n) => !local.has(n.toLowerCase())).slice(0, limit - hits.length);
    } catch {
      pubchemNames = [];
    }
  }
  return c.json({ ok: true, query: q, hits, pubchem: pubchemNames });
});

api.get('/library', (c) => {
  const category = c.req.query('category');
  const entries = category ? library().byCategory(category) : library().entries;
  return c.json({ ok: true, count: entries.length, entries: entries.map(summary) });
});

api.get('/categories', (c) => c.json({ ok: true, categories: library().categories() }));

api.get('/formula', (c) => {
  const f = c.req.query('f') ?? c.req.query('q');
  if (!f) return c.json({ ok: false, error: 'Missing ?f=' }, 400);
  try {
    return c.json({ ok: true, ...formulaInfo(f) });
  } catch (err) {
    if (err instanceof FormulaError) return c.json({ ok: false, error: err.message }, 400);
    throw err;
  }
});

api.get('/balance', (c) => {
  const eq = c.req.query('eq') ?? c.req.query('q');
  if (!eq) return c.json({ ok: false, error: 'Missing ?eq= (for example "Fe + O2 -> Fe2O3")' }, 400);
  try {
    return c.json({ ok: true, ...balance(eq) });
  } catch (err) {
    if (err instanceof BalanceError || err instanceof FormulaError) return c.json({ ok: false, error: err.message }, 400);
    throw err;
  }
});

api.get('/lattices', (c) => c.json({ ok: true, materials: latticeList() }));

api.get('/lattice', (c) => {
  const q = c.req.query('q');
  if (!q) return c.json({ ok: false, error: 'Missing ?q= (a material such as NaCl, iron, diamond, perovskite)' }, 400);
  const r = latticeFor(q, num(c.req.query('repeat'), 2, 1, 4));
  if (!r) return c.json({ ok: false, error: `No lattice model for "${q}"`, available: latticeList().map((m) => m.formula) }, 404);
  return c.json({ ok: true, ...latticeSummary(r), molfile: r.molfile, cell: r.cluster.cell, edges: r.edges });
});

api.get('/lattice/3d.sdf', (c) => {
  const q = c.req.query('q') ?? '';
  const r = latticeFor(q, num(c.req.query('repeat'), 2, 1, 4));
  if (!r) return c.json({ ok: false, error: `No lattice model for "${q}"` }, 404);
  return new Response(r.molfile, { headers: { 'content-type': 'chemical/x-mdl-sdfile; charset=utf-8' } });
});

api.get('/lattice/3d.png', (c) => {
  const q = c.req.query('q') ?? '';
  const r = latticeFor(q, num(c.req.query('repeat'), 2, 1, 4));
  if (!r) return c.json({ ok: false, error: `No lattice model for "${q}"` }, 404);
  const opts = snapshotOptions(c);
  const lines = r.edges.map(([from, to]) => ({ from, to, color: opts.theme === 'dark' ? '#8a8f9a' : '#7a7f8a' }));
  return new Response(snapshotPng(r.cluster, { ...opts, lines }), { headers: { 'content-type': 'image/png' } });
});

api.get('/connect', (c) => c.json({ ok: true, ...buildConnectInfo() }));

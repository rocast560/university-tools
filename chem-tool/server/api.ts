// REST routes under /api (spec 9.2). Errors: { error, ...details } with a matching status.

import { Hono } from 'hono';
import { z } from 'zod';
import { FormulaError, composition, hillFormula, molarMass, parseFormula } from '../src/chem/formula';
import { search } from '../src/chem/library';
import { svgToPng } from '../src/chem/png';
import { renderSnapshotSvg } from '../src/chem/render3d';
import { ResolveError } from '../src/chem/resolve';
import type { AppDeps } from './app';
import { CommandSchema } from './schemas';
import { CommandError } from './workspace';

export function connectInfo(deps: AppDeps): { mcpUrl: string; claudeCode: string; openapi: string; window: string } {
  const base = `http://${deps.host ?? '127.0.0.1'}:${deps.port ?? 8140}`;
  return { mcpUrl: `${base}/mcp`, claudeCode: `claude mcp add --transport http chemtool ${base}/mcp`, openapi: `${base}/openapi.json`, window: base };
}

const png = (bytes: Uint8Array) => new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png' } });

export function registerApi(app: Hono, deps: AppDeps): void {
  const api = new Hono();

  api.onError((err, c) => {
    if (err instanceof CommandError) return c.json({ error: err.message, ...err.details }, err.status);
    if (err instanceof ResolveError) return c.json({ error: err.message, suggestions: err.suggestions, reason: err.reason }, 404);
    if (err instanceof FormulaError) return c.json({ error: err.message }, 400);
    if (err instanceof z.ZodError) return c.json({ error: 'Invalid request', issues: err.issues }, 400);
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  api.get('/health', (c) => c.json({ ok: true, version: deps.store.get().version, port: deps.port ?? null }));

  api.get('/search', (c) => {
    const hits = search(c.req.query('q') ?? '', Number(c.req.query('limit') ?? 20));
    return c.json(hits.map((e) => ({ name: e.name, formula: e.formula, category: e.category, smiles: e.smiles })));
  });

  api.get('/resolve', async (c) => {
    const q = c.req.query('q') ?? '';
    if (!q) throw new CommandError(400, 'Missing q');
    return c.json(await deps.resolver.resolve(q));
  });

  api.get('/workspace', (c) => c.json(deps.store.get()));

  api.post('/command', async (c) => {
    const cmd = CommandSchema.parse(await c.req.json());
    const result = await deps.store.dispatch(cmd, 'api');
    return c.json({ result, workspace: deps.store.get() });
  });

  api.get('/species/:file', async (c) => {
    const m = /^(.+)\.(svg|png|sdf|mol)$/.exec(c.req.param('file'));
    if (!m) return c.notFound();
    const { species } = deps.store.findSpecies(m[1]);
    const svg = c.req.query('numbered') === '1' ? species.svg2dNumbered : species.svg2d;
    switch (m[2]) {
      case 'svg': return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } });
      case 'png': return png(await svgToPng(svg, Number(c.req.query('w') ?? 800)));
      case 'mol': return new Response(species.molfile3d, { headers: { 'content-type': 'chemical/x-mdl-molfile' } });
      default: return new Response(`${species.molfile3d}\n> <NAME>\n${species.name}\n\n$$$$\n`, { headers: { 'content-type': 'chemical/x-mdl-sdfile' } });
    }
  });

  api.get('/snapshot.png', async (c) => {
    const scene = deps.store.scene(c.req.query('scene') || undefined);
    const species = deps.store.focused(scene.id);
    const width = Number(c.req.query('w') ?? 640);
    const [rx, ry, rz] = scene.view.camera.rotation;
    const svg = renderSnapshotSvg(species.atoms, species.bonds, {
      width, height: Number(c.req.query('h') ?? Math.round(width * 0.75)), style: scene.view.style,
      showHydrogens: scene.view.showHydrogens, highlight: scene.view.highlight, rotation: [20 + rx, 30 + ry, rz],
    });
    return png(await svgToPng(svg, width));
  });

  api.get('/formula', (c) => {
    const p = parseFormula(c.req.query('q') ?? '');
    return c.json({ hill: hillFormula(p.counts, p.charge), charge: p.charge, molarMass: molarMass(p.counts), composition: composition(p.counts) });
  });

  api.get('/connect', (c) => c.json(connectInfo(deps)));

  app.route('/api', api);
}

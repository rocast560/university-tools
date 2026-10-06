// REST routes. Every route is a thin call into the Service; errors map to
// JSON {error} with the ServiceError status.

import { lab3Example } from './lab3-example.ts';
import { createLibraryLookup } from './libraries.ts';
import { DATA_DIR, KICAD_SYMBOL_DIR } from './config.ts';
import path from 'node:path';
import { OrganizerError, OrganizerStore } from './organizer.ts';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { WirePath } from '../src/layout/types.ts';
import { PART_ALIASES, resolveAlias } from '../src/parts/aliases.ts';
import { renderSvg, type Highlight } from '../src/render/index.ts';
import { DARK, LIGHT } from '../src/render/theme.ts';
import { summarize } from '../src/pipeline.ts';
import { buildConnectInfo } from './connect.ts';
import { pngAvailable, renderPng } from './png.ts';
import { ServiceError, type ProjectEvent, type Service } from './service.ts';
import { createTunnel, type Tunnel } from './tunnel.ts';
import type { ClientRegistry } from './clients.ts';
import type { Events } from './watch.ts';

export function parseHighlight(q: string | undefined): Highlight | null {
  if (!q) return null;
  const [kind, ...rest] = q.split(':');
  const v = rest.join(':');
  if (kind === 'net' && v) return { net: v };
  if (kind === 'ref' && v) return { ref: v };
  if (kind === 'wire' && /^\d+$/.test(v)) return { wire: Number(v) };
  return null;
}

/**
 * The request's JSON body as an object, or a 400. `null`, an array or a
 * number parses, but reading `body.key` off one would throw and answer 500.
 * `lenient` routes, which have always taken a missing or broken body as
 * empty, get `{}` instead of the 400.
 */
async function objectBody(c: Context, lenient = false): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => undefined);
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  if (lenient) return {};
  throw new ServiceError('the body must be a JSON object');
}

export function summaryOf(p: ReturnType<Service['get']>) {
  return {
    id: p.info.id,
    name: p.info.name,
    path: p.info.path,
    components: [...p.design.components.values()].map((c) => ({ ref: c.ref, value: p.doc.values[c.ref] ?? c.value, lib: c.lib, part: c.part, pins: c.pins.size, footprint: p.doc.footprints[c.ref]?.kind ?? 'unknown' })),
    nets: [...p.design.nets.keys()].filter((n) => !n.startsWith('unconnected-')),
    board: p.doc.board,
    options: p.sidecar.options,
    errors: p.doc.checks.filter((c) => c.level === 'error').length,
    warnings: p.doc.checks.filter((c) => c.level === 'warning').length,
    unplaced: p.doc.unplaced,
    summary: summarize(p.doc),
  };
}

export function createApi(service: Service, events: Events<ProjectEvent>, tunnel: Tunnel = createTunnel(), clients?: ClientRegistry): Hono {
  const api = new Hono();

  api.onError((err, c) => {
    if (err instanceof ServiceError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof OrganizerError) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  api.post('/examples/lab3', async (c) => {
    const text = await lab3Example(createLibraryLookup({ symbolDir: KICAD_SYMBOL_DIR }));
    return c.json(summaryOf(await service.import('Lab3_Prelab_Example.kicad_sch', new TextEncoder().encode(text))));
  });
  api.get('/projects', async (c) => c.json(await service.list()));
  api.post('/projects/open', async (c) => {
    const body = (await objectBody(c, true)) as { path?: string };
    if (!body.path) throw new ServiceError('body must be {"path": "<absolute path to a .kicad_sch>"}');
    const p = await service.open(body.path);
    return c.json(summaryOf(p));
  });
  // Import copies an uploaded .kicad_sch into the library (PROJECTS_DIR) and
  // opens it, so the desktop app can own projects without a native file picker.
  api.post('/projects/import', async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) throw new ServiceError('send multipart/form-data with a "file" field holding a .kicad_sch');
    const p = await service.import(file.name, new Uint8Array(await file.arrayBuffer()));
    return c.json(summaryOf(p));
  });
  api.get('/projects/:id', (c) => c.json(summaryOf(service.get(c.req.param('id')))));
  api.post('/projects/:id/refresh', async (c) => c.json(summaryOf(await service.refresh(c.req.param('id')))));
  api.delete('/projects/:id', (c) => {
    service.close(c.req.param('id'));
    return c.json({ ok: true });
  });
  api.get('/projects/:id/layout', (c) => c.json(service.get(c.req.param('id')).doc));
  api.get('/projects/:id/steps', (c) => c.json(service.get(c.req.param('id')).doc.steps));
  api.get('/projects/:id/checks', (c) => c.json(service.get(c.req.param('id')).doc.checks));
  api.get('/projects/:id/truth-table', (c) => {
    const s = service.get(c.req.param('id')).doc.sim;
    return c.json(s.truthTable ?? { rows: [], note: s.note });
  });
  api.get('/projects/:id/pinouts', (c) => c.json(service.get(c.req.param('id')).doc.pinouts));
  api.get('/projects/:id/netlist', (c) => c.body(service.get(c.req.param('id')).netlistText, 200, { 'content-type': 'text/plain; charset=utf-8' }));
  api.get('/projects/:id/sidecar', (c) => c.json(service.get(c.req.param('id')).sidecar));
  api.get('/projects/:id/board.svg', (c) => {
    const p = service.get(c.req.param('id'));
    const svg = renderSvg(p.doc, { highlight: parseHighlight(c.req.query('highlight')), theme: c.req.query('theme') === 'dark' ? DARK : LIGHT, wireStyle: p.sidecar.options.wireStyle });
    return c.body(svg, 200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-cache' });
  });
  api.get('/projects/:id/board.png', (c) => {
    const p = service.get(c.req.param('id'));
    if (!pngAvailable()) return c.json({ error: 'PNG rendering unavailable; use board.svg' }, 501);
    const png = renderPng(renderSvg(p.doc, { highlight: parseHighlight(c.req.query('highlight')), wireStyle: p.sidecar.options.wireStyle }));
    // resvg/Node always back this with a real ArrayBuffer; TS's stricter
    // Uint8Array<ArrayBufferLike> vs <ArrayBuffer> split needs a nudge here.
    return c.body(png as Uint8Array<ArrayBuffer>, 200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
  });
  api.get('/projects/:id/schematic.svg', async (c) => c.body(await service.schematicSvg(c.req.param('id')), 200, { 'content-type': 'image/svg+xml; charset=utf-8' }));
  api.post('/projects/:id/sim', async (c) => {
    const body = (await objectBody(c, true)) as { levels?: Record<string, 0 | 1> };
    return c.json(service.simulate(c.req.param('id'), body.levels ?? {}));
  });
  api.post('/projects/:id/layout/options', async (c) => c.json((await service.setOptions(c.req.param('id'), (await objectBody(c)) as never)).doc));
  api.post('/projects/:id/layout/move', async (c) => {
    const body = (await objectBody(c)) as { ref?: string; holes?: Record<string, { col: number; row: string }> };
    if (!body.ref || !body.holes) throw new ServiceError('body must be {"ref": "R1", "holes": {"1": {"col": 3, "row": "a"}, ...}}');
    return c.json((await service.movePart(c.req.param('id'), body.ref, body.holes as never)).doc);
  });
  api.post('/projects/:id/layout/colors', async (c) => {
    const body = (await objectBody(c)) as { net?: string; color?: string | null };
    if (!body.net) throw new ServiceError('body must be {"net": "/A", "color": "#rrggbb" | null}');
    return c.json((await service.setColor(c.req.param('id'), body.net, body.color ?? null)).doc);
  });
  api.post('/projects/:id/layout/tests', async (c) => {
    const body = (await c.req.json()) as { tests?: unknown };
    return c.json((await service.setTests(c.req.param('id'), body.tests)).sidecar.tests);
  });
  api.post('/projects/:id/layout/ledcolor', async (c) => {
    const body = (await objectBody(c)) as { ref?: string; color?: string | null };
    if (!body.ref) throw new ServiceError('body must be {"ref": "D1", "color": "blue" | null}');
    return c.json((await service.setLedColor(c.req.param('id'), body.ref, body.color ?? null)).doc);
  });
  api.post('/projects/:id/layout/wire', async (c) => {
    const body = (await objectBody(c)) as { key?: string; path?: WirePath | null };
    if (!body.key || body.path === undefined) throw new ServiceError('body must be {"key": "/A|a12|e20", "path": {"points": [{"col": 12.5, "gap": "c|d", "lane": 0}]} | null}');
    return c.json((await service.setWirePath(c.req.param('id'), body.key, body.path)).doc);
  });
  api.post('/projects/:id/layout/reset', async (c) => c.json((await service.resetLayout(c.req.param('id'))).doc));
  api.post('/projects/:id/erc', async (c) => c.json(await service.erc(c.req.param('id'))));
  const editResult = (out: Awaited<ReturnType<Service['setValue']>>) => ({ ok: true, ref: out.ref, unit: out.unit, backup: out.backup, notes: out.notes, checks: out.project.doc.checks, summary: summaryOf(out.project) });
  api.post('/projects/:id/edit/add', async (c) => {
    const b = (await objectBody(c)) as { part?: string; libId?: string; value?: string; ref?: string; connections?: Record<string, string> };
    const libId = b.libId ?? (b.part ? resolveAlias(b.part)?.libId : undefined) ?? (b.part?.includes(':') ? b.part : undefined);
    if (!libId) throw new ServiceError(`unknown part "${b.part ?? ''}"; use a name from list_supported_parts (GET /api/parts) or a KiCad lib_id like Device:R`);
    return c.json(editResult(await service.addComponent(c.req.param('id'), { libId, value: b.value ?? resolveAlias(b.part ?? '')?.defaultValue, ref: b.ref, connections: b.connections })));
  });
  api.post('/projects/:id/edit/connect', async (c) => {
    const b = (await objectBody(c)) as { ref?: string; pin?: string; net?: string };
    if (!b.ref || !b.pin || !b.net) throw new ServiceError('body must be {"ref": "R1", "pin": "1", "net": "A"}');
    return c.json(editResult(await service.connect(c.req.param('id'), b.ref, String(b.pin), b.net)));
  });
  api.post('/projects/:id/edit/disconnect', async (c) => {
    const b = (await objectBody(c)) as { ref?: string; pin?: string };
    if (!b.ref || !b.pin) throw new ServiceError('body must be {"ref": "R1", "pin": "1"}');
    return c.json(editResult(await service.disconnect(c.req.param('id'), b.ref, String(b.pin))));
  });
  api.post('/projects/:id/edit/remove', async (c) => {
    const b = (await objectBody(c)) as { ref?: string };
    if (!b.ref) throw new ServiceError('body must be {"ref": "R1"}');
    return c.json(editResult(await service.removeComponent(c.req.param('id'), b.ref)));
  });
  api.post('/projects/:id/edit/value', async (c) => {
    const b = (await objectBody(c)) as { ref?: string; value?: string };
    if (!b.ref || b.value === undefined) throw new ServiceError('body must be {"ref": "R1", "value": "10k"}');
    return c.json(editResult(await service.setValue(c.req.param('id'), b.ref, String(b.value))));
  });
  // Home page folders: which folder each project is filed under.
  const organizer = new OrganizerStore(path.join(DATA_DIR, 'organizer.json'));
  api.get('/organizer', async (c) => c.json(await organizer.get()));
  api.post('/organizer/folders', async (c) => {
    const body = (await objectBody(c, true)) as { name?: unknown };
    return c.json(await organizer.createFolder(body.name));
  });
  api.patch('/organizer/folders/:id', async (c) => {
    const body = (await objectBody(c, true)) as { name?: unknown };
    return c.json(await organizer.renameFolder(c.req.param('id'), body.name));
  });
  api.delete('/organizer/folders/:id', async (c) => {
    await organizer.deleteFolder(c.req.param('id'));
    return c.json({ ok: true });
  });
  api.post('/organizer/move', async (c) => {
    const body = (await objectBody(c, true)) as { path?: unknown; folderId?: unknown };
    await organizer.move(body.path, body.folderId);
    return c.json({ ok: true });
  });
  api.post('/organizer/order', async (c) => {
    const body = (await objectBody(c, true)) as { ids?: unknown };
    await organizer.reorder(body.ids);
    return c.json({ ok: true });
  });
  api.get('/connect', (c) => c.json({ ...buildConnectInfo(), tunnel: tunnel.status() }));
  // Who has been calling the MCP server, for the status lights.
  api.get('/clients', (c) => c.json(clients?.list() ?? []));
  // The stdio entry point runs in its own process and reports in here.
  api.post('/clients/touch', async (c) => {
    const body = (await objectBody(c, true)) as { name?: string; method?: string; transport?: string };
    if (!clients) return c.json({ ok: false });
    const name = typeof body.name === 'string' && body.name ? body.name : 'stdio client';
    return c.json(clients.touch({ id: `stdio:${name}`, transport: 'stdio', method: typeof body.method === 'string' ? body.method : 'request', clientName: name }));
  });
  api.get('/parts', (c) => c.json(PART_ALIASES));

  // Public access for ChatGPT and other internet-only MCP clients.
  api.get('/tunnel', (c) => c.json(tunnel.status()));
  api.post('/tunnel', async (c) => {
    const body = (await objectBody(c, true)) as { action?: string };
    if (body.action === 'start') return c.json(await tunnel.start());
    if (body.action === 'stop') return c.json(tunnel.stop());
    throw new ServiceError('body must be {"action": "start"} or {"action": "stop"}');
  });
  api.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const unsub = events.subscribe((ev) => void stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) }));
      // A page that has just connected wants to know who is already here.
      for (const client of clients?.list() ?? []) await stream.writeSSE({ event: 'client', data: JSON.stringify({ projectId: '', type: 'client', client }) });
      let alive = true;
      stream.onAbort(() => {
        alive = false;
        unsub();
      });
      await stream.writeSSE({ event: 'hello', data: '{}' });
      while (alive) {
        await stream.sleep(25_000);
        if (alive) await stream.writeSSE({ event: 'ping', data: '{}' });
      }
    }),
  );
  return api;
}

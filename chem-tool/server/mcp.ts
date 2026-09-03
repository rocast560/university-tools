// MCP tool definitions (spec 9.4). One McpServer per connection, all sharing the workspace store.

import { StreamableHTTPTransport } from '@hono/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Hono } from 'hono';
import { z } from 'zod';
import { composition, hillFormula, molarMass, parseFormula } from '../src/chem/formula';
import { search } from '../src/chem/library';
import { svgToPng } from '../src/chem/png';
import { renderSnapshotSvg } from '../src/chem/render3d';
import type { Scene, Species, ViewState } from '../src/chem/types';
import { connectInfo } from './api';
import type { AppDeps } from './app';
import { EditOpSchema } from './schemas';
import { CommandError, describe } from './workspace';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

const text = (t: string): Content => ({ type: 'text', text: t });
const json = (o: unknown): Content => ({ type: 'text', text: '```json\n' + JSON.stringify(o) + '\n```' });
async function image(svg: string, width: number): Promise<Content> {
  return { type: 'image', data: Buffer.from(await svgToPng(svg, width)).toString('base64'), mimeType: 'image/png' };
}

function atomList(s: Species): string {
  return s.atoms.map((a) => `${a.index}:${a.element}${a.charge ? (a.charge > 0 ? '+' : '') + a.charge : ''}`).join(' ');
}
function bondList(s: Species): string {
  return s.bonds.map((b) => `${b.a}-${b.b}${b.order > 1 ? `(${b.order})` : ''}${b.aromatic ? 'ar' : ''}`).join(' ');
}

export function speciesText(s: Species, deps: AppDeps, scene?: Scene): string {
  const geometryNote = s.geometry === 'conformer' ? '' : s.geometry === 'star'
    ? '3D geometry: ideal star geometry (the conformer generator does not handle this species).'
    : '3D geometry: flat 2D layout (no 3D available for this species).';
  return [
    `${s.name}: ${s.displayFormula}${s.iupacName ? ` (IUPAC: ${s.iupacName})` : ''}`,
    `Hill formula ${s.formula}; molar mass ${s.info.molarMass} g/mol; charge ${s.charge}; source ${s.source}${s.cid ? `; PubChem CID ${s.cid}` : ''}`,
    `SMILES ${s.smiles}`,
    `Atoms (1-based, heavy first): ${atomList(s)}`,
    `Bonds: ${bondList(s)}`,
    geometryNote,
    scene ? `Scene "${scene.title}" (id ${scene.id}). Open in the window: ${connectInfo(deps).window}/?scene=${scene.id}` : '',
  ].filter(Boolean).join('\n');
}

/** Software-rendered 3D PNG. Phase 2 asks a live window first. */
export async function render3dPng(deps: AppDeps, scene: Scene, species: Species, width: number, style?: ViewState['style']): Promise<Uint8Array> {
  const [rx, ry, rz] = scene.view.camera.rotation;
  const svg = renderSnapshotSvg(species.atoms, species.bonds, {
    width, height: Math.round(width * 0.75), style: style ?? scene.view.style, showHydrogens: scene.view.showHydrogens,
    highlight: scene.view.highlight, rotation: [20 + rx, 30 + ry, rz],
  });
  return svgToPng(svg, width);
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  const details = err instanceof CommandError ? err.details : err instanceof Error && 'suggestions' in err ? { suggestions: (err as { suggestions: unknown }).suggestions } : {};
  return { isError: true, content: [text(message), ...(Object.keys(details).length ? [json(details)] : [])] };
}

export function createMcpServer(deps: AppDeps): McpServer {
  const server = new McpServer({ name: 'chemtool', version: '0.1.0' });
  const store = deps.store;
  const run = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => { try { return await fn(); } catch (err) { return fail(err); } };
  const speciesIdArg = z.string().optional().describe('Species id from an earlier result. Defaults to the focused species of the active scene.');
  const widthArg = z.number().int().min(100).max(2000).default(640);
  const current = (id?: string) => store.findSpecies(id);
  const stateJson = () => ({ version: store.get().version, sceneId: store.get().activeSceneId });

  server.registerTool('lookup_chemical', {
    title: 'Look up a chemical',
    description: 'Resolve a name, formula, SMILES or CAS number to a compound. By default loads it into the ChemTool window and returns info, the numbered atom list (use these numbers in edit_molecule and set_view) and a 2D drawing. Set load=false to only read.',
    inputSchema: { query: z.string().min(1), load: z.boolean().default(true), newScene: z.boolean().default(false).describe('Open a new scene tab instead of replacing the current molecule.') },
  }, (args) => run(async () => {
    if (!args.load) {
      const r = await deps.resolver.resolve(args.query);
      return { content: [text(speciesText(r.species, deps)), json({ alternatives: r.alternatives, note: r.note }), await image(r.species.svg2dNumbered, 480)] };
    }
    const result = await store.dispatch({ type: 'load', query: args.query, newScene: args.newScene }, 'mcp');
    const scene = store.scene(result.sceneId);
    const species = store.focused(scene.id);
    return { content: [text(`${result.message}\n${speciesText(species, deps, scene)}`), json({ ...stateJson(), speciesId: species.id, alternatives: result.alternatives }), await image(species.svg2dNumbered, 480)] };
  }));

  server.registerTool('search_chemicals', {
    title: 'Search the library', description: 'Autocomplete-style search over the offline library by name, alias or formula. Does not change the window.',
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).default(10) },
  }, (args) => run(async () => {
    const hits = search(args.query, args.limit).map((e) => ({ name: e.name, formula: e.formula, category: e.category }));
    return { content: [text(hits.length ? hits.map((h) => `${h.name} (${h.formula}) - ${h.category}`).join('\n') : 'No matches'), json(hits)] };
  }));

  server.registerTool('get_current', {
    title: 'What is on screen', description: 'The active scene: its species with numbered atoms, the equation (for reactions), the view state and the workspace version. Cheap; call it to refresh atom numbers after edits.',
    inputSchema: {},
  }, () => run(async () => {
    const scene = store.activeScene();
    const focused = store.focused();
    const summary = scene.species.map((s) => (s.id === focused.id ? '[focused] ' : '') + speciesText(s, deps)).join('\n\n');
    return { content: [text(`Scene "${scene.title}" (id ${scene.id}, kind ${scene.kind})\n${summary}`), json({ ...stateJson(), kind: scene.kind, focusId: scene.focusId, equation: scene.equation ?? null, view: scene.view, species: scene.species.map((s) => ({ id: s.id, name: s.name, formula: s.formula, atoms: s.atoms, bonds: s.bonds })) })] };
  }));

  server.registerTool('set_molecule', {
    title: 'Replace the molecule', description: 'Replace the focused molecule from a SMILES string, a molfile, or a name/formula query. Returns the new numbered atom list and a 2D drawing.',
    inputSchema: { smiles: z.string().optional(), molfile: z.string().optional(), query: z.string().optional(), name: z.string().optional().describe('Display name for the new structure.') },
  }, (args) => run(async () => {
    const result = args.query
      ? await store.dispatch({ type: 'load', query: args.query }, 'mcp')
      : await store.dispatch({ type: 'set_structure', smiles: args.smiles, molfile: args.molfile, name: args.name }, 'mcp');
    const scene = store.scene(result.sceneId);
    const species = store.focused(scene.id);
    return { content: [text(`${result.message}\n${speciesText(species, deps, scene)}`), json({ ...stateJson(), speciesId: species.id }), await image(species.svg2dNumbered, 480)] };
  }));

  server.registerTool('render_2d', {
    title: 'Render 2D', description: 'PNG of the skeletal 2D structure. numbered=true labels heavy atoms with their indices.',
    inputSchema: { speciesId: speciesIdArg, numbered: z.boolean().default(false), width: widthArg },
  }, (args) => run(async () => {
    const { species } = current(args.speciesId);
    return { content: [text(`2D drawing of ${describe(species)}`), await image(args.numbered ? species.svg2dNumbered : species.svg2d, args.width)] };
  }));

  server.registerTool('render_3d', {
    title: 'Render 3D', description: 'PNG of the 3D model. Uses the live window when one is open, otherwise a software renderer.',
    inputSchema: { speciesId: speciesIdArg, style: z.enum(['ballstick', 'stick', 'spacefill', 'wireframe']).optional(), width: widthArg },
  }, (args) => run(async () => {
    const { scene, species } = current(args.speciesId);
    const bytes = await render3dPng(deps, scene, species, args.width, args.style);
    return { content: [text(`3D view of ${describe(species)} (software renderer)`), { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' }] };
  }));

  server.registerTool('get_structure', {
    title: 'Get structure data', description: 'The structure as SDF, molfile (3D, explicit hydrogens), SMILES, or JSON atoms and bonds.',
    inputSchema: { speciesId: speciesIdArg, format: z.enum(['sdf', 'molfile', 'smiles', 'json']).default('smiles') },
  }, (args) => run(async () => {
    const { species } = current(args.speciesId);
    const body = args.format === 'smiles' ? species.smiles
      : args.format === 'molfile' ? species.molfile3d
      : args.format === 'sdf' ? `${species.molfile3d}\n> <NAME>\n${species.name}\n\n$$$$\n`
      : JSON.stringify({ id: species.id, name: species.name, formula: species.formula, charge: species.charge, atoms: species.atoms, bonds: species.bonds });
    return { content: [text(body)] };
  }));

  server.registerTool('formula_info', {
    title: 'Formula info', description: 'Molar mass, Hill formula and mass percent composition of a formula. Pure calculation; does not change the window.',
    inputSchema: { formula: z.string().min(1) },
  }, (args) => run(async () => {
    const p = parseFormula(args.formula);
    const info = { hill: hillFormula(p.counts, p.charge), charge: p.charge, molarMass: Math.round(molarMass(p.counts) * 1000) / 1000, composition: composition(p.counts) };
    return { content: [text(`${args.formula}: Hill ${info.hill}, molar mass ${info.molarMass} g/mol\n${info.composition.map((c) => `${c.element}: ${c.count} atoms, ${c.massPercent}%`).join('\n')}`), json(info)] };
  }));

  server.registerTool('new_scene', {
    title: 'New scene', description: 'Open a new scene tab, optionally loading a compound into it. The new scene becomes active.',
    inputSchema: { title: z.string().optional(), query: z.string().optional() },
  }, (args) => run(async () => {
    const result = await store.dispatch({ type: 'new_scene', title: args.title, query: args.query }, 'mcp');
    return { content: [text(result.message), json({ ...stateJson(), speciesId: result.speciesId })] };
  }));

  server.registerTool('list_scenes', { title: 'List scenes', description: 'All scene tabs with their ids, titles and focused species.', inputSchema: {} }, () => run(async () => {
    const ws = store.get();
    const rows = ws.scenes.map((s) => ({ id: s.id, title: s.title, kind: s.kind, active: s.id === ws.activeSceneId, focused: describe(store.focused(s.id)) }));
    return { content: [text(rows.map((r) => `${r.active ? '* ' : '  '}${r.title} (id ${r.id}): ${r.focused}`).join('\n')), json(rows)] };
  }));

  server.registerTool('switch_scene', { title: 'Switch scene', description: 'Make a scene tab active in the window.', inputSchema: { sceneId: z.string() } }, (args) => run(async () => {
    const result = await store.dispatch({ type: 'switch_scene', sceneId: args.sceneId }, 'mcp');
    return { content: [text(result.message), json(stateJson())] };
  }));

  server.registerTool('edit_molecule', {
    title: 'Edit the molecule',
    description: 'Apply atom-level edits to the focused molecule. Atom numbers come from the most recent result (call get_current to re-read them). Ops: add_atom {element, bondTo, order?}, remove_atom {index}, set_element {index, element}, set_charge {index, charge}, add_bond {a, b, order?}, remove_bond {a, b}, set_bond_order {a, b, order}, attach_group {index, group}, replace_group {index, group} where index is a hydrogen or a leaf atom. Named groups: H OH NH2 CH3 C2H5 COOH CHO CN NO2 SO3H OCH3 SH F Cl Br I phenyl, or any SMILES fragment. Hydrogens are re-saturated automatically. A rejected edit leaves the molecule unchanged.',
    inputSchema: { ops: z.array(EditOpSchema).min(1), name: z.string().optional().describe('Display name for the result.') },
  }, (args) => run(async () => {
    const result = await store.dispatch({ type: 'edit', ops: args.ops, name: args.name }, 'mcp');
    const scene = store.scene(result.sceneId);
    const species = store.focused(scene.id);
    return { content: [text(`${result.message}\n${speciesText(species, deps, scene)}`), json({ ...stateJson(), speciesId: species.id }), await image(species.svg2dNumbered, 480)] };
  }));

  server.registerTool('set_view', {
    title: 'Change the 3D view',
    description: 'Style, labels, highlighted atoms, spin, hydrogens, dipole arrow, camera preset, or a relative rotation. Returns a 3D image of the result.',
    inputSchema: {
      style: z.enum(['ballstick', 'stick', 'spacefill', 'wireframe']).optional(),
      labels: z.enum(['none', 'element', 'index']).optional(),
      highlight: z.array(z.number().int().min(1)).optional().describe('Atom numbers to highlight; [] clears.'),
      spin: z.boolean().optional(),
      showHydrogens: z.boolean().optional(),
      showDipole: z.boolean().optional(),
      preset: z.enum(['fit', 'front', 'top', 'side']).optional(),
      rotate: z.object({ axis: z.enum(['x', 'y', 'z']), degrees: z.number() }).optional().describe('Rotate relative to the current view.'),
      width: widthArg,
    },
  }, (args) => run(async () => {
    const scene = store.activeScene();
    const { preset, rotate, width, ...fields } = args;
    const rotation: [number, number, number] = [...scene.view.camera.rotation];
    if (rotate) rotation[{ x: 0, y: 1, z: 2 }[rotate.axis]] += rotate.degrees;
    const camera = preset || rotate ? { preset: preset ?? scene.view.camera.preset, rotation } : undefined;
    await store.dispatch({ type: 'set_view', view: { ...fields, ...(camera ? { camera } : {}) } }, 'mcp');
    const species = store.focused(scene.id);
    const bytes = await render3dPng(deps, store.activeScene(), species, width);
    return { content: [text(`View updated: ${JSON.stringify(store.activeScene().view)}`), { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' }] };
  }));

  for (const kind of ['undo', 'redo'] as const) {
    server.registerTool(kind, { title: kind === 'undo' ? 'Undo' : 'Redo', description: `${kind === 'undo' ? 'Undo' : 'Redo'} the last structural change in the active scene. View changes are not part of history.`, inputSchema: {} }, () => run(async () => {
      const result = await store.dispatch({ type: kind }, 'mcp');
      const species = store.focused(result.sceneId);
      return { content: [text(`${result.message}\n${speciesText(species, deps, store.scene(result.sceneId))}`), json({ ...stateJson(), speciesId: species.id })] };
    }));
  }

  return server;
}

/** Stateless Streamable HTTP mount: a fresh server and transport per request. */
export function mountMcp(app: Hono, deps: AppDeps): void {
  app.all('/mcp', async (c) => {
    const server = createMcpServer(deps);
    const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return transport.handleRequest(c);
  });
}

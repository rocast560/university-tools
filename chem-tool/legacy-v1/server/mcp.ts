// The MCP server: nine tools over the same service layer the REST API
// uses. createMcpServer() is called once per HTTP request (stateless
// transport) and once for the stdio entry point.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BalanceError } from '../src/chem/balance.ts';
import { FormulaError } from '../src/chem/formula.ts';
import { library } from '../src/chem/library.ts';
import type { RenderStyle } from '../src/chem/render3d.ts';
import { APP_NAME, APP_VERSION, PUBLIC_URL } from './config.ts';
import {
  balance,
  depiction2dPng,
  describe,
  formulaInfo,
  latticeFor,
  latticeList,
  latticeSummary,
  linksFor,
  resolveQuery,
  snapshotPng,
  structureOf,
  summary,
  toPdb,
  toXyz,
} from './service.ts';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

function text(t: string): Content {
  return { type: 'text', text: t };
}

function image(png: Uint8Array): Content {
  return { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' };
}

function fail(message: string, extra?: Record<string, unknown>) {
  return { isError: true as const, content: [text(message)], structuredContent: { ok: false, error: message, ...extra } };
}

const queryField = z
  .string()
  .min(1)
  .describe('Chemical name ("acetic acid"), formula ("CH3COOH", "Ca(OH)2"), CAS number, PubChem CID, or SMILES.');

const styleField = z.enum(['ballstick', 'stick', 'spacefill']).optional().describe('Rendering style; default ballstick.');

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: APP_NAME, version: APP_VERSION },
    {
      instructions:
        'Chemistry Tool looks up chemicals by name, formula, CAS, CID or SMILES and returns properties, 2D structure images, 3D ball-and-stick renders and structure files. ' +
        'Several hundred engineering chemistry compounds are local; anything else comes from PubChem. ' +
        `A web view of any result is at ${PUBLIC_URL}/?q=<query>.`,
    },
  );

  server.registerTool(
    'lookup_chemical',
    {
      title: 'Look up a chemical',
      description:
        'Identify a chemical from a name, formula, CAS number, PubChem CID or SMILES and return its formula, molar mass, IUPAC name, SMILES, composition, description, isomers sharing the formula, crystal structure when it is a common solid, and links to images and structure files.',
      inputSchema: { query: queryField },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query }) => {
      const result = await resolveQuery(query);
      if (!result.ok) {
        return fail(result.error + (result.suggestions.length ? `\nDid you mean: ${result.suggestions.map((s) => `${s.name} (${s.formula})`).join(', ')}?` : ''), { suggestions: result.suggestions });
      }
      const r = result.resolved;
      return {
        content: [text(describe(result))],
        structuredContent: {
          ok: true,
          matchedOn: r.matchedOn,
          compound: r.compound,
          alternatives: r.alternatives.map((a) => ({ id: a.id, name: a.name, formula: a.formula, molarMass: a.molarMass })),
          composition: r.composition,
          lattice: r.lattice ?? null,
          structureSource: r.structureSource,
          warnings: r.warnings,
          links: linksFor(r.query),
        },
      };
    },
  );

  server.registerTool(
    'render_2d',
    {
      title: 'Draw the 2D structure',
      description: 'Render the 2D skeletal structure of a chemical as a PNG image.',
      inputSchema: {
        query: queryField,
        theme: z.enum(['light', 'dark']).optional().describe('Background theme; default light.'),
        width: z.number().int().min(128).max(2048).optional().describe('Image width in pixels; default 640.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, theme, width }) => {
      const result = await resolveQuery(query);
      if (!result.ok) return fail(result.error);
      const r = result.resolved;
      if (!r.svg) return fail(`${r.compound.name} has no 2D depiction (no SMILES available).`);
      const png = depiction2dPng(r.svg, theme ?? 'light', width ?? 640);
      return {
        content: [
          image(png),
          text(`2D structure of ${r.compound.name} (${r.compound.formulaUnicode}). SVG: ${linksFor(r.query).svg2d}`),
        ],
      };
    },
  );

  server.registerTool(
    'render_3d',
    {
      title: 'Render the 3D model',
      description:
        'Render a 3D ball-and-stick (or stick, or space-filling) model of a chemical as a PNG snapshot. For an interactive rotatable model open the returned web link.',
      inputSchema: {
        query: queryField,
        style: styleField,
        labels: z.boolean().optional().describe('Label heavy atoms with element symbols.'),
        theme: z.enum(['light', 'dark']).optional(),
        rotate_x: z.number().optional().describe('Extra rotation in degrees about the horizontal axis.'),
        rotate_y: z.number().optional().describe('Extra rotation in degrees about the vertical axis.'),
        width: z.number().int().min(128).max(2048).optional(),
        height: z.number().int().min(128).max(2048).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, style, labels, theme, rotate_x, rotate_y, width, height }) => {
      const result = await resolveQuery(query);
      if (!result.ok) return fail(result.error);
      const r = result.resolved;
      const s = structureOf(r.molfile);
      if (!s) return fail(`No 3D structure is available for ${r.compound.name}.`);
      const png = snapshotPng(s, { style: style as RenderStyle | undefined, labels, theme, rotate: { x: rotate_x, y: rotate_y }, width, height });
      const caption = [
        `3D model of ${r.compound.name} (${r.compound.formulaUnicode}), ${s.atoms.length} atoms, geometry from ${r.structureSource}.`,
        ...r.warnings,
        `Interactive view: ${linksFor(r.query).page}`,
      ].join('\n');
      return { content: [image(png), text(caption)] };
    },
  );

  server.registerTool(
    'get_structure',
    {
      title: 'Get the structure file',
      description: 'Return the 3D structure of a chemical as SDF/MOL (V2000), XYZ or PDB text, or its SMILES.',
      inputSchema: {
        query: queryField,
        format: z.enum(['sdf', 'xyz', 'pdb', 'smiles']).optional().describe('Default sdf.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, format }) => {
      const result = await resolveQuery(query);
      if (!result.ok) return fail(result.error);
      const r = result.resolved;
      const fmt = format ?? 'sdf';
      if (fmt === 'smiles') return { content: [text(r.compound.smiles || '(no SMILES available)')] };
      const s = structureOf(r.molfile);
      if (!s || !r.molfile) return fail(`No 3D structure is available for ${r.compound.name}.`);
      const body = fmt === 'sdf' ? r.molfile : fmt === 'xyz' ? toXyz(s, r.compound.name) : toPdb(s, r.compound.name);
      return { content: [text(body)] };
    },
  );

  server.registerTool(
    'search_chemicals',
    {
      title: 'Search the library',
      description: 'Autocomplete style search of the local compound library by name, alias or formula prefix.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      const hits = library().search(query, limit ?? 10);
      if (hits.length === 0) return { content: [text(`No library entries match "${query}". lookup_chemical can still find it on PubChem.`)], structuredContent: { hits: [] } };
      const rows = hits.map((h) => `${h.entry.name}  ${h.entry.formula}  (${h.entry.category}; matched ${h.matchedOn} "${h.matchedText}")`);
      return { content: [text(rows.join('\n'))], structuredContent: { hits: hits.map((h) => ({ ...summary(h.entry), matchedOn: h.matchedOn })) } };
    },
  );

  server.registerTool(
    'list_library',
    {
      title: 'List the library',
      description: 'List the categories of the local library, or every compound in one category.',
      inputSchema: { category: z.string().optional().describe('Leave empty to list categories with counts.') },
      annotations: { readOnlyHint: true },
    },
    async ({ category }) => {
      const lib = library();
      if (!category) {
        const cats = lib.categories();
        return {
          content: [text(cats.map((c) => `${c.category}: ${c.count}`).join('\n') + `\n\nTotal: ${lib.size} compounds.`)],
          structuredContent: { categories: cats, total: lib.size },
        };
      }
      const entries = lib.byCategory(category);
      if (entries.length === 0) return fail(`No category "${category}". Categories: ${lib.categories().map((c) => c.category).join('; ')}`);
      return {
        content: [text(entries.map((e) => `${e.name}  ${e.formula}  ${e.molarMass} g/mol${e.note ? `  ${e.note}` : ''}`).join('\n'))],
        structuredContent: { category, entries: entries.map(summary) },
      };
    },
  );

  server.registerTool(
    'formula_info',
    {
      title: 'Formula information',
      description: 'Parse a chemical formula (hydrates, brackets and charges allowed) and return element counts, Hill formula, molar mass and mass percent composition, plus any known compounds with that formula.',
      inputSchema: { formula: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ formula }) => {
      try {
        const info = formulaInfo(formula);
        const lines = [
          `${info.formulaUnicode}: molar mass ${info.molarMass} g/mol${info.charge ? `, charge ${info.charge}` : ''}`,
          ...info.composition.map((c) => `${c.name} (${c.symbol}) × ${c.count}: ${c.mass} g/mol, ${c.massPercent}%`),
        ];
        if (info.knownCompounds.length) lines.push(`Known compounds: ${info.knownCompounds.map((k) => `${k.name} (${k.formula})`).join(', ')}`);
        return { content: [text(lines.join('\n'))], structuredContent: info };
      } catch (err) {
        if (err instanceof FormulaError) return fail(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    'balance_equation',
    {
      title: 'Balance a chemical equation',
      description: 'Balance an equation written as "reactants -> products" (also "=" or "→"), including ionic equations with charges and electrons (e-).',
      inputSchema: { equation: z.string().min(3).describe('For example "Fe + O2 -> Fe2O3" or "MnO4- + H+ + e- -> Mn2+ + H2O".') },
      annotations: { readOnlyHint: true },
    },
    async ({ equation }) => {
      try {
        const r = balance(equation);
        return { content: [text(`${r.equation}\n(${r.ascii})`)], structuredContent: r };
      } catch (err) {
        if (err instanceof BalanceError || err instanceof FormulaError) return fail(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    'crystal_lattice',
    {
      title: 'Crystal lattice model',
      description:
        'Build an idealised unit cell cluster for a common solid (NaCl rock salt, CsCl, bcc iron, fcc copper, hcp magnesium, diamond, silicon, graphite, zinc blende, fluorite, perovskite) and return its parameters with a PNG render and optionally the SDF.',
      inputSchema: {
        material: z.string().min(1).describe('Formula, element or structure name: "NaCl", "iron", "diamond", "fcc", "perovskite".'),
        repeat: z.number().int().min(1).max(4).optional().describe('Unit cells per axis; default 2.'),
        include_sdf: z.boolean().optional().describe('Also return the SDF text of the cluster.'),
        theme: z.enum(['light', 'dark']).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ material, repeat, include_sdf, theme }) => {
      const r = latticeFor(material, repeat ?? 2);
      if (!r) return fail(`No lattice model for "${material}". Available: ${latticeList().map((m) => `${m.name} (${m.formula})`).join(', ')}`);
      const info = latticeSummary(r);
      const lines = r.edges.map(([from, to]) => ({ from, to, color: '#8a8f9a' }));
      const png = snapshotPng(r.cluster, { theme, style: 'ballstick', lines, labels: false });
      const caption = [
        `${info.name}: ${info.title}, a = ${info.a} Å${info.c ? `, c = ${info.c} Å` : ''}.`,
        `${info.atomsPerCell} atoms per unit cell, coordination number ${info.coordination}${info.packingFactor ? `, atomic packing factor ${info.packingFactor}` : ''}.`,
        info.note,
        `Cluster shown: ${info.repeat}×${info.repeat}×${info.repeat} cells, ${info.atomsShown} atoms.`,
        `Interactive view: ${PUBLIC_URL}/?q=${encodeURIComponent(material)}&view=lattice`,
      ];
      const content: Content[] = [image(png), text(caption.join('\n'))];
      if (include_sdf) content.push(text(r.molfile));
      return { content, structuredContent: info };
    },
  );

  server.registerResource(
    'library',
    'chem://library',
    { title: 'Compound library', description: 'Every compound in the local library with formula, molar mass and category.', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(library().entries.map(summary)) }],
    }),
  );

  server.registerResource(
    'lattices',
    'chem://lattices',
    { title: 'Crystal lattice models', description: 'Materials with an idealised unit cell model.', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(latticeList()) }] }),
  );

  return server;
}

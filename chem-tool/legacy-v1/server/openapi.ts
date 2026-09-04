// OpenAPI 3.1 document for the REST routes, served at /openapi.json. This
// is what ChatGPT Custom GPT Actions and other OpenAPI clients import.

import { APP_VERSION, PUBLIC_URL } from './config.ts';

const q = {
  name: 'q',
  in: 'query',
  required: true,
  description: 'Chemical name, formula (any spelling: H2O, CH3COOH, Ca(OH)2, CuSO4.5H2O), CAS number, PubChem CID or SMILES.',
  schema: { type: 'string' },
  example: 'acetic acid',
};

const theme = { name: 'theme', in: 'query', required: false, schema: { type: 'string', enum: ['light', 'dark'] } };
const width = { name: 'width', in: 'query', required: false, schema: { type: 'integer', minimum: 64, maximum: 2048 } };
const height = { name: 'height', in: 'query', required: false, schema: { type: 'integer', minimum: 64, maximum: 2048 } };
const style = { name: 'style', in: 'query', required: false, schema: { type: 'string', enum: ['ballstick', 'stick', 'spacefill'] } };
const labels = { name: 'labels', in: 'query', required: false, schema: { type: 'string', enum: ['0', '1'] } };
const rotate = ['rx', 'ry', 'rz'].map((name) => ({ name, in: 'query', required: false, description: 'Extra rotation in degrees.', schema: { type: 'number' } }));

const errorResponse = {
  description: 'Not found or invalid input',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
};

function imageResponse(mime: string, description: string) {
  return { '200': { description, content: { [mime]: { schema: { type: 'string', format: 'binary' } } } }, '404': errorResponse };
}

export function openapiDocument() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Chemistry Tool API',
      version: APP_VERSION,
      description:
        'Look up chemicals by name, formula, CAS, CID or SMILES; get properties, 2D structure images, 3D structure files and rendered snapshots; parse formulas; balance equations; build crystal lattice models.',
    },
    servers: [{ url: PUBLIC_URL }],
    paths: {
      '/api/molecule': {
        get: {
          operationId: 'lookupChemical',
          summary: 'Identify a chemical and return everything known about it',
          parameters: [
            q,
            { name: 'svg', in: 'query', required: false, description: 'Set 0 to omit the 2D SVG.', schema: { type: 'string', enum: ['0', '1'] } },
            { name: 'structure', in: 'query', required: false, description: 'Set 0 to omit the 3D molfile.', schema: { type: 'string', enum: ['0', '1'] } },
          ],
          responses: {
            '200': { description: 'Resolved compound', content: { 'application/json': { schema: { $ref: '#/components/schemas/Molecule' } } } },
            '404': errorResponse,
            '502': { description: 'Not in the local library and PubChem unreachable' },
          },
        },
      },
      '/api/molecule/2d.svg': { get: { operationId: 'structure2dSvg', summary: '2D structure as SVG', parameters: [q, theme], responses: imageResponse('image/svg+xml', 'SVG image') } },
      '/api/molecule/2d.png': { get: { operationId: 'structure2dPng', summary: '2D structure as PNG', parameters: [q, theme, width], responses: imageResponse('image/png', 'PNG image') } },
      '/api/molecule/3d.sdf': { get: { operationId: 'structure3dSdf', summary: '3D structure as SDF/MOL V2000', parameters: [q], responses: imageResponse('chemical/x-mdl-sdfile', 'SDF text') } },
      '/api/molecule/3d.xyz': { get: { operationId: 'structure3dXyz', summary: '3D structure as XYZ', parameters: [q], responses: imageResponse('chemical/x-xyz', 'XYZ text') } },
      '/api/molecule/3d.pdb': { get: { operationId: 'structure3dPdb', summary: '3D structure as PDB', parameters: [q], responses: imageResponse('chemical/x-pdb', 'PDB text') } },
      '/api/molecule/3d.svg': { get: { operationId: 'render3dSvg', summary: 'Rendered 3D snapshot as SVG', parameters: [q, style, labels, theme, width, height, ...rotate], responses: imageResponse('image/svg+xml', 'SVG image') } },
      '/api/molecule/3d.png': { get: { operationId: 'render3dPng', summary: 'Rendered 3D snapshot as PNG', parameters: [q, style, labels, theme, width, height, ...rotate], responses: imageResponse('image/png', 'PNG image') } },
      '/api/search': {
        get: {
          operationId: 'searchChemicals',
          summary: 'Autocomplete search of the local library',
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 50 } },
            { name: 'remote', in: 'query', required: false, description: 'Set 1 to add PubChem name completions.', schema: { type: 'string', enum: ['0', '1'] } },
          ],
          responses: { '200': { description: 'Hits', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/api/library': {
        get: {
          operationId: 'listLibrary',
          summary: 'List library compounds, optionally by category',
          parameters: [{ name: 'category', in: 'query', required: false, schema: { type: 'string' } }],
          responses: { '200': { description: 'Entries', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/api/categories': { get: { operationId: 'listCategories', summary: 'Library categories with counts', responses: { '200': { description: 'Categories' } } } },
      '/api/formula': {
        get: {
          operationId: 'formulaInfo',
          summary: 'Parse a formula: counts, molar mass, composition',
          parameters: [{ name: 'f', in: 'query', required: true, schema: { type: 'string' }, example: 'Ca(OH)2' }],
          responses: { '200': { description: 'Formula information' }, '400': errorResponse },
        },
      },
      '/api/balance': {
        get: {
          operationId: 'balanceEquation',
          summary: 'Balance a chemical equation',
          parameters: [{ name: 'eq', in: 'query', required: true, schema: { type: 'string' }, example: 'Fe + O2 -> Fe2O3' }],
          responses: { '200': { description: 'Balanced equation' }, '400': errorResponse },
        },
      },
      '/api/lattices': { get: { operationId: 'listLattices', summary: 'Materials with a crystal lattice model', responses: { '200': { description: 'Materials' } } } },
      '/api/lattice': {
        get: {
          operationId: 'crystalLattice',
          summary: 'Unit cell cluster for a solid (NaCl, iron, diamond, perovskite ...)',
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' }, example: 'NaCl' },
            { name: 'repeat', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 4 } },
          ],
          responses: { '200': { description: 'Lattice with molfile and cell edges' }, '404': errorResponse },
        },
      },
      '/api/lattice/3d.sdf': { get: { operationId: 'crystalLatticeSdf', summary: 'Lattice cluster as SDF', parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }], responses: imageResponse('chemical/x-mdl-sdfile', 'SDF text') } },
      '/api/lattice/3d.png': { get: { operationId: 'crystalLatticePng', summary: 'Lattice cluster rendered as PNG', parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }, theme, width, height], responses: imageResponse('image/png', 'PNG image') } },
      '/api/connect': { get: { operationId: 'connectInfo', summary: 'Connection snippets for Claude Desktop, Claude Code, ChatGPT', responses: { '200': { description: 'Snippets' } } } },
      '/api/health': { get: { operationId: 'health', summary: 'Liveness', responses: { '200': { description: 'OK' } } } },
    },
    components: {
      schemas: {
        Error: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', const: false },
            error: { type: 'string' },
            suggestions: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, formula: { type: 'string' } } } },
          },
        },
        Compound: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            formula: { type: 'string' },
            formulaHtml: { type: 'string' },
            formulaUnicode: { type: 'string' },
            hill: { type: 'string' },
            molarMass: { type: 'number', description: 'g/mol' },
            charge: { type: 'integer' },
            smiles: { type: 'string' },
            iupac: { type: 'string' },
            aliases: { type: 'array', items: { type: 'string' } },
            category: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            note: { type: 'string' },
            kind: { type: 'string', enum: ['molecule', 'ionic', 'element', 'network'] },
            cid: { type: ['integer', 'null'] },
            cas: { type: ['string', 'null'] },
            source: { type: 'string', enum: ['library', 'pubchem', 'smiles', 'lattice'] },
            pubchemUrl: { type: ['string', 'null'] },
          },
        },
        Molecule: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            query: { type: 'string' },
            matchedOn: { type: 'string' },
            compound: { $ref: '#/components/schemas/Compound' },
            alternatives: { type: 'array', items: { $ref: '#/components/schemas/Compound' } },
            composition: { type: 'array', items: { type: 'object' } },
            warnings: { type: 'array', items: { type: 'string' } },
            lattice: { type: ['object', 'null'] },
            structureSource: { type: 'string' },
            svg: { type: 'string', description: '2D depiction, SVG markup' },
            molfile: { type: ['string', 'null'], description: '3D structure, MDL V2000' },
            links: { type: 'object', additionalProperties: { type: 'string' } },
          },
        },
      },
    },
  };
}

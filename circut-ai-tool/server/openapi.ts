// OpenAPI 3.1 description of the REST routes (also usable as a ChatGPT Action).

import { APP_NAME, APP_VERSION, PUBLIC_URL } from './config.ts';

const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'project id from /api/projects/open' };
const json = (description: string) => ({ description, content: { 'application/json': { schema: { type: 'object' } } } });
const op = (summary: string, extra: Record<string, unknown> = {}) => ({ summary, parameters: [id], responses: { '200': json('OK'), '400': json('bad request'), '404': json('not open') }, ...extra });
const body = (schema: Record<string, unknown>) => ({ required: true, content: { 'application/json': { schema } } });

export function openapiDocument() {
  return {
    openapi: '3.1.0',
    info: { title: APP_NAME, version: APP_VERSION, description: 'KiCad schematic to breadboard layout, build guide, checks, logic simulation and schematic edits.' },
    servers: [{ url: PUBLIC_URL }],
    paths: {
      '/api/projects': { get: { summary: 'Recent and discovered schematics', responses: { '200': json('lists') } } },
      '/api/projects/open': { post: { summary: 'Open a .kicad_sch by absolute path', requestBody: body({ type: 'object', required: ['path'], properties: { path: { type: 'string' } } }), responses: { '200': json('summary') } } },
      '/api/projects/{id}': { get: op('Summary of an open project'), delete: op('Close a project') },
      '/api/projects/{id}/refresh': { post: op('Re-read the schematic from disk') },
      '/api/projects/{id}/layout': { get: op('Full layout document') },
      '/api/projects/{id}/steps': { get: op('Build steps') },
      '/api/projects/{id}/checks': { get: op('Checks') },
      '/api/projects/{id}/truth-table': { get: op('Truth table') },
      '/api/projects/{id}/pinouts': { get: op('Chip pinouts with holes') },
      '/api/projects/{id}/netlist': { get: op('kicad-cli netlist text (the client parses it to run the layout engine locally)') },
      '/api/projects/{id}/sidecar': { get: op('Pinned placements, options and colours') },
      '/api/projects/{id}/board.svg': { get: op('Breadboard picture as SVG', { parameters: [id, { name: 'highlight', in: 'query', schema: { type: 'string' }, description: 'net:/A, ref:R1 or wire:3' }, { name: 'theme', in: 'query', schema: { type: 'string', enum: ['light', 'dark'] } }] }) },
      '/api/projects/{id}/board.png': { get: op('Breadboard picture as PNG') },
      '/api/projects/{id}/schematic.svg': { get: op('KiCad schematic as SVG') },
      '/api/projects/{id}/sim': { post: op('Simulate with explicit input levels', { requestBody: body({ type: 'object', properties: { levels: { type: 'object', additionalProperties: { type: 'integer', enum: [0, 1] } } } }) }) },
      '/api/projects/{id}/layout/options': { post: op('Set layout options', { requestBody: body({ type: 'object', properties: { board: { type: 'string', enum: ['auto', 'half', 'full'] }, railSplit: { type: ['boolean', 'null'] }, dipSwitchPositions: { type: 'integer' }, packageOrder: { type: 'array', items: { type: 'string' } }, substitutions: { type: 'object' } } }) }) },
      '/api/projects/{id}/layout/move': { post: op('Move a part to given holes', { requestBody: body({ type: 'object', required: ['ref', 'holes'], properties: { ref: { type: 'string' }, holes: { type: 'object' } } }) }) },
      '/api/projects/{id}/layout/colors': { post: op('Set a net colour', { requestBody: body({ type: 'object', required: ['net'], properties: { net: { type: 'string' }, color: { type: ['string', 'null'] } } }) }) },
      '/api/projects/{id}/layout/reset': { post: op('Forget pinned placements, options and colours') },
      '/api/projects/{id}/erc': { post: op('Run KiCad ERC') },
      '/api/parts': { get: { summary: 'Supported parts and aliases', responses: { '200': json('list') } } },
      '/api/connect': { get: { summary: 'Connection snippets', responses: { '200': json('snippets') } } },
    },
  };
}

// HTTP entry point: `npm start` (or `node server/index.ts`).

import { serve } from '@hono/node-server';
import { library } from '../src/chem/library.ts';
import { app } from './app.ts';
import { HOST, PORT, PUBLIC_URL } from './config.ts';

const lib = library();

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, () => {
  console.log(`Chemistry Tool: ${PUBLIC_URL}  (${lib.size} compounds in the local library)`);
  console.log(`  API      ${PUBLIC_URL}/api/molecule?q=water`);
  console.log(`  OpenAPI  ${PUBLIC_URL}/openapi.json`);
  console.log(`  MCP      ${PUBLIC_URL}/mcp`);
});

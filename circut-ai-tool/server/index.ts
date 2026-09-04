// HTTP entry point: `bun start`.

import { createApp } from './app.ts';
import { bootService } from './boot.ts';
import { HOST, KICAD_CLI, PORT, PUBLIC_URL } from './config.ts';
import { createMcpServer } from './mcp.ts';

const { service, events, kicad } = await bootService({ watch: true });
const app = createApp({ service, events, mcp: () => createMcpServer(service) });

Bun.serve({ hostname: HOST, port: PORT, fetch: app.fetch, idleTimeout: 255 });
console.log(`Circuit AI Tool: ${PUBLIC_URL}`);
console.log(`  API      ${PUBLIC_URL}/api/projects`);
console.log(`  OpenAPI  ${PUBLIC_URL}/openapi.json`);
console.log(`  MCP      ${PUBLIC_URL}/mcp  (alias ${PUBLIC_URL}/mcp-server/mcp)`);
console.log(`  kicad-cli ${(await kicad.available()) ? 'found' : 'NOT FOUND'} at ${KICAD_CLI}`);

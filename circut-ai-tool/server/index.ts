// Entry point. `bun start` serves HTTP; `--stdio` speaks MCP over stdio instead,
// so the packaged single-file executable can do both (Claude Desktop launches it
// with --stdio; the desktop shell launches it without).

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApp } from './app.ts';
import { bootService } from './boot.ts';
import { HOST, KICAD_CLI, PORT, PUBLIC_URL } from './config.ts';
import { createMcpServer } from './mcp.ts';

if (process.argv.includes('--stdio')) {
  // stdout carries the protocol; every diagnostic must go to stderr.
  console.log = (...args: unknown[]) => console.error(...args);
  const { service } = await bootService({ watch: true });
  await createMcpServer(service).connect(new StdioServerTransport());
  console.error('[circuit-ai-tool] stdio MCP server ready');
} else {
  const { service, events, kicad } = await bootService({ watch: true });
  const app = createApp({ service, events, mcp: () => createMcpServer(service), kicad });

  Bun.serve({ hostname: HOST, port: PORT, fetch: app.fetch, idleTimeout: 255 });
  console.log(`Circuit AI Tool: ${PUBLIC_URL}`);
  console.log(`  API      ${PUBLIC_URL}/api/projects`);
  console.log(`  OpenAPI  ${PUBLIC_URL}/openapi.json`);
  console.log(`  MCP      ${PUBLIC_URL}/mcp  (alias ${PUBLIC_URL}/mcp-server/mcp)`);
  console.log(`  kicad-cli ${(await kicad.available()) ? 'found' : 'NOT FOUND'} at ${KICAD_CLI}`);
}

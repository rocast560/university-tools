// stdio MCP entry point for clients that launch a command (Claude Desktop).
// stdout carries the protocol; diagnostics go to stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { bootService } from './boot.ts';
import { reportStdioActivity } from './clients.ts';
import { PUBLIC_URL } from './config.ts';
import { createMcpServer } from './mcp.ts';

console.log = (...args: unknown[]) => console.error(...args);
const { service } = await bootService({ watch: true });
const server = createMcpServer(service);
const transport = new StdioServerTransport();
await server.connect(transport);
reportStdioActivity(transport, PUBLIC_URL);
console.error('[circuit-ai-tool] stdio MCP server ready');

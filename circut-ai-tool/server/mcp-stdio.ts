// stdio MCP entry point for clients that launch a command (Claude Desktop).
// stdout carries the protocol; diagnostics go to stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { bootService } from './boot.ts';
import { createMcpServer } from './mcp.ts';

console.log = (...args: unknown[]) => console.error(...args);
const { service } = await bootService({ watch: true });
const server = createMcpServer(service);
await server.connect(new StdioServerTransport());
console.error('[circuit-ai-tool] stdio MCP server ready');

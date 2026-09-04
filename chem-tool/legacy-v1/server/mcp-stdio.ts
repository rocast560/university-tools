// stdio MCP entry point, for clients that launch a command instead of
// dialling a URL (Claude Desktop, `claude mcp add ... -- node ...`).
//
// The tools run in this process, so nothing else has to be running; the
// only difference from the HTTP endpoint is that "open in the app" links
// need `npm start` to be up before they work.
//
// stdout carries the protocol and nothing else; diagnostics go to stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { library } from '../src/chem/library.ts';
import { createMcpServer } from './mcp.ts';

console.log = (...args: unknown[]) => console.error(...args);

const lib = library();
const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[chemistry-tool] stdio MCP server ready, ${lib.size} compounds in the local library`);

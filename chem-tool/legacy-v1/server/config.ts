// Runtime settings shared by the HTTP server, the MCP tools and the
// connection snippets. Environment variables override the defaults:
//
//   CHEM_PORT   TCP port (default 8140)
//   CHEM_HOST   bind address (default 127.0.0.1; 0.0.0.0 to reach it from other machines)

export const PORT = Number(process.env.CHEM_PORT ?? 8140);
export const HOST = process.env.CHEM_HOST ?? '127.0.0.1';

/** The URL users open in a browser; loopback even when bound to 0.0.0.0. */
export const PUBLIC_URL = process.env.CHEM_PUBLIC_URL ?? `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;

export const APP_NAME = 'chemistry-tool';
export const APP_VERSION = '0.1.0';

// Bun entry point. The only file that may use Bun APIs.

import path from 'node:path';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { PubChem } from '../src/chem/pubchem';
import { createResolver } from '../src/chem/resolve';
import { createApp } from './app';
import { config } from './config';
import { createSaver, loadWorkspace } from './persist';
import { WorkspaceStore, createInitialWorkspace } from './workspace';

const file = path.join(config.dataDir, 'workspace.json');
const saver = createSaver(file);
const resolver = createResolver({ pubchem: new PubChem({ cacheDir: path.join(config.dataDir, 'cache', 'pubchem') }) });
const store = new WorkspaceStore((await loadWorkspace(file)) ?? createInitialWorkspace(), resolver, saver.save);
const { app } = createApp({ store, resolver, staticDir: config.staticDir, upgradeWebSocket, host: config.host, port: config.port });

const server = Bun.serve({ port: config.port, hostname: config.host, fetch: app.fetch, websocket });
console.log(`ChemTool server: http://${config.host}:${server.port}  data: ${config.dataDir}  static: ${config.staticDir}`);

const shutdown = async () => {
  await saver.flush();
  server.stop(true);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

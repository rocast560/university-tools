declare const Bun: { serve(options: Record<string, unknown>): { hostname: string; port: number } };

import { DEFAULT_TEMPLATE } from '../src/template';
import { loadConfig } from './config';
import { createEventBus } from './events';
import { createHandler } from './router';
import { createWorkspaceService } from './service';
import { createSettingsStore } from './settings';
import { createWatcher } from './watcher';

const config = loadConfig();
const bus = createEventBus();
const settings = createSettingsStore(config.dataDir);
const watcher = createWatcher({ bus });
const service = createWorkspaceService({ settings, bus, watcher, dataDir: config.dataDir, workspacesDir: config.workspacesDir, template: DEFAULT_TEMPLATE });
service.boot();

// Later tasks replace these nulls: backup (Task 12), compile (Task 9), mcp (Task 13), browse (Task 12).
const handler = createHandler({ settings, service, bus, token: config.token, staticDir: config.staticDir, dataDir: config.dataDir, backup: null, compile: null, mcp: null, browse: null });

Bun.serve({ hostname: config.host, port: config.port, maxRequestBodySize: 32 * 1024 * 1024, idleTimeout: 120, fetch: handler });
console.log(`[tfs] listening on http://${config.host}:${config.port}  data=${config.dataDir}  static=${config.staticDir ?? '(api only)'}  auth=${config.token ? 'token' : 'open'}`);

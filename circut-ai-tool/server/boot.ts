// Wire the real dependencies together (used by the HTTP and stdio entries).

import path from 'node:path';
import { DATA_DIR, KICAD_CLI, KICAD_SYMBOL_DIR, PROJECTS_DIR } from './config.ts';
import { createKicadCli } from './kicad-cli.ts';
import { createLibraryLookup } from './libraries.ts';
import { ProjectRegistry } from './projects.ts';
import { Service, type ProjectEvent } from './service.ts';
import { Events } from './watch.ts';

export async function bootService(opts: { watch?: boolean } = {}) {
  const registry = new ProjectRegistry(DATA_DIR);
  await registry.load();
  const events = new Events<ProjectEvent>();
  const kicad = createKicadCli({ exe: KICAD_CLI, cacheDir: path.join(DATA_DIR, 'cache') });
  const libs = createLibraryLookup({ symbolDir: KICAD_SYMBOL_DIR });
  const service = new Service({ kicad, registry, events, watch: opts.watch ?? true, projectsDir: PROJECTS_DIR, libs });
  return { service, events, kicad };
}

// Project folders, resolved from this file so they are right no matter
// which entry point (server, stdio MCP, build script, tests) is running
// or what the working directory is.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');
export const SDF_DIR = path.join(DATA_DIR, 'sdf');
export const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
export const CACHE_DIR = path.join(PROJECT_ROOT, 'cache');
export const DIST_DIR = path.join(PROJECT_ROOT, 'dist');

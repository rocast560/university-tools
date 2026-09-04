// Runtime settings. Environment variables override the defaults.

import os from 'node:os';
import path from 'node:path';

export const PORT = Number(process.env.CIRCUIT_PORT ?? 8765);
export const HOST = process.env.CIRCUIT_HOST ?? '127.0.0.1';
export const PUBLIC_URL = process.env.CIRCUIT_PUBLIC_URL ?? `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
export const APP_NAME = 'circuit-ai-tool';
export const APP_VERSION = '0.1.0';

const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
const kicadRoot = path.join(localAppData, 'Programs', 'KiCad', '9.0');

export const KICAD_CLI = process.env.KICAD_CLI ?? path.join(kicadRoot, 'bin', 'kicad-cli.exe');
export const KICAD_SYMBOL_DIR = process.env.KICAD_SYMBOL_DIR ?? path.join(kicadRoot, 'share', 'kicad', 'symbols');
export const DATA_DIR = process.env.DATA_DIR ?? path.join(localAppData, 'UniversityTools', 'circuit');
export const PROJECTS_DIR = process.env.PROJECTS_DIR ?? path.join(os.homedir(), 'Documents', 'KiCad', '9.0', 'projects');

// Both must be overridable by environment: under `bun build --compile`,
// import.meta.dir resolves inside Bun's virtual filesystem (B:\~BUN\...), so a
// packaged build would serve nothing. The desktop shell passes STATIC_DIR.
export const PROJECT_ROOT = process.env.PROJECT_ROOT ?? path.resolve(import.meta.dir, '..');
export const DIST_DIR = process.env.STATIC_DIR ?? path.join(PROJECT_ROOT, 'dist');

/** Set by the desktop shell to its own sidecar path, for the stdio MCP snippet. */
export const PACKAGED_EXE = process.env.CIRCUIT_EXE ?? null;

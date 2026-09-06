// Runtime settings. Environment variables override the defaults; the defaults
// depend on the platform (Windows laptop or Linux container), see platformDefaults.

import os from 'node:os';
import path from 'node:path';

export interface Defaults {
  kicadCli: string;
  kicadSymbolDir: string;
  symLibTable: string;
  dataDir: string;
  projectsDir: string;
  pngFont: string;
}

/**
 * Pure so a test can check both platforms on one machine; joins with the
 * platform's own path module for the same reason.
 */
export function platformDefaults(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): Defaults {
  if (platform === 'win32') {
    const j = path.win32.join;
    const localAppData = env.LOCALAPPDATA ?? j(home, 'AppData', 'Local');
    const appData = env.APPDATA ?? j(home, 'AppData', 'Roaming');
    const kicadRoot = j(localAppData, 'Programs', 'KiCad', '9.0');
    return {
      kicadCli: j(kicadRoot, 'bin', 'kicad-cli.exe'),
      kicadSymbolDir: j(kicadRoot, 'share', 'kicad', 'symbols'),
      symLibTable: j(appData, 'kicad', '9.0', 'sym-lib-table'),
      dataDir: j(localAppData, 'UniversityTools', 'circuit'),
      projectsDir: j(home, 'Documents', 'KiCad', '9.0', 'projects'),
      pngFont: 'Consolas',
    };
  }
  const j = path.posix.join;
  const configHome = env.XDG_CONFIG_HOME ?? j(home, '.config');
  const dataHome = env.XDG_DATA_HOME ?? j(home, '.local', 'share');
  return {
    kicadCli: 'kicad-cli',
    kicadSymbolDir: '/usr/share/kicad/symbols',
    symLibTable: j(configHome, 'kicad', '9.0', 'sym-lib-table'),
    dataDir: j(dataHome, 'university-tools', 'circuit'),
    projectsDir: j(home, 'KiCad', '9.0', 'projects'),
    pngFont: 'DejaVu Sans Mono',
  };
}

const d = platformDefaults(process.platform, process.env, os.homedir());

export const PORT = Number(process.env.CIRCUIT_PORT ?? 8765);
export const HOST = process.env.CIRCUIT_HOST ?? '127.0.0.1';
export const PUBLIC_URL = process.env.CIRCUIT_PUBLIC_URL ?? `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
export const APP_NAME = 'circuit-ai-tool';
export const APP_VERSION = '0.1.0';

export const KICAD_CLI = process.env.KICAD_CLI ?? d.kicadCli;
export const KICAD_SYMBOL_DIR = process.env.KICAD_SYMBOL_DIR ?? d.kicadSymbolDir;
export const KICAD_SYM_LIB_TABLE = process.env.KICAD_SYM_LIB_TABLE ?? d.symLibTable;
export const DATA_DIR = process.env.DATA_DIR ?? d.dataDir;
export const PROJECTS_DIR = process.env.PROJECTS_DIR ?? d.projectsDir;
export const PNG_FONT = process.env.CIRCUIT_PNG_FONT ?? d.pngFont;

/** Poll the open schematic every N ms instead of relying on inotify (0 = fs.watch). Docker Desktop bind mounts of Windows folders need this. */
export const WATCH_POLL_MS = Math.max(0, Number(process.env.CIRCUIT_WATCH_POLL_MS ?? 0) || 0);
/** "hostPrefix=containerPrefix;..." rewrites paths sent by clients on the host (see projects.ts parsePathMap). */
export const PATH_MAP = process.env.CIRCUIT_PATH_MAP ?? '';
/** Container name when running under Docker; switches the connect snippets to `docker exec`. */
export const CONTAINER = process.env.CIRCUIT_CONTAINER || null;

// Both must be overridable by environment: under `bun build --compile`,
// import.meta.dir resolves inside Bun's virtual filesystem (B:\~BUN\...), so a
// packaged build would serve nothing. The desktop shell passes STATIC_DIR.
export const PROJECT_ROOT = process.env.PROJECT_ROOT ?? path.resolve(import.meta.dir, '..');
export const DIST_DIR = process.env.STATIC_DIR ?? path.join(PROJECT_ROOT, 'dist');

/** Set by the desktop shell to its own sidecar path, for the stdio MCP snippet. */
export const PACKAGED_EXE = process.env.CIRCUIT_EXE ?? null;

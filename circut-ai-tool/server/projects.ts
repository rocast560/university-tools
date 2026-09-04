// Recent-projects list under DATA_DIR, folder scanning, and the sidecar file
// that lives next to each schematic (NAME.breadboard.json).

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeSidecar, type Sidecar } from '../src/layout/types.ts';

export interface ProjectInfo {
  id: string;
  path: string;
  name: string;
  dir: string;
  lastOpened: string;
}

export const normalizePath = (p: string) => path.resolve(p).replace(/\\/g, '/');

export function projectId(absPath: string): string {
  return createHash('sha256').update(normalizePath(absPath).toLowerCase()).digest('hex').slice(0, 10);
}

export class ProjectRegistry {
  private items = new Map<string, ProjectInfo>();
  private file: string;

  constructor(private dataDir: string) {
    this.file = path.join(dataDir, 'projects.json');
  }

  async load() {
    try {
      const list = JSON.parse(await readFile(this.file, 'utf8')) as ProjectInfo[];
      for (const p of list) if (p && typeof p.path === 'string') this.items.set(p.id, p);
    } catch {
      /* first run */
    }
  }

  private async save() {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.file, JSON.stringify(this.list(), null, 2));
  }

  list(): ProjectInfo[] {
    return [...this.items.values()].sort((a, b) => b.lastOpened.localeCompare(a.lastOpened));
  }

  get(id: string): ProjectInfo | undefined {
    return this.items.get(id);
  }

  async remember(absPath: string): Promise<ProjectInfo> {
    const p = normalizePath(absPath);
    const info: ProjectInfo = { id: projectId(p), path: p, name: path.basename(p, '.kicad_sch'), dir: path.posix.dirname(p), lastOpened: new Date().toISOString() };
    this.items.set(info.id, info);
    await this.save();
    return info;
  }

  async forget(id: string) {
    this.items.delete(id);
    await this.save();
  }
}

export async function scanProjects(dir: string, depth = 2): Promise<{ path: string; name: string }[]> {
  const out: { path: string; name: string }[] = [];
  async function walk(d: string, level: number) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && level < depth && !e.name.endsWith('-backups')) await walk(full, level + 1);
      else if (e.isFile() && e.name.endsWith('.kicad_sch')) out.push({ path: normalizePath(full), name: path.basename(e.name, '.kicad_sch') });
    }
  }
  await walk(dir, 0);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Copy a schematic into the library at `dir`, as `<dir>/<stem>/<stem>.kicad_sch`.
 * The name comes from an upload, so it is reduced to a bare safe stem; a clash
 * gets a numeric suffix rather than overwriting an existing project.
 */
export async function importSchematic(dir: string, filename: string, contents: Uint8Array): Promise<string> {
  if (!filename.toLowerCase().endsWith('.kicad_sch')) throw new Error('only .kicad_sch files can be imported');
  const raw = path.basename(filename, path.extname(filename));
  const stem = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._]+/, '').slice(0, 64);
  if (!stem) throw new Error(`"${filename}" has no usable name`);
  let name = stem;
  for (let n = 2; existsSync(path.join(dir, name)); n++) name = `${stem}-${n}`;
  const target = path.join(dir, name, `${name}.kicad_sch`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
  return normalizePath(target);
}

export function sidecarPath(schPath: string): string {
  return path.join(path.dirname(schPath), `${path.basename(schPath, '.kicad_sch')}.breadboard.json`);
}

export async function readSidecar(schPath: string): Promise<Sidecar> {
  try {
    return normalizeSidecar(JSON.parse(await readFile(sidecarPath(schPath), 'utf8')));
  } catch {
    return normalizeSidecar({});
  }
}

export async function writeSidecar(schPath: string, sidecar: Sidecar): Promise<void> {
  await writeFile(sidecarPath(schPath), JSON.stringify(sidecar, null, 2));
}

// Folders for the home page. Projects live wherever they live on disk; this
// only remembers which folder each one is filed under, in one JSON file in
// the data directory, so the arrangement follows the server rather than the
// browser.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface Folder {
  id: string;
  name: string;
  /** Display order; folders are shown ascending. */
  order: number;
}

export interface Organizer {
  folders: Folder[];
  /** Project path -> folder id. A path that is not here is unfiled. */
  placements: Record<string, string>;
}

export class OrganizerError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const clean = (name: unknown): string => {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!n) throw new OrganizerError('a folder needs a name');
  if (n.length > 60) throw new OrganizerError('folder names are at most 60 characters');
  return n;
};

export class OrganizerStore {
  private data: Organizer = { folders: [], placements: {} };
  private loaded = false;

  constructor(private file: string) {}

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Organizer>;
      const folders = Array.isArray(raw.folders) ? raw.folders.filter((f) => f && typeof f.id === 'string' && typeof f.name === 'string').map((f, i) => ({ id: f.id, name: f.name, order: typeof f.order === 'number' ? f.order : i })) : [];
      const ids = new Set(folders.map((f) => f.id));
      const placements: Record<string, string> = {};
      if (raw.placements && typeof raw.placements === 'object') for (const [p, id] of Object.entries(raw.placements)) if (typeof id === 'string' && ids.has(id)) placements[p] = id;
      this.data = { folders, placements };
    } catch {
      /* no file yet, or unreadable: start empty */
    }
  }

  private async save() {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.data, null, 2));
  }

  async get(): Promise<Organizer> {
    await this.load();
    return { folders: [...this.data.folders].sort((a, b) => a.order - b.order), placements: { ...this.data.placements } };
  }

  async createFolder(name: unknown): Promise<Folder> {
    await this.load();
    const folder: Folder = { id: crypto.randomUUID().slice(0, 8), name: clean(name), order: (this.data.folders.at(-1)?.order ?? -1) + 1 };
    this.data.folders.push(folder);
    await this.save();
    return folder;
  }

  async renameFolder(id: string, name: unknown): Promise<Folder> {
    await this.load();
    const folder = this.data.folders.find((f) => f.id === id);
    if (!folder) throw new OrganizerError('no such folder', 404);
    folder.name = clean(name);
    await this.save();
    return folder;
  }

  /** Remove a folder; whatever was in it becomes unfiled. */
  async deleteFolder(id: string): Promise<void> {
    await this.load();
    if (!this.data.folders.some((f) => f.id === id)) throw new OrganizerError('no such folder', 404);
    this.data.folders = this.data.folders.filter((f) => f.id !== id);
    for (const [p, fid] of Object.entries(this.data.placements)) if (fid === id) delete this.data.placements[p];
    await this.save();
  }

  /** File a project under a folder, or unfile it with null. */
  async move(projectPath: unknown, folderId: unknown): Promise<void> {
    await this.load();
    if (typeof projectPath !== 'string' || !projectPath) throw new OrganizerError('path is required');
    if (folderId === null || folderId === undefined || folderId === '') delete this.data.placements[projectPath];
    else {
      if (typeof folderId !== 'string' || !this.data.folders.some((f) => f.id === folderId)) throw new OrganizerError('no such folder', 404);
      this.data.placements[projectPath] = folderId;
    }
    await this.save();
  }

  /** Put the folders in this order; ids not listed keep their place after the listed ones. */
  async reorder(ids: unknown): Promise<void> {
    await this.load();
    if (!Array.isArray(ids)) throw new OrganizerError('ids must be a list');
    const listed = ids.filter((x): x is string => typeof x === 'string');
    let n = 0;
    for (const id of listed) {
      const f = this.data.folders.find((x) => x.id === id);
      if (f) f.order = n++;
    }
    for (const f of [...this.data.folders].sort((a, b) => a.order - b.order)) if (!listed.includes(f.id)) f.order = n++;
    await this.save();
  }
}

// Open projects and everything that can be done to them. The only module
// that calls the pure pipeline on the server. Layout edits change the
// sidecar; schematic edits (part 4) change the .kicad_sch through this
// class as well so that mtime checks, backups and rebuilds live in one place.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseSchematic, type Schematic } from '../src/kicad/schematic.ts';
import type { Hole, Options, Sidecar } from '../src/layout/types.ts';
import { emptySidecar } from '../src/layout/types.ts';
import { parseNetlist, type Design } from '../src/netlist.ts';
import { buildLayoutDoc, type LayoutDoc } from '../src/pipeline.ts';
import { simulate, type SimResult } from '../src/sim/index.ts';
import type { KicadCli } from './kicad-cli.ts';
import { normalizePath, projectId, readSidecar, scanProjects, writeSidecar, type ProjectInfo, type ProjectRegistry } from './projects.ts';
import { watchFile, type Events } from './watch.ts';

export class ServiceError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface OpenProject {
  info: ProjectInfo;
  schematic: Schematic;
  design: Design;
  sidecar: Sidecar;
  doc: LayoutDoc;
  netlistText: string;
  mtimeMs: number;
  size: number;
}

export interface ProjectEvent {
  projectId: string;
  type: 'changed' | 'error' | 'closed';
  message?: string;
}

export interface ServiceDeps {
  kicad: KicadCli;
  registry: ProjectRegistry;
  events: Events<ProjectEvent>;
  watch: boolean;
  projectsDir: string;
}

export class Service {
  private open_ = new Map<string, OpenProject>();
  private stops = new Map<string, () => void>();

  constructor(private deps: ServiceDeps) {}

  has(id: string): boolean {
    return this.open_.has(id);
  }

  get(id: string): OpenProject {
    const p = this.open_.get(id);
    if (!p) throw new ServiceError(`project "${id}" is not open; call open_schematic with its path first`, 404);
    return p;
  }

  async list() {
    return { recent: this.deps.registry.list(), found: await scanProjects(this.deps.projectsDir, 2) };
  }

  async open(pathOrId: string): Promise<OpenProject> {
    const known = this.open_.get(pathOrId) ?? (this.deps.registry.get(pathOrId) ? this.open_.get(this.deps.registry.get(pathOrId)!.id) : undefined);
    if (known) return known;
    const remembered = this.deps.registry.get(pathOrId);
    const file = normalizePath(remembered ? remembered.path : pathOrId);
    if (!file.toLowerCase().endsWith('.kicad_sch')) throw new ServiceError(`"${pathOrId}" is not a .kicad_sch file`);
    const id = projectId(file);
    const project = await this.load(file, id);
    project.info = await this.deps.registry.remember(file);
    this.open_.set(id, project);
    if (this.deps.watch) this.startWatch(id, file);
    return project;
  }

  private async load(file: string, id: string): Promise<OpenProject> {
    let s;
    try {
      s = await stat(file);
    } catch {
      throw new ServiceError(`schematic not found: ${file}`, 404);
    }
    const text = await readFile(file, 'utf8');
    const schematic = parseSchematic(text, path.basename(file, '.kicad_sch'));
    if (schematic.sheets) throw new ServiceError(`hierarchical sheets are not supported (found ${schematic.sheets}); flatten the design first`);
    if (schematic.buses) throw new ServiceError(`buses are not supported (found ${schematic.buses} bus segments); use labels instead`);
    const netlistText = await this.deps.kicad.netlist(file);
    const design = parseNetlist(netlistText);
    const sidecar = await readSidecar(file);
    const doc = buildLayoutDoc(design, sidecar);
    const info: ProjectInfo = this.deps.registry.get(id) ?? { id, path: file, name: path.basename(file, '.kicad_sch'), dir: path.posix.dirname(file), lastOpened: new Date().toISOString() };
    return { info, schematic, design, sidecar, doc, netlistText, mtimeMs: s.mtimeMs, size: s.size };
  }

  private startWatch(id: string, file: string) {
    this.stops.get(id)?.();
    this.stops.set(
      id,
      watchFile(file, () => {
        this.refresh(id)
          .then(() => this.deps.events.emit({ projectId: id, type: 'changed' }))
          .catch((e) => this.deps.events.emit({ projectId: id, type: 'error', message: (e as Error).message }));
      }),
    );
  }

  async refresh(id: string): Promise<OpenProject> {
    const current = this.get(id);
    const fresh = await this.load(current.info.path, id);
    fresh.info = current.info;
    this.open_.set(id, fresh);
    return fresh;
  }

  close(id: string) {
    this.stops.get(id)?.();
    this.stops.delete(id);
    this.open_.delete(id);
    this.deps.events.emit({ projectId: id, type: 'closed' });
  }

  /** Rebuild the doc from the current design and sidecar, persist the sidecar. */
  private async rebuild(p: OpenProject): Promise<OpenProject> {
    p.doc = buildLayoutDoc(p.design, p.sidecar);
    await writeSidecar(p.info.path, p.sidecar);
    return p;
  }

  async saveSidecar(id: string) {
    await writeSidecar(this.get(id).info.path, this.get(id).sidecar);
  }

  async setOptions(id: string, patch: Partial<Options>): Promise<OpenProject> {
    const p = this.get(id);
    const o = p.sidecar.options;
    if (patch.board !== undefined) {
      if (!['auto', 'half', 'full'].includes(patch.board)) throw new ServiceError('board must be auto, half or full');
      o.board = patch.board;
    }
    if (patch.railSplit !== undefined) o.railSplit = patch.railSplit === null ? null : !!patch.railSplit;
    if (patch.dipSwitchPositions !== undefined) {
      if (!Number.isInteger(patch.dipSwitchPositions) || patch.dipSwitchPositions < 0 || patch.dipSwitchPositions > 16) throw new ServiceError('dipSwitchPositions must be 0 to 16');
      o.dipSwitchPositions = patch.dipSwitchPositions;
    }
    if (patch.packageOrder !== undefined) o.packageOrder = patch.packageOrder.filter((r) => p.design.components.has(r));
    if (patch.substitutions !== undefined) o.substitutions = { ...o.substitutions, ...patch.substitutions };
    return this.rebuild(p);
  }

  async movePart(id: string, ref: string, holes: Record<string, Hole>): Promise<OpenProject> {
    const p = this.get(id);
    const comp = p.design.components.get(ref);
    if (!comp) throw new ServiceError(`no component ${ref} in the schematic`, 404);
    const expected = Object.keys(p.doc.pinHoles[ref] ?? {});
    if (!expected.length) throw new ServiceError(`${ref} is not placed on the board, so it cannot be moved`);
    const missing = expected.filter((pin) => !holes[pin]);
    if (missing.length) throw new ServiceError(`move_part needs a hole for every pin of ${ref}; missing pin ${missing.join(', pin ')}`);
    const before = { ...p.sidecar.pinned };
    p.sidecar.pinned[ref] = Object.fromEntries(expected.map((pin) => [pin, { col: holes[pin].col, row: holes[pin].row }]));
    const doc = buildLayoutDoc(p.design, p.sidecar);
    const dropped = doc.warnings.find((w) => w.startsWith(`pinned placement for ${ref} dropped`));
    if (dropped) {
      p.sidecar.pinned = before;
      throw new ServiceError(dropped.replace('pinned placement for', 'cannot move'));
    }
    return this.rebuild(p);
  }

  async setColor(id: string, net: string, color: string | null): Promise<OpenProject> {
    const p = this.get(id);
    if (!p.design.nets.has(net)) throw new ServiceError(`no net ${net} in the schematic (names are exact, for example "/A" or "+5V")`, 404);
    if (color === null) delete p.sidecar.colors[net];
    else if (/^#[0-9a-fA-F]{6}$/.test(color)) p.sidecar.colors[net] = color;
    else throw new ServiceError('color must be #rrggbb');
    return this.rebuild(p);
  }

  async resetLayout(id: string): Promise<OpenProject> {
    const p = this.get(id);
    const keep = p.sidecar.placed;
    p.sidecar = { ...emptySidecar(), placed: keep };
    return this.rebuild(p);
  }

  simulate(id: string, levels: Record<string, 0 | 1>): SimResult {
    const p = this.get(id);
    for (const net of Object.keys(levels)) if (!p.design.nets.has(net)) throw new ServiceError(`no net ${net}`, 404);
    return simulate(p.doc.sim.model, levels);
  }

  schematicSvg(id: string): Promise<string> {
    return this.deps.kicad.svg(this.get(id).info.path);
  }

  erc(id: string): Promise<unknown> {
    return this.deps.kicad.erc(this.get(id).info.path);
  }
}

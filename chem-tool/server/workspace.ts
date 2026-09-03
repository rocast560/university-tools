// The workspace store: the single mutation path for the live molecule state.

import { EditError, applyEdits } from '../src/chem/edit';
import { ResolveError, type Alternative, type ResolveResult, type Resolver } from '../src/chem/resolve';
import { buildSpecies, newId, speciesFromMolecule } from '../src/chem/species';
import { parseMolfile, parseSmiles } from '../src/chem/structure';
import { DEFAULT_VIEW, type Scene, type SceneSnapshot, type Species, type ViewState, type Workspace } from '../src/chem/types';
import type { Command, ViewPatch } from './schemas';

export type Actor = `window:${string}` | 'mcp' | 'api' | 'system';

export class CommandError extends Error {
  constructor(public readonly status: 400 | 404 | 409 | 422, message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface CommandResult { message: string; sceneId: string; speciesId?: string; alternatives?: Alternative[] }
export type Listener = (workspace: Workspace, actor: Actor) => void;

export const HISTORY_LIMIT = 50;

export function newScene(title: string, species: Species): Scene {
  return {
    id: newId(), title, kind: 'molecule', species: [species], focusId: species.id,
    view: { ...DEFAULT_VIEW, highlight: [], camera: { ...DEFAULT_VIEW.camera } },
    history: { past: [], future: [] },
  };
}

export function createInitialWorkspace(): Workspace {
  const water = buildSpecies({ name: 'Water', smiles: 'O', source: 'library', displayFormula: 'H2O', category: 'Gases and diatomics' });
  const scene = newScene('Water', water);
  return { version: 1, scenes: [scene], activeSceneId: scene.id };
}

export function snapshotOf(scene: Scene): SceneSnapshot {
  return { kind: scene.kind, species: [...scene.species], equation: scene.equation, focusId: scene.focusId };
}

export function pushHistory(scene: Scene): void {
  scene.history.past.push(snapshotOf(scene));
  if (scene.history.past.length > HISTORY_LIMIT) scene.history.past.shift();
  scene.history.future = [];
}

export function mergeView(view: ViewState, patch: ViewPatch): ViewState {
  return { ...view, ...patch, highlight: patch.highlight ?? view.highlight, camera: patch.camera ? { ...patch.camera } : view.camera };
}

export function describe(s: Species): string {
  return `${s.name} (${s.displayFormula})`;
}

export class WorkspaceStore {
  private readonly listeners = new Set<Listener>();

  constructor(private ws: Workspace, private readonly resolver: Resolver, private readonly onChange?: (ws: Workspace) => void) {}

  get(): Workspace { return this.ws; }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  activeScene(): Scene { return this.scene(this.ws.activeSceneId); }

  scene(id?: string): Scene {
    const target = id ?? this.ws.activeSceneId;
    const s = this.ws.scenes.find((x) => x.id === target);
    if (!s) throw new CommandError(404, `No scene ${target}`);
    return s;
  }

  focused(sceneId?: string): Species {
    const s = this.scene(sceneId);
    return s.species.find((x) => x.id === s.focusId) ?? s.species[0];
  }

  findSpecies(id?: string): { scene: Scene; species: Species } {
    if (!id) { const scene = this.activeScene(); return { scene, species: this.focused() }; }
    for (const scene of this.ws.scenes) {
      const species = scene.species.find((x) => x.id === id);
      if (species) return { scene, species };
    }
    throw new CommandError(404, `No species ${id}`);
  }

  async dispatch(command: Command, actor: Actor): Promise<CommandResult> {
    const result = await this.apply(command);
    this.ws = { ...this.ws, version: this.ws.version + 1 };
    this.onChange?.(this.ws);
    for (const fn of this.listeners) {
      try { fn(this.ws, actor); } catch (err) { console.error('workspace listener failed:', err); }
    }
    return result;
  }

  protected checkVersion(base?: number): void {
    if (base !== undefined && base !== this.ws.version) {
      throw new CommandError(409, `Workspace changed (you had version ${base}, it is now ${this.ws.version})`, { version: this.ws.version });
    }
  }

  protected replaceFocused(scene: Scene, species: Species): void {
    pushHistory(scene);
    scene.species = scene.kind === 'molecule' ? [species] : scene.species.map((s) => (s.id === scene.focusId ? species : s));
    scene.focusId = species.id;
    scene.view = { ...scene.view, highlight: [] };
    if (scene.kind === 'molecule') scene.title = species.name;
  }

  protected async resolveOr404(query: string): Promise<ResolveResult> {
    try {
      return await this.resolver.resolve(query);
    } catch (err) {
      if (err instanceof ResolveError) throw new CommandError(404, err.message, { suggestions: err.suggestions, reason: err.reason });
      throw err;
    }
  }

  protected async apply(cmd: Command): Promise<CommandResult> {
    switch (cmd.type) {
      case 'load': {
        const r = await this.resolveOr404(cmd.query);
        if (cmd.newScene || this.ws.scenes.length === 0) {
          const scene = newScene(r.species.name, r.species);
          this.ws.scenes.push(scene);
          this.ws.activeSceneId = scene.id;
          return { message: `Loaded ${describe(r.species)} into a new scene`, sceneId: scene.id, speciesId: r.species.id, alternatives: r.alternatives };
        }
        const scene = this.scene(cmd.sceneId);
        this.replaceFocused(scene, r.species);
        return { message: `Loaded ${describe(r.species)} from ${r.species.source}${r.note ? '. ' + r.note : ''}`, sceneId: scene.id, speciesId: r.species.id, alternatives: r.alternatives };
      }
      case 'set_structure': {
        this.checkVersion(cmd.baseVersion);
        const scene = this.activeScene();
        const current = this.focused();
        const mol = cmd.molfile ? parseMolfile(cmd.molfile) : cmd.smiles ? parseSmiles(cmd.smiles) : null;
        if (!mol) throw new CommandError(422, 'set_structure needs a valid SMILES or molfile');
        const name = cmd.name ?? (current.name.endsWith('(edited)') ? current.name : `${current.name} (edited)`);
        const species = speciesFromMolecule(mol, { name, source: 'edit', category: current.category });
        this.replaceFocused(scene, species);
        return { message: `Structure replaced: ${describe(species)}`, sceneId: scene.id, speciesId: species.id };
      }
      case 'set_view': {
        const scene = this.scene(cmd.sceneId);
        scene.view = mergeView(scene.view, cmd.view);
        return { message: 'View updated', sceneId: scene.id };
      }
      case 'focus': {
        const { scene, species } = this.findSpecies(cmd.speciesId);
        scene.focusId = species.id;
        this.ws.activeSceneId = scene.id;
        return { message: `Focused ${describe(species)}`, sceneId: scene.id, speciesId: species.id };
      }
      case 'new_scene': {
        const species = cmd.query ? (await this.resolveOr404(cmd.query)).species : this.focused();
        const scene = newScene(cmd.title ?? species.name, species);
        this.ws.scenes.push(scene);
        this.ws.activeSceneId = scene.id;
        return { message: `New scene "${scene.title}"`, sceneId: scene.id, speciesId: species.id };
      }
      case 'close_scene': {
        if (this.ws.scenes.length === 1) throw new CommandError(400, 'Cannot close the last scene');
        const idx = this.ws.scenes.findIndex((s) => s.id === cmd.sceneId);
        if (idx < 0) throw new CommandError(404, `No scene ${cmd.sceneId}`);
        this.ws.scenes.splice(idx, 1);
        if (this.ws.activeSceneId === cmd.sceneId) this.ws.activeSceneId = this.ws.scenes[Math.max(0, idx - 1)].id;
        return { message: 'Scene closed', sceneId: this.ws.activeSceneId };
      }
      case 'switch_scene': {
        const scene = this.scene(cmd.sceneId);
        this.ws.activeSceneId = scene.id;
        return { message: `Switched to "${scene.title}"`, sceneId: scene.id };
      }
      case 'rename_scene': {
        const scene = this.scene(cmd.sceneId);
        scene.title = cmd.title;
        return { message: 'Scene renamed', sceneId: scene.id };
      }
      case 'edit': {
        this.checkVersion(cmd.baseVersion);
        const scene = this.activeScene();
        const current = this.focused();
        const mol = parseMolfile(current.molfile3d);
        if (!mol) throw new CommandError(422, 'The current structure cannot be parsed');
        let edited;
        try {
          edited = applyEdits(mol, cmd.ops);
        } catch (err) {
          if (err instanceof EditError) throw new CommandError(422, err.message, { atoms: current.atoms.map((a) => `${a.index}:${a.element}`).join(' ') });
          throw err;
        }
        const name = cmd.name ?? (current.name.endsWith('(edited)') ? current.name : `${current.name} (edited)`);
        const species = speciesFromMolecule(edited, { name, source: 'edit', category: current.category });
        this.replaceFocused(scene, species);
        return { message: `Applied ${cmd.ops.length} edit${cmd.ops.length === 1 ? '' : 's'}: now ${describe(species)}`, sceneId: scene.id, speciesId: species.id };
      }
      case 'undo':
      case 'redo': {
        const scene = this.activeScene();
        const from = cmd.type === 'undo' ? scene.history.past : scene.history.future;
        const to = cmd.type === 'undo' ? scene.history.future : scene.history.past;
        const target = from.pop();
        if (!target) throw new CommandError(400, cmd.type === 'undo' ? 'Nothing to undo' : 'Nothing to redo');
        to.push(snapshotOf(scene));
        scene.kind = target.kind;
        scene.species = target.species;
        scene.equation = target.equation;
        scene.focusId = target.focusId;
        scene.view = { ...scene.view, highlight: [] };
        const species = this.focused(scene.id);
        return { message: `${cmd.type === 'undo' ? 'Undid' : 'Redid'}: now ${describe(species)}`, sceneId: scene.id, speciesId: species.id };
      }
    }
  }
}

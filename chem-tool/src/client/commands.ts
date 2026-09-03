import type { EditOpInput, ViewPatch } from '../../server/schemas';
import { useStore } from './store';
import { CommandFailed, sendCommand } from './ws';

function report(err: unknown): never {
  const e = err as CommandFailed;
  const suggestions = Array.isArray(e.details?.suggestions) ? ` Did you mean: ${(e.details.suggestions as string[]).join(', ')}?` : '';
  useStore.getState().showToast(`${e.message}${suggestions}`);
  throw err;
}

export async function load(query: string, newScene = false) {
  try {
    const r = await sendCommand({ type: 'load', query, newScene });
    useStore.getState().setAlternatives(r.speciesId ?? null, r.alternatives ?? []);
    return r;
  } catch (err) { report(err); }
}
export const setView = (view: ViewPatch) => sendCommand({ type: 'set_view', view }).catch(report);
export const focus = (speciesId: string) => sendCommand({ type: 'focus', speciesId }).catch(report);
export const newScene = (title?: string, query?: string) => sendCommand({ type: 'new_scene', title, query }).catch(report);
export const switchScene = (sceneId: string) => sendCommand({ type: 'switch_scene', sceneId }).catch(report);
export const closeScene = (sceneId: string) => sendCommand({ type: 'close_scene', sceneId }).catch(report);
export const renameScene = (sceneId: string, title: string) => sendCommand({ type: 'rename_scene', sceneId, title }).catch(report);
export const setStructure = (molfile: string, baseVersion: number) => sendCommand({ type: 'set_structure', molfile, baseVersion });
export const undo = () => sendCommand({ type: 'undo' }).catch(report);
export const redo = () => sendCommand({ type: 'redo' }).catch(report);
export const edit = (ops: EditOpInput[], baseVersion?: number) => sendCommand({ type: 'edit', ops, baseVersion });

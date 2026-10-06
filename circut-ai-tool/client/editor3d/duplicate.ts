// Duplicate a part: add another of the same kind and value, then slide it to
// the nearest free spot on its right. The new part joins no net; wiring it is
// the user's next step. A schematic edit, so it is not on the undo stack.

import { validatePlacement } from '../../src/edit/placement.ts';
import { PART_ALIASES } from '../../src/parts/aliases.ts';
import { P } from '../../src/render/index.ts';
import { api } from '../api.ts';
import { shiftHoles } from '../drag.ts';
import { loadProject, toast } from '../main.ts';
import { store } from '../state.ts';
import { addKeyHandler, type Workspace } from './workspace.ts';

/** How many columns to the right the copy may land. */
const REACH = 20;

let working = false;

/** Add a copy of `ref`; resolves with the new ref, or null when it could not be made. */
export async function duplicatePart(ref: string): Promise<string | null> {
  const p = store.get().project;
  const comp = p?.design.components.get(ref);
  if (!p || !comp) return null;
  if (working) return null;
  const alias = PART_ALIASES.find((a) => a.libId === `${comp.lib}:${comp.part}`);
  if (!alias) {
    toast(`can't duplicate ${ref}: no tray part for ${comp.lib}:${comp.part}`);
    return null;
  }
  working = true;
  try {
    const added = await api.editAdd(p.id, { part: alias.alias, value: comp.value, connections: {}, spare: false });
    const orig = p.doc.pinHoles[ref];
    let spot: ReturnType<typeof shiftHoles> = null;
    if (orig) {
      for (let k = 1; k <= REACH && !spot; k++) {
        const shifted = shiftHoles(orig, k * P, 0, p.doc.board, true);
        if (shifted && validatePlacement(p.doc, p.design, 'NEW?', shifted, () => '').ok) spot = shifted;
      }
    }
    if (spot) {
      try {
        await api.move(p.id, added.ref, spot);
      } catch (e) {
        toast(`${added.ref} added, but not beside ${ref}: ${(e as Error).message}`);
      }
    }
    if (!spot) toast('placed automatically');
    await loadProject(p.id);
    if (store.get().project?.id === p.id) store.setProject({ selectedRef: added.ref });
    return added.ref;
  } catch (e) {
    toast(`Not duplicated: ${(e as Error).message}`);
    return null;
  } finally {
    working = false;
  }
}

export function attachDuplicate(_ws: Workspace): () => void {
  return addKeyHandler((e) => {
    if (e.key !== 'd' && e.key !== 'D') return false;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
    const ref = store.get().project?.selectedRef;
    if (!ref) return false;
    if (e.repeat) return true;
    void duplicatePart(ref);
    return true;
  });
}

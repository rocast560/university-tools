import { describe, expect, test } from 'vitest';
import { createResolver } from '../src/chem/resolve';
import { CommandError, HISTORY_LIMIT, WorkspaceStore, createInitialWorkspace } from './workspace';

const make = () => new WorkspaceStore(createInitialWorkspace(), createResolver({ pubchem: null }));

describe('edit, undo, redo', () => {
  test('edit replaces the focused species and records history', async () => {
    const store = make();
    await store.dispatch({ type: 'load', query: 'ethanol' }, 'api');
    const r = await store.dispatch({ type: 'edit', ops: [{ op: 'replace_group', index: 3, group: 'NH2' }], baseVersion: 2 }, 'mcp');
    expect(r.message).toMatch(/1 edit/);
    expect(store.focused().formula).toBe('C2H7N');
    expect(store.focused().name).toBe('Ethanol (edited)');
    expect(store.focused().source).toBe('edit');
    expect(store.activeScene().history.past).toHaveLength(2);
  });
  test('invalid edits are 422 with the atom list; stale versions are 409', async () => {
    const store = make();
    const bad = await store.dispatch({ type: 'edit', ops: [{ op: 'add_atom', element: 'Cl', bondTo: 42 }] }, 'mcp').catch((e) => e);
    expect(bad).toBeInstanceOf(CommandError);
    expect(bad.status).toBe(422);
    expect(bad.details.atoms).toBe('1:O 2:H 3:H');
    const stale = await store.dispatch({ type: 'edit', ops: [{ op: 'set_element', index: 1, element: 'S' }], baseVersion: 99 }, 'mcp').catch((e) => e);
    expect(stale.status).toBe(409);
    expect(store.get().version).toBe(1);
  });
  test('undo and redo walk the history and clear highlights', async () => {
    const store = make();
    await store.dispatch({ type: 'load', query: 'methane' }, 'api');
    await store.dispatch({ type: 'edit', ops: [{ op: 'add_atom', element: 'Cl', bondTo: 1 }] }, 'mcp');
    await store.dispatch({ type: 'set_view', view: { highlight: [2] } }, 'mcp');
    expect(store.focused().formula).toBe('CH3Cl');
    await store.dispatch({ type: 'undo' }, 'mcp');
    expect(store.focused().formula).toBe('CH4');
    expect(store.activeScene().view.highlight).toEqual([]);
    await store.dispatch({ type: 'undo' }, 'mcp');
    expect(store.focused().name).toBe('Water');
    const empty = await store.dispatch({ type: 'undo' }, 'mcp').catch((e) => e);
    expect(empty.status).toBe(400);
    await store.dispatch({ type: 'redo' }, 'mcp');
    await store.dispatch({ type: 'redo' }, 'mcp');
    expect(store.focused().formula).toBe('CH3Cl');
    expect((await store.dispatch({ type: 'redo' }, 'mcp').catch((e) => e)).status).toBe(400);
  });
  test('a new structural change after undo discards the redo branch; history is capped', async () => {
    const store = make();
    await store.dispatch({ type: 'load', query: 'methane' }, 'api');
    await store.dispatch({ type: 'undo' }, 'mcp');
    expect(store.activeScene().history.future).toHaveLength(1);
    await store.dispatch({ type: 'load', query: 'ethane' }, 'api');
    expect(store.activeScene().history.future).toHaveLength(0);
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) await store.dispatch({ type: 'set_structure', smiles: i % 2 ? 'C' : 'CC' }, 'api');
    expect(store.activeScene().history.past).toHaveLength(HISTORY_LIMIT);
  });
});

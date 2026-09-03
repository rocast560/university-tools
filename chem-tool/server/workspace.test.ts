import { describe, expect, test, vi } from 'vitest';
import { createResolver } from '../src/chem/resolve';
import { CommandError, WorkspaceStore, createInitialWorkspace, mergeView } from './workspace';
import { DEFAULT_VIEW } from '../src/chem/types';

function makeStore() {
  const events: string[] = [];
  const store = new WorkspaceStore(createInitialWorkspace(), createResolver({ pubchem: null }), (ws) => events.push(`saved:${ws.version}`));
  return { store, events };
}

describe('WorkspaceStore', () => {
  test('starts with water in one scene', () => {
    const { store } = makeStore();
    expect(store.get().version).toBe(1);
    expect(store.get().scenes).toHaveLength(1);
    expect(store.focused().name).toBe('Water');
  });
  test('load replaces the focused species, bumps version, notifies listeners and saver', async () => {
    const { store, events } = makeStore();
    const seen: string[] = [];
    store.subscribe((ws, actor) => seen.push(`${actor}:${ws.version}`));
    const result = await store.dispatch({ type: 'load', query: 'ethanol' }, 'mcp');
    expect(result.speciesId).toBe(store.focused().id);
    expect(result.message).toMatch(/Ethanol/);
    expect(store.focused().name).toBe('Ethanol');
    expect(store.activeScene().title).toBe('Ethanol');
    expect(store.get().version).toBe(2);
    expect(seen).toEqual(['mcp:2']);
    expect(events).toEqual(['saved:2']);
    expect(store.activeScene().history.past).toHaveLength(1);
  });
  test('load with isomers reports alternatives; unknown query is a 404 with suggestions', async () => {
    const { store } = makeStore();
    const r = await store.dispatch({ type: 'load', query: 'C2H6O' }, 'api');
    expect(r.alternatives?.map((a) => a.name)).toEqual(['Dimethyl ether']);
    const err = await store.dispatch({ type: 'load', query: 'watre' }, 'api').catch((e) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect(err.status).toBe(404);
    expect(err.details.suggestions).toContain('Water');
    expect(store.get().version).toBe(2);
  });
  test('load into a new scene', async () => {
    const { store } = makeStore();
    const r = await store.dispatch({ type: 'load', query: 'methane', newScene: true }, 'api');
    expect(store.get().scenes).toHaveLength(2);
    expect(store.get().activeSceneId).toBe(r.sceneId);
    expect(store.focused().name).toBe('Methane');
  });
  test('set_structure from SMILES, version conflicts, invalid input', async () => {
    const { store } = makeStore();
    await store.dispatch({ type: 'set_structure', smiles: 'CCO', baseVersion: 1 }, 'window:a');
    expect(store.focused().formula).toBe('C2H6O');
    expect(store.focused().source).toBe('edit');
    expect(store.focused().name).toBe('Water (edited)');
    const stale = await store.dispatch({ type: 'set_structure', smiles: 'C', baseVersion: 1 }, 'window:a').catch((e) => e);
    expect(stale.status).toBe(409);
    expect(stale.details.version).toBe(2);
    const bad = await store.dispatch({ type: 'set_structure', smiles: 'C(' }, 'window:a').catch((e) => e);
    expect(bad.status).toBe(422);
    expect(store.get().version).toBe(2);
  });
  test('set_view merges and is not history', async () => {
    const { store } = makeStore();
    await store.dispatch({ type: 'set_view', view: { style: 'spacefill', highlight: [1] } }, 'mcp');
    expect(store.activeScene().view).toMatchObject({ style: 'spacefill', highlight: [1], labels: 'none' });
    expect(store.activeScene().history.past).toHaveLength(0);
  });
  test('scene management', async () => {
    const { store } = makeStore();
    const first = store.activeScene().id;
    const r = await store.dispatch({ type: 'new_scene', title: 'Copy' }, 'api');
    expect(store.get().scenes.map((s) => s.title)).toEqual(['Water', 'Copy']);
    await store.dispatch({ type: 'rename_scene', sceneId: r.sceneId, title: 'Second' }, 'api');
    await store.dispatch({ type: 'switch_scene', sceneId: first }, 'api');
    expect(store.get().activeSceneId).toBe(first);
    await store.dispatch({ type: 'close_scene', sceneId: r.sceneId }, 'api');
    expect(store.get().scenes).toHaveLength(1);
    const last = await store.dispatch({ type: 'close_scene', sceneId: first }, 'api').catch((e) => e);
    expect(last.status).toBe(400);
  });
  test('focus by species id across scenes', async () => {
    const { store } = makeStore();
    const waterId = store.focused().id;
    await store.dispatch({ type: 'load', query: 'ammonia', newScene: true }, 'api');
    await store.dispatch({ type: 'focus', speciesId: waterId }, 'api');
    expect(store.focused().name).toBe('Water');
    const missing = await store.dispatch({ type: 'focus', speciesId: 'nope' }, 'api').catch((e) => e);
    expect(missing.status).toBe(404);
  });
  test('a throwing listener does not stop other listeners or fail the command', async () => {
    const { store } = makeStore();
    const seen: number[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.subscribe(() => { throw new Error('bad listener'); });
    store.subscribe((ws) => seen.push(ws.version));
    await expect(store.dispatch({ type: 'set_view', view: { spin: true } }, 'api')).resolves.toBeTruthy();
    expect(seen).toEqual([2]);
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });
});

test('mergeView keeps unspecified fields', () => {
  const v = mergeView(DEFAULT_VIEW, { spin: true, camera: { preset: 'top', rotation: [0, 90, 0] } });
  expect(v).toMatchObject({ spin: true, style: 'ballstick', camera: { preset: 'top', rotation: [0, 90, 0] } });
});

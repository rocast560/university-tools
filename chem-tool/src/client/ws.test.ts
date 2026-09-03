import { expect, test } from 'vitest';
import { createInitialWorkspace } from '../../server/workspace';
import { useStore } from './store';
import { extraHandlers, handleMessage } from './ws';

test('handleMessage applies state, surfaces errors, forwards unknown messages', () => {
  const ws = createInitialWorkspace();
  handleMessage({ type: 'state', workspace: ws, actor: 'mcp', version: 1 });
  expect(useStore.getState().workspace?.version).toBe(1);
  expect(useStore.getState().lastActor).toBe('mcp');
  handleMessage({ type: 'error', message: 'boom' });
  expect(useStore.getState().toast).toBe('boom');
  const seen: unknown[] = [];
  extraHandlers.push((m) => seen.push(m));
  handleMessage({ type: 'snapshot_request', id: 'x' });
  expect(seen).toEqual([{ type: 'snapshot_request', id: 'x' }]);
});

test('alternatives are scoped to the species they were resolved for', () => {
  useStore.getState().setAlternatives('abc123', [{ name: 'Dimethyl ether', formula: 'C2H6O', smiles: 'COC' }]);
  expect(useStore.getState().alternatives).toEqual({ speciesId: 'abc123', items: [{ name: 'Dimethyl ether', formula: 'C2H6O', smiles: 'COC' }] });
  useStore.getState().setAlternatives(null, []);
  expect(useStore.getState().alternatives.items).toEqual([]);
});

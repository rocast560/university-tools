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

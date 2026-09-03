import { expect, test } from 'vitest';
import { createInitialWorkspace } from '../../server/workspace';
import { activeScene, focusedSpecies } from './selectors';

test('selectors find the active scene and focused species, and tolerate null', () => {
  const ws = createInitialWorkspace();
  const scene = activeScene(ws);
  expect(scene?.id).toBe(ws.activeSceneId);
  expect(focusedSpecies(scene)?.name).toBe('Water');
  expect(activeScene(null)).toBeNull();
  expect(focusedSpecies(null)).toBeNull();
  expect(activeScene({ ...ws, activeSceneId: 'missing' })?.id).toBe(ws.scenes[0].id);
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createSaver, loadWorkspace } from './persist';
import { createInitialWorkspace } from './workspace';

test('save then load round trips; missing or corrupt files load as null', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'chemws-'));
  const file = path.join(dir, 'nested', 'workspace.json');
  try {
    expect(await loadWorkspace(file)).toBeNull();
    const saver = createSaver(file, 0);
    const ws = createInitialWorkspace();
    saver.save({ ...ws, version: 5 });
    saver.save({ ...ws, version: 6 });
    await saver.flush();
    const back = await loadWorkspace(file);
    expect(back?.version).toBe(6);
    expect(back?.scenes[0].species[0].name).toBe('Water');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

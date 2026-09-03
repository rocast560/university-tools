import type { Scene, Species, Workspace } from '../chem/types';

export function activeScene(ws: Workspace | null): Scene | null {
  if (!ws) return null;
  return ws.scenes.find((s) => s.id === ws.activeSceneId) ?? ws.scenes[0] ?? null;
}

export function focusedSpecies(scene: Scene | null): Species | null {
  if (!scene) return null;
  return scene.species.find((s) => s.id === scene.focusId) ?? scene.species[0] ?? null;
}

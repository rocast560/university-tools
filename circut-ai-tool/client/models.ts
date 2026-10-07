// Loads the KiCad part bodies (GLB, meshopt-compressed) listed in
// public/models/manifest.json, once, so the board build can clone them.

import type * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { validateManifest, type ModelInfo, type ModelKey } from '../src/models/manifest.ts';

export interface ModelSet {
  readonly keys: ModelKey[];
  /** A fresh clone of the body (geometry shared), or null when the key is missing. */
  body(key: ModelKey): { object: THREE.Object3D; info: ModelInfo } | null;
}

const EMPTY: ModelSet = { keys: [], body: () => null };

/** Never rejects for a bad model: it warns once per failed key and leaves that key out. */
export async function loadModels(base = '/models/', signal?: AbortSignal, drop: ModelKey[] = []): Promise<ModelSet> {
  let manifest;
  try {
    const res = await fetch(`${base}manifest.json`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = validateManifest(await res.json());
  } catch (e) {
    if (!signal?.aborted) console.warn(`3D models: manifest unavailable (${e instanceof Error ? e.message : String(e)})`);
    return EMPTY;
  }
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const loaded = new Map<ModelKey, { scene: THREE.Object3D; info: ModelInfo }>();
  await Promise.all((Object.entries(manifest.models) as [ModelKey, ModelInfo][]).map(async ([key, info]) => {
    try {
      if (drop.includes(key)) throw new Error('dropped');
      const res = await fetch(`${base}${info.file}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const gltf = await loader.parseAsync(await res.arrayBuffer(), base);
      loaded.set(key, { scene: gltf.scene, info });
    } catch (e) {
      if (!signal?.aborted) console.warn(`3D models: ${key} not loaded (${e instanceof Error ? e.message : String(e)})`);
    }
  }));
  if (signal?.aborted) return EMPTY;
  return {
    keys: [...loaded.keys()],
    body(key) {
      const m = loaded.get(key);
      return m ? { object: m.scene.clone(true), info: m.info } : null;
    },
  };
}

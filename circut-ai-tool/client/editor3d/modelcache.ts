// The kit models are fetched once per page; reopening the editor reuses them.
import type { ModelSet } from '../models.ts';

const NONE: ModelSet = { keys: [], body: () => null };

/**
 * One shared load of the part models. It never rejects: a load that fails
 * (the models chunk gone after a redeploy) is no models, warned about once,
 * and like a load that got nothing it is not kept, so the next call tries again.
 * `clear` drops whatever is kept.
 */
export function cachedModels(load: () => Promise<ModelSet>): (() => Promise<ModelSet>) & { clear(): void } {
  let cache: Promise<ModelSet> | null = null;
  let warned = false;
  const get = () => {
    if (!cache) {
      const pending = load().catch((e: unknown) => {
        if (!warned) console.warn(`3D models: not loaded, showing simple shapes (${e instanceof Error ? e.message : String(e)})`);
        warned = true;
        return NONE;
      });
      cache = pending;
      // Not tied to one open's signal (a later open may share it); a load that got nothing must not stick.
      void pending.then((set) => {
        if (!set.keys.length && cache === pending) cache = null;
      });
    }
    return cache;
  };
  return Object.assign(get, { clear: () => void (cache = null) });
}

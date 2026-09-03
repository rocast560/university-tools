import type { ServerEvent } from '../src/types';

export type Listener = (event: ServerEvent) => void;
export interface EventBus {
  emit(event: ServerEvent): void;
  subscribe(listener: Listener): () => void;
  readonly size: number;
}

export function createEventBus(): EventBus {
  const listeners = new Set<Listener>();
  return {
    emit(event) {
      for (const l of [...listeners]) {
        try { l(event); } catch (err) { listeners.delete(l); console.error('[events] listener dropped', err); }
      }
    },
    subscribe(l) { listeners.add(l); return () => { listeners.delete(l); }; },
    get size() { return listeners.size; },
  };
}

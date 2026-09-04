// One store, one render. Every change goes through store.set(), which
// notifies subscribers; main.ts re-renders the current route from the state.

import type { Sidecar } from '../src/layout/types.ts';
import type { Design } from '../src/netlist.ts';
import type { LayoutDoc } from '../src/pipeline.ts';
import type { Highlight } from '../src/render/index.ts';

export type Route = { name: 'home' } | { name: 'project'; id: string } | { name: 'connect' };

export interface ProjectState {
  id: string;
  name: string;
  path: string;
  design: Design;
  sidecar: Sidecar;
  doc: LayoutDoc;
  switches: Record<string, boolean>;
  highlight: Highlight | null;
  activeStep: number | null;
  done: Set<number>;
  panel: 'guide' | 'parts' | 'pinouts' | 'checks' | 'truth' | 'options';
}

export interface AppState {
  route: Route;
  theme: 'light' | 'dark';
  project: ProjectState | null;
  loading: boolean;
  toast: string | null;
}

function initialTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* storage blocked */
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

let state: AppState = { route: { name: 'home' }, theme: initialTheme(), project: null, loading: false, toast: null };
const subs = new Set<(s: AppState) => void>();

export const store = {
  get: () => state,
  set(patch: Partial<AppState>) {
    state = { ...state, ...patch };
    for (const fn of subs) fn(state);
  },
  setProject(patch: Partial<ProjectState>) {
    if (!state.project) return;
    store.set({ project: { ...state.project, ...patch } });
  },
  subscribe(fn: (s: AppState) => void) {
    subs.add(fn);
    return () => subs.delete(fn);
  },
};

export function parseRoute(hash: string): Route {
  const m = /^#\/p\/([0-9a-f]{10})/.exec(hash);
  if (m) return { name: 'project', id: m[1] };
  if (hash.startsWith('#/connect')) return { name: 'connect' };
  return { name: 'home' };
}

export function doneKey(id: string) {
  return `guide:${id}`;
}

export function loadDone(id: string): Set<number> {
  try {
    return new Set(JSON.parse(localStorage.getItem(doneKey(id)) ?? '[]') as number[]);
  } catch {
    return new Set();
  }
}

export function saveDone(id: string, done: Set<number>) {
  try {
    localStorage.setItem(doneKey(id), JSON.stringify([...done]));
  } catch {
    /* storage blocked */
  }
}

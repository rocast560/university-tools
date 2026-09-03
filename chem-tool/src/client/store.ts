import { create } from 'zustand';
import type { Alternative } from '../chem/resolve';
import type { Workspace } from '../chem/types';

export type Panel = 'structure' | 'sketch' | 'info';
export type Connection = 'connecting' | 'open' | 'closed';

export interface ClientState {
  workspace: Workspace | null;
  connection: Connection;
  panel: Panel;
  toast: string | null;
  lastActor: string | null;
  alternatives: Alternative[];
  setWorkspace(ws: Workspace, actor: string): void;
  setConnection(c: Connection): void;
  setPanel(p: Panel): void;
  showToast(t: string | null): void;
  setAlternatives(a: Alternative[]): void;
}

export const useStore = create<ClientState>((set) => ({
  workspace: null,
  connection: 'connecting',
  panel: 'structure',
  toast: null,
  lastActor: null,
  alternatives: [],
  setWorkspace: (workspace, actor) => set({ workspace, lastActor: actor }),
  setConnection: (connection) => set({ connection }),
  setPanel: (panel) => set({ panel }),
  showToast: (toast) => set({ toast }),
  setAlternatives: (alternatives) => set({ alternatives }),
}));

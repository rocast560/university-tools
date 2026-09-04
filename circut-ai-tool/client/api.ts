// Thin fetch wrappers over /api. Errors carry the server's message.

import type { Hole, Options, Sidecar } from '../src/layout/types.ts';
import type { LayoutDoc } from '../src/pipeline.ts';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not json */
    }
    throw new ApiError(msg, res.status);
  }
  return (await res.json()) as T;
}

const post = <T,>(url: string, body: unknown) => call<T>(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  errors: number;
  warnings: number;
  summary: string;
}

export interface ProjectLists {
  recent: { id: string; name: string; path: string; lastOpened: string }[];
  found: { path: string; name: string }[];
}

export interface ConnectInfo {
  appUrl: string;
  mcpUrl: string;
  mcpAliasUrl: string;
  openapiUrl: string;
  stdioCommand: string;
  tools: string[];
  snippets: { id: string; title: string; how: string; language: string; code: string }[];
}

export const api = {
  list: () => call<ProjectLists>('/api/projects'),
  open: (path: string) => post<ProjectSummary>('/api/projects/open', { path }),
  summary: (id: string) => call<ProjectSummary>(`/api/projects/${id}`),
  layout: (id: string) => call<LayoutDoc>(`/api/projects/${id}/layout`),
  netlist: async (id: string) => {
    const res = await fetch(`/api/projects/${id}/netlist`);
    if (!res.ok) throw new ApiError('netlist unavailable', res.status);
    return res.text();
  },
  sidecar: (id: string) => call<Sidecar>(`/api/projects/${id}/sidecar`),
  move: (id: string, ref: string, holes: Record<string, Hole>) => post<LayoutDoc>(`/api/projects/${id}/layout/move`, { ref, holes }),
  options: (id: string, patch: Partial<Options>) => post<LayoutDoc>(`/api/projects/${id}/layout/options`, patch),
  color: (id: string, net: string, color: string | null) => post<LayoutDoc>(`/api/projects/${id}/layout/colors`, { net, color }),
  reset: (id: string) => post<LayoutDoc>(`/api/projects/${id}/layout/reset`, {}),
  connect: () => call<ConnectInfo>('/api/connect'),
  events(onEvent: (ev: { projectId: string; type: string; message?: string }) => void): () => void {
    const es = new EventSource('/api/events');
    const handler = (e: MessageEvent) => {
      try {
        onEvent(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    };
    es.addEventListener('changed', handler);
    es.addEventListener('error', handler as EventListener);
    return () => es.close();
  },
};

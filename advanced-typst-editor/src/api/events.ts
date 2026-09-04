import type { ServerEvent } from '@/types';

/** Subscribe to the server's SSE stream; reconnects with backoff. Returns a disposer. */
export function connectEvents(onEvent: (ev: ServerEvent) => void, onStatus?: (online: boolean) => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let delay = 1000;
  const types: ServerEvent['type'][] = ['workspace.changed', 'workspaces.changed', 'backup.state', 'mcp.clients'];
  const open = () => {
    if (closed) return;
    es = new EventSource('/api/events');
    es.addEventListener('hello', () => { delay = 1000; onStatus?.(true); });
    for (const t of types) es.addEventListener(t, (e) => { try { onEvent(JSON.parse((e as MessageEvent).data) as ServerEvent); } catch { /* ignore */ } });
    es.onerror = () => { es?.close(); es = null; onStatus?.(false); if (!closed) { setTimeout(open, delay); delay = Math.min(delay * 2, 15000); } };
  };
  open();
  return () => { closed = true; es?.close(); };
}

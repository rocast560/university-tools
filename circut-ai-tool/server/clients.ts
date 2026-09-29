// Who is talking to the MCP server right now.
//
// The HTTP transport is stateless, so nothing ties one request to the next
// except what the client sends with every request: its User-Agent and, from
// the one `initialize` call it makes first, its clientInfo name. The registry
// keys on the User-Agent, learns the name from initialize, and guesses one
// from the agent string for clients that never introduced themselves. The
// stdio entry point runs in its own process and reports in over the REST API.

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** The one method of the event bus the registry needs. */
interface Emitter {
  emit(ev: ClientEvent): void;
}

export type ClientKind = 'claude-code' | 'claude-desktop' | 'codex' | 'chatgpt' | 'other';

export interface ClientSeen {
  /** Stable per client: the agent string for HTTP, or the stdio process. */
  id: string;
  kind: ClientKind;
  /** What it called itself, or what it looks like. */
  name: string;
  transport: 'http' | 'stdio' | 'tunnel';
  /** Milliseconds since the epoch. */
  lastSeen: number;
  lastMethod: string;
  calls: number;
}

export interface ClientEvent {
  projectId: '';
  type: 'client';
  client: ClientSeen;
}

/** The kind a client is, from its name or its agent string. */
export function kindOf(name: string, transport: ClientSeen['transport']): ClientKind {
  const n = name.toLowerCase();
  if (/claude[- ]?code|claude-cli|@anthropic-ai\/claude-code/.test(n)) return 'claude-code';
  if (/claude|anthropic/.test(n)) return 'claude-desktop';
  if (/codex/.test(n)) return 'codex';
  if (/chatgpt|openai/.test(n) || transport === 'tunnel') return 'chatgpt';
  if (transport === 'stdio') return 'claude-desktop';
  return 'other';
}

export class ClientRegistry {
  private seen = new Map<string, ClientSeen>();
  private names = new Map<string, string>();

  constructor(private events?: Emitter) {}

  /** Record one request. `clientName` is set on initialize and remembered for the id. */
  touch(o: { id: string; transport: ClientSeen['transport']; method: string; clientName?: string; agent?: string }): ClientSeen {
    if (o.clientName) this.names.set(o.id, o.clientName);
    const name = this.names.get(o.id) ?? o.agent?.split(/[\s/(]/)[0] ?? 'MCP client';
    const prev = this.seen.get(o.id);
    const client: ClientSeen = {
      id: o.id,
      name,
      transport: o.transport,
      kind: kindOf(this.names.get(o.id) ?? o.agent ?? '', o.transport),
      lastSeen: Date.now(),
      lastMethod: o.method,
      calls: (prev?.calls ?? 0) + 1,
    };
    this.seen.set(o.id, client);
    this.events?.emit({ projectId: '', type: 'client', client });
    return client;
  }

  list(): ClientSeen[] {
    return [...this.seen.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }
}

/** What an incoming MCP request says about its sender, without consuming the request. */
export async function describeMcpRequest(req: Request): Promise<{ id: string; transport: 'http' | 'tunnel'; method: string; clientName?: string; agent: string }> {
  const agent = req.headers.get('user-agent') ?? 'unknown';
  const transport = req.headers.has('cf-ray') || req.headers.has('cf-connecting-ip') ? 'tunnel' : 'http';
  let method = req.method === 'GET' ? 'stream' : 'request';
  let clientName: string | undefined;
  if (req.method === 'POST') {
    try {
      const body = (await req.clone().json()) as { method?: string; params?: { clientInfo?: { name?: string } } } | { method?: string }[];
      const first = Array.isArray(body) ? body[0] : body;
      if (first && typeof first.method === 'string') method = first.method;
      const info = !Array.isArray(body) ? body.params?.clientInfo : undefined;
      if (info?.name) clientName = info.name;
    } catch {
      /* not JSON, or a stream: still a request */
    }
  }
  return { id: `${transport}:${agent}`, transport, method, clientName, agent };
}

/**
 * A stdio server lives in a process of its own, launched by the assistant, so
 * the web app never sees its traffic. Wrap the transport after the server
 * has connected and every message goes on as before, with a heartbeat to the
 * HTTP server's registry first. Failures are ignored: the lights are a
 * courtesy, not a dependency.
 */
export function reportStdioActivity(transport: { onmessage?: (message: JSONRPCMessage, extra?: unknown) => void }, baseUrl: string) {
  let name = 'stdio client';
  const orig = transport.onmessage;
  transport.onmessage = (message: JSONRPCMessage, extra?: unknown) => {
    const m = message as unknown as { method?: string; params?: { clientInfo?: { name?: string } } };
    if (m.params?.clientInfo?.name) name = m.params.clientInfo.name;
    if (typeof m.method === 'string') void fetch(`${baseUrl}/api/clients/touch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, method: m.method, transport: 'stdio' }) }).catch(() => {});
    orig?.(message, extra);
  };
}

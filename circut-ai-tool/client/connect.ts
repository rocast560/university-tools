// Copy-paste snippets for Claude Desktop, Claude Code, ChatGPT, Codex and curl,
// plus the cloud-access toggle that exposes this server through a tunnel.

import { api, type TunnelStatus } from './api.ts';
import { appBar, esc, h, toast, wireAppBar } from './main.ts';
import { store } from './state.ts';
import { placeLights } from './lights.ts';

/** Which status light a connect snippet belongs to. */
function lightKindFor(id: string): 'claude-code' | 'claude-desktop' | 'codex' | 'chatgpt' | null {
  if (id === 'claude-code') return 'claude-code';
  if (id === 'claude-desktop' || id === 'claude-connector') return 'claude-desktop';
  if (id === 'codex') return 'codex';
  if (id === 'chatgpt') return 'chatgpt';
  return null;
}

function cloudCard(t: TunnelStatus): string {
  const busy = t.state === 'downloading' || t.state === 'starting';
  const label = { off: 'Start tunnel', downloading: 'Downloading cloudflared…', starting: 'Starting…', on: 'Stop tunnel', error: 'Retry' }[t.state];
  const live = t.state === 'on' && t.mcpUrl;
  return `<section class="snippet cloud">
    <h3>Cloud access <span class="tunnel-state is-${t.state}">${t.state === 'on' ? 'live' : esc(t.state)}</span></h3>
    <p class="muted">ChatGPT can only reach servers on the internet. This runs a cloudflared tunnel and gives you a public https URL to paste into ChatGPT › Connectors. cloudflared is downloaded once, the first time you switch it on.</p>
    <p class="warn-note">While the tunnel is on, anyone who has the URL can read <em>and edit</em> your schematics through it. The address is random and stops working the moment you switch it off.</p>
    ${live ? `<pre><code>${esc(t.mcpUrl!)}</code></pre><button data-copy>Copy</button>` : ''}
    ${t.message ? `<p class="muted">${esc(t.message)}</p>` : ''}
    <p><button class="${t.state === 'on' ? '' : 'primary'}" data-tunnel="${t.state === 'on' ? 'stop' : 'start'}" ${busy ? 'disabled' : ''}>${esc(label)}</button></p>
  </section>`;
}

export async function renderConnect(root: HTMLElement) {
  root.replaceChildren(h(`<main class="connect">${appBar(store.get().theme, { title: 'Connect an assistant', current: 'connect' })}<p class="muted">Loading…</p></main>`));
  wireAppBar(root.querySelector<HTMLElement>('header.appbar')!);
  try {
    const info = await api.connect();
    const main = root.querySelector('main')!;

    const wireCopy = () =>
      main.querySelectorAll<HTMLButtonElement>('button[data-copy]').forEach((b) =>
        b.addEventListener('click', async () => {
          await navigator.clipboard.writeText(b.previousElementSibling!.textContent ?? '');
          b.textContent = 'Copied';
          setTimeout(() => (b.textContent = 'Copy'), 1500);
        }),
      );

    function wireTunnel() {
      main.querySelectorAll<HTMLButtonElement>('button[data-tunnel]').forEach((b) =>
        b.addEventListener('click', async () => {
          const action = b.dataset.tunnel as 'start' | 'stop';
          b.disabled = true;
          if (action === 'start') b.textContent = 'Starting…';
          try {
            paint(await api.tunnel(action));
          } catch (err) {
            toast((err as Error).message);
            b.disabled = false;
          }
        }),
      );
    }

    function paint(t: TunnelStatus) {
      const old = main.querySelector('.cloud');
      const next = h(cloudCard(t));
      old ? old.replaceWith(next) : main.append(next);
      wireCopy();
      wireTunnel();
    }

    const bar = main.querySelector<HTMLElement>('header.appbar')!;
    bar.querySelector('.spacer')!.before(h(`<span class="path">MCP ${esc(info.mcpUrl)}</span>`));
    main.replaceChildren(
      bar,
      h(`<p>Tools: <code>${info.tools.map(esc).join('</code>, <code>')}</code></p>`),
      h(cloudCard(info.tunnel)),
      ...info.snippets.map((s) => {
        const kind = lightKindFor(s.id);
        const light = kind ? `<span class="conn-light light is-off" data-kind="${kind}"><i></i><span class="conn-state">not connected</span></span>` : '';
        return h(`<section class="snippet"><h3>${esc(s.title)}${light}</h3><p class="muted">${esc(s.how)}</p><pre><code>${esc(s.code)}</code></pre><button data-copy>Copy</button></section>`);
      }),
    );
    wireCopy();
    wireTunnel();
    placeLights();
  } catch (e) {
    root.querySelector('p')!.textContent = `Server not reachable: ${(e as Error).message}`;
  }
}

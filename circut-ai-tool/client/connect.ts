// Copy-paste snippets for Claude Desktop, Claude Code, ChatGPT, Codex and curl.

import { api } from './api.ts';
import { esc, h } from './main.ts';

export async function renderConnect(root: HTMLElement) {
  root.replaceChildren(h('<main class="connect"><header><a href="#/" class="back">← projects</a><h1>Connect an assistant</h1></header><p class="muted">Loading…</p></main>'));
  try {
    const info = await api.connect();
    const main = root.querySelector('main')!;
    main.replaceChildren(
      h(`<header><a href="#/" class="back">← projects</a><h1>Connect an assistant</h1><span class="path">MCP ${esc(info.mcpUrl)}</span></header>`),
      h(`<p>Tools: <code>${info.tools.map(esc).join('</code>, <code>')}</code></p>`),
      ...info.snippets.map((s) => h(`<section class="snippet"><h3>${esc(s.title)}</h3><p class="muted">${esc(s.how)}</p><pre><code>${esc(s.code)}</code></pre><button data-copy>Copy</button></section>`)),
    );
    main.querySelectorAll<HTMLButtonElement>('button[data-copy]').forEach((b) =>
      b.addEventListener('click', async () => {
        await navigator.clipboard.writeText(b.previousElementSibling!.textContent ?? '');
        b.textContent = 'Copied';
        setTimeout(() => (b.textContent = 'Copy'), 1500);
      }),
    );
  } catch (e) {
    root.querySelector('p')!.textContent = `Server not reachable: ${(e as Error).message}`;
  }
}

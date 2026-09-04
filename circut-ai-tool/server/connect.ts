// Copy and paste snippets for connecting chat clients to this server.

import path from 'node:path';
import { APP_NAME, PACKAGED_EXE, PROJECT_ROOT, PUBLIC_URL } from './config.ts';

export interface ConnectSnippet {
  id: string;
  title: string;
  how: string;
  language: 'json' | 'bash' | 'text';
  code: string;
}

export const TOOL_NAMES = ['list_projects', 'open_schematic', 'refresh', 'get_summary', 'get_layout', 'render_breadboard', 'render_schematic', 'get_build_steps', 'get_checks', 'get_truth_table', 'get_pinout', 'explain_net', 'simulate', 'list_supported_parts', 'set_layout_options', 'move_part', 'set_net_color', 'reset_layout', 'run_erc', 'add_component', 'connect', 'disconnect', 'remove_component', 'set_value'];

export function buildConnectInfo(publicUrl: string = PUBLIC_URL) {
  // Packaged: one executable that speaks stdio with --stdio. Dev: bun + the script.
  // PROJECT_ROOT/process.execPath are both meaningless inside a compiled binary.
  const stdioCommand = PACKAGED_EXE ?? process.execPath;
  const stdioArgs = PACKAGED_EXE ? ['--stdio'] : [path.join(PROJECT_ROOT, 'server', 'mcp-stdio.ts')];
  const stdioLine = `"${stdioCommand}" "${stdioArgs.join('" "')}"`;
  const PUBLIC_URL = publicUrl;
  const mcpUrl = `${PUBLIC_URL}/mcp`;
  const openapiUrl = `${PUBLIC_URL}/openapi.json`;
  const snippets: ConnectSnippet[] = [
    { id: 'claude-desktop', title: 'Claude Desktop (stdio, works even when this server is closed)', how: 'Claude Desktop: Settings, Developer, Edit Config. Merge this into claude_desktop_config.json, save, then fully quit and reopen Claude Desktop.', language: 'json', code: JSON.stringify({ mcpServers: { [APP_NAME]: { command: stdioCommand, args: stdioArgs } } }, null, 2) },
    { id: 'claude-connector', title: 'Claude Desktop or claude.ai (custom connector over HTTP)', how: 'Settings, Connectors, Add custom connector, paste this URL. Needs the server running (bun start). If only https is accepted, expose it with a tunnel (see ChatGPT) and paste the tunnel URL plus /mcp.', language: 'text', code: mcpUrl },
    { id: 'claude-code', title: 'Claude Code', how: 'Run once in any terminal. The existing "circuit-designer" registration keeps working because /mcp-server/mcp is an alias of /mcp.', language: 'bash', code: [`claude mcp add --transport http ${APP_NAME} ${mcpUrl}`, `# or, without the web server running:`, `claude mcp add ${APP_NAME} -- ${stdioLine}`].join('\n') },
    { id: 'chatgpt', title: 'ChatGPT (desktop or web)', how: 'ChatGPT reaches MCP servers over the internet only. Expose the local server with a tunnel, then Settings, Connectors (Developer mode under Advanced), Create, paste the tunnel URL plus /mcp. The tunnel URL plus /openapi.json also works as a Custom GPT Action.', language: 'bash', code: [`bun start`, `# second terminal, either:`, `npx cloudflared tunnel --url ${PUBLIC_URL}`, `# or:`, `ngrok http ${PUBLIC_URL.replace(/^https?:\/\//, '')}`, `# then paste  https://<tunnel-host>/mcp  into ChatGPT`].join('\n') },
    { id: 'codex', title: 'Codex CLI', how: 'Register the running server.', language: 'bash', code: `codex mcp add ${APP_NAME} --url ${mcpUrl}` },
    { id: 'api', title: 'Plain HTTP', how: 'Open a schematic, then read the layout or the picture.', language: 'bash', code: [`curl -X POST ${PUBLIC_URL}/api/projects/open -H "content-type: application/json" -d "{\\"path\\": \\"C:/Users/you/Documents/KiCad/9.0/projects/PL1_1/PL1_1.kicad_sch\\"}"`, `curl ${PUBLIC_URL}/api/projects/<id>/layout`, `curl ${PUBLIC_URL}/api/projects/<id>/board.png -o board.png`, `curl ${openapiUrl}`].join('\n') },
  ];
  return { appUrl: PUBLIC_URL, mcpUrl, mcpAliasUrl: `${PUBLIC_URL}/mcp-server/mcp`, openapiUrl, stdioCommand: stdioLine, projectDir: PROJECT_ROOT, tools: TOOL_NAMES, snippets };
}

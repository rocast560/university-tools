// Copy and paste snippets for connecting chat clients to this server. The
// absolute paths are filled in from the running process, so what the user
// copies is exactly what their machine needs.

import path from 'node:path';
import { PROJECT_ROOT } from '../src/chem/paths.ts';
import { APP_NAME, PUBLIC_URL } from './config.ts';

export interface ConnectSnippet {
  id: string;
  title: string;
  /** Short instruction, one or two sentences. */
  how: string;
  language: 'json' | 'bash' | 'text';
  code: string;
}

export function buildConnectInfo() {
  const stdioScript = path.join(PROJECT_ROOT, 'server', 'mcp-stdio.ts');
  const nodeExe = process.execPath;
  const mcpUrl = `${PUBLIC_URL}/mcp`;
  const openapiUrl = `${PUBLIC_URL}/openapi.json`;

  const claudeDesktop = {
    mcpServers: {
      [APP_NAME]: {
        command: nodeExe,
        args: [stdioScript],
      },
    },
  };

  const snippets: ConnectSnippet[] = [
    {
      id: 'claude-desktop',
      title: 'Claude Desktop (stdio, works even when this web server is closed)',
      how: 'Claude Desktop: Settings, Developer, Edit Config. Merge this into claude_desktop_config.json, save, then fully quit and reopen Claude Desktop. The tools appear under the tools icon in a new chat.',
      language: 'json',
      code: JSON.stringify(claudeDesktop, null, 2),
    },
    {
      id: 'claude-desktop-connector',
      title: 'Claude Desktop or claude.ai (custom connector over HTTP)',
      how: 'Settings, Connectors, Add custom connector, paste this URL. This needs the web server running (npm start). If your plan only accepts https URLs, expose it with a tunnel (see ChatGPT below) and paste the tunnel URL plus /mcp instead.',
      language: 'text',
      code: mcpUrl,
    },
    {
      id: 'claude-code',
      title: 'Claude Code',
      how: 'Run once in any terminal. The first command uses the web server; the second launches the tools directly and works offline.',
      language: 'bash',
      code: [
        `claude mcp add --transport http ${APP_NAME} ${mcpUrl}`,
        `# or, without the web server running:`,
        `claude mcp add ${APP_NAME} -- "${nodeExe}" "${stdioScript}"`,
      ].join('\n'),
    },
    {
      id: 'chatgpt',
      title: 'ChatGPT (desktop or web)',
      how: 'ChatGPT connects to MCP servers over the internet only, so first expose the local server with a tunnel, then in ChatGPT go to Settings, Connectors (turn on Developer mode under Advanced), Create, and paste the tunnel URL with /mcp. The same tunnel URL with /openapi.json works as a Custom GPT Action.',
      language: 'bash',
      code: [
        `npm start`,
        `# in a second terminal, either:`,
        `npx cloudflared tunnel --url ${PUBLIC_URL}`,
        `# or:`,
        `ngrok http ${PUBLIC_URL.replace(/^https?:\/\//, '')}`,
        `# then paste  https://<your-tunnel-host>/mcp  into ChatGPT's MCP server URL`,
      ].join('\n'),
    },
    {
      id: 'codex',
      title: 'Codex CLI',
      how: 'Register the running web server.',
      language: 'bash',
      code: `codex mcp add ${APP_NAME} --url ${mcpUrl}`,
    },
    {
      id: 'api',
      title: 'Plain HTTP (any language, any tool)',
      how: 'Every capability is a GET request. The OpenAPI document lists them all.',
      language: 'bash',
      code: [
        `curl "${PUBLIC_URL}/api/molecule?q=acetic%20acid"`,
        `curl "${PUBLIC_URL}/api/molecule/2d.png?q=caffeine" -o caffeine.png`,
        `curl "${PUBLIC_URL}/api/molecule/3d.sdf?q=C6H12O6" -o glucose.sdf`,
        `curl "${PUBLIC_URL}/api/balance?eq=Fe+%2B+O2+-%3E+Fe2O3"`,
        `curl "${openapiUrl}"`,
      ].join('\n'),
    },
  ];

  return {
    appUrl: PUBLIC_URL,
    mcpUrl,
    openapiUrl,
    stdioCommand: `"${nodeExe}" "${stdioScript}"`,
    projectDir: PROJECT_ROOT,
    tools: [
      'lookup_chemical', 'render_2d', 'render_3d', 'get_structure', 'search_chemicals',
      'list_library', 'formula_info', 'balance_equation', 'crystal_lattice',
    ],
    snippets,
  };
}

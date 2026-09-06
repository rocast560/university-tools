// Smoke test for the Docker image: run from the host against a running
// container. Proves the bind mount, the host->container path map, kicad-cli,
// PNG rendering and both MCP URLs.
//
//   bun scripts/docker-smoke.ts [http://localhost:8765]
//
// KICAD_PROJECTS (default C:/Users/rober/Documents/KiCad/9.0/projects) must be
// the folder docker-compose.yml mounts at /projects. A temporary
// circuit-smoke/ folder is created inside it and removed afterwards.

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const base = (process.argv[2] ?? 'http://localhost:8765').replace(/\/$/, '');
const projects = process.env.KICAD_PROJECTS ?? 'C:/Users/rober/Documents/KiCad/9.0/projects';
const fixture = path.resolve(import.meta.dir, '..', 'test', 'fixtures', 'PL1_1.kicad_sch');
const smokeDir = path.join(projects, 'circuit-smoke');
const hostPath = path.join(smokeDir, 'PL1_1.kicad_sch');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

async function waitForHealth(ms: number): Promise<{ ok: boolean; kicad: boolean | null } | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return (await r.json()) as { ok: boolean; kicad: boolean | null };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

const health = await waitForHealth(60_000);
check('server answers /api/health', health !== null);
check('kicad-cli is available in the container', health?.kicad === true, JSON.stringify(health));
if (!health) process.exit(1);

mkdirSync(smokeDir, { recursive: true });
cpSync(fixture, hostPath);
let id: string | null = null;
try {
  const open = await fetch(`${base}/api/projects/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: hostPath }) });
  const summary = (await open.json()) as { id?: string; path?: string; components?: unknown[]; errors?: number; error?: string };
  check('open by host path', open.ok, summary.error ?? '');
  check('path was mapped into the container', summary.path === '/projects/circuit-smoke/PL1_1.kicad_sch', String(summary.path));
  check('components parsed', (summary.components?.length ?? 0) > 0, `${summary.components?.length ?? 0} parts`);
  check('no layout errors', summary.errors === 0, String(summary.errors));
  id = summary.id ?? null;
  if (id) {
    const svg = await fetch(`${base}/api/projects/${id}/board.svg`);
    check('board.svg', svg.ok && (await svg.text()).includes('<svg'));
    const png = await fetch(`${base}/api/projects/${id}/board.png`);
    const bytes = png.ok ? (await png.arrayBuffer()).byteLength : 0;
    check('board.png renders (>20 KB)', png.ok && bytes > 20_000, `${bytes} bytes`);
    const checks = (await (await fetch(`${base}/api/projects/${id}/checks`)).json()) as { level: string }[];
    check('checks: no errors', checks.every((c) => c.level !== 'error'));
  }
  for (const url of ['/mcp', '/mcp-server/mcp']) {
    const r = await fetch(`${base}${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } }),
    });
    const text = await r.text();
    check(`MCP initialize on ${url}`, r.ok && text.includes('"name":"circuit-ai-tool"'));
  }
} finally {
  if (id) await fetch(`${base}/api/projects/${id}`, { method: 'DELETE' }).catch(() => {});
  rmSync(smokeDir, { recursive: true, force: true });
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);

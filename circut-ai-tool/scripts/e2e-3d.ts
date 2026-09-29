// End-to-end checks for the 3D editor: a real server, a real build and a real
// headless Chrome, driven over the DevTools protocol. Headless Chrome counts
// as a visible page, so timers and requestAnimationFrame run at full rate
// (the Chrome MCP tab does not: it is a background tab, clamped to 1 s).
//
// Run: bun run build && bun scripts/e2e-3d.ts [scenario ...]
// Needs kicad-cli (KiCad 9) to open the fixture schematic.

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8799;
const DEBUG = 9333;
const root = mkdtempSync(path.join(tmpdir(), 'e2e3d-'));
const base = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class CDP {
  private id = 0;
  private waiting = new Map<number, (v: unknown) => void>();
  constructor(private ws: WebSocket) {
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id !== undefined) this.waiting.get(msg.id)?.(msg.error ? Promise.reject(new Error(msg.error.message)) : msg.result);
    });
  }
  static async open(url: string): Promise<CDP> {
    const ws = new WebSocket(url);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    return new CDP(ws);
  }
  send<T = unknown>(method: string, params: object = {}): Promise<T> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((r) => this.waiting.set(id, r as (v: unknown) => void));
  }
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  async until(expression: string, what: string, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await this.eval<boolean>(`!!(${expression})`)) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  }
  async mouse(type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', x: number, y: number, clickCount = 1) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount });
  }
  async key(key: string, code: string, modifiers = 0) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
  }
}

async function main() {
  const server = Bun.spawn(['bun', 'server/index.ts'], { env: { ...process.env, CIRCUIT_PORT: String(PORT), DATA_DIR: path.join(root, 'data'), PROJECTS_DIR: root }, stdout: 'ignore', stderr: 'inherit' });
  const chrome = Bun.spawn([CHROME, '--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${path.join(root, 'chrome')}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1400,900', 'about:blank'], { stdout: 'ignore', stderr: 'ignore' });
  let failed = 0;
  try {
    for (let i = 0; ; i++) {
      if (await fetch(`${base}/api/projects`).then((r) => r.ok, () => false)) break;
      if (i > 100) throw new Error('server did not start');
      await sleep(100);
    }
    const sch = path.join(root, 'PL1_1.kicad_sch');
    copyFileSync('test/fixtures/PL1_1.kicad_sch', sch);
    const opened = (await (await fetch(`${base}/api/projects/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: sch }) })).json()) as { id: string };
    let target: { webSocketDebuggerUrl: string } | null = null;
    for (let i = 0; i < 100 && !target; i++) {
      // Encoded, or DevTools reads the # as its own fragment and drops the route.
      target = await fetch(`http://localhost:${DEBUG}/json/new?${encodeURIComponent(`${base}/?e2e#/p/${opened.id}`)}`, { method: 'PUT' }).then((r) => r.json(), () => null);
      if (!target) await sleep(100);
    }
    const page = await CDP.open(target!.webSocketDebuggerUrl);
    await page.send('Runtime.enable');
    const want = new Set(process.argv.slice(2));
    for (const [name, run] of Object.entries(SCENARIOS)) {
      if (want.size && !want.has(name)) continue;
      try {
        await page.eval(`location.reload()`);
        await page.until(`document.querySelector('[data-action=view3d]')`, 'the project page');
        await run(page, opened.id);
        console.log(`ok   ${name}`);
      } catch (e) {
        failed++;
        console.log(`FAIL ${name}: ${(e as Error).message}`);
      }
    }
  } finally {
    chrome.kill();
    server.kill();
    await sleep(300);
    rmSync(root, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

/** Open the workspace and wait until its scene has drawn a frame. */
async function open3d(page: CDP) {
  await page.eval(`document.querySelector('[data-action=view3d]').click()`);
  await page.until(`window.__e3d?.ready`, 'the 3D workspace');
}

const SCENARIOS: Record<string, (page: CDP, id: string) => Promise<void>> = {
  async 'workspace opens full screen'(page) {
    await open3d(page);
    const r = await page.eval<{ w: number; h: number }>(`(() => { const b = document.querySelector('.ws').getBoundingClientRect(); return { w: b.width, h: b.height }; })()`);
    if (r.w < 1300 || r.h < 800) throw new Error(`workspace is ${r.w}x${r.h}, not full screen`);
  },
};

void main();

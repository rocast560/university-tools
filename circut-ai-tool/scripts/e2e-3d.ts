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
import type { Hole, WirePath } from '../src/layout/types.ts';
import type { LayoutDoc } from '../src/pipeline.ts';
import { planToPath, wireKey } from '../src/render/route3d.ts';

const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8799;
const DEBUG = 9333;
const root = mkdtempSync(path.join(tmpdir(), 'e2e3d-'));
const base = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long any one protocol call may take before the run gives up on it. */
const SEND_TIMEOUT = 30000;

class CDP {
  private id = 0;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<(params: unknown) => void>>();
  constructor(private ws: WebSocket) {
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
      if (msg.id !== undefined) {
        const w = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (msg.error) w?.reject(new Error(msg.error.message));
        else w?.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    });
    // A closed socket answers nothing; fail whatever is still waiting rather than hang.
    ws.addEventListener('close', () => {
      for (const w of this.waiting.values()) w.reject(new Error('DevTools connection closed'));
      this.waiting.clear();
    });
  }
  static async open(url: string): Promise<CDP> {
    const ws = new WebSocket(url);
    await new Promise((r, j) => {
      ws.addEventListener('open', r, { once: true });
      ws.addEventListener('error', () => j(new Error('could not connect to DevTools')), { once: true });
    });
    return new CDP(ws);
  }
  send<T = unknown>(method: string, params: object = {}): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method} got no answer in ${SEND_TIMEOUT / 1000} s`));
      }, SEND_TIMEOUT);
      this.waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v as T)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** The next event of one kind. Ask before triggering it, or it can be missed. */
  next(method: string, ms = SEND_TIMEOUT): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const set = this.listeners.get(method) ?? new Set();
      this.listeners.set(method, set);
      const fn = (p: unknown) => {
        set.delete(fn);
        clearTimeout(timer);
        resolve(p);
      };
      const timer = setTimeout(() => {
        set.delete(fn);
        reject(new Error(`no ${method} in ${ms / 1000} s`));
      }, ms);
      set.add(fn);
    });
  }
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  async until(expression: string, what: string, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // A poll that lands while a document is being torn down just fails; the next one asks the new document.
      if (await this.eval<boolean>(`!!(${expression})`).catch(() => false)) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  }
  /** Reload and resolve once the new document has loaded, so nothing is asked of the old one. */
  async reload() {
    const loaded = this.next('Page.loadEventFired');
    await this.send('Page.reload', { ignoreCache: true });
    await loaded;
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
  let server: ReturnType<typeof Bun.spawn> | null = null;
  let chrome: ReturnType<typeof Bun.spawn> | null = null;
  let failed = 0;
  try {
    server = Bun.spawn(['bun', 'server/index.ts'], { env: { ...process.env, CIRCUIT_PORT: String(PORT), DATA_DIR: path.join(root, 'data'), PROJECTS_DIR: root }, stdout: 'ignore', stderr: 'inherit' });
    chrome = Bun.spawn([CHROME, '--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${path.join(root, 'chrome')}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1400,900', 'about:blank'], { stdout: 'ignore', stderr: 'ignore' });
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
    await page.send('Page.enable');
    const want = new Set(process.argv.slice(2));
    for (const [name, run] of Object.entries(SCENARIOS)) {
      if (want.size && !want.has(name)) continue;
      try {
        await page.reload();
        await page.until(`document.querySelector('[data-action=view3d]')`, 'the project page');
        await run(page, opened.id);
        console.log(`ok   ${name}`);
      } catch (e) {
        failed++;
        console.log(`FAIL ${name}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    failed++;
    console.log(`FAIL harness: ${(e as Error).message}`);
  } finally {
    chrome?.kill();
    server?.kill();
    await Promise.all([chrome?.exited, server?.exited]);
    // Chrome's child processes can hold the profile for a moment after it exits.
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        await sleep(250);
      }
    }
  }
  process.exit(failed ? 1 : 0);
}

/** Open the workspace and wait until its scene has drawn a frame. */
async function open3d(page: CDP) {
  await page.eval(`document.querySelector('[data-action=view3d]').click()`);
  await page.until(`window.__e3d?.ready`, 'the 3D workspace');
}

/**
 * Parts whose screen point picks as themselves (picks are depth-ordered, so a
 * jumper can sit in front of a part's top centre), in `__e3d.parts()` order.
 */
async function pickable(page: CDP) {
  return page.eval<{ ref: string; x: number; y: number }[]>(
    `__e3d.parts().flatMap((ref) => { const at = __e3d.screenOf(ref); const hit = at && __e3d.pickAt(at.x, at.y); return hit && hit.kind === 'part' && hit.ref === ref ? [{ ref, x: at.x, y: at.y }] : []; })`,
  );
}

/** Poll until `expression` holds or `ms` passes; true when it held. */
/** The toast on screen, if any, for a failure message. */
const lastToast = (page: CDP) => page.eval<string>(`document.getElementById('toast')?.textContent || 'none'`);

async function settles(page: CDP, expression: string, ms: number) {
  return page.until(expression, '', ms).then(() => true, () => false);
}

/** POST JSON to the test server; throws with the server's answer when it refuses. */
async function post(url: string, body: unknown) {
  const res = await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${url} failed with ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  return res;
}

/** POST JSON to the test server; whether it accepted it. */
async function tryPost(url: string, body: unknown) {
  const res = await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await res.text().catch(() => '');
  return res.ok;
}

/** GET JSON from the test server; throws when it refuses. */
async function get<T>(url: string): Promise<T> {
  const res = await fetch(`${base}${url}`);
  if (!res.ok) throw new Error(`GET ${url} failed with ${res.status}`);
  return (await res.json()) as T;
}

/** Square wires and no hand shapes, set on the server and picked up by a fresh page. */
async function squareWires(page: CDP, id: string) {
  await post(`/api/projects/${id}/layout/options`, { wireStyle: 'orthogonal' });
  await post(`/api/projects/${id}/layout/wire`, { key: '*', path: null });
  await page.reload();
  await page.until(`document.querySelector('[data-action=view3d]')`, 'the project page');
}

/** Back to curved wires with no hand shapes, so a square-wire scenario leaves nothing behind for the next. */
async function arcWires(id: string) {
  await post(`/api/projects/${id}/layout/wire`, { key: '*', path: null });
  await post(`/api/projects/${id}/layout/options`, { wireStyle: 'arc' });
}

/**
 * A jumper whose middle picks as itself (a part can stand in front of it).
 * With `run`, only one with a run across the board longer than two pitches,
 * which has a segment handle to drag up and down the screen; `seg` is that run.
 */
async function pickableWire(page: CDP, run = false, skip: string[] = []) {
  const hit = await page.eval<{ key: string; index: number; net: string; x: number; y: number; seg: number } | null>(
    `(() => { const plans = __e3d.routes(); const keys = __e3d.wires(); const skip = ${JSON.stringify(skip)}; for (let i = 0; i < keys.length; i++) { if (skip.includes(keys[i])) continue; const p = plans?.[i]; const seg = p ? p.findIndex((q, k) => k + 1 < p.length && q[1] === p[k + 1][1] && Math.abs(q[0] - p[k + 1][0]) > 36) : -1; if (${run} && seg < 0) continue; const at = __e3d.wireScreen(i); const hit = at && __e3d.pickAt(at.x, at.y); if (hit && hit.kind === 'wire' && hit.index === i) return { key: keys[i], index: i, net: hit.net, x: at.x, y: at.y, seg }; } return null; })()`,
  );
  if (!hit) throw new Error('no jumper could be picked at its middle');
  return hit;
}

/**
 * Arm a part from the tray with a real tap on its tile, showing every part
 * first when it is not in the group on screen.
 */
async function armTile(page: CDP, alias: string) {
  const sel = `.ws-tile[data-alias=${JSON.stringify(alias)}]`;
  await page.until(`document.querySelector('.ws-tile')`, 'the tray tiles');
  if (!(await page.eval<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`))) await page.eval(`document.querySelector('.ws-chip[data-group=All]').click()`);
  await page.until(`document.querySelector(${JSON.stringify(sel)})`, `the ${alias} tile`);
  const at = await page.eval<{ x: number; y: number }>(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); t.scrollIntoView({ inline: 'center' }); const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.mouse('mousePressed', at.x, at.y);
  await page.mouse('mouseReleased', at.x, at.y);
  await page.until(`document.querySelector(${JSON.stringify(sel + '.is-armed')})`, `${alias} to be armed`);
}

/**
 * Two free holes `span` columns apart on one row, both on screen with the
 * canvas under them, preferring strips no leg is in yet; with the screen
 * point of the first.
 */
async function freeSpot(page: CDP, span: number, avoid: number[] = []) {
  // The camera can still be gliding into place just after the editor opens; a hole's screen point is only good once it stops.
  for (let last = '', i = 0; i < 40; i++) {
    const now = await page.eval<string>(`JSON.stringify(__e3d.holeScreen({ col: 1, row: 'a' }))`);
    if (now === last) break;
    last = now;
    await sleep(150);
  }
  const spot = await page.eval<{ col: number; row: string; x: number; y: number } | null>(
    `(() => { const used = new Set(); const taken = new Set(); for (const pins of Object.values(__e3d.allHoles())) for (const h of Object.values(pins)) { used.add(h.col + (/[a-e]/.test(h.row) ? 'top' : 'bot')); taken.add(h.row + h.col); } const cols = __e3d.boardSpec().cols; for (const strict of [true, false]) for (const row of ['c', 'h', 'b', 'i']) { const half = /[a-e]/.test(row) ? 'top' : 'bot'; for (let col = 2; col + ${span} <= cols - 1; col++) { if (${JSON.stringify(avoid)}.includes(col)) continue; if (taken.has(row + col) || taken.has(row + (col + ${span}))) continue; if (strict && (used.has(col + half) || used.has(col + ${span} + half))) continue; const a = __e3d.holeScreen({ col, row }); const b = __e3d.holeScreen({ col: col + ${span}, row }); if (!a || !b) continue; if (document.elementFromPoint(a.x, a.y)?.tagName !== 'CANVAS' || document.elementFromPoint(b.x, b.y)?.tagName !== 'CANVAS') continue; return { col, row, x: a.x, y: a.y }; } } return null; })()`,
  );
  if (!spot) throw new Error('no free spot on screen for a new part');
  return spot;
}

/** Take out parts a scenario added, so the next scenario sees the fixture as it was. */
async function removeAdded(id: string, before: string[]) {
  const now = await get<LayoutDoc>(`/api/projects/${id}/layout`);
  const refs = new Set([...Object.keys(now.pinHoles), ...now.parts.map((x) => x.id), ...now.packages.map((x) => x.id), ...now.unplaced.map((x) => x.ref)]);
  for (const ref of refs) if (!before.includes(ref)) await tryPost(`/api/projects/${id}/edit/remove`, { ref });
}

/**
 * Two free holes on screen, the canvas under both, for a jumper from a hole
 * passing `from` (page code over `h`) to one whose jumper outcome passes `want`
 * (page code over `o`). Rails are left out.
 */
async function jumperEnds(page: CDP, from: string, want: string) {
  const ends = await page.eval<{ a: Hole; b: Hole; ax: number; ay: number; bx: number; by: number } | null>(
    `(() => { const taken = new Set(); for (const pins of Object.values(__e3d.allHoles())) for (const h of Object.values(pins)) taken.add(h.row + h.col); const cols = __e3d.boardSpec().cols; const free = []; for (const row of 'abcdefghij') for (let col = 1; col <= cols; col++) { if (taken.has(row + col)) continue; const at = __e3d.holeScreen({ col, row }); if (!at || document.elementFromPoint(at.x, at.y)?.tagName !== 'CANVAS') continue; free.push({ h: { col, row }, at }); } const fromOk = (h) => ${from}; for (const a of free) { if (!fromOk(a.h)) continue; for (const b of free) { const o = __e3d.jumper(a.h, b.h); if (${want}) return { a: a.h, b: b.h, ax: a.at.x, ay: a.at.y, bx: b.at.x, by: b.at.y }; } } return null; })()`,
  );
  if (!ends) throw new Error('no pair of holes on screen gives that jumper');
  return ends;
}

/** A click (press and release in place) at a screen point. */
async function click(page: CDP, x: number, y: number) {
  await page.mouse('mouseMoved', x, y);
  await page.mouse('mousePressed', x, y);
  await page.mouse('mouseReleased', x, y);
}

const SCENARIOS: Record<string, (page: CDP, id: string) => Promise<void>> = {
  async 'the editor opens with the kit models loaded'(page) {
    await open3d(page);
    const keys = await page.eval<string[]>(`__e3d.modelKeys().slice().sort()`);
    if (keys.join() !== 'dip14,dip16,dipswitch7,led5,r0207,seg056') throw new Error(`models loaded: ${keys.join() || 'none'}`);
  },
  async 'Detail toggle swaps to simple shapes and back'(page) {
    try {
      await open3d(page);
      await page.until(`__e3d.modelKeys().length === 6`, 'the models');
      await page.eval(`document.querySelector('[data-ws=detail]').click()`);
      await page.until(`document.querySelector('[data-ws=detail]').textContent === 'Detail: simple' && __e3d.modelKeys().length === 0`, 'simple detail');
      await page.reload();
      await page.until(`document.querySelector('[data-action=view3d]')`, 'the project page');
      await open3d(page);
      if ((await page.eval<string>(`document.querySelector('[data-ws=detail]').textContent`)) !== 'Detail: simple') throw new Error('the choice was not remembered');
      await page.eval(`document.querySelector('[data-ws=detail]').click()`);
      await page.until(`document.querySelector('[data-ws=detail]').textContent === 'Detail: high' && __e3d.modelKeys().length === 6`, 'high detail again');
    } finally {
      await page.eval(`try { localStorage.removeItem('benchmate.3dDetail'); } catch {}`);
    }
  },
  async 'Detail toggle keeps the selection and the Show filter'(page) {
    try {
      await open3d(page);
      await page.until(`__e3d.modelKeys().length === 6`, 'the models');
      const target = (await pickable(page))[0];
      if (!target) throw new Error('no pickable part');
      await page.eval(`__e3d.select(${JSON.stringify(target.ref)})`);
      await page.eval(`document.querySelector('.ws-legend [data-show=resistors]').click()`);
      for (const want of ['simple', 'high']) {
        await page.eval(`document.querySelector('[data-ws=detail]').click()`);
        await page.until(`document.querySelector('[data-ws=detail]').textContent === 'Detail: ${want}' && __e3d.modelKeys().length === ${want === 'high' ? 6 : 0}`, `${want} detail`);
        const ok = await page.eval<boolean>(`__e3d.selected() === ${JSON.stringify(target.ref)} && document.querySelector('.ws-legend [data-show=resistors]').classList.contains('is-on')`);
        if (!ok) throw new Error(`the selection or Show filter was lost going to ${want}`);
      }
    } finally {
      await page.eval(`try { localStorage.removeItem('benchmate.3dDetail'); } catch {}`);
    }
  },
  async 'a missing model falls back'(page) {
    await open3d(page);
    await page.eval(`__e3d.dropModels(['dip14'])`);
    await page.key('Escape', 'Escape');
    await page.until(`!document.querySelector('.ws')`, 'the editor to close');
    await open3d(page);
    const keys = await page.eval<string[]>(`__e3d.modelKeys()`);
    if (keys.includes('dip14') || keys.length !== 5) throw new Error(`keys after the drop: ${keys.join()}`);
    if (!(await pickable(page)).length) throw new Error('nothing is pickable');
    const chip = await page.eval<{ x: number; y: number } | null>(`(() => { const ref = __e3d.chips()[0]; const at = ref && __e3d.screenOf(ref); return at ? { x: at.x, y: at.y } : null; })()`);
    if (!chip) throw new Error('no chip on screen');
  },
  async 'workspace opens full screen'(page) {
    await open3d(page);
    const r = await page.eval<{ w: number; h: number }>(`(() => { const b = document.querySelector('.ws').getBoundingClientRect(); return { w: b.width, h: b.height }; })()`);
    if (r.w < 1300 || r.h < 800) throw new Error(`workspace is ${r.w}x${r.h}, not full screen`);
  },
  async 'Esc and Back both close it'(page) {
    await open3d(page);
    await page.key('Escape', 'Escape');
    await page.until(`!document.querySelector('.ws')`, 'Esc to close');
    await open3d(page);
    await page.eval(`history.back()`);
    await page.until(`!document.querySelector('.ws')`, 'Back to close');
    await page.until(`document.querySelector('[data-action=view3d]').textContent.trim() === '3D'`, 'the toolbar button to read 3D again');
  },
  async 'Back during load leaves no editor behind'(page) {
    // Hold the three download open so Back can land while it is pending.
    await page.eval(`window.__e3dDelay = 1500`);
    await page.eval(`document.querySelector('[data-action=view3d]').click()`);
    await page.until(`document.querySelector('.ws')`, 'the shell to appear');
    await page.eval(`history.back()`);
    await sleep(2500);
    const left = await page.eval<boolean>(`!document.querySelector('.ws') && !document.body.classList.contains('ws-open') && !window.__e3d`);
    if (!left) throw new Error('an editor was left behind');
    await page.until(`document.querySelector('[data-action=view3d]').textContent.trim() === '3D'`, 'the toolbar button to read 3D');
  },
  async 'a failed mount leaves no shell'(page) {
    await page.eval(`window.__e3dFailMount = true`);
    await page.eval(`document.querySelector('[data-action=view3d]').click()`);
    await page.until(`document.querySelector('.toast')`, 'the failure toast');
    const left = await page.eval<boolean>(`!document.querySelector('.ws') && !document.body.classList.contains('ws-open') && !window.__e3d`);
    if (!left) throw new Error('a shell was left behind');
    await page.until(`document.querySelector('[data-action=view3d]').textContent.trim() === '3D'`, 'the toolbar button to read 3D');
  },
  async 'clicking a part selects it, empty board clears it'(page) {
    await open3d(page);
    // Picks are depth-ordered, so a jumper can sit in front of a part's top centre: take a part whose point picks as itself.
    const target = await page.eval<{ ref: string; x: number; y: number } | null>(
      `(() => { for (const ref of __e3d.parts()) { const at = __e3d.screenOf(ref); const hit = at && __e3d.pickAt(at.x, at.y); if (hit && hit.kind === 'part' && hit.ref === ref) return { ref, x: at.x, y: at.y }; } return null; })()`,
    );
    if (!target) throw new Error('no part could be picked at its screen point');
    await page.mouse('mousePressed', target.x, target.y);
    await page.mouse('mouseReleased', target.x, target.y);
    await page.until(`__e3d.selected() === ${JSON.stringify(target.ref)}`, `${target.ref} to be selected`);
    // Empty canvas: nothing picked there, and the canvas (not the legend or toolbar) is what sits under the point.
    const empty = await page.eval<{ x: number; y: number } | null>(
      `(() => { for (let y = 120; y < 880; y += 40) for (let x = 1380; x > 700; x -= 40) { if (__e3d.pickAt(x, y) === null && document.elementFromPoint(x, y)?.tagName === 'CANVAS') return { x, y }; } return null; })()`,
    );
    if (!empty) throw new Error('no empty canvas point found');
    await page.mouse('mousePressed', empty.x, empty.y);
    await page.mouse('mouseReleased', empty.x, empty.y);
    await page.until(`__e3d.selected() === null`, 'the selection to clear');
  },
  async 'dragging a selected part moves it to new holes'(page) {
    await open3d(page);
    const candidates = await pickable(page);
    if (!candidates.length) throw new Error('no part could be picked at its screen point');
    // Try a few distances right on the first pickable part: some columns may be
    // taken, and one of them must be free. If every nearby column is taken for
    // that part, try the next one before giving up.
    for (const { ref } of candidates.slice(0, 4)) {
      // The previous part's card floats over the canvas and would catch this part's click.
      await page.eval(`__e3d.select(null)`);
      // Asked again for each part: a refused drag leaves the camera alone, but a screen point is only good for the current view.
      const at = (await pickable(page)).find((c) => c.ref === ref);
      if (!at) continue;
      const { x, y } = at;
      const before = await page.eval<Record<string, { col: number }>>(`__e3d.holes(${JSON.stringify(ref)})`);
      const beforeKey = JSON.stringify(before);
      await page.mouse('mousePressed', x, y);
      await page.mouse('mouseReleased', x, y);
      await page.until(`__e3d.selected() === ${JSON.stringify(ref)}`, `${ref} to be selected`);
      for (const dx of [60, 120, 180, 240]) {
        await page.mouse('mousePressed', x, y);
        for (let k = 1; k <= 6; k++) await page.mouse('mouseMoved', x + (dx * k) / 6, y);
        await page.mouse('mouseReleased', x + dx, y);
        const changed = `JSON.stringify(__e3d.holes(${JSON.stringify(ref)})) !== ${JSON.stringify(beforeKey)}`;
        if (!(await settles(page, changed, 1500))) continue;
        const after = await page.eval<Record<string, { col: number }>>(`__e3d.holes(${JSON.stringify(ref)})`);
        if (Object.values(after)[0].col <= Object.values(before)[0].col) throw new Error(`${ref} moved, but not to the right`);
        return;
      }
    }
    throw new Error('no drag distance moved any part');
  },
  async 'leaving 3D releases the selection on the flat board'(page) {
    await open3d(page);
    const ref = (await page.eval<string[]>(`__e3d.parts()`))[0];
    await page.eval(`__e3d.select(${JSON.stringify(ref)})`);
    // The flat board underneath draws the 3D selection as a hard highlight: everything else dimmed.
    const dimmed = `document.querySelectorAll('#board .part[opacity], #board .pkg[opacity]').length`;
    await page.until(`${dimmed} > 0`, 'the flat board to dim around the selection');
    await page.eval(`history.back()`);
    await page.until(`!document.querySelector('.ws')`, 'Back to close');
    await page.until(`${dimmed} === 0`, 'the flat board to un-dim after leaving 3D', 5000);
  },
  async 'a drag that starts on an unselected part orbits instead'(page) {
    await open3d(page);
    const [first] = await pickable(page);
    if (!first) throw new Error('no part could be picked at its screen point');
    const { ref, x, y } = first;
    const before = await page.eval<string>(`JSON.stringify(__e3d.holes(${JSON.stringify(ref)}))`);
    await page.mouse('mousePressed', x, y);
    for (let k = 1; k <= 6; k++) await page.mouse('mouseMoved', x + k * 20, y);
    await page.mouse('mouseReleased', x + 120, y);
    await sleep(400);
    if ((await page.eval<string>(`JSON.stringify(__e3d.holes(${JSON.stringify(ref)}))`)) !== before) throw new Error('an unselected part moved');
    if ((await page.eval<string | null>(`__e3d.selected()`)) !== null) throw new Error('an orbit drag selected a part');
  },
  async 'store update mid-drag does not strand a ghost'(page) {
    await open3d(page);
    const [first] = await pickable(page);
    if (!first) throw new Error('no part could be picked at its screen point');
    const { ref, x, y } = first;
    await page.mouse('mousePressed', x, y);
    await page.mouse('mouseReleased', x, y);
    await page.until(`__e3d.selected() === ${JSON.stringify(ref)}`, `${ref} to be selected`);
    await page.mouse('mousePressed', x, y);
    await page.mouse('mouseMoved', x + 40, y);
    // The drag has to be live, with holes tinted, for the cancel to prove anything.
    await page.until(`__e3d.tintCount() > 0`, 'strip tints while dragging', 3000);
    // A switch flick or a reload lands while the pointer is down.
    await page.eval(`document.querySelector('[data-ws=next]').click()`);
    await page.until(`__e3d.tintCount() > 0`, 'the drag to survive a store update that keeps the doc', 3000);
    await page.key('Escape', 'Escape');
    await page.mouse('mouseReleased', x + 40, y);
    await sleep(300);
    const tinted = await page.eval<number>(`__e3d.tintCount()`);
    if (tinted !== 0) throw new Error(`${tinted} strip tints left behind`);
    if (!(await page.eval<boolean>(`!!document.querySelector('.ws')`))) throw new Error('Esc mid-drag closed the editor');
  },
  async 'a doc change mid-drag ends the drag and clears the tints'(page) {
    await open3d(page);
    const parts = await pickable(page);
    if (parts.length < 2) throw new Error('need two pickable parts');
    const [{ ref, x, y }, other] = parts;
    const before = await page.eval<string>(`JSON.stringify(__e3d.holes(${JSON.stringify(ref)}))`);
    await page.mouse('mousePressed', x, y);
    await page.mouse('mouseReleased', x, y);
    await page.until(`__e3d.selected() === ${JSON.stringify(ref)}`, `${ref} to be selected`);
    await page.mouse('mousePressed', x, y);
    await page.mouse('mouseMoved', x + 40, y);
    await page.until(`__e3d.tintCount() > 0`, 'strip tints while dragging', 3000);
    // Another part re-pinned where it stands: a new doc arrives, nothing else changes.
    const ok = await page.eval<boolean>(`__e3d.move(${JSON.stringify(other.ref)}, __e3d.holes(${JSON.stringify(other.ref)}))`);
    if (!ok) throw new Error(`moving ${other.ref} in place was refused`);
    await page.until(`__e3d.tintCount() === 0`, 'the tints to clear when the doc changed', 3000);
    // The drag is over: more pointer travel and the release move nothing.
    await page.mouse('mouseMoved', x + 120, y);
    await page.mouse('mouseReleased', x + 120, y);
    await sleep(600);
    const tinted = await page.eval<number>(`__e3d.tintCount()`);
    if (tinted !== 0) throw new Error(`${tinted} strip tints came back after the drag ended`);
    if ((await page.eval<string>(`JSON.stringify(__e3d.holes(${JSON.stringify(ref)}))`)) !== before) throw new Error(`${ref} moved after its drag was cancelled`);
  },
  async 'the wire style button rebuilds the board in place'(page) {
    await open3d(page);
    const start = await page.eval<string>(`__e3d.wireStyle()`);
    const flipped = start === 'orthogonal' ? 'arc' : 'orthogonal';
    await page.eval(`document.querySelector('[data-ws=wires]').click()`);
    await page.until(`__e3d.wireStyle() === ${JSON.stringify(flipped)} && document.querySelector('[data-ws=wires]').textContent === ${JSON.stringify(flipped === 'orthogonal' ? 'Wires: square' : 'Wires: curved')}`, 'the wire style to switch');
    if (!(await page.eval<boolean>(`!!document.querySelector('.ws') && __e3d.ready`))) throw new Error('the workspace did not survive the rebuild');
    // Put it back so later scenarios see the default.
    await page.eval(`document.querySelector('[data-ws=wires]').click()`);
    await page.until(`__e3d.wireStyle() === ${JSON.stringify(start)}`, 'the wire style to switch back');
  },
  async 'an MCP-style REST edit reaches the open page quietly'(page, id) {
    await open3d(page);
    const ref = (await page.eval<string[]>(`__e3d.lead2()`))[0];
    await page.eval(`__e3d.select(${JSON.stringify(ref)})`);
    const value = '33k';
    // Straight at the server, as the MCP tools and other clients do: the page makes no call of its own.
    const res = await fetch(`${base}/api/projects/${id}/edit/value`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref, value }) });
    if (!res.ok) throw new Error(`edit/value answered ${res.status}: ${await res.text()}`);
    await page.until(`__e3d.value(${JSON.stringify(ref)}) === ${JSON.stringify(value)}`, 'the page to pick up the edit', 15000);
    const quiet = `!(document.getElementById('toast')?.textContent ?? '').includes('changed on disk')`;
    if (!(await page.eval<boolean>(quiet))) throw new Error('an edit was announced as "changed on disk"');
    // The watcher's view of the same write must not follow up with a toast either.
    await sleep(2000);
    if (!(await page.eval<boolean>(quiet))) throw new Error('the watcher echoed the edit as "changed on disk"');
    if ((await page.eval<string | null>(`__e3d.selected()`)) !== ref) throw new Error('the reload dropped the selection');
  },
  async 'R turns a resistor and Ctrl+Z puts it back'(page) {
    await open3d(page);
    const ref = (await page.eval<string[]>(`__e3d.lead2()`))[0];
    if (!ref) throw new Error('no two-lead part on the fixture');
    const read = () => page.eval<string>(`JSON.stringify(__e3d.holes(${JSON.stringify(ref)}))`);
    const before = await read();
    await page.eval(`__e3d.select(${JSON.stringify(ref)})`);
    // A quarter turn may be refused on a crowded board; press until one lands, at most 3.
    let turned = false;
    for (let i = 0; i < 3 && !turned; i++) {
      await page.key('r', 'KeyR');
      await sleep(900);
      turned = (await read()) !== before;
    }
    if (!turned) return console.log('     (no legal quarter turn for this part on this board; undo path not exercised)');
    await page.until(`!document.querySelector('[data-ws=undo]').disabled`, 'Undo to enable');
    await page.key('z', 'KeyZ', 2 /* ctrl */);
    await page.until(`JSON.stringify(__e3d.holes(${JSON.stringify(ref)})) === ${JSON.stringify(before)}`, 'undo to restore the holes');
    await page.key('Z', 'KeyZ', 2 | 8 /* ctrl+shift */);
    await page.until(`JSON.stringify(__e3d.holes(${JSON.stringify(ref)})) !== ${JSON.stringify(before)}`, 'redo to turn it again');
  },
  async 'Shift+R flips a chip end for end'(page) {
    await open3d(page);
    const ref = (await page.eval<string[]>(`__e3d.chips()`))[0];
    if (!ref) throw new Error('no chip on the fixture');
    await page.eval(`__e3d.select(${JSON.stringify(ref)})`);
    await page.key('R', 'KeyR', 8 /* shift */);
    // The placement rules may legitimately refuse an in-place flip; either outcome proves the key is wired.
    await page.until(
      `__e3d.holes(${JSON.stringify(ref)})['1'].row === 'e' || (document.getElementById('toast')?.textContent ?? '').includes("Can't flip")`,
      'pin 1 to move to row e, or a "Can\'t flip" toast',
      6000,
    );
    const flipped = await page.eval<boolean>(`__e3d.holes(${JSON.stringify(ref)})['1'].row === 'e'`);
    console.log(`     (${flipped ? 'chip flipped' : "flip refused with a Can't flip toast"})`);
  },
  async 'the card edits a value and survives the reload'(page) {
    await open3d(page);
    const ref = (await page.eval<string[]>(`__e3d.lead2()`)).find(() => true)!;
    await page.eval(`__e3d.select(${JSON.stringify(ref)})`);
    await page.until(`document.querySelector('.ws-card:not([hidden])')?.dataset.ref === ${JSON.stringify(ref)}`, 'the card');
    await page.eval(`(() => { const i = document.querySelector('.ws-card input[name=value]'); i.value = '4.7k'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await page.until(`__e3d.value(${JSON.stringify(ref)}) === '4.7k' && document.querySelector('.ws-card input[name=value]')?.value === '4.7k' && !document.querySelector('.ws-card.is-busy')`, 'the new value in the reloaded design', 20000);
    // The server must not echo our own edit back as a "changed on disk" reload.
    await new Promise((r) => setTimeout(r, 3000));
    if (await page.eval<boolean>(`(document.getElementById('toast')?.textContent ?? '').includes('changed on disk')`)) throw new Error('our own edit came back as "changed on disk"');
    await page.until(`document.querySelector('.ws-card:not([hidden])')?.dataset.ref === ${JSON.stringify(ref)} && __e3d.selected() === ${JSON.stringify(ref)}`, 'the card to survive the follow-up reload');
  },
  async 'Delete opens the confirm, but not while typing in the value'(page) {
    await open3d(page);
    const ref = (await page.eval<string[]>(`__e3d.lead2()`))[0];
    await page.eval(`__e3d.select(${JSON.stringify(ref)})`);
    await page.until(`document.querySelector('.ws-card:not([hidden])')`, 'the card');
    await page.eval(`document.querySelector('.ws-card input[name=value]').focus()`);
    await page.key('Backspace', 'Backspace');
    await new Promise((r) => setTimeout(r, 400));
    if (await page.eval<boolean>(`!document.querySelector('.ws-card-confirm').hidden`)) throw new Error('Backspace in the value field opened the delete confirm');
    await page.eval(`document.activeElement.blur()`);
    await page.key('Delete', 'Delete');
    await page.until(`!document.querySelector('.ws-card-confirm').hidden`, 'the confirm to open');
  },
  async 'card closes when its part disappears'(page) {
    await open3d(page);
    const ref = (await page.eval<string[]>(`__e3d.lead2()`)).at(-1)!;
    await page.eval(`__e3d.select(${JSON.stringify(ref)})`);
    await page.until(`document.querySelector('.ws-card:not([hidden])')`, 'the card');
    await page.eval(`document.querySelector('.ws-card [data-card=delete]').click()`);
    await page.eval(`document.querySelector('.ws-card [data-card=confirm]').click()`);
    await page.until(`!__e3d.parts().includes(${JSON.stringify(ref)})`, `${ref} to be removed`, 20000);
    await page.until(`!document.querySelector('.ws-card:not([hidden])')`, 'the card to close');
  },
  async 'square wires lie flat on the board and match the flat board'(page, id) {
    await squareWires(page, id);
    try {
      await open3d(page);
      await page.until(`__e3d.routes() && __e3d.routes().length === __e3d.wires().length`, 'routed square wires');
      // Flat: the centre line sits one radius up and the jacket reaches one more radius, so nothing
      // is higher than the tallest hump the router asked for plus a diameter. (How tall humps may
      // be is held per board in test/clearance.test.ts.)
      const top = await page.eval<number>(`__e3d.wireTop()`);
      const lift = await page.eval<number>(`__e3d.maxLift()`);
      if (!(top > 0 && top <= lift + 2 * 4 + 0.5)) throw new Error(`the highest jacket reaches y = ${top}; the tallest hump is ${lift}, so it should stay under ${lift + 8.5}`);
      // The page's flat board draws the very same paths.
      const same = await page.eval<boolean>(
        `(() => { const d = [...document.querySelectorAll('#board .wire')].map((g) => g.querySelectorAll('path')[1]?.getAttribute('d')); const want = __e3d.routes().map((p) => p.map(([x, y], k) => (k ? 'L ' : 'M ') + x + ' ' + y).join(' ')); return d.length === want.length && d.every((v, i) => v === want[i]); })()`,
      );
      if (!same) throw new Error('the flat board and the 3D board draw different wire paths');
    } finally {
      await arcWires(id);
    }
  },
  async 'losing the WebGL context closes the editor with a toast, and 3D opens again'(page) {
    await open3d(page);
    await page.eval(`__e3d.loseContext()`);
    await page.until(`!document.querySelector('.ws') && !window.__e3d`, 'the editor to close');
    await page.until(`(document.getElementById('toast')?.textContent ?? '').includes('graphics context')`, 'the context-loss toast');
    await page.until(`document.querySelector('[data-action=view3d]').textContent.trim() === '3D'`, 'the toolbar button to read 3D');
    await open3d(page);
  },
  async 'clicking a jumper selects it and opens the wire card'(page, id) {
    await squareWires(page, id);
    try {
      await open3d(page);
      const hit = await pickableWire(page);
      await page.mouse('mousePressed', hit.x, hit.y);
      await page.mouse('mouseReleased', hit.x, hit.y);
      await page.until(`__e3d.selectedWire() === ${JSON.stringify(hit.key)}`, `the jumper ${hit.key} to be selected`);
      await page.until(`document.querySelector('.ws-wirecard:not([hidden])')?.dataset.wire === ${JSON.stringify(hit.key)}`, 'the wire card');
      await page.until(`__e3d.handles().length > 0`, 'the handles');
      await page.until(`document.querySelector('.ws-legend [data-legend].is-on')?.dataset.legend === ${JSON.stringify(hit.net)}`, 'the click to follow the net softly');
      // F frames the selected wire: the camera glides (the wire moves on screen) and fly mode stays off.
      const before = await page.eval<{ x: number; y: number }>(`__e3d.wireScreen(${hit.index})`);
      await page.key('f', 'KeyF');
      if (await page.eval<boolean>(`document.querySelector('.ws-hint').textContent.startsWith('WASD')`)) throw new Error('F with a wire selected entered fly mode');
      await page.until(`(() => { const a = __e3d.wireScreen(${hit.index}); return a && Math.hypot(a.x - ${before.x}, a.y - ${before.y}) > 2; })()`, 'F to glide the camera to the wire');
      if ((await page.eval<string | null>(`__e3d.selectedWire()`)) !== hit.key) throw new Error('F dropped the wire selection');
      await page.key('Escape', 'Escape');
      await page.until(`__e3d.selectedWire() === null && document.querySelector('.ws-wirecard').hidden`, 'Esc to drop the wire');
      await page.until(`!document.querySelector('.ws-legend [data-legend].is-on')`, 'dropping the wire to release its net');
      if (!(await page.eval<boolean>(`!!document.querySelector('.ws')`))) throw new Error('Esc with a wire selected closed the editor');
    } finally {
      await arcWires(id);
    }
  },
  async 'dragging a segment handle reshapes a wire, undo puts it back, and the shape survives a reload'(page, id) {
    await squareWires(page, id);
    try {
      await open3d(page);
      // Up or down the screen moves a run that lies across the board. Some lanes are refused (a run
      // pulled too far stretches the stub out of its hole over a leg further down the strip, or into a
      // chip), and a short run hemmed in by legs and a chip may have no other lane at all, so the short
      // drags come first and a wire with nowhere to go gives way to the next.
      let hit = await pickableWire(page, true);
      let before = '';
      let shaped = false;
      const tries: string[] = [];
      for (const tried: string[] = []; !shaped && tried.length < 4; ) {
        if (tried.length) hit = await pickableWire(page, true, tried);
        tried.push(hit.key);
        await page.eval(`__e3d.selectWire(${JSON.stringify(hit.key)})`);
        await page.until(`__e3d.handles().some((h) => h.kind === 'segment' && h.index === ${hit.seg})`, 'the segment handle');
        before = await page.eval<string>(`JSON.stringify(__e3d.routes()[${hit.index}])`);
        for (const dy of [35, -35, 70, -70, 110, -110]) {
          const h = await page.eval<{ x: number; y: number }>(`__e3d.handles().find((h) => h.kind === 'segment' && h.index === ${hit.seg})`);
          await page.mouse('mousePressed', h.x, h.y);
          for (let k = 1; k <= 6; k++) await page.mouse('mouseMoved', h.x, h.y + (dy * k) / 6);
          await page.mouse('mouseReleased', h.x, h.y + dy);
          if (await settles(page, `__e3d.wirePath(${JSON.stringify(hit.key)}) !== null`, 3000)) {
            shaped = true;
            break;
          }
          tries.push(`${hit.key} ${dy}: ${await lastToast(page)}`);
        }
      }
      if (!shaped) throw new Error(`no drag of a segment handle kept a shape (${tries.join('; ')})`);
      const after = await page.eval<string>(`JSON.stringify(__e3d.routes()[${hit.index}])`);
      if (after === before) throw new Error('the shape was saved but the wire did not change');
      await page.until(`!document.querySelector('[data-ws=undo]').disabled`, 'Undo to enable');
      await page.key('z', 'KeyZ', 2 /* ctrl */);
      await page.until(`__e3d.wirePath(${JSON.stringify(hit.key)}) === null && JSON.stringify(__e3d.routes()[${hit.index}]) === ${JSON.stringify(before)}`, 'undo to restore the routed shape');
      await page.key('Z', 'KeyZ', 2 | 8 /* ctrl+shift */);
      await page.until(`JSON.stringify(__e3d.routes()[${hit.index}]) === ${JSON.stringify(after)}`, 'redo to shape it again');
      await page.reload();
      await page.until(`document.querySelector('[data-action=view3d]')`, 'the project page after reload');
      await open3d(page);
      await page.until(`JSON.stringify(__e3d.routes()?.[${hit.index}]) === ${JSON.stringify(after)}`, 'the hand shape to survive a reload');
    } finally {
      await arcWires(id);
    }
  },
  async 'double-click adds a bend pair and Delete on a picked bend takes it out'(page, id) {
    await squareWires(page, id);
    try {
      await open3d(page);
      // Double-click a wire itself, halfway along it. A Z there can be refused (a short run hemmed in
      // by legs has no lane to jog to), with a "Can't bend it there" toast; then try the next wire.
      let hit = await pickableWire(page, true);
      let start = 0;
      let added = false;
      const tries: string[] = [];
      for (const tried: string[] = []; !added && tried.length < 4; ) {
        if (tried.length) hit = await pickableWire(page, true, tried);
        tried.push(hit.key);
        await page.eval(`__e3d.selectWire(${JSON.stringify(hit.key)})`);
        await page.until(`__e3d.handles().length > 0`, 'the handles');
        start = await page.eval<number>(`__e3d.routes()[${hit.index}].length - 2`);
        const at = await page.eval<{ x: number; y: number }>(`__e3d.wireScreen(${hit.index})`);
        await page.mouse('mousePressed', at.x, at.y);
        await page.mouse('mouseReleased', at.x, at.y);
        await page.mouse('mousePressed', at.x, at.y, 2);
        await page.mouse('mouseReleased', at.x, at.y, 2);
        await page.until(`__e3d.routes()[${hit.index}].length - 2 === ${start + 2} || (document.getElementById('toast')?.textContent ?? '').startsWith("Can't bend")`, 'a bend pair to be added, or refused', 6000);
        added = await page.eval<boolean>(`__e3d.routes()[${hit.index}].length - 2 === ${start + 2}`);
        if (added) break;
        tries.push(`${hit.key}: ${await lastToast(page)}`);
        // So the next wire's refusal is its own toast, not this one still showing.
        await page.until(`!document.getElementById('toast')`, 'the toast to fade', 8000);
      }
      if (!added) throw new Error(`no double-click added a bend pair (${tries.join('; ')})`);
      // Pick one of the new corners (not one under the wire card, which floats over the canvas) and press
      // Delete. Taking out one corner of a Z slides a run to the other one's lane, which can be refused
      // (the stub out of a hole would then lie over a leg), so each inner corner is tried in turn.
      const corners = await page.eval<{ index: number; x: number; y: number }[]>(
        `(() => { const plan = __e3d.routes()[${hit.index}]; return __e3d.handles().filter((h) => h.kind === 'bend' && h.index > 1 && h.index < plan.length - 2 && document.elementFromPoint(h.x, h.y)?.tagName === 'CANVAS'); })()`,
      );
      if (!corners.length) throw new Error('no inner bend handle to pick');
      const refused: string[] = [];
      for (const { index } of corners) {
        // Handles move when the board is redrawn, so find this one again.
        const corner = await page.eval<{ x: number; y: number } | null>(`__e3d.handles().find((h) => h.kind === 'bend' && h.index === ${index}) ?? null`);
        if (!corner) continue;
        await page.mouse('mousePressed', corner.x, corner.y);
        await page.mouse('mouseReleased', corner.x, corner.y);
        await sleep(300);
        await page.key('Delete', 'Delete');
        if (await settles(page, `__e3d.routes()[${hit.index}].length - 2 === ${start}`, 4000)) break;
        refused.push(`bend ${index}: ${await lastToast(page)}`);
        await page.until(`!document.getElementById('toast')`, 'the toast to fade', 8000);
      }
      if (!(await page.eval<boolean>(`__e3d.routes()[${hit.index}].length - 2 === ${start}`))) throw new Error(`Delete did not take the pair out of ${hit.key} (${refused.join('; ')})`);
    } finally {
      await arcWires(id);
    }
  },
  async "digit keys recolour the selected wire's net"(page, id) {
    await squareWires(page, id);
    let net: string | null = null;
    try {
      await open3d(page);
      const hit = await pickableWire(page);
      net = hit.net;
      await page.eval(`__e3d.selectWire(${JSON.stringify(hit.key)})`);
      await page.until(`__e3d.selectedWire() === ${JSON.stringify(hit.key)}`, 'the wire to be selected');
      await page.key('4', 'Digit4');
      await page.until(`__e3d.netColor(${JSON.stringify(hit.net)})?.toLowerCase() === '#2e9e4f'`, 'the net to turn green');
    } finally {
      if (net) await post(`/api/projects/${id}/layout/colors`, { net, color: null });
      await arcWires(id);
    }
  },
  async 'Tidy all wires, then undo restores every shape'(page, id) {
    await squareWires(page, id);
    let moved: { ref: string; holes: Record<string, Hole> } | null = null;
    try {
      // Each cleanly routed jumper keeps its own route as a hand shape (a real shape the server accepts).
      const first = await get<LayoutDoc>(`/api/projects/${id}/layout`);
      const shaped: string[] = [];
      for (const [i, w] of first.wires.entries()) {
        const r = first.routes?.[i];
        const path = r && !r.warning ? planToPath(w, r.plan) : null;
        if (!path?.points.length) continue;
        await post(`/api/projects/${id}/layout/wire`, { key: wireKey(w), path });
        shaped.push(wireKey(w));
      }
      if (shaped.length < 2) throw new Error(`only ${shaped.length} jumper(s) could be shaped`);
      // Then move a part until one of those shapes is left behind by its jumper (stale).
      let stale: string | null = null;
      const lead2 = first.parts.filter((x) => x.kind === 'lead2').map((x) => x.id);
      outer: for (const ref of lead2) {
        const holes = first.pinHoles[ref];
        if (!holes) continue;
        for (const d of [1, -1, 2, -2]) {
          const next = Object.fromEntries(Object.entries(holes).map(([pin, h]) => [pin, { ...h, col: h.col + d }]));
          if (!(await tryPost(`/api/projects/${id}/layout/move`, { ref, holes: next }))) continue;
          const now = await get<LayoutDoc>(`/api/projects/${id}/layout`);
          const live = new Set(now.wires.map(wireKey));
          stale = shaped.find((k) => !live.has(k)) ?? null;
          if (stale) {
            moved = { ref, holes };
            break outer;
          }
          await post(`/api/projects/${id}/layout/move`, { ref, holes });
        }
      }
      if (!stale) console.log('     (no part move left a shape stale; the stale-shape path was not exercised)');
      // What undo must bring back: every shape whose jumper is still there and laid out from it.
      const doc = await get<LayoutDoc>(`/api/projects/${id}/layout`);
      const side = await get<{ wirePaths: Record<string, WirePath> }>(`/api/projects/${id}/sidecar`);
      const want: Record<string, WirePath> = {};
      doc.wires.forEach((w, i) => {
        const k = wireKey(w);
        if (side.wirePaths[k] && doc.routes?.[i]?.locked) want[k] = side.wirePaths[k];
      });
      const keys = Object.keys(want);
      if (keys.length < 2) throw new Error(`only ${keys.length} live hand shape(s) to tidy`);
      if (stale && !side.wirePaths[stale]) throw new Error('the stale shape was not kept in the sidecar');
      await page.reload();
      await page.until(`document.querySelector('[data-action=view3d]')`, 'the project page');
      await open3d(page);
      await page.eval(`__e3d.selectWire(${JSON.stringify(keys[0])})`);
      await page.until(`document.querySelector('.ws-wirecard:not([hidden]) [data-wire=tidy]')`, 'the Tidy all wires button');
      await page.eval(`document.querySelector('.ws-wirecard [data-wire=tidy]').click()`);
      await page.until(`${JSON.stringify([...keys, ...(stale ? [stale] : [])])}.every((k) => __e3d.wirePath(k) === null)`, 'Tidy to clear every shape', 20000);
      await page.until(`!document.querySelector('[data-ws=undo]').disabled`, 'Undo to enable');
      await page.key('z', 'KeyZ', 2 /* ctrl */);
      await page.until(`Object.entries(${JSON.stringify(want)}).every(([k, p]) => JSON.stringify(__e3d.wirePath(k)) === JSON.stringify(p))`, 'undo to restore every live shape', 30000);
      // Counted as done: it went over to the redo side rather than being dropped.
      await page.until(`!document.querySelector('[data-ws=redo]').disabled`, 'the undone Tidy to be redoable');
      if (stale && (await page.eval<boolean>(`__e3d.wirePath(${JSON.stringify(stale)}) !== null`))) throw new Error('undo put back a stale shape');
      if (await page.eval<boolean>(`(document.getElementById('toast')?.textContent ?? '').includes('could not be put back')`)) throw new Error('undo reported a failure restoring live shapes');
    } finally {
      if (moved) await tryPost(`/api/projects/${id}/layout/move`, moved);
      await arcWires(id);
    }
  },
  async 'dropping a resistor from the tray adds it to the schematic on those holes'(page, id) {
    await open3d(page);
    const before = await page.eval<string[]>(`__e3d.components()`);
    try {
      await armTile(page, 'resistor');
      const spot = await freeSpot(page, 4);
      await page.mouse('mouseMoved', spot.x, spot.y);
      await page.until(`__e3d.ghostCount() > 0`, 'the drop ghost');
      await page.mouse('mousePressed', spot.x, spot.y);
      await page.mouse('mouseReleased', spot.x, spot.y);
      await page.until(`__e3d.components().length > ${before.length}`, 'the resistor to be added', 20000);
      const ref = (await page.eval<string[]>(`__e3d.components()`)).find((r) => !before.includes(r))!;
      // A refused move toasts before the reload that adds the part, so it is on screen now.
      const said = await lastToast(page);
      if (!/^R\d+$/.test(ref)) throw new Error(`the new part is ${ref}, not a resistor`);
      const want = JSON.stringify([`${spot.row}${spot.col}`, `${spot.row}${spot.col + 4}`].sort());
      await page.until(`(() => { const h = __e3d.holes(${JSON.stringify(ref)}); return h && JSON.stringify(Object.values(h).map((x) => x.row + x.col).sort()) === ${JSON.stringify(want)}; })()`, `${ref} on ${want}`, 10000).catch(async (e) => {
        throw new Error(`${(e as Error).message}; it is on ${JSON.stringify(await page.eval(`__e3d.holes(${JSON.stringify(ref)})`))}; toast: ${said}`);
      });
      await page.until(`__e3d.selected() === ${JSON.stringify(ref)}`, `${ref} to be selected`);
      if (await page.eval<boolean>(`!!document.querySelector('.ws-tile.is-armed')`)) throw new Error('the tile stayed armed after the drop');
    } finally {
      await removeAdded(id, before);
    }
  },
  async 'D duplicates the selected resistor to the right'(page, id) {
    await open3d(page);
    const before = await page.eval<string[]>(`__e3d.components()`);
    try {
      const ref = (await page.eval<string[]>(`__e3d.lead2()`)).find((r) => /^R\d+$/.test(r))!;
      await page.eval(`__e3d.select(${JSON.stringify(ref)})`);
      await page.until(`document.querySelector('.ws-card:not([hidden]) input[name=value]')`, 'the card');
      const value = await page.eval<string>(`document.querySelector('.ws-card:not([hidden]) input[name=value]').value`);
      const orig = await page.eval<Record<string, { col: number; row: string }>>(`__e3d.holes(${JSON.stringify(ref)})`);
      await page.eval(`document.activeElement.blur()`);
      await page.key('d', 'KeyD');
      await page.until(`__e3d.components().length > ${before.length}`, 'the copy to be added', 20000);
      const copy = (await page.eval<string[]>(`__e3d.components()`)).find((r) => !before.includes(r))!;
      if (!/^R\d+$/.test(copy)) throw new Error(`the copy is ${copy}, not a resistor`);
      await page.until(`__e3d.selected() === ${JSON.stringify(copy)}`, `${copy} to be selected`);
      await page.until(`(() => { const h = __e3d.holes(${JSON.stringify(copy)}); return !!h && Object.keys(h).length === 2; })()`, `${copy} pinned`, 10000);
      const got = await page.eval<Record<string, { col: number; row: string }>>(`__e3d.holes(${JSON.stringify(copy)})`);
      const pins = Object.keys(orig);
      const k = got[pins[0]].col - orig[pins[0]].col;
      if (k < 1 || k > 20) throw new Error(`the copy is shifted ${k} columns`);
      for (const pin of pins) if (got[pin]?.row !== orig[pin].row || got[pin].col - orig[pin].col !== k) throw new Error(`legs are not ${ref}'s shifted by ${k}: ${JSON.stringify(got)} vs ${JSON.stringify(orig)}`);
      await page.until(`document.querySelector('.ws-card:not([hidden]) input[name=value]')?.value === ${JSON.stringify(value)}`, `the copy's value to be ${value}`);
      const orig2 = await page.eval<string>(`JSON.stringify(__e3d.holes(${JSON.stringify(ref)}))`);
      if (orig2 !== JSON.stringify(orig)) throw new Error(`${ref} moved`);
    } finally {
      await removeAdded(id, before);
    }
  },
  async 'D on a 74LS chip adds a new chip, not a spare gate of it'(page, id) {
    // U1 is a 74LS86 with gate A placed and gates B-D spare: a copy must be a new package.
    await open3d(page);
    const before = await page.eval<string[]>(`__e3d.components()`);
    try {
      const orig = await page.eval<string>(`JSON.stringify(__e3d.holes('U1'))`);
      await page.eval(`__e3d.select('U1')`);
      await page.until(`__e3d.selected() === 'U1'`, 'U1 to be selected');
      await page.eval(`document.activeElement?.blur()`);
      await page.key('d', 'KeyD');
      await page.until(`__e3d.components().length > ${before.length}`, 'the copy to be added', 20000);
      const copy = (await page.eval<string[]>(`__e3d.components()`)).find((r) => !before.includes(r))!;
      if (!/^U\d+$/.test(copy)) throw new Error(`the copy is ${copy}, not a chip`);
      await page.until(`__e3d.selected() === ${JSON.stringify(copy)}`, `${copy} to be selected`);
      const now = await page.eval<string>(`JSON.stringify(__e3d.holes('U1'))`);
      if (now !== orig) throw new Error(`U1 moved: ${now} vs ${orig}`);
    } finally {
      await removeAdded(id, before);
    }
  },
  async 'Esc disarms and clears the ghost'(page) {
    await open3d(page);
    await armTile(page, 'resistor');
    const spot = await freeSpot(page, 4);
    await page.mouse('mouseMoved', spot.x, spot.y);
    await page.until(`__e3d.ghostCount() > 0`, 'the drop ghost');
    await page.key('Escape', 'Escape');
    await page.until(`__e3d.ghostCount() === 0 && !document.querySelector('.ws-tile.is-armed')`, 'Esc to disarm and clear the ghost', 3000);
    if (await page.eval<number>(`__e3d.tintCount()`)) throw new Error('strip tints left behind');
    if (!(await page.eval<boolean>(`!!document.querySelector('.ws')`))) throw new Error('Esc while armed closed the editor');
  },
  async 'a search that hides the armed tile disarms it'(page) {
    await open3d(page);
    const before = await page.eval<string[]>(`__e3d.components()`);
    // Tiles, scrollbar and all, sit inside the tray: nothing is clipped by its fixed height.
    await page.eval(`document.querySelector('.ws-chip[data-group=All]').click()`);
    const fit = await page.eval<{ tray: number; scroll: boolean; worst: number }>(
      `(() => { const t = document.querySelector('.ws-tray'); const r = t.getBoundingClientRect(); const inner = r.top + t.clientTop + t.clientHeight; return { tray: inner, scroll: t.scrollWidth > t.clientWidth, worst: Math.max(...[...t.querySelectorAll('.ws-tile, .ws-tile svg')].map((e) => e.getBoundingClientRect().bottom)) }; })()`,
    );
    if (!fit.scroll) throw new Error('the All group did not overflow the tray, so the scrollbar case was not checked');
    if (fit.worst > fit.tray + 0.5) throw new Error(`tiles reach ${fit.worst}px, below the tray's visible ${fit.tray}px`);
    await page.eval(`document.querySelector('.ws-chip[data-group=Basic]').click()`);
    await armTile(page, 'resistor');
    const spot = await freeSpot(page, 4);
    await page.mouse('mouseMoved', spot.x, spot.y);
    await page.until(`__e3d.ghostCount() > 0`, 'the drop ghost');
    await page.eval(`(() => { const s = document.querySelector('.ws-search'); s.value = 'zzz-no-such-part'; s.dispatchEvent(new Event('input')); })()`);
    await page.until(`document.querySelector('.ws-tray-empty') && !document.querySelector('.ws-tile.is-armed') && __e3d.ghostCount() === 0`, 'the hidden part to disarm and its ghost to go', 3000);
    await page.mouse('mouseMoved', spot.x + 1, spot.y);
    await page.mouse('mousePressed', spot.x, spot.y);
    await page.mouse('mouseReleased', spot.x, spot.y);
    await sleep(1500);
    if ((await page.eval<string[]>(`__e3d.components()`)).length !== before.length) throw new Error('a click after the search added a part');
    if (await page.eval<number>(`__e3d.ghostCount()`)) throw new Error('a ghost came back after the search');
  },
  async 'a refused move after add still leaves the part placed'(page, id) {
    await open3d(page);
    const before = await page.eval<string[]>(`__e3d.components()`);
    try {
      // A chip pointed at row b: it has no default holes there, so nothing is added.
      await armTile(page, '74LS00');
      const spot = await freeSpot(page, 7);
      const b = await page.eval<{ x: number; y: number }>(`__e3d.holeScreen({ col: ${spot.col}, row: 'b' })`);
      await page.mouse('mouseMoved', b.x, b.y);
      await page.until(`__e3d.ghostCount() > 0`, 'a refusing ghost on row b');
      await page.mouse('mousePressed', b.x, b.y);
      await page.mouse('mouseReleased', b.x, b.y);
      await page.until(`document.querySelector('.ws-hint').textContent.startsWith("can't go here")`, 'the hint to say why');
      await sleep(1200);
      if ((await page.eval<string[]>(`__e3d.components()`)).length !== before.length) throw new Error('a chip was added from row b');
      // A chip whose first leg lands on another chip's leg: the verdict refuses it before any add.
      const chip = (await page.eval<string[]>(`__e3d.chips()`))[0];
      const leg = await page.eval<{ col: number; row: string }>(`Object.values(__e3d.holes(${JSON.stringify(chip)})).filter((h) => h.row === 'f').sort((p, q) => p.col - q.col)[0]`);
      const f = await page.eval<{ x: number; y: number }>(`__e3d.holeScreen(${JSON.stringify(leg)})`);
      if ((await page.eval<string>(`document.elementFromPoint(${f.x}, ${f.y})?.tagName`)) !== 'CANVAS') throw new Error(`${chip}'s leg is not on the canvas`);
      await page.mouse('mouseMoved', f.x, f.y);
      await page.until(`document.querySelector('.ws-hint').textContent.includes('taken')`, 'the hint to say the hole is taken');
      await page.mouse('mousePressed', f.x, f.y);
      await page.mouse('mouseReleased', f.x, f.y);
      await sleep(1200);
      if ((await page.eval<string[]>(`__e3d.components()`)).length !== before.length) throw new Error('a chip was added over another chip');
      await page.key('Escape', 'Escape');
      await page.until(`!document.querySelector('.ws-tile.is-armed')`, 'the chip to disarm');
      // The server refusing the move after the add: the part stays, placed by the board.
      await armTile(page, 'resistor');
      const free = await freeSpot(page, 4);
      await page.eval(`__e3d.failNextMove()`);
      await page.mouse('mouseMoved', free.x, free.y);
      await page.mouse('mousePressed', free.x, free.y);
      await page.mouse('mouseReleased', free.x, free.y);
      await page.until(`__e3d.components().length > ${before.length}`, 'the resistor to be added', 20000);
      await page.until(`(document.getElementById('toast')?.textContent ?? '').includes('not at that spot')`, 'the toast to say it went elsewhere', 5000);
    } finally {
      await removeAdded(id, before);
    }
  },
  async 'dragging a tile onto the board adds the part where it is let go'(page, id) {
    await open3d(page);
    const before = await page.eval<string[]>(`__e3d.components()`);
    try {
      await page.until(`document.querySelector('.ws-tile[data-alias=resistor]')`, 'the resistor tile');
      const tile = await page.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector('.ws-tile[data-alias=resistor]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      const spot = await freeSpot(page, 4);
      await page.mouse('mousePressed', tile.x, tile.y);
      for (let k = 1; k <= 8; k++) await page.mouse('mouseMoved', tile.x + ((spot.x - tile.x) * k) / 8, tile.y + ((spot.y - tile.y) * k) / 8);
      await page.until(`__e3d.ghostCount() > 0 && document.querySelector('.ws-drag-ghost')?.hidden`, 'the board ghost in place of the dragged icon');
      await page.mouse('mouseReleased', spot.x, spot.y);
      await page.until(`__e3d.components().length > ${before.length}`, 'the resistor to be added', 20000);
      const ref = (await page.eval<string[]>(`__e3d.components()`)).find((r) => !before.includes(r))!;
      const want = JSON.stringify([`${spot.row}${spot.col}`, `${spot.row}${spot.col + 4}`].sort());
      await page.until(`(() => { const h = __e3d.holes(${JSON.stringify(ref)}); return h && JSON.stringify(Object.values(h).map((x) => x.row + x.col).sort()) === ${JSON.stringify(want)}; })()`, `${ref} on ${want}`, 10000);
      if (await page.eval<boolean>(`!!document.querySelector('.ws-drag-ghost')`)) throw new Error('the dragged icon was left on screen');
    } finally {
      await removeAdded(id, before);
    }
  },
  async 'the wire tool joins an unconnected leg to a net'(page, id) {
    await open3d(page);
    const before = await page.eval<string[]>(`__e3d.components()`);
    try {
      await page.eval(`__e3d.select(null)`);
      // A resistor whose legs sit in empty strips, so both are unconnected. The fixture can be too full for
      // that, and a strip with only a jumper on it or a chip pin the schematic lacks is only found out by
      // trying: a spot that does not work is cleared and the next column is tried.
      const avoid: number[] = [];
      for (;;) {
        await armTile(page, 'resistor');
        const spot = await freeSpot(page, 4, avoid);
        const have = before.length;
        await click(page, spot.x, spot.y);
        await page.until(`__e3d.components().length > ${have}`, 'the resistor to be added', 20000);
        const ref = (await page.eval<string[]>(`__e3d.components()`)).find((r) => !before.includes(r))!;
        await page.until(`(() => { const h = __e3d.holes(${JSON.stringify(ref)}); return h && Object.values(h).some((x) => x.row === ${JSON.stringify(spot.row)} && x.col === ${spot.col}); })()`, `${ref} on its spot`, 10000);
        const pin = await page.eval<string>(`Object.entries(__e3d.holes(${JSON.stringify(ref)})).find(([, h]) => h.col === ${spot.col})[0]`);
        const was = await page.eval<string>(`__e3d.pinNet(${JSON.stringify(ref)}, ${JSON.stringify(pin)})`);
        let refused = '';
        if (!was.startsWith('unconnected-')) refused = `${ref} pin ${pin} starts on ${was}, not unconnected`;
        else {
          const half = /[a-e]/.test(spot.row) ? 'abcde' : 'fghij';
          const ends = await jumperEnds(page, `h.col === ${spot.col} && ${JSON.stringify(half)}.includes(h.row)`, `o.kind === 'connect' && o.pins.some((p) => p.ref === ${JSON.stringify(ref)} && p.pin === ${JSON.stringify(pin)})`);
          // The drop focuses the new part's value box; W typed there would be a value, not the tool.
          await page.eval(`document.activeElement?.blur()`);
          await page.key('w', 'KeyW');
          await page.until(`document.querySelector('[data-ws=wire]').classList.contains('is-on') && document.querySelector('.ws-hint').textContent.startsWith('click a hole to start a jumper')`, 'the wire tool to turn on');
          await click(page, ends.ax, ends.ay);
          await page.mouse('mouseMoved', ends.bx, ends.by);
          await page.until(`__e3d.ghostCount() > 0 && document.querySelector('.ws-hint').textContent.startsWith('joins')`, 'the jumper ghost and a "joins" hint');
          await page.mouse('mousePressed', ends.bx, ends.by);
          await page.mouse('mouseReleased', ends.bx, ends.by);
          await page.until(`(document.getElementById('toast')?.textContent ?? '') !== ''`, 'a toast after the jumper', 20000);
          const said = await lastToast(page);
          if (said.startsWith('joined')) {
            if ((await page.eval<string>(`__e3d.pinNet(${JSON.stringify(ref)}, ${JSON.stringify(pin)})`)).startsWith('unconnected-')) throw new Error(`${ref} pin ${pin} did not join a net`);
            if (!(await page.eval<boolean>(`document.querySelector('[data-ws=wire]').classList.contains('is-on')`))) throw new Error('the wire tool turned off after a jumper');
            await page.key('Escape', 'Escape');
            await page.until(`!document.querySelector('[data-ws=wire]').classList.contains('is-on')`, 'Esc to turn the tool off');
            if (!(await page.eval<boolean>(`!!document.querySelector('.ws')`))) throw new Error('Esc with the wire tool on closed the editor');
            return;
          }
          refused = said;
          await page.key('Escape', 'Escape');
          await page.until(`!document.querySelector('[data-ws=wire]').classList.contains('is-on')`, 'Esc to turn the tool off');
        }
        if (avoid.length >= 8) throw new Error(refused);
        avoid.push(spot.col);
        await removeAdded(id, before);
        await page.until(`__e3d.components().length === ${before.length}`, 'the stray resistor to go', 20000);
      }
    } finally {
      await removeAdded(id, before);
    }
  },
  async 'the wire tool refuses to join two nets'(page) {
    await open3d(page);
    const ends = await jumperEnds(page, 'true', `o.kind === 'refuse' && o.reason.includes('Merge nets in the schematic')`);
    await page.eval(`(document.querySelector('[data-ws=wire]').click(), window.__doc0 = __e3d.doc(), 0)`);
    await page.until(`document.querySelector('[data-ws=wire]').classList.contains('is-on')`, 'the Wire button to turn the tool on');
    await click(page, ends.ax, ends.ay);
    await page.mouse('mouseMoved', ends.bx, ends.by);
    await page.until(`__e3d.ghostCount() > 0 && document.querySelector('.ws-hint').textContent.includes('Merge nets')`, 'a refusing ghost and hint');
    await page.mouse('mousePressed', ends.bx, ends.by);
    await page.mouse('mouseReleased', ends.bx, ends.by);
    await page.until(`(document.getElementById('toast')?.textContent ?? '').includes('Merge nets in the schematic')`, 'the refusal toast', 5000);
    await sleep(1500);
    if (!(await page.eval<boolean>(`__e3d.doc() === window.__doc0`))) throw new Error('a refused jumper changed the doc');
    if (await page.eval<number>(`__e3d.ghostCount()`)) throw new Error('the ghost stayed after the refusal');
    // Right-click drops a jumper in progress; the tool stays on.
    await click(page, ends.ax, ends.ay);
    await page.mouse('mouseMoved', ends.bx, ends.by);
    await page.until(`__e3d.ghostCount() > 0`, 'the ghost again');
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ends.bx, y: ends.by, button: 'right', buttons: 2, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ends.bx, y: ends.by, button: 'right', buttons: 0, clickCount: 1 });
    await page.until(`__e3d.ghostCount() === 0`, 'right-click to cancel the jumper', 3000);
    if (!(await page.eval<boolean>(`document.querySelector('[data-ws=wire]').classList.contains('is-on')`))) throw new Error('right-click turned the tool off');
  },
  async 'Ctrl+W and Alt+W are left to the browser, not the wire tool'(page) {
    await open3d(page);
    await page.eval(`document.activeElement?.blur()`);
    for (const mod of ['ctrlKey', 'altKey', 'metaKey']) {
      // A synthetic event: a real Ctrl+W would close the tab if it reached the browser.
      const prevented = await page.eval<boolean>(`(() => { const e = new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ${mod}: true, bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return e.defaultPrevented; })()`);
      await sleep(100);
      if (await page.eval<boolean>(`document.querySelector('[data-ws=wire]').classList.contains('is-on')`)) throw new Error(`${mod} + W turned the wire tool on`);
      if (prevented) throw new Error(`${mod} + W was preventDefault-ed`);
    }
    await page.key('w', 'KeyW');
    await page.until(`document.querySelector('[data-ws=wire]').classList.contains('is-on')`, 'plain W to turn the tool on');
    await page.key('Escape', 'Escape');
  },
  async 'the wire tool and the tray take turns'(page) {
    await open3d(page);
    await armTile(page, 'resistor');
    await page.key('w', 'KeyW');
    await page.until(`document.querySelector('[data-ws=wire]').classList.contains('is-on') && !document.querySelector('.ws-tile.is-armed')`, 'W to disarm the tray part');
    await armTile(page, 'resistor');
    await page.until(`!document.querySelector('[data-ws=wire]').classList.contains('is-on')`, 'arming a part to turn the wire tool off');
    await page.key('Escape', 'Escape');
  },
};

void main();

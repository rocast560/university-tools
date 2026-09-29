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
async function settles(page: CDP, expression: string, ms: number) {
  return page.until(expression, '', ms).then(() => true, () => false);
}

/** Square wires and no hand shapes, set on the server and picked up by a fresh page. */
async function squareWires(page: CDP, id: string) {
  const post = (url: string, body: unknown) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post(`/api/projects/${id}/layout/options`, { wireStyle: 'orthogonal' });
  await post(`/api/projects/${id}/layout/wire`, { key: '*', path: null });
  await page.reload();
  await page.until(`document.querySelector('[data-action=view3d]')`, 'the project page');
}

const SCENARIOS: Record<string, (page: CDP, id: string) => Promise<void>> = {
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
    await open3d(page);
    await page.until(`__e3d.routes() && __e3d.routes().length === __e3d.wires().length`, 'routed square wires');
    // Flat: the centre line sits one radius up, a hump adds one diameter, the jacket one more radius.
    const top = await page.eval<number>(`__e3d.wireTop()`);
    if (!(top > 0 && top <= 4 + 8 + 4 + 0.5)) throw new Error(`the highest jacket reaches y = ${top}; flat wires stay under 16.5`);
    // The page's flat board draws the very same paths.
    const same = await page.eval<boolean>(
      `(() => { const d = [...document.querySelectorAll('#board .wire')].map((g) => g.querySelectorAll('path')[1]?.getAttribute('d')); const want = __e3d.routes().map((p) => p.map(([x, y], k) => (k ? 'L ' : 'M ') + x + ' ' + y).join(' ')); return d.length === want.length && d.every((v, i) => v === want[i]); })()`,
    );
    if (!same) throw new Error('the flat board and the 3D board draw different wire paths');
  },
  async 'losing the WebGL context closes the editor with a toast, and 3D opens again'(page) {
    await open3d(page);
    await page.eval(`__e3d.loseContext()`);
    await page.until(`!document.querySelector('.ws') && !window.__e3d`, 'the editor to close');
    await page.until(`(document.getElementById('toast')?.textContent ?? '').includes('graphics context')`, 'the context-loss toast');
    await page.until(`document.querySelector('[data-action=view3d]').textContent.trim() === '3D'`, 'the toolbar button to read 3D');
    await open3d(page);
  },
};

void main();

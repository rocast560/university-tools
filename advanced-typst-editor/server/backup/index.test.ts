import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerEvent } from '../../src/types';
import { createEventBus } from '../events';
import { createSettingsStore } from '../settings';
import { createWorkspaceService } from '../service';
import { tmpDir, rmDir, put } from '../test-util';
import { createBackup } from './index';
import { MARKER_FILE } from './mirror';

const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => { for (const s of stops.splice(0)) s(); for (const d of dirs.splice(0)) rmDir(d); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(clock = { t: 1_000_000 }) {
  const dataDir = tmpDir(); dirs.push(dataDir);
  const bus = createEventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const settings = createSettingsStore(dataDir);
  const now = () => clock.t;
  const service = createWorkspaceService({ settings, bus, watcher: null, dataDir, workspacesDir: path.join(dataDir, 'workspaces'), template: '= T', now });
  const backup = createBackup({ settings, service, bus, dataDir, workspacesDir: path.join(dataDir, 'workspaces'), now, version: '0.1.0', quietMs: 50, maxWaitMs: 200 });
  stops.push(() => backup.stop());
  return { dataDir, bus, events, settings, service, backup, clock };
}

describe('backup', () => {
  it('validates destinations: absolute, claimable', () => {
    const { backup } = setup();
    const dest = tmpDir(); dirs.push(dest);
    expect(() => backup.configure({ destinations: [{ path: 'relative', mirror: true, snapshots: true }] })).toThrow(/absolute/);
    put(dest, 'photo.jpg', 'x');
    expect(() => backup.configure({ destinations: [{ path: dest, mirror: true, snapshots: true }] })).toThrow(/already has files/);
    fs.unlinkSync(path.join(dest, 'photo.jpg'));
    const s = backup.configure({ destinations: [{ path: dest, mirror: true, snapshots: false }], snapshotIntervalMin: 5, keepSnapshots: 3 });
    expect(s.destinations[0]).toMatchObject({ path: path.resolve(dest), mirror: true, snapshots: false });
    expect(s.destinations[0]!.id).toBeTruthy();
    expect(s.snapshotIntervalMin).toBe(5);
    expect(fs.existsSync(path.join(dest, MARKER_FILE))).toBe(false); // nothing runs until scheduled
  });

  it('mirrors after writes settle and snapshots on run()', async () => {
    const { backup, service, events } = setup();
    const dest = tmpDir(); dirs.push(dest);
    backup.configure({ destinations: [{ path: dest, mirror: true, snapshots: true }] });
    backup.start();
    const w = service.create({ name: 'Rep', group: 'G', source: '= one' });
    service.writeFile(w.id, 'main.typ', Buffer.from('= two'), 'c');
    await sleep(400);
    expect(fs.readFileSync(path.join(dest, 'G', 'Rep', 'main.typ'), 'utf8')).toBe('= two');
    expect(backup.state().lastMirrorFiles).toBeGreaterThan(0);
    expect(backup.state().lastSnapshotAt).not.toBeNull();
    const s = await backup.run();
    expect(s.lastSnapshotAt).not.toBeNull();
    expect(backup.listSnapshots(s.destinations[0]!.id)).toHaveLength(1);
    expect(events.some((e) => e.type === 'backup.state')).toBe(true);
  });

  it('takes a timed snapshot only when the state changed', async () => {
    const { backup, service, clock } = setup();
    const dest = tmpDir(); dirs.push(dest);
    backup.configure({ destinations: [{ path: dest, mirror: false, snapshots: true }], snapshotIntervalMin: 1 });
    backup.start();
    service.create({ name: 'A', group: null, source: '= a' });
    await sleep(300);
    const id = backup.state().destinations[0]!.id;
    expect(backup.listSnapshots(id)).toHaveLength(1); // first ever snapshot is immediate
    clock.t += 61_000;
    await backup.tick();
    expect(backup.listSnapshots(id)).toHaveLength(1); // nothing changed
    fs.writeFileSync(path.join(service.list()[0]!.path, 'main.typ'), '= b');
    clock.t += 61_000;
    await backup.tick();
    expect(backup.listSnapshots(id)).toHaveLength(2);
  });

  it('isolates a failing destination so the others still mirror and snapshot', async () => {
    const { backup, service } = setup();
    const dest1 = tmpDir(); dirs.push(dest1);
    const dest2 = tmpDir(); dirs.push(dest2);
    const cfgd = backup.configure({
      destinations: [
        { path: dest1, mirror: true, snapshots: true },
        { path: dest2, mirror: true, snapshots: true },
      ],
    });
    put(dest1, 'photo.jpg', 'x'); // make dest1 non-claimable after configure
    const w = service.create({ name: 'Rep', group: null, source: '= one' });
    const s = await backup.run();
    expect(fs.readFileSync(path.join(dest2, w.name, 'main.typ'), 'utf8')).toBe('= one');
    expect(backup.listSnapshots(cfgd.destinations[1]!.id)).toHaveLength(1);
    expect(s.lastError).toContain(path.resolve(dest1));
    expect(s.lastError).toContain('already has files');
    expect(s.lastSnapshotAt).not.toBeNull();
  });

  it('coalesces a schedule() that arrives during an in-flight run()', async () => {
    const { backup, service } = setup();
    const dest = tmpDir(); dirs.push(dest);
    backup.configure({ destinations: [{ path: dest, mirror: true, snapshots: true }] });
    service.create({ name: 'A', group: null, source: '= a' });
    const p = backup.run();
    backup.schedule();
    await p;
    await sleep(150); // let the debounced pass armed by schedule() also settle
    expect(backup.state().running).toBe(false);
    expect(backup.state().lastSnapshotAt).not.toBeNull();
  });

  it('restores through a destination and reports the count', async () => {
    const { backup, service, dataDir } = setup();
    const dest = tmpDir(); dirs.push(dest);
    backup.configure({ destinations: [{ path: dest, mirror: false, snapshots: true }] });
    const w = service.create({ name: 'A', group: null, source: '= snap' });
    const s = await backup.run();
    fs.writeFileSync(path.join(w.path, 'main.typ'), '= later');
    const r = await backup.restore(s.destinations[0]!.id, backup.listSnapshots(s.destinations[0]!.id)[0]!.name);
    expect(r.restored).toBe(1);
    expect(fs.readFileSync(path.join(w.path, 'main.typ'), 'utf8')).toBe('= snap');
    expect(fs.readdirSync(dataDir).some((n) => n.startsWith('pre-restore-'))).toBe(true);
  });
});

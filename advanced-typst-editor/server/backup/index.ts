import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BackupDestination, BackupState, SnapshotInfo } from '../../src/types';
import type { EventBus } from '../events';
import { HttpError } from '../http';
import type { BackupApi } from '../router';
import type { WorkspaceService } from '../service';
import type { SettingsStore } from '../settings';
import { openWorkspace } from '../workspace';
import { claimable, planMirror, runMirror, type MirrorItem } from './mirror';
import { listSnapshots, pruneSnapshots, restoreSnapshot, stateDigest, writeSnapshot } from './snapshot';

export interface BackupDeps {
  settings: SettingsStore;
  service: WorkspaceService;
  bus: EventBus;
  dataDir: string;
  workspacesDir: string;
  now?: () => number;
  version: string;
  quietMs?: number;
  maxWaitMs?: number;
  log?: (...a: unknown[]) => void;
}

export interface Backup extends BackupApi {
  schedule(): void;
  start(): void;
  stop(): void;
  /** Run the snapshot-interval check once (the timer calls this every 60 s). */
  tick(): Promise<void>;
}

export function createBackup(deps: BackupDeps): Backup {
  const now = deps.now ?? (() => Date.now());
  const quietMs = deps.quietMs ?? 1500;
  const maxWaitMs = deps.maxWaitMs ?? 10_000;
  const log = deps.log ?? ((...a: unknown[]) => console.error('[backup]', ...a));

  let running = false;
  let rerun = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let deadline: number | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let lastRunAt: number | null = null;
  let lastMirrorFiles: number | null = null;
  let lastSnapshotAt: number | null = null;
  let lastSnapshotDigest: string | null = null;
  let lastError: string | null = null;

  const cfg = () => deps.settings.get().backup;
  const state = (): BackupState => ({ ...cfg(), running: running || quietTimer !== null, lastRunAt, lastMirrorFiles, lastSnapshotAt, lastError });
  const publish = () => deps.bus.emit({ type: 'backup.state', state: state() });

  const items = (): MirrorItem[] =>
    deps.service.list().filter((w) => w.status === 'ok').map((w) => ({ entry: w, files: openWorkspace(w.path).listFiles() }));

  const dest = (id: string): BackupDestination => {
    const d = cfg().destinations.find((x) => x.id === id);
    if (!d) throw new HttpError(404, `no backup destination ${id}`);
    return d;
  };

  const doMirror = (its: MirrorItem[]) => {
    const plan = planMirror(its);
    let files = 0;
    for (const d of cfg().destinations) {
      if (!d.mirror) continue;
      files += runMirror(d.path, plan, { now, log }).written;
    }
    lastMirrorFiles = files;
  };
  const doSnapshot = (its: MirrorItem[]) => {
    const c = cfg();
    let any = false;
    for (const d of c.destinations) {
      if (!d.snapshots) continue;
      writeSnapshot(d.path, its, { now: now(), version: deps.version, destinationId: d.id });
      pruneSnapshots(d.path, c.keepSnapshots);
      any = true;
    }
    if (any) { lastSnapshotAt = now(); lastSnapshotDigest = stateDigest(its); }
  };

  const runOnce = async (opts: { snapshot: boolean }) => {
    if (running) { rerun = true; return; }
    running = true;
    try {
      do {
        rerun = false;
        const its = items();
        doMirror(its);
        const due = lastSnapshotAt === null || now() - lastSnapshotAt >= cfg().snapshotIntervalMin * 60_000;
        if (opts.snapshot || (due && stateDigest(its) !== lastSnapshotDigest)) doSnapshot(its);
        lastRunAt = now();
        lastError = null;
      } while (rerun);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log('run failed:', lastError);
    } finally {
      running = false;
      publish();
    }
  };

  const schedule = () => {
    if (cfg().destinations.length === 0) return;
    const t = now();
    if (deadline === null) deadline = t + maxWaitMs;
    if (quietTimer) clearTimeout(quietTimer);
    const wait = Math.max(0, Math.min(quietMs, deadline - t));
    quietTimer = setTimeout(() => { quietTimer = null; deadline = null; void runOnce({ snapshot: false }); }, wait);
    (quietTimer as unknown as { unref?: () => void }).unref?.();
  };

  return {
    state,
    schedule,
    configure(patch) {
      const cur = cfg();
      let destinations = cur.destinations;
      if ('destinations' in patch) {
        if (!Array.isArray(patch.destinations)) throw new HttpError(400, 'destinations must be an array');
        destinations = patch.destinations.map((raw) => {
          const r = raw as Partial<BackupDestination>;
          if (typeof r.path !== 'string' || !path.isAbsolute(r.path)) throw new HttpError(400, 'each destination needs an absolute path');
          const p = path.resolve(r.path);
          const known = cur.destinations.find((d) => d.id === r.id || path.resolve(d.path).toLowerCase() === p.toLowerCase());
          try { fs.mkdirSync(p, { recursive: true }); } catch (err) { throw new HttpError(400, `cannot create ${p}: ${err instanceof Error ? err.message : String(err)}`); }
          if (!claimable(p)) throw new HttpError(409, `${p} already has files this app did not write; pick an empty folder or one used for a previous backup`);
          return { id: known?.id ?? crypto.randomUUID(), path: p, mirror: r.mirror !== false, snapshots: r.snapshots !== false };
        });
      }
      deps.settings.update((s) => ({
        ...s,
        backup: {
          destinations,
          snapshotIntervalMin: typeof patch.snapshotIntervalMin === 'number' ? patch.snapshotIntervalMin : cur.snapshotIntervalMin,
          keepSnapshots: typeof patch.keepSnapshots === 'number' ? patch.keepSnapshots : cur.keepSnapshots,
        },
      }));
      lastError = null;
      publish();
      return state();
    },
    async run() { await runOnce({ snapshot: true }); return state(); },
    listSnapshots: (destinationId) => listSnapshots(dest(destinationId).path, destinationId),
    async restore(destinationId, name) {
      if (!/^typst-snapshot-\d{8}-\d{6}\.zip$/.test(name)) throw new HttpError(400, 'bad snapshot name');
      const zipPath = path.join(dest(destinationId).path, 'snapshots', name);
      const out = await restoreSnapshot({ zipPath, dataDir: deps.dataDir, workspacesDir: deps.workspacesDir, settings: deps.settings, now });
      deps.service.boot();
      deps.bus.emit({ type: 'workspaces.changed' });
      return out;
    },
    async tick() { if (cfg().destinations.some((d) => d.snapshots)) await runOnce({ snapshot: false }); },
    start() {
      unsubscribe ??= deps.bus.subscribe((ev) => { if (ev.type === 'workspace.changed' || ev.type === 'workspaces.changed') schedule(); });
      tickTimer ??= setInterval(() => void this.tick(), 60_000);
      (tickTimer as unknown as { unref?: () => void }).unref?.();
      if (cfg().destinations.length) schedule();
    },
    stop() {
      unsubscribe?.(); unsubscribe = null;
      if (tickTimer) clearInterval(tickTimer); tickTimer = null;
      if (quietTimer) clearTimeout(quietTimer); quietTimer = null; deadline = null;
    },
  };
}

export type { SnapshotInfo };

// Asks connected windows for a WebGL snapshot; the first answer wins, silence means fallback.

import { newId } from '../src/chem/species';

export interface SnapshotTarget { send(msg: unknown): void }

export class SnapshotBroker {
  private readonly pending = new Map<string, { resolve: (png: Uint8Array | null) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly windows: () => SnapshotTarget[], private readonly timeoutMs = 3000) {}

  request(sceneId: string, width: number, height: number): Promise<Uint8Array | null> {
    const targets = this.windows();
    if (targets.length === 0) return Promise.resolve(null);
    const id = newId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      for (const w of targets) w.send({ type: 'snapshot_request', id, sceneId, width, height });
    });
  }

  resolve(id: string, pngBase64: string | null): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(pngBase64 ? new Uint8Array(Buffer.from(pngBase64, 'base64')) : null);
    return true;
  }
}

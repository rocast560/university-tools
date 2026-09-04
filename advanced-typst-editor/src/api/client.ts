import type { BackupState, CompileResult, DirListing, McpStatus, RedactionDefaults, SnapshotInfo, TypstAsset, TypstAssetKind, WorkspaceDetail, WorkspaceEntry, WorkspaceStatus, AssetFolder } from '@/types';

export const CLIENT_ID: string = (() => {
  try {
    const k = 'tfs-client-id';
    let v = sessionStorage.getItem(k);
    if (!v) { v = Math.random().toString(36).slice(2, 10); sessionStorage.setItem(k, v); }
    return v;
  } catch { return Math.random().toString(36).slice(2, 10); }
})();

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

async function req<T>(method: string, url: string, body?: unknown, raw = false): Promise<T> {
  const headers: Record<string, string> = { 'x-client-id': CLIENT_ID };
  let payload: BodyInit | undefined;
  if (body instanceof Blob || body instanceof Uint8Array) { headers['content-type'] = 'application/octet-stream'; payload = body as BodyInit; }
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(url, { method, headers, body: payload });
  if (!res.ok) {
    let msg = `${method} ${url} failed (${res.status})`;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* keep */ }
    throw new ApiError(res.status, msg);
  }
  if (raw) return (await res.arrayBuffer()) as unknown as T;
  return (res.status === 204 ? null : await res.json()) as T;
}
/**
 * Ceiling for a `keepalive` request body. Browsers cap the combined body of
 * in-flight keepalive requests (~64 KiB in Chromium) and reject anything over
 * it outright -- which would lose the very save keepalive exists to guarantee.
 * A document past this size falls back to an ordinary request on unload: not
 * guaranteed to land, but strictly better than one guaranteed to fail.
 */
const KEEPALIVE_MAX_BYTES = 60_000;

const enc = encodeURIComponent;
const wsUrl = (id: string) => `/api/workspaces/${enc(id)}`;
const fileUrl = (id: string, p: string) => `${wsUrl(id)}/files/${p.split('/').map(enc).join('/')}`;
const assetUrl = (id: string, a: string) => `${wsUrl(id)}/assets/${a.split('/').map(enc).join('/')}`;

export const api = {
  health: () => req<{ ok: boolean }>('GET', '/api/health'),
  listWorkspaces: () => req<{ workspaces: WorkspaceStatus[] }>('GET', '/api/workspaces').then((r) => r.workspaces),
  listGroups: () => req<{ groups: string[] }>('GET', '/api/groups').then((r) => r.groups),
  createGroup: (name: string) => req<{ groups: string[] }>('POST', '/api/groups', { name }).then((r) => r.groups),
  renameGroup: (name: string, newName: string) => req<{ groups: string[] }>('PATCH', `/api/groups/${enc(name)}`, { name: newName }).then((r) => r.groups),
  deleteGroup: (name: string) => req<{ groups: string[] }>('DELETE', `/api/groups/${enc(name)}`).then((r) => r.groups),
  createWorkspace: (input: { name: string; group?: string | null; source?: string }) => req<{ workspace: WorkspaceEntry }>('POST', '/api/workspaces', input).then((r) => r.workspace),
  openFolder: (path: string, name?: string) => req<{ workspace: WorkspaceEntry }>('POST', '/api/workspaces/open', { path, name }).then((r) => r.workspace),
  patchWorkspace: (id: string, patch: { name?: string; group?: string | null }) => req<{ workspace: WorkspaceEntry }>('PATCH', wsUrl(id), patch).then((r) => r.workspace),
  deleteWorkspace: (id: string) => req<{ ok: true }>('DELETE', wsUrl(id)),
  getWorkspace: (id: string) => req<WorkspaceDetail>('GET', wsUrl(id)),
  async readText(id: string, path: string): Promise<{ text: string; etag: string }> {
    const res = await fetch(fileUrl(id, path), { headers: { 'x-client-id': CLIENT_ID } });
    if (!res.ok) throw new ApiError(res.status, `cannot read ${path}`);
    return { text: await res.text(), etag: res.headers.get('etag') ?? '' };
  },
  readBytes: (id: string, path: string) => req<ArrayBuffer>('GET', fileUrl(id, path), undefined, true).then((b) => new Uint8Array(b)),
  writeText: (id: string, path: string, text: string, keepalive = false) => {
    const body = new TextEncoder().encode(text);
    return fetch(fileUrl(id, path), {
      method: 'PUT',
      headers: { 'x-client-id': CLIENT_ID, 'content-type': 'application/octet-stream' },
      body,
      keepalive: keepalive && body.byteLength <= KEEPALIVE_MAX_BYTES,
    }).then((r) => { if (!r.ok) throw new ApiError(r.status, `save failed (${r.status})`); });
  },
  deleteFile: (id: string, path: string) => req<{ ok: true }>('DELETE', fileUrl(id, path)),
  uploadAsset: (id: string, file: Blob, opts: { kind: TypstAssetKind; filename: string; folder: string | null; family?: string | null }) => {
    const qs = new URLSearchParams({ kind: opts.kind, filename: opts.filename });
    if (opts.folder) qs.set('folder', opts.folder);
    if (opts.family) qs.set('family', opts.family);
    return req<{ asset: TypstAsset }>('POST', `${wsUrl(id)}/assets?${qs}`, file).then((r) => r.asset);
  },
  patchAsset: (id: string, assetId: string, patch: Record<string, unknown>) => req<{ asset: TypstAsset }>('PATCH', assetUrl(id, assetId), patch).then((r) => r.asset),
  renameAsset: (id: string, assetId: string, stem: string) => req<{ asset: TypstAsset; references: number }>('PATCH', assetUrl(id, assetId), { stem }),
  moveAsset: (id: string, assetId: string, folder: string | null) => req<{ asset: TypstAsset; references: number }>('PATCH', assetUrl(id, assetId), { folder }),
  deleteAsset: (id: string, assetId: string) => req<{ ok: true }>('DELETE', assetUrl(id, assetId)),
  createFolder: (id: string, path: string) => req<{ folder: AssetFolder }>('POST', `${wsUrl(id)}/asset-folders`, { path }).then((r) => r.folder),
  renameFolder: (id: string, path: string, newPath: string) => req<{ references: number }>('PATCH', `${wsUrl(id)}/asset-folders`, { path, newPath }),
  deleteFolder: (id: string, path: string) => req<{ references: number; moved: number }>('DELETE', `${wsUrl(id)}/asset-folders?path=${enc(path)}`),
  compile: (id: string, file?: string) => req<CompileResult>('POST', `${wsUrl(id)}/compile`, { file }),
  exportPdfTo: (id: string, to: string, file?: string) => req<{ path: string; baked: number }>('POST', `${wsUrl(id)}/export-pdf`, { to, file }),
  getSettings: () => req<{ typstCli: string | null; redaction: RedactionDefaults }>('GET', '/api/settings'),
  patchSettings: (patch: { typstCli?: string | null; redaction?: Partial<RedactionDefaults> }) => req<{ typstCli: string | null; redaction: RedactionDefaults }>('PATCH', '/api/settings', patch),
  getBackup: () => req<{ backup: BackupState }>('GET', '/api/backup').then((r) => r.backup),
  patchBackup: (patch: Record<string, unknown>) => req<{ backup: BackupState }>('PATCH', '/api/backup', patch).then((r) => r.backup),
  runBackup: () => req<{ backup: BackupState }>('POST', '/api/backup/run').then((r) => r.backup),
  listSnapshots: (destination: string) => req<{ snapshots: SnapshotInfo[] }>('GET', `/api/backup/snapshots?destination=${enc(destination)}`).then((r) => r.snapshots),
  restoreSnapshot: (destination: string, snapshot: string) => req<{ restored: number }>('POST', '/api/backup/restore', { destination, snapshot }),
  browse: (path: string) => req<DirListing>('GET', `/api/fs/browse?path=${enc(path)}`),
  mcpStatus: () => req<McpStatus>('GET', '/api/mcp/status'),
};

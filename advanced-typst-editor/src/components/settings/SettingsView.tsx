import { useEffect, useState } from 'react';
import { X, Play, RotateCcw, Trash2, Plus } from 'lucide-react';
import { api } from '@/api/client';
import { useAppStore } from '@/stores';
import { Portal } from '@/components/ui/Portal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { FolderBrowserDialog } from '@/components/ui/FolderBrowserDialog';
import type { BackupDestination, SnapshotInfo } from '@/types';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mb-6"><h2 className="mb-2 text-[11px] font-bold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">{title}</h2>{children}</section>;
}

export function SettingsView() {
  const close = () => useAppStore.getState().setSettingsOpen(false);
  const backup = useAppStore((s) => s.backup);
  const mcp = useAppStore((s) => s.mcp);
  const redaction = useAppStore((s) => s.redaction);
  const typstCli = useAppStore((s) => s.typstCli);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const loadBackup = useAppStore((s) => s.loadBackup);
  const [adding, setAdding] = useState(false);
  const [snapshots, setSnapshots] = useState<Record<string, SnapshotInfo[]>>({});
  const [restore, setRestore] = useState<SnapshotInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cli, setCli] = useState(typstCli ?? '');

  useEffect(() => { void loadBackup(); }, [loadBackup]);
  useEffect(() => {
    if (!backup) return;
    for (const d of backup.destinations) if (d.snapshots) void api.listSnapshots(d.id).then((list) => setSnapshots((s) => ({ ...s, [d.id]: list }))).catch(() => {});
  }, [backup]);

  const patch = async (p: Record<string, unknown>, label: string) => {
    setBusy(label); setError(null);
    try { useAppStore.setState({ backup: await api.patchBackup(p) }); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const setDest = (next: BackupDestination[]) => patch({ destinations: next }, 'destinations');

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={close}>
        <div className="flex h-[80vh] w-[760px] flex-col rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--popover))] shadow-xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-4 py-2">
            <span className="text-sm font-semibold">Settings</span>
            <button type="button" onClick={close} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><X size={14} /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-xs">
            {error && <div className="mb-3 rounded-md border border-[hsl(var(--status-red))]/40 bg-[hsl(var(--status-red))]/10 px-3 py-1.5 text-[hsl(var(--status-red))]">{error}</div>}

            <Section title="Backups">
              <p className="mb-2 text-[hsl(var(--muted-foreground))]">Each destination gets a live mirror of every workspace (nothing is ever deleted there; stale files move to <code>_trash/</code>) and timed zip snapshots under <code>snapshots/</code>. A destination must be empty or one this app already uses.</p>
              {backup?.destinations.map((d) => (
                <div key={d.id} className="mb-2 rounded-md border border-[hsl(var(--border))] p-2">
                  <div className="flex items-center gap-3">
                    <span className="flex-1 truncate font-mono" title={d.path}>{d.path}</span>
                    <label className="flex items-center gap-1"><input type="checkbox" checked={d.mirror} onChange={(e) => void setDest(backup.destinations.map((x) => (x.id === d.id ? { ...x, mirror: e.target.checked } : x)))} />Mirror</label>
                    <label className="flex items-center gap-1"><input type="checkbox" checked={d.snapshots} onChange={(e) => void setDest(backup.destinations.map((x) => (x.id === d.id ? { ...x, snapshots: e.target.checked } : x)))} />Snapshots</label>
                    <button type="button" title="Remove destination (files stay)" onClick={() => void setDest(backup.destinations.filter((x) => x.id !== d.id))} className="rounded p-1 hover:bg-[hsl(var(--accent))]"><Trash2 size={13} /></button>
                  </div>
                  {d.snapshots && (
                    <div className="mt-2 max-h-32 overflow-auto rounded bg-[hsl(var(--muted))]/40 p-1">
                      {(snapshots[d.id] ?? []).map((s) => (
                        <div key={s.name} className="flex items-center gap-2 px-1 py-0.5">
                          <span className="flex-1 font-mono">{s.name}</span>
                          <span className="text-[hsl(var(--muted-foreground))]">{s.workspaces} ws · {(s.bytes / 1e6).toFixed(1)} MB</span>
                          <button type="button" onClick={() => setRestore(s)} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[hsl(var(--accent))]"><RotateCcw size={11} />Restore</button>
                        </div>
                      ))}
                      {(snapshots[d.id] ?? []).length === 0 && <div className="px-1 text-[hsl(var(--muted-foreground))]">No snapshots yet.</div>}
                    </div>
                  )}
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1 rounded-md border border-[hsl(var(--border))] px-2 py-1 hover:bg-[hsl(var(--accent))]"><Plus size={12} />Add destination</button>
                <label className="flex items-center gap-1">Snapshot every <input type="number" min={1} className="w-16 rounded border border-[hsl(var(--input))] bg-transparent px-1" defaultValue={backup?.snapshotIntervalMin ?? 60} onBlur={(e) => void patch({ snapshotIntervalMin: Number(e.target.value) }, 'interval')} /> min</label>
                <label className="flex items-center gap-1">keep last <input type="number" min={1} className="w-16 rounded border border-[hsl(var(--input))] bg-transparent px-1" defaultValue={backup?.keepSnapshots ?? 30} onBlur={(e) => void patch({ keepSnapshots: Number(e.target.value) }, 'keep')} /></label>
                <button type="button" disabled={!backup?.destinations.length || busy === 'run'} onClick={async () => { setBusy('run'); try { useAppStore.setState({ backup: await api.runBackup() }); } finally { setBusy(null); } }} className="ml-auto flex items-center gap-1 rounded-md bg-[hsl(var(--primary))] px-2 py-1 text-[hsl(var(--primary-foreground))] disabled:opacity-40"><Play size={12} />Back up now</button>
              </div>
              {backup && <div className="mt-2 text-[hsl(var(--muted-foreground))]">{backup.lastRunAt ? `Last run ${new Date(backup.lastRunAt).toLocaleString()}, ${backup.lastMirrorFiles ?? 0} files written` : 'No run yet.'}{backup.lastSnapshotAt ? ` · last snapshot ${new Date(backup.lastSnapshotAt).toLocaleString()}` : ''}{backup.lastError ? ` · error: ${backup.lastError}` : ''}</div>}
            </Section>

            <Section title="MCP (Claude Code, Claude Desktop)">
              <p>Endpoint: <code>http://localhost:8090/mcp</code> {mcp?.authRequired ? '(bearer token required: APP_TOKEN)' : '(no token)'}</p>
              <p className="mt-1">Claude Code: <code>claude mcp add --transport http typst-figure-studio http://localhost:8090/mcp</code></p>
              <p className="mt-1">Claude Desktop (stdio bridge): <code>{'{ "command": "bun", "args": ["C:/Users/rober/Desktop/university-tools/advanced-typst-editor/server/mcp-stdio.ts"] }'}</code></p>
              <ul className="mt-2">
                {(mcp?.clients ?? []).map((c) => <li key={c.name} className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${c.connected ? 'bg-[hsl(var(--status-green))]' : 'bg-[hsl(var(--muted-foreground))]/40'}`} />{c.name} {c.version ?? ''} · {c.sessions} session{c.sessions === 1 ? '' : 's'} · seen {new Date(c.lastSeenAt).toLocaleTimeString()}</li>)}
                {(mcp?.clients ?? []).length === 0 && <li className="text-[hsl(var(--muted-foreground))]">No client has connected yet.</li>}
              </ul>
            </Section>

            <Section title="Typst CLI (server-side compile and PDF export for MCP)">
              <div className="flex gap-2">
                <input value={cli} onChange={(e) => setCli(e.target.value)} placeholder="auto (bundled typst.exe, then PATH)" className="min-w-0 flex-1 rounded-md border border-[hsl(var(--input))] bg-transparent px-2 py-1 font-mono" />
                <button type="button" onClick={() => void saveSettings({ typstCli: cli.trim() || null })} className="rounded-md border border-[hsl(var(--border))] px-2 py-1 hover:bg-[hsl(var(--accent))]">Save</button>
              </div>
            </Section>

            <Section title="Redaction defaults for new blur regions">
              <div className="flex items-center gap-3">
                <select value={redaction.style} onChange={(e) => void saveSettings({ redaction: { style: e.target.value as 'gaussian' | 'pixelate' } })} className="rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--card))] px-2 py-1"><option value="gaussian">Blur</option><option value="pixelate">Pixels</option></select>
                <input type="range" min={0.25} max={3} step={0.25} value={redaction.strength} onChange={(e) => void saveSettings({ redaction: { strength: Number(e.target.value) } })} />
                <span>{Math.round(redaction.strength * 100)}%</span>
              </div>
            </Section>
          </div>
        </div>
      </div>
      {adding && <FolderBrowserDialog title="Choose a backup destination" confirmLabel="Use as destination" onClose={() => setAdding(false)} onPick={(p) => { setAdding(false); void setDest([...(backup?.destinations ?? []), { id: '', path: p, mirror: true, snapshots: true }]); }} />}
      {restore && <ConfirmDialog title={`Restore ${restore.name}?`} message="Current workspaces are copied to a pre-restore folder first. Library workspaces are replaced; external ones are restored beside them, never over the original folder." confirmLabel="Restore" onConfirm={async () => { const s = restore; setRestore(null); setBusy('restore'); try { await api.restoreSnapshot(s.destinationId, s.name); await useAppStore.getState().loadWorkspaces(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); } }} onCancel={() => setRestore(null)} />}
    </Portal>
  );
}

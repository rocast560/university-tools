import { lazy, Suspense, useEffect } from 'react';
import { connectEvents } from '@/api/events';
import { useAppStore } from '@/stores';
import { Sidebar } from '@/components/sidebar/Sidebar';

const TypstView = lazy(() => import('@/components/typst/TypstView').then((m) => ({ default: m.TypstView })));
const SettingsView = lazy(() => import('@/components/settings/SettingsView').then((m) => ({ default: m.SettingsView })));

export default function App() {
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  useEffect(() => {
    const s = useAppStore.getState();
    void (async () => {
      await Promise.all([s.loadWorkspaces(), s.loadSettings(), s.loadBackup(), s.loadMcp()]);
      const list = useAppStore.getState().workspaces;
      let remembered: string | null = null;
      try { remembered = localStorage.getItem('tfs-active-workspace'); } catch { /* ignore */ }
      const pick = list.find((w) => w.id === remembered && w.status === 'ok') ?? list.find((w) => w.status === 'ok') ?? null;
      await s.selectWorkspace(pick?.id ?? null);
    })();
    return connectEvents((ev) => useAppStore.getState().handleEvent(ev), (online) => useAppStore.getState().setOnline(online));
  }, []);
  return (
    <div className="flex h-screen overflow-hidden bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      <Sidebar />
      <main data-ui="main" className="min-w-0 flex-1">
        <Suspense fallback={<div className="p-4 text-xs text-[hsl(var(--muted-foreground))]">Loading…</div>}><TypstView /></Suspense>
      </main>
      {settingsOpen && <Suspense fallback={null}><SettingsView /></Suspense>}
    </div>
  );
}

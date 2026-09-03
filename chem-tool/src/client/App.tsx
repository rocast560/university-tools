import { useEffect, useRef, useState } from 'react';
import { load, redo, undo } from './commands';
import { ConnectDialog } from './components/ConnectDialog';
import { SceneTabs } from './components/SceneTabs';
import { SearchBar } from './components/SearchBar';
import { SidePanel } from './components/SidePanel';
import { StatusBar } from './components/StatusBar';
import { Toast } from './components/Toast';
import { Viewer3D } from './components/Viewer3D';
import { activeScene, focusedSpecies } from './selectors';
import { useStore } from './store';
import { connect } from './ws';

export default function App() {
  const workspace = useStore((s) => s.workspace);
  const scene = activeScene(workspace);
  const species = focusedSpecies(scene);
  const handledUrl = useRef(false);
  const [connectOpen, setConnectOpen] = useState(new URLSearchParams(location.search).get('connect') === '1');

  useEffect(() => { connect(); }, []);

  useEffect(() => {
    if (!workspace || handledUrl.current) return;
    handledUrl.current = true;
    const q = new URLSearchParams(location.search).get('q');
    if (q) { load(q).catch(() => {}); history.replaceState(null, '', location.pathname); }
  }, [workspace]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest('.sketch-host'))) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!workspace || !scene || !species) return <div className="loading">Connecting to ChemTool…</div>;

  return (
    <div className="app">
      <header className="topbar">
        <SearchBar />
        <SceneTabs />
        <div className="history">
          <button className="tab" disabled={scene.history.past.length === 0} onClick={() => undo()} title="Undo (Ctrl+Z)">↶</button>
          <button className="tab" disabled={scene.history.future.length === 0} onClick={() => redo()} title="Redo (Ctrl+Y)">↷</button>
        </div>
        <button className="tab" onClick={() => setConnectOpen(true)}>Connect</button>
        <StatusBar />
      </header>
      <main className="main">
        <Viewer3D species={species} view={scene.view} />
      </main>
      <aside className="side">
        <SidePanel scene={scene} species={species} />
      </aside>
      <ConnectDialog open={connectOpen} onClose={() => setConnectOpen(false)} />
      <Toast />
    </div>
  );
}

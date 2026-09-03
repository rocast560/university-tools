import { useEffect, useRef } from 'react';
import { load } from './commands';
import { SceneTabs } from './components/SceneTabs';
import { SearchBar } from './components/SearchBar';
import { SidePanel } from './components/SidePanel';
import { StatusBar } from './components/StatusBar';
import { Structure2D } from './components/Structure2D';
import { Toast } from './components/Toast';
import { activeScene, focusedSpecies } from './selectors';
import { useStore } from './store';
import { connect } from './ws';

export default function App() {
  const workspace = useStore((s) => s.workspace);
  const scene = activeScene(workspace);
  const species = focusedSpecies(scene);
  const handledUrl = useRef(false);

  useEffect(() => { connect(); }, []);

  useEffect(() => {
    if (!workspace || handledUrl.current) return;
    handledUrl.current = true;
    const q = new URLSearchParams(location.search).get('q');
    if (q) { load(q).catch(() => {}); history.replaceState(null, '', location.pathname); }
  }, [workspace]);

  if (!workspace || !scene || !species) return <div className="loading">Connecting to ChemTool…</div>;

  return (
    <div className="app">
      <header className="topbar">
        <SearchBar />
        <SceneTabs />
        <StatusBar />
      </header>
      <main className="main">
        <div className="viewer-placeholder">
          <Structure2D species={species} large />
        </div>
      </main>
      <aside className="side">
        <SidePanel scene={scene} species={species} />
      </aside>
      <Toast />
    </div>
  );
}

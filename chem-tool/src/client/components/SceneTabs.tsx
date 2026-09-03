import { closeScene, newScene, switchScene } from '../commands';
import { useStore } from '../store';

export function SceneTabs() {
  const ws = useStore((s) => s.workspace);
  if (!ws) return null;
  return (
    <nav className="tabs">
      {ws.scenes.map((s) => (
        <button key={s.id} className={s.id === ws.activeSceneId ? 'tab active' : 'tab'} onClick={() => switchScene(s.id)} title={s.id}>
          {s.title}
          {ws.scenes.length > 1 && <span className="close" onClick={(e) => { e.stopPropagation(); closeScene(s.id); }}>×</span>}
        </button>
      ))}
      <button className="tab add" onClick={() => newScene()} title="New scene">+</button>
    </nav>
  );
}

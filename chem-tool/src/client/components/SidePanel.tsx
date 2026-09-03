import type { Scene, Species } from '../../chem/types';
import { useStore, type Panel } from '../store';
import { InfoPanel } from './InfoPanel';
import { Structure2D } from './Structure2D';

const TABS: { id: Panel; label: string }[] = [
  { id: 'structure', label: '2D' },
  { id: 'info', label: 'Info' },
];

export function SidePanel({ scene, species }: { scene: Scene; species: Species }) {
  const panel = useStore((s) => s.panel);
  const setPanel = useStore((s) => s.setPanel);
  return (
    <div className="panel">
      <div className="panel-tabs">
        {TABS.map((t) => <button key={t.id} className={panel === t.id ? 'active' : ''} onClick={() => setPanel(t.id)}>{t.label}</button>)}
      </div>
      <div className="panel-body">
        {panel === 'structure' && <Structure2D species={species} />}
        {panel === 'info' && <InfoPanel species={species} scene={scene} />}
      </div>
    </div>
  );
}

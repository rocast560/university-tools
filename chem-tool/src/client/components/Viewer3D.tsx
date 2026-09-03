import { useEffect, useRef, useState } from 'react';
import type { Species, ViewState } from '../../chem/types';
import { setView } from '../commands';
import type { Viewer3DApi } from '../viewer3d';

/** Set by the mounted viewer; used by the live snapshot responder (phase 2). */
export let snapshotProvider: (() => string | null) | null = null;

const STYLES: ViewState['style'][] = ['ballstick', 'stick', 'spacefill', 'wireframe'];
const LABELS: ViewState['labels'][] = ['none', 'element', 'index'];

export function Viewer3D({ species, view }: { species: Species; view: ViewState }) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer3DApi | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    import('../viewer3d').then((m) => {
      if (!alive || !host.current) return;
      viewer.current = m.createViewer(host.current);
      snapshotProvider = () => viewer.current?.snapshot() ?? null;
      setReady(true);
    });
    const onResize = () => viewer.current?.resize();
    window.addEventListener('resize', onResize);
    return () => { alive = false; window.removeEventListener('resize', onResize); snapshotProvider = null; viewer.current?.destroy(); viewer.current = null; };
  }, []);

  useEffect(() => { if (ready) viewer.current?.setView(view, species); }, [ready, species, view]);

  const download = () => {
    const url = viewer.current?.snapshot();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url; a.download = `${species.name}-3d.png`; a.click();
  };

  return (
    <div className="viewer">
      <div ref={host} className="viewer-canvas" />
      {!ready && <div className="viewer-loading">Loading 3D…</div>}
      <div className="toolbar">
        <div className="group">
          {STYLES.map((s) => <button key={s} className={view.style === s ? 'active' : ''} onClick={() => setView({ style: s })}>{s}</button>)}
        </div>
        <div className="group">
          {LABELS.map((l) => <button key={l} className={view.labels === l ? 'active' : ''} onClick={() => setView({ labels: l })}>{l === 'none' ? 'no labels' : l}</button>)}
        </div>
        <div className="group">
          <button className={view.spin ? 'active' : ''} onClick={() => setView({ spin: !view.spin })}>spin</button>
          <button className={view.showHydrogens ? 'active' : ''} onClick={() => setView({ showHydrogens: !view.showHydrogens })}>H</button>
          <button onClick={() => { viewer.current?.resetCamera(); setView({ camera: { preset: 'fit', rotation: [0, 0, 0] }, highlight: [] }); }}>reset</button>
          <button onClick={download}>PNG</button>
        </div>
      </div>
      <div className="viewer-caption">{species.name} · {species.displayFormula} · {species.info.molarMass} g/mol</div>
    </div>
  );
}

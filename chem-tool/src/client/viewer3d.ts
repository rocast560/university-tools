// 3Dmol.js wrapper. Loaded lazily from Viewer3D.tsx.

import * as $3Dmol from '3dmol';
import type { Species, ViewState } from '../chem/types';

export interface Viewer3DApi {
  setSpecies(species: Species, view: ViewState): void;
  setView(view: ViewState, species: Species): void;
  snapshot(): string;
  resize(): void;
  destroy(): void;
}

function styleSpec(style: ViewState['style']): Record<string, unknown> {
  switch (style) {
    case 'stick': return { stick: { radius: 0.22 } };
    case 'spacefill': return { sphere: {} };
    case 'wireframe': return { line: { linewidth: 2 } };
    default: return { stick: { radius: 0.15 }, sphere: { scale: 0.28 } };
  }
}

const PRESET_Q: Record<ViewState['camera']['preset'], [number, number, number, number]> = {
  fit: [0, 0, 0, 1],
  front: [0, 0, 0, 1],
  top: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
  side: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
};

export function createViewer(container: HTMLElement): Viewer3DApi {
  const viewer = $3Dmol.createViewer(container, { backgroundColor: 'white', antialias: true });
  let currentId: string | null = null;
  let lastCamera = '';

  function apply(view: ViewState, species: Species, resetCamera: boolean) {
    viewer.setStyle({}, styleSpec(view.style));
    if (!view.showHydrogens) viewer.setStyle({ elem: 'H' }, {});
    if (view.highlight.length) viewer.addStyle({ index: view.highlight.map((i) => i - 1) }, { sphere: { color: '#ffd400', scale: 0.42, opacity: 0.85 } });
    viewer.removeAllLabels();
    if (view.labels !== 'none') {
      for (const a of species.atoms) {
        if (a.element === 'H' && (!view.showHydrogens || view.labels === 'index')) continue;
        viewer.addLabel(view.labels === 'index' ? String(a.index) : a.element, {
          position: { x: a.x, y: a.y, z: a.z }, fontSize: 12, fontColor: 'white', backgroundColor: 'black', backgroundOpacity: 0.6, borderThickness: 0, inFront: true,
        });
      }
    }
    if (resetCamera) {
      viewer.zoomTo();
      const v = viewer.getView() as number[];
      viewer.setView([v[0], v[1], v[2], v[3], ...PRESET_Q[view.camera.preset]]);
      const [rx, ry, rz] = view.camera.rotation;
      if (rx) viewer.rotate(rx, 'x');
      if (ry) viewer.rotate(ry, 'y');
      if (rz) viewer.rotate(rz, 'z');
    }
    viewer.spin(view.spin ? 'y' : false);
    viewer.render();
  }

  const api: Viewer3DApi = {
    setSpecies(species, view) {
      viewer.removeAllModels();
      viewer.removeAllShapes();
      viewer.removeAllLabels();
      viewer.addModel(species.molfile3d, 'sdf');
      currentId = species.id;
      lastCamera = JSON.stringify(view.camera);
      apply(view, species, true);
    },
    setView(view, species) {
      if (species.id !== currentId) { api.setSpecies(species, view); return; }
      const cam = JSON.stringify(view.camera);
      const changed = cam !== lastCamera;
      lastCamera = cam;
      apply(view, species, changed);
    },
    snapshot: () => viewer.pngURI(),
    resize: () => viewer.resize(),
    destroy: () => viewer.clear(),
  };
  return api;
}

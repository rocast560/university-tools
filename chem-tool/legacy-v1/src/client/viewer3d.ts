// 3Dmol.js wrapper. Loaded lazily (dynamic import from main.ts) so the
// initial page does not pay for WebGL code until there is a model to show.

import * as $3Dmol from '3dmol/build/3Dmol.es6.js';
import type { GLViewer } from '3dmol';

export type Style3D = 'ballstick' | 'stick' | 'spacefill' | 'wire';

export interface ModelOptions {
  style: Style3D;
  labels: boolean;
  /** Bigger spheres and no sticks: lattice clusters of metals and ionic solids. */
  packed?: boolean;
  /** Extra line segments (unit cell edges). */
  edges?: Array<[[number, number, number], [number, number, number]]>;
}

export interface Viewer3D {
  setModel(molfile: string, options: ModelOptions): void;
  setStyle(style: Style3D): void;
  setLabels(on: boolean): void;
  spin(on: boolean): void;
  reset(): void;
  pngDataUrl(): string;
  resize(): void;
}

function styleSpec(style: Style3D, packed: boolean): Record<string, unknown> {
  if (packed) {
    if (style === 'spacefill') return { sphere: { scale: 1.0 } };
    if (style === 'stick') return { stick: { radius: 0.12 }, sphere: { scale: 0.32 } };
    if (style === 'wire') return { line: {}, sphere: { scale: 0.18 } };
    return { sphere: { scale: 0.45 }, stick: { radius: 0.12 } };
  }
  switch (style) {
    case 'stick':
      return { stick: { radius: 0.22 } };
    case 'spacefill':
      return { sphere: {} };
    case 'wire':
      return { line: { linewidth: 2 } };
    default:
      return { stick: { radius: 0.15 }, sphere: { scale: 0.28 } };
  }
}

export function createViewer3D(container: HTMLElement): Viewer3D {
  const viewer: GLViewer = $3Dmol.createViewer(container, { backgroundAlpha: 0, antialias: true });
  let currentStyle: Style3D = 'ballstick';
  let packed = false;
  let labelsOn = false;
  let spinning = false;

  const applyLabels = () => {
    viewer.removeAllLabels();
    if (!labelsOn) return;
    viewer.addPropertyLabels('elem', { not: { elem: 'H' } }, {
      fontSize: 12,
      fontColor: 'white',
      backgroundColor: 'black',
      backgroundOpacity: 0.55,
      borderThickness: 0,
      alignment: 'center',
      inFront: true,
    });
  };

  const applyStyle = () => {
    viewer.setStyle({}, styleSpec(currentStyle, packed));
    viewer.render();
  };

  return {
    setModel(molfile, options) {
      viewer.removeAllModels();
      viewer.removeAllShapes();
      viewer.removeAllLabels();
      currentStyle = options.style;
      packed = options.packed ?? false;
      labelsOn = options.labels;
      viewer.addModel(molfile, 'sdf');
      viewer.setStyle({}, styleSpec(currentStyle, packed));
      for (const [a, b] of options.edges ?? []) {
        viewer.addLine({ start: { x: a[0], y: a[1], z: a[2] }, end: { x: b[0], y: b[1], z: b[2] }, color: '#8a8f9a' });
      }
      applyLabels();
      viewer.zoomTo();
      viewer.zoom(0.9, 0);
      viewer.render();
      if (spinning) viewer.spin('y');
    },
    setStyle(style) {
      currentStyle = style;
      applyStyle();
    },
    setLabels(on) {
      labelsOn = on;
      applyLabels();
      viewer.render();
    },
    spin(on) {
      spinning = on;
      viewer.spin(on ? 'y' : false);
    },
    reset() {
      viewer.zoomTo();
      viewer.zoom(0.9, 200);
      viewer.render();
    },
    pngDataUrl() {
      return viewer.pngURI();
    },
    resize() {
      viewer.resize();
    },
  };
}

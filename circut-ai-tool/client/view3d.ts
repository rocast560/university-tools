// Opening and closing the 3D board.
//
// three is loaded on demand, so a user who never opens this never downloads
// it and the first paint of the flat board stays as quick as it was.

import type { LayoutDoc } from '../src/pipeline.ts';
import type { Board3D } from './board3d.ts';
import { analog } from './analog.ts';

let view: Board3D | null = null;
let host: HTMLElement | null = null;
let unsub: (() => void) | null = null;

export const is3dOpen = () => !!view;

export async function open3d(card: HTMLElement, doc: LayoutDoc) {
  if (view) return;
  host = document.createElement('div');
  host.className = 'view3d';
  host.innerHTML = '<div class="view3d-hint">drag or middle-drag to orbit &middot; right-drag to pan &middot; scroll to zoom</div><div class="view3d-canvas"></div>';
  card.appendChild(host);
  const canvasHost = host.querySelector<HTMLElement>('.view3d-canvas')!;
  const { mount3d } = await import('./board3d.ts');
  // The user may have closed it again while three was still downloading.
  if (!host.isConnected) return;
  view = mount3d(canvasHost, doc);
  view.setState(analog.latest());
  unsub = analog.subscribe((s) => view?.setState(s));
}

export function close3d() {
  unsub?.();
  unsub = null;
  view?.dispose();
  view = null;
  host?.remove();
  host = null;
}

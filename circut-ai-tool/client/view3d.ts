// Opening and closing the 3D editor. The editor itself lives in
// client/editor3d/; this module only keeps the one instance and the history
// entry that lets the browser's Back button close it.
//
// three is still loaded on demand (workspace.ts imports board3d.ts
// dynamically), so a user who never opens 3D never downloads it.

import { openWorkspace, type Workspace } from './editor3d/workspace.ts';
import { toast } from './main.ts';
import { store } from './state.ts';

let ws: Workspace | null = null;
let opening = false;
let loading: AbortController | null = null;
let onPop: (() => void) | null = null;

export const is3dOpen = () => !!ws;

export async function open3d() {
  if (ws || opening) return;
  opening = true;
  // One history entry on the same URL: Back closes the editor rather than
  // leaving the project. The router only listens for hash changes, so this
  // entry is invisible to it.
  history.pushState({ ...(history.state ?? {}), view3d: true }, '');
  onPop = () => close3d(false);
  addEventListener('popstate', onPop);
  const ac = (loading = new AbortController());
  try {
    ws = await openWorkspace(() => {
      ws = null;
      // Repaint the page toolbar so its button reads 3D again.
      store.setProject({});
    }, ac.signal);
    // Nothing to show (no project): undo the history entry and listener.
    if (!ws && !ac.signal.aborted) close3d();
  } catch (e) {
    if (!ac.signal.aborted) {
      close3d();
      toast(`Could not open the 3D editor: ${(e as Error).message}`);
    }
  } finally {
    if (loading === ac) loading = null;
    opening = false;
  }
}

/** Close the editor; `viaHistory` also drops the history entry opening it pushed. */
export function close3d(viaHistory = true) {
  if (onPop) {
    removeEventListener('popstate', onPop);
    onPop = null;
  }
  if (viaHistory && (history.state as { view3d?: boolean } | null)?.view3d) history.back();
  loading?.abort();
  loading = null;
  ws?.close();
  ws = null;
}

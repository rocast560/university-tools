// The parts tray across the top of the 3D editor: a search box, group chips
// and a tile per part. A part goes on the board two ways: drag its tile onto
// a hole, or tap the tile to arm it and then click a hole. Either way a ghost
// shows where its legs would go, tinted by the same placement rules a move
// uses, and the drop adds it to the schematic and then pins it to those holes.
//
// Every decision (which holes, whether they are free, which nets the legs
// join) is made in src/edit/*; this file only wires pointer events to them.

import { defaultHoles, holeNear } from '../../src/edit/newpart.ts';
import { legsToConnections, validatePlacement } from '../../src/edit/placement.ts';
import type { Hole } from '../../src/layout/types.ts';
import type { PartAlias } from '../../src/parts/aliases.ts';
import type { Footprint } from '../../src/parts/catalog.ts';
import { api, type PartFootprint } from '../api.ts';
import { loadProject, toast } from '../main.ts';
import { store } from '../state.ts';
import { claimTool, onToolClaimed } from './tool.ts';
import { iconHtml, listParts, tileHtml, trayHtml, type Group } from './tray-tiles.ts';
import { addKeyHandler, type Workspace } from './workspace.ts';

/** Movement under this, in CSS px, is a tap rather than a drag. */
const TAP_PX = 4;
/** Footprints the board places by itself: added to the schematic without a move. */
const AUTO = new Set<Footprint['kind']>(['sevenseg', 'module', 'unsupported']);

const ghostShape = (fp: Footprint): 'lead2' | 'dip' | 'other' => (fp.kind === 'lead2' ? 'lead2' : fp.kind === 'dip' || fp.kind === 'dipswitch' ? 'dip' : 'other');
const why = (fp: Footprint, at: Hole) =>
  (fp.kind === 'dip' || fp.kind === 'dipswitch') && at.row !== 'e' && at.row !== 'f' ? `${fp.kind === 'dip' ? 'a chip' : 'a DIP switch'} has to straddle the centre channel (rows e and f)` : 'its legs would run off the board';

/** Test-only seam (scripts/e2e-3d.ts): the next tray drop's move is refused as if by the server. */
let failNextMove = false;
export const _failNextMove = () => void (failNextMove = true);

export function attachTray(ws: Workspace): () => void {
  const { board } = ws;
  const tray = ws.root.querySelector<HTMLElement>('.ws-tray')!;
  tray.innerHTML = trayHtml();
  const search = tray.querySelector<HTMLInputElement>('.ws-search')!;
  const tilesEl = tray.querySelector<HTMLElement>('.ws-tiles')!;
  let parts: PartAlias[] = [];
  let group: Group = 'Basic';
  let query = '';
  let disposed = false;
  const cache = new Map<string, Promise<PartFootprint>>();
  const fps = new Map<string, PartFootprint>();
  const fpOf = (alias: string) => {
    let p = cache.get(alias);
    if (!p) {
      p = api.footprint(alias);
      cache.set(alias, p);
      p.then(
        (fp) => {
          fps.set(alias, fp);
          paintIcon(alias);
        },
        (e: Error) => {
          cache.delete(alias);
          toast(`Can't use ${alias}: ${e.message}`);
        },
      );
    }
    return p;
  };

  /** The part a tap has armed; clicks on the board then drop it. */
  let armed: { alias: string; tile: HTMLElement } | null = null;
  /** A tile being dragged out of the tray. */
  let drag: { alias: string; tile: HTMLElement; pointerId: number; x: number; y: number; moved: boolean; ghost: HTMLElement | null } | null = null;
  /** What the pointer is over: the hole, the legs' holes (null when it cannot sit there) and the verdict. */
  let current: { alias: string; at: Hole; doc: unknown; holes: Record<string, Hole> | null; ok: boolean; reason: string; auto: boolean } | null = null;
  let shown = false;
  let busy = false;

  // ---------- rendering (the markup is tray-tiles.ts's) ----------
  const kind = () => store.get().project?.sidecar.options.resistorKind ?? 'carbon';
  const tileFor = (alias: string) => tilesEl.querySelector<HTMLElement>(`[data-alias="${CSS.escape(alias)}"]`);
  const render = () => {
    for (const chip of tray.querySelectorAll<HTMLElement>('.ws-chip')) chip.classList.toggle('is-on', !query.trim() && chip.dataset.group === group);
    const list = listParts(parts, group, query);
    tilesEl.innerHTML = list.length ? list.map((a) => tileHtml(a, fps.get(a.alias), kind(), armed?.alias === a.alias)).join('') : `<span class="ws-tray-empty">${parts.length ? 'No part matches' : 'Loading parts…'}</span>`;
    // The armed tile may have been re-drawn; keep pointing at the live one.
    // A search or group that hides it disarms: no part is dropped from a tile nobody can see.
    if (armed) {
      const tile = tileFor(armed.alias);
      if (tile) armed.tile = tile;
      else disarm();
    }
  };
  /** A chip's leg count is only known once its footprint is in: redraw its icon then. */
  const paintIcon = (alias: string) => {
    const tile = tileFor(alias);
    const a = parts.find((x) => x.alias === alias);
    if (!tile || !a) return;
    tile.querySelector('svg')?.remove();
    tile.insertAdjacentHTML('afterbegin', iconHtml(a, fps.get(alias), kind()));
  };

  // ---------- the preview ----------
  const armedHint = () => (armed ? `click a hole to place ${armed.alias} · Esc cancels` : '');
  const clearPreview = () => {
    current = null;
    if (!shown) return;
    shown = false;
    board.setGhost(null);
    board.setStripTint([]);
  };
  /** Whether the pointer is over the canvas itself (not the card, the legend or the tray). */
  const overCanvas = (e: { clientX: number; clientY: number }) => document.elementFromPoint(e.clientX, e.clientY) === board.dom;

  /** Ghost and tints for `alias` at the pointer; recomputed only when the hole under it changes. */
  const preview = (e: { clientX: number; clientY: number }, alias: string) => {
    const p = store.get().project;
    const fp = fps.get(alias);
    const pt = p && fp && overCanvas(e) ? board.boardPoint(e) : null;
    const at = pt && p ? holeNear(p.doc.board, pt) : null;
    if (!p || !fp || !at) {
      if (current) ws.hint(armedHint());
      clearPreview();
      return;
    }
    if (current && current.alias === alias && current.doc === p.doc && current.at.col === at.col && current.at.row === at.row) return;
    shown = true;
    if (AUTO.has(fp.footprint.kind)) {
      current = { alias, at, doc: p.doc, holes: null, ok: true, reason: '', auto: true };
      board.setGhost({ holes: [at], footprint: 'other', ok: true });
      board.setStripTint([]);
      ws.hint(`${alias} is placed automatically · click to add it`);
      return;
    }
    const holes = defaultHoles(fp.footprint, fp.pins, at, p.doc.board);
    if (!holes) {
      const reason = why(fp.footprint, at);
      current = { alias, at, doc: p.doc, holes: null, ok: false, reason, auto: false };
      board.setGhost({ holes: [at], footprint: 'other', ok: false });
      board.setStripTint([]);
      ws.hint(`can't go here: ${reason}`);
      return;
    }
    const verdict = validatePlacement(p.doc, p.design, 'NEW?', holes, () => '');
    current = { alias, at, doc: p.doc, holes, ok: verdict.ok, reason: verdict.reason ?? '', auto: false };
    board.setGhost({ holes: Object.values(holes), footprint: ghostShape(fp.footprint), ok: verdict.ok });
    board.setStripTint(verdict.tints);
    ws.hint(verdict.ok ? `${drag ? 'release' : 'click'} to place ${alias} at ${at.row}${at.col}${armed ? ' · Esc cancels' : ''}` : `can't go here: ${verdict.reason}`);
  };

  // ---------- arming, cancelling, dropping ----------
  const arm = (alias: string, tile: HTMLElement) => {
    disarm();
    claimTool('tray');
    armed = { alias, tile };
    tile.classList.add('is-armed');
    ws.hint(armedHint());
    void fpOf(alias).catch(() => armed?.alias === alias && disarm());
    ws.canvasHost.addEventListener('pointerdown', onCanvasDown, true);
    ws.canvasHost.addEventListener('pointerup', onCanvasUp, true);
    window.addEventListener('pointermove', onArmedMove);
  };
  function disarm() {
    if (!armed) return;
    armed.tile.classList.remove('is-armed');
    tilesEl.querySelector('.is-armed')?.classList.remove('is-armed');
    armed = null;
    armDown = null;
    ws.canvasHost.removeEventListener('pointerdown', onCanvasDown, true);
    ws.canvasHost.removeEventListener('pointerup', onCanvasUp, true);
    window.removeEventListener('pointermove', onArmedMove);
    clearPreview();
    ws.hint('');
  }
  const endDrag = () => {
    if (!drag) return;
    drag.ghost?.remove();
    try {
      drag.tile.releasePointerCapture(drag.pointerId);
    } catch {
      /* already released */
    }
    drag = null;
  };
  const cancel = () => {
    const had = !!drag || !!armed;
    endDrag();
    disarm();
    clearPreview();
    ws.hint('');
    return had;
  };

  const drop = async () => {
    const p = store.get().project;
    const cur = current;
    if (!p || !cur || busy) return;
    if (!cur.ok) return void ws.hint(`can't go here: ${cur.reason}`);
    const fp = fps.get(cur.alias);
    endDrag();
    disarm();
    clearPreview();
    busy = true;
    tray.classList.add('is-busy');
    try {
      const connections = cur.holes ? legsToConnections(p.doc, p.design, cur.holes) : {};
      let added: { ref: string; notes: string[] };
      try {
        added = await api.editAdd(p.id, { part: cur.alias, connections, spare: false });
      } catch (e) {
        toast(`Not added: ${(e as Error).message}`);
        return;
      }
      // A leg the server could not join (its gate is already in use, or the pin is unknown) stays unconnected: say so. A refused move below says more and replaces this.
      const skipped = added.notes.filter((n) => /not connected/.test(n));
      if (skipped.length) toast(`${added.ref} added; ${skipped.join('; ')}`);
      if (cur.holes) {
        try {
          if (failNextMove) {
            failNextMove = false;
            throw new Error('the move was refused (test)');
          }
          await api.move(p.id, added.ref, cur.holes);
        } catch (e) {
          toast(`${added.ref} added, but not at that spot: ${(e as Error).message}. The board placed it.`);
        }
      }
      await loadProject(p.id);
      if (disposed || store.get().project?.id !== p.id) return;
      store.setProject({ selectedRef: added.ref });
      if (cur.auto) ws.hint('placed automatically');
      // The card opens from the selection; a part with a value is ready to have it typed.
      if (fp?.value) ws.root.querySelector<HTMLInputElement>('.ws-card:not(.ws-wirecard) input[name=value]')?.focus();
    } finally {
      busy = false;
      tray.classList.remove('is-busy');
    }
  };

  // ---------- pointer: the board while armed ----------
  // Capture listeners on the canvas's parent run before the canvas's own, so
  // selection, wire editing and orbit never see an armed click.
  let armDown: { x: number; y: number } | null = null;
  function onCanvasDown(e: PointerEvent) {
    if (!armed || e.target !== board.dom || e.button !== 0) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    armDown = { x: e.clientX, y: e.clientY };
  }
  function onCanvasUp(e: PointerEvent) {
    if (!armed || !armDown) return;
    e.stopImmediatePropagation();
    const tap = Math.hypot(e.clientX - armDown.x, e.clientY - armDown.y) <= TAP_PX;
    armDown = null;
    if (!tap) return;
    preview(e, armed.alias);
    void drop();
  }
  function onArmedMove(e: PointerEvent) {
    if (armed && !drag) preview(e, armed.alias);
  }

  // ---------- pointer: the tiles ----------
  const tileOf = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>('.ws-tile');
  tray.addEventListener('pointerdown', (e) => {
    const tile = tileOf(e);
    if (!tile || e.button !== 0 || busy) return;
    e.preventDefault();
    endDrag();
    try {
      tile.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic pointer */
    }
    drag = { alias: tile.dataset.alias!, tile, pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false, ghost: null };
    const alias = drag.alias;
    void fpOf(alias).catch(() => drag?.alias === alias && cancel());
  });
  tray.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) <= TAP_PX) return;
    if (!drag.moved) {
      drag.moved = true;
      disarm();
      claimTool('tray');
      drag.ghost = document.createElement('div');
      drag.ghost.className = 'ws-drag-ghost';
      drag.ghost.innerHTML = drag.tile.querySelector('svg')?.outerHTML ?? '';
      ws.root.appendChild(drag.ghost);
    }
    const over = overCanvas(e);
    drag.ghost!.hidden = over;
    drag.ghost!.style.transform = `translate(${e.clientX - 28}px, ${e.clientY - 16}px)`;
    if (over) preview(e, drag.alias);
    else if (current) {
      clearPreview();
      ws.hint('');
    }
  });
  tray.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { alias, tile, moved } = drag;
    if (!moved) {
      endDrag();
      if (armed?.alias === alias) disarm();
      else arm(alias, tile);
      return;
    }
    preview(e, alias);
    const cur = current;
    if (cur?.ok && overCanvas(e)) return void drop();
    cancel();
    if (cur && !cur.ok) ws.hint(`can't go here: ${cur.reason}`);
  });
  const onLost = (e: PointerEvent) => {
    if (drag && e.pointerId === drag.pointerId && drag.moved) cancel();
  };
  tray.addEventListener('pointercancel', onLost);
  // Keyboard: Enter or Space on a tile arms it like a tap.
  tray.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.ws-chip');
    if (chip) {
      group = chip.dataset.group as Group;
      query = search.value = '';
      return render();
    }
    const tile = tileOf(e);
    if (tile && e.detail === 0) armed?.alias === tile.dataset.alias ? disarm() : arm(tile.dataset.alias!, tile);
  });
  search.addEventListener('input', () => {
    query = search.value;
    render();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      cancel();
      search.blur();
    }
  });
  // Any other tool disarms: the toolbar, the legend.
  const otherTool = (e: Event) => {
    if ((e.target as HTMLElement).closest('.ws-bar, .ws-legend')) disarm();
  };
  ws.root.addEventListener('pointerdown', otherTool);

  // Another tool (the wire tool) taking the board drops whatever the tray had in hand.
  const offTool = onToolClaimed((t) => void (t !== 'tray' && cancel()));
  const offKey = addKeyHandler((e) => {
    if (e.key === '/') {
      search.focus();
      search.select();
      return true;
    }
    if (e.key === 'Escape') return cancel();
    return false;
  });
  // A new doc under a live preview: its verdict is stale, so draw it again on the next move.
  const offStore = store.subscribe(() => {
    if (current && current.doc !== store.get().project?.doc) {
      clearPreview();
      ws.hint(armedHint());
    }
  });

  api
    .parts()
    .then((list) => {
      if (disposed) return;
      parts = list;
      render();
    })
    .catch((e: Error) => toast(`Parts tray: ${e.message}`));
  render();

  return () => {
    disposed = true;
    endDrag();
    disarm();
    clearPreview();
    offKey();
    offTool();
    offStore();
    ws.root.removeEventListener('pointerdown', otherTool);
  };
}

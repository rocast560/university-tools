// ─────────────────────────────────────────────────────────────────────────
// Typst tab: a typst.app-style split view rendered entirely locally.
//
// Left: the raw Typst source in a CodeMirror editor.
// Right: the live, in-browser-compiled preview.
//
// The source is main.typ (or another .typ picked in the header) of the active
// workspace, loaded and autosaved by useWorkspaceFile. Every other file in the
// folder is mounted into the compiler so #include and data files work.
// ─────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { PanelLeftClose, PanelLeftOpen, FileDown, Image, FileText, Images, Search } from 'lucide-react';
import { useAppStore } from '@/stores';
import { api } from '@/api/client';
import { useWorkspaceFile } from '@/hooks/use-workspace-file';
import {
  TypstEditor, revealTypstRange, getTypstCaret, setTypstSearchRequest, setTypstEditorContent,
} from './TypstEditor';
import { DiskChangeBar } from './DiskChangeBar';
import { TypstPreview, type SourceCandidate } from './TypstPreview';
import { TypstSearchPanel } from './TypstSearchPanel';
import { TypstAssetsPanel } from './TypstAssetsPanel';
import {
  compileTypstPdf,
  compileTypstSvg,
  setTypstFonts,
  setTypstShadowFiles,
  typstErrorMessage,
  type TypstShadowFile,
} from '@/lib/typst-compiler';
import { assetPath, fetchAssetBytes, resolveAssetBytes } from '@/lib/typst-assets';
import { matchAssetByHref } from '@/lib/asset-folders';
import { findSourceRange, type SourceRange } from '@/lib/typst-source-map';
import type { FileEntry } from '@/types';
import {
  clampPaneWidth,
  fitPanes,
  loadTypstLayout,
  saveTypstLayout,
  PANE_DEFAULT,
  type PaneKind,
  type TypstLayout,
} from '@/lib/pane-resize';

function triggerDownload(filename: string, data: BlobPart, mime: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function TypstView() {
  const workspaceId = useAppStore((s) => s.activeWorkspaceId);

  if (!workspaceId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
        Select a workspace to use the Typst editor.
      </div>
    );
  }

  return <TypstWorkspaceView workspaceId={workspaceId} />;
}

/**
 * Files that are not assets but the document may still pull in: chapters it
 * `#include`s, a bibliography, data tables, a logo it never cropped.
 */
const MOUNTABLE_EXTS = ['.typ', '.bib', '.csv', '.json', '.yaml', '.yml', '.toml', '.txt', '.svg', '.pdf'];

/**
 * Anything larger than this is a stray download that happens to live in the
 * folder, not a document input: reading it and pushing it through wasm on
 * every workspace switch would cost more than the document itself.
 */
const MAX_MOUNT_BYTES = 25 * 1024 * 1024;

/**
 * Bytes of the workspace's plain (non-asset) files, keyed by workspace, path
 * and mtime. The server's mtime is the only thing that can make a mounted
 * file stale, so re-running the sync after an unrelated change hands back the
 * exact same arrays and `setTypstShadowFiles` sees no change at all.
 */
const plainFileCache = new Map<string, Promise<Uint8Array>>();

function readPlainFile(workspaceId: string, f: FileEntry): Promise<Uint8Array> {
  const key = `${workspaceId}:${f.path}:${f.mtime}`;
  const hit = plainFileCache.get(key);
  if (hit) return hit;
  const bytes = api.readBytes(workspaceId, f.path);
  // Don't cache a rejection: a transient blip shouldn't unmount the file for
  // the rest of the session.
  bytes.catch(() => { plainFileCache.delete(key); });
  plainFileCache.set(key, bytes);
  return bytes;
}

/**
 * Push the workspace's files into the compiler's virtual filesystem and font
 * set, and report a revision that changes whenever they do, so the preview
 * recompiles after a drop or a crop, not just on a source edit.
 *
 * Images are resolved through `resolveAssetBytes`, which applies the crop
 * rectangle before the bytes ever reach Typst; fonts are installed at init.
 * Every other file is mounted verbatim at `/<workspace-relative path>`, so
 * `#include "/chapters/intro.typ"` and `#bibliography("/refs.bib")` resolve.
 * Everything is memoized (assets by id + crop, plain files by mtime), so this
 * is a no-op on re-renders where nothing moved.
 *
 * `mainFile` is skipped: what gets compiled at that path is the editor's
 * live, possibly-unsaved text, not the copy on disk.
 */
function useTypstAssetSync(workspaceId: string, mainFile: string): number {
  const assets = useAppStore((s) => s.typstAssets);
  const files = useAppStore((s) => s.detail?.files);
  const loadTypstAssets = useAppStore((s) => s.loadTypstAssets);
  const [revision, setRevision] = useState(0);

  useEffect(() => { void loadTypstAssets(); }, [loadTypstAssets, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const images = assets.filter((a) => a.kind === 'image');
      const fonts = assets.filter((a) => a.kind === 'font');
      // Assets own their own bytes (cropped, redacted); everything else is
      // mounted exactly as it sits on disk.
      const assetIds = new Set(assets.map((a) => a.id));
      const plain = (files ?? []).filter(
        (f) => !assetIds.has(f.path)
          && f.path !== mainFile
          && f.size <= MAX_MOUNT_BYTES
          && MOUNTABLE_EXTS.some((e) => f.path.toLowerCase().endsWith(e)),
      );

      // allSettled: one file whose bytes went missing (deleted out-of-band,
      // renamed between the listing and the read) must not take down every
      // other image in the document. Failures are simply left unmounted, and
      // Typst reports the unresolved path against the exact line that
      // referenced it.
      const [imageResults, fontResults, plainResults] = await Promise.all([
        Promise.allSettled(
          images.map(async (a) => ({ path: assetPath(a), bytes: await resolveAssetBytes(a) })),
        ),
        Promise.allSettled(fonts.map((a) => fetchAssetBytes(a.id))),
        Promise.allSettled(
          plain.map(async (f) => ({ path: `/${f.path}`, bytes: await readPlainFile(workspaceId, f) })),
        ),
      ]);
      if (cancelled) return;

      const mounted = (results: PromiseSettledResult<TypstShadowFile>[]): TypstShadowFile[] =>
        results
          .filter((r): r is PromiseFulfilledResult<TypstShadowFile> => r.status === 'fulfilled')
          .map((r) => r.value);
      const fontBytes = fontResults
        .filter((r): r is PromiseFulfilledResult<Uint8Array> => r.status === 'fulfilled')
        .map((r) => r.value);

      const filesChanged = setTypstShadowFiles([...mounted(imageResults), ...mounted(plainResults)]);
      const fontsChanged = setTypstFonts(fontBytes);
      if (filesChanged || fontsChanged) setRevision((r) => r + 1);
    })();
    return () => { cancelled = true; };
  }, [assets, files, mainFile, workspaceId]);

  return revision;
}

function TypstWorkspaceView({ workspaceId }: { workspaceId: string }) {
  // The document being edited: main.typ unless the header's switcher picks
  // another .typ from the workspace folder.
  const [file, setFile] = useState('main.typ');
  const { text: source, loading, dirty, externalChange, setText, reload, keepMine } =
    useWorkspaceFile(workspaceId, file);
  const detail = useAppStore((s) => s.detail);
  // Derived from the (stable) detail object rather than selected directly: a
  // selector that builds a fresh array on every call has no stable snapshot
  // for useSyncExternalStore and would re-render forever.
  const typFiles = useMemo(
    () => detail?.files.filter((f) => f.path.endsWith('.typ')).map((f) => f.path) ?? [],
    [detail],
  );
  const detailName = detail?.entry.name ?? 'document';
  // A different workspace starts at its own main.typ.
  useEffect(() => { setFile('main.typ'); }, [workspaceId]);

  const typstAssets = useAppStore((s) => s.typstAssets);
  // Ref mirror so the preview's click callback stays stable across renders.
  const typstAssetsRef = useRef(typstAssets);
  typstAssetsRef.current = typstAssets;
  const [layout, setLayout] = useState<TypstLayout>(loadTypstLayout);
  const { showEditor, showAssets } = layout;
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const editorPaneRef = useRef<HTMLDivElement>(null);
  const assetsPaneRef = useRef<HTMLDivElement>(null);
  const assetRevision = useTypstAssetSync(workspaceId, file);
  // Mirrors `source` so the reveal callback can stay stable across keystrokes.
  const sourceRef = useRef(source);
  sourceRef.current = source;

  // Live pane widths, mirrored into refs so the drag handler reads the current
  // value without re-subscribing and without depending on a render.
  const widthsRef = useRef({ editor: layout.editor, assets: layout.assets });
  widthsRef.current = { editor: layout.editor, assets: layout.assets };
  const visibleRef = useRef({ editor: showEditor, assets: showAssets });
  visibleRef.current = { editor: showEditor, assets: showAssets };

  // Teardown for an in-progress drag (removes the listeners, the cursor lock,
  // and any queued frame). Set while dragging, null otherwise, so the unmount
  // effect can tear down a drag that's still active.
  const dragCleanupRef = useRef<(() => void) | null>(null);

  // Defensive: if the tab unmounts mid-drag, tear the drag down (removes the
  // orphaned document listeners, cancels the queued frame, and undoes the
  // global cursor/selection lock that mouseup would normally clear).
  useEffect(() => () => { dragCleanupRef.current?.(); }, []);

  // Programmatic rewrites (slot placement, search replace) go through the
  // editor when it is mounted so undo works; otherwise straight to the file.
  // setTypstEditorContent dispatches into CodeMirror, whose update listener
  // calls setText, so both paths end in the same autosave.
  const applySource = useCallback((next: string) => {
    if (!setTypstEditorContent(next)) setText(next);
  }, [setText]);

  /**
   * Click-to-source: jump the caret to whatever was clicked in the preview.
   *
   * Opens the code pane first if it's hidden: the whole point of the gesture
   * is to land on the source, so silently doing nothing because the editor is
   * collapsed would be the wrong call. The reveal is deferred a frame so the
   * newly-mounted CodeMirror instance exists before we drive it.
   */
  /**
   * Select `[from, to)` in the editor, opening the (possibly hidden) code pane
   * first. Shared by click-to-source and the search panel. When the pane has
   * to be revealed, the CodeMirror instance mounts a frame later, so the
   * selection is deferred to the next frame.
   */
  const revealRange = useCallback((from: number, to: number, focus = true) => {
    if (!visibleRef.current.editor) {
      setLayout((prev) => {
        const merged = { ...prev, showEditor: true };
        saveTypstLayout(merged);
        return merged;
      });
      requestAnimationFrame(() => revealTypstRange(from, to, focus));
      return;
    }
    revealTypstRange(from, to, focus);
  }, []);

  // The search panel selects matches without stealing focus from its input, so
  // repeated Enter keeps stepping through results.
  const revealForSearch = useCallback(
    (from: number, to: number) => revealRange(from, to, false),
    [revealRange],
  );

  const revealSource = useCallback((candidates: SourceCandidate[]) => {
    let hit: SourceRange | null = null;
    for (const c of candidates) {
      hit = findSourceRange(sourceRef.current, c.text, c.occurrence);
      if (hit) break;
    }
    if (hit) revealRange(hit.from, hit.to);
  }, [revealRange]);

  // Assets panel: full-tab mode, and click-to-reveal from the preview
  // (clicking a rendered figure selects + flashes its asset card).
  const [assetsMax, setAssetsMax] = useState(false);
  const [assetReveal, setAssetReveal] = useState<{ id: string; nonce: number } | null>(null);
  const toggleAssetsMax = useCallback(() => setAssetsMax((m) => !m), []);
  const hideAssets = useCallback(() => {
    setAssetsMax(false);
    setLayout((prev) => {
      const merged = { ...prev, showAssets: false };
      saveTypstLayout(merged);
      return merged;
    });
  }, []);
  const revealImage = useCallback((href: string) => {
    void (async () => {
      const images = typstAssetsRef.current.filter((a) => a.kind === 'image');
      const match = await matchAssetByHref(href, images, resolveAssetBytes);
      if (!match) return;
      if (!visibleRef.current.assets) {
        setLayout((prev) => {
          const merged = { ...prev, showAssets: true };
          saveTypstLayout(merged);
          return merged;
        });
      }
      setAssetReveal({ id: match.id, nonce: Date.now() });
    })();
  }, []);

  // Whole-document find & replace panel (lib/typst-search). Ctrl/⌘+F inside the
  // editor and the header's Find button both route here; opening it reveals the
  // code pane so there's something to search into.
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => {
    if (!visibleRef.current.editor) {
      setLayout((prev) => {
        const merged = { ...prev, showEditor: true };
        saveTypstLayout(merged);
        return merged;
      });
    }
    setSearchOpen(true);
  }, []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  // Bridge the editor's Ctrl/⌘+F keybinding to this panel while the tab is
  // mounted.
  useEffect(() => {
    setTypstSearchRequest(openSearch);
    return () => setTypstSearchRequest(null);
  }, [openSearch]);

  /**
   * Drag one of the two dividers.
   *
   * The width is written straight to the pane's own style during the drag and
   * committed to React state only on release, so a resize costs one style
   * mutation per frame instead of a full re-render of the tab. That matters
   * here more than in most layouts: a re-render mid-drag would reconcile the
   * assets rail and (worse) risk remounting the CodeMirror host, which would
   * drop the caret and the whole undo history with it.
   *
   * The container geometry is read once at drag start; reading it per-move
   * forces a synchronous reflow on every event, which is most of the lag in a
   * naive implementation.
   */
  const startResize = useCallback((which: PaneKind) => (e: React.PointerEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const paneEl = which === 'editor' ? editorPaneRef.current : assetsPaneRef.current;
    if (!paneEl) return;

    const containerWidth = container.getBoundingClientRect().width;
    const startX = e.clientX;
    const startWidth = widthsRef.current[which];
    const other = which === 'editor'
      ? (visibleRef.current.assets ? widthsRef.current.assets : 0)
      : (visibleRef.current.editor ? widthsRef.current.editor : 0);

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    let frame = 0;
    let next = startWidth;

    const onMove = (ev: PointerEvent) => {
      // The editor grows as the pointer moves right; the assets rail is on
      // the far side, so it grows as the pointer moves left.
      const delta = ev.clientX - startX;
      const raw = which === 'editor' ? startWidth + delta : startWidth - delta;
      next = clampPaneWidth(which, raw, containerWidth, other);
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          paneEl.style.width = `${next}px`;
        });
      }
    };

    const cleanup = () => {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      dragCleanupRef.current = null;
    };

    const onUp = () => {
      cleanup();
      // Single commit: React state catches up to the DOM we've been driving.
      setLayout((prev) => {
        const merged = { ...prev, [which]: next };
        saveTypstLayout(merged);
        return merged;
      });
    };

    dragCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, []);

  /** Double-click a divider to restore that pane's default width. */
  const resetPane = useCallback((which: PaneKind) => () => {
    setLayout((prev) => {
      const merged = { ...prev, [which]: PANE_DEFAULT[which] };
      saveTypstLayout(merged);
      return merged;
    });
  }, []);

  const togglePane = useCallback((which: PaneKind) => () => {
    setLayout((prev) => {
      const key = which === 'editor' ? 'showEditor' : 'showAssets';
      const merged = { ...prev, [key]: !prev[key] };
      saveTypstLayout(merged);
      return merged;
    });
  }, []);

  // Keep both rails inside the container when it changes size (window resize,
  // sidebar toggle, pane split). Without this a layout saved on a wide monitor
  // can leave no room for the preview on a narrow one.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width <= 0) return;
      setLayout((prev) => {
        const fitted = fitPanes(
          { editor: prev.editor, assets: prev.assets },
          { editor: prev.showEditor, assets: prev.showAssets },
          width,
        );
        if (fitted.editor === prev.editor && fitted.assets === prev.assets) return prev;
        return { ...prev, ...fitted };
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const exportPdf = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    try {
      const bytes = await compileTypstPdf(source, `/${file}`);
      triggerDownload(`${detailName}.pdf`, bytes as BlobPart, 'application/pdf');
    } catch (err) {
      setExportError(`PDF export failed: ${typstErrorMessage(err)}`);
    } finally {
      setExporting(false);
    }
  }, [source, file, detailName]);

  const exportSvg = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    try {
      const res = await compileTypstSvg(source, {}, `/${file}`);
      if (!res.svg) {
        const msg = res.diagnostics.find((d) => d.severity === 'error')?.message ?? 'document has errors';
        setExportError(`SVG export failed: ${msg}`);
        return;
      }
      triggerDownload(`${detailName}.svg`, res.svg, 'image/svg+xml');
    } catch (err) {
      setExportError(`SVG export failed: ${typstErrorMessage(err)}`);
    } finally {
      setExporting(false);
    }
  }, [source, file, detailName]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div data-ui="toolbar" className="flex h-9 shrink-0 items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3">
        <div className="flex items-center gap-2">
          <FileText size={13} className="text-[hsl(var(--status-purple))]" />
          <span className="text-[11px] font-bold uppercase tracking-widest text-[hsl(var(--foreground))]">Typst</span>
          {typFiles.length > 1 && (
            <select value={file} onChange={(e) => setFile(e.target.value)} className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-1.5 py-0.5 text-[11px]">
              {typFiles.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          )}
          <span title={dirty ? 'Unsaved' : 'Saved'} className={`h-1.5 w-1.5 rounded-full ${dirty ? 'bg-[hsl(var(--status-amber))]' : 'bg-[hsl(var(--status-green))]'}`} />
          <span className="text-[10px] text-[hsl(var(--muted-foreground))]">locally rendered</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={togglePane('editor')}
            title={showEditor ? 'Hide code editor' : 'Show code editor'}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))]"
          >
            {showEditor ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
            Code
          </button>
          <button
            onClick={openSearch}
            title="Search the document (Ctrl/⌘+F)"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))]"
          >
            <Search size={13} /> Find
          </button>
          <button
            onClick={togglePane('assets')}
            title={showAssets ? 'Hide assets panel' : 'Show assets panel'}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))] ${
              showAssets ? 'text-[hsl(var(--foreground))]' : 'text-[hsl(var(--muted-foreground))]'
            }`}
          >
            <Images size={13} /> Assets
          </button>
          <div className="mx-1 h-4 w-px bg-[hsl(var(--border))]" />
          <button
            onClick={exportSvg}
            disabled={exporting}
            title="Export SVG"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))] disabled:opacity-40"
          >
            <Image size={13} /> SVG
          </button>
          <button
            onClick={exportPdf}
            disabled={exporting}
            title="Export PDF"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wide hover:bg-[hsl(var(--accent))] disabled:opacity-40"
          >
            <FileDown size={13} /> PDF
          </button>
        </div>
      </div>
      {exportError && (
        <div className="flex shrink-0 items-center gap-3 border-b border-[hsl(var(--status-red))]/30 bg-[hsl(var(--status-red))]/10 px-3 py-1.5 text-xs text-[hsl(var(--status-red))]">
          <span className="min-w-0 flex-1 truncate" title={exportError}>{exportError}</span>
          <button type="button" onClick={() => setExportError(null)} className="shrink-0 rounded-md px-2 py-0.5 hover:bg-[hsl(var(--status-red))]/15">Dismiss</button>
        </div>
      )}
      {externalChange && <DiskChangeBar file={file} onReload={() => void reload()} onKeep={keepMine} />}

      {/* Editor | Preview | Assets.
          `contain: layout paint` on each pane keeps a width change from
          relayouting or repainting the other two: the preview's SVG in
          particular can be a very large subtree. */}
      <div ref={containerRef} className="relative flex min-h-0 flex-1">
        {showEditor && (
          <>
            <div
              ref={editorPaneRef}
              className="relative min-w-0 shrink-0 overflow-hidden"
              style={{ width: `${layout.editor}px`, contain: 'layout paint' }}
            >
              {searchOpen && !loading && (
                <TypstSearchPanel
                  source={source}
                  caret={getTypstCaret()}
                  onReveal={revealForSearch}
                  onReplaceSource={applySource}
                  onClose={closeSearch}
                />
              )}
              {loading ? (
                <div className="flex h-full items-center justify-center text-xs text-[hsl(var(--muted-foreground))]">Loading…</div>
              ) : (
                <TypstEditor value={source} onChange={setText} docKey={`${workspaceId}:${file}`} />
              )}
            </div>
            <PaneDivider onPointerDown={startResize('editor')} onDoubleClick={resetPane('editor')} />
          </>
        )}

        <div className="min-w-0 flex-1 overflow-hidden" style={{ contain: 'layout paint' }}>
          <TypstPreview source={source} revision={assetRevision} mainPath={`/${file}`} onRevealSource={revealSource} onRevealImage={revealImage} />
        </div>

        {showAssets && !assetsMax && (
          <>
            <PaneDivider onPointerDown={startResize('assets')} onDoubleClick={resetPane('assets')} />
            <div
              ref={assetsPaneRef}
              className="min-w-0 shrink-0 overflow-hidden"
              style={{ width: `${layout.assets}px`, contain: 'layout paint' }}
            >
              <TypstAssetsPanel
                source={source}
                onSourceChange={applySource}
                fullscreen={false}
                onToggleFullscreen={toggleAssetsMax}
                onHide={hideAssets}
                reveal={assetReveal}
              />
            </div>
          </>
        )}

        {/* Full-tab asset browser: an overlay, so the editor stays mounted
            and its caret and undo history survive. */}
        {showAssets && assetsMax && (
          <div className="absolute inset-0 z-20 bg-[hsl(var(--card))]">
            <TypstAssetsPanel
              source={source}
              onSourceChange={applySource}
              fullscreen
              onToggleFullscreen={toggleAssetsMax}
              onHide={hideAssets}
              reveal={assetReveal}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Drag handle between two panes.
 *
 * The visible rule is 1px but the grab area is padded out to 9px via a
 * transparent overlay: a 1px hit target is genuinely hard to grab, and
 * widening the rule itself would put a chunky line through the layout.
 */
function PaneDivider({
  onPointerDown,
  onDoubleClick,
}: {
  onPointerDown: (e: React.PointerEvent) => void;
  onDoubleClick: () => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      title="Drag to resize · double-click to reset"
      className="group relative w-px shrink-0 cursor-col-resize bg-[hsl(var(--border))]"
    >
      <div className="absolute inset-y-0 -left-1 -right-1 z-10 transition-colors group-hover:bg-[hsl(var(--primary))]/60" />
    </div>
  );
}

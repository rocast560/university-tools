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

import { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from 'react';
import { PanelLeftClose, PanelLeftOpen, FileDown, Image, FileText, Images, Search } from 'lucide-react';
import { useAppStore } from '@/stores';
import { useWorkspaceFile } from '@/hooks/use-workspace-file';
import {
  revealTypstRange, getTypstCaret, setTypstSearchRequest, setTypstEditorContent, setTypstDocKey,
} from './typst-editor-bridge';
import { DiskChangeBar } from './DiskChangeBar';
import { TypstPreview, type SourceCandidate } from './TypstPreview';
import { TypstAssetsPanel } from './TypstAssetsPanel';

// CodeMirror and its Typst grammar are ~500 KB -- most of this tab's
// JavaScript -- and the preview is what the operator looks at first. Loading
// the editor as its own chunk lets the toolbar, preview and assets rail paint
// while it arrives, and skips it entirely while the code pane is hidden. The
// tab drives it through typst-editor-bridge, never by importing it.
const TypstEditor = lazy(() => import('./TypstEditor').then((m) => ({ default: m.TypstEditor })));
// Only ever mounted behind Ctrl/Cmd+F.
const TypstSearchPanel = lazy(() => import('./TypstSearchPanel').then((m) => ({ default: m.TypstSearchPanel })));
import {
  compileTypstPdf,
  compileTypstSvg,
  setTypstFonts,
  setTypstShadowFiles,
  typstErrorMessage,
} from '@/lib/typst-compiler';
import { resolveAssetBytes } from '@/lib/typst-assets';
import { collectMounts } from '@/lib/typst-mount';
import { switchTrace } from '@/lib/perf';
import { matchAssetByHref } from '@/lib/asset-folders';
import { findSourceRange, type SourceRange } from '@/lib/typst-source-map';
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
 * Push the workspace's files into the compiler's virtual filesystem and font
 * set. `revision` changes whenever they do, so the preview recompiles after a
 * drop or a crop, not just on a source edit. `ready` is true once a sync has
 * completed against a detail that belongs to *this* workspace: until then the
 * preview must not compile, or the first render after a switch would run
 * before the images are mounted and a second compile would follow.
 *
 * The byte resolution lives in lib/typst-mount so the prefetcher warms the
 * very same caches; a sync whose inputs are already resident costs no request.
 */
function useTypstAssetSync(workspaceId: string, mainFile: string): { revision: number; ready: boolean } {
  const detail = useAppStore((s) => s.detail);
  const assets = useAppStore((s) => s.typstAssets);
  const files = detail?.files;
  const detailId = detail?.entry.id;
  const [state, setState] = useState<{ revision: number; readyFor: string | null }>({ revision: 0, readyFor: null });

  useEffect(() => {
    if (detailId !== workspaceId) return;
    let cancelled = false;
    void (async () => {
      const { shadow, fonts } = await collectMounts(workspaceId, assets, files, mainFile);
      if (cancelled) return;
      const filesChanged = setTypstShadowFiles(shadow);
      const fontsChanged = setTypstFonts(fonts);
      switchTrace.mark('assets');
      setState((s) => {
        const changed = filesChanged || fontsChanged;
        if (!changed && s.readyFor === workspaceId) return s;
        return { revision: changed ? s.revision + 1 : s.revision, readyFor: workspaceId };
      });
    })();
    return () => { cancelled = true; };
  }, [assets, files, mainFile, workspaceId, detailId]);

  return { revision: state.revision, ready: state.readyFor === workspaceId };
}

function TypstWorkspaceView({ workspaceId }: { workspaceId: string }) {
  // The document being edited: main.typ unless the header's switcher picks
  // another .typ from the workspace folder.
  const [file, setFile] = useState('main.typ');
  const { text: source, loading, dirty, externalChange, setText, reload, keepMine } =
    useWorkspaceFile(workspaceId, file);
  const detail = useAppStore((s) => s.detail);
  // Derived from the (stable) files array rather than selected directly: a
  // selector that builds a fresh array on every call has no stable snapshot
  // for useSyncExternalStore and would re-render forever. Keyed on `files`,
  // not `detail`, so a revalidation that only moved openedAt changes nothing.
  const detailFiles = detail?.files;
  const typFiles = useMemo(
    () => detailFiles?.filter((f) => f.path.endsWith('.typ')).map((f) => f.path) ?? [],
    [detailFiles],
  );
  const detailName = detail?.entry.name ?? 'document';
  // A different workspace starts at its own main.typ, or the first .typ file
  // when main.typ is absent (e.g. an opened folder without one). `detail` is
  // cleared to null the instant `workspaceId` changes and only repopulates
  // once the new workspace's files have loaded, so this waits for `detail`
  // before choosing and then applies the default once per workspace — a
  // later `typFiles` change from an unrelated detail reload (autosave, an
  // asset edit, ...) must not clobber a manual file switch.
  const defaultedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!detail || defaultedForRef.current === workspaceId) return;
    defaultedForRef.current = workspaceId;
    setFile(typFiles.includes('main.typ') || typFiles.length === 0 ? 'main.typ' : typFiles[0]!);
  }, [workspaceId, detail, typFiles]);

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
  const { revision: assetRevision, ready: assetsReady } = useTypstAssetSync(workspaceId, file);
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
  // The document the code pane is showing. The bridge scopes a reveal that is
  // waiting for the (lazily loaded) editor to this key, so switching files
  // cannot land a stale offset in the wrong text.
  const docKey = `${workspaceId}:${file}`;
  useEffect(() => { setTypstDocKey(docKey); }, [docKey]);

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
    }
    // No waiting on a frame: the bridge queues the reveal until the editor
    // registers, so this lands whether the pane was already open, mounts on
    // the next frame, or (the first time it is opened) is still downloading.
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

    // On the container, not <body>: an inherited property changed on <body>
    // forces a style recalculation of the whole document, which with a long
    // report mounted costs over a second before the drag even starts.
    container.style.userSelect = 'none';
    container.style.cursor = 'col-resize';

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
      container.style.userSelect = '';
      container.style.cursor = '';
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
                <Suspense fallback={null}>
                  <TypstSearchPanel
                    source={source}
                    caret={getTypstCaret()}
                    onReveal={revealForSearch}
                    onReplaceSource={applySource}
                    onClose={closeSearch}
                  />
                </Suspense>
              )}
              {loading ? (
                <div className="flex h-full items-center justify-center text-xs text-[hsl(var(--muted-foreground))]">Loading…</div>
              ) : (
                <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-[hsl(var(--muted-foreground))]">Loading…</div>}>
                  <TypstEditor value={source} onChange={setText} docKey={docKey} />
                </Suspense>
              )}
            </div>
            <PaneDivider onPointerDown={startResize('editor')} onDoubleClick={resetPane('editor')} />
          </>
        )}

        <div className="min-w-0 flex-1 overflow-hidden" style={{ contain: 'layout paint' }}>
          <TypstPreview source={source} revision={assetRevision} mainPath={`/${file}`} docKey={docKey} ready={!loading && assetsReady} onRevealSource={revealSource} onRevealImage={revealImage} />
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

// ─────────────────────────────────────────────────────────────────────────
// Handle on the live Typst code editor, for the parts of the tab that need to
// drive it without prop-drilling a ref through the split-pane tree: the
// preview's click-to-source, the find & replace panel, the assets rail's
// "insert #image(…) at the caret".
//
// This module holds *no* CodeMirror imports — not even a type — on purpose.
// TypstEditor is loaded as its own lazy chunk (CodeMirror and its lezer
// grammar are ~500 KB, most of the Typst tab's JavaScript), and a static
// import of anything inside it from TypstView or TypstAssetsPanel would pull
// that chunk straight back onto the tab's critical path. So the editor
// registers a small command interface here on mount, and every caller talks
// to the interface instead of to the view.
//
// The upshot: with the code pane hidden the editor's chunk is never
// downloaded at all, and with it shown the preview paints while CodeMirror
// is still arriving.
// ─────────────────────────────────────────────────────────────────────────

/** What TypstEditor can be asked to do. Implemented over its EditorView. */
export interface TypstEditorHandle {
  /** Select `[from, to)` and scroll it into view, optionally taking focus. */
  reveal(from: number, to: number, focus: boolean): void;
  /** Current caret offset. */
  caret(): number;
  /** Insert at the caret, replacing any selection. */
  insert(text: string): boolean;
  /** Replace the whole document as a minimal change. */
  setContent(next: string, echo: boolean): boolean;
}

let handle: TypstEditorHandle | null = null;

/**
 * The most recent reveal target, replayed onto whatever editor mounts next.
 *
 * Click-to-source and the search panel both open the code pane and then
 * immediately ask it to jump somewhere. The editor mounts asynchronously —
 * it is a lazy chunk, so on the first open that means a network round trip,
 * not a frame — and dropping the request would leave the user staring at a
 * pane that opened at the top of the file instead of at what they clicked.
 *
 * Deliberately *not* consumed when it is applied. React StrictMode
 * double-invokes effects in development: the editor mounts, is torn down at
 * once, and mounts again. A one-shot queue would be drained by the throwaway
 * first mount and the real one would come up at the top of the file. Keeping
 * it also means re-opening the pane returns to the last place the user
 * pointed at, rather than to line 1.
 *
 * Only the newest is kept, and it is scoped to `pendingDocKey` — a character
 * offset means nothing in a different file, so switching documents drops it.
 */
let pendingReveal: { from: number; to: number; focus: boolean } | null = null;
let pendingDocKey: string | null = null;

/** Which document the code pane is showing, as `<workspace>:<path>`. */
let currentDocKey: string | null = null;

/**
 * Announce the document the pane is showing. Switching files invalidates any
 * reveal still waiting for an editor: its offsets belong to the old text.
 */
export function setTypstDocKey(key: string): void {
  if (currentDocKey === key) return;
  currentDocKey = key;
  pendingReveal = null;
  pendingDocKey = null;
}

/**
 * Register (or, with null, unregister) the mounted editor.
 *
 * Replays the pending reveal, so a jump requested while the chunk was still
 * loading lands as soon as the editor exists.
 */
export function setTypstEditorHandle(next: TypstEditorHandle | null): void {
  handle = next;
  if (next && pendingReveal && pendingDocKey === currentDocKey) {
    next.reveal(pendingReveal.from, pendingReveal.to, pendingReveal.focus);
  }
}

/**
 * Unregister on unmount, but only if `own` is still the registered handle.
 *
 * A remount (the file switcher picking another .typ) tears the old editor
 * down around the new one; an unguarded clear in the old cleanup would
 * unregister the replacement that had already registered itself.
 */
export function clearTypstEditorHandle(own: TypstEditorHandle): void {
  if (handle === own) setTypstEditorHandle(null);
}

/**
 * Select `[from, to)` in the editor: the landing action for click-to-source
 * from the rendered preview, and for stepping through search matches.
 *
 * Returns false when no editor is mounted yet — the request is queued rather
 * than lost, so callers can treat false as "will happen shortly", not
 * "didn't happen".
 *
 * `focus` defaults to true (a preview click wants the caret in the editor to
 * type immediately). The search panel passes false so focus stays in its
 * input, letting Enter/Shift+Enter keep stepping through matches instead of
 * being swallowed by the editor.
 */
export function revealTypstRange(from: number, to: number, focus = true): boolean {
  // Recorded whether or not an editor is listening, so that a pane closed and
  // re-opened later comes back to this spot instead of to the top of the file.
  pendingReveal = { from, to, focus };
  pendingDocKey = currentDocKey;
  if (!handle) return false;
  handle.reveal(from, to, focus);
  return true;
}

/**
 * The current caret offset, so the search panel can start "find next" from
 * where the user actually is rather than the top of the document. Returns 0
 * when no editor is mounted.
 */
export function getTypstCaret(): number {
  return handle?.caret() ?? 0;
}

/**
 * Insert `text` at the caret, replacing any selection. Returns false when no
 * Typst editor is mounted (the code pane is hidden), so callers can fall
 * back to copying the snippet instead.
 */
export function insertAtTypstCursor(text: string): boolean {
  return handle?.insert(text) ?? false;
}

/**
 * Replace the whole document with `next` as a minimal change (common prefix
 * and suffix kept), so the caret and undo history survive a rewrite that only
 * touched one slot or one search match. Returns false when no editor is
 * mounted, so the caller can write the file directly instead.
 *
 * `echo: false` suppresses the resulting `onChange` and keeps the push out of
 * the undo history; `echo: true` — a real programmatic edit — stays undoable.
 */
export function setTypstEditorContent(next: string, echo = true): boolean {
  return handle?.setContent(next, echo) ?? false;
}

// Bridge for the in-editor Ctrl/⌘+F: CodeMirror's key handler runs inside the
// view, but the search *panel* is React state owned by TypstView. The view
// calls `requestTypstSearch` to ask the tab to open (and focus) the panel.
// Registered while the tab is mounted; a no-op otherwise.
let onSearchRequest: (() => void) | null = null;

export function setTypstSearchRequest(fn: (() => void) | null): void {
  onSearchRequest = fn;
}

export function requestTypstSearch(): void {
  onSearchRequest?.();
}

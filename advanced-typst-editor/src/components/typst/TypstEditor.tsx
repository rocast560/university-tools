// ─────────────────────────────────────────────────────────────────────────
// Raw-Typst code editor.
//
// A CodeMirror 6 instance over a plain string. The parent owns the text (see
// hooks/use-workspace-file.ts); edits flow up through onChange and external
// replacements flow down through the value prop.
//
// This module is the *only* one in the app that imports CodeMirror, and it is
// loaded as its own lazy chunk: the editor plus its lezer grammar is ~500 KB,
// the bulk of the Typst tab's JavaScript. Everything else drives the editor
// through the dependency-free command interface in typst-editor-bridge.ts,
// which this component registers on mount.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, memo } from 'react';
import { Annotation, EditorState, Transaction } from '@codemirror/state';
import {
  EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, keymap,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { highlightSelectionMatches } from '@codemirror/search';
import { typstLanguage, typstHighlightExtension } from '@/lib/typst-language';
import {
  clearTypstEditorHandle,
  requestTypstSearch,
  setTypstEditorHandle,
  type TypstEditorHandle,
} from './typst-editor-bridge';

// Editor chrome themed off the app's CSS variables so it matches both light
// and dark modes and the active accent.
const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: 'transparent',
      color: 'hsl(var(--foreground))',
      fontSize: '13px',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      lineHeight: '1.6',
      overflow: 'auto',
    },
    '.cm-content': { caretColor: 'hsl(var(--foreground))' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'hsl(var(--muted-foreground) / 0.6)',
      border: 'none',
    },
    '.cm-activeLine': { backgroundColor: 'hsl(var(--muted) / 0.45)' },
    '.cm-activeLineGutter': {
      backgroundColor: 'hsl(var(--muted) / 0.45)',
      color: 'hsl(var(--foreground))',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'hsl(var(--foreground))' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'hsl(var(--primary) / 0.25)',
    },

    // ── Ctrl/⌘+F search panel ──
    // CodeMirror's panel ships with light-mode defaults that are unreadable
    // against the app's dark chrome, so restyle it off the same CSS vars as
    // everything else.
    '.cm-panels': {
      backgroundColor: 'hsl(var(--card))',
      color: 'hsl(var(--foreground))',
      borderTop: '1px solid hsl(var(--border))',
    },
    '.cm-panel.cm-search': { padding: '6px 8px', fontSize: '11px' },
    '.cm-panel.cm-search label': {
      fontSize: '10px',
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      color: 'hsl(var(--muted-foreground))',
    },
    '.cm-panel.cm-search input[type=text]': {
      backgroundColor: 'hsl(var(--background))',
      color: 'hsl(var(--foreground))',
      border: '1px solid hsl(var(--border))',
      borderRadius: '4px',
      padding: '2px 6px',
      fontSize: '11px',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    },
    '.cm-panel.cm-search input[type=text]:focus': {
      outline: 'none',
      borderColor: 'hsl(var(--primary))',
    },
    '.cm-panel.cm-search button': {
      backgroundColor: 'transparent',
      backgroundImage: 'none',
      color: 'hsl(var(--foreground))',
      border: '1px solid hsl(var(--border))',
      borderRadius: '4px',
      padding: '2px 7px',
      margin: '0 2px',
      fontSize: '10px',
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      cursor: 'pointer',
    },
    '.cm-panel.cm-search button:hover': { backgroundColor: 'hsl(var(--accent))' },
    '.cm-panel.cm-search button[name=close]': {
      border: 'none',
      fontSize: '15px',
      padding: '0 6px',
      color: 'hsl(var(--muted-foreground))',
    },
    // Match highlighting: the active match needs to beat the selection layer.
    '.cm-searchMatch': {
      backgroundColor: 'hsl(var(--status-purple) / 0.3)',
      outline: '1px solid hsl(var(--status-purple) / 0.5)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'hsl(var(--primary) / 0.55)',
    },
    '.cm-selectionMatch': { backgroundColor: 'hsl(var(--foreground) / 0.12)' },
  },
  { dark: true },
);

/**
 * Select `[from, to)` and scroll it into view: the landing action for
 * click-to-source from the rendered preview.
 *
 * Centers the target rather than scrolling it to the top edge, so the
 * surrounding context stays visible.
 */
function revealIn(view: EditorView, from: number, to: number, focus: boolean): void {
  const max = view.state.doc.length;
  const anchor = Math.min(Math.max(from, 0), max);
  const head = Math.min(Math.max(to, 0), max);
  view.dispatch({
    selection: { anchor, head },
    effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
  });
  if (focus) view.focus();
}

/** Insert `text` at the caret, replacing any selection. */
function insertIn(view: EditorView, text: string): boolean {
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/**
 * Marks a transaction that only pushes the parent's own `value` back into the
 * view (a reload from disk, an MCP/VS Code edit). The parent already holds
 * that exact string, so echoing it back through `onChange` would flag the
 * buffer dirty and autosave it straight back to the server -- an external edit
 * would answer itself with a redundant write, and a second tab watching the
 * same file would see that write as "changed on disk while you have unsaved
 * edits". Programmatic *edits* (slot placement, replace-all) deliberately do
 * not carry it: those are real changes the parent has yet to see.
 *
 * Such a push is also kept out of the undo history (`Transaction.addToHistory`
 * is false alongside it): an undoable external edit is the same overwrite by
 * another route, since one Ctrl+Z would replace it through a plain transaction
 * that *does* report through `onChange` and autosave the pre-external text back.
 */
const fromParentValue = Annotation.define<boolean>();

/**
 * Replace the whole document with `next` as a minimal change (common prefix
 * and suffix kept), so the caret and undo history survive a rewrite that only
 * touched one slot or one search match.
 *
 * `echo: false` suppresses the resulting `onChange` and keeps the push out of
 * the undo history (see `fromParentValue`); `echo: true` -- a real programmatic
 * edit -- stays undoable.
 */
function setContentIn(view: EditorView, next: string, echo: boolean): boolean {
  const cur = view.state.doc.toString();
  if (cur === next) return true;
  let start = 0;
  while (start < cur.length && start < next.length && cur[start] === next[start]) start++;
  let endCur = cur.length, endNext = next.length;
  while (endCur > start && endNext > start && cur[endCur - 1] === next[endNext - 1]) { endCur--; endNext--; }
  view.dispatch({
    changes: { from: start, to: endCur, insert: next.slice(start, endNext) },
    annotations: echo ? undefined : [fromParentValue.of(true), Transaction.addToHistory.of(false)],
  });
  return true;
}

export const TypstEditor = memo(function TypstEditor({ value, onChange, docKey }: { value: string; onChange: (next: string) => void; docKey: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), EditorView.lineWrapping, EditorState.tabSize.of(2),
          history(), typstLanguage(), typstHighlightExtension, editorTheme, highlightSelectionMatches(),
          keymap.of([
            { key: 'Mod-f', preventDefault: true, run: () => { requestTypstSearch(); return true; } },
            ...historyKeymap, ...defaultKeymap, indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            if (u.transactions.some((tr) => tr.annotation(fromParentValue))) return;
            onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    // Publish the editor to the rest of the tab. Registering flushes any
    // reveal that was requested while this (lazily loaded) chunk was still
    // on its way — a preview click that opened a hidden code pane.
    const handle: TypstEditorHandle = {
      reveal: (from, to, focus) => revealIn(view, from, to, focus),
      caret: () => view.state.selection.main.head,
      insert: (text) => insertIn(view, text),
      setContent: (next, echo) => setContentIn(view, next, echo),
    };
    setTypstEditorHandle(handle);
    return () => {
      clearTypstEditorHandle(handle);
      viewRef.current = null;
      view.destroy();
    };
    // A new document (workspace/file switch) remounts; typing does not (value is only read at mount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // The parent's text changed under us (a reload from disk after an MCP or
  // VS Code edit): apply it as one transaction, without echoing it back as an
  // edit the parent then has to save again.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    setContentIn(view, value, false);
  }, [value]);

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />;
});

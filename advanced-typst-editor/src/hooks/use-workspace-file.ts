import { useCallback, useEffect, useRef, useState } from 'react';
import { api, CLIENT_ID } from '@/api/client';
import { createAutosave } from '@/lib/autosave';
import { switchTrace } from '@/lib/perf';
import { docKeyOf, textCache } from '@/lib/workspace-cache';
import { useAppStore } from '@/stores';

export const AUTOSAVE_MS = 500;

interface FileState {
  key: string;
  text: string;
  loading: boolean;
  dirty: boolean;
  externalChange: boolean;
}

/** The state a document starts in: its cached text at once, or empty and loading. */
function initialState(key: string): FileState {
  const cached = textCache.get(key);
  return { key, text: cached?.text ?? '', loading: !cached, dirty: false, externalChange: false };
}

/**
 * One text file of the active workspace: loaded from the API, edited locally,
 * autosaved 500 ms after the last change, on blur and on pagehide. A
 * `workspace.changed` event naming this file from another origin reloads it
 * when the buffer is clean and raises `externalChange` when it is dirty.
 *
 * A document opened before this session is shown from `textCache` in the
 * same render that switches to it (no loading state, no frame of the previous
 * document's text under the new key), and the server is asked with
 * `If-None-Match` whether it moved on; a 304 costs nothing, a 200 replaces
 * the text while the buffer is still clean.
 */
export function useWorkspaceFile(workspaceId: string, path: string) {
  const key = docKeyOf(workspaceId, path);
  const [state, setState] = useState<FileState>(() => initialState(key));
  // Derived state: a new key means a new document, presented now rather than
  // after an effect, so nothing downstream ever sees the old text with the
  // new key. React re-renders before committing when state is set here.
  if (state.key !== key) setState(initialState(key));
  const shown = state.key === key ? state : initialState(key);

  const saver = useRef(createAutosave({ delayMs: AUTOSAVE_MS, save: async () => undefined }));
  const lastChange = useAppStore((s) => s.lastChange);
  const seenSeq = useRef(0);

  const load = useCallback(async (ifNoneMatch: string | null = null) => {
    let r: { text: string; etag: string } | null;
    try {
      r = await api.readText(workspaceId, path, ifNoneMatch);
    } catch {
      setState((s) => (s.key === key ? { ...s, loading: false } : s));
      return;
    }
    if (r === null) { switchTrace.mark('source'); return; } // 304: what we show is current
    const fresh = r;
    textCache.set(key, { text: fresh.text, etag: fresh.etag });
    setState((s) => {
      if (s.key !== key) return s;
      // Edits already made on top of the cached copy: keep them and flag the
      // disk copy as changed underneath, unless it is the very same text.
      if (s.dirty) return fresh.text === s.text ? s : { ...s, externalChange: true };
      return { ...s, text: fresh.text, loading: false, dirty: false, externalChange: false };
    });
    switchTrace.mark('source');
  }, [workspaceId, path, key]);

  useEffect(() => {
    saver.current = createAutosave({
      delayMs: AUTOSAVE_MS,
      save: async (t, keepalive) => {
        const etag = await api.writeText(workspaceId, path, t, keepalive);
        textCache.set(key, { text: t, etag });
        setState((s) => (s.key === key ? { ...s, dirty: false } : s));
      },
    });
    const cached = textCache.get(key);
    if (cached) switchTrace.mark('source');
    // A null etag means a save of this very text is still on its way to the
    // server: what we hold is newer than anything a read could return.
    if (!cached || cached.etag !== null) void load(cached?.etag ?? null);
    const s = saver.current;
    // pagehide is the last chance to save: ask for a keepalive request so the
    // browser is allowed to finish it after the document is gone. blur is not
    // an unload (and fires constantly), so it saves the ordinary way.
    const onPagehide = () => { void s.flush(true); };
    const onBlur = () => { void s.flush(); };
    window.addEventListener('pagehide', onPagehide);
    window.addEventListener('blur', onBlur);
    return () => { void s.flush(); s.dispose(); window.removeEventListener('pagehide', onPagehide); window.removeEventListener('blur', onBlur); };
  }, [workspaceId, path, key, load]);

  // External edits (MCP, VS Code, restore): reload when clean, ask when dirty.
  useEffect(() => {
    if (!lastChange || lastChange.seq === seenSeq.current) return;
    seenSeq.current = lastChange.seq;
    if (lastChange.id !== workspaceId || !lastChange.paths.includes(path)) return;
    if (lastChange.origin === CLIENT_ID) return;
    if (saver.current.dirty() || shown.dirty) setState((s) => (s.key === key ? { ...s, externalChange: true } : s));
    else void load();
  }, [lastChange, workspaceId, path, key, shown.dirty, load]);

  const setText = useCallback((next: string) => {
    // The cache follows the buffer so a switch away and back shows the edit;
    // its etag is unknown until the save reports one.
    textCache.set(key, { text: next, etag: null });
    setState((s) => (s.key === key ? { ...s, text: next, dirty: true } : s));
    saver.current.change(next);
  }, [key]);
  const flush = useCallback(() => saver.current.flush(), []);
  const reload = useCallback(() => load(), [load]);
  const keepMine = useCallback(() => {
    setState((s) => (s.key === key ? { ...s, externalChange: false } : s));
    void saver.current.flush();
  }, [key]);

  return { text: shown.text, loading: shown.loading, dirty: shown.dirty, externalChange: shown.externalChange, setText, flush, reload, keepMine };
}

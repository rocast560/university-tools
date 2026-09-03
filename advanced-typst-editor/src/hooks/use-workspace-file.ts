import { useCallback, useEffect, useRef, useState } from 'react';
import { api, CLIENT_ID } from '@/api/client';
import { createAutosave } from '@/lib/autosave';
import { useAppStore } from '@/stores';

export const AUTOSAVE_MS = 500;

/**
 * One text file of the active workspace: loaded from the API, edited locally,
 * autosaved 500 ms after the last change, on blur and on pagehide. A
 * `workspace.changed` event naming this file from another origin reloads it
 * when the buffer is clean and raises `externalChange` when it is dirty.
 */
export function useWorkspaceFile(workspaceId: string, path: string) {
  const [text, setTextState] = useState('');
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const saver = useRef(createAutosave({ delayMs: AUTOSAVE_MS, save: async (t, keepalive) => { await api.writeText(workspaceId, path, t, keepalive); } }));
  const lastChange = useAppStore((s) => s.lastChange);
  const seenSeq = useRef(0);

  const load = useCallback(async () => {
    const r = await api.readText(workspaceId, path);
    setTextState(r.text);
    setDirty(false);
    setExternalChange(false);
  }, [workspaceId, path]);

  useEffect(() => {
    saver.current = createAutosave({ delayMs: AUTOSAVE_MS, save: async (t, keepalive) => { await api.writeText(workspaceId, path, t, keepalive); setDirty(false); } });
    setLoading(true);
    void load().finally(() => setLoading(false));
    const s = saver.current;
    // pagehide is the last chance to save: ask for a keepalive request so the
    // browser is allowed to finish it after the document is gone. blur is not
    // an unload (and fires constantly), so it saves the ordinary way.
    const onPagehide = () => { void s.flush(true); };
    const onBlur = () => { void s.flush(); };
    window.addEventListener('pagehide', onPagehide);
    window.addEventListener('blur', onBlur);
    return () => { void s.flush(); s.dispose(); window.removeEventListener('pagehide', onPagehide); window.removeEventListener('blur', onBlur); };
  }, [workspaceId, path, load]);

  // External edits (MCP, VS Code, restore): reload when clean, ask when dirty.
  useEffect(() => {
    if (!lastChange || lastChange.seq === seenSeq.current) return;
    seenSeq.current = lastChange.seq;
    if (lastChange.id !== workspaceId || !lastChange.paths.includes(path)) return;
    if (lastChange.origin === CLIENT_ID) return;
    if (saver.current.dirty() || dirty) setExternalChange(true);
    else void load();
  }, [lastChange, workspaceId, path, dirty, load]);

  const setText = useCallback((next: string) => { setTextState(next); setDirty(true); saver.current.change(next); }, []);
  const flush = useCallback(() => saver.current.flush(), []);
  const keepMine = useCallback(() => { setExternalChange(false); void saver.current.flush(); }, []);

  return { text, loading, dirty, externalChange, setText, flush, reload: load, keepMine };
}

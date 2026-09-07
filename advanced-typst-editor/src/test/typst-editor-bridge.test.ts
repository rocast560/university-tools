import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setTypstEditorHandle,
  clearTypstEditorHandle,
  revealTypstRange,
  getTypstCaret,
  insertAtTypstCursor,
  setTypstEditorContent,
  setTypstSearchRequest,
  requestTypstSearch,
  setTypstDocKey,
  type TypstEditorHandle,
} from '@/components/typst/typst-editor-bridge';

function fakeHandle() {
  const reveal = vi.fn<(from: number, to: number, focus: boolean) => void>();
  const insert = vi.fn<(text: string) => boolean>(() => true);
  const setContent = vi.fn<(next: string, echo: boolean) => boolean>(() => true);
  const handle: TypstEditorHandle = { reveal, caret: () => 42, insert, setContent };
  return { handle, reveal, insert, setContent };
}

beforeEach(() => {
  setTypstEditorHandle(null);
  setTypstSearchRequest(null);
  // A fresh document per test, so a leftover reveal cannot cross between them.
  setTypstDocKey(`doc-${Math.random()}`);
});

describe('typst editor bridge', () => {
  it('reports "no editor" for edit commands when none is mounted', () => {
    expect(insertAtTypstCursor('#image("/a.png")')).toBe(false);
    expect(setTypstEditorContent('hello')).toBe(false);
    expect(getTypstCaret()).toBe(0);
  });

  it('forwards to the registered handle', () => {
    const { handle, reveal, insert, setContent } = fakeHandle();
    setTypstEditorHandle(handle);

    expect(getTypstCaret()).toBe(42);
    expect(insertAtTypstCursor('x')).toBe(true);
    expect(insert).toHaveBeenCalledWith('x');

    expect(setTypstEditorContent('doc', false)).toBe(true);
    expect(setContent).toHaveBeenCalledWith('doc', false);
    expect(setTypstEditorContent('doc')).toBe(true);
    expect(setContent).toHaveBeenLastCalledWith('doc', true);

    revealTypstRange(3, 9);
    expect(reveal).toHaveBeenCalledWith(3, 9, true);
  });

  // The reason the bridge exists: TypstEditor is a lazy chunk, so a preview
  // click that reveals a hidden code pane fires before CodeMirror has even
  // downloaded. The reveal has to wait for the editor, not be dropped.
  it('queues a reveal requested before the editor mounts and flushes it on register', () => {
    expect(revealTypstRange(5, 12)).toBe(false);

    const { handle, reveal } = fakeHandle();
    setTypstEditorHandle(handle);
    expect(reveal).toHaveBeenCalledWith(5, 12, true);
  });

  it('keeps only the newest queued reveal', () => {
    revealTypstRange(1, 2);
    revealTypstRange(7, 8, false);

    const { handle, reveal } = fakeHandle();
    setTypstEditorHandle(handle);
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledWith(7, 8, false);
  });

  // Offsets belong to the text they were measured in, so a reveal waiting for
  // an editor must not fire into a different file.
  it('drops a pending reveal when the document changes', () => {
    setTypstDocKey('ws:main.typ');
    revealTypstRange(1, 2);
    setTypstDocKey('ws:chapter.typ');

    const { handle, reveal } = fakeHandle();
    setTypstEditorHandle(handle);
    expect(reveal).not.toHaveBeenCalled();
  });

  it('replays the last reveal when the same document\'s pane is re-opened', () => {
    setTypstDocKey('ws:main.typ');
    const open = fakeHandle();
    setTypstEditorHandle(open.handle);
    revealTypstRange(4, 6);
    expect(open.reveal).toHaveBeenCalledWith(4, 6, true);

    // Hiding the code pane unmounts the editor; showing it mounts a new one.
    clearTypstEditorHandle(open.handle);
    const reopened = fakeHandle();
    setTypstEditorHandle(reopened.handle);
    expect(reopened.reveal).toHaveBeenCalledWith(4, 6, true);
  });

  // A file switch tears the outgoing editor down around the incoming one, so
  // an unguarded clear in the old cleanup would unregister its replacement.
  it('only unregisters the handle that is still current', () => {
    const outgoing = fakeHandle();
    const incoming = fakeHandle();
    setTypstEditorHandle(outgoing.handle);
    setTypstEditorHandle(incoming.handle);

    clearTypstEditorHandle(outgoing.handle);
    expect(insertAtTypstCursor('still here')).toBe(true);
    expect(incoming.insert).toHaveBeenCalledWith('still here');

    clearTypstEditorHandle(incoming.handle);
    expect(insertAtTypstCursor('gone')).toBe(false);
  });

  // React StrictMode double-invokes effects in development: the editor mounts,
  // is torn down immediately, and mounts again. A queue consumed by the
  // throwaway first mount strands the reveal -- the user clicks the preview
  // with the code pane shut and the pane opens at the top of the file instead.
  it('still reveals when StrictMode remounts the editor', () => {
    revealTypstRange(5, 12);

    const first = fakeHandle();
    setTypstEditorHandle(first.handle);
    expect(first.reveal).toHaveBeenCalledWith(5, 12, true);
    clearTypstEditorHandle(first.handle);

    const second = fakeHandle();
    setTypstEditorHandle(second.handle);
    expect(second.reveal).toHaveBeenCalledWith(5, 12, true);
  });

  it('routes the editor\'s Ctrl+F back to the tab, and is a no-op once unregistered', () => {
    const onSearch = vi.fn();
    setTypstSearchRequest(onSearch);
    requestTypstSearch();
    expect(onSearch).toHaveBeenCalledTimes(1);

    setTypstSearchRequest(null);
    expect(() => requestTypstSearch()).not.toThrow();
    expect(onSearch).toHaveBeenCalledTimes(1);
  });
});

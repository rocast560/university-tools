import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StrictMode } from 'react';
import { render, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { TypstEditor } from '@/components/typst/TypstEditor';
import {
  revealTypstRange,
  showTypstPreviewHighlight,
  setTypstDocKey,
  setTypstEditorHandle,
} from '@/components/typst/typst-editor-bridge';

const viewIn = (container: HTMLElement): EditorView => {
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement);
  if (!view) throw new Error('no CodeMirror view mounted');
  return view;
};

const DOC = '= Report\n\n#let department = "Information Technology"\n';
const FROM = DOC.indexOf('Information');
const TO = FROM + 'Information Technology'.length;

// jsdom has no layout: CodeMirror's own measuring (it runs on a frame, after a test may have ended)
// needs these on Range, as it does in any browser. Without them a late frame throws an uncaught error.
{
  const proto = Range.prototype as Partial<Range>;
  if (!proto.getClientRects) proto.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  if (!proto.getBoundingClientRect) proto.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() { return {}; } }) as DOMRect;
}

beforeEach(() => setTypstEditorHandle(null));

/**
 * Click-to-source with the code pane shut: TypstView flips the pane visible
 * and asks for the jump in the same handler, but the editor is a lazy chunk,
 * so on the first open it is still being fetched. The reveal therefore has to
 * survive until an editor exists — which is the whole reason the bridge holds
 * it rather than firing and forgetting.
 */
describe('reveal into a not-yet-mounted editor', () => {
  it('applies a reveal that was requested before the editor existed', () => {
    setTypstDocKey('ws:main.typ');
    expect(revealTypstRange(FROM, TO)).toBe(false);

    const { container } = render(
      <TypstEditor value={DOC} onChange={() => {}} docKey="ws:main.typ" />,
    );

    const sel = viewIn(container).state.selection.main;
    expect([sel.anchor, sel.head]).toEqual([FROM, TO]);
  });

  // The regression this guards: StrictMode mounts the editor, tears it down and
  // mounts it again. A reveal consumed by the throwaway first mount left the
  // real editor sitting at the top of the file.
  it('survives a StrictMode double mount', () => {
    setTypstDocKey('ws:strict.typ');
    revealTypstRange(FROM, TO);

    const { container } = render(
      <StrictMode>
        <TypstEditor value={DOC} onChange={() => {}} docKey="ws:strict.typ" />
      </StrictMode>,
    );

    const sel = viewIn(container).state.selection.main;
    expect([sel.anchor, sel.head]).toEqual([FROM, TO]);
  });

  it('leaves the editor alone when the reveal belonged to another document', () => {
    setTypstDocKey('ws:other.typ');
    revealTypstRange(FROM, TO);
    setTypstDocKey('ws:main.typ');

    const { container } = render(
      <TypstEditor value={DOC} onChange={() => {}} docKey="ws:main.typ" />,
    );

    const sel = viewIn(container).state.selection.main;
    expect([sel.anchor, sel.head]).toEqual([0, 0]);
  });
});

/**
 * A long jump in a wrapped document lands on height estimates for lines that
 * were never measured, so the first scroll can stop hundreds of lines short
 * (seen on a 23-page report: ~180 lines above the viewport). After the view
 * has measured, the reveal checks where the target really is and scrolls
 * again, at most twice.
 */
describe('reveal correction after measuring', () => {
  const mountLive = () => {
    setTypstDocKey('ws:live.typ');
    const { container } = render(<TypstEditor value={DOC} onChange={() => {}} docKey="ws:live.typ" />);
    return viewIn(container);
  };
  const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

  it('re-issues the scroll, at most twice, while the target is outside the scroller', async () => {
    const view = mountLive();
    vi.spyOn(view.scrollDOM, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 300, left: 0, right: 400, width: 400, height: 300, x: 0, y: 0, toJSON() { return {}; } });
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ top: -3828, bottom: -3810, left: 0, right: 5 });
    const dispatch = vi.spyOn(view, 'dispatch');
    expect(revealTypstRange(FROM, TO)).toBe(true);
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(3));
    await frames(); await frames(); await frames();
    // One dispatch for the reveal itself plus two corrective scrolls.
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it('does not scroll again when the target is already visible', async () => {
    const view = mountLive();
    vi.spyOn(view.scrollDOM, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 300, left: 0, right: 400, width: 400, height: 300, x: 0, y: 0, toJSON() { return {}; } });
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ top: 140, bottom: 158, left: 0, right: 5 });
    const dispatch = vi.spyOn(view, 'dispatch');
    revealTypstRange(FROM, TO);
    await frames(); await frames();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

/**
 * The preview-selection mark (phase 2): the passage a highlight in the preview maps to is shown
 * in the editor as a transient mark. It must never touch the caret, the selection or focus: the
 * operator is working in the preview, and Ctrl+C there must still copy the preview's text.
 */
describe('preview-selection highlight', () => {
  const mountLive = () => {
    setTypstDocKey('ws:hl.typ');
    const { container } = render(<TypstEditor value={DOC} onChange={() => {}} docKey="ws:hl.typ" />);
    return { view: viewIn(container), container };
  };
  const marks = (c: HTMLElement) => Array.from(c.querySelectorAll('.cm-previewSelection')).map((n) => n.textContent).join('');

  it('adds and clears the mark without changing the selection or focus', async () => {
    const { view, container } = mountLive();
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    view.dispatch({ selection: { anchor: 3 } });
    const before = view.state.selection.main.toJSON();

    expect(showTypstPreviewHighlight({ from: FROM, to: TO, approximate: false })).toBe(true);
    await waitFor(() => expect(marks(container)).toBe('Information Technology'));
    expect(view.state.selection.main.toJSON()).toEqual(before);
    expect(view.hasFocus).toBe(false);
    expect(document.activeElement).toBe(outside);

    expect(showTypstPreviewHighlight(null)).toBe(true);
    await waitFor(() => expect(marks(container)).toBe(''));
    expect(view.state.selection.main.toJSON()).toEqual(before);
    expect(document.activeElement).toBe(outside);
  });

  it('marks an approximate range differently, and moves the mark with edits', async () => {
    const { view, container } = mountLive();
    showTypstPreviewHighlight({ from: FROM, to: TO, approximate: true });
    await waitFor(() => expect(container.querySelector('.cm-previewSelection.cm-previewSelection-approx')).not.toBeNull());
    view.dispatch({ changes: { from: 0, insert: 'XX' } });
    await waitFor(() => expect(marks(container)).toBe('Information Technology'));
  });

  it('returns false with no editor mounted and does not queue a scroll or open anything', () => {
    setTypstEditorHandle(null);
    expect(showTypstPreviewHighlight({ from: 1, to: 2, approximate: false })).toBe(false);
  });

  it('scrolls an off-screen range into view, checking after render, without moving the caret', async () => {
    const { view } = mountLive();
    vi.spyOn(view.scrollDOM, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 300, left: 0, right: 400, width: 400, height: 300, x: 0, y: 0, toJSON() { return {}; } });
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ top: -3828, bottom: -3810, left: 0, right: 5 });
    const dispatch = vi.spyOn(view, 'dispatch');
    const caret = view.state.selection.main.head;
    showTypstPreviewHighlight({ from: FROM, to: TO, approximate: false });
    await waitFor(() => expect(dispatch.mock.calls.length).toBeGreaterThanOrEqual(2));
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r())))));
    // The reveal itself plus at most two corrective scrolls.
    expect(dispatch.mock.calls.length).toBeLessThanOrEqual(3);
    expect(view.state.selection.main.head).toBe(caret);
  });

  it('does not scroll a range that is already visible', async () => {
    const { view } = mountLive();
    vi.spyOn(view.scrollDOM, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 300, left: 0, right: 400, width: 400, height: 300, x: 0, y: 0, toJSON() { return {}; } });
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ top: 140, bottom: 158, left: 0, right: 5 });
    const dispatch = vi.spyOn(view, 'dispatch');
    showTypstPreviewHighlight({ from: FROM, to: TO, approximate: false });
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    expect(dispatch).toHaveBeenCalledTimes(1); // just the mark
  });
});

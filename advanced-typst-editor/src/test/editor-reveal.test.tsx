import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StrictMode } from 'react';
import { render, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { TypstEditor } from '@/components/typst/TypstEditor';
import {
  revealTypstRange,
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

import { describe, it, expect, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { render } from '@testing-library/react';
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

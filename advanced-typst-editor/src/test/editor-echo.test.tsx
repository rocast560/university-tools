import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { undo, undoDepth } from '@codemirror/commands';
import { TypstEditor, setTypstEditorContent } from '@/components/typst/TypstEditor';

const viewIn = (container: HTMLElement): EditorView => {
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement);
  if (!view) throw new Error('no CodeMirror view mounted');
  return view;
};

/**
 * An external edit (MCP, VS Code, "reload from disk") reaches the editor as a
 * new `value` prop. That must NOT come back out through `onChange`: the parent
 * already holds the string, and treating it as a user edit marks the buffer
 * dirty and autosaves it straight back -- which also makes a second tab
 * watching the file show "changed on disk while you have unsaved edits".
 *
 * Programmatic *edits* (slot placement, replace-all) go through
 * `setTypstEditorContent` and must still report, because the parent has not
 * seen them yet.
 */
describe('TypstEditor change echo', () => {
  it('does not report a doc change that came from the value prop', () => {
    const onChange = vi.fn();
    const { rerender } = render(<TypstEditor value="= one" onChange={onChange} docKey="w:main.typ" />);
    expect(onChange).not.toHaveBeenCalled();

    rerender(<TypstEditor value="= two" onChange={onChange} docKey="w:main.typ" />);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports a programmatic rewrite through setTypstEditorContent', () => {
    const onChange = vi.fn();
    render(<TypstEditor value="= one" onChange={onChange} docKey="w2:main.typ" />);

    expect(setTypstEditorContent('= one, edited')).toBe(true);
    expect(onChange).toHaveBeenCalledWith('= one, edited');
  });

  /**
   * Suppressing the echo is not enough on its own: if the external edit lands
   * in the undo history, one Ctrl+Z rolls it back through an ordinary
   * transaction, which *does* report through onChange -- and the autosave then
   * writes the pre-external text straight back over someone else's edit. The
   * exact thing the echo suppression exists to prevent, via undo.
   */
  it('does not put a value-prop push into the undo history', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<TypstEditor value="= one" onChange={onChange} docKey="w3:main.typ" />);
    const view = viewIn(container);

    rerender(<TypstEditor value="= two" onChange={onChange} docKey="w3:main.typ" />);
    expect(view.state.doc.toString()).toBe('= two');
    expect(undoDepth(view.state)).toBe(0);

    undo(view);
    expect(view.state.doc.toString()).toBe('= two');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps a programmatic rewrite undoable', () => {
    const onChange = vi.fn();
    const { container } = render(<TypstEditor value="= one" onChange={onChange} docKey="w4:main.typ" />);
    const view = viewIn(container);

    expect(setTypstEditorContent('= one, edited')).toBe(true);
    expect(undoDepth(view.state)).toBe(1);

    undo(view);
    expect(view.state.doc.toString()).toBe('= one');
  });
});

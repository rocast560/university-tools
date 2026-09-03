import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { TypstEditor, setTypstEditorContent } from '@/components/typst/TypstEditor';

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
});

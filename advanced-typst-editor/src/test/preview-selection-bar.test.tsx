import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PreviewSelectionBar } from '@/components/typst/PreviewSelectionBar';

const noop = vi.fn();

// With the code pane open the preview can be ~345 px wide, narrower than the
// bar with three buttons and the "approximate" note. Clamping the position is
// then not enough: the bar has to wrap inside the pane instead of being cut
// off at its edge (seen in the real app on 2026-10-17).
describe('PreviewSelectionBar', () => {
  it('never grows wider than the pane it sits in, and may wrap', () => {
    render(
      <PreviewSelectionBar
        anchor={{ x: 150, below: 40, above: 10 }}
        bounds={{ w: 200, h: 400 }}
        approximate
        canSource
        canSelect
        copied={null}
        onCopy={noop}
        onCopySource={noop}
        onSelect={noop}
      />,
    );
    const bar = screen.getByTestId('preview-selection-bar');
    expect(bar.style.maxWidth).toBe('192px');
    expect(bar.className).toContain('flex-wrap');
    expect(bar.className).not.toContain('whitespace-nowrap');
    // Labels themselves stay on one line each.
    for (const b of Array.from(bar.querySelectorAll('button'))) expect(b.className).toContain('whitespace-nowrap');
  });
});

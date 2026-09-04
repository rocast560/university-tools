import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useAppStore } from '@/stores';
import { PlaceScreenshotDialog } from '@/components/typst/PlaceScreenshotDialog';
import type { TypstAsset } from '@/types';

const asset: TypstAsset = { id: 'assets/a.png', kind: 'image', filename: 'a.png', mime: 'image/png', size: 1, etag: '1-1', folderId: null, createdAt: 0, updatedAt: 0, width: 10, height: 10, crop: null, blurs: null };

beforeEach(() => { useAppStore.setState({ redaction: { style: 'pixelate', strength: 2 } }); });

describe('PlaceScreenshotDialog redaction defaults', () => {
  it('starts in the configured style', () => {
    render(<PlaceScreenshotDialog asset={asset} source="= x" onApply={() => {}} onUnplace={() => {}} onAddSlot={() => {}} onRename={async () => 'a.png'} onClose={() => {}} hidePlacement />);
    // BTCT's dialog does not expose aria-pressed on the style buttons, and
    // they only render once blur-drawing mode is on, so turn that on first
    // (the toggle is titled "Draw rectangles..." for an encodable format like
    // png), then find the style button whose "selected" class is applied.
    fireEvent.click(screen.getByTitle(/draw rectangles over sensitive content/i));
    const styleButtons = [screen.getByTitle('Smooth gaussian blur'), screen.getByTitle('Hard mosaic blocks')];
    const selected = styleButtons.find((b) => b.className.includes('bg-[hsl(var(--primary))]'));
    expect(selected?.textContent ?? '').toMatch(/pixel/i);
  });
});

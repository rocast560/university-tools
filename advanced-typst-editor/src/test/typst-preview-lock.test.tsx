import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';

// Same harness as typst-preview-pages.test.tsx: the wasm compiler is stubbed.
const compileTypstSvg = vi.fn();
vi.mock('@/lib/typst-compiler', () => ({
  compileTypstSvg: (...args: unknown[]) => compileTypstSvg(...args),
  typstErrorMessage: (e: unknown) => String(e),
}));

import { TypstPreview } from '@/components/typst/TypstPreview';
import { clearWorkspaceCaches } from '@/lib/workspace-cache';

class FakeIntersectionObserver {
  constructor(public cb: unknown) {}
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

const DOC =
  '<svg class="typst-doc" viewBox="0 0 200 100" width="200" height="100" xmlns="http://www.w3.org/2000/svg">' +
  '<style type="text/css">.tsel{position:fixed}</style><defs class="glyph"><path id="gA" d="M0 0"/></defs>' +
  '<g class="typst-page" data-tid="p1" data-page-width="200" data-page-height="100">' +
  '<image href="data:image/png;base64,AAAA" x="0" y="0" width="40" height="40"/>' +
  '<foreignObject x="1" y="2" width="10" height="5"><div class="tsel">hello</div></foreignObject>' +
  '</g><script>1</script></svg>';

const BOX = { left: 0, top: 0, right: 50, bottom: 20, width: 50, height: 20, x: 0, y: 0, toJSON() { return {}; } } as DOMRect;

async function mount(props: { locked?: boolean }) {
  compileTypstSvg.mockResolvedValue({ svg: DOC, diagnostics: [] });
  const onRevealSource = vi.fn();
  const onRevealImage = vi.fn();
  const view = render(<TypstPreview source="a" onRevealSource={onRevealSource} onRevealImage={onRevealImage} {...props} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  const shadow = view.container.querySelector('[data-testid="preview-shadow-host"]')!.shadowRoot!;
  const run = shadow.querySelector('foreignObject')!;
  const img = shadow.querySelector('image')!;
  vi.spyOn(run, 'getBoundingClientRect').mockReturnValue(BOX);
  vi.spyOn(img, 'getBoundingClientRect').mockReturnValue({ ...BOX, left: 200, right: 240, x: 200 } as DOMRect);
  return { ...view, run, img, onRevealSource, onRevealImage };
}

describe('TypstPreview lock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    compileTypstSvg.mockReset();
    clearWorkspaceCaches();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('unlocked: clicking text reveals source and clicking an image reveals the asset', async () => {
    const { run, img, onRevealSource, onRevealImage } = await mount({});
    fireEvent.click(run, { clientX: 10, clientY: 10 });
    expect(onRevealSource).toHaveBeenCalledTimes(1);
    fireEvent.click(img, { clientX: 210, clientY: 10 });
    expect(onRevealImage).toHaveBeenCalledTimes(1);
  });

  it('locked: clicks reveal neither source nor asset', async () => {
    const { run, img, onRevealSource, onRevealImage } = await mount({ locked: true });
    fireEvent.click(run, { clientX: 10, clientY: 10 });
    fireEvent.click(img, { clientX: 210, clientY: 10 });
    expect(onRevealSource).not.toHaveBeenCalled();
    expect(onRevealImage).not.toHaveBeenCalled();
  });

  it('locked: text cursor, explanatory title and a Locked badge beside the status', async () => {
    const { container, getByText } = await mount({ locked: true });
    const area = container.querySelector<HTMLElement>('[data-testid="preview-pages"]')!;
    expect(area.className).toContain('cursor-text');
    expect(area.className).not.toContain('cursor-pointer');
    expect(area.title).toBe('Locked: select and copy text freely. Unlock to jump to the code.');
    expect(getByText('Locked')).toBeTruthy();
    expect(getByText('Preview')).toBeTruthy();
  });

  // typst.ts lays a `.pseudo-link` rect with `pointer-events: all` over every
  // link (TOC entries, cross-references), so a drag starting on linked text
  // lands on the rect and the selection anchors at the top of the page.
  it('locked: link rects let the pointer through to the text layer', async () => {
    const { container } = await mount({ locked: true });
    const shadow = container.querySelector('[data-testid="preview-shadow-host"]')!.shadowRoot!;
    expect(shadow.querySelector('.stack')!.classList.contains('locked')).toBe(true);
    const css = Array.from(shadow.querySelectorAll('style')).map((s) => s.textContent).join('\n');
    expect(css).toMatch(/\.locked \.pseudo-link\s*\{[^}]*pointer-events:\s*none/);
  });

  it('unlocked: link rects stay clickable', async () => {
    const { container } = await mount({});
    const shadow = container.querySelector('[data-testid="preview-shadow-host"]')!.shadowRoot!;
    expect(shadow.querySelector('.stack')!.classList.contains('locked')).toBe(false);
  });

  it('unlocked: pointer cursor and no badge', async () => {
    const { container, queryByText } = await mount({});
    const area = container.querySelector<HTMLElement>('[data-testid="preview-pages"]')!;
    expect(area.className).toContain('cursor-pointer');
    expect(queryByText('Locked')).toBeNull();
  });
});

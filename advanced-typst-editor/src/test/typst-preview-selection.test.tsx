import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent, screen } from '@testing-library/react';

// The compiler is wasm + fonts: stub it with canned pages, as the page tests do. The mapper is
// real, so these tests also prove that what the preview hands it lines up with the source.
const compileTypstSvg = vi.fn();
vi.mock('@/lib/typst-compiler', () => ({
  compileTypstSvg: (...args: unknown[]) => compileTypstSvg(...args),
  typstErrorMessage: (e: unknown) => String(e),
}));

import { TypstPreview, type SourceClick } from '@/components/typst/TypstPreview';
import { clearWorkspaceCaches } from '@/lib/workspace-cache';
import type { SourceRange } from '@/lib/typst-source-map';

class FakeIntersectionObserver {
  constructor(public cb: unknown) {}
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

const run = (text: string) => `<foreignObject x="1" y="2" width="10" height="5"><div class="tsel">${text}</div></foreignObject>`;
const page = (n: number, runs: string[]) =>
  `<g class="typst-page" transform="translate(0, ${(n - 1) * 100})" data-tid="p${n}" data-page-width="200" data-page-height="100">` +
  '<g><use href="#gA"/></g>' + runs.map(run).join('') + '</g>';
const doc = (pages: string[]) =>
  '<svg style="overflow: visible;" class="typst-doc" viewBox="0 0 200.000 400.000" width="200.000" height="400.000" xmlns="http://www.w3.org/2000/svg">' +
  '<style type="text/css">.tsel{position:fixed}</style><defs class="glyph"><path id="gA" d="M0 0"/></defs>' +
  pages.join('') + '<script>1</script></svg>';

const SOURCE = 'The quick brown fox jumps over the lazy dog today.\n\nSecond page opens with epsilon zeta eta theta iota.\n';
const PAGE1 = ['The quick brown fox ', 'jumps over the lazy dog today.'];
const PAGE2 = ['Second page opens with epsilon ', 'zeta eta theta iota.'];
const SVG = doc([page(1, PAGE1), page(2, PAGE2)]);

const shadowOf = (c: HTMLElement) => c.querySelector('[data-testid="preview-shadow-host"]')!.shadowRoot!;
/** The text node of run `r` on page card `p` (a selection anchors inside it). */
const textOf = (c: HTMLElement, p: number, r: number): Text =>
  shadowOf(c).querySelectorAll('[data-page-index]')[p]!.querySelectorAll('.tsel')[r]!.firstChild as Text;

/** What `window.getSelection()` (or Chrome's shadow getSelection) reports for a drag over page text. */
const dragSel = (a: Node, aOff: number, f: Node, fOff: number, text: string) =>
  ({ toString: () => text, anchorNode: a, anchorOffset: aOff, focusNode: f, focusOffset: fOff, isCollapsed: false, rangeCount: 0, type: 'Range' }) as unknown as Selection;
const collapsed = () => ({ toString: () => '', anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, isCollapsed: true, rangeCount: 0, type: 'None' }) as unknown as Selection;

async function advance(ms = 200) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

const idx = (s: string, sub: string) => s.indexOf(sub);

describe('preview selection mapping', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  let getSelection: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    compileTypstSvg.mockReset();
    compileTypstSvg.mockResolvedValue({ svg: SVG, diagnostics: [] });
    clearWorkspaceCaches();
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    getSelection = vi.spyOn(window, 'getSelection');
    getSelection.mockReturnValue(collapsed());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function mount(props: Partial<React.ComponentProps<typeof TypstPreview>> = {}) {
    const onSelectionRange = vi.fn<(r: (SourceRange & { approximate: boolean }) | null) => void>();
    const onSelectInCode = vi.fn<(r: SourceRange) => void>();
    const onRevealSource = vi.fn<(c: SourceClick) => SourceRange | null | void>();
    const view = render(<TypstPreview source={SOURCE} docKey="w:main.typ" onSelectionRange={onSelectionRange} onSelectInCode={onSelectInCode} onRevealSource={onRevealSource} {...props} />);
    await advance(400);
    return { ...view, onSelectionRange, onSelectInCode, onRevealSource };
  }

  /** Drag over "quick brown" in page 1's first run, then release. */
  async function dragQuickBrown(view: Awaited<ReturnType<typeof mount>>) {
    const t = textOf(view.container, 0, 0);
    const a = idx(PAGE1[0]!, 'quick'), b = idx(PAGE1[0]!, 'quick brown') + 'quick brown'.length;
    getSelection.mockReturnValue(dragSel(t, a, t, b, 'quick brown'));
    fireEvent.mouseDown(t.parentElement!);
    fireEvent.mouseUp(t.parentElement!);
    await advance();
  }

  it('maps a drag once, after mouseup, and not during the drag or on selectionchange ticks', async () => {
    const view = await mount();
    const t = textOf(view.container, 0, 0);
    getSelection.mockReturnValue(dragSel(t, 4, t, 15, 'quick brown'));
    fireEvent.mouseDown(t.parentElement!);
    for (let i = 0; i < 5; i++) { document.dispatchEvent(new Event('selectionchange')); await advance(30); }
    fireEvent.mouseMove(t.parentElement!);
    expect(view.onSelectionRange).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();

    fireEvent.mouseUp(t.parentElement!);
    await advance(50); // inside the debounce
    expect(view.onSelectionRange).not.toHaveBeenCalled();
    await advance(200);
    expect(view.onSelectionRange).toHaveBeenCalledTimes(1);
    const r = view.onSelectionRange.mock.calls[0]![0]!;
    expect(SOURCE.slice(r.from, r.to)).toBe('quick brown');
    expect(r.approximate).toBe(false);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('maps after Shift is released (keyboard selection)', async () => {
    const view = await mount();
    const t = textOf(view.container, 0, 1);
    getSelection.mockReturnValue(dragSel(t, idx(PAGE1[1]!, 'lazy'), t, idx(PAGE1[1]!, 'lazy dog') + 8, 'lazy dog'));
    fireEvent.keyUp(window, { key: 'ArrowRight' }); // not Shift: nothing
    await advance();
    expect(view.onSelectionRange).not.toHaveBeenCalled();
    fireEvent.keyUp(window, { key: 'Shift' });
    await advance();
    expect(view.onSelectionRange).toHaveBeenCalledTimes(1);
    expect(SOURCE.slice(view.onSelectionRange.mock.calls[0]![0]!.from, view.onSelectionRange.mock.calls[0]![0]!.to)).toBe('lazy dog');
  });

  it('normalises a backwards drag and reads a selection that spans pages', async () => {
    const view = await mount();
    const a = textOf(view.container, 1, 0), f = textOf(view.container, 0, 1);
    // Anchor on page 2, focus on page 1: a drag from the bottom up.
    getSelection.mockReturnValue(dragSel(a, idx(PAGE2[0]!, 'epsilon') + 'epsilon'.length, f, idx(PAGE1[1]!, 'over'), 'over the lazy dog today. Second page opens with epsilon'));
    fireEvent.mouseUp(f.parentElement!);
    await advance();
    const r = view.onSelectionRange.mock.calls[0]![0]!;
    expect(SOURCE.slice(r.from, r.to)).toBe('over the lazy dog today.\n\nSecond page opens with epsilon');
  });

  it('reads the Chrome shadow-root selection, whose anchor is real, while window.getSelection is retargeted to the host', async () => {
    const view = await mount();
    const t = textOf(view.container, 0, 0);
    const host = view.container.querySelector('[data-testid="preview-shadow-host"]')!;
    const shadow = shadowOf(view.container) as ShadowRoot & { getSelection?: () => unknown };
    shadow.getSelection = () => dragSel(t, 4, t, 15, 'quick brown');
    getSelection.mockReturnValue(dragSel(host, 0, host, 0, 'quick brown'));
    fireEvent.mouseUp(t.parentElement!);
    await advance();
    expect(SOURCE.slice(view.onSelectionRange.mock.calls[0]![0]!.from, view.onSelectionRange.mock.calls[0]![0]!.to)).toBe('quick brown');
  });

  it('ignores a selection that lives in the editor, even when Chrome stringifies it through the shadow root', async () => {
    const view = await mount();
    const t = textOf(view.container, 0, 0);
    const editorSel = { toString: () => 'KEY AREAS FOR IMPROVEMENT', anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, isCollapsed: true, type: 'None' };
    (shadowOf(view.container) as ShadowRoot & { getSelection?: () => unknown }).getSelection = () => editorSel;
    getSelection.mockReturnValue(editorSel as unknown as Selection);
    fireEvent.mouseUp(t.parentElement!);
    await advance();
    expect(view.onSelectionRange).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();

    // And one anchored in some other element of the page (the editor's DOM) is not a preview selection either.
    const outside = document.createElement('div');
    outside.textContent = 'quick brown';
    document.body.appendChild(outside);
    getSelection.mockReturnValue(dragSel(outside.firstChild!, 0, outside.firstChild!, 5, 'quick'));
    fireEvent.mouseUp(t.parentElement!);
    await advance();
    expect(view.onSelectionRange).not.toHaveBeenCalled();
  });

  it('clears the mapped state and the toolbar when the selection collapses', async () => {
    const view = await mount();
    await dragQuickBrown(view);
    expect(view.onSelectionRange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();

    getSelection.mockReturnValue(collapsed());
    fireEvent.mouseUp(textOf(view.container, 0, 0).parentElement!);
    await advance();
    expect(view.onSelectionRange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  });

  it('Escape dismisses the toolbar and the highlight', async () => {
    const view = await mount();
    await dragQuickBrown(view);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(view.onSelectionRange).toHaveBeenLastCalledWith(null);
  });

  it('a new document or an edit drops the mapped selection (its offsets belong to the old source)', async () => {
    const view = await mount();
    await dragQuickBrown(view);
    view.rerender(<TypstPreview source={SOURCE + 'more'} docKey="w:main.typ" onSelectionRange={view.onSelectionRange} onSelectInCode={view.onSelectInCode} />);
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(view.onSelectionRange).toHaveBeenLastCalledWith(null);
  });

  it('Copy writes the rendered text', async () => {
    const view = await mount();
    await dragQuickBrown(view);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })); });
    expect(writeText).toHaveBeenCalledWith('quick brown');
  });

  it('Copy Typst source writes the source slice', async () => {
    const view = await mount();
    await dragQuickBrown(view);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy Typst source' })); });
    expect(writeText).toHaveBeenCalledWith('quick brown');
  });

  it('Select in code hands the mapped range to the editor', async () => {
    const view = await mount();
    await dragQuickBrown(view);
    fireEvent.click(screen.getByRole('button', { name: 'Select in code' }));
    expect(view.onSelectInCode).toHaveBeenCalledTimes(1);
    const r = view.onSelectInCode.mock.calls[0]![0];
    expect(SOURCE.slice(r.from, r.to)).toBe('quick brown');
    // The real selection takes over: the toolbar and the transient mark go.
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(view.onSelectionRange).toHaveBeenLastCalledWith(null);
  });

  it('a locked preview offers Copy and Copy Typst source only, and never reveals', async () => {
    const view = await mount({ locked: true });
    await dragQuickBrown(view);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Typst source' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select in code' })).toBeNull();
    // The passive highlight still goes out (it opens nothing and moves no caret).
    expect(view.onSelectionRange).toHaveBeenCalledTimes(1);
    fireEvent.click(textOf(view.container, 0, 0).parentElement!, { clientX: 5, clientY: 5 });
    expect(view.onRevealSource).not.toHaveBeenCalled();
    expect(view.onSelectInCode).not.toHaveBeenCalled();
  });

  it('a plain click still reveals, before and after a drag', async () => {
    const view = await mount();
    const t = textOf(view.container, 0, 0);
    const fo = t.parentElement!.closest('foreignObject')!;
    vi.spyOn(fo, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 50, bottom: 20, width: 50, height: 20, x: 0, y: 0, toJSON() { return {}; } } as DOMRect);
    fireEvent.click(fo, { clientX: 10, clientY: 10 });
    expect(view.onRevealSource).toHaveBeenCalledTimes(1);

    await dragQuickBrown(view);
    // The drag's own click is swallowed (a selection is live) ...
    fireEvent.click(fo, { clientX: 10, clientY: 10 });
    expect(view.onRevealSource).toHaveBeenCalledTimes(1);
    // ... and a click on a collapsed selection reveals again, clearing the mapped selection.
    getSelection.mockReturnValue(collapsed());
    fireEvent.mouseUp(fo);
    fireEvent.click(fo, { clientX: 10, clientY: 10 });
    await advance();
    expect(view.onRevealSource).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  });

  it('flags generated text as approximate in the toolbar and on the Copy Typst source button', async () => {
    const GEN_SOURCE = 'Intro paragraph with some ordinary words in it.\n\nTotal budget: #lorem(8)\n';
    const svg = doc([page(1, ['Intro paragraph with some ordinary words in it.', 'Total budget: Lorem ipsum dolor sit amet, consectetur adipiscing elit.'])]);
    compileTypstSvg.mockResolvedValue({ svg, diagnostics: [] });
    const view = await mount({ source: GEN_SOURCE });
    const t = textOf(view.container, 0, 1);
    const run1 = 'Total budget: Lorem ipsum dolor sit amet, consectetur adipiscing elit.';
    getSelection.mockReturnValue(dragSel(t, idx(run1, 'ipsum'), t, idx(run1, 'amet') + 4, 'ipsum dolor sit amet'));
    fireEvent.mouseUp(t.parentElement!);
    await advance();
    expect(view.onSelectionRange.mock.calls[0]![0]!.approximate).toBe(true);
    expect(screen.getByText('approximate')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Typst source' }).getAttribute('title')).toMatch(/approximate/i);
  });

  it('keeps the toolbar out of the way of a toolbar click: pressing it does not take the selection', async () => {
    const view = await mount();
    await dragQuickBrown(view);
    const copy = screen.getByRole('button', { name: 'Copy' });
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    copy.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });
});

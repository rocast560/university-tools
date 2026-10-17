// ─────────────────────────────────────────────────────────────────────────
// The small bar that appears next to a highlight in the preview: Copy (the
// rendered text), Copy Typst source (the markup it maps to) and Select in code.
//
// It lives in the preview pane, outside the shadow root that holds the pages,
// so the page styles and the 26 000-node SVG never see it. The pointer-down is
// swallowed so pressing a button neither collapses the highlight nor moves
// focus out of the preview: Ctrl+C keeps copying the preview's text.
// ─────────────────────────────────────────────────────────────────────────

import { useLayoutEffect, useRef, useState } from 'react';
import { Check, Copy, Braces, TextSelect } from 'lucide-react';

/** Where the bar goes, in pane coordinates: under the selection's end, or above its start when there is no room below. */
export interface BarAnchor {
  x: number;
  below: number;
  above: number;
}

const GAP = 4;
// Used until the bar has been measured (and where there is no layout to measure).
const FALLBACK = { w: 320, h: 28 };

export function PreviewSelectionBar({
  anchor, bounds, approximate, canSource, canSelect, copied, onCopy, onCopySource, onSelect,
}: {
  anchor: BarAnchor;
  /** Size of the pane the bar is positioned in. */
  bounds: { w: number; h: number };
  approximate: boolean;
  /** A source range exists: without one only Copy is offered. */
  canSource: boolean;
  /** Select in code is offered: unlocked, and a range exists. */
  canSelect: boolean;
  copied: 'text' | 'source' | null;
  onCopy: () => void;
  onCopySource: () => void;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.x, top: anchor.below });

  // Place it from its measured size: below the end of the selection, else above its start, and always inside the pane.
  useLayoutEffect(() => {
    const el = ref.current;
    const w = el?.offsetWidth || FALLBACK.w;
    const h = el?.offsetHeight || FALLBACK.h;
    let top = anchor.below;
    if (top + h > bounds.h - GAP) top = anchor.above - h;
    top = Math.min(Math.max(top, GAP), Math.max(GAP, bounds.h - h - GAP));
    const left = Math.min(Math.max(anchor.x - w / 2, GAP), Math.max(GAP, bounds.w - w - GAP));
    setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
  }, [anchor.x, anchor.below, anchor.above, bounds.w, bounds.h, canSource, canSelect, approximate]);

  const btn = 'flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 hover:bg-[hsl(var(--accent))]';
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Selection"
      data-testid="preview-selection-bar"
      // Keep the highlight and the focus where they are: a button press must not collapse the selection it acts on.
      onMouseDown={(e) => e.preventDefault()}
      // Capped at the pane width and allowed to wrap: with the code pane open
      // the preview can be narrower than the bar, and clamping its position
      // alone left the end of it cut off at the pane edge.
      className="pop-shadow absolute z-20 flex flex-wrap items-center gap-0.5 rounded-md bg-[hsl(var(--popover))] p-0.5 text-xs text-[hsl(var(--popover-foreground))]"
      style={{ left: pos.left, top: pos.top, maxWidth: Math.max(0, bounds.w - 2 * GAP) }}
    >
      <button type="button" className={btn} onClick={onCopy} title="Copy the selected text">
        {copied === 'text' ? <Check size={12} /> : <Copy size={12} />}
        Copy
      </button>
      {canSource && (
        <button
          type="button"
          className={btn}
          onClick={onCopySource}
          title={approximate ? 'Copy the Typst source (approximate: the passage was matched by its text, so check the markup)' : 'Copy the Typst source of this passage'}
        >
          {copied === 'source' ? <Check size={12} /> : <Braces size={12} />}
          Copy Typst source
        </button>
      )}
      {canSelect && (
        <button type="button" className={btn} onClick={onSelect} title="Select this passage in the code pane">
          <TextSelect size={12} />
          Select in code
        </button>
      )}
      {approximate && canSource && <span className="whitespace-nowrap px-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">approximate</span>}
    </div>
  );
}

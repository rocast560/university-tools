// Full screen gives the window to the breadboard. The controls around it
// (toolbar above, Show row, net legend below) can be full size, compact (one
// line each, the legend scrolled sideways) or hidden, from a small switcher
// floating in the board's bottom-right corner or with H. The choice is
// remembered.

import { icon } from './icons.ts';

export type ChromeSize = 'full' | 'compact' | 'hidden';
const SIZES: readonly ChromeSize[] = ['full', 'compact', 'hidden'];
const KEY = 'fullscreenControls';

/** The remembered size; compact when nothing (or nonsense) was stored. */
export function readChromeSize(stored: string | null): ChromeSize {
  return (SIZES as readonly (string | null)[]).includes(stored) ? (stored as ChromeSize) : 'compact';
}

/** H: hide the controls, or bring back the size they were hidden from. */
export function toggleHidden(size: ChromeSize, before: ChromeSize): { size: ChromeSize; before: ChromeSize } {
  if (size !== 'hidden') return { size: 'hidden', before: size };
  const back = before === 'hidden' ? 'compact' : before;
  return { size: back, before: back };
}

const LABELS: [ChromeSize, string][] = [
  ['full', 'Full'],
  ['compact', 'Compact'],
  ['hidden', 'Hide'],
];

/** Add the switcher to a board card and keep its size in sync. Idempotent per card. */
export function mountFullscreenChrome(card: HTMLElement): void {
  if (card.querySelector('.fs-chrome')) return;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    /* storage blocked */
  }
  let size = readChromeSize(stored);
  let before: ChromeSize = size === 'hidden' ? 'compact' : size;

  const bar = document.createElement('div');
  bar.className = 'fs-chrome';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Controls around the board');
  bar.title = 'Controls around the board · H hides or shows them';
  bar.innerHTML = `<span>${icon('options')}Controls</span>${LABELS.map(([s, label]) => `<button type="button" data-fs-size="${s}">${label}</button>`).join('')}`;
  // In the board's stage, so it sits in the well's bottom strip opposite the Show filter, clear of the toolbar above.
  (card.querySelector('.board-stage') ?? card).appendChild(bar);

  const apply = (next: ChromeSize) => {
    size = next;
    if (next !== 'hidden') before = next;
    card.dataset.chrome = next;
    for (const b of bar.querySelectorAll<HTMLElement>('[data-fs-size]')) {
      const on = b.dataset.fsSize === next;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* storage blocked */
    }
  };
  apply(size);

  bar.addEventListener('click', (e) => {
    const s = (e.target as HTMLElement).closest<HTMLElement>('[data-fs-size]')?.dataset.fsSize;
    if (s) apply(s as ChromeSize);
  });

  document.addEventListener('keydown', (e) => {
    if (document.fullscreenElement !== card || !card.isConnected) return;
    if (e.key !== 'h' && e.key !== 'H') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const r = toggleHidden(size, before);
    before = r.before;
    apply(r.size);
    e.preventDefault();
  });
}

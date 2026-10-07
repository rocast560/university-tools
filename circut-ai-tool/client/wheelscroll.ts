// A plain mouse wheel over a one-row strip (the net legends) scrolls it sideways.
// When the strip has nothing to scroll, or the gesture is already horizontal, the
// event is left alone so the page still scrolls vertically.

export function wheelScrollX(strip: HTMLElement): void {
  strip.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || strip.scrollWidth <= strip.clientWidth) return;
      strip.scrollLeft += e.deltaY;
      e.preventDefault();
    },
    { passive: false },
  );
}

// A plain mouse wheel over a one-row strip (the net legends) scrolls it sideways.
// When the strip has nothing to scroll, is already at its end in the wheel's
// direction, or the gesture is already horizontal, the event is left alone so the
// page still scrolls vertically.

export function wheelScrollX(strip: HTMLElement): void {
  strip.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || strip.scrollWidth <= strip.clientWidth) return;
      const atStart = strip.scrollLeft <= 0;
      const atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
      if ((e.deltaY < 0 && atStart) || (e.deltaY > 0 && atEnd)) return;
      strip.scrollLeft += e.deltaY;
      e.preventDefault();
    },
    { passive: false },
  );
}

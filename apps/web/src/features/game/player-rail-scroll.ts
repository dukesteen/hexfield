export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function axis(viewStart: number, viewEnd: number, start: number, end: number): number {
  if (start < viewStart || end - start > viewEnd - viewStart) return start - viewStart;
  if (end > viewEnd) return end - viewEnd;
  return 0;
}

/**
 * The scroll change that brings `item` fully into `view` (both in viewport coordinates), or
 * null when it is already visible. An item larger than the view is aligned to its start.
 */
export function scrollDeltaToReveal(view: Box, item: Box): { x: number; y: number } | null {
  const x = axis(view.left, view.right, item.left, item.right);
  const y = axis(view.top, view.bottom, item.top, item.bottom);
  return x === 0 && y === 0 ? null : { x, y };
}

function scrollable(value: string): boolean {
  return value === 'auto' || value === 'scroll';
}

function scrolls(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  return (
    (scrollable(style.overflowY) && element.scrollHeight > element.clientHeight) ||
    (scrollable(style.overflowX) && element.scrollWidth > element.clientWidth)
  );
}

/**
 * Bring the active player's panel into view by scrolling its scrolling ancestors up to and
 * including `rail` (the sidebar list or the phone strip), never the page itself.
 */
export function revealPlayerPanel(rail: HTMLElement, panel: HTMLElement): void {
  const reduced =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (let element = panel.parentElement; element; element = element.parentElement) {
    if (scrolls(element)) {
      const delta = scrollDeltaToReveal(
        element.getBoundingClientRect(),
        panel.getBoundingClientRect(),
      );
      if (delta)
        element.scrollBy({ left: delta.x, top: delta.y, behavior: reduced ? 'auto' : 'smooth' });
    }
    if (element === rail) break;
  }
}

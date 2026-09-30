import type { VisibilityDocument } from './wake-lock.js';

/** Shorter trips (a notification shade, an app switcher glance) do not warrant a notice. */
export const BACKGROUND_NOTICE_MS = 3000;

/**
 * Calls `onReturn` when the page becomes visible again after being hidden for at least
 * `thresholdMs`. A hidden tab cannot show UI, so the online-game warning appears on return.
 */
export function watchBackgrounding(
  doc: VisibilityDocument,
  onReturn: (hiddenMs: number) => void,
  now: () => number = () => Date.now(),
  thresholdMs = BACKGROUND_NOTICE_MS,
): () => void {
  let hiddenAt = doc.visibilityState === 'hidden' ? now() : null;
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') {
      hiddenAt ??= now();
      return;
    }
    if (hiddenAt === null) return;
    const hiddenMs = now() - hiddenAt;
    hiddenAt = null;
    if (hiddenMs >= thresholdMs) onReturn(hiddenMs);
  };
  doc.addEventListener('visibilitychange', onVisibility);
  return () => doc.removeEventListener('visibilitychange', onVisibility);
}

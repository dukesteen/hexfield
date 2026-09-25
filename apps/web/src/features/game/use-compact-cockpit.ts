import { useSyncExternalStore } from 'react';

const query = '(max-width: 767px), (max-height: 500px)';

function subscribe(notify: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
}

function current() {
  return window.matchMedia(query).matches;
}

/** The cockpit breakpoint is shared by the hand, action sheet, and player strip. */
export function useCompactCockpit() {
  return useSyncExternalStore(subscribe, current, () => false);
}

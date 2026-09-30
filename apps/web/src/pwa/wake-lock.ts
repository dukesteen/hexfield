/** The subset of the Screen Wake Lock API this app uses (feature-detected at runtime). */
export interface WakeLockSentinelLike {
  readonly released: boolean;
  release: () => Promise<void>;
}

export interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export interface VisibilityDocument {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * Keeps the screen awake while a game is open. Browsers release the lock whenever the page is
 * hidden, so it is requested again each time the page becomes visible. Failures (battery saver,
 * permissions policy, no support) are ignored: the lock only reduces mobile disconnects.
 */
export function holdScreenWakeLock(
  wakeLock: WakeLockLike | undefined,
  doc: VisibilityDocument,
): () => void {
  if (!wakeLock) return () => undefined;
  let sentinel: WakeLockSentinelLike | null = null;
  let pending = false;
  let stopped = false;

  const acquire = async () => {
    if (stopped || pending || doc.visibilityState !== 'visible') return;
    if (sentinel && !sentinel.released) return;
    pending = true;
    try {
      const next = await wakeLock.request('screen');
      if (stopped) {
        await next.release();
        return;
      }
      sentinel = next;
    } catch {
      sentinel = null;
    } finally {
      pending = false;
    }
  };
  const onVisibility = () => void acquire();

  doc.addEventListener('visibilitychange', onVisibility);
  void acquire();
  return () => {
    stopped = true;
    doc.removeEventListener('visibilitychange', onVisibility);
    const held = sentinel;
    sentinel = null;
    if (held && !held.released) void held.release().catch(() => undefined);
  };
}

export function browserWakeLock(): WakeLockLike | undefined {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return undefined;
  return navigator.wakeLock;
}

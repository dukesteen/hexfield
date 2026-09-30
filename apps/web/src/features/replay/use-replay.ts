import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReplaySession } from './replay-session.js';

/** Re-renders on every seek or perspective change; returns the session's revision. */
export function useReplayRevision(session: ReplaySession): number {
  const revision = useRef(0);
  const subscribe = useCallback(
    (notify: () => void) =>
      session.subscribe((update) => {
        revision.current = update.revision;
        notify();
      }),
    [session],
  );
  return useSyncExternalStore(
    subscribe,
    () => revision.current,
    () => revision.current,
  );
}

export const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];
/** One input every 600 ms at 1×. */
const BASE_INTERVAL_MS = 600;

/** Steps the session forward while playing and stops at the end. */
export function usePlayback(session: ReplaySession) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  useEffect(() => {
    if (!playing) return undefined;
    const handle = setInterval(() => {
      if (session.position >= session.length) {
        setPlaying(false);
        return;
      }
      session.step(1);
    }, BASE_INTERVAL_MS / speed);
    return () => clearInterval(handle);
  }, [playing, session, speed]);
  const toggle = useCallback(() => {
    // Playing from the end starts again from the beginning.
    if (!playing && session.position >= session.length) session.seek(0);
    setPlaying(!playing);
  }, [playing, session]);
  return { playing, setPlaying, toggle, speed, setSpeed };
}

export type ReplayLoad<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'error'; readonly error: unknown };

/**
 * Runs a replay's one full verification pass after the "preparing" status has painted; it
 * can take a second or two for a long expansion game.
 */
export function useDeferredReplay<T>(load: (() => T) | null): ReplayLoad<T> {
  const [result, setResult] = useState<ReplayLoad<T>>({ status: 'loading' });
  useEffect(() => {
    if (!load) return undefined;
    setResult({ status: 'loading' });
    const handle = setTimeout(() => {
      try {
        setResult({ status: 'ready', value: load() });
      } catch (error) {
        setResult({ status: 'error', error });
      }
    }, 16);
    return () => clearTimeout(handle);
  }, [load]);
  return result;
}

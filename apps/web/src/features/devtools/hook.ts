import { hashValue, toHex } from '@cp2p/codec';
import type { BoardHit, BoardRenderer, ScreenPoint } from '@cp2p/renderer';
import type { GameSession } from '../../session/types.js';
import type { ActionAvailability } from '../actions/availability.js';
import { ordinaryActionRejectionCount } from '../game/action-diagnostics.js';

export interface DevHook {
  readonly session: GameSession;
  readonly renderer: BoardRenderer | null;
  diagnostics(): {
    readonly hash: string;
    readonly revision: number;
    readonly rejectionCount: number;
    readonly pending: ReturnType<GameSession['getPending']>;
    readonly actions: ActionAvailability | null;
  };
  pixelPosition(hit: BoardHit): ScreenPoint | null;
}

declare global {
  interface Window {
    __cp2p?: DevHook;
  }
}

/** Install from a development route only; cleanup cannot remove a newer hook. */
export function installDevHook({
  session,
  renderer = null,
  actions = null,
}: {
  session: GameSession;
  renderer?: BoardRenderer | null;
  actions?: ActionAvailability | null;
}): () => void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return () => {};
  let revision = 0;
  const unsubscribe = session.subscribe((update) => {
    revision = update.revision;
  });
  const hook: DevHook = {
    session,
    renderer,
    diagnostics: () => ({
      hash: toHex(hashValue(session.getState())),
      revision,
      rejectionCount: ordinaryActionRejectionCount(),
      pending: session.getPending(),
      actions: actions === null ? null : structuredClone(actions),
    }),
    pixelPosition: (hit) => renderer?.getPixelPosition(hit) ?? null,
  };
  Reflect.set(window, '__cp2p', hook);
  return () => {
    unsubscribe();
    if (Reflect.get(window, '__cp2p') === hook) Reflect.deleteProperty(window, '__cp2p');
  };
}

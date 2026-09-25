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

/** Stable installation, with values refreshed by the route as the UI changes. */
export interface DevHookView {
  renderer: BoardRenderer | null;
  actions: { revision: number; availability: ActionAvailability | null } | null;
}

declare global {
  interface Window {
    __cp2p?: DevHook;
  }
}

/** Install from a development route only; cleanup cannot remove a newer hook. */
export function installDevHook({
  session,
  view,
}: {
  session: GameSession;
  view: DevHookView;
}): () => void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return () => {};
  let revision = 0;
  const unsubscribe = session.subscribe((update) => {
    revision = update.revision;
  });
  const hook: DevHook = {
    session,
    get renderer() {
      return view.renderer;
    },
    diagnostics: () => ({
      hash: toHex(hashValue(session.getState())),
      revision,
      rejectionCount: ordinaryActionRejectionCount(),
      pending: session.getPending(),
      actions:
        view.actions?.revision === revision && view.actions.availability !== null
          ? structuredClone(view.actions.availability)
          : null,
    }),
    pixelPosition: (hit) => view.renderer?.getPixelPosition(hit) ?? null,
  };
  Reflect.set(window, '__cp2p', hook);
  return () => {
    unsubscribe();
    if (Reflect.get(window, '__cp2p') === hook) Reflect.deleteProperty(window, '__cp2p');
  };
}

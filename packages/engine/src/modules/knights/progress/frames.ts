import type { GameState, PhaseFrame } from '../../../core/state/index.js';
import { popPhase, pushPhase, replaceTop } from '../../base/shared.js';
import { KNIGHTS_ID } from '../config.js';

/** A frame owned by the knights module. */
export function knightsFrame(id: string, data: unknown): PhaseFrame {
  return { id, module: KNIGHTS_ID, data };
}

/** The data of the top frame when it is the knights frame `id`, else undefined. */
// The caller names the data shape its own frame stores; nothing else could infer it.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
export function frameData<T>(state: GameState, id: string): T | undefined {
  const top = state.turn.phase.at(-1);
  if (top?.module !== KNIGHTS_ID || top.id !== id) return undefined;
  // Only the code that pushes this frame writes its data, and each caller names the same shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return top.data as T;
}

/** The data of the top knights frame `id`; throws when the frame is not on top. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
export function requireFrame<T>(state: GameState, id: string): T {
  const data = frameData<T>(state, id);
  if (data === undefined) throw new Error(`Expected the ${id} frame on top`);
  return data;
}

export function pushKnights(state: GameState, id: string, data: unknown): GameState {
  return pushPhase(state, knightsFrame(id, data));
}

export function replaceKnights(state: GameState, id: string, data: unknown): GameState {
  return replaceTop(state, knightsFrame(id, data));
}

export { popPhase };

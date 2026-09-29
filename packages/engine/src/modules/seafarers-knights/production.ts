import type { GameState } from '../../core/state/index.js';
import { popPhase, topFrame } from '../base/shared.js';
import { AQUEDUCT_FRAME, bankResources } from '../knights/aqueduct.js';
import { KNIGHTS_ID } from '../knights/config.js';

/**
 * Part of the `afterInput` hook: on a roll that pays gold and the Aqueduct, the gold choices sit
 * above the Aqueduct choices and are made first. When they empty the bank of resources, the
 * Aqueduct choices close unpaid, as they do in knights when the bank runs out between two seats.
 */
export function closeEmptyAqueduct(state: GameState): GameState {
  const top = topFrame(state);
  return top?.module === KNIGHTS_ID &&
    top.id === AQUEDUCT_FRAME &&
    bankResources(state).length === 0
    ? popPhase(state)
    : state;
}

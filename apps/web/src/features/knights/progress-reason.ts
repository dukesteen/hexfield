import type { GameState, Seat } from '@cp2p/engine';
import { cardInfo } from './catalogue';
import { knightsState } from './state';

/** Why a held progress card cannot be played now: the key under `knights:card.reason`. */
export type NotPlayableReason =
  | 'victory'
  | 'notYourTurn'
  | 'busy'
  | 'onlyBeforeRoll'
  | 'afterRoll'
  | 'finishStep'
  | 'robberLocked'
  | 'noTarget';

/**
 * The reason a card the engine offers no play for is not playable, from public state: whose turn
 * it is, the step the turn is in, the card's timing, and the robber lock. Anything else (no rival
 * with knights, no road to move, nothing to take) is a missing target.
 */
export function notPlayableReason(
  state: Readonly<GameState>,
  seat: Seat,
  card: string,
  busy = false,
): NotPlayableReason {
  const info = cardInfo(card);
  if (info.play === 'victory') return 'victory';
  if (state.turn.activeSeat !== seat) return 'notYourTurn';
  if (busy) return 'busy';
  const top = state.turn.phase.at(-1);
  const step = top?.module === 'base' ? top.id : null;
  if (info.preRoll) return step === 'preRoll' ? 'noTarget' : 'onlyBeforeRoll';
  if (step === 'preRoll') return 'afterRoll';
  if (step !== 'main') return 'finishStep';
  if (card === 'bishop' && knightsState(state)?.robberLocked) return 'robberLocked';
  return 'noTarget';
}

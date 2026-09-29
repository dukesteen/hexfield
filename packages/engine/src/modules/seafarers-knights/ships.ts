import type { GameState } from '../../core/state/index.js';
import { seafaringExt, updateSeafaring } from '../seafaring/types.js';

/**
 * The `afterInput` hook: the Diplomat can take a ship off the board in the turn it was built or
 * moved. Seafaring's "built this turn" list then forgets it, so the list names only ships on the
 * board. A ship later built on the same edge this turn is noted again by `afterBuild`.
 */
export function forgetRemovedShips(state: GameState): GameState {
  const built = seafaringExt(state).builtThisTurn;
  if (built.length === 0) return state;
  const onBoard = new Set((state.board.ships ?? []).map((ship) => ship.edge));
  if (built.every((edge) => onBoard.has(edge))) return state;
  return updateSeafaring(state, (old) => ({
    ...old,
    builtThisTurn: old.builtThisTurn.filter((edge) => onBoard.has(edge)),
  }));
}

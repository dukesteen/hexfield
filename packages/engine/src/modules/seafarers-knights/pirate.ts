import type { Blocker } from '../../core/modules/index.js';
import type { GameState } from '../../core/state/index.js';
import { knightsExt } from '../knights/types.js';
import { seafaringExt, updateSeafaring } from '../seafaring/types.js';
import { comboExt, updateCombo } from './types.js';

/**
 * Genesis: the pirate is not on the board. The scenario's pirate hex is kept until the first
 * barbarian attack (C&K 2025 p.12: the pirate "does not enter play until after the first barbarian
 * attack").
 */
export function holdPirate(state: GameState): GameState {
  const start = seafaringExt(state).pirateHex;
  return updateSeafaring(
    updateCombo(state, (old) => ({ ...old, pirateStart: start })),
    (old) => ({ ...old, pirateHex: null }),
  );
}

/**
 * The `onDiceResult` hook: once the barbarians have attacked (knights unlocked the robber), the
 * pirate enters play on the scenario's pirate hex, or stays off the board when the scenario has
 * none and enters at its first move. This runs after knights' own `onDiceResult`, in the same roll.
 */
export function enterPirate(state: GameState): GameState {
  const ext = comboExt(state);
  if (ext.pirateEntered || knightsExt(state).robberLocked) return state;
  return updateSeafaring(
    updateCombo(state, (old) => ({ ...old, pirateEntered: true })),
    (old) => ({ ...old, pirateHex: ext.pirateStart }),
  );
}

/** The blockers a chase (a knight's action) allows to move, when the top frame names them. */
function chased(state: GameState): readonly string[] | null {
  const top = state.turn.phase.at(-1);
  if (top?.module !== 'base' || top.id !== 'moveRobber') return null;
  const data: unknown = top.data;
  const only: unknown =
    typeof data === 'object' && data !== null ? Reflect.get(data, 'only') : null;
  return Array.isArray(only)
    ? only.filter((item): item is string => typeof item === 'string')
    : null;
}

/**
 * The `robberLike` hook, after knights and seafaring: the pirate is locked with the robber, and a
 * chase moves only the piece beside the knight.
 */
export function limitBlockers(state: GameState, acc: readonly Blocker[]): readonly Blocker[] {
  const locked = knightsExt(state).robberLocked;
  const only = chased(state);
  if (!locked && only === null) return acc;
  return acc.map((blocker) =>
    (locked && blocker.id === 'pirate') || (only !== null && !only.includes(blocker.id))
      ? { ...blocker, legalHexes: [] }
      : blocker,
  );
}

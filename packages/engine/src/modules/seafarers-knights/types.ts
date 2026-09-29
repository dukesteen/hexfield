import type { GameState } from '../../core/state/index.js';

/** Id of the rules module that plays Seafarers and Cities & Knights together (docs/rules/combos.md). */
export const COMBO_ID = 'scenario:seafarers-knights';
export const COMBO_VERSION = '1.0.0';

/** Public state under `ext['scenario:seafarers-knights']`. */
export interface ComboExt {
  /** The scenario's pirate hex, kept until the first barbarian attack puts the pirate on it. */
  pirateStart: string | null;
  /** Whether the first attack has happened, so the pirate has entered play. */
  pirateEntered: boolean;
}

export function comboExt(state: GameState): ComboExt {
  const value = state.ext[COMBO_ID];
  if (typeof value !== 'object' || value === null) throw new Error('Missing combination state');
  // Module genesis and hooks own this extension slot.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as ComboExt;
}

export function updateCombo(state: GameState, change: (old: ComboExt) => ComboExt): GameState {
  return { ...state, ext: { ...state.ext, [COMBO_ID]: change(comboExt(state)) } };
}

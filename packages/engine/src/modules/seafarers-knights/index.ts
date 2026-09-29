import type { GameModule, RenderHint } from '../../core/modules/index.js';
import type { GameState } from '../../core/state/index.js';
import { knightsExt } from '../knights/types.js';
import { seafaringExt } from '../seafaring/types.js';
import { enterPirate, holdPirate, limitBlockers } from './pirate.js';
import { closeEmptyAqueduct } from './production.js';
import { forgetRemovedShips } from './ships.js';
import { COMBO_ID, COMBO_VERSION, comboExt } from './types.js';
import type { ComboExt } from './types.js';

export { COMBO_ID, COMBO_VERSION, comboExt } from './types.js';
export type { ComboExt } from './types.js';

/** Public checks for the pair: the pirate enters with the first attack and not before. */
function comboInvariants(state: GameState): string[] {
  const errors: string[] = [];
  const ext = comboExt(state);
  if (!ext.pirateEntered && seafaringExt(state).pirateHex !== null)
    errors.push('the pirate is on the board before the first attack');
  if (ext.pirateEntered && knightsExt(state).robberLocked)
    errors.push('the pirate entered while the robber is locked');
  return errors;
}

/**
 * Seafarers with Cities & Knights (docs/rules/combos.md). The two modules hold their own rules for
 * ships and knights (knights are ship-aware, seafaring reads knights through the `routeGraph`
 * hook). This module holds what belongs to neither: the pirate enters play with the first barbarian
 * attack, shares the robber's lock, and a knight's chase moves only the piece beside it. It is
 * selected only through the combined scenarios (`scenario` in the compatibility matrix).
 */
export function seafarersKnightsModule(): GameModule {
  return {
    id: COMBO_ID,
    version: COMBO_VERSION,
    dependsOn: ['base', 'seafaring', 'knights'],
    conflictsWith: [],
    optionsSchema: [],
    initState: (): ComboExt => ({ pirateStart: null, pirateEntered: false }),
    initializeState: (ctx, state) => {
      // The barbarian track needs a slot outside an explicit board's perimeter (combos.md).
      if (!ctx.config.board) throw new Error('Seafaring with knights needs an explicit board');
      return holdPirate(state);
    },
    hooks: {
      onDiceResult: (state) => enterPirate(state),
      afterInput: (state) => closeEmptyAqueduct(forgetRemovedShips(state)),
      robberLike: limitBlockers,
      renderHints: (state, acc) => {
        const ext = comboExt(state);
        const hint: RenderHint = {
          module: COMBO_ID,
          kind: 'pirate-pending',
          pending: !ext.pirateEntered,
          start: ext.pirateStart,
        };
        return [...acc, hint];
      },
    },
    commands: {},
    systemInputs: {},
    phases: {},
    invariants: comboInvariants,
  };
}

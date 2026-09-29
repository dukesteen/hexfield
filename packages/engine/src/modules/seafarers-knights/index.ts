import type { GameModule, RenderHint } from '../../core/modules/index.js';
import { isFogTerrain } from '../../core/board/index.js';
import type { GameState } from '../../core/state/index.js';
import { hexesForVertex } from '../base/board/index.js';
import { knightsExt } from '../knights/types.js';
import { seafaringExt } from '../seafaring/types.js';
import { enterPirate, holdPirate, limitBlockers } from './pirate.js';
import { closeEmptyAqueduct } from './production.js';
import { forgetRemovedShips } from './ships.js';
import { COMBO_ID, COMBO_VERSION, comboExt } from './types.js';
import type { ComboExt } from './types.js';

export { COMBO_ID, COMBO_VERSION, comboExt } from './types.js';
export type { ComboExt } from './types.js';

/**
 * Public checks for the pair: the pirate enters with the first attack and not before, and no knight
 * stands beside unrevealed fog (a knight only reaches vertices where its seat's roads and ships end,
 * and every road or ship reveals the fog at both ends, combos.md "Fog").
 */
function comboInvariants(state: GameState): string[] {
  const errors: string[] = [];
  const fog = new Set(
    state.board.hexes.filter((hex) => isFogTerrain(hex.terrain)).map((hex) => hex.id),
  );
  if (fog.size > 0 && !seafaringExt(state).fog)
    for (const knight of knightsExt(state).knights)
      if (hexesForVertex(state, knight.vertex).some((hex) => fog.has(hex)))
        errors.push(`knight at ${knight.vertex} stands beside unrevealed fog`);
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
    // Runs after seafaring's own genesis, so a generated archipelago's pirate start is kept too.
    initializeState: (_ctx, state) => holdPirate(state),
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

import { failure, success } from '../../../core/types/index.js';
import { updateKnights, knightsExt } from '../types.js';
import { changed, paramsObject } from './card.js';
import type { CardModule } from './card.js';

/** Two production dice faces, each 1 to 6. */
function diceOf(params: unknown) {
  const object = paramsObject(params, ['dice']);
  if (!object.ok) return object;
  const dice = object.value.dice;
  return Array.isArray(dice) &&
    dice.length === 2 &&
    dice.every(
      (face) => typeof face === 'number' && Number.isSafeInteger(face) && face >= 1 && face <= 6,
    )
    ? success<[number, number]>([Number(dice[0]), Number(dice[1])])
    : failure('invalid-dice', 'The Alchemist sets two dice faces from 1 to 6');
}

/**
 * Alchemist: before rolling, set both production dice. Only the event die is rolled. The red die
 * chosen here is the one the progress card check reads.
 */
export const alchemist: CardModule = {
  card: {
    id: 'alchemist',
    timing: 'preRoll',
    problem: (state, _seat, params) => {
      const dice = diceOf(params);
      if (!dice.ok) return dice;
      return knightsExt(state).alchemist === null
        ? success(undefined)
        : failure('dice-already-set', 'The production dice are already set for this roll');
    },
    options: () =>
      Array.from({ length: 36 }, (_, index) => ({
        dice: [Math.floor(index / 6) + 1, (index % 6) + 1],
      })),
    apply: (state, seat, params) => {
      const dice = diceOf(params);
      if (!dice.ok) throw new Error('Validated Alchemist dice missing');
      return changed(
        updateKnights(state, (old) => ({ ...old, alchemist: dice.value })),
        { type: 'diceSet', seat, dice: dice.value },
      );
    },
  },
};

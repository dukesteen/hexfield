import { failure, success } from '../../../core/types/index.js';
import type { Result } from '../../../core/types/index.js';
import { cardKindsOf } from '../../base/shared.js';
import { knightsExt, updateKnights } from '../types.js';
import { paramsObject } from './card.js';
import type { CardModule } from './card.js';
import type { GameState } from '../../../core/state/index.js';
import type { Seat } from '../../../core/types/index.js';

function kindOf(state: GameState, params: unknown): Result<string> {
  const object = paramsObject(params, ['kind']);
  if (!object.ok) return object;
  const kind = object.value.kind;
  return typeof kind === 'string' && cardKindsOf(state).includes(kind)
    ? success(kind)
    : failure('invalid-kind', 'Name a resource or a commodity');
}

function alreadyNamed(state: GameState, seat: Seat, kind: string): boolean {
  const fleet = knightsExt(state).fleet;
  return fleet?.seat === seat && fleet.kinds.includes(kind);
}

/**
 * Merchant Fleet: name a resource or commodity; for the rest of the turn every bank trade that
 * gives that kind is 2:1, as many times as you like. Two fleets in a turn name two kinds. The
 * window is cleared when the turn ends.
 */
export const merchantFleet: CardModule = {
  card: {
    id: 'merchantFleet',
    timing: 'main',
    problem: (state, seat, params) => {
      const kind = kindOf(state, params);
      if (!kind.ok) return kind;
      return alreadyNamed(state, seat, kind.value)
        ? failure('already-named', 'That kind already trades 2:1 this turn')
        : success(undefined);
    },
    options: (state, seat) =>
      cardKindsOf(state)
        .filter((kind) => !alreadyNamed(state, seat, kind))
        .map((kind) => ({ kind })),
    apply: (state, seat, params) => {
      const kind = kindOf(state, params);
      if (!kind.ok) throw new Error('Validated fleet kind missing');
      const old = knightsExt(state).fleet;
      const kinds = old?.seat === seat ? [...old.kinds, kind.value] : [kind.value];
      return {
        state: updateKnights(state, (ext) => ({ ...ext, fleet: { seat, kinds } })),
        events: [{ type: 'fleetNamed', seat, kind: kind.value }],
        effects: [],
      };
    },
  },
};

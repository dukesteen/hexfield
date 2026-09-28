import { failure, success } from '../../../core/types/index.js';
import type { Resource, Seat } from '../../../core/types/index.js';
import type { GameState } from '../../../core/state/index.js';
import { verticesForHex } from '../../base/board/index.js';
import { exchangeBank } from '../../base/shared.js';
import { plainCard } from './card.js';
import type { ProgressCard } from './card.js';

/** Hexes of a terrain that touch at least one building of the seat, by id. */
export function touchedHexes(state: GameState, seat: Seat, terrain: string): string[] {
  const own = new Set(
    state.board.buildings.filter((piece) => piece.seat === seat).map((piece) => piece.vertex),
  );
  return state.board.hexes
    .filter(
      (hex) => hex.terrain === terrain && verticesForHex(state, hex.id).some((v) => own.has(v)),
    )
    .map((hex) => hex.id)
    .toSorted();
}

/** What the bank pays: 2 per touched hex, cities not doubling it, capped by what the bank holds. */
export function harvestAmount(
  state: GameState,
  seat: Seat,
  terrain: string,
  resource: Resource,
): number {
  return Math.min(2 * touchedHexes(state, seat, terrain).length, state.bank[resource] ?? 0);
}

/**
 * Irrigation and Mining: take 2 of a resource for each hex of a terrain that touches one of your
 * buildings. The robber does not matter. A short bank pays what it has left.
 */
export function harvestCard(id: string, terrain: string, resource: Resource): ProgressCard {
  return plainCard({
    id,
    timing: 'main',
    problem: (state, seat) =>
      touchedHexes(state, seat, terrain).length === 0
        ? failure('no-hex', `None of your buildings touches a ${terrain} hex`)
        : (state.bank[resource] ?? 0) === 0
          ? failure('empty-bank', `The bank has no ${resource}`)
          : success(undefined),
    apply: (state, seat) => {
      const taken = exchangeBank(
        state,
        seat,
        { [resource]: harvestAmount(state, seat, terrain, resource) },
        true,
      );
      return {
        state: taken.state,
        events: [
          {
            type: 'harvested',
            seat,
            resource,
            count: harvestAmount(state, seat, terrain, resource),
          },
        ],
        effects: taken.effects,
      };
    },
  });
}

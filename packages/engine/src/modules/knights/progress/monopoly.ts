import type { GameState } from '../../../core/state/index.js';
import { kindBounds } from '../../../core/resources/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { Result, Seat } from '../../../core/types/index.js';
import { cardKindsOf, frame, ownSeat, pushPhase } from '../../base/shared.js';
import { paramsObject } from './card.js';
import type { ProgressCard } from './card.js';

/** The other seats that may hold the kind, judged on public bounds, in seat order. */
export function mayHold(state: GameState, actor: Seat, kind: string): Seat[] {
  return state.config.seats.filter(
    (seat) => seat !== actor && (kindBounds(ownSeat(state, seat).resources).max[kind] ?? 0) > 0,
  );
}

function kindOf(state: GameState, params: unknown, kinds: readonly string[]): Result<string> {
  const object = paramsObject(params, ['kind']);
  if (!object.ok) return object;
  const kind = object.value.kind;
  return typeof kind === 'string' && kinds.includes(kind) && cardKindsOf(state).includes(kind)
    ? success(kind)
    : failure('invalid-kind', 'Name one of the card kinds this monopoly can take');
}

/**
 * Resource Monopoly (2 cards from each seat) and Trade Monopoly (1). Each other seat that may hold
 * the kind reveals its count through the base monopoly frame (`REVEAL_COUNT`, the same hidden
 * information as the base monopoly); then up to `limit` cards move to the player.
 */
export function monopolyCard(id: string, kinds: readonly string[], limit: number): ProgressCard {
  return {
    id,
    timing: 'main',
    problem: (state, seat, params) => {
      const kind = kindOf(state, params, kinds);
      if (!kind.ok) return kind;
      return mayHold(state, seat, kind.value).length > 0
        ? success(undefined)
        : failure('no-holder', 'No other seat can hold that kind');
    },
    options: (_state, _seat) => kinds.map((kind) => ({ kind })),
    apply: (state, seat, params) => {
      const kind = kindOf(state, params, kinds);
      if (!kind.ok) throw new Error('Validated monopoly kind missing');
      const remaining = mayHold(state, seat, kind.value);
      return {
        state: pushPhase(
          state,
          frame('monopoly', { seat, resource: kind.value, remaining, limit }),
        ),
        events: [{ type: 'monopolyPlayed', seat, kind: kind.value, limit }],
        effects: [],
      };
    },
  };
}

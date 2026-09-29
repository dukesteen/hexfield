import type { GameState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { Result, Seat } from '../../../core/types/index.js';
import { verticesForHex } from '../../base/board/index.js';
import { robberHexes } from '../../base/robber.js';
import { frame, ownSeat, pushPhase } from '../../base/shared.js';
import { paramsObject, stringOf } from './card.js';
import type { CardModule } from './card.js';
import { seatsFrom } from './hand.js';
import type { HandlerContext } from '../../../core/modules/index.js';

function hexOf(params: unknown): Result<string> {
  const object = paramsObject(params, ['hex']);
  if (!object.ok) return object;
  const hex = stringOf(object.value.hex);
  return hex === undefined
    ? failure('invalid-hex', 'Choose a land hex for the robber')
    : success(hex);
}

/**
 * The seats the Bishop robs on a hex, in turn order from the player: every other seat with a
 * building there and a card in hand (one card per seat, however many buildings it has there), after
 * the module target hooks (the robber lock).
 */
export function bishopVictims(
  state: GameState,
  seat: Seat,
  hex: string,
  ctx: HandlerContext,
): Seat[] {
  const vertices = new Set(verticesForHex(state, hex));
  const occupied = state.config.seats.filter(
    (other) =>
      other !== seat &&
      ownSeat(state, other).resources.total > 0 &&
      state.board.buildings.some((piece) => piece.seat === other && vertices.has(piece.vertex)),
  );
  const allowed = ctx.hooks.stealTargets(state, seat, 'robber', hex, occupied);
  return seatsFrom(state, seat).filter((other) => allowed.includes(other));
}

/**
 * Bishop (Taxation): only once the robber is free (after the first attack). Move the robber to any
 * other land hex, even one with no building, and steal one random resource or commodity card from
 * each other seat with a building there. Progress cards are never taken. Each theft is a base
 * `stealResult` frame, so it is the same hidden random pick, proved as in base.
 */
export const bishop: CardModule = {
  card: {
    id: 'bishop',
    timing: 'main',
    problem: (state, _seat, params, ctx) => {
      const hex = hexOf(params);
      if (!hex.ok) return hex;
      return robberHexes(state, ctx).includes(hex.value)
        ? success(undefined)
        : failure('illegal-robber-hex', 'The robber must move to a different legal land hex');
    },
    options: (state, _seat, ctx) => robberHexes(state, ctx).map((hex) => ({ hex })),
    apply: (state, seat, params, ctx) => {
      const hex = hexOf(params);
      if (!hex.ok) throw new Error('Validated Bishop hex missing');
      let next: GameState = { ...state, board: { ...state.board, robberHex: hex.value } };
      const victims = bishopVictims(next, seat, hex.value, ctx);
      // The first victim's frame must end up on top, so push them last.
      for (const victim of victims.toReversed())
        next = pushPhase(next, frame('stealResult', { thief: seat, victim, returnTo: 'pop' }));
      return {
        state: next,
        events: [{ type: 'robberMoved', hex: hex.value, seat }],
        effects: [],
      };
    },
  },
};

import type { GameState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { Result, Seat } from '../../../core/types/index.js';
import { TERRAIN_RESOURCE } from '../../base/constants.js';
import { isLandHex, verticesForHex } from '../../base/board/index.js';
import { knightsExt, updateKnights } from '../types.js';
import { paramsObject, stringOf } from './card.js';
import type { CardModule } from './card.js';

function hexOf(params: unknown): Result<string> {
  const object = paramsObject(params, ['hex']);
  if (!object.ok) return object;
  const hex = stringOf(object.value.hex);
  return hex === undefined ? failure('invalid-hex', 'Choose a land hex') : success(hex);
}

/** Land hexes that touch one of the seat's settlements or cities, by id. Never a gold hex. */
export function hexesNextToSeat(state: GameState, seat: Seat): string[] {
  const own = new Set(
    state.board.buildings.filter((piece) => piece.seat === seat).map((piece) => piece.vertex),
  );
  return state.board.hexes
    .filter(
      (hex) =>
        hex.terrain !== 'gold' &&
        isLandHex(state, hex.id) &&
        verticesForHex(state, hex.id).some((v) => own.has(v)),
    )
    .map((hex) => hex.id)
    .toSorted();
}

/**
 * The card kind a merchant on this hex trades 2:1 for its controller: the hex's resource, never its
 * commodity. A desert has none.
 */
export function merchantKind(state: GameState, hex: string): string | null {
  const terrain = state.board.hexes.find((item) => item.id === hex)?.terrain;
  return terrain === undefined ? null : (TERRAIN_RESOURCE[terrain] ?? null);
}

/**
 * Merchant: take the merchant piece, wherever it is, and put it on a land hex next to one of your
 * settlements or cities. You control it, earn 1 point and trade its hex's resource 2:1, until any
 * Merchant card moves it. A desert is a land hex: it gives the point and no rate. A gold hex is
 * refused (Cities and Knights with Seafarers).
 */
export const merchant: CardModule = {
  card: {
    id: 'merchant',
    timing: 'main',
    problem: (state, seat, params) => {
      const hex = hexOf(params);
      if (!hex.ok) return hex;
      if (!hexesNextToSeat(state, seat).includes(hex.value))
        return failure('not-adjacent', 'The merchant goes on a land hex next to your building');
      const held = knightsExt(state).merchant;
      return held?.seat === seat && held.hex === hex.value
        ? failure('already-there', 'You already control the merchant on that hex')
        : success(undefined);
    },
    options: (state, seat) => {
      const held = knightsExt(state).merchant;
      return hexesNextToSeat(state, seat)
        .filter((hex) => !(held?.seat === seat && held.hex === hex))
        .map((hex) => ({ hex }));
    },
    apply: (state, seat, params) => {
      const hex = hexOf(params);
      if (!hex.ok) throw new Error('Validated merchant hex missing');
      const from = knightsExt(state).merchant;
      return {
        state: updateKnights(state, (old) => ({ ...old, merchant: { seat, hex: hex.value } })),
        events: [{ type: 'merchantPlaced', seat, hex: hex.value, from: from?.seat ?? null }],
        effects: [],
      };
    },
  },
};

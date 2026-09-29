import { describe, expect, test } from 'vitest';
import type { GameState } from '../../../core/state/index.js';
import { handOf, withBuildings, withHand } from '../support.js';
import { knightsExt, updateKnights } from '../types.js';
import { at, engine, held, play, refusal, scene, withCards } from './testing.js';

function position() {
  const { state, ring, out } = scene();
  const built = withBuildings(state, [{ vertex: at(ring, 3), seat: 0 }]);
  return { state: withHand(withCards(built, 0, 'medicine'), 0, { grain: 1, ore: 2 }), ring, out };
}

/** A pillaged city lying on its side at a vertex: a settlement that still uses a city piece. */
function withSideways(state: GameState, vertex: string): GameState {
  const placed = withBuildings(state, [{ vertex, seat: 0 }]);
  return updateKnights(
    {
      ...placed,
      seats: placed.seats.map((seat) =>
        seat.seat === 0
          ? {
              ...seat,
              piecesLeft: {
                ...seat.piecesLeft,
                settlement: (seat.piecesLeft.settlement ?? 0) + 1,
                city: (seat.piecesLeft.city ?? 0) - 1,
                sideways: 1,
              },
            }
          : seat,
      ),
    },
    (old) => ({ ...old, sideways: [{ seat: 0, vertex }] }),
  );
}

const listed = (game: GameState) =>
  engine
    .getLegalCommands(game, 0)
    .commands.filter((item) => item.type === 'PLAY_PROGRESS_CARD')
    .map((item) => item.params);

describe('Medicine', () => {
  test('upgrades a settlement for 1 grain and 2 ore', () => {
    const { state, out } = position();
    const after = play(state, 0, 'medicine', { vertex: at(out, 0) });
    expect(after.board.buildings.find((piece) => piece.vertex === at(out, 0))?.kind).toBe('city');
    expect(handOf(after, 0)).toMatchObject({ grain: 0, ore: 0 });
    expect(after.seats[0]?.piecesLeft.city).toBe((state.seats[0]?.piecesLeft.city ?? 0) - 1);
    expect(after.seats[0]?.piecesLeft.settlement).toBe(
      (state.seats[0]?.piecesLeft.settlement ?? 0) + 1,
    );
    expect(held(after, 0)).toEqual([]);
  });

  test('one card upgrades one settlement, and the price must be paid', () => {
    const { state, out, ring } = position();
    expect(
      refusal(withHand(state, 0, { grain: 1, ore: 1 }), 0, 'medicine', { vertex: at(out, 0) }),
    ).toBe('insufficient-resources');
    expect(refusal(state, 0, 'medicine', { vertex: at(ring, 5) })).toBe('illegal-city');
    expect(refusal(state, 0, 'medicine', { vertex: at(ring, 1) })).toBe('illegal-city');
    const after = play(state, 0, 'medicine', { vertex: at(ring, 3) });
    expect(held(after, 0)).toEqual([]);
  });

  test('a seat with no city piece left cannot upgrade', () => {
    const { state, out } = position();
    const none = {
      ...state,
      seats: state.seats.map((seat) =>
        seat.seat === 0 ? { ...seat, piecesLeft: { ...seat.piecesLeft, city: 0 } } : seat,
      ),
    };
    expect(refusal(none, 0, 'medicine', { vertex: at(out, 0) })).toBe('illegal-city');
  });

  test('a sideways piece goes first, and is upgraded without a city piece', () => {
    const { state, ring, out } = position();
    const flat = withSideways(state, at(ring, 1));
    // Any other settlement waits until the sideways piece is upright.
    expect(refusal(flat, 0, 'medicine', { vertex: at(out, 0) })).toBe('illegal-city');
    const after = play(flat, 0, 'medicine', { vertex: at(ring, 1) });
    expect(knightsExt(after).sideways).toEqual([]);
    expect(after.board.buildings.find((piece) => piece.vertex === at(ring, 1))?.kind).toBe('city');
    expect(after.seats[0]?.piecesLeft.sideways).toBe(0);
    expect(after.seats[0]?.piecesLeft.city).toBe(flat.seats[0]?.piecesLeft.city);
  });

  test('every upgradable settlement is listed for a hand that can pay', () => {
    const { state, out, ring } = position();
    expect(listed(state)).toEqual(
      expect.arrayContaining([{ vertex: at(out, 0) }, { vertex: at(ring, 3) }]),
    );
    expect(listed(withHand(state, 0, {}))).toEqual([]);
  });
});

import { describe, expect, test } from 'vitest';
import { createBaseEngine, baseModule } from '../index.js';
import type { GameConfig, GameState, PrivateState } from '../../../core/state/types.js';
import type { Seat } from '../../../core/types/index.js';
import { baseExt } from '../types.js';

const engine = createBaseEngine();
function config(options: Record<string, unknown> = {}, seats: Seat[] = [0, 1, 2]): GameConfig {
  return {
    modules: [{ id: 'base', version: baseModule().version }],
    seats,
    options: { base: options },
  };
}
function genesis(): GameState {
  return engine.createGame(config(), new Uint8Array(32));
}
function withSeat(
  state: GameState,
  seat: Seat,
  update: (old: GameState['seats'][number]) => GameState['seats'][number],
): GameState {
  return { ...state, seats: state.seats.map((old) => (old.seat === seat ? update(old) : old)) };
}

describe('base options and invariant diagnostics', () => {
  test.each([
    {},
    { preRollSec: 0, mainSec: 10, discardSec: 10, robberSec: 10 },
    { preRollSec: 10, mainSec: 10, discardSec: 10 },
    { preRollSec: 10, mainSec: 10, discardSec: 10, robberSec: 10, extra: 1 },
    [],
  ])('rejects malformed turnTimer %j', (turnTimer) => {
    expect(() => engine.createGame(config({ turnTimer }), new Uint8Array(32))).toThrow(
      'Invalid option base.turnTimer',
    );
  });
  test('rejects fractional timer seconds before genesis state is built', () => {
    const turnTimer = { preRollSec: 1.5, mainSec: 10, discardSec: 10, robberSec: 10 };
    expect(() => engine.createGame(config({ turnTimer }), new Uint8Array(32))).toThrow(
      'Game state numbers must be safe integers',
    );
  });
  test('accepts timer values and rejects out-of-range base options and seat counts', () => {
    const turnTimer = { preRollSec: 5, mainSec: 11, discardSec: 17, robberSec: 23 };
    expect(
      engine.createGame(config({ turnTimer }), new Uint8Array(32)).config.options.base,
    ).toMatchObject({ turnTimer });
    expect(() => engine.createGame(config({ vpTarget: 2 }), new Uint8Array(32))).toThrow(
      'Invalid option base.vpTarget',
    );
    expect(() => engine.createGame(config({ mapLayout: 'unknown' }), new Uint8Array(32))).toThrow(
      'Invalid option base.mapLayout',
    );
    expect(() => engine.createGame(config({}, [0, 1, 2, 3, 4]), new Uint8Array(32))).toThrow(
      'Base game requires two to four seats',
    );
  });

  test('public diagnostics catch board identity, ownership, robber, and piece supply corruption', () => {
    const initial = genesis();
    expect(engine.checkInvariants(initial)).toEqual([]);
    const roads = {
      ...initial,
      board: {
        ...initial.board,
        roads: [
          { edge: 'e:0,0,W', seat: 0 as const },
          { edge: 'e:0,0,W', seat: 0 as const },
          { edge: 'toString', seat: 5 as const },
        ],
      },
    };
    expect(engine.checkInvariants(roads)).toEqual(
      expect.arrayContaining([
        'duplicate road edge',
        'road uses unknown edge',
        'road has unknown owner',
      ]),
    );
    const buildings = {
      ...initial,
      board: {
        ...initial.board,
        buildings: [
          { vertex: 'v:0,0,N', seat: 0 as const, kind: 'settlement' },
          { vertex: 'v:0,0,N', seat: 0 as const, kind: 'city' },
          { vertex: 'constructor', seat: 5 as const, kind: 'outpost' },
        ],
      },
    };
    expect(engine.checkInvariants(buildings)).toEqual(
      expect.arrayContaining([
        'duplicate building vertex',
        'building uses unknown vertex',
        'building has unknown owner',
        'building has unknown kind',
      ]),
    );
    expect(
      engine.checkInvariants({ ...initial, board: { ...initial.board, robberHex: 'constructor' } }),
    ).toContain('robber must occupy one board hex');
    const noRoadSupply = withSeat(initial, 0, (seat) => ({
      ...seat,
      piecesLeft: { ...seat.piecesLeft, road: -1 },
    }));
    expect(engine.checkInvariants(noRoadSupply)).toEqual(
      expect.arrayContaining(['seat 0 invalid road supply', 'seat 0 road supply mismatch']),
    );
  });

  test('public diagnostics catch invalid awards, bank, slots, deck and play turn', () => {
    const initial = genesis();
    expect(
      engine.checkInvariants({
        ...initial,
        awards: { ...initial.awards, longestRoad: 0, largestArmy: 1 },
      }),
    ).toEqual(
      expect.arrayContaining([
        'longest road holder is below threshold',
        'largest army holder is below threshold',
      ]),
    );
    expect(engine.checkInvariants({ ...initial, bank: { ...initial.bank, brick: 20 } })).toContain(
      'invalid bank brick',
    );
    const duplicatedSlots = {
      ...initial,
      seats: initial.seats.map((seat) => ({
        ...seat,
        cardSlots: [{ slotId: 'same', deck: 'dev', acquiredTurn: 0 }],
      })),
    };
    expect(engine.checkInvariants(duplicatedSlots)).toContain('duplicate card slot');
    expect(
      engine.checkInvariants({ ...initial, decks: { dev: { remaining: 24, drawn: [] } } }),
    ).toContain('development deck count mismatch');
    const ext = baseExt(initial.ext.base);
    expect(
      engine.checkInvariants({
        ...initial,
        ext: { ...initial.ext, base: { ...ext, devPlayedTurn: initial.turn.number + 1 } },
      }),
    ).toContain('development play turn is in the future');
  });

  test('private diagnostics detect a missing owner and resource nonconservation', () => {
    const state = genesis();
    const privates = new Map<Seat, PrivateState>(
      state.config.seats.map((seat) => [seat, engine.createPrivateState(seat)]),
    );
    expect(engine.checkPrivateInvariants(state, privates)).toEqual([]);
    const withoutThird = new Map(privates);
    withoutThird.delete(2);
    expect(engine.checkPrivateInvariants(state, withoutThird)).toContain(
      'missing private state for seat 2',
    );
    const first = privates.get(0);
    if (!first) throw new Error('No private state');
    privates.set(0, { ...first, hand: { ...first.hand, brick: 1 } });
    expect(engine.checkPrivateInvariants(state, privates)).toContain(
      'brick bank and private hands total 20, expected 19',
    );
  });
});

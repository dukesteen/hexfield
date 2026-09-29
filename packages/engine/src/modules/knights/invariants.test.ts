import { describe, expect, test } from 'vitest';
import type { GameState, PrivateState } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import { knightsEngine } from './testing.js';
import { updateKnights } from './types.js';
import { newGame, ringLayout, withBuildings, withKnights } from './support.js';

const engine = knightsEngine();
const at = (list: readonly string[], index: number): string => list[index] ?? '';

function errors(state: GameState): string[] {
  return engine.checkInvariants(state);
}

describe('knights invariants', () => {
  const base = newGame(engine, { seats: 3 });
  const { ring } = ringLayout(base);

  test('a clean position passes', () => {
    const state = withKnights(base, [
      { seat: 0, vertex: at(ring, 0) },
      { seat: 0, vertex: at(ring, 1) },
      { seat: 0, vertex: at(ring, 2), level: 2 },
    ]);
    expect(errors(state)).toEqual([]);
  });

  test('at most two knights of each level per seat', () => {
    const three = withKnights(
      base,
      [0, 1, 2].map((index) => ({ seat: 0 as const, vertex: at(ring, index) })),
    );
    expect(errors(three)).toContain('seat 0 has too many level 1 knights');
    const mighty = withKnights(
      base,
      [0, 1, 2].map((index) => ({ seat: 1 as const, vertex: at(ring, index), level: 3 })),
    );
    expect(errors(mighty)).toContain('seat 1 has too many level 3 knights');
  });

  test('a displaced knight in its owner’s hand still counts against its level', () => {
    const state = withKnights(base, [
      { seat: 1, vertex: at(ring, 0) },
      { seat: 1, vertex: at(ring, 1) },
    ]);
    const waiting = {
      ...state,
      turn: {
        ...state.turn,
        phase: [
          ...state.turn.phase,
          {
            module: 'knights',
            id: 'displaced',
            data: {
              seat: 1,
              origin: at(ring, 3),
              level: 1,
              active: false,
              ready: false,
              promotedTurn: null,
            },
          },
        ],
      },
    };
    expect(errors(waiting)).toContain('seat 1 has too many level 1 knights');
  });

  test('knights stand alone on empty vertices, with a level and an owner', () => {
    const doubled = updateKnights(base, (old) => ({
      ...old,
      knights: [
        { seat: 0, vertex: at(ring, 0), level: 1, active: false, ready: false, promotedTurn: null },
        { seat: 1, vertex: at(ring, 0), level: 1, active: false, ready: false, promotedTurn: null },
      ],
    }));
    expect(errors(doubled)).toContain('two knights on one vertex');
    const onBuilding = withKnights(withBuildings(base, [{ vertex: at(ring, 0), seat: 0 }]), [
      { seat: 1, vertex: at(ring, 0) },
    ]);
    expect(errors(onBuilding)).toContain('a knight stands on a building');
    expect(errors(withKnights(base, [{ seat: 0, vertex: at(ring, 0), level: 4 }]))).toContain(
      'invalid knight level',
    );
    expect(
      errors(withKnights(base, [{ seat: 0, vertex: at(ring, 0), active: false, ready: true }])),
    ).toContain('a ready knight is inactive');
  });

  test('walls: one per city, three per seat, always under the owner’s city', () => {
    const cities = [0, 1, 2, 3].map((index) => ({
      vertex: at(ring, index),
      seat: 0 as const,
      kind: 'city',
    }));
    const built = withBuildings(base, cities);
    const four = updateKnights(built, (old) => ({
      ...old,
      walls: cities.map((city) => ({ seat: 0 as const, vertex: city.vertex })),
    }));
    expect(errors(four)).toContain('seat 0 has too many walls');
    const twice = updateKnights(built, (old) => ({
      ...old,
      walls: [
        { seat: 0, vertex: at(ring, 0) },
        { seat: 0, vertex: at(ring, 0) },
      ],
    }));
    expect(errors(twice)).toContain('two walls on one city');
    const stray = updateKnights(base, (old) => ({
      ...old,
      walls: [{ seat: 0, vertex: at(ring, 0) }],
    }));
    expect(errors(stray)).toContain('a wall is not on a city of its owner');
  });

  test('sideways pieces are settlements of their owner and match the supply count', () => {
    const settled = withBuildings(base, [{ vertex: at(ring, 0), seat: 0 }]);
    const flat = updateKnights(settled, (old) => ({
      ...old,
      sideways: [{ seat: 0, vertex: at(ring, 0) }],
    }));
    expect(errors(flat)).toContain('seat 0 sideways supply mismatch');
    const stray = updateKnights(base, (old) => ({
      ...old,
      sideways: [{ seat: 0, vertex: at(ring, 0) }],
    }));
    expect(errors(stray)).toContain('a sideways piece is not a settlement of its owner');
  });

  test('metropolises: one per city, on a city of a holder at level 4 or more', () => {
    const city = at(ring, 0);
    const built = withBuildings(base, [{ vertex: city, seat: 0, kind: 'city' }]);
    const levels = { trade: 4, politics: 0, science: 0 };
    const held = updateKnights(built, (old) => ({
      ...old,
      improvements: old.improvements.map((item, seat) => (seat === 0 ? levels : item)),
      metropolises: { ...old.metropolises, trade: { seat: 0, vertex: city } },
    }));
    expect(errors(held)).toEqual([]);
    const doubled = updateKnights(held, (old) => ({
      ...old,
      improvements: old.improvements.map((item, seat) =>
        seat === 0 ? { ...levels, politics: 4 } : item,
      ),
      metropolises: { ...old.metropolises, politics: { seat: 0, vertex: city } },
    }));
    expect(errors(doubled)).toContain('two metropolises on one city');
    const low = updateKnights(held, (old) => ({
      ...old,
      improvements: old.improvements.map((item, seat) =>
        seat === 0 ? { ...levels, trade: 3 } : item,
      ),
    }));
    expect(errors(low)).toContain('trade metropolis holder is below level 4');
    const stray = updateKnights(held, (old) => ({
      ...old,
      metropolises: { ...old.metropolises, trade: { seat: 0, vertex: at(ring, 1) } },
    }));
    expect(errors(stray)).toContain('trade metropolis is not on a city of its holder');
  });

  test('defender counts are per seat and never negative; the ship stays below the last step', () => {
    const broken = updateKnights(base, (old) => ({ ...old, defenders: [0, -1, 0] }));
    expect(errors(broken)).toContain('invalid defender count');
    expect(errors(updateKnights(base, (old) => ({ ...old, defenders: [0] })))).toContain(
      'defenders are not per seat',
    );
    expect(errors(updateKnights(base, (old) => ({ ...old, barbarians: { step: 7 } })))).toContain(
      'invalid barbarian step',
    );
  });
});

describe('commodity conservation', () => {
  test('a commodity out of thin air, or missing, is reported by the private audit', () => {
    const state = newGame(engine, { seats: 3 });
    const privates = new Map<Seat, PrivateState>(
      state.config.seats.map((seat) => [seat, engine.createPrivateState(seat, state.config)]),
    );
    expect(engine.checkPrivateInvariants(state, privates)).toEqual([]);
    const first = privates.get(0);
    if (!first) throw new Error('No private state');
    privates.set(0, { ...first, hand: { ...first.hand, paper: 1 } });
    expect(engine.checkPrivateInvariants(state, privates)).toContain(
      'paper bank and private hands total 13, expected 12',
    );
    privates.set(0, { ...first, hand: { ...first.hand, coin: -1 } });
    expect(engine.checkPrivateInvariants(state, privates)).toContain(
      'coin bank and private hands total 11, expected 12',
    );
  });
});

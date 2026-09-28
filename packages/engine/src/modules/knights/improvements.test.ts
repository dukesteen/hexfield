import { describe, expect, test } from 'vitest';
import type { GameState } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import { knightsEngine } from './testing.js';
import { knightsExt, updateKnights } from './types.js';
import {
  handOf,
  inMain,
  newGame,
  rejection,
  submit,
  top,
  verticesOfHex,
  withBuildings,
  withHand,
  withLevels,
} from './support.js';

const engine = knightsEngine();

/** One vertex from each of `count` different hexes; the tests never build roads, so spacing is moot. */
function cityVertices(state: GameState, count: number): string[] {
  const picked: string[] = [];
  for (const hex of state.board.hexes) {
    const vertex = verticesOfHex(state, hex.id).find((item) => !picked.includes(item));
    if (vertex !== undefined) picked.push(vertex);
    if (picked.length === count) return picked;
  }
  throw new Error('Not enough city sites');
}

/** A position with the given cities for seat 0 (and other seats' cities), in the main phase. */
function position(cities: Partial<Record<Seat, number>> = { 0: 1 }): {
  state: GameState;
  sites: Record<number, string[]>;
} {
  let state = newGame(engine, { seats: 3 });
  const all = cityVertices(state, 12);
  const sites: Record<number, string[]> = {};
  const pieces: { vertex: string; seat: Seat; kind: string }[] = [];
  let next = 0;
  for (const seat of [0, 1, 2] as const) {
    const count = cities[seat] ?? 0;
    sites[seat] = all.slice(next, next + count);
    for (const vertex of sites[seat]) pieces.push({ vertex, seat, kind: 'city' });
    next += count;
  }
  state = withBuildings(state, pieces);
  return { state: inMain(state), sites };
}

const improve = (state: GameState, seat: Seat, track: string) =>
  submit(engine, state, seat, { type: 'BUILD_IMPROVEMENT', track });
const refused = (state: GameState, seat: Seat, track: string) =>
  rejection(engine, state, seat, { type: 'BUILD_IMPROVEMENT', track });

describe('city improvements', () => {
  test('level k costs k commodities of the track, bought in order up to 5', () => {
    let { state } = position();
    state = withHand(state, 0, { cloth: 6, coin: 6, paper: 6 });
    for (const [track, kind] of [
      ['trade', 'cloth'],
      ['politics', 'coin'],
      ['science', 'paper'],
    ] as const)
      for (let level = 1; level <= 3; level++) {
        const before = handOf(state, 0)[kind] ?? 0;
        state = improve(state, 0, track);
        expect(handOf(state, 0)[kind]).toBe(before - level);
        expect(knightsExt(state).improvements[0]?.[track]).toBe(level);
      }
    expect(engine.checkInvariants(state)).toEqual([]);
  });

  test('another commodity, resources, or too few cards do not pay', () => {
    const { state } = position();
    expect(refused(withHand(state, 0, { coin: 3, ore: 5 }), 0, 'trade')).toBe(
      'insufficient-resources',
    );
    const level1 = withLevels(withHand(state, 0, { cloth: 1 }), 0, { trade: 1 });
    expect(refused(level1, 0, 'trade')).toBe('insufficient-resources');
    expect(refused(withHand(state, 0, { cloth: 1 }), 0, 'sky')).toBe('invalid-track');
  });

  test('a city is needed, and an improvement stays after the last city is gone', () => {
    const none = inMain(newGame(engine));
    expect(refused(withHand(none, 0, { cloth: 5 }), 0, 'trade')).toBe('no-city');
    const { state } = position();
    const improved = improve(withHand(state, 0, { cloth: 1 }), 0, 'trade');
    const lost = {
      ...improved,
      board: { ...improved.board, buildings: [] },
    };
    expect(knightsExt(lost).improvements[0]?.trade).toBe(1);
    expect(refused(withHand(lost, 0, { cloth: 5 }), 0, 'trade')).toBe('no-city');
  });

  test('level 5 is the last', () => {
    const { state } = position();
    const capped = withLevels(withHand(state, 0, { cloth: 9 }), 0, { trade: 5 });
    expect(refused(capped, 0, 'trade')).toBe('max-level');
  });

  test('only the building seat can improve, and only in the main phase', () => {
    const { state } = position({ 0: 1, 1: 1 });
    const rich = withHand(withHand(state, 0, { cloth: 5 }), 1, { cloth: 5 });
    expect(refused(rich, 1, 'trade')).toBe('not-pending');
    const rolling = {
      ...rich,
      turn: { ...rich.turn, phase: [{ id: 'dice', module: 'base', data: null }] },
    };
    expect(refused(rolling, 0, 'trade')).not.toBeNull();
  });

  test('legal commands list the affordable tracks', () => {
    const { state } = position();
    const rich = withHand(state, 0, { cloth: 1, coin: 1 });
    const priv = {
      ...engine.createPrivateState(0, rich.config),
      hand: { ...engine.createPrivateState(0, rich.config).hand, cloth: 1, coin: 1 },
    };
    const commands = engine
      .getLegalCommands(rich, 0, priv)
      .commands.filter((command) => command.type === 'BUILD_IMPROVEMENT');
    expect(commands).toEqual([
      { type: 'BUILD_IMPROVEMENT', track: 'trade' },
      { type: 'BUILD_IMPROVEMENT', track: 'politics' },
    ]);
    expect(top(rich)?.id).toBe('main');
  });
});

describe('metropolises', () => {
  test('the first seat to level 4 puts the metropolis on its only city: 4 points for that city', () => {
    const { state, sites } = position({ 0: 1 });
    const start = withLevels(withHand(state, 0, { cloth: 4 }), 0, { trade: 3 });
    const done = improve(start, 0, 'trade');
    expect(knightsExt(done).metropolises.trade).toEqual({ seat: 0, vertex: sites[0]?.[0] });
    expect(top(done)?.id).toBe('main');
    // A city is 2, the metropolis 2 more.
    expect(done.seats[0]?.publicVp).toBe(4);
    expect(engine.computeVictoryPoints(done, 0)).toMatchObject({ public: 4 });
    expect(engine.checkInvariants(done)).toEqual([]);
  });

  test('with several cities the seat chooses one, then the metropolis is placed', () => {
    const { state, sites } = position({ 0: 2 });
    const [first, second] = sites[0] ?? [];
    const asked = improve(
      withLevels(withHand(state, 0, { coin: 4 }), 0, { politics: 3 }),
      0,
      'politics',
    );
    expect(top(asked)).toMatchObject({ id: 'metropolis', module: 'knights' });
    expect(knightsExt(asked).metropolises.politics).toBeNull();
    expect(refused(asked, 0, 'trade')).toBe('not-pending');
    expect(
      rejection(engine, asked, 0, {
        type: 'PLACE_METROPOLIS',
        track: 'politics',
        vertex: 'nowhere',
      }),
    ).toBe('illegal-metropolis');
    expect(
      rejection(engine, asked, 1, { type: 'PLACE_METROPOLIS', track: 'politics', vertex: first }),
    ).toBe('not-pending');
    const legal = engine
      .getLegalCommands(asked, 0)
      .commands.filter((command) => command.type === 'PLACE_METROPOLIS');
    expect(legal).toHaveLength(2);
    const placed = submit(engine, asked, 0, {
      type: 'PLACE_METROPOLIS',
      track: 'politics',
      vertex: second,
    });
    expect(knightsExt(placed).metropolises.politics).toEqual({ seat: 0, vertex: second });
    expect(top(placed)?.id).toBe('main');
    // A timeout picks the lowest available city.
    const timed = engine.apply(asked, {
      kind: 'system',
      type: 'TIMEOUT',
      seat: 0,
      phase: 'metropolis',
    });
    if (!timed.ok) throw new Error(timed.error.message);
    expect(knightsExt(timed.value.state).metropolises.politics?.vertex).toBe(
      [first, second].toSorted()[0],
    );
  });

  test('one seat holds several metropolises on different cities', () => {
    const { state, sites } = position({ 0: 2 });
    let next = withLevels(withHand(state, 0, { cloth: 4, coin: 4 }), 0, { trade: 3, politics: 3 });
    next = improve(next, 0, 'trade');
    // The first metropolis went to one of two cities; the second has one city left.
    const trade = knightsExt(next).metropolises.trade;
    expect(top(next)?.id).toBe('metropolis');
    next = submit(engine, next, 0, {
      type: 'PLACE_METROPOLIS',
      track: 'trade',
      vertex: sites[0]?.[0],
    });
    next = improve(next, 0, 'politics');
    expect(top(next)?.id).toBe('main');
    const held = knightsExt(next).metropolises;
    expect(held.politics?.vertex).toBe(sites[0]?.[1]);
    expect(held.trade?.vertex).not.toBe(held.politics?.vertex);
    expect(trade).toBeNull();
    expect(next.seats[0]?.publicVp).toBe(8);
  });

  test('level 4 needs a city without a metropolis', () => {
    const { state } = position({ 0: 1 });
    const holding = improve(
      withLevels(withHand(state, 0, { cloth: 4, coin: 4 }), 0, { trade: 3, politics: 3 }),
      0,
      'trade',
    );
    expect(refused(holding, 0, 'politics')).toBe('no-available-city');
    const none = position({ 1: 1 }).state;
    expect(
      refused(withLevels(withHand(none, 0, { coin: 4 }), 0, { politics: 3 }), 0, 'politics'),
    ).toBe('no-city');
  });

  test('the second seat to level 4 gets no metropolis, but still needs an available city', () => {
    const { state } = position({ 0: 1, 1: 1 });
    const held = improve(withLevels(withHand(state, 0, { cloth: 4 }), 0, { trade: 3 }), 0, 'trade');
    const second = withLevels(
      withHand({ ...held, turn: { ...held.turn, activeSeat: 1 } }, 1, { cloth: 4 }),
      1,
      { trade: 3 },
    );
    const done = improve(second, 1, 'trade');
    expect(knightsExt(done).metropolises.trade?.seat).toBe(0);
    expect(knightsExt(done).improvements[1]?.trade).toBe(4);
    expect(done.seats[1]?.publicVp).toBe(2);
  });

  test('level 5 takes the metropolis from a level-4 holder, who cannot regain it', () => {
    const { state, sites } = position({ 0: 1, 1: 2 });
    const holder = improve(
      withLevels(withHand(state, 0, { cloth: 4 }), 0, { trade: 3 }),
      0,
      'trade',
    );
    expect(holder.seats[0]?.publicVp).toBe(4);
    const rival = withLevels(
      withHand({ ...holder, turn: { ...holder.turn, activeSeat: 1 } }, 1, { cloth: 5 }),
      1,
      { trade: 4 },
    );
    const asked = improve(rival, 1, 'trade');
    expect(top(asked)?.id).toBe('metropolis');
    const stolen = submit(engine, asked, 1, {
      type: 'PLACE_METROPOLIS',
      track: 'trade',
      vertex: sites[1]?.[1],
    });
    expect(knightsExt(stolen).metropolises.trade).toEqual({ seat: 1, vertex: sites[1]?.[1] });
    expect(stolen.seats[0]?.publicVp).toBe(2);
    expect(stolen.seats[1]?.publicVp).toBe(6);
    expect(engine.checkInvariants(stolen)).toEqual([]);
    // Seat 0 reaching level 5 later gets nothing back.
    const late = withLevels(
      withHand({ ...stolen, turn: { ...stolen.turn, activeSeat: 0 } }, 0, { cloth: 5 }),
      0,
      { trade: 4 },
    );
    const back = improve(late, 0, 'trade');
    expect(knightsExt(back).metropolises.trade?.seat).toBe(1);
    expect(back.seats[0]?.publicVp).toBe(2);
  });

  test('a holder buying level 5 keeps its metropolis without another city', () => {
    const { state } = position({ 0: 1 });
    const four = improve(withLevels(withHand(state, 0, { cloth: 4 }), 0, { trade: 3 }), 0, 'trade');
    const five = improve(withHand(four, 0, { cloth: 5 }), 0, 'trade');
    expect(knightsExt(five).improvements[0]?.trade).toBe(5);
    expect(knightsExt(five).metropolises.trade?.seat).toBe(0);
    expect(top(five)?.id).toBe('main');
  });

  test('taking a metropolis at level 5 needs an available city of the buyer', () => {
    const { state, sites } = position({ 0: 1, 1: 1 });
    const holder = improve(
      withLevels(withHand(state, 0, { cloth: 4 }), 0, { trade: 3 }),
      0,
      'trade',
    );
    // Seat 1's only city already carries another metropolis.
    const busy = updateKnights({ ...holder, turn: { ...holder.turn, activeSeat: 1 } }, (old) => ({
      ...old,
      metropolises: { ...old.metropolises, politics: { seat: 1, vertex: sites[1]?.[0] ?? '' } },
      improvements: old.improvements.map((levels, seat) =>
        seat === 1 ? { ...levels, politics: 4, trade: 4 } : levels,
      ),
    }));
    expect(refused(withHand(busy, 1, { cloth: 5 }), 1, 'trade')).toBe('no-available-city');
  });
});

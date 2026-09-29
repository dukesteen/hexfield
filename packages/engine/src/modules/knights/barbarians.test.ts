import { describe, expect, test } from 'vitest';
import type { GameState } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import { knightsEngine } from './testing.js';
import { setKnights } from './pieces.js';
import { knightsExt, updateKnights } from './types.js';
import {
  handOf,
  hexOf,
  inDice,
  inMain,
  newGame,
  rejection,
  ringLayout,
  roll,
  submit,
  top,
  verticesOfHex,
  withBuildings,
  withHand,
  withKnights,
  withLevels,
  withStep,
  withTokens,
} from './support.js';

const engine = knightsEngine();
const at = (list: readonly string[], index: number): string => list[index] ?? '';

/** Twelve distinct vertices for cities: the corners of one hex and their outward neighbors. */
function sites(state: GameState): string[] {
  const { ring, out } = ringLayout(state);
  return [...ring, ...out];
}

interface Board {
  cities?: Partial<Record<Seat, number>>;
  /** Active knight levels per seat, one knight each. */
  levels?: Partial<Record<Seat, number[]>>;
  seats?: number;
}

/**
 * A position at the roll of seat 0 with the ship one step away, no number tokens (so a roll pays
 * nothing), the given cities, and the given active knights.
 */
function arena(options: Board = {}): { state: GameState; spots: Record<number, string[]> } {
  const base = newGame(engine, { seats: options.seats ?? 3 });
  const all = sites(base);
  const spots: Record<number, string[]> = {};
  const pieces: { vertex: string; seat: Seat; kind: string }[] = [];
  let next = 0;
  for (const seat of [0, 1, 2] as const) {
    const count = options.cities?.[seat] ?? 0;
    spots[seat] = all.slice(next, next + count);
    for (const vertex of spots[seat] ?? []) pieces.push({ vertex, seat, kind: 'city' });
    next += count;
  }
  let state = withTokens(withBuildings(base, pieces), {});
  for (const seat of [0, 1, 2] as const)
    state = withKnights(
      state,
      (options.levels?.[seat] ?? []).map((level) => {
        const vertex = all[next++] ?? '';
        return { seat, vertex, level };
      }),
    );
  return { state: withStep(inDice(state), 6), spots };
}

const attackRoll = (state: GameState, dice: readonly [number, number] = [1, 2]) =>
  roll(engine, state, dice, 'ship');
const ext = (state: GameState) => knightsExt(state);

describe('the barbarian track', () => {
  test('a ship face moves the barbarians one step, other faces do not', () => {
    const { state } = arena({ cities: { 0: 1 } });
    const start = withStep(state, 2);
    expect(ext(roll(engine, start, [1, 2], 'ship')).barbarians.step).toBe(3);
    for (const face of ['trade', 'politics', 'science'])
      expect(ext(roll(engine, start, [1, 2], face)).barbarians.step).toBe(2);
  });

  test('seven ship faces make the attack, whatever the dice show', () => {
    let { state } = arena({ cities: { 0: 1 } });
    state = withStep(state, 0);
    for (let face = 1; face <= 6; face++) {
      state = roll(engine, inDice(state), [1, 2], 'ship');
      expect(ext(state).barbarians.step).toBe(face);
      expect(ext(state).lastAttack).toBeNull();
    }
    state = roll(engine, inDice(state), [1, 2], 'ship');
    expect(ext(state).barbarians.step).toBe(0);
    expect(ext(state).lastAttack).toMatchObject({ strength: 1, defense: 0, outcome: 'pillaged' });
    expect(engine.checkInvariants(state)).toEqual([]);
  });

  test('the ship returns, every knight is inactive and the robber is free after any attack', () => {
    const { state } = arena({ cities: { 0: 1 }, levels: { 0: [1], 1: [2] } });
    expect(ext(state).robberLocked).toBe(true);
    const after = attackRoll(state);
    expect(ext(after).barbarians.step).toBe(0);
    expect(ext(after).robberLocked).toBe(false);
    expect(ext(after).knights.every((knight) => !knight.active && !knight.ready)).toBe(true);
    expect(ext(after).knights).toHaveLength(2);
    expect(top(after)?.id).toBe('main');
  });

  test('an attack on a 7 lets the robber move on that 7, after the discards', () => {
    const { state } = arena({ cities: { 0: 1 } });
    const after = attackRoll(withHand(state, 1, { brick: 8 }), [3, 4]);
    expect(top(after)).toMatchObject({ id: 'discard', data: { remaining: [1] } });
    const discarded = submit(engine, after, 1, {
      type: 'DISCARD',
      cards: { brick: 4 },
    });
    expect(top(discarded)?.id).toBe('moveRobber');
    const quiet = attackRoll(state, [3, 4]);
    expect(top(quiet)?.id).toBe('moveRobber');
  });

  test('without an attack the robber stays locked on a 7', () => {
    const { state } = arena({ cities: { 0: 1 } });
    expect(top(roll(engine, withStep(state, 2), [3, 4], 'ship'))?.id).toBe('main');
  });
});

describe('barbarian strength and defense', () => {
  test('strength is the cities on the board; a metropolis city counts once', () => {
    const { state, spots } = arena({ cities: { 0: 2, 1: 1 } });
    const withMetropolis = withLevels(state, 0, { trade: 4 });
    const placed = updateKnights(withMetropolis, (old) => ({
      ...old,
      metropolises: { ...old.metropolises, trade: { seat: 0, vertex: at(spots[0] ?? [], 0) } },
    }));
    expect(ext(attackRoll(placed)).lastAttack?.strength).toBe(3);
  });

  test('only active knights defend, including the seats that have no city', () => {
    const { state } = arena({ cities: { 0: 1 }, levels: { 2: [3] } });
    const tired = updateKnights(state, (old) => ({
      ...old,
      knights: old.knights.map((knight) => ({ ...knight, active: false, ready: false })),
    }));
    expect(ext(attackRoll(tired)).lastAttack).toMatchObject({ defense: 0, outcome: 'pillaged' });
    const after = attackRoll(state);
    expect(ext(after).lastAttack).toMatchObject({
      defense: 3,
      contributions: [0, 0, 3],
      outcome: 'defended',
      defender: 2,
    });
  });

  test('a defense equal to the strength holds', () => {
    const { state } = arena({ cities: { 0: 2, 1: 1 }, levels: { 0: [1, 2] } });
    const after = attackRoll(state);
    expect(ext(after).lastAttack).toMatchObject({ strength: 3, defense: 3, outcome: 'defended' });
    expect(after.board.buildings.filter((piece) => piece.kind === 'city')).toHaveLength(3);
  });
});

describe('when the defenders win', () => {
  test('the strictly best defender takes a Defender of Catan card worth a point', () => {
    const { state } = arena({ cities: { 0: 1, 1: 1 }, levels: { 0: [1], 1: [2] } });
    const after = attackRoll(state);
    expect(ext(after).defenders).toEqual([0, 1, 0]);
    expect(ext(after).lastAttack).toMatchObject({ defender: 1, tied: [] });
    // A city is two points; the card is a third for seat 1.
    expect(after.seats.map((seat) => seat.publicVp)).toEqual([2, 3, 0]);
    expect(engine.computeVictoryPoints(after, 1).public).toBe(3);
    // Cards are never scarce: a second win adds a second card.
    const rested = setKnights(after, (list) =>
      list.map((knight) => ({ ...knight, active: true, ready: true })),
    );
    const again = attackRoll(withStep(inDice(rested), 6));
    expect(ext(again).defenders).toEqual([0, 2, 0]);
  });

  test('a tie at the top gives nobody a card and is recorded for the progress draws', () => {
    const { state } = arena({
      cities: { 0: 1, 1: 1, 2: 1 },
      levels: { 0: [2], 1: [2], 2: [1] },
    });
    const after = attackRoll(state);
    expect(ext(after).defenders).toEqual([0, 0, 0]);
    expect(ext(after).lastAttack).toMatchObject({
      outcome: 'defended',
      defender: null,
      tied: [0, 1],
    });
    // The tied seats are listed in turn order from the active seat.
    const second = attackRoll({ ...state, turn: { ...state.turn, activeSeat: 1 } });
    expect(ext(second).lastAttack?.tied).toEqual([1, 0]);
  });

  test('no active knights at all: nobody is a defender and nothing is awarded', () => {
    const { state } = arena({ cities: {} });
    const after = attackRoll(state);
    expect(ext(after).lastAttack).toMatchObject({
      strength: 0,
      defense: 0,
      outcome: 'defended',
      defender: null,
      tied: [],
    });
    expect(ext(after).defenders).toEqual([0, 0, 0]);
  });
});

describe('when the barbarians win', () => {
  test('the seat with the lowest contribution loses a city, the others keep theirs', () => {
    const { state, spots } = arena({ cities: { 0: 1, 1: 1, 2: 1 }, levels: { 0: [1], 1: [1] } });
    const after = attackRoll(state);
    const kinds = new Map(after.board.buildings.map((piece) => [piece.vertex, piece.kind]));
    expect(kinds.get(at(spots[0] ?? [], 0))).toBe('city');
    expect(kinds.get(at(spots[1] ?? [], 0))).toBe('city');
    expect(kinds.get(at(spots[2] ?? [], 0))).toBe('settlement');
    expect(ext(after).lastAttack?.pillaged).toEqual([
      { seat: 2, vertex: at(spots[2] ?? [], 0), sideways: false },
    ]);
    const seat = after.seats.find((item) => item.seat === 2);
    expect(seat?.piecesLeft).toMatchObject({ city: 4, settlement: 4 });
    expect(engine.checkInvariants(after)).toEqual([]);
  });

  test('every seat tied for the lowest contribution loses a city', () => {
    const { state, spots } = arena({ cities: { 0: 1, 1: 1, 2: 1 }, levels: { 2: [1] } });
    const after = attackRoll(state);
    const kinds = new Map(after.board.buildings.map((piece) => [piece.vertex, piece.kind]));
    expect(kinds.get(at(spots[0] ?? [], 0))).toBe('settlement');
    expect(kinds.get(at(spots[1] ?? [], 0))).toBe('settlement');
    expect(kinds.get(at(spots[2] ?? [], 0))).toBe('city');
  });

  test('a seat with only a metropolis is immune, so the next lowest seat loses a city', () => {
    const { state, spots } = arena({ cities: { 0: 1, 1: 1, 2: 1 }, levels: { 1: [1] } });
    const protectedSeat = updateKnights(withLevels(state, 0, { trade: 4 }), (old) => ({
      ...old,
      metropolises: { ...old.metropolises, trade: { seat: 0, vertex: at(spots[0] ?? [], 0) } },
    }));
    const after = attackRoll(protectedSeat);
    const kinds = new Map(after.board.buildings.map((piece) => [piece.vertex, piece.kind]));
    // Seats 0 and 2 both contribute 0 but seat 0 has no city that can be lost.
    expect(kinds.get(at(spots[0] ?? [], 0))).toBe('city');
    expect(kinds.get(at(spots[1] ?? [], 0))).toBe('city');
    expect(kinds.get(at(spots[2] ?? [], 0))).toBe('settlement');
    expect(ext(after).lastAttack?.pillaged.map((item) => item.seat)).toEqual([2]);
  });

  test('when every city carries a metropolis nothing is lost', () => {
    const { state, spots } = arena({ cities: { 0: 1, 1: 1 } });
    const metropolises = updateKnights(
      withLevels(withLevels(state, 0, { trade: 4 }), 1, { politics: 4 }),
      (old) => ({
        ...old,
        metropolises: {
          ...old.metropolises,
          trade: { seat: 0, vertex: at(spots[0] ?? [], 0) },
          politics: { seat: 1, vertex: at(spots[1] ?? [], 0) },
        },
      }),
    );
    const after = attackRoll(metropolises);
    expect(after.board.buildings.every((piece) => piece.kind === 'city')).toBe(true);
    expect(ext(after).lastAttack).toMatchObject({ outcome: 'pillaged', pillaged: [] });
  });

  test('a seat with several cities chooses which one, and the roll waits for the choice', () => {
    const { state, spots } = arena({ cities: { 0: 2 } });
    const after = attackRoll(state);
    expect(top(after)).toMatchObject({ module: 'knights', id: 'pillage' });
    expect(engine.getPending(after)).toEqual([
      { kind: 'player', seat: 0, allowed: ['CHOOSE_PILLAGE', 'CLAIM_VICTORY'] },
    ]);
    const options = engine
      .getLegalCommands(after, 0)
      .commands.filter((item) => item.type === 'CHOOSE_PILLAGE')
      .map((item) => item.vertex);
    expect(options).toEqual([...(spots[0] ?? [])].toSorted());
    expect(
      rejection(engine, after, 0, { type: 'CHOOSE_PILLAGE', vertex: at(sites(state), 9) }),
    ).toBe('illegal-pillage');
    expect(
      rejection(engine, after, 1, { type: 'CHOOSE_PILLAGE', vertex: at(spots[0] ?? [], 0) }),
    ).toBe('not-pending');
    const chosen = submit(engine, after, 0, {
      type: 'CHOOSE_PILLAGE',
      vertex: at(spots[0] ?? [], 1),
    });
    expect(top(chosen)?.id).toBe('main');
    const kinds = new Map(chosen.board.buildings.map((piece) => [piece.vertex, piece.kind]));
    expect(kinds.get(at(spots[0] ?? [], 1))).toBe('settlement');
    expect(kinds.get(at(spots[0] ?? [], 0))).toBe('city');
    expect(engine.checkInvariants(chosen)).toEqual([]);
  });

  test('several seats choose at once, and the roll resolves after the last choice', () => {
    const { state, spots } = arena({ cities: { 0: 2, 1: 2 } });
    const after = attackRoll(state);
    expect(engine.getPending(after)).toHaveLength(2);
    const first = submit(engine, after, 1, {
      type: 'CHOOSE_PILLAGE',
      vertex: at(spots[1] ?? [], 0),
    });
    expect(top(first)?.id).toBe('pillage');
    const second = submit(engine, first, 0, {
      type: 'CHOOSE_PILLAGE',
      vertex: at(spots[0] ?? [], 0),
    });
    expect(top(second)?.id).toBe('main');
    expect(ext(second).lastAttack?.pillaged.map((item) => item.seat)).toEqual([1, 0]);
  });

  test('a timeout chooses the lowest city id', () => {
    const { state, spots } = arena({ cities: { 0: 2 } });
    const after = attackRoll(state);
    const result = engine.apply(after, {
      kind: 'system',
      type: 'TIMEOUT',
      seat: 0,
      phase: 'pillage',
    });
    if (!result.ok) throw new Error(result.error.message);
    const lowest = [...(spots[0] ?? [])].toSorted()[0];
    expect(result.value.state.board.buildings.find((piece) => piece.vertex === lowest)?.kind).toBe(
      'settlement',
    );
    expect(top(result.value.state)?.id).toBe('main');
  });

  test('a wall goes with its pillaged city, and the hand limit drops', () => {
    const { state, spots } = arena({ cities: { 0: 1 } });
    const walled = updateKnights(withHand(state, 0, { brick: 9 }), (old) => ({
      ...old,
      walls: [{ seat: 0, vertex: at(spots[0] ?? [], 0) }],
    }));
    expect(engine.hooks.handLimit(walled, 0, 7)).toBe(9);
    const after = attackRoll(walled);
    expect(ext(after).walls).toEqual([]);
    expect(engine.hooks.handLimit(after, 0, 7)).toBe(7);
    expect(engine.checkInvariants(after)).toEqual([]);
  });

  test('points drop with the city, and the piece counts as a settlement', () => {
    const { state } = arena({ cities: { 0: 1 } });
    const after = attackRoll(state);
    expect(after.seats.find((seat) => seat.seat === 0)?.publicVp).toBe(1);
  });
});

/** Seat 0 has a city on a brick hex that pays on 6, and a second city elsewhere. */
function producing(second: boolean) {
  const base = newGame(engine, { seats: 3 });
  const hills = hexOf(base, 'hills');
  const brick = verticesOfHex(base, hills)[0] ?? '';
  const other = verticesOfHex(base, hexOf(base, 'fields')).find(
    (vertex) => !verticesOfHex(base, hills).includes(vertex),
  );
  const cities = [
    { vertex: brick, seat: 0 as const, kind: 'city' },
    ...(second && other ? [{ vertex: other, seat: 0 as const, kind: 'city' }] : []),
  ];
  const state = withStep(inDice(withTokens(withBuildings(base, cities), { [hills]: 6 })), 6);
  return { state, brick, other: other ?? '' };
}

describe('the attack comes before production', () => {
  test('a pillaged city pays as a settlement on the same roll', () => {
    const { state } = producing(false);
    expect(handOf(state, 0).brick).toBe(0);
    const plain = roll(engine, withStep(state, 0), [3, 3], 'trade');
    expect(handOf(plain, 0).brick).toBe(2);
    const attacked = roll(engine, state, [3, 3], 'ship');
    expect(handOf(attacked, 0).brick).toBe(1);
  });

  test('with a choice to make, production waits and follows the choice', () => {
    const { state, brick, other } = producing(true);
    const held = roll(engine, state, [3, 3], 'ship');
    expect(top(held)?.id).toBe('pillage');
    expect(handOf(held, 0).brick).toBe(0);
    const kept = submit(engine, held, 0, { type: 'CHOOSE_PILLAGE', vertex: other });
    expect(handOf(kept, 0).brick).toBe(2);
    expect(top(kept)?.id).toBe('main');
    const lost = submit(engine, held, 0, { type: 'CHOOSE_PILLAGE', vertex: brick });
    expect(handOf(lost, 0).brick).toBe(1);
  });

  test('a held-back 7 goes on to the discards and robber step after the choice', () => {
    const { state, spots } = arena({ cities: { 0: 2 } });
    const held = attackRoll(withHand(state, 1, { brick: 8 }), [3, 4]);
    expect(top(held)?.id).toBe('pillage');
    const chosen = submit(engine, held, 0, {
      type: 'CHOOSE_PILLAGE',
      vertex: at(spots[0] ?? [], 0),
    });
    expect(top(chosen)).toMatchObject({ id: 'discard', data: { remaining: [1] } });
  });
});

/** Seat 0 has five settlements and all four cities on the board. */
function stretched() {
  const base = newGame(engine, { seats: 3 });
  const all = sites(base);
  const pieces = all.slice(0, 9).map((vertex, index) => ({
    vertex,
    seat: 0 as const,
    kind: index < 5 ? 'settlement' : 'city',
  }));
  const state = withStep(inDice(withTokens(withBuildings(base, pieces), {}), 1), 6);
  return { state, cities: all.slice(5, 9), settlements: all.slice(0, 5) };
}

describe('a city piece with no settlement to replace it', () => {
  test('the piece lies on its side and counts as a settlement', () => {
    const { state, cities } = stretched();
    const held = attackRoll(state);
    const lost = submit(engine, held, 0, { type: 'CHOOSE_PILLAGE', vertex: at(cities, 0) });
    expect(ext(lost).sideways).toEqual([{ seat: 0, vertex: at(cities, 0) }]);
    const piece = lost.board.buildings.find((item) => item.vertex === at(cities, 0));
    expect(piece?.kind).toBe('settlement');
    const seat = lost.seats.find((item) => item.seat === 0);
    expect(seat?.piecesLeft).toMatchObject({ settlement: 0, city: 0, sideways: 1 });
    expect(ext(lost).lastAttack?.pillaged).toEqual([
      { seat: 0, vertex: at(cities, 0), sideways: true },
    ]);
    // 5 settlements + the sideways piece + 3 cities: 5 + 1 + 6 points.
    expect(seat?.publicVp).toBe(12);
    expect(engine.checkInvariants(lost)).toEqual([]);
  });

  test('it is not a city for the next attack and cannot be pillaged again', () => {
    const { state, cities } = stretched();
    const lost = submit(engine, attackRoll(state), 0, {
      type: 'CHOOSE_PILLAGE',
      vertex: at(cities, 0),
    });
    const next = attackRoll(withStep(inDice(lost, 1), 6));
    expect(ext(next).lastAttack?.strength).toBe(3);
    const choices = engine
      .getLegalCommands(next, 0)
      .commands.filter((item) => item.type === 'CHOOSE_PILLAGE')
      .map((item) => item.vertex);
    expect(choices).toEqual(cities.slice(1).toSorted());
  });

  test('it must be upgraded before any other settlement, with no city piece needed', () => {
    const { state, cities, settlements } = stretched();
    const lost = submit(engine, attackRoll(state), 0, {
      type: 'CHOOSE_PILLAGE',
      vertex: at(cities, 0),
    });
    const rich = inMain(withHand(lost, 0, { grain: 4, ore: 6 }));
    expect(rejection(engine, rich, 0, { type: 'BUILD_CITY', vertex: at(settlements, 0) })).toBe(
      'illegal-city',
    );
    expect(
      engine.getLegalCommands(rich, 0).commands.filter((item) => item.type === 'BUILD_CITY'),
    ).toEqual([]);
    const upgraded = submit(engine, rich, 0, {
      type: 'UPGRADE_SIDEWAYS_CITY',
      vertex: at(cities, 0),
    });
    expect(ext(upgraded).sideways).toEqual([]);
    expect(upgraded.board.buildings.find((item) => item.vertex === at(cities, 0))?.kind).toBe(
      'city',
    );
    expect(handOf(upgraded, 0)).toMatchObject({ grain: 2, ore: 3 });
    const seat = upgraded.seats.find((item) => item.seat === 0);
    expect(seat?.piecesLeft).toMatchObject({ settlement: 0, city: 0, sideways: 0 });
    // Five settlements and four cities are 13 points: the upgrade wins the game for the active seat.
    expect(seat?.publicVp).toBe(13);
    expect(upgraded.result).toMatchObject({ winner: 0, reason: 'public-vp' });
    expect(engine.checkInvariants(upgraded)).toEqual([]);
  });

  test('several sideways pieces may be upgraded in any order', () => {
    const { state, cities } = stretched();
    const held = attackRoll(withStep(inDice(state, 1), 6));
    const first = submit(engine, held, 0, { type: 'CHOOSE_PILLAGE', vertex: at(cities, 1) });
    const second = attackRoll(withStep(inDice(first, 1), 6));
    const both = submit(engine, second, 0, { type: 'CHOOSE_PILLAGE', vertex: at(cities, 0) });
    expect(ext(both).sideways).toHaveLength(2);
    const rich = inMain(withHand(both, 0, { grain: 4, ore: 6 }));
    const later = submit(engine, rich, 0, { type: 'UPGRADE_SIDEWAYS_CITY', vertex: at(cities, 1) });
    expect(ext(later).sideways).toEqual([{ seat: 0, vertex: at(cities, 0) }]);
  });

  test('the upgrade is allowed in a special build phase', () => {
    const fiveSix = knightsEngine(true);
    const base = newGame(fiveSix, { fiveSix: true });
    const all = sites(base);
    const pieces = all.slice(0, 9).map((vertex, index) => ({
      vertex,
      seat: 1 as const,
      kind: index < 5 ? 'settlement' : 'city',
    }));
    const flat = withHand(
      updateKnights(withBuildings(inMain(base), pieces), (old) => ({
        ...old,
        sideways: [{ seat: 1 as const, vertex: at(all, 5) }],
      })),
      1,
      { grain: 2, ore: 3 },
    );
    const lying = {
      ...flat,
      board: {
        ...flat.board,
        buildings: flat.board.buildings.map((piece) =>
          piece.vertex === at(all, 5) ? { ...piece, kind: 'settlement' } : piece,
        ),
      },
      seats: flat.seats.map((seat) =>
        seat.seat === 1 ? { ...seat, piecesLeft: { ...seat.piecesLeft, sideways: 1 } } : seat,
      ),
    };
    const sbp = submit(fiveSix, lying, 0, { type: 'END_TURN' });
    expect(top(sbp)?.id).toBe('sbp');
    expect(
      fiveSix
        .getLegalCommands(sbp, 1)
        .commands.some((item) => item.type === 'UPGRADE_SIDEWAYS_CITY'),
    ).toBe(true);
  });
});

describe('five and six players', () => {
  test('the attack and pillage work at five seats', () => {
    const fiveSix = knightsEngine(true);
    const base = newGame(fiveSix, { fiveSix: true });
    const all = sites(base);
    const seats: readonly Seat[] = [0, 1, 2, 3, 4];
    const pieces = seats.map((seat, index) => ({
      vertex: at(all, index),
      seat,
      kind: 'city',
    }));
    let state = withTokens(withBuildings(base, pieces), {});
    state = withKnights(state, [
      { seat: 3, vertex: at(all, 7), level: 2 },
      { seat: 4, vertex: at(all, 8), level: 3 },
    ]);
    state = withStep(inDice(state), 6);
    const after = roll(fiveSix, state, [1, 2], 'ship');
    // Strength 5, defense 5: the defenders hold and seat 4 takes the card.
    expect(ext(after).lastAttack).toMatchObject({ strength: 5, defense: 5, defender: 4 });
    const weaker = roll(
      fiveSix,
      withStep(
        inDice(
          updateKnights(state, (old) => ({
            ...old,
            knights: old.knights.filter((knight) => knight.seat === 3),
          })),
        ),
        6,
      ),
      [1, 2],
      'ship',
    );
    expect(ext(weaker).lastAttack).toMatchObject({ outcome: 'pillaged' });
    // Seats 0, 1, 2 and 4 tie at 0: each loses its only city.
    expect(ext(weaker).lastAttack?.pillaged.map((item) => item.seat)).toEqual([0, 1, 2, 4]);
    expect(fiveSix.checkInvariants(weaker)).toEqual([]);
  });
});

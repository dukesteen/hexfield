import { describe, expect, test } from 'vitest';
import { createBaseEngine, exactResourceBounds, loseHidden } from '@cp2p/engine';
import type { GameState, Resource, Seat } from '@cp2p/engine';
import { boardInfo, pips, productionRates, tradeRates, vertexPips } from './board.js';
import { chooseDiscard } from './discard.js';
import { expectedHand, handBelief, sampleHand } from './inference.js';
import { CITY, SETTLEMENT, affordableWithTrades, planGoals, turnsToAfford } from './plan.js';
import { robberHexScore, stealScore } from './robber.js';
import { openSites, roadDistances } from './sites.js';
import { acceptsTrade, handScore, resourceValues, tradeGain } from './trade.js';
import type { HandContext } from './trade.js';
import { vertexScore } from './vertex.js';
import { createRng } from '@cp2p/engine/rng';

const engine = createBaseEngine();
type Hand = Record<Resource, number>;
const hand = (cards: Partial<Hand>): Hand => ({
  brick: 0,
  lumber: 0,
  wool: 0,
  grain: 0,
  ore: 0,
  ...cards,
});

function baseGame(seats: Seat[] = [0, 1, 2, 3]): GameState {
  return engine.createGame(
    {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats,
      options: { base: { mapLayout: 'random' } },
    },
    new Uint8Array(32).fill(9),
  );
}

/**
 * A known board: every land hex is a 2 or 12 pasture except the three around one vertex, which are
 * a 6 hills, an 8 forest and a 5 fields. That vertex is obviously the best opening.
 */
function knownBoard(): { state: GameState; best: string } {
  const state = baseGame();
  const info = boardInfo(state);
  const land = new Set(
    state.board.hexes.filter((hex) => hex.terrain !== 'sea').map((hex) => hex.id),
  );
  const best = info.graph.vertexIds.find(
    (_, index) =>
      (info.graph.vertexHexes[index] ?? []).every((hex) => land.has(hex)) &&
      (info.graph.vertexHexes[index] ?? []).length === 3,
  );
  if (!best) throw new Error('No inland vertex');
  const around = info.graph.vertexHexes[info.graph.vertexIndex[best] ?? -1] ?? [];
  const special: Record<string, { terrain: string; token: number }> = {
    [around[0] ?? '']: { terrain: 'hills', token: 6 },
    [around[1] ?? '']: { terrain: 'forest', token: 8 },
    [around[2] ?? '']: { terrain: 'fields', token: 5 },
  };
  let flip = 0;
  const hexes = state.board.hexes.map((hex) => {
    if (!land.has(hex.id)) return hex;
    const chosen = special[hex.id];
    if (chosen) return { ...hex, ...chosen };
    flip++;
    return { ...hex, terrain: 'pasture', token: flip % 2 ? 2 : 12 };
  });
  return { state: { ...state, board: { ...state.board, hexes, robberHex: null } }, best };
}

function withBuildings(state: GameState, buildings: GameState['board']['buildings']): GameState {
  return { ...state, board: { ...state.board, buildings } };
}

function withHands(state: GameState, hands: Partial<Record<Seat, Hand>>): GameState {
  return {
    ...state,
    seats: state.seats.map((holder) => {
      const bounds = exactResourceBounds(hands[holder.seat] ?? hand({}));
      if (!bounds.ok) throw new Error(bounds.error.message);
      return { ...holder, resources: bounds.value };
    }),
  };
}

const context = (cost = CITY): HandContext => ({
  cost,
  income: { brick: 0.3, lumber: 0.3, wool: 0.3, grain: 0.3, ore: 0.3 },
  rates: { brick: 4, lumber: 4, wool: 4, grain: 4, ore: 4 },
});

describe('pip values', () => {
  test('weights numbers by the ways two dice make them', () => {
    expect([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(pips)).toEqual([
      1, 2, 3, 4, 5, 0, 5, 4, 3, 2, 1,
    ]);
    expect(pips(null)).toBe(0);
  });
});

describe('vertex score on a known board', () => {
  test('the obviously best setup vertex scores highest', () => {
    const { state, best } = knownBoard();
    const info = boardInfo(state);
    const open = openSites(state, info);
    const ranked = [...open].toSorted(
      (a, b) => vertexScore(state, 0, b, {}, info, open) - vertexScore(state, 0, a, {}, info, open),
    );
    expect(ranked[0]).toBe(best);
    expect(vertexPips(info, best)).toMatchObject({ brick: 5, lumber: 5, grain: 4 });
  });

  test('a second settlement is steered toward resources the first lacks', () => {
    const { state, best } = knownBoard();
    const placed = withBuildings(state, [{ vertex: best, seat: 0, kind: 'settlement' }]);
    const info = boardInfo(placed);
    expect(productionRates(placed, 0, info).brick).toBeCloseTo(5 / 36);
    // A pasture 2 vertex is worth more to a seat without wool than to one that has it.
    const open = openSites(placed, info);
    const pasture = [...open].find(
      (vertex) => vertexPips(info, vertex).wool > 0 && vertexPips(info, vertex).brick === 0,
    );
    if (!pasture) throw new Error('No pasture site');
    const fresh = vertexScore(placed, 0, pasture, {}, info, open);
    const other = vertexScore(placed, 1, pasture, { diversity: 0 }, info, open);
    expect(fresh).toBeGreaterThan(other);
  });

  test('a harbor is only worth its maritime rate once a seat builds there', () => {
    const state = baseGame();
    const harbor = state.board.harbors.find((item) => item.kind === 'generic');
    if (!harbor) throw new Error('No generic harbor');
    const info = boardInfo(state);
    const vertex = info.graph.edgeVertices[info.graph.edgeIndex[harbor.edge] ?? -1]?.[0];
    if (!vertex) throw new Error('No harbor vertex');
    expect(tradeRates(state, 0).brick).toBe(4);
    expect(
      tradeRates(withBuildings(state, [{ vertex, seat: 0, kind: 'settlement' }]), 0).brick,
    ).toBe(3);
  });
});

describe('roads and sites', () => {
  test('counts the roads needed to reach a site and stops at other seats', () => {
    const { state, best } = knownBoard();
    const placed = withBuildings(state, [{ vertex: best, seat: 0, kind: 'settlement' }]);
    const distances = roadDistances(placed, 0, 3);
    expect(distances.get(best)).toBe(0);
    const info = boardInfo(placed);
    const neighbour = info.graph.vertexNeighbors[info.graph.vertexIndex[best] ?? -1]?.[0];
    if (!neighbour) throw new Error('No neighbour');
    expect(distances.get(neighbour)).toBe(1);
    expect(openSites(placed).has(neighbour)).toBe(false);
  });
});

describe('opponent hand inference', () => {
  test('an exactly known hand is inferred exactly', () => {
    const state = withHands(baseGame(), { 1: hand({ ore: 3, wool: 1 }) });
    expect(expectedHand(handBelief(state, 1))).toMatchObject({ ore: 3, wool: 1, brick: 0 });
  });

  test('hidden losses widen the bounds, and samples stay inside them', () => {
    const known = withHands(baseGame(), { 1: hand({ ore: 3, brick: 2 }) });
    const holder = known.seats[1];
    if (!holder) throw new Error('No seat');
    const lost = loseHidden(holder.resources, 1);
    if (!lost.ok) throw new Error(lost.error.message);
    const state = {
      ...known,
      seats: known.seats.map((item) =>
        item.seat === 1 ? { ...item, resources: lost.value } : item,
      ),
    };
    const expected = expectedHand(handBelief(state, 1));
    expect((expected.ore ?? 0) + (expected.brick ?? 0)).toBeCloseTo(4);
    expect(expected.ore).toBeGreaterThan(2);
    expect(expected.wool).toBe(0);
    const rng = createRng(new Uint8Array(32).fill(1));
    for (let n = 0; n < 50; n++) {
      const sample = sampleHand(handBelief(state, 1), rng);
      expect((sample.ore ?? 0) + (sample.brick ?? 0)).toBe(4);
      expect(sample.ore).toBeGreaterThanOrEqual(2);
      expect(sample.brick).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('plan evaluation', () => {
  test('turns-to-afford is zero when payable and counts surplus trades', () => {
    const income = { brick: 0, lumber: 0, wool: 0, grain: 0.5, ore: 0.5 };
    const rates = { brick: 4, lumber: 4, wool: 4, grain: 4, ore: 4 };
    expect(turnsToAfford(hand({ grain: 2, ore: 3 }), CITY, income, rates)).toBe(0);
    expect(turnsToAfford(hand({ grain: 2, ore: 2 }), CITY, income, rates)).toBe(2);
    expect(affordableWithTrades(hand({ grain: 2, ore: 2, wool: 4 }), CITY, rates)).toBe(true);
    expect(turnsToAfford(hand({}), SETTLEMENT, income, rates, 10)).toBe(10);
  });

  test('prefers a city when the hand is one card away from it', () => {
    const { state, best } = knownBoard();
    const placed = withBuildings(state, [{ vertex: best, seat: 0, kind: 'settlement' }]);
    const goals = planGoals(placed, 0, hand({ grain: 2, ore: 2 }));
    expect(goals[0]?.kind).toBe('city');
    expect(goals[0]?.vertex).toBe(best);
  });
});

describe('trade evaluation', () => {
  test('values the card the goal lacks and refuses to give it away', () => {
    const cards = hand({ grain: 2, ore: 2, wool: 3 });
    const values = resourceValues(cards, context());
    expect(values.ore).toBeGreaterThan(values.wool);
    expect(tradeGain(cards, { ore: 1 }, { wool: 1 }, context())).toBeGreaterThan(0);
    expect(tradeGain(cards, { wool: 1 }, { ore: 1 }, context())).toBeLessThan(0);
    expect(tradeGain(cards, { ore: 1 }, { brick: 1 }, context())).toBeNull();
  });

  test('asks much more of a partner close to winning', () => {
    const state = baseGame();
    const leader = {
      ...state,
      seats: state.seats.map((item) => (item.seat === 1 ? { ...item, publicVp: 9 } : item)),
    };
    const cards = hand({ grain: 1, ore: 1, wool: 3 });
    expect(acceptsTrade(state, cards, { ore: 1 }, { wool: 1 }, 1, 10, context())).toBe(true);
    expect(acceptsTrade(leader, cards, { ore: 1 }, { wool: 1 }, 1, 10, context())).toBe(false);
  });

  test('a hand over seven cards is worth less', () => {
    expect(handScore(hand({ wool: 8 }), context())).toBeLessThan(
      handScore(hand({ wool: 7 }), context()) + 0.04,
    );
  });
});

describe('robber targeting', () => {
  test('blocks the leader and never its own production', () => {
    const { state, best } = knownBoard();
    const info = boardInfo(state);
    const around = info.graph.vertexHexes[info.graph.vertexIndex[best] ?? -1] ?? [];
    const target = around[0] ?? '';
    const withLeader = withHands(
      {
        ...withBuildings(state, [{ vertex: best, seat: 1, kind: 'city' }]),
        seats: state.seats.map((item) => (item.seat === 1 ? { ...item, publicVp: 6 } : item)),
      },
      { 1: hand({ wool: 3 }) },
    );
    const own = withBuildings(state, [{ vertex: best, seat: 0, kind: 'city' }]);
    expect(robberHexScore(withLeader, 0, target, 10)).toBeGreaterThan(10);
    expect(robberHexScore(own, 0, target, 10)).toBeLessThan(0);
    expect(stealScore(withLeader, 0, 1, 10)).toBeGreaterThan(stealScore(withLeader, 0, 2, 10));
  });
});

describe('discard', () => {
  test('keeps the cards closest to the goal', () => {
    const dropped = chooseDiscard(hand({ grain: 2, ore: 3, wool: 3, brick: 1 }), 4, context());
    expect(Object.values(dropped).reduce((sum, count) => sum + count, 0)).toBe(4);
    expect(dropped.ore).toBe(0);
    expect(dropped.grain).toBe(0);
    expect(dropped.wool).toBe(3);
  });
});

import { fromBase64Url } from '@cp2p/codec';
import { engineForConfig } from '@cp2p/engine';
import type { GameState } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import { expect, test } from 'vitest';
import { DICE_PROBABILITY, ReplayAnalyser } from './replay-analysis.js';
import { goldenTranscript } from './replay-golden.test-helper.js';

function initial(): GameState {
  const { config, genesisSeed } = goldenTranscript('normal-game-01.replay.json');
  return engineForConfig(config).createGame(config, fromBase64Url(genesisSeed));
}

test('the expected dice distribution sums to one', () => {
  expect(DICE_PROBABILITY.reduce((sum, p) => sum + p, 0)).toBeCloseTo(1, 12);
  expect(DICE_PROBABILITY[5]).toBeCloseTo(6 / 36, 12);
});

test('counts gains, trades, steals, robber blocks, dice and markers', () => {
  const start = initial();
  const analyser = new ReplayAnalyser(start);
  const hex = start.board.hexes.find((item) => item.token === 6);
  if (!hex) throw new Error('Board has no 6');
  const graph = buildBoardGraph(start.board.hexes);
  const corners = graph.hexVertices[graph.hexIndex[hex.id] ?? -1] ?? [];
  const [first, second] = corners;
  if (!first || !second) throw new Error('Hex has no corners');
  const robbed: GameState = {
    ...start,
    board: {
      ...start.board,
      robberHex: hex.id,
      buildings: [
        { vertex: first, seat: 0, kind: 'settlement' },
        { vertex: second, seat: 1, kind: 'city' },
      ],
    },
  };
  // A 6 under the robber: the settlement loses one card, the city two.
  analyser.step(
    robbed,
    { state: robbed, events: [{ type: 'diceRolled', roll: 6 }], effects: [] },
    1,
  );
  // Production from the bank counts as gained; a player trade and a steal do not.
  analyser.step(
    robbed,
    {
      state: robbed,
      events: [{ type: 'resourcesProduced', bySeat: { 2: { grain: 3 } } }],
      effects: [
        {
          type: 'resource-transfer',
          from: { kind: 'bank' },
          to: { kind: 'seat', seat: 2 },
          resource: 'grain',
          count: 3,
        },
      ],
    },
    2,
  );
  analyser.step(
    robbed,
    {
      state: robbed,
      events: [{ type: 'tradeConfirmed', offerId: 1, withSeat: 1 }],
      effects: [
        {
          type: 'resource-transfer',
          from: { kind: 'seat', seat: 0 },
          to: { kind: 'seat', seat: 1 },
          resource: 'wool',
          count: 1,
        },
        {
          type: 'resource-transfer',
          from: { kind: 'seat', seat: 1 },
          to: { kind: 'seat', seat: 0 },
          resource: 'ore',
          count: 2,
        },
      ],
    },
    3,
  );
  analyser.step(
    robbed,
    {
      state: robbed,
      events: [{ type: 'resourceStolen', thief: 3, victim: 2, known: false }],
      effects: [{ type: 'hidden-resource-transfer', from: 2, to: 3, count: 1 }],
    },
    4,
  );
  const awarded: GameState = {
    ...robbed,
    awards: { ...robbed.awards, longestRoad: 1 },
    seats: robbed.seats.map((seat) =>
      seat.seat === 1 ? { ...seat, publicVp: seat.publicVp + 2 } : seat,
    ),
    turn: { ...robbed.turn, number: robbed.turn.number + 1 },
  };
  analyser.step(
    robbed,
    { state: awarded, events: [{ type: 'diceRolled', roll: 7 }], effects: [] },
    5,
  );
  const { timeline, stats } = analyser.finish(awarded);

  expect(stats.robberBlocked).toEqual([1, 2, 0, 0]);
  expect(stats.dice[6 - 2]).toBe(1);
  expect(stats.dice[7 - 2]).toBe(1);
  expect(stats.dice.reduce((sum, count) => sum + count, 0)).toBe(2);
  expect(stats.gains.at(-1)?.totals).toEqual([0, 0, 3, 0]);
  expect(stats.trades[0]).toMatchObject({ playerTrades: 1, given: 1, received: 2 });
  expect(stats.trades[1]).toMatchObject({ playerTrades: 1, given: 2, received: 1 });
  expect(stats.trades[2]).toMatchObject({ playerTrades: 0, stolenFrom: 1 });
  expect(stats.trades[3]).toMatchObject({ steals: 1 });
  expect(timeline.sevens).toEqual([5]);
  expect(timeline.turnAt).toHaveLength(6);
  expect(timeline.turnStarts.at(-1)).toEqual({ turn: robbed.turn.number + 1, position: 5 });
  expect(timeline.markers).toEqual([
    { position: 5, kind: 'award', seat: 1, detail: 'longestRoad' },
    { position: 5, kind: 'swing', seat: null, detail: '2' },
  ]);
});

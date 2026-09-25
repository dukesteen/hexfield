import { expect, test } from 'vitest';
import type { GameEvent } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import { standardFixedBoard } from '@cp2p/maps';
import { LocalSession } from '../../session/local-session.js';
import { diceHistogram, productionBySeat, victoryBreakdown } from './stats';

test('game-over dice and production statistics reflect only recorded events', () => {
  const events: GameEvent[] = [
    { type: 'diceRolled', roll: 8, dice: [3, 5] },
    { type: 'resourcesProduced', bySeat: { '0': { brick: 2, grain: 1 }, '1': { ore: 1 } } },
    { type: 'diceRolled', roll: 8, dice: [2, 6] },
    { type: 'diceRolled', roll: 5, dice: [2, 3] },
    { type: 'maritimeTrade', seat: 0 },
  ];
  expect(diceHistogram(events).find((entry) => entry.roll === 8)?.count).toBe(2);
  expect(diceHistogram(events).find((entry) => entry.roll === 5)?.count).toBe(1);
  expect(productionBySeat(events, 0)).toBe(3);
  expect(productionBySeat(events, 1)).toBe(1);
  expect(productionBySeat(events, 2)).toBe(0);
});

test('a real dice payment remains in production statistics after save replay', async () => {
  const made = LocalSession.create({
    config: {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1, 2],
      options: { base: { mapLayout: 'standard-fixed' } },
      board: standardFixedBoard(),
    },
    humanSeats: [0, 1, 2],
    botSeats: [],
    genesisSeed: new Uint8Array(32).fill(9),
    entropy: { randomBytes: (target) => target.fill(0) },
  });
  if (!made.ok) throw new Error(made.error.message);
  const session = made.value;
  try {
    for (let step = 0; step < 12; step++) {
      const pending = session.getPending().find((item) => item.kind === 'player');
      if (pending?.kind !== 'player') throw new Error('Setup choice missing');
      const command = session.getLegalCommands(pending.seat).commands[0];
      if (!command) throw new Error('Legal setup command missing');
      // eslint-disable-next-line no-await-in-loop -- Every placement changes the next legal choice.
      const result = await session.submit(pending.seat, command);
      if (!result.ok) throw new Error(result.error.message);
    }
    const state = session.getState();
    const graph = buildBoardGraph(state.board.hexes);
    const producing = state.board.buildings.flatMap((building) => {
      const index = graph.vertexIndex[building.vertex];
      return (index === undefined ? [] : (graph.vertexHexes[index] ?? []))
        .map((id) => state.board.hexes.find((hex) => hex.id === id))
        .filter((hex) => hex?.token && hex.id !== state.board.robberHex);
    })[0];
    if (!producing?.token) throw new Error('Setup produced no usable token');
    const first = Math.max(1, producing.token - 6);
    const forced = session.forceDice([first, producing.token - first]);
    if (!forced.ok) throw new Error(forced.error.message);
    const rolled = await session.submit(state.turn.activeSeat, { type: 'ROLL_DICE' });
    if (!rolled.ok) throw new Error(rolled.error.message);
    const beforeSave = session.getEvents();
    expect(beforeSave.some((event) => event.type === 'resourcesProduced')).toBe(true);
    const total = state.config.seats.reduce<number>(
      (sum, seat) => sum + productionBySeat(beforeSave, seat),
      0,
    );
    expect(total).toBeGreaterThan(0);
    const saved = session.exportSave();
    const restored = LocalSession.restore(saved, {
      entropy: { randomBytes: (target) => target.fill(0) },
    });
    if (!restored.ok) throw new Error(restored.error.message);
    try {
      expect(restored.value.getEvents()).toEqual(beforeSave);
      expect(
        state.config.seats.map((seat) => productionBySeat(restored.value.getEvents(), seat)),
      ).toEqual(state.config.seats.map((seat) => productionBySeat(beforeSave, seat)));
    } finally {
      restored.value.dispose();
    }
  } finally {
    session.dispose();
  }
});

test('final scoring includes winner and loser private VP without guessing missing hands', () => {
  const made = LocalSession.create({
    config: {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1],
      options: { base: { mapLayout: 'standard-fixed' } },
      board: standardFixedBoard(),
    },
    humanSeats: [0, 1],
    botSeats: [],
    genesisSeed: new Uint8Array(32).fill(3),
  });
  if (!made.ok) throw new Error(made.error.message);
  try {
    const initial = made.value.getState();
    const vertices = buildBoardGraph(initial.board.hexes).vertexIds;
    const winnerVertex = vertices[0];
    const loserVertex = vertices[1];
    if (!winnerVertex || !loserVertex) throw new Error('Board needs two vertices');
    const state = {
      ...initial,
      board: {
        ...initial.board,
        buildings: [
          { vertex: winnerVertex, seat: 0 as const, kind: 'settlement' as const },
          { vertex: loserVertex, seat: 1 as const, kind: 'city' as const },
        ],
      },
      awards: { ...initial.awards, longestRoad: 0 as const },
      seats: initial.seats.map((seat) =>
        seat.seat === 0
          ? {
              ...seat,
              cardSlots: [
                { slotId: 'vp:0', deck: 'dev', acquiredTurn: 1, revealed: 'victoryPoint' as const },
              ],
            }
          : seat,
      ),
    };
    expect(victoryBreakdown(state, 0, 1)).toEqual({
      buildings: 1,
      awards: 2,
      revealed: 1,
      hidden: 1,
      total: 5,
    });
    expect(victoryBreakdown(state, 1, 2)).toEqual({
      buildings: 2,
      awards: 0,
      revealed: 0,
      hidden: 2,
      total: 4,
    });
    expect(victoryBreakdown(state, 1, null).total).toBeNull();
  } finally {
    made.value.dispose();
  }
});

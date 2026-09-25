import { readFile } from 'node:fs/promises';
import { fromBase64Url } from '@cp2p/codec';
import {
  createBaseEngine,
  type GameConfig,
  type GameEvent,
  type Input,
  type Seat,
} from '@cp2p/engine';
import { expect, test } from 'vitest';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import { standardFixedBoard } from '@cp2p/maps';
import { LocalSession } from '../../session/local-session.js';
import { diceHistogram, productionBySeat, victoryBreakdown } from './stats';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSeat(value: unknown): value is Seat {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0 && value <= 5;
}

function isGoldenConfig(value: unknown): value is GameConfig {
  return (
    isRecord(value) &&
    Array.isArray(value.modules) &&
    value.modules.every(
      (module: unknown) =>
        isRecord(module) && typeof module.id === 'string' && typeof module.version === 'string',
    ) &&
    Array.isArray(value.seats) &&
    value.seats.every((seat: unknown) => isSeat(seat)) &&
    isRecord(value.options) &&
    value.board === undefined
  );
}

function isGoldenInput(value: unknown): value is Input {
  return (
    isRecord(value) &&
    ((value.kind === 'system' && typeof value.type === 'string') ||
      (value.kind === 'command' &&
        isSeat(value.seat) &&
        isRecord(value.command) &&
        typeof value.command.type === 'string'))
  );
}

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
      vpCards: 2,
      total: 5,
    });
    expect(victoryBreakdown(state, 1, 2)).toEqual({
      buildings: 2,
      awards: 0,
      revealed: 0,
      hidden: 2,
      vpCards: 2,
      total: 4,
    });
    expect(victoryBreakdown(state, 1, null)).toMatchObject({ vpCards: null, total: null });
  } finally {
    made.value.dispose();
  }
});

test('claimed victory cards appear once in the final VP-card total', async () => {
  const fixtureUrl = new URL(
    '../../../../../packages/engine/test/golden/hidden-vp-win.replay.json',
    import.meta.url,
  );
  // This is the verified engine golden with a final two-slot CLAIM_VICTORY input.
  const replay: unknown = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  if (
    typeof replay !== 'object' ||
    replay === null ||
    !('config' in replay) ||
    !isGoldenConfig(replay.config) ||
    !('genesisSeed' in replay) ||
    typeof replay.genesisSeed !== 'string' ||
    !('inputs' in replay) ||
    !Array.isArray(replay.inputs) ||
    !replay.inputs.every((input: unknown) => isGoldenInput(input))
  )
    throw new Error('Hidden-VP golden is malformed');
  const inputs: Input[] = replay.inputs;
  const engine = createBaseEngine();
  let state = engine.createGame(replay.config, fromBase64Url(replay.genesisSeed));
  for (const input of inputs) {
    const applied = engine.apply(state, input);
    if (!applied.ok) throw new Error(`Hidden-VP golden rejected: ${applied.error.code}`);
    state = applied.value.state;
  }
  expect(inputs.at(-1)).toMatchObject({
    kind: 'command',
    command: { type: 'CLAIM_VICTORY', slotIds: ['dev:2', 'dev:7'] },
  });
  expect(state.result?.winner).toBe(0);
  const score = victoryBreakdown(state, 0, 0);
  expect(score).toMatchObject({
    buildings: 6,
    awards: 2,
    revealed: 2,
    hidden: 0,
    vpCards: 2,
    total: 10,
  });
});

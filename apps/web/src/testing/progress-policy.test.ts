/* eslint-disable vitest/no-conditional-expect -- Check actual interrupt and maritime branches only when they occur. */
import { expect, test } from 'vitest';
import { RandomBot, createBotRng } from '@cp2p/bots';
import { LocalGame, RESOURCES, createBaseEngine, exactResourceBounds } from '@cp2p/engine';
import type { LocalRandomSource, Seat } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import { progressCommand } from '../../tests/helpers/progress-policy.js';

const engine = createBaseEngine();
const config = {
  modules: [{ id: 'base', version: '1.0.0' }],
  seats: [0, 1, 2, 3] as Seat[],
  options: { base: { vpTarget: 3, diceMode: 'random' } },
};

function main(hand: Record<string, number>) {
  const initial = engine.createGame(config, new Uint8Array(32));
  const started = engine.apply(initial, { kind: 'system', type: 'START_SEAT', seat: 0 });
  if (!started.ok) throw new Error(started.error.message);
  const placement = engine
    .getLegalCommands(started.value.state, 0)
    .commands.find((command) => command.type === 'PLACE_SETTLEMENT');
  if (!placement || typeof placement.vertex !== 'string')
    throw new Error('Missing setup placement');
  const counts = Object.fromEntries(RESOURCES.map((resource) => [resource, hand[resource] ?? 0]));
  const bounds = exactResourceBounds({
    brick: counts.brick ?? 0,
    lumber: counts.lumber ?? 0,
    wool: counts.wool ?? 0,
    grain: counts.grain ?? 0,
    ore: counts.ore ?? 0,
  });
  if (!bounds.ok) throw new Error(bounds.error.message);
  const state = {
    ...started.value.state,
    turn: { ...started.value.state.turn, phase: [{ module: 'base', id: 'main', data: null }] },
    board: {
      ...started.value.state.board,
      buildings: [{ vertex: placement.vertex, seat: 0 as const, kind: 'settlement' as const }],
    },
    seats: started.value.state.seats.map((seat) =>
      seat.seat === 0 ? { ...seat, resources: bounds.value } : seat,
    ),
  };
  const priv = { ...engine.createPrivateState(0), hand: counts };
  const pending = engine
    .getPending(state)
    .find((item) => item.kind === 'player' && item.seat === 0);
  if (!pending) throw new Error('Missing main pending');
  return { view: { state, priv, seat: 0 as const }, pending };
}

test('prioritizes legal scoring builds and strictly useful maritime trades', () => {
  for (const [hand, type] of [
    [{ ore: 3, grain: 2 }, 'BUILD_CITY'],
    [{ wool: 8 }, 'MARITIME_TRADE'],
    [{ wool: 3, ore: 2, grain: 2 }, 'END_TURN'],
  ] as const) {
    const { view, pending } = main(hand);
    const command = progressCommand(
      view,
      pending,
      createBotRng(new Uint8Array(32)),
      new RandomBot(),
    );
    expect(command.type).toBe(type);
    expect(engine.validate(view.state, { kind: 'command', seat: 0, command }).ok).toBe(true);
    if (type === 'MARITIME_TRADE') {
      expect(command.give).toEqual({ wool: 4 });
      expect(['ore', 'grain']).toContain(
        Object.keys(typeof command.get === 'object' && command.get !== null ? command.get : {})[0],
      );
    }
  }
});

test('builds only a useful road toward an open settlement site', () => {
  const { view } = main({ brick: 2, lumber: 2, wool: 1, grain: 1 });
  const graph = buildBoardGraph(view.state.board.hexes);
  const vertex = view.state.board.buildings[0]?.vertex;
  if (!vertex) throw new Error('Missing settlement');
  const edge = graph.vertexEdges[graph.vertexIndex[vertex] ?? -1]?.[0];
  if (!edge) throw new Error('Missing setup road');
  const state = {
    ...view.state,
    board: { ...view.state.board, roads: [{ edge, seat: 0 as const }] },
  };
  const pending = engine
    .getPending(state)
    .find((item) => item.kind === 'player' && item.seat === 0);
  if (!pending) throw new Error('Missing road pending');
  const command = progressCommand(
    { ...view, state },
    pending,
    createBotRng(new Uint8Array(32)),
    new RandomBot(),
  );
  expect(command.type).toBe('BUILD_ROAD');
  expect(engine.validate(state, { kind: 'command', seat: 0, command }).ok).toBe(true);
  if (typeof command.edge !== 'string') throw new Error('Missing chosen road');
  const connected = {
    ...state,
    board: {
      ...state.board,
      roads: [...state.board.roads, { edge: command.edge, seat: 0 as const }],
    },
  };
  const settlement = progressCommand(
    { ...view, state: connected },
    pending,
    createBotRng(new Uint8Array(32)),
    new RandomBot(),
  );
  expect(settlement.type).toBe('BUILD_SETTLEMENT');
  expect(engine.validate(connected, { kind: 'command', seat: 0, command: settlement }).ok).toBe(
    true,
  );
});

test('fixed five-seed noncrypto base games finish legally within 300 moves', () => {
  const counts: number[] = [];
  const interrupts = new Set<string>();
  for (const seed of [1, 2, 3, 4, 5]) {
    const random = createBotRng(new Uint8Array(32).fill(seed + 20));
    const source: LocalRandomSource = {
      resolve: (pending, state, privates) => {
        if (pending.systemType === 'START_SEAT')
          return { input: { kind: 'system', type: 'START_SEAT', seat: 0 } };
        if (pending.systemType === 'DICE_RESULT')
          return {
            input: {
              kind: 'system',
              type: 'DICE_RESULT',
              dice: [random.int(6) + 1, random.int(6) + 1],
            },
          };
        if (pending.systemType === 'STEAL_RESULT') {
          const victim = state.config.seats.find((seat) => seat === pending.request.victim);
          const thief = state.config.seats.find((seat) => seat === pending.request.thief);
          if (victim === undefined || thief === undefined) throw new Error('Bad steal');
          const hand = privates.get(victim)?.hand;
          if (!hand) throw new Error('Missing victim hand');
          let index = random.int(
            RESOURCES.reduce((sum, resource) => sum + (hand[resource] ?? 0), 0),
          );
          for (const resource of RESOURCES) {
            index -= hand[resource] ?? 0;
            if (index < 0)
              return { input: { kind: 'system', type: 'STEAL_RESULT', thief, victim, resource } };
          }
        }
        throw new Error(`Unexpected random request ${pending.systemType}`);
      },
    };
    const opened = LocalGame.create(engine, config, new Uint8Array(32).fill(seed), source);
    if (!opened.ok) throw new Error(opened.error.message);
    const game = opened.value;
    const bots = config.seats.map(() => new RandomBot());
    const rngs = config.seats.map((seat) => createBotRng(new Uint8Array(32).fill(seed + seat)));
    let moves = 0;
    while (!game.state.result && moves < 300) {
      const pending = game.getPending().find((item) => item.kind === 'player');
      if (!pending || pending.kind !== 'player') throw new Error('No player pending');
      const priv = game.privateState(pending.seat);
      const bot = bots[pending.seat];
      const rng = rngs[pending.seat];
      if (!priv || !bot || !rng) throw new Error('Missing own actor');
      const state = game.snapshot();
      if (state.turn.phase.at(-1)?.id !== 'main' && !pending.allowed.includes('PLACE_SETTLEMENT')) {
        const own = { state, priv, seat: pending.seat };
        const interruptSeed = new Uint8Array(32).fill(90);
        const expected = new RandomBot().decide(own, pending, createBotRng(interruptSeed));
        expect(progressCommand(own, pending, createBotRng(interruptSeed), new RandomBot())).toEqual(
          expected,
        );
        interrupts.add(expected.type);
      }
      const command = progressCommand({ state, priv, seat: pending.seat }, pending, rng, bot);
      const result = game.submit({ kind: 'command', seat: pending.seat, command });
      if (!result.ok) throw new Error(`${command.type}: ${result.error.message}`);
      moves++;
    }
    expect(game.state.result).not.toBeNull();
    counts.push(moves);
  }
  expect(interrupts).toContain('DISCARD');
  expect(interrupts).toContain('MOVE_ROBBER');
  expect(interrupts).toContain('STEAL');
  // eslint-disable-next-line no-console -- Record all fixed-seed results without selecting successful seeds.
  console.info('Five fixed noncrypto policy move counts', counts);
}, 60_000);

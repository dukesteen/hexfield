import { describe, expect, test } from 'vitest';
import { createBaseEngine } from '../modules/base/index.js';
import { boardGraph } from '../modules/base/board/index.js';
import { frame } from '../modules/base/shared.js';
import { exactResourceBounds } from './resources/index.js';
import { createRng } from './rng/index.js';
import type { GameState, PrivateState } from './state/index.js';
import type { ResourceCounts, Seat } from './types/index.js';
import { enumerateCommands } from './enumerate.js';

const engine = createBaseEngine();
const zero: ResourceCounts = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
const cityOnly = (command: { type: string }) => command.type === 'BUILD_CITY';

function genesis(): GameState {
  return engine.createGame(
    {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1, 2],
      options: { base: { mapLayout: 'random' } },
    },
    new Uint8Array(32),
  );
}

function hand(state: GameState, seat: Seat, counts: ResourceCounts): GameState {
  const bounds = exactResourceBounds(counts);
  if (!bounds.ok) throw new Error(bounds.error.message);
  return {
    ...state,
    seats: state.seats.map((holder) =>
      holder.seat === seat ? { ...holder, resources: bounds.value } : holder,
    ),
  };
}

function priv(seat: Seat, counts: ResourceCounts): PrivateState {
  return { ...engine.createPrivateState(seat), hand: counts };
}

describe('legal command enumeration', () => {
  test('expands all 15 year-of-plenty pairs and five monopoly choices', () => {
    let state = genesis();
    state = {
      ...state,
      turn: { ...state.turn, number: 3, activeSeat: 0, phase: [frame('main')] },
      seats: state.seats.map((holder) =>
        holder.seat === 0
          ? {
              ...holder,
              cardSlots: [
                { slotId: 'dev:0', deck: 'dev', acquiredTurn: 2 },
                { slotId: 'dev:1', deck: 'dev', acquiredTurn: 2 },
              ],
            }
          : holder,
      ),
    };
    const own = { ...priv(0, zero), slots: { 'dev:0': 'yearOfPlenty', 'dev:1': 'monopoly' } };
    const choices = enumerateCommands(engine, state, 0, own);
    expect(
      choices.filter((choice) => choice.type === 'PLAY_DEV_CARD' && choice.card === 'yearOfPlenty'),
    ).toHaveLength(15);
    expect(
      choices.filter((choice) => choice.type === 'PLAY_DEV_CARD' && choice.card === 'monopoly'),
    ).toHaveLength(5);
    for (const choice of choices)
      expect(engine.validate(state, { kind: 'command', seat: 0, command: choice }).ok).toBe(true);
  });

  test('enumerates complete road placements and valid single-unit trades', () => {
    let state = genesis();
    const vertex = boardGraph(state).vertexIds[0];
    if (!vertex) throw new Error('No vertex');
    state = hand(
      {
        ...state,
        turn: { ...state.turn, number: 3, activeSeat: 0, phase: [frame('main')] },
        board: { ...state.board, buildings: [{ vertex, seat: 0, kind: 'settlement' }] },
      },
      0,
      { ...zero, brick: 4, lumber: 4, wool: 4, grain: 4, ore: 4 },
    );
    const own = priv(0, { ...zero, brick: 4, lumber: 4, wool: 4, grain: 4, ore: 4 });
    const allLegal = engine.getLegalCommands(state, 0, own);
    expect(engine.getLegalCommands(state, 0, own, cityOnly)).toEqual({
      commands: allLegal.commands.filter(cityOnly),
      templates: allLegal.templates,
    });
    const choices = enumerateCommands(engine, state, 0, own);
    expect(
      enumerateCommands(engine, state, 0, own, {
        candidateFilter: (command) => command.type === 'BUILD_CITY',
      }),
    ).toEqual(choices.filter((command) => command.type === 'BUILD_CITY'));
    const graph = boardGraph(state);
    for (const [type, field, ids] of [
      ['BUILD_ROAD', 'edge', graph.edgeIds],
      ['BUILD_SETTLEMENT', 'vertex', graph.vertexIds],
      ['BUILD_CITY', 'vertex', graph.vertexIds],
    ] as const) {
      const expected = ids
        .filter(
          (id) =>
            engine.validate(state, { kind: 'command', seat: 0, command: { type, [field]: id } }).ok,
        )
        .toSorted();
      const actual = choices
        .filter((choice) => choice.type === type)
        .map((choice) => String(choice[field]))
        .toSorted();
      expect(actual).toEqual(expected);
    }
    expect(choices.some((choice) => choice.type === 'MARITIME_TRADE')).toBe(true);
    expect(choices.filter((choice) => choice.type === 'OFFER_TRADE').length).toBeLessThanOrEqual(
      40,
    );
    for (const choice of choices)
      expect(engine.validate(state, { kind: 'command', seat: 0, command: choice }).ok).toBe(true);
  });

  test('enumerates every small discard and samples a large hand without duplicates', () => {
    const first = hand(genesis(), 0, { ...zero, brick: 2, lumber: 2, wool: 1 });
    const state: GameState = {
      ...first,
      turn: {
        ...first.turn,
        number: 3,
        activeSeat: 0,
        phase: [frame('discard', { remaining: [0] })],
      },
    };
    const small = enumerateCommands(
      engine,
      state,
      0,
      priv(0, { ...zero, brick: 2, lumber: 2, wool: 1 }),
    );
    expect(small).toHaveLength(5);
    for (const choice of small)
      expect(engine.validate(state, { kind: 'command', seat: 0, command: choice }).ok).toBe(true);

    const largeHand: ResourceCounts = { brick: 19, lumber: 19, wool: 19, grain: 19, ore: 19 };
    const large = hand(state, 0, largeHand);
    expect(() => enumerateCommands(engine, large, 0, priv(0, largeHand))).toThrow(/sampleIndex/);
    const seed = new Uint8Array(32).fill(7);
    const rng1 = createRng(seed);
    const rng2 = createRng(seed);
    const options = { maxDiscardOptions: 50 };
    const sampled1 = enumerateCommands(engine, large, 0, priv(0, largeHand), {
      ...options,
      sampleIndex: (max) => rng1.int(max),
    });
    const sampled2 = enumerateCommands(engine, large, 0, priv(0, largeHand), {
      ...options,
      sampleIndex: (max) => rng2.int(max),
    });
    expect(sampled1).toHaveLength(50);
    expect(new Set(sampled1.map((choice) => JSON.stringify(choice))).size).toBe(50);
    expect(sampled1).toEqual(sampled2);
    for (const choice of sampled1)
      expect(engine.validate(large, { kind: 'command', seat: 0, command: choice }).ok).toBe(true);
  });
});

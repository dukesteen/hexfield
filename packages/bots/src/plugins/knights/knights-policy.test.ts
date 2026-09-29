import { describe, expect, test } from 'vitest';
import {
  createResourceBounds,
  deckOfTrack,
  kindsOfCounts,
  knightsConfig,
  knightsEngine,
  knightsExt,
  trackOfCard,
  zeroCounts,
} from '@cp2p/engine';
import type { CommandShape, GameState, PhaseFrame, PrivateState } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import { PLUGINS } from '../../levels.js';
import { HARD } from '../../policy/config.js';
import { HeuristicBot } from '../../policy/heuristic-bot.js';
import { createBotRng } from '../../random-bot.js';
import { attackChance } from './shared.js';

const engine = knightsEngine();
const MAIN: PhaseFrame[] = [{ module: 'base', id: 'main', data: null }];

function genesis(): GameState {
  return engine.createGame(knightsConfig({ seats: 4 }), new Uint8Array(32));
}

function withTurn(state: GameState, phase: PhaseFrame[]): GameState {
  return { ...state, turn: { number: 9, activeSeat: 0, phase } };
}

/** Give seat 0 an exact hand, in the public bounds and the private state. */
function withHand(
  state: GameState,
  hand: Record<string, number>,
): { state: GameState; priv: PrivateState } {
  const kinds = kindsOfCounts(state.bank);
  const counts = { ...zeroCounts(kinds), ...hand };
  const total = kinds.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0);
  const bounds = createResourceBounds(total, counts, counts, kinds);
  if (!bounds.ok) throw new Error(bounds.error.message);
  const next = {
    ...state,
    seats: state.seats.map((item) =>
      item.seat === 0 ? { ...item, resources: bounds.value } : item,
    ),
  };
  return { state: next, priv: { ...engine.createPrivateState(0, state.config), hand: counts } };
}

function withKnights(state: GameState, change: Partial<ReturnType<typeof knightsExt>>): GameState {
  return { ...state, ext: { ...state.ext, knights: { ...knightsExt(state), ...change } } };
}

function withProgress(state: GameState, cards: readonly string[]): GameState {
  const slots = cards.map((card, index) => ({
    slotId: `progress:${index}`,
    deck: deckOfTrack(trackOfCard(card) ?? 'science'),
    acquiredTurn: 1,
    known: card,
  }));
  return {
    ...state,
    seats: state.seats.map((item) => (item.seat === 0 ? { ...item, cardSlots: slots } : item)),
  };
}

/** The Hard bot's decision for seat 0, checked to be legal. */
function decide(state: GameState, priv: PrivateState): CommandShape {
  const pending = engine
    .getPending(state)
    .find(
      (item) =>
        item.kind === 'player' &&
        item.seat === 0 &&
        item.allowed.some((type) => type !== 'CLAIM_VICTORY'),
    );
  if (pending?.kind !== 'player') throw new Error('No pending for seat 0');
  const bot = new HeuristicBot(HARD, PLUGINS, engine);
  const warnings: string[] = [];
  const command = bot.decide({ state, priv, seat: 0 }, pending, createBotRng(new Uint8Array(32)), {
    warn: (message) => warnings.push(message),
  });
  expect(warnings).toEqual([]);
  expect(engine.validate(state, { kind: 'command', seat: 0, command }).ok).toBe(true);
  return command;
}

describe('knights policy', () => {
  test('the attack chance follows the track: a ship on half of all rolls', () => {
    const base = genesis();
    const at = (step: number, rounds?: number): number =>
      attackChance(withKnights(base, { barbarians: { step } }), rounds);
    expect(at(6)).toBeCloseTo(15 / 16);
    expect(at(5)).toBeCloseTo(11 / 16);
    expect(at(0)).toBe(0);
    expect(at(0, 3)).toBeGreaterThan(0.3);
  });

  test('activates a knight when the attack is likely before its next turn', () => {
    const base = genesis();
    const graph = buildBoardGraph(base.board.hexes);
    const [city, knight, other] = [graph.vertexIds[0], graph.vertexIds[20], graph.vertexIds[40]];
    if (!city || !knight || !other) throw new Error('Board too small');
    const board: GameState['board'] = {
      ...base.board,
      buildings: [
        { vertex: city, seat: 0, kind: 'city' as const },
        { vertex: other, seat: 1, kind: 'city' as const },
      ],
    };
    const armed = withKnights(
      { ...base, board },
      {
        barbarians: { step: 6 },
        knights: [
          { seat: 0, vertex: knight, level: 1, active: false, ready: false, promotedTurn: null },
        ],
      },
    );
    const { state, priv } = withHand(withTurn(armed, MAIN), { grain: 1 });
    expect(decide(state, priv)).toEqual({ type: 'ACTIVATE_KNIGHT', vertex: knight });
  });

  test('buys the level that takes a metropolis before anything else', () => {
    const base = genesis();
    const graph = buildBoardGraph(base.board.hexes);
    const [city, settlement] = [graph.vertexIds[0], graph.vertexIds[40]];
    if (!city || !settlement) throw new Error('Board too small');
    const levels = knightsExt(base).improvements.map((item, seat) =>
      seat === 0 ? { ...item, science: 3 } : item,
    );
    const board: GameState['board'] = {
      ...base.board,
      buildings: [
        { vertex: city, seat: 0, kind: 'city' as const },
        { vertex: settlement, seat: 0, kind: 'settlement' as const },
      ],
    };
    const ready = withTurn(withKnights({ ...base, board }, { improvements: levels }), MAIN);
    // A city is affordable too; the metropolis comes first.
    const { state, priv } = withHand(ready, { paper: 4, ore: 3, grain: 2 });
    expect(decide(state, priv)).toEqual({ type: 'BUILD_IMPROVEMENT', track: 'science' });
    // One paper short: a bank trade of the card it misses least.
    const short = withHand(ready, { paper: 3, wool: 4 });
    expect(decide(short.state, short.priv)).toEqual({
      type: 'MARITIME_TRADE',
      give: { wool: 4 },
      get: { paper: 1 },
    });
  });

  test('sets the dice on its best number with an Alchemist, never a 7', () => {
    const base = genesis();
    const graph = buildBoardGraph(base.board.hexes);
    const counts = new Map<number, string[]>();
    for (const hex of base.board.hexes)
      if (typeof hex.token === 'number')
        counts.set(hex.token, [...(counts.get(hex.token) ?? []), hex.id]);
    const [token, hexes] = [...counts.entries()].find(([, ids]) => ids.length >= 2) ?? [0, []];
    const vertices = new Set(
      hexes.flatMap((hex) => graph.hexVertices[graph.hexIndex[hex] ?? -1] ?? []),
    );
    const board: GameState['board'] = {
      ...base.board,
      buildings: [...vertices].map((vertex) => ({ vertex, seat: 0, kind: 'city' as const })),
    };
    const state = withTurn(withProgress({ ...base, board }, ['alchemist']), [
      { module: 'base', id: 'preRoll', data: null },
    ]);
    const command = decide(state, engine.createPrivateState(0, state.config));
    expect(command.type).toBe('PLAY_PROGRESS_CARD');
    expect(command.card).toBe('alchemist');
    const dice = Reflect.get(Object(command.params), 'dice');
    expect(Array.isArray(dice) ? Number(dice[0]) + Number(dice[1]) : 0).toBe(token);
  });

  test('over the card limit with nothing worth playing, discards the card least worth keeping', () => {
    const cards = ['merchant', 'resourceMonopoly', 'intrigue', 'irrigation', 'wedding'];
    const state = withTurn(withProgress(genesis(), cards), MAIN);
    const command = decide(state, engine.createPrivateState(0, state.config));
    expect(command).toEqual({
      type: 'DISCARD_PROGRESS',
      cards: [{ slotId: 'progress:2', card: 'intrigue' }],
    });
  });

  test('plays the Merchant for its point', () => {
    const base = genesis();
    const graph = buildBoardGraph(base.board.hexes);
    const vertex = graph.vertexIds[30];
    if (!vertex) throw new Error('Board too small');
    const board: GameState['board'] = {
      ...base.board,
      buildings: [{ vertex, seat: 0, kind: 'settlement' as const }],
    };
    const state = withTurn(withProgress({ ...base, board }, ['merchant']), MAIN);
    const command = decide(state, engine.createPrivateState(0, state.config));
    expect(command.type).toBe('PLAY_PROGRESS_CARD');
    expect(command.card).toBe('merchant');
  });
});

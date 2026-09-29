import { describe, expect, test } from 'vitest';
import {
  createResourceBounds,
  kindsOfCounts,
  knightsConfig,
  knightsEngine,
  knightsExt,
  zeroCounts,
} from '@cp2p/engine';
import type { GameState, PhaseFrame } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import { RandomBot, createBotRng } from './random-bot.js';

const engine = knightsEngine();

function genesis(): GameState {
  return engine.createGame(knightsConfig({ seats: 3 }), new Uint8Array(32));
}

function inFrame(state: GameState, phase: PhaseFrame[]): GameState {
  return { ...state, turn: { number: 5, activeSeat: 0, phase } };
}

/** Two adjacent vertices and the edge between them. */
function pair(state: GameState): { a: string; b: string; edge: string } {
  const graph = buildBoardGraph(state.board.hexes);
  const edge = graph.edgeIds[0] ?? '';
  const [a, b] = graph.edgeVertices[graph.edgeIndex[edge] ?? 0] ?? ['', ''];
  return { a, b, edge };
}

/** Give seat 0 an exact hand, in the public bounds and the private state. */
function withHand(state: GameState, hand: Record<string, number>) {
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

function decide(state: GameState, priv: ReturnType<typeof engine.createPrivateState>) {
  const pending = engine
    .getPending(state)
    .find(
      (item) =>
        item.kind === 'player' &&
        item.seat === 0 &&
        item.allowed.some((type) => type !== 'CLAIM_VICTORY'),
    );
  if (pending?.kind !== 'player') throw new Error('No pending for seat 0');
  const bot = new RandomBot(engine);
  const rng = createBotRng(new Uint8Array(32).fill(3));
  const command = bot.decide({ state, priv, seat: 0 }, pending, rng);
  expect(engine.validate(state, { kind: 'command', seat: 0, command }).ok).toBe(true);
  return command;
}

const frames = (state: GameState, id: string, data: unknown): GameState =>
  inFrame(state, [{ module: 'knights', id, data }]);

/** The number of cards a command names. */
function cardCount(cards: unknown): number {
  return typeof cards === 'object' && cards !== null
    ? Object.values(cards).reduce(
        (sum: number, count: unknown) => sum + (typeof count === 'number' ? count : 0),
        0,
      )
    : 0;
}

describe('RandomBot in a knights game', () => {
  test('answers a pillage with one of its cities', () => {
    const base = genesis();
    const graph = buildBoardGraph(base.board.hexes);
    const [first, second] = [graph.vertexIds[0] ?? '', graph.vertexIds[20] ?? ''];
    const state = inFrame(
      {
        ...base,
        board: {
          ...base.board,
          buildings: [
            { vertex: first, seat: 0, kind: 'city' },
            { vertex: second, seat: 0, kind: 'city' },
          ],
        },
      },
      [{ module: 'knights', id: 'pillage', data: { remaining: [0], roll: 5 } }],
    );
    const pending = engine
      .getPending(state)
      .find((item) => item.kind === 'player' && item.seat === 0);
    if (!pending) throw new Error('No pillage pending');
    const bot = new RandomBot(engine);
    const rng = createBotRng(new Uint8Array(32).fill(1));
    const view = { state, priv: engine.createPrivateState(0), seat: 0 as const };
    const chosen = new Set<unknown>();
    for (let n = 0; n < 30; n++) {
      const command = bot.decide(view, pending, rng);
      expect(command.type).toBe('CHOOSE_PILLAGE');
      expect(engine.validate(state, { kind: 'command', seat: 0, command }).ok).toBe(true);
      chosen.add(command.vertex);
    }
    expect(chosen).toEqual(new Set([first, second]));
  });

  test('places a displaced knight where its roads lead', () => {
    const base = genesis();
    const { a, b, edge } = pair(base);
    const data = { seat: 1, origin: a, level: 1, active: false, ready: false, promotedTurn: null };
    const state = inFrame(
      {
        ...base,
        board: {
          ...base.board,
          roads: [{ edge, seat: 1 }],
        },
        ext: {
          ...base.ext,
          knights: {
            ...knightsExt(base),
            knights: [
              { seat: 0, vertex: a, level: 2, active: false, ready: false, promotedTurn: null },
            ],
          },
        },
      },
      [{ module: 'knights', id: 'displaced', data }],
    );
    const pending = engine
      .getPending(state)
      .find((item) => item.kind === 'player' && item.seat === 1);
    if (!pending) throw new Error('No displaced pending');
    const bot = new RandomBot(engine);
    const command = bot.decide(
      { state, priv: engine.createPrivateState(1), seat: 1 },
      pending,
      createBotRng(new Uint8Array(32).fill(2)),
    );
    expect(command).toEqual({ type: 'RELOCATE_KNIGHT', to: b });
  });

  describe('progress cards', () => {
    test('discards down to the limit when it cannot end its turn', () => {
      const base = genesis();
      const cards = ['engineer', 'irrigation', 'mining', 'medicine', 'crane'];
      const slots = cards.map((card, index) => ({
        slotId: `progress:${index}`,
        deck: 'progress-science',
        acquiredTurn: 1,
        known: card,
      }));
      const state = inFrame(
        {
          ...base,
          seats: base.seats.map((item) => (item.seat === 0 ? { ...item, cardSlots: slots } : item)),
        },
        [{ module: 'base', id: 'main', data: null }],
      );
      const command = decide(state, engine.createPrivateState(0, state.config));
      expect(command.type).toBe('DISCARD_PROGRESS');
    });

    test('answers a wedding with two of its own cards and a sabotage with half its hand', () => {
      const { state, priv } = withHand(genesis(), { ore: 3, cloth: 2, wool: 1 });
      const wedding = frames(state, 'wedding', { actor: 1, remaining: [0] });
      const gift = decide(wedding, priv);
      expect(gift.type).toBe('WEDDING_GIVE');
      expect(cardCount(gift.cards)).toBe(2);
      const sabotage = frames(state, 'saboteur', { actor: 1, remaining: [0] });
      const discard = decide(sabotage, priv);
      expect(discard.type).toBe('SABOTEUR_DISCARD');
      expect(cardCount(discard.cards)).toBe(3);
    });

    test('answers a commercial harbor offer with a commodity it holds, or none', () => {
      const own = withHand(genesis(), { cloth: 1, wool: 2 });
      const frame = { actor: 1, seat: 0, offered: 'wool' };
      expect(decide(frames(own.state, 'harborReply', frame), own.priv)).toEqual({
        type: 'HARBOR_REPLY',
        commodity: 'cloth',
      });
      const none = withHand(genesis(), { wool: 2 });
      expect(decide(frames(none.state, 'harborReply', frame), none.priv)).toEqual({
        type: 'HARBOR_REPLY',
        commodity: 'none',
      });
    });

    test('names a deck for a defender tie draw', () => {
      const { state, priv } = withHand(genesis(), {});
      const command = decide(
        frames(state, 'progress', {
          roll: 6,
          queue: [{ seat: 0, deck: null }],
          checks: [],
          discards: null,
        }),
        priv,
      );
      expect(command.type).toBe('CHOOSE_PROGRESS_DECK');
      expect(['trade', 'politics', 'science']).toContain(command.deck);
    });

    test('skips or places a deserting knight', () => {
      const { state, priv } = withHand(genesis(), {});
      const place = frames(state, 'deserter', {
        actor: 0,
        target: 1,
        stage: 'place',
        level: 1,
        active: false,
      });
      // With no road of its own the seat has no site, so it leaves the place empty.
      expect(decide(place, priv)).toEqual({ type: 'DESERTER_SKIP' });
    });
  });
});

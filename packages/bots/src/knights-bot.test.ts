import { describe, expect, test } from 'vitest';
import { knightsConfig, knightsEngine, knightsExt } from '@cp2p/engine';
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
});

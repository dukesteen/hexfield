import { describe, expect, test } from 'vitest';
import { knightsConfig, knightsEngine } from '@cp2p/engine';
import type { GameState, Pending, PrivateState } from '@cp2p/engine';
import { createRng } from '@cp2p/engine/rng';
import { RandomBot, createBotRng } from '../random-bot.js';
import { sampledChance } from './chance.js';
import { copyWorld, determinize } from './determinize.js';
import { rollout } from './rollout.js';

const engine = knightsEngine();

function started(): { state: GameState; priv: PrivateState; first: Pending } {
  const created = engine.createGame(knightsConfig({ seats: 3 }), new Uint8Array(32).fill(4));
  const applied = engine.apply(created, { kind: 'system', type: 'START_SEAT', seat: 0 });
  if (!applied.ok) throw new Error(applied.error.message);
  const first = engine
    .getPending(applied.value.state)
    .find((item) => item.kind === 'player' && item.seat === 0);
  if (!first) throw new Error('No setup pending');
  return {
    state: applied.value.state,
    priv: engine.createPrivateState(0, created.config),
    first,
  };
}

describe('sampled chance (follow-up B)', () => {
  test('a knights rollout runs on: event die, progress draws and reveals are all answered', () => {
    const { state, priv, first } = started();
    const view = { state, priv, seat: 0 };
    const random = new RandomBot(engine);
    const firstMove = random.decide(view, first, createBotRng(new Uint8Array(32).fill(1)));
    const world = determinize(view, engine, createBotRng(new Uint8Array(32).fill(2)), true);
    expect([...world.decks.keys()].some((id) => id.startsWith('progress'))).toBe(true);
    const sampled = copyWorld(world);
    const end = rollout(
      engine,
      sampled,
      0,
      firstMove,
      () => random,
      createBotRng(new Uint8Array(32).fill(5)),
      40,
      () => false,
      sampledChance(
        sampled,
        createRng(new Uint8Array(32).fill(6)),
        createRng(new Uint8Array(32).fill(7)),
      ),
    );
    if (end === null || end === 'timeout') throw new Error('Rollout stopped');
    // Forty turns later (or at the end of the game): no chance event stopped the rollout.
    expect(end.state.result !== null || end.state.turn.number >= state.turn.number + 40).toBe(true);
  });

  test('the dice stream is separate: the same seed rolls the same dice whatever the draws', () => {
    const { state } = started();
    const pending: Extract<Pending, { kind: 'random' }> = {
      kind: 'random',
      systemType: 'DICE_RESULT',
      request: { type: 'dice', mode: 'random', extra: [{ id: 'event', faces: ['ship', 'trade'] }] },
    };
    const world = { state, privates: new Map(), devDeck: [], decks: new Map() };
    const roll = (drawSeed: number) =>
      sampledChance(
        world,
        createRng(new Uint8Array(32).fill(9)),
        createRng(new Uint8Array(32).fill(drawSeed)),
      )(pending, state, new Map());
    const first = roll(1);
    expect(first?.input).toMatchObject({
      type: 'DICE_RESULT',
      extra: { event: expect.any(String) },
    });
    expect(roll(2)).toEqual(first);
  });
});

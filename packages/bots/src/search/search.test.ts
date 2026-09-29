import { describe, expect, test } from 'vitest';
import { createBaseEngine, exactResourceBounds, loseHidden } from '@cp2p/engine';
import type { GameState, Pending, PrivateState } from '@cp2p/engine';
import { createBotRng } from '../random-bot.js';
import { PLUGINS } from '../levels.js';
import { determinize } from './determinize.js';
import { HardBot } from './hard-bot.js';

const engine = createBaseEngine();

function setup(): { state: GameState; priv: PrivateState; pending: Pending } {
  const created = engine.createGame(
    {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1, 2, 3],
      options: { base: { mapLayout: 'random' } },
    },
    new Uint8Array(32).fill(2),
  );
  const started = engine.apply(created, { kind: 'system', type: 'START_SEAT', seat: 0 });
  if (!started.ok) throw new Error(started.error.message);
  const pending = engine
    .getPending(started.value.state)
    .find((item) => item.kind === 'player' && item.seat === 0);
  if (!pending) throw new Error('No setup pending');
  return { state: started.value.state, priv: engine.createPrivateState(0), pending };
}

describe('determinization', () => {
  test('keeps the bot’s own hand and samples opponents inside their public bounds', () => {
    const { state } = setup();
    const exact = exactResourceBounds({ brick: 2, lumber: 1, wool: 0, grain: 0, ore: 3 });
    if (!exact.ok) throw new Error(exact.error.message);
    const lost = loseHidden(exact.value, 2);
    if (!lost.ok) throw new Error(lost.error.message);
    const hidden = {
      ...state,
      seats: state.seats.map((holder) =>
        holder.seat === 1 ? { ...holder, resources: lost.value } : holder,
      ),
    };
    const priv = {
      ...engine.createPrivateState(0),
      hand: { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 },
    };
    const rng = createBotRng(new Uint8Array(32).fill(8));
    for (let n = 0; n < 20; n++) {
      const world = determinize({ state: hidden, priv, seat: 0 }, engine, rng);
      expect(world.privates.get(0)).toBe(priv);
      const hand = world.privates.get(1)?.hand ?? {};
      expect(Object.values(hand).reduce((sum, count) => sum + count, 0)).toBe(4);
      expect(hand.wool).toBe(0);
      expect(hand.ore ?? 0).toBeLessThanOrEqual(3);
      expect(world.devDeck).toHaveLength(state.decks.dev?.remaining ?? 0);
    }
  });
});

describe('Hard bot search', () => {
  test('an opening choice is legal and reproducible from the seed', () => {
    const { state, priv, pending } = setup();
    const choose = () =>
      new HardBot(PLUGINS, engine).decide(
        { state, priv, seat: 0 },
        pending,
        createBotRng(new Uint8Array(32).fill(5)),
        { iterationBudget: 2 },
      );
    const first = choose();
    expect(first.type).toBe('PLACE_SETTLEMENT');
    expect(engine.validate(state, { kind: 'command', seat: 0, command: first }).ok).toBe(true);
    expect(choose()).toEqual(first);
  });

  test('a budget too small for one iteration leaves the heuristic’s choice', () => {
    const { state, priv, pending } = setup();
    const started = performance.now();
    const command = new HardBot(PLUGINS, engine).decide(
      { state, priv, seat: 0 },
      pending,
      createBotRng(new Uint8Array(32).fill(5)),
      { timeBudgetMs: 0 },
    );
    expect(command.type).toBe('PLACE_SETTLEMENT');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

import { expect, test } from 'vitest';
import { RandomBot } from '@cp2p/bots';
import { createBaseEngine, exactResourceBounds } from '@cp2p/engine';
import { stableBotConfig } from '../../tests/helpers/stable-bot-config.js';

test('cloned browser snapshots retain per-turn and per-game offer limits', () => {
  const engine = createBaseEngine();
  const state = engine.createGame(
    {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1, 2],
      options: { base: { mapLayout: 'random' } },
    },
    new Uint8Array(32),
  );
  const bounds = exactResourceBounds({ brick: 2, lumber: 0, wool: 0, grain: 0, ore: 0 });
  if (!bounds.ok) throw new Error(bounds.error.message);
  const main = {
    ...state,
    turn: {
      ...state.turn,
      activeSeat: 0 as const,
      phase: [{ module: 'base', id: 'main', data: null }],
    },
    seats: state.seats.map((holder) =>
      holder.seat === 0 ? { ...holder, resources: bounds.value } : holder,
    ),
  };
  const priv = {
    ...engine.createPrivateState(0),
    hand: { brick: 2, lumber: 0, wool: 0, grain: 0, ore: 0 },
  };
  const bot = new RandomBot(engine);
  const stable = stableBotConfig();
  let pinned;
  for (let turn = 0; turn < 10; turn++) {
    const snapshot = () =>
      stable(structuredClone({ ...main, turn: { ...main.turn, number: turn } }));
    const current = snapshot();
    pinned ??= current.config;
    expect(current.config).toBe(pinned);
    const pending = engine
      .getPending(current)
      .find((item) => item.kind === 'player' && item.seat === 0);
    if (!pending) throw new Error('Missing main pending');
    const decide = () =>
      bot.decide({ state: snapshot(), priv, seat: 0 }, pending, { int: (max) => max - 1 });
    expect(decide().type === 'OFFER_TRADE').toBe(turn < 8);
    expect(decide().type).not.toBe('OFFER_TRADE');
  }
});

test('refuses changed configs and isolates the pinned config from snapshots', () => {
  const engine = createBaseEngine();
  const state = engine.createGame(
    {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1, 2],
      options: { base: { mapLayout: 'random' } },
    },
    new Uint8Array(32),
  );
  const stable = stableBotConfig();
  const first = structuredClone(state);
  const pinned = stable(first);
  expect(pinned.config).not.toBe(first.config);
  first.config.seats.reverse();
  expect(() => stable(first)).toThrow('Browser bot game config changed');
  expect(stable(structuredClone(state)).config).toBe(pinned.config);
});

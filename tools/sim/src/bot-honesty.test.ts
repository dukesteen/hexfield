import { describe, expect, test } from 'vitest';
import { createBot, createBotRng, createBotView } from '@cp2p/bots';
import type { BotLevel, BotView } from '@cp2p/bots';
import { LocalGame, engineForConfig } from '@cp2p/engine';
import type { GameState, Pending, PrivateState, Seat } from '@cp2p/engine';
import { gameConfig } from './run-game.js';
import { createLocalRandomSource, deriveSeed } from './random-source.js';

/**
 * A view in which anything not structurally present throws when read. A bot that tried to reach
 * another seat's secrets (a `privates` map, a `hands` table, a deck order) would fail at once.
 */
function guarded<T extends object>(target: T, path: string): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      if (typeof key === 'string' && !(key in object) && key !== 'then' && key !== 'toJSON')
        throw new Error(`Bot read absent field ${path}.${key}`);
      return Reflect.get(object, key, receiver);
    },
  });
}

function honestView(state: GameState, priv: PrivateState, seat: Seat): BotView {
  const view = createBotView(state, priv, seat);
  return guarded(
    { state: guarded(view.state, 'state'), priv: guarded(view.priv, 'priv'), seat: view.seat },
    'view',
  );
}

function playerPending(pending: Pending[], active: Seat): Extract<Pending, { kind: 'player' }> {
  const players = pending.filter(
    (item): item is Extract<Pending, { kind: 'player' }> =>
      item.kind === 'player' && item.allowed.some((type) => type !== 'CLAIM_VICTORY'),
  );
  const chosen =
    players.find((item) => item.allowed.includes('DISCARD')) ??
    players.find((item) => item.seat !== active && item.allowed.includes('RESPOND_TRADE')) ??
    players.find((item) => item.seat === active) ??
    players[0];
  if (!chosen) throw new Error('No player pending');
  return chosen;
}

describe('difficulty honesty', () => {
  test('a bot view has no field for another seat’s private state', () => {
    const config = gameConfig(4, {});
    const engine = engineForConfig(config);
    const state = engine.createGame(config, deriveSeed(3, 0, 'genesis'));
    const view = honestView(state, engine.createPrivateState(0, config), 0);
    // @ts-expect-error -- a bot view carries no other seat's private state.
    expect(() => view.privates).toThrow(/absent field view.privates/);
    // @ts-expect-error -- nor does the public state.
    expect(() => view.state.hands).toThrow(/absent field state.hands/);
    expect(Object.keys(view).toSorted()).toEqual(['priv', 'seat', 'state']);
    expect(() => createBotView(state, engine.createPrivateState(1, config), 0)).toThrow(/own seat/);
  });

  test.each(['easy', 'normal', 'hard'] as const)(
    'the %s bot plays a whole game reading only its own view',
    (level: BotLevel) => {
      const config = gameConfig(4, {});
      const engine = engineForConfig(config);
      const created = LocalGame.create(
        engine,
        config,
        deriveSeed(3, 0, 'genesis'),
        createLocalRandomSource(deriveSeed(3, 0, 'system')),
      );
      if (!created.ok) throw new Error(created.error.message);
      const game = created.value;
      const bots = config.seats.map(() => createBot(level, engine));
      const rngs = config.seats.map((seat) => createBotRng(deriveSeed(3, 0, 'bot', seat)));
      let decisions = 0;
      while (!game.state.result && game.state.turn.number < 400) {
        const pending = playerPending(game.getPending(), game.state.turn.activeSeat);
        const priv = game.privateView(pending.seat);
        const bot = bots[pending.seat];
        const rng = rngs[pending.seat];
        if (!priv || !bot || !rng) throw new Error('Missing seat');
        const command = bot.decide(honestView(game.state, priv, pending.seat), pending, rng, {
          iterationBudget: 2,
        });
        const next = game.submit({ kind: 'command', seat: pending.seat, command });
        if (!next.ok) throw new Error(next.error.message);
        decisions++;
      }
      expect(game.state.result).not.toBeNull();
      expect(decisions).toBeGreaterThan(100);
    },
    60_000,
  );
});

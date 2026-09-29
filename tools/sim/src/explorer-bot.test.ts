import { createBotRng } from '@cp2p/bots';
import { LocalGame, engineForConfig } from '@cp2p/engine';
import type { Pending } from '@cp2p/engine';
import { scenarioById, scenarioConfig } from '@cp2p/maps';
import { expect, test } from 'vitest';
import { ExplorerBot } from './explorer-bot.js';
import { createLocalRandomSource, deriveSeed } from './random-source.js';

test('an explorer bot sails toward the fog, so a Fogbound game reveals tiles', () => {
  const scenario = scenarioById('fogbound');
  if (!scenario) throw new Error('Missing fogbound');
  const base = scenarioConfig(scenario, 4);
  const config = {
    ...base,
    options: { ...base.options, base: { ...(base.options.base ?? {}), vpTarget: 8 } },
  };
  const engine = engineForConfig(config);
  const created = LocalGame.create(
    engine,
    config,
    deriveSeed(5, 1, 'genesis'),
    createLocalRandomSource(deriveSeed(5, 1, 'system')),
  );
  if (!created.ok) throw new Error(created.error.message);
  const game = created.value;
  const bots = config.seats.map(() => new ExplorerBot(engine));
  const rngs = config.seats.map((seat) => createBotRng(deriveSeed(5, 1, 'bot', seat)));
  for (let step = 0; step < 20_000 && !game.state.result; step++) {
    const players = game
      .getPending()
      .filter(
        (item): item is Extract<Pending, { kind: 'player' }> =>
          item.kind === 'player' && item.allowed.some((type) => type !== 'CLAIM_VICTORY'),
      );
    const pending =
      players.find((item) => item.allowed.includes('DISCARD')) ??
      players.find((item) => item.seat === game.state.turn.activeSeat) ??
      players[0];
    const priv = pending && game.privateView(pending.seat);
    const bot = pending && bots[pending.seat];
    const rng = pending && rngs[pending.seat];
    if (!pending || !priv || !bot || !rng) throw new Error('No actor');
    const command = bot.decide({ state: game.state, priv, seat: pending.seat }, pending, rng);
    const result = game.submit({ kind: 'command', seat: pending.seat, command });
    if (!result.ok) throw new Error(result.error.message);
  }
  expect(game.state.result).not.toBeNull();
  const reveals = game.log.filter(
    (input) => input.kind === 'system' && input.type === 'FOG_REVEALED',
  );
  expect(reveals.length).toBeGreaterThan(0);
}, 120_000);

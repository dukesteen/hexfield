import { describe, expect, test } from 'vitest';
import { BotHost } from '@cp2p/bots';
import { LocalGame, engineForConfig } from '@cp2p/engine';
import type { Pending } from '@cp2p/engine';
import { gameConfig } from './run-game.js';
import { createLocalRandomSource, deriveSeed } from './random-source.js';

type PlayerPending = Extract<Pending, { kind: 'player' }>;

/**
 * A bot in a worker receives a structured-clone copy of the state with every request, so nothing
 * it remembers may hang on object identity (a bot that did re-offered the same trade forever).
 */
describe('bots behind a worker boundary', () => {
  test.each(['random', 'easy', 'normal', 'hard'] as const)(
    'a hosted %s bot fed fresh copies of the state finishes a game',
    (level) => {
      const config = gameConfig(4, {});
      const engine = engineForConfig(config);
      const created = LocalGame.create(
        engine,
        config,
        deriveSeed(9, 0, 'genesis'),
        createLocalRandomSource(deriveSeed(9, 0, 'system')),
      );
      if (!created.ok) throw new Error(created.error.message);
      const game = created.value;
      const host = new BotHost();
      for (let step = 0; step < 4000 && !game.state.result; step++) {
        const pending = game
          .getPending()
          .find(
            (item): item is PlayerPending =>
              item.kind === 'player' && item.allowed.some((type) => type !== 'CLAIM_VICTORY'),
          );
        const priv = pending && game.privateView(pending.seat);
        if (!pending || !priv) throw new Error('No player pending');
        const response = host.handle(
          structuredClone({
            kind: 'decide',
            id: step,
            bot: `seat-${pending.seat}`,
            level,
            seed: deriveSeed(9, 0, 'bot', pending.seat),
            view: { state: game.state, priv, seat: pending.seat },
            pending,
            hosted: true,
            iterationBudget: 2,
          }),
        );
        if (response.kind !== 'decision') throw new Error(JSON.stringify(response));
        const next = game.submit({
          kind: 'command',
          seat: pending.seat,
          command: response.command,
        });
        if (!next.ok) throw new Error(next.error.message);
      }
      expect(game.state.result).not.toBeNull();
    },
    60_000,
  );
});

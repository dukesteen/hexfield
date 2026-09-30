import { BotClient, BotHost, workerPort } from '@cp2p/bots';
import type { DecideArgs, Decision } from '@cp2p/bots';
import type { Engine, Seat } from '@cp2p/engine';
import { randomSeed } from './random.js';
import type { Entropy } from './random.js';

/** Runs a bot host's bots: in a dedicated Web Worker in the browser, inline where there is none. */
export interface BotRunner {
  decide(args: DecideArgs): Decision | Promise<Decision>;
  dispose(): void;
}

/** Bots on the calling thread, answering at once (tests, and environments without workers). */
export function inlineBotRunner(engine?: Engine): BotRunner {
  const host = new BotHost(engine);
  let next = 1;
  return {
    decide(args) {
      const response = host.handle({
        kind: 'decide',
        id: next++,
        bot: args.bot,
        level: args.level,
        seed: args.seed,
        view: { state: args.state, priv: args.priv, seat: args.seat },
        pending: args.pending,
        ...(args.timeBudgetMs === undefined ? {} : { timeBudgetMs: args.timeBudgetMs }),
        ...(args.hosted ? { hosted: true } : {}),
      });
      if (response.kind !== 'decision')
        throw new Error(response.kind === 'error' ? response.message : 'Bot gave no decision');
      return {
        command: response.command,
        warnings: response.warnings,
        elapsedMs: response.elapsedMs,
      };
    },
    dispose() {},
  };
}

/** Bots in one dedicated worker; the page posts each of them only its own view. */
export function workerBotRunner(): BotRunner {
  const worker = new Worker(new URL('./bot-worker.ts', import.meta.url), { type: 'module' });
  const client = new BotClient(workerPort(worker));
  return {
    decide: (args) => client.decide(args),
    dispose: () => client.close(),
  };
}

/** A worker when the environment has one, else inline. */
export function defaultBotRunner(engine?: Engine): BotRunner {
  return typeof Worker === 'undefined' ? inlineBotRunner(engine) : workerBotRunner();
}

/** A Hard bot's thinking time per decision: 300 ms on a desktop, 150 ms on a phone or tablet. */
export function hardBudgetMs(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): number {
  return /Mobi|Android|iPhone|iPad/i.test(userAgent) ? 150 : 300;
}

/**
 * A hosted bot's RNG seed. Seats hosted when the game opened derive theirs from
 * the seat master; a bot a takeover activated later gets a fresh local seed,
 * kept for the rest of the session. The seed only drives the bot's choices,
 * which peers still validate.
 */
export function hostedBotSeed(
  seeds: Map<Seat, Uint8Array>,
  seat: Seat,
  entropy: Entropy,
): Uint8Array {
  const known = seeds.get(seat);
  if (known) return known;
  const seed = randomSeed(entropy);
  seeds.set(seat, seed);
  return seed;
}

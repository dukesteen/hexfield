import type { Engine } from '@cp2p/engine';
import { decideHosted } from '../hosted.js';
import { createBot } from '../levels.js';
import { createBotRng } from '../random-bot.js';
import type { Bot, BotLevel, BotRng } from '../types.js';
import { parseBotRequest } from './messages.js';
import type { BotResponse } from './messages.js';

interface Hosted {
  level: BotLevel;
  bot: Bot;
  rng: BotRng;
}

/** Monotonic milliseconds where available (workers and Node both have `performance`). */
function now(): number {
  return typeof performance === 'undefined' ? 0 : performance.now();
}

/**
 * The bot side of the worker boundary: one host runs every bot of one bot host (for example all
 * the bots a browser tab hosts), keyed by `bot`. Each bot keeps its own RNG, seeded once from the
 * request that first names it, so its play is reproducible.
 */
export class BotHost {
  private readonly bots = new Map<string, Hosted>();

  constructor(private readonly engine?: Engine) {}

  private hosted(key: string, level: BotLevel, seed: Uint8Array): Hosted {
    const known = this.bots.get(key);
    if (known && known.level === level) return known;
    const hosted = {
      level,
      bot: createBot(level, this.engine),
      rng: known?.rng ?? createBotRng(seed),
    };
    this.bots.set(key, hosted);
    return hosted;
  }

  /** Answer one request. Malformed requests and bot failures become error responses. */
  handle(message: unknown): BotResponse {
    const id =
      typeof message === 'object' &&
      message !== null &&
      'id' in message &&
      typeof message.id === 'number'
        ? message.id
        : -1;
    try {
      const request = parseBotRequest(message);
      if (request.kind === 'dispose') {
        this.bots.delete(request.bot);
        return { kind: 'disposed', id: request.id };
      }
      const { bot, rng } = this.hosted(request.bot, request.level, request.seed);
      if (request.kind === 'respondTrade') {
        const { view, offer } = request;
        const accept = bot.wantsTrade
          ? bot.wantsTrade(view, offer.give, offer.want, offer.proposer)
          : (bot.respondToTrade?.(view, offer, rng) ?? false);
        return { kind: 'tradeResponse', id: request.id, accept };
      }
      const warnings: string[] = [];
      const context = {
        ...(request.legal ? { legal: request.legal } : {}),
        ...(request.timeBudgetMs === undefined ? {} : { timeBudgetMs: request.timeBudgetMs }),
        ...(request.iterationBudget === undefined
          ? {}
          : { iterationBudget: request.iterationBudget }),
        warn: (warning: string) => warnings.push(warning),
      };
      const started = now();
      const command = request.hosted
        ? decideHosted(bot, request.view, request.pending, rng, this.engine, context)
        : bot.decide(request.view, request.pending, rng, context);
      return { kind: 'decision', id: request.id, command, warnings, elapsedMs: now() - started };
    } catch (error) {
      return { kind: 'error', id, message: error instanceof Error ? error.message : String(error) };
    }
  }
}

import type { CommandShape, Pending, TradeOffer } from '@cp2p/engine';
import type { BotLevel, BotView } from '../types.js';
import { isBotLevel } from '../types.js';
import { assertBotView } from '../view.js';

export type PlayerPending = Extract<Pending, { kind: 'player' }>;

/** Fields every request about one bot carries. */
interface BotAddress {
  id: number;
  /** The bot's key within its host (one host multiplexes several bots, for example by seat). */
  bot: string;
  level: BotLevel;
  /** 32 bytes seeding the bot's RNG the first time the host sees this bot. */
  seed: Uint8Array;
}

/** `decide({ view, pending, legal, timeBudgetMs })`: the bot's next command. */
export interface DecideRequest extends BotAddress {
  kind: 'decide';
  view: BotView;
  pending: PlayerPending;
  legal?: CommandShape[];
  timeBudgetMs?: number;
  iterationBudget?: number;
  /** Settle open trades first, as a bot hosted beside people does (see `decideHosted`). */
  hosted?: boolean;
}

/** `respondTrade(...)`: whether the bot takes an offer made to it. */
export interface RespondTradeRequest extends BotAddress {
  kind: 'respondTrade';
  view: BotView;
  offer: TradeOffer;
}

export interface DisposeRequest {
  kind: 'dispose';
  id: number;
  bot: string;
}

export type BotRequest = DecideRequest | RespondTradeRequest | DisposeRequest;

export type BotResponse =
  | { kind: 'decision'; id: number; command: CommandShape; warnings: string[]; elapsedMs: number }
  | { kind: 'tradeResponse'; id: number; accept: boolean }
  | { kind: 'disposed'; id: number }
  | { kind: 'error'; id: number; message: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of required) if (!(key in value)) throw new TypeError(`Bot request lacks ${key}`);
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.includes(key))
      throw new TypeError(`Bot request has an unexpected field ${key}`);
}

function address(value: Record<string, unknown>): void {
  if (typeof value.id !== 'number' || typeof value.bot !== 'string')
    throw new TypeError('Bot request needs an id and a bot key');
  if (!isBotLevel(value.level)) throw new TypeError('Bot request names an unknown level');
  if (!(value.seed instanceof Uint8Array) || value.seed.length !== 32)
    throw new TypeError('Bot seed must be 32 bytes');
}

/**
 * Check a message that crossed the worker boundary. Unknown fields are refused, and the view must
 * be exactly a bot view (see `assertBotView`), so no other seat's secrets can ride along.
 */
export function parseBotRequest(value: unknown): BotRequest {
  if (!record(value)) throw new TypeError('Bot request must be an object');
  switch (value.kind) {
    case 'decide': {
      onlyKeys(
        value,
        ['kind', 'id', 'bot', 'level', 'seed', 'view', 'pending'],
        ['legal', 'timeBudgetMs', 'iterationBudget', 'hosted'],
      );
      address(value);
      assertBotView(value.view);
      const pending = value.pending;
      if (
        !record(pending) ||
        pending.kind !== 'player' ||
        pending.seat !== value.view.seat ||
        !Array.isArray(pending.allowed)
      )
        throw new TypeError('A bot decides only its own player request');
      // Checked field by field above; the envelope now has the request's shape.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return value as unknown as DecideRequest;
    }
    case 'respondTrade': {
      onlyKeys(value, ['kind', 'id', 'bot', 'level', 'seed', 'view', 'offer']);
      address(value);
      assertBotView(value.view);
      if (!record(value.offer) || typeof value.offer.id !== 'number')
        throw new TypeError('A trade response needs an offer');
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return value as unknown as RespondTradeRequest;
    }
    case 'dispose':
      onlyKeys(value, ['kind', 'id', 'bot']);
      if (typeof value.id !== 'number' || typeof value.bot !== 'string')
        throw new TypeError('Dispose needs an id and a bot key');
      return { kind: 'dispose', id: value.id, bot: value.bot };
    default:
      throw new TypeError('Unknown bot request');
  }
}

import type { GameState, PrivateState, Seat } from '@cp2p/engine';
import type { BotView } from './types.js';

const VIEW_KEYS = ['priv', 'seat', 'state'];
const PRIVATE_KEYS = ['ext', 'hand', 'seat', 'slots'];
const STATE_KEYS = [
  'awards',
  'bank',
  'board',
  'config',
  'counters',
  'decks',
  'engineVersion',
  'ext',
  'result',
  'schema',
  'seats',
  'turn',
];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], what: string): void {
  const own = Object.keys(value).toSorted();
  if (own.length !== keys.length || own.some((key, index) => key !== keys[index]))
    throw new TypeError(`A bot view's ${what} has fields [${own.join(', ')}]`);
}

/**
 * Check that a value is exactly a bot view: the public state, one private state, and the seat that
 * private state belongs to. Anything else, such as another seat's hand, is rejected, so a host can
 * run this on every message it hands to a bot.
 */
export function assertBotView(value: unknown): asserts value is BotView {
  if (!record(value)) throw new TypeError('A bot view must be an object');
  exactKeys(value, VIEW_KEYS, 'envelope');
  const { state, priv, seat } = value;
  if (!record(state) || !record(priv)) throw new TypeError('A bot view needs state and priv');
  exactKeys(state, STATE_KEYS, 'state');
  exactKeys(priv, PRIVATE_KEYS, 'private state');
  if (typeof seat !== 'number' || priv.seat !== seat)
    throw new TypeError('A bot view holds only its own seat');
}

/** The only way the hosts build a view: exactly these three fields, nothing copied by spreading. */
export function createBotView(state: GameState, priv: PrivateState, seat: Seat): BotView {
  if (priv.seat !== seat) throw new TypeError('A bot view holds only its own seat');
  const view: BotView = { state, priv, seat };
  assertBotView(view);
  return view;
}

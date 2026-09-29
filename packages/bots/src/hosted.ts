import { engineForConfig } from '@cp2p/engine';
import type { CommandShape, Engine, Pending, TradeOffer } from '@cp2p/engine';
import { buildTarget } from './random-bot.js';
import type { Bot, BotRng, BotView } from './types.js';

type Counts = Readonly<Record<string, number>>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function openOffers(view: BotView): TradeOffer[] {
  const base = view.state.ext.base;
  const offers = record(base) ? base.offers : undefined;
  // The engine owns this shape; the reader only skips what it cannot use.
  return Array.isArray(offers)
    ? offers.filter((offer): offer is TradeOffer => record(offer) && typeof offer.id === 'number')
    : [];
}

function total(counts: Counts): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

/**
 * Whether a bot takes `gets` for `gives`: it must hold the cards and keep what its next build
 * needs, and then takes any trade that brings a card that build lacks or costs it no cards, so a
 * fair swap of its spare cards goes through.
 */
export function wantsTrade(view: BotView, gets: Counts, gives: Counts): boolean {
  const hand = view.priv.hand;
  if (Object.entries(gives).some(([kind, count]) => (hand[kind] ?? 0) < count)) return false;
  const goal: Counts = buildTarget(view) ?? {};
  const keepsGoal = Object.entries(gives).every(
    ([kind, count]) => count === 0 || (hand[kind] ?? 0) - count >= (goal[kind] ?? 0),
  );
  const helps = Object.entries(gets).some(
    ([kind, count]) => count > 0 && (hand[kind] ?? 0) < (goal[kind] ?? 0),
  );
  return keepsGoal && (helps || total(gets) >= total(gives));
}

function valid(engine: Engine, view: BotView, command: CommandShape): boolean {
  return engine.validate(view.state, { kind: 'command', seat: view.seat, command }).ok;
}

/**
 * Trade manners for a bot that plays beside people: it answers offers on its merits, and on its
 * own turn it settles every open offer before doing anything else. Its own offer goes to the first
 * seat that accepted and can pay, or is withdrawn; a counter-offer made to it is taken or turned
 * down. The scheduler only asks while replies are still owed once its patience has run out, so an
 * offer never hangs. Null when no trade needs settling.
 */
export function hostedTradeCommand(
  view: BotView,
  pending: Pending,
  engine: Engine = engineForConfig(view.state.config),
): CommandShape | null {
  if (pending.kind !== 'player' || pending.seat !== view.seat) return null;
  const offers = openOffers(view);
  const active = view.state.turn.activeSeat === view.seat;
  if (!active) {
    if (!pending.allowed.includes('RESPOND_TRADE')) return null;
    const offer = offers.find(
      (item) =>
        item.proposer === view.state.turn.activeSeat &&
        item.to.includes(view.seat) &&
        !item.acceptedBy.includes(view.seat) &&
        !item.declinedBy.includes(view.seat),
    );
    if (!offer) return null;
    const command = {
      type: 'RESPOND_TRADE',
      offerId: offer.id,
      accept: wantsTrade(view, offer.give, offer.want),
    };
    return valid(engine, view, command) ? command : null;
  }
  for (const offer of offers) {
    const own = offer.proposer === view.seat;
    if (!own && !offer.to.includes(view.seat)) continue;
    const partners = own ? offer.acceptedBy : [offer.proposer];
    const takes = own || wantsTrade(view, offer.give, offer.want);
    if (takes && pending.allowed.includes('CONFIRM_TRADE'))
      for (const withSeat of partners) {
        const confirm = { type: 'CONFIRM_TRADE', offerId: offer.id, withSeat };
        if (valid(engine, view, confirm)) return confirm;
      }
    const cancel = { type: 'CANCEL_TRADE', offerId: offer.id };
    if (pending.allowed.includes('CANCEL_TRADE') && valid(engine, view, cancel)) return cancel;
  }
  return null;
}

/** A hosted bot's move: settle trades first (see `hostedTradeCommand`), else its own policy. */
export function decideHosted(
  bot: Bot,
  view: BotView,
  pending: Pending,
  rng: BotRng,
  engine?: Engine,
): CommandShape {
  return hostedTradeCommand(view, pending, engine) ?? bot.decide(view, pending, rng);
}

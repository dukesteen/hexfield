import type { CommandShape, Seat } from '@cp2p/engine';
import { openOffers } from '../offers.js';
import {
  acceptsTrade,
  chooseDiscard,
  pips,
  resourceHand,
  robberHexScore,
  shortfall,
  stealScore,
} from '../eval/index.js';
import type { TurnContext } from './context.js';
import { best } from './setup.js';

/** A discard (or any "give up N cards" choice) that keeps the goal's cards. */
export function discard(context: TurnContext, type = 'DISCARD'): CommandShape | null {
  const template = context.templates.find((item) => item.type === type);
  const count = template?.count;
  if (typeof count !== 'number') return null;
  const cards = chooseDiscard(context.view.priv.hand, count, context.handContext());
  const command = { type, cards };
  return context.valid(command) ? command : null;
}

function opponentPips(context: TurnContext, hex: string): number {
  const { state, seat } = context.view;
  const token = state.board.hexes.find((item) => item.id === hex)?.token;
  const index = context.info.graph.hexIndex[hex];
  const vertices = new Set<string>(
    index === undefined ? [] : (context.info.graph.hexVertices[index] ?? []),
  );
  let sum = 0;
  for (const building of state.board.buildings) {
    if (!vertices.has(building.vertex)) continue;
    const amount = pips(token) * (building.kind === 'settlement' ? 1 : 2);
    sum += building.seat === seat ? -3 * amount : amount;
  }
  return sum;
}

/** Where to move the robber (or any piece that blocks a hex, by the same scoring). */
export function robberHex(context: TurnContext, type = 'MOVE_ROBBER'): CommandShape | null {
  const { state, seat } = context.view;
  const options = context.ofType(type);
  return best(
    options,
    (command) => {
      const hex = String(command.hex);
      return context.config.robber === 'simple'
        ? opponentPips(context, hex)
        : robberHexScore(state, seat, hex, context.target);
    },
    context,
  );
}

/** Whom to rob: the leader or the richest hand (easy: simply the richest hand). */
export function stealVictim(context: TurnContext, type = 'STEAL'): CommandShape | null {
  const { state, seat } = context.view;
  const options = context.ofType(type);
  return best(
    options,
    (command) => {
      const victim = state.seats.find((item) => item.seat === command.victim);
      if (!victim) return -1;
      if (context.config.robber === 'simple') return victim.resources.total;
      return stealScore(state, seat, victim.seat, context.target);
    },
    context,
  );
}

function total(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

/**
 * Whether the bot takes `gets` for `gives` with `partner`. Easy takes a trade that brings a card its
 * goal lacks without costing one it needs, or that nets it cards; Normal and Hard require the trade
 * to shorten the goal enough, and much more from a partner close to winning.
 */
export function wantsTradeWith(
  context: TurnContext,
  gets: Readonly<Record<string, number>>,
  gives: Readonly<Record<string, number>>,
  partner: Seat,
): boolean {
  const { state, priv } = context.view;
  const hand = priv.hand;
  if (Object.entries(gives).some(([kind, count]) => (hand[kind] ?? 0) < count)) return false;
  if (context.config.id === 'easy') {
    const cost = context.goal()?.cost;
    if (!cost) return false;
    const before = shortfall(resourceHand(hand), cost);
    const after: Record<string, number> = { ...hand };
    for (const [kind, count] of Object.entries(gives)) after[kind] = (after[kind] ?? 0) - count;
    for (const [kind, count] of Object.entries(gets)) after[kind] = (after[kind] ?? 0) + count;
    const closer = shortfall(resourceHand(after), cost) < before;
    return closer && total(gets) >= total(gives);
  }
  return acceptsTrade(
    state,
    hand,
    gets,
    gives,
    partner,
    context.target,
    context.handContext(),
    context.config.trade,
  );
}

/** Reply to an open offer made to this seat. */
export function respondToOffer(context: TurnContext): CommandShape | null {
  const { state } = context.view;
  const replies = context.ofType('RESPOND_TRADE');
  if (!replies.length) return null;
  const offerId = replies[0]?.offerId;
  const offer = openOffers(state).find((item) => item.id === offerId);
  const accept = offer ? wantsTradeWith(context, offer.give, offer.want, offer.proposer) : false;
  return (
    replies.find((command) => command.offerId === offerId && command.accept === accept) ??
    replies.find((command) => command.offerId === offerId && command.accept === false) ??
    null
  );
}

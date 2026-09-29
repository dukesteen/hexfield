import type { CommandShape, GameState, Seat } from '@cp2p/engine';
import {
  COMMODITIES,
  RESOURCES,
  baseLongestRoadLength,
  isBaseResource,
  knightsExt,
  knightsOf,
} from '@cp2p/engine';
import {
  expectedHand,
  handBelief,
  openSites,
  pips,
  rawPips,
  resourceHand,
  shortfall,
  spareCosts,
} from '../../eval/index.js';
import type { TurnContext } from '../../policy/context.js';
import { publicVp } from '../../policy/context.js';
import { best, settlementValue } from '../../policy/setup.js';
import { commodityWorth } from './improvements.js';
import {
  attackChance,
  cardCount,
  handTotal,
  idleStrength,
  paramOf,
  progressHeld,
  threatOf,
} from './shared.js';

/**
 * What keeping a card is worth, in resource cards: a play must beat it. The same values choose
 * what to discard over the limit.
 */
const HOLD: Readonly<Record<string, number>> = {
  alchemist: 2.5,
  crane: 2,
  engineer: 0.5,
  inventor: 2,
  irrigation: 3,
  mining: 3,
  medicine: 2.5,
  roadBuilding: 2,
  smith: 2,
  commercialHarbor: 1.5,
  masterMerchant: 2.5,
  merchant: 3,
  merchantFleet: 1.5,
  resourceMonopoly: 3,
  tradeMonopoly: 2,
  bishop: 2,
  deserter: 2,
  diplomat: 2,
  intrigue: 1.5,
  saboteur: 2.5,
  spy: 2,
  warlord: 2,
  wedding: 2.5,
};

/** Cards played with a purchase (Crane, Medicine) or before the roll are handled elsewhere. */
const ELSEWHERE = new Set(['crane', 'medicine', 'alchemist']);

/** Roughly what one victory point is worth in cards. */
const VP = 6;

export function holdValue(card: string): number {
  return HOLD[card] ?? 1;
}

/** One card's worth to the bot: a resource about 1, a commodity by its track plans. */
export function cardWorth(context: TurnContext, kind: string): number {
  if (COMMODITIES.includes(kind)) return commodityWorth(context, kind);
  const goal = context.goal();
  const hand = context.view.priv.hand;
  if (goal && isBaseResource(kind) && goal.cost[kind] > (hand[kind] ?? 0)) return 1.2;
  return 0.9;
}

function target(context: TurnContext, command: CommandShape): Seat {
  const value = paramOf(command, 'target');
  return context.view.state.config.seats.find((seat) => seat === value) ?? context.view.seat;
}

/** Cards a seat's hand is expected to hold of one kind, from its public bounds. */
function expectedOf(state: GameState, seat: Seat, kind: string): number {
  return expectedHand(handBelief(state, seat))[kind] ?? 0;
}

function completesGoal(context: TurnContext, extra: Readonly<Record<string, number>>): boolean {
  const goal = context.goal();
  if (!goal) return false;
  const hand = { ...context.view.priv.hand };
  for (const [kind, count] of Object.entries(extra)) hand[kind] = (hand[kind] ?? 0) + count;
  const before = shortfall(resourceHand(context.view.priv.hand), goal.cost);
  return before > 0 && shortfall(resourceHand(hand), goal.cost) === 0;
}

function harvest(context: TurnContext, terrain: string, kind: string): number {
  const { state, seat } = context.view;
  const own = new Set(
    state.board.buildings.filter((piece) => piece.seat === seat).map((piece) => piece.vertex),
  );
  let hexes = 0;
  for (const hex of state.board.hexes) {
    if (hex.terrain !== terrain) continue;
    const index = context.info.graph.hexIndex[hex.id];
    const vertices = index === undefined ? [] : (context.info.graph.hexVertices[index] ?? []);
    if (vertices.some((vertex) => own.has(vertex))) hexes++;
  }
  const count = Math.min(2 * hexes, state.bank[kind] ?? 0);
  // One matching hex (two cards) is kept for later unless it completes the goal now.
  const bonus = completesGoal(context, { [kind]: count }) ? 1.5 : 0;
  return count * cardWorth(context, kind) + bonus - (hexes < 2 ? 1.5 : 0);
}

/** Production pips a hex gives each seat (a city counts twice). */
function hexShares(context: TurnContext, hex: string): Map<Seat, number> {
  const { state } = context.view;
  const index = context.info.graph.hexIndex[hex];
  const vertices = new Set<string>(
    index === undefined ? [] : (context.info.graph.hexVertices[index] ?? []),
  );
  const shares = new Map<Seat, number>();
  for (const piece of state.board.buildings)
    if (vertices.has(piece.vertex))
      shares.set(piece.seat, (shares.get(piece.seat) ?? 0) + (piece.kind === 'city' ? 2 : 1));
  return shares;
}

/** Inventor: my production gained minus the threat-weighted production opponents gain. */
function inventor(context: TurnContext, command: CommandShape): number {
  const { state, seat } = context.view;
  const hexes = paramOf(command, 'hexes');
  if (!Array.isArray(hexes)) return -Infinity;
  const [a, b] = hexes.map(String);
  if (a === undefined || b === undefined) return -Infinity;
  const token = (id: string): number | null =>
    state.board.hexes.find((hex) => hex.id === id)?.token ?? null;
  const delta = pips(token(b)) - pips(token(a));
  let value = 0;
  for (const [hex, change] of [
    [a, delta],
    [b, -delta],
  ] as const) {
    if (hex === state.board.robberHex) continue;
    for (const [owner, weight] of hexShares(context, hex))
      value += owner === seat ? weight * change : -0.5 * threatOf(context, owner) * weight * change;
  }
  // A pip is about one card over the rest of a game.
  return value * 0.9;
}

/** Bishop: a card from each victim, the leader's production blocked, the robber off my own hex. */
function bishop(context: TurnContext, command: CommandShape): number {
  const { state, seat } = context.view;
  const hex = String(paramOf(command, 'hex'));
  const token = state.board.hexes.find((item) => item.id === hex)?.token;
  let value = 0;
  for (const [owner, weight] of hexShares(context, hex)) {
    if (owner === seat) value -= weight * pips(token) * 0.35;
    else {
      if (handTotal(state, owner) > 0) value += 1;
      value += weight * pips(token) * 0.12 * threatOf(context, owner);
    }
  }
  const current = state.board.robberHex;
  if (current) {
    const mine = hexShares(context, current).get(seat) ?? 0;
    const currentToken = state.board.hexes.find((item) => item.id === current)?.token;
    value += mine * pips(currentToken) * 0.35;
  }
  return value;
}

/** Diplomat: take the Longest Road from its holder (or open a road of mine to rebuild it). */
function diplomat(context: TurnContext, command: CommandShape): number {
  const { state, seat } = context.view;
  const edge = String(paramOf(command, 'edge'));
  const road = state.board.roads.find((item) => item.edge === edge);
  if (!road || road.seat === seat) return -Infinity;
  const holder = state.awards.longestRoad;
  const after = {
    ...state,
    board: { ...state.board, roads: state.board.roads.filter((item) => item.edge !== edge) },
  };
  if (holder === null || holder === undefined || holder !== road.seat) return 0.2;
  const before = baseLongestRoadLength(state, holder);
  const cut = baseLongestRoadLength(after, holder);
  const rival = Math.max(
    4,
    ...state.seats
      .filter((item) => item.seat !== holder)
      .map((item) => baseLongestRoadLength(state, item.seat)),
  );
  if (cut >= before) return 0.2;
  // The holder keeps the award while no other road is longer.
  const loses = cut < rival || cut < 5;
  const mine = baseLongestRoadLength(state, seat);
  const gain = loses
    ? 2 * VP * 0.5 * threatOf(context, holder) + (mine > cut && mine >= 5 ? 2 * VP : 0)
    : 0.5;
  return gain;
}

/** Deserter: the victim loses its weakest knight; a knight of mine may take its place. */
function deserter(context: TurnContext, command: CommandShape): number {
  const { state, seat } = context.view;
  const victim = target(context, command);
  const theirs = knightsOf(state, victim);
  if (!theirs.length) return -Infinity;
  const weakest = Math.min(...theirs.map((knight) => knight.level));
  const mine = knightsOf(state, seat);
  const supply = [1, 2, 3].some(
    (level) => level <= weakest && mine.filter((knight) => knight.level === level).length < 2,
  );
  const urgency = 1 + attackChance(state);
  return (
    weakest * 0.8 * threatOf(context, victim) * urgency + (supply ? weakest * 1.2 * urgency : 0)
  );
}

/** Intrigue: push an opposing knight off a site or road end the bot wants. */
function intrigue(context: TurnContext, command: CommandShape): number {
  const vertex = String(paramOf(command, 'vertex'));
  const open = openSites(context.view.state, context.info);
  const owner = knightsExt(context.view.state).knights.find(
    (knight) => knight.vertex === vertex,
  )?.seat;
  const blocking = open.has(vertex) ? settlementValue(context, vertex, open) * 0.15 : 0.5;
  return blocking + (owner === undefined ? 0 : 0.3 * threatOf(context, owner));
}

/** Saboteur: half of every hand at least as rich in points as the bot's, weighted by threat. */
function saboteur(context: TurnContext): number {
  const { state, seat } = context.view;
  const mine = publicVp(state, seat);
  let value = 0;
  for (const holder of state.seats) {
    if (holder.seat === seat || publicVp(state, holder.seat) < mine) continue;
    value += Math.floor(handTotal(state, holder.seat) / 2) * 0.6 * threatOf(context, holder.seat);
  }
  return value;
}

/** Wedding: two cards from every seat with more points. */
function wedding(context: TurnContext): number {
  const { state, seat } = context.view;
  const mine = publicVp(state, seat);
  let value = 0;
  for (const holder of state.seats)
    if (holder.seat !== seat && publicVp(state, holder.seat) > mine)
      value += Math.min(2, handTotal(state, holder.seat)) * 1.1;
  return value;
}

function monopoly(context: TurnContext, command: CommandShape, limit: number): number {
  const { state, seat } = context.view;
  const kind = String(paramOf(command, 'kind'));
  let take = 0;
  for (const holder of state.seats)
    if (holder.seat !== seat) take += Math.min(limit, expectedOf(state, holder.seat, kind));
  return (
    take * cardWorth(context, kind) + (completesGoal(context, { [kind]: Math.floor(take) }) ? 1 : 0)
  );
}

/** Merchant Fleet: 2:1 trades of the kind the bot holds most beyond its goal. */
function merchantFleet(context: TurnContext, command: CommandShape): number {
  const kind = String(paramOf(command, 'kind'));
  const hand = context.view.priv.hand;
  const goal = context.goal();
  const need = goal && isBaseResource(kind) ? goal.cost[kind] : 0;
  const spare = (hand[kind] ?? 0) - need - (COMMODITIES.includes(kind) ? 3 : 0);
  if (spare < 2) return -Infinity;
  const rate = isBaseResource(kind) ? context.handContext().rates[kind] : 4;
  return Math.floor(spare / 2) * (rate - 2) * 0.35;
}

/** Commercial Harbor: a spare resource for a commodity from each seat that may hold one. */
function commercialHarbor(context: TurnContext): number {
  const { state, seat } = context.view;
  const costs = spareCosts(context.view.priv.hand, context.handContext());
  const spare = Math.min(...RESOURCES.map((resource) => costs[resource]));
  if (!Number.isFinite(spare)) return -Infinity;
  let seats = 0;
  for (const holder of state.seats) {
    if (holder.seat === seat) continue;
    if (COMMODITIES.some((kind) => expectedOf(state, holder.seat, kind) >= 0.5)) seats++;
  }
  return seats * 0.6;
}

/** Master Merchant or Spy: the richest target, the leader first. */
function steal(context: TurnContext, command: CommandShape, progress: boolean): number {
  const { state } = context.view;
  const victim = target(context, command);
  const count = progress ? progressHeld(state, victim) : handTotal(state, victim);
  if (progress) return count ? 1.6 + 0.3 * Math.min(count, 4) + 0.4 * threatOf(context, victim) : 0;
  return Math.min(2, count) * 1.3 + 0.3 * threatOf(context, victim);
}

/** Smith: free promotions, worth more before an attack. */
function smith(context: TurnContext, command: CommandShape): number {
  const vertices = paramOf(command, 'vertices');
  const count = Array.isArray(vertices) ? vertices.length : 0;
  return count * (1.1 + attackChance(context.view.state));
}

/** Warlord: every idle knight activated, worth most just before an attack. */
function warlord(context: TurnContext): number {
  const { state, seat } = context.view;
  const idle = knightsOf(state, seat).filter((knight) => !knight.active).length;
  const chance = attackChance(state);
  return idle * (0.8 + 2 * chance) + (idleStrength(state, seat) > 0 && chance > 0.5 ? 1 : 0);
}

function roadBuilding(context: TurnContext): number {
  const goal = context.goal();
  if (goal?.kind === 'settlement' && (goal.roads ?? 0) >= 1)
    return 2 + Math.min(2, goal.roads ?? 0);
  return 0.5;
}

/** A play's worth now, in cards; null for a card this policy leaves to another step. */
export function playValue(context: TurnContext, command: CommandShape): number | null {
  const card = String(command.card);
  if (ELSEWHERE.has(card)) return null;
  const { state, seat } = context.view;
  switch (card) {
    case 'printer':
    case 'constitution':
      return 100;
    case 'merchant': {
      const held = knightsExt(state).merchant;
      const hex = String(paramOf(command, 'hex'));
      const terrain = state.board.hexes.find((item) => item.id === hex);
      const trade = pips(terrain?.token) * 0.1;
      return held?.seat === seat ? trade - 1 : VP * 0.8 + trade;
    }
    case 'engineer':
      return 1 + rawPips(state, String(paramOf(command, 'vertex')), context.info) * 0.01;
    case 'irrigation':
      return harvest(context, 'fields', 'grain');
    case 'mining':
      return harvest(context, 'mountains', 'ore');
    case 'inventor':
      return inventor(context, command);
    case 'roadBuilding':
      return roadBuilding(context);
    case 'smith':
      return smith(context, command);
    case 'commercialHarbor':
      return commercialHarbor(context);
    case 'masterMerchant':
      return steal(context, command, false);
    case 'spy':
      return steal(context, command, true);
    case 'merchantFleet':
      return merchantFleet(context, command);
    case 'resourceMonopoly':
      return monopoly(context, command, 2);
    case 'tradeMonopoly':
      return monopoly(context, command, 1);
    case 'bishop':
      return bishop(context, command);
    case 'deserter':
      return deserter(context, command);
    case 'diplomat':
      return diplomat(context, command);
    case 'intrigue':
      return intrigue(context, command);
    case 'saboteur':
      return saboteur(context);
    case 'warlord':
      return warlord(context);
    case 'wedding':
      return wedding(context);
    default:
      return 0;
  }
}

/**
 * The action-phase card to play now, if any: the best play that beats keeping its card. Near the
 * four-card limit (a new draw would force a discard) any useful play goes.
 */
export function progressPlay(context: TurnContext): CommandShape | null {
  const plays = context.ofType('PLAY_PROGRESS_CARD');
  if (!plays.length) return null;
  const held = progressHeld(context.view.state, context.view.seat);
  const slack = held >= 4 ? 0.2 : held >= 3 ? 0.6 : 1;
  let top: { command: CommandShape; margin: number } | null = null;
  for (const command of plays) {
    const value = playValue(context, command);
    if (value === null || !Number.isFinite(value)) continue;
    const margin = value - holdValue(String(command.card)) * slack;
    if (margin > 0 && (!top || margin > top.margin)) top = { command, margin };
  }
  return top?.command ?? null;
}

/**
 * Over the limit at the end of a turn: play whatever still helps, then discard the cards least
 * worth keeping.
 */
function size(command: CommandShape): number {
  return Array.isArray(command.cards) ? command.cards.length : 0;
}

export function progressDiscard(context: TurnContext): CommandShape | null {
  const discards = context.ofType('DISCARD_PROGRESS');
  if (!discards.length) return null;
  const most = Math.max(...discards.map(size));
  return best(
    discards.filter((command) => size(command) === most),
    (command) =>
      -(Array.isArray(command.cards) ? command.cards : []).reduce(
        (sum: number, item: unknown) =>
          sum +
          holdValue(
            typeof item === 'object' && item !== null ? String(Reflect.get(item, 'card')) : '',
          ),
        0,
      ),
    context,
  );
}

/** A salvage play before discarding: any card with a positive effect. */
export function salvagePlay(context: TurnContext): CommandShape | null {
  return best(
    context.ofType('PLAY_PROGRESS_CARD').filter((command) => {
      const value = playValue(context, command);
      return value !== null && Number.isFinite(value) && value > 0;
    }),
    (command) => -holdValue(String(command.card)),
    context,
  );
}

function red(command: CommandShape): number {
  const dice = paramOf(command, 'dice');
  return Array.isArray(dice) ? Number(dice[0]) : 0;
}

/**
 * Alchemist, before the roll: the dice total that pays the bot most (never a 7), played when it
 * beats an ordinary roll by more than the card is worth kept. The red die is low when the bot's
 * improvements draw at least as well as anyone's.
 */
export function alchemist(context: TurnContext): CommandShape | null {
  const options = context
    .ofType('PLAY_PROGRESS_CARD')
    .filter((command) => command.card === 'alchemist');
  if (!options.length) return null;
  const { state, seat } = context.view;
  const payout = new Map<number, number>();
  let expected = 0;
  const terrains = new Map(state.board.hexes.map((hex) => [hex.id, hex]));
  for (const piece of state.board.buildings) {
    const index = context.info.graph.vertexIndex[piece.vertex];
    if (index === undefined) continue;
    for (const item of context.info.yields[index] ?? []) {
      if (item.hex === state.board.robberHex) continue;
      const token = terrains.get(item.hex)?.token;
      if (typeof token !== 'number') continue;
      const cards = piece.kind === 'city' ? 2 : 1;
      const worth = piece.seat === seat ? cards : -0.3 * cards * threatOf(context, piece.seat);
      payout.set(token, (payout.get(token) ?? 0) + worth);
      if (piece.seat === seat) expected += (cards * item.pips) / 36;
    }
  }
  let bestTotal = 0;
  let bestValue = -Infinity;
  for (const [total, value] of payout)
    if (total !== 7 && value > bestValue) {
      bestValue = value;
      bestTotal = total;
    }
  const held = progressHeld(state, seat);
  if (bestValue - expected < holdValue('alchemist') * (held >= 4 ? 0.2 : 1)) return null;
  const levels = knightsExt(state).improvements;
  const mine = Math.max(...Object.values(levels[seat] ?? {}).map(Number));
  const theirs = Math.max(
    0,
    ...levels.flatMap((item, other) => (other === seat ? [] : Object.values(item).map(Number))),
  );
  const matching = options.filter((command) => {
    const dice = paramOf(command, 'dice');
    return Array.isArray(dice) && Number(dice[0]) + Number(dice[1]) === bestTotal;
  });
  return best(matching, (command) => (mine >= theirs ? -red(command) : red(command)), context);
}

/** Commercial Harbor offers: the resource the bot misses least, to each seat it may reach. */
export function harborOffer(context: TurnContext): CommandShape | null {
  const offers = context.ofType('HARBOR_OFFER');
  if (!offers.length) return null;
  const costs = spareCosts(context.view.priv.hand, context.handContext());
  return best(
    offers,
    (command) => {
      const resource = String(command.resource);
      return isBaseResource(resource) ? -costs[resource] : -Infinity;
    },
    context,
  );
}

/** Answering a Commercial Harbor: give the commodity the bot values least. */
export function harborReply(context: TurnContext): CommandShape | null {
  const replies = context.ofType('HARBOR_REPLY');
  return best(
    replies,
    (command) =>
      command.commodity === 'none' ? -100 : -commodityWorth(context, String(command.commodity)),
    context,
  );
}

/** Cards in the bot's hand, for the hand-size checks. */
export function handSize(context: TurnContext): number {
  return cardCount(context.view.priv.hand);
}

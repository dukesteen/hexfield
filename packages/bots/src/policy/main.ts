import type { CommandShape, Resource } from '@cp2p/engine';
import { RESOURCES, baseLongestRoadLength } from '@cp2p/engine';
import {
  expectedHand,
  handBelief,
  handScore,
  openSites,
  resourceHand,
  shortfall,
  tradeGain,
  wantAndSpare,
} from '../eval/index.js';
import { openOffers } from '../offers.js';
import type { TurnContext } from './context.js';
import { wantsTradeWith } from './reactions.js';
import { best, edgeValue, settlementValue } from './setup.js';

/** What a bot remembers between its decisions within one game. */
export interface TurnMemory {
  turn: number;
  offers: number;
}

function knightsPlayed(context: TurnContext): readonly number[] {
  const base = context.view.state.ext.base;
  return typeof base === 'object' &&
    base !== null &&
    'knightsPlayed' in base &&
    Array.isArray(base.knightsPlayed)
    ? base.knightsPlayed.map(Number)
    : [];
}

function robberOnOwnHex(context: TurnContext): boolean {
  const { state, seat } = context.view;
  const hex = state.board.robberHex;
  if (!hex) return false;
  const index = context.info.graph.hexIndex[hex];
  const vertices = new Set<string>(
    index === undefined ? [] : (context.info.graph.hexVertices[index] ?? []),
  );
  const token = state.board.hexes.find((item) => item.id === hex)?.token;
  return (
    token !== null &&
    state.board.buildings.some((piece) => piece.seat === seat && vertices.has(piece.vertex))
  );
}

/** Play a knight before rolling when the robber sits on the bot's own production. */
export function knightBeforeRoll(context: TurnContext): CommandShape | null {
  const knight = context.ofType('PLAY_DEV_CARD').find((command) => command.card === 'knight');
  if (!knight) return null;
  if (robberOnOwnHex(context)) return knight;
  return context.config.devCardTactics && armyWorthIt(context) ? knight : null;
}

function eagerKnight(context: TurnContext, knight: CommandShape | undefined): boolean {
  return knight !== undefined && context.config.knights === 'eager';
}

/** A knight that takes or defends the largest army. */
function armyWorthIt(context: TurnContext): boolean {
  const played = knightsPlayed(context);
  const mine = played[context.view.seat] ?? 0;
  const others = Math.max(0, ...played.filter((_, seat) => seat !== context.view.seat));
  return mine + 1 >= 3 && mine + 1 > others && mine <= others;
}

function devCardPlay(context: TurnContext): CommandShape | null {
  const plays = context.ofType('PLAY_DEV_CARD');
  const knight = plays.find((command) => command.card === 'knight');
  if (
    knight &&
    (robberOnOwnHex(context) ||
      eagerKnight(context, knight) ||
      (context.config.devCardTactics && armyWorthIt(context)))
  )
    return knight;
  if (!context.config.devCardTactics) {
    // An easy bot plays what it holds as soon as it can, simply.
    const simple = plays.find((command) => command.card === 'roadBuilding') ?? knight;
    if (simple && context.rng.int(3) === 0) return simple;
    return yearOfPlenty(context, true);
  }
  const monopoly = bestMonopoly(context, plays);
  if (monopoly) return monopoly;
  const goal = context.goal();
  const roadBuilding = plays.find((command) => command.card === 'roadBuilding');
  if (roadBuilding && goal?.kind === 'settlement' && (goal.roads ?? 0) >= 1) return roadBuilding;
  return yearOfPlenty(context, false) ?? (knight && context.rng.int(4) === 0 ? knight : null);
}

function bestMonopoly(context: TurnContext, plays: readonly CommandShape[]): CommandShape | null {
  const { state, seat } = context.view;
  const monopolies = plays.filter((command) => command.card === 'monopoly');
  if (!monopolies.length) return null;
  const takes: Record<string, number> = {};
  for (const holder of state.seats) {
    if (holder.seat === seat) continue;
    const expected = expectedHand(handBelief(state, holder.seat));
    for (const [kind, count] of Object.entries(expected)) takes[kind] = (takes[kind] ?? 0) + count;
  }
  const hand = context.view.priv.hand;
  const handContext = context.handContext();
  const choice = best(
    monopolies,
    (command) => {
      const params = command.params;
      const resource =
        typeof params === 'object' && params !== null && 'resource' in params
          ? String(params.resource)
          : '';
      const take = Math.floor(takes[resource] ?? 0);
      return (
        handScore({ ...hand, [resource]: (hand[resource] ?? 0) + take }, handContext) + take * 0.1
      );
    },
    context,
  );
  if (!choice) return null;
  const params = choice.params;
  const resource =
    typeof params === 'object' && params !== null && 'resource' in params
      ? String(params.resource)
      : '';
  return (takes[resource] ?? 0) >= 3.5 ? choice : null;
}

function yearOfPlenty(context: TurnContext, anyTime: boolean): CommandShape | null {
  const template = context.templates.find(
    (item) => item.type === 'PLAY_DEV_CARD' && item.card === 'yearOfPlenty',
  );
  if (!template || typeof template.slotId !== 'string') return null;
  const hand = context.view.priv.hand;
  const handContext = context.handContext();
  let top: { resources: Record<Resource, number>; score: number } | null = null;
  for (let i = 0; i < RESOURCES.length; i++)
    for (let j = i; j < RESOURCES.length; j++) {
      const first = RESOURCES[i];
      const second = RESOURCES[j];
      if (first === undefined || second === undefined) continue;
      const resources = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
      resources[first]++;
      resources[second]++;
      const next = { ...hand };
      for (const resource of RESOURCES)
        next[resource] = (next[resource] ?? 0) + resources[resource];
      const score = handScore(next, handContext);
      if (!top || score > top.score) top = { resources, score };
    }
  if (!top) return null;
  const goal = context.goal();
  const completes =
    goal !== null &&
    shortfall(resourceHand({ ...hand, ...addTo(hand, top.resources) }), goal.cost) === 0;
  if (!anyTime && !completes) return null;
  const command = {
    type: 'PLAY_DEV_CARD',
    slotId: template.slotId,
    card: 'yearOfPlenty',
    params: { resources: top.resources },
  };
  return context.valid(command) ? command : null;
}

function addTo(
  hand: Readonly<Record<string, number>>,
  extra: Readonly<Record<string, number>>,
): Record<string, number> {
  const next = { ...hand };
  for (const [kind, count] of Object.entries(extra)) next[kind] = (next[kind] ?? 0) + count;
  return next;
}

/** Confirm or withdraw the bot's own offer, and answer counter-offers made to it. */
function settleOffers(context: TurnContext): CommandShape | null {
  const { state, seat } = context.view;
  for (const offer of openOffers(state)) {
    if (offer.proposer === seat) {
      for (const withSeat of offer.acceptedBy) {
        const confirm = { type: 'CONFIRM_TRADE', offerId: offer.id, withSeat };
        if (context.valid(confirm)) return confirm;
      }
      const waiting = offer.to.some(
        (other) => !offer.acceptedBy.includes(other) && !offer.declinedBy.includes(other),
      );
      if (!waiting || !offer.valid) {
        const cancel = { type: 'CANCEL_TRADE', offerId: offer.id };
        if (context.valid(cancel)) return cancel;
      }
      continue;
    }
    if (!offer.to.includes(seat)) continue;
    if (wantsTradeWith(context, offer.give, offer.want, offer.proposer)) {
      const confirm = { type: 'CONFIRM_TRADE', offerId: offer.id, withSeat: offer.proposer };
      if (context.valid(confirm)) return confirm;
    }
    const cancel = { type: 'CANCEL_TRADE', offerId: offer.id };
    if (context.valid(cancel)) return cancel;
  }
  return null;
}

function bankTrade(context: TurnContext): CommandShape | null {
  if (!context.types.has('MARITIME_TRADE')) return null;
  const { state } = context.view;
  const hand = context.view.priv.hand;
  const handContext = context.handContext();
  const goal = context.goal();
  let top: { command: CommandShape; gain: number } | null = null;
  for (const give of RESOURCES) {
    const rate = handContext.rates[give];
    if ((hand[give] ?? 0) < rate) continue;
    for (const get of RESOURCES) {
      if (get === give || (state.bank[get] ?? 0) < 1) continue;
      const gets = { [get]: 1 };
      const gives = { [give]: rate };
      const gain = tradeGain(hand, gets, gives, handContext);
      if (gain === null) continue;
      if (context.config.bankTrades === 'immediate') {
        if (
          !goal ||
          shortfall(resourceHand(addTo(addTo(hand, gets), { [give]: -rate })), goal.cost) > 0
        )
          continue;
      }
      if (!top || gain > top.gain)
        top = { command: { type: 'MARITIME_TRADE', give: gives, get: gets }, gain };
    }
  }
  return top && top.gain > 0.15 && context.valid(top.command) ? top.command : null;
}

function offerTrade(context: TurnContext, memory: TurnMemory): CommandShape | null {
  if (!context.config.offers || !context.types.has('OFFER_TRADE') || memory.offers >= 1)
    return null;
  if (openOffers(context.view.state).some((offer) => offer.proposer === context.view.seat))
    return null;
  const goal = context.goal();
  const hand = context.view.priv.hand;
  if (!goal || shortfall(resourceHand(hand), goal.cost) > 2) return null;
  const pair = wantAndSpare(hand, context.handContext());
  if (!pair || pair.wantValue <= pair.spareValue + 0.2) return null;
  const command = { type: 'OFFER_TRADE', give: { [pair.spare]: 1 }, want: { [pair.want]: 1 } };
  if (!context.valid(command)) return null;
  memory.offers++;
  return command;
}

/**
 * Builds in priority order: whatever the plan saves for, then any other victory point the hand
 * already pays for, then a road on the way to the planned settlement.
 */
function build(context: TurnContext): CommandShape | null {
  const goal = context.goal();
  const open = openSites(context.view.state, context.info);
  const settlement = best(
    context.ofType('BUILD_SETTLEMENT'),
    (command) => settlementValue(context, String(command.vertex), open),
    context,
  );
  const city = best(
    context.ofType('BUILD_CITY'),
    (command) => settlementValue(context, String(command.vertex), open),
    context,
  );
  const ordered = goal?.kind === 'settlement' ? [settlement, city] : [city, settlement];
  for (const command of ordered) if (command) return command;
  const hand = context.view.priv.hand;
  if (goal?.kind === 'settlement' && (goal.roads ?? 0) > 0) {
    const road = best(
      context.ofType('BUILD_ROAD').filter((command) => goal.firstEdges?.has(String(command.edge))),
      (command) => edgeValue(context, String(command.edge), open),
      context,
    );
    if (road) return road;
  }
  const dev = context.ofType('BUY_DEV_CARD')[0];
  if (dev) {
    if (goal?.kind === 'devCard') return dev;
    const after = addTo(hand, { wool: -1, grain: -1, ore: -1 });
    if (
      !goal ||
      shortfall(resourceHand(after), goal.cost) <=
        shortfall(resourceHand(hand), goal.cost) + context.config.devAppetite
    )
      return dev;
  }
  const longest = longestRoadMove(context);
  if (longest) return longest;
  // With no settlement in reach, a spare road still extends toward new land.
  if (!goal || goal.kind !== 'settlement') {
    const cards = Object.values(hand).reduce((sum, count) => sum + count, 0);
    if (cards >= 7) {
      const road = best(
        context.ofType('BUILD_ROAD'),
        (command) => edgeValue(context, String(command.edge), open),
        context,
      );
      if (road && edgeValue(context, String(road.edge), open) > 0) return road;
    }
  }
  return null;
}

/**
 * A road that lengthens the bot's longest road, when the award is in reach (its road is at least
 * four long and within one of the best other) and the road costs no card the goal needs.
 */
function longestRoadMove(context: TurnContext): CommandShape | null {
  if (!context.config.longestRoad) return null;
  const roads = context.ofType('BUILD_ROAD');
  if (!roads.length) return null;
  const { state, seat } = context.view;
  const goal = context.goal();
  const hand = context.view.priv.hand;
  if (
    goal &&
    shortfall(resourceHand(addTo(hand, { brick: -1, lumber: -1 })), goal.cost) >
      shortfall(resourceHand(hand), goal.cost)
  )
    return null;
  const mine = baseLongestRoadLength(state, seat);
  const others = Math.max(
    0,
    ...state.seats
      .filter((holder) => holder.seat !== seat)
      .map((holder) => baseLongestRoadLength(state, holder.seat)),
  );
  if (state.awards.longestRoad === seat && mine > others + 1) return null;
  if (mine + 2 < Math.max(5, others)) return null;
  const longer = (command: CommandShape): number => {
    const board = {
      ...state.board,
      roads: [...state.board.roads, { edge: String(command.edge), seat }],
    };
    return baseLongestRoadLength({ ...state, board }, seat);
  };
  const choice = best(roads, longer, context);
  return choice && longer(choice) > mine ? choice : null;
}

/**
 * Above seven cards at the end of a turn a seven would cost half the hand, so spend first: a
 * development card, a useful road, or the least harmful bank trade.
 */
function dumpHand(context: TurnContext): CommandShape | null {
  if (!context.config.dumpHand || !context.types.has('END_TURN')) return null;
  const hand = context.view.priv.hand;
  const cards = Object.values(hand).reduce((sum, count) => sum + count, 0);
  if (cards <= 7) return null;
  const dev = context.ofType('BUY_DEV_CARD')[0];
  if (dev) return dev;
  const open = openSites(context.view.state, context.info);
  const road = best(
    context.ofType('BUILD_ROAD'),
    (command) => edgeValue(context, String(command.edge), open),
    context,
  );
  if (road && edgeValue(context, String(road.edge), open) > 0) return road;
  const handContext = context.handContext();
  let top: { command: CommandShape; gain: number } | null = null;
  for (const give of RESOURCES) {
    const rate = handContext.rates[give];
    if ((hand[give] ?? 0) < rate) continue;
    for (const get of RESOURCES) {
      if (get === give || (context.view.state.bank[get] ?? 0) < 1) continue;
      const gain = tradeGain(hand, { [get]: 1 }, { [give]: rate }, handContext);
      if (gain !== null && (!top || gain > top.gain))
        top = {
          command: { type: 'MARITIME_TRADE', give: { [give]: rate }, get: { [get]: 1 } },
          gain,
        };
    }
  }
  return top && top.gain > -0.6 && context.valid(top.command) ? top.command : null;
}

/** The main phase (and a special build phase): settle trades, play a card, build, trade, end. */
export function mainTurn(
  context: TurnContext,
  memory: TurnMemory,
  extra: () => CommandShape | null,
): CommandShape | null {
  const claim = context.ofType('CLAIM_VICTORY')[0];
  if (claim) return claim;
  const settled = settleOffers(context);
  if (settled) return settled;
  const card = devCardPlay(context);
  if (card) return card;
  const built = build(context);
  if (built) return built;
  const module = extra();
  if (module) return module;
  const banked = bankTrade(context);
  if (banked) return banked;
  const offered = offerTrade(context, memory);
  if (offered) return offered;
  const dumped = dumpHand(context);
  if (dumped) return dumped;
  for (const type of ['END_TURN', 'END_SBP']) {
    const end = context.ofType(type)[0];
    if (end) return end;
  }
  return null;
}

import type { CommandHandler, PhaseHandler, SystemInputHandler } from '../../core/modules/index.js';
import { gainKnown, loseKnown, revealExact } from '../../core/resources/index.js';
import type { CardSlot, GameState, PrivateState } from '../../core/state/index.js';
import { RESOURCES, failure, success } from '../../core/types/index.js';
import type { Resource, ResourceCounts, Result, Seat } from '../../core/types/index.js';
import { recomputeLargestArmyAward, recomputeLongestRoadAward } from './awards/index.js';
import { DEV_CARD_COUNTS, DEV_COST, emptyResources } from './constants.js';
import type { DevCard } from './constants.js';
import { legalRoadEdges, canPlaceRoad } from './placement/index.js';
import { claimCommands } from './legal.js';
import {
  affordable,
  buildCost,
  countTotal,
  exchangeBank,
  frame,
  isResource,
  ownSeat,
  parseCounts,
  playerPending,
  popPhase,
  privateExchange,
  pushPhase,
  replaceTop,
  top,
  updateBase,
  updateSeat,
  withClaim,
} from './shared.js';
import { baseExt } from './types.js';
import type { DrawData, MonopolyData, RoadBuildingData } from './types.js';

function isDevCard(value: unknown): value is DevCard {
  return typeof value === 'string' && Object.hasOwn(DEV_CARD_COUNTS, value);
}

function slot(state: GameState, seat: Seat, id: unknown): CardSlot | undefined {
  return typeof id === 'string'
    ? ownSeat(state, seat).cardSlots.find((item) => item.slotId === id)
    : undefined;
}

function drawData(state: GameState): DrawData {
  const value = top(state).data;
  if (typeof value !== 'object' || value === null) throw new Error('Missing draw phase');
  // BUY_DEV_CARD owns this phase data.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as DrawData;
}

function roadBuildingData(state: GameState): RoadBuildingData {
  const value = top(state).data;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('remaining' in value) ||
    typeof value.remaining !== 'number'
  )
    throw new Error('Missing road-building phase');
  return { remaining: value.remaining };
}

function monopolyData(state: GameState): MonopolyData {
  const value = top(state).data;
  if (typeof value !== 'object' || value === null) throw new Error('Missing monopoly phase');
  // PLAY_DEV_CARD owns this phase data.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as MonopolyData;
}

function plentyRequest(value: unknown): Result<ResourceCounts> {
  const parsed = parseCounts(value);
  if (!parsed.ok) return parsed;
  return countTotal(parsed.value) === 2
    ? parsed
    : failure('invalid-plenty-count', 'Year of plenty must request exactly two resources');
}

function plentyReceipt(state: GameState, requested: ResourceCounts): ResourceCounts {
  const received = emptyResources();
  for (const resource of RESOURCES)
    received[resource] = Math.min(requested[resource], state.bank[resource] ?? 0);
  return received;
}

export const drawDevPhase: PhaseHandler = {
  legalCommands: (state, _frame, seat, priv) => claimCommands(state, seat, priv),
  pending: (state) => {
    const data = drawData(state);
    return withClaim(state, [
      {
        kind: 'random',
        request: {
          type: 'draw',
          deck: 'dev',
          seat: data.seat,
          slotId: data.slotId,
          remaining: state.decks.dev?.remaining ?? 0,
        },
        systemType: 'CARD_DEALT',
      },
    ]);
  },
};

export const buyDevCard: CommandHandler = {
  validate: (state, input, ctx) => {
    if ((state.decks.dev?.remaining ?? 0) <= 0)
      return failure('empty-dev-deck', 'No development cards remain');
    const cost = buildCost(state, 'devCard', DEV_COST, ctx);
    return cost.ok ? affordable(state, input.seat, cost.value) : cost;
  },
  apply: (state, input, ctx) => {
    const cost = buildCost(state, 'devCard', DEV_COST, ctx);
    if (!cost.ok) throw new Error('Validated dev cost missing');
    const id = `dev:${state.counters.nextSlotId}`;
    let next = exchangeBank(state, input.seat, cost.value, false);
    next = { ...next, counters: { ...next.counters, nextSlotId: next.counters.nextSlotId + 1 } };
    next = pushPhase(next, frame('drawDev', { seat: input.seat, slotId: id }));
    return { state: next, events: [{ type: 'devCardBought', seat: input.seat, slotId: id }] };
  },
  applyPrivate: (priv, before, input, _data, ctx) => {
    if (priv.seat !== input.seat) return success(priv);
    const cost = buildCost(before, 'devCard', DEV_COST, ctx);
    return cost.ok ? privateExchange(priv, cost.value, false) : cost;
  },
};

export const cardDealt: SystemInputHandler = {
  validate: (state, input) => {
    const data = drawData(state);
    if (input.seat !== data.seat || input.slotId !== data.slotId || input.deck !== 'dev')
      return failure('deal-mismatch', 'Deal does not match the pending draw');
    return input.card === undefined || isDevCard(input.card)
      ? success(undefined)
      : failure('invalid-dev-card', 'Unknown development card');
  },
  apply: (state) => {
    const data = drawData(state);
    const deck = state.decks.dev;
    if (!deck || deck.remaining <= 0) throw new Error('Validated deck missing');
    const publicSlot: CardSlot = {
      slotId: data.slotId,
      deck: 'dev',
      acquiredTurn: state.turn.number,
    };
    let next = updateSeat(state, data.seat, (old) => ({
      ...old,
      cardSlots: [...old.cardSlots, publicSlot],
    }));
    next = {
      ...next,
      decks: {
        ...next.decks,
        dev: {
          remaining: deck.remaining - 1,
          drawn: [...deck.drawn, { slotId: data.slotId, seat: data.seat }],
        },
      },
    };
    return {
      state: popPhase(next),
      events: [{ type: 'devCardDealt', seat: data.seat, slotId: data.slotId }],
    };
  },
  applyPrivate: (priv, before, input, data) => {
    const pending = drawData(before);
    if (priv.seat !== pending.seat) return success(priv);
    const card = input.card ?? data?.card;
    if (!isDevCard(card))
      return failure('missing-private-card', 'Owner must receive the dealt card identity');
    if (input.card !== undefined && data?.card !== undefined && data.card !== input.card)
      return failure('card-identity-mismatch', 'Private card identity disagrees with local deal');
    return success({ ...priv, slots: { ...priv.slots, [pending.slotId]: card } });
  },
};

function playParams(
  state: GameState,
  card: DevCard,
  params: unknown,
): Result<{ resource?: Resource; requested?: ResourceCounts }> {
  if (card === 'yearOfPlenty') {
    if (typeof params !== 'object' || params === null)
      return failure('invalid-dev-params', 'Year of plenty needs resource counts');
    const requested = plentyRequest(Reflect.get(params, 'resources'));
    return requested.ok ? success({ requested: requested.value }) : requested;
  }
  if (card === 'monopoly') {
    const resource =
      typeof params === 'object' && params !== null ? Reflect.get(params, 'resource') : undefined;
    return isResource(resource)
      ? success({ resource })
      : failure('invalid-dev-params', 'Monopoly needs a resource');
  }
  return success({});
}

export const playDevCard: CommandHandler = {
  validate: (state, input) => {
    const card = input.command.card;
    if (!isDevCard(card) || card === 'victoryPoint')
      return failure('invalid-dev-card', 'This card cannot be played');
    const owned = slot(state, input.seat, input.command.slotId);
    if (!owned || owned.revealed)
      return failure('invalid-dev-slot', 'Card slot is missing, foreign or spent');
    if (owned.acquiredTurn === state.turn.number)
      return failure('new-dev-card', 'Card cannot be played on the turn acquired');
    if (baseExt(state.ext.base).devPlayedTurn === state.turn.number)
      return failure('dev-card-already-played', 'Only one development card may be played per turn');
    const params = playParams(state, card, input.command.params);
    return params.ok ? success(undefined) : params;
  },
  apply: (state, input) => {
    const card = input.command.card;
    const id = input.command.slotId;
    if (!isDevCard(card) || typeof id !== 'string') throw new Error('Validated card play missing');
    let next = updateSeat(state, input.seat, (old) => ({
      ...old,
      cardSlots: old.cardSlots.map((held) =>
        held.slotId === id ? { ...held, revealed: card } : held,
      ),
    }));
    next = updateBase(next, (old) => ({ ...old, devPlayedTurn: state.turn.number }));
    if (card === 'knight') {
      next = updateBase(next, (old) => ({
        ...old,
        knightsPlayed: old.knightsPlayed.map((count, seat) =>
          seat === input.seat ? count + 1 : count,
        ),
      }));
      next = recomputeLargestArmyAward(next);
      next = pushPhase(next, frame('moveRobber', { returnTo: 'pop' }));
    } else if (card === 'roadBuilding') {
      next = pushPhase(next, frame('roadBuilding', { remaining: 2 }));
      if (
        (ownSeat(next, input.seat).piecesLeft.road ?? 0) === 0 ||
        legalRoadEdges(next, input.seat).length === 0
      )
        next = popPhase(next);
    } else if (card === 'yearOfPlenty') {
      const params = playParams(state, card, input.command.params);
      if (!params.ok || !params.value.requested)
        throw new Error('Validated plenty request missing');
      next = exchangeBank(next, input.seat, plentyReceipt(next, params.value.requested), true);
    } else if (card === 'monopoly') {
      const params = playParams(state, card, input.command.params);
      if (!params.ok || !params.value.resource)
        throw new Error('Validated monopoly resource missing');
      const resource = params.value.resource;
      const remaining = state.config.seats.filter(
        (seat) => seat !== input.seat && ownSeat(state, seat).resources.max[resource] > 0,
      );
      if (remaining.length)
        next = pushPhase(next, frame('monopoly', { seat: input.seat, resource, remaining }));
    }
    return { state: next, events: [{ type: 'devCardPlayed', seat: input.seat, card }] };
  },
  applyPrivate: (priv, before, input) => {
    const id = input.command.slotId;
    const card = input.command.card;
    if (priv.seat !== input.seat) return success(priv);
    if (typeof id !== 'string' || !isDevCard(card))
      return failure('invalid-dev-card', 'Invalid private card play');
    if (!Object.hasOwn(priv.slots, id) || priv.slots[id] !== card)
      return failure('private-card-mismatch', 'Played identity differs from the owned card');
    const slots = Object.fromEntries(
      Object.entries(priv.slots).filter(([slotId]) => slotId !== id),
    );
    let next: PrivateState = { ...priv, slots };
    if (card === 'yearOfPlenty') {
      const params = playParams(before, card, input.command.params);
      if (!params.ok || !params.value.requested)
        return failure('invalid-dev-params', 'Invalid plenty request');
      const credited = privateExchange(next, plentyReceipt(before, params.value.requested), true);
      if (!credited.ok) return credited;
      next = credited.value;
    }
    return success(next);
  },
};

export const roadBuildingPhase: PhaseHandler = {
  pending: (state) =>
    withClaim(state, [
      playerPending(state, state.turn.activeSeat, ['PLACE_FREE_ROAD', 'SKIP'], 'roadBuilding'),
    ]),
  legalCommands: (state, _frame, seat, priv) => {
    const claim = claimCommands(state, seat, priv);
    return seat === state.turn.activeSeat
      ? {
          commands: [
            { type: 'SKIP' },
            ...legalRoadEdges(state, seat).map((edge) => ({ type: 'PLACE_FREE_ROAD', edge })),
            ...claim.commands,
          ],
          templates: claim.templates,
        }
      : { commands: [], templates: [] };
  },
};

export const placeFreeRoad: CommandHandler = {
  validate: (state, input, ctx) => {
    const edge = input.command.edge;
    if (
      typeof edge !== 'string' ||
      !ctx.hooks.placementRules.road(state, input.seat, edge, canPlaceRoad(state, input.seat, edge))
    )
      return failure('illegal-road', 'Free road location is illegal');
    return (ownSeat(state, input.seat).piecesLeft.road ?? 0) > 0
      ? success(undefined)
      : failure('no-roads', 'No road pieces remain');
  },
  apply: (state, input, ctx) => {
    const edge = input.command.edge;
    if (typeof edge !== 'string') throw new Error('Validated edge missing');
    let next: GameState = {
      ...state,
      board: { ...state.board, roads: [...state.board.roads, { edge, seat: input.seat }] },
    };
    next = updateSeat(next, input.seat, (old) => ({
      ...old,
      piecesLeft: { ...old.piecesLeft, road: (old.piecesLeft.road ?? 0) - 1 },
    }));
    next = ctx.hooks.afterBuild(next, input.seat, 'road', edge);
    next = recomputeLongestRoadAward(next);
    const remaining = roadBuildingData(state).remaining - 1;
    next =
      remaining <= 0 ||
      (ownSeat(next, input.seat).piecesLeft.road ?? 0) <= 0 ||
      legalRoadEdges(next, input.seat).length === 0
        ? popPhase(next)
        : replaceTop(next, frame('roadBuilding', { remaining }));
    return { state: next, events: [{ type: 'roadBuilt', seat: input.seat, edge, free: true }] };
  },
};

export const skipRoadBuilding: CommandHandler = {
  validate: () => success(undefined),
  apply: (state) => ({ state: popPhase(state), events: [] }),
};

export const monopolyPhase: PhaseHandler = {
  legalCommands: (state, _frame, seat, priv) => claimCommands(state, seat, priv),
  pending: (state) => {
    const data = monopolyData(state);
    return withClaim(
      state,
      data.remaining.map((seat) => ({
        kind: 'reveal',
        seat,
        request: {
          type: 'monopolyCount',
          resource: data.resource,
          max: ownSeat(state, seat).resources.max[data.resource],
        },
        systemType: 'REVEAL_COUNT',
      })),
    );
  },
};

export const revealCount: SystemInputHandler = {
  validate: (state, input) => {
    const data = monopolyData(state);
    const victim = data.remaining.find((seat) => seat === input.seat);
    if (victim === undefined || input.resource !== data.resource)
      return failure('reveal-mismatch', 'Reveal does not match monopoly pending');
    if (typeof input.count !== 'number' || !Number.isSafeInteger(input.count) || input.count < 0)
      return failure('invalid-reveal-count', 'Count must be a non-negative integer');
    const holder = ownSeat(state, victim);
    if (
      input.count < holder.resources.min[data.resource] ||
      input.count > holder.resources.max[data.resource]
    )
      return failure('reveal-out-of-bounds', 'Count is outside public bounds');
    const exact = revealExact(holder.resources, data.resource, input.count);
    if (!exact.ok) return exact;
    const paid = loseKnown(exact.value, { ...emptyResources(), [data.resource]: input.count });
    return paid.ok ? success(undefined) : paid;
  },
  apply: (state, input) => {
    const data = monopolyData(state);
    const victim = data.remaining.find((seat) => seat === input.seat);
    if (victim === undefined || typeof input.count !== 'number')
      throw new Error('Validated reveal missing');
    const counts = { ...emptyResources(), [data.resource]: input.count };
    const exact = revealExact(ownSeat(state, victim).resources, data.resource, input.count);
    if (!exact.ok) throw new Error('Validated monopoly reveal was infeasible');
    const loss = loseKnown(exact.value, counts);
    const gain = gainKnown(ownSeat(state, data.seat).resources, counts);
    if (!loss.ok || !gain.ok) throw new Error('Validated monopoly bounds failed');
    let next = updateSeat(state, victim, (old) => ({ ...old, resources: loss.value }));
    next = updateSeat(next, data.seat, (old) => ({ ...old, resources: gain.value }));
    const remaining = data.remaining.filter((seat) => seat !== victim);
    next = remaining.length
      ? replaceTop(next, frame('monopoly', { ...data, remaining }))
      : popPhase(next);
    return {
      state: next,
      events: [
        {
          type: 'monopolyCollected',
          seat: data.seat,
          from: victim,
          resource: data.resource,
          count: input.count,
        },
      ],
    };
  },
  applyPrivate: (priv, before, input) => {
    const data = monopolyData(before);
    const victim = data.remaining.find((seat) => seat === input.seat);
    if (victim === undefined || typeof input.count !== 'number')
      return failure('reveal-mismatch', 'Missing monopoly reveal');
    if (priv.seat !== victim && priv.seat !== data.seat) return success(priv);
    if (priv.seat === victim && priv.hand[data.resource] !== input.count)
      return failure('private-reveal-mismatch', 'Revealed count differs from the owner hand');
    return privateExchange(
      priv,
      { ...emptyResources(), [data.resource]: input.count },
      priv.seat === data.seat,
    );
  },
};

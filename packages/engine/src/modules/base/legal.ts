import type { HandlerContext } from '../../core/modules/index.js';
import type { LegalCommandSet } from '../../core/pipeline/index.js';
import type { GameState, PrivateState } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import { RESOURCES } from '../../core/types/index.js';
import { CITY_COST, DEV_COST, ROAD_COST, SETTLEMENT_COST } from './constants.js';
import { legalCityVertices, legalRoadEdges, legalSettlementVertices } from './placement/index.js';
import { affordable, buildCost, ownSeat, top } from './shared.js';
import { baseExt, baseOptions } from './types.js';
import { automaticVictoryClaim } from './victory.js';

export function claimCommands(state: GameState, seat: Seat, priv?: PrivateState): LegalCommandSet {
  if (seat !== state.turn.activeSeat) return { commands: [], templates: [] };
  if (!priv)
    return { commands: [], templates: [{ type: 'CLAIM_VICTORY', slotIds: 'owned VP slots' }] };
  const claim = automaticVictoryClaim(state, new Map([[seat, priv]]));
  return claim ? { commands: [claim.command], templates: [] } : { commands: [], templates: [] };
}

function playableDev(state: GameState, seat: Seat, priv?: PrivateState): LegalCommandSet {
  if (baseExt(state.ext.base).devPlayedTurn === state.turn.number)
    return { commands: [], templates: [] };
  const commands: LegalCommandSet['commands'] = [];
  const templates: LegalCommandSet['templates'] = [];
  for (const slot of ownSeat(state, seat).cardSlots) {
    if (slot.revealed || slot.acquiredTurn === state.turn.number) continue;
    const card = priv?.slots[slot.slotId];
    if (!card) {
      templates.push({ type: 'PLAY_DEV_CARD', slotId: slot.slotId, card: 'private identity' });
    } else if (card === 'knight' || card === 'roadBuilding') {
      commands.push({ type: 'PLAY_DEV_CARD', slotId: slot.slotId, card });
    } else if (card === 'yearOfPlenty') {
      templates.push({
        type: 'PLAY_DEV_CARD',
        slotId: slot.slotId,
        card,
        params: { resources: 'choose two' },
      });
    } else if (card === 'monopoly') {
      for (const resource of ['brick', 'lumber', 'wool', 'grain', 'ore'])
        commands.push({ type: 'PLAY_DEV_CARD', slotId: slot.slotId, card, params: { resource } });
    }
  }
  return { commands, templates };
}

function canPay(
  state: GameState,
  seat: Seat,
  type: string,
  cost: Parameters<typeof buildCost>[2],
  ctx: HandlerContext,
  priv?: PrivateState,
): boolean {
  const adjusted = buildCost(state, type, cost, ctx);
  if (!adjusted.ok) return false;
  if (priv)
    return RESOURCES.every((resource) => (priv.hand[resource] ?? 0) >= adjusted.value[resource]);
  return affordable(state, seat, adjusted.value).ok;
}

function privateCanPay(
  priv: PrivateState | undefined,
  cost: Parameters<typeof buildCost>[2],
): boolean {
  return !priv || RESOURCES.every((resource) => (priv.hand[resource] ?? 0) >= cost[resource]);
}

/** Concrete pre-roll actions plus private card and victory choices. */
export function preRollLegal(
  state: GameState,
  seat: Seat,
  priv: PrivateState | undefined,
): LegalCommandSet {
  if (seat !== state.turn.activeSeat) return { commands: [], templates: [] };
  const cards = playableDev(state, seat, priv);
  const claim = claimCommands(state, seat, priv);
  return {
    commands: [{ type: 'ROLL_DICE' }, ...cards.commands, ...claim.commands],
    templates: [...cards.templates, ...claim.templates],
  };
}

/** Enumerate discrete builds; keep unbounded resource/trade selections as templates. */
export function mainLegal(
  state: GameState,
  seat: Seat,
  priv: PrivateState | undefined,
  ctx: HandlerContext,
): LegalCommandSet {
  const options = baseOptions(state.config.options.base);
  if (seat !== state.turn.activeSeat) {
    if (!options.playerTrades) return { commands: [], templates: [] };
    const offers = baseExt(state.ext.base).offers;
    const responses = offers.flatMap((offer) =>
      offer.proposer === state.turn.activeSeat &&
      offer.to.includes(seat) &&
      !offer.acceptedBy.includes(seat) &&
      !offer.declinedBy.includes(seat)
        ? [
            ...(privateCanPay(priv, offer.want)
              ? [{ type: 'RESPOND_TRADE', offerId: offer.id, accept: true }]
              : []),
            { type: 'RESPOND_TRADE', offerId: offer.id, accept: false },
          ]
        : [],
    );
    const cancellations = offers
      .filter(
        (offer) =>
          offer.proposer === seat ||
          (offer.proposer === state.turn.activeSeat && offer.acceptedBy.includes(seat)),
      )
      .map((offer) => ({ type: 'CANCEL_TRADE', offerId: offer.id }));
    return {
      commands: [...responses, ...cancellations],
      templates: [{ type: 'PROPOSE_TRADE', give: 'resources', want: 'resources' }],
    };
  }
  const commands: LegalCommandSet['commands'] = [{ type: 'END_TURN' }];
  const templates: LegalCommandSet['templates'] = [
    { type: 'MARITIME_TRADE', give: 'rate multiples', get: 'resources' },
  ];
  const claim = claimCommands(state, seat, priv);
  commands.push(...claim.commands);
  templates.push(...claim.templates);
  const cards = playableDev(state, seat, priv);
  commands.push(...cards.commands);
  templates.push(...cards.templates);
  if (
    (ownSeat(state, seat).piecesLeft.road ?? 0) > 0 &&
    canPay(state, seat, 'road', ROAD_COST, ctx, priv)
  ) {
    commands.push(
      ...legalRoadEdges(state, seat)
        .filter((edge) => ctx.hooks.placementRules.road(state, seat, edge, true))
        .map((edge) => ({ type: 'BUILD_ROAD', edge })),
    );
  }
  if (
    (ownSeat(state, seat).piecesLeft.settlement ?? 0) > 0 &&
    canPay(state, seat, 'settlement', SETTLEMENT_COST, ctx, priv)
  ) {
    commands.push(
      ...legalSettlementVertices(state, seat)
        .filter((vertex) => ctx.hooks.placementRules.settlement(state, seat, vertex, true))
        .map((vertex) => ({ type: 'BUILD_SETTLEMENT', vertex })),
    );
  }
  if (
    (ownSeat(state, seat).piecesLeft.city ?? 0) > 0 &&
    canPay(state, seat, 'city', CITY_COST, ctx, priv)
  ) {
    commands.push(
      ...legalCityVertices(state, seat)
        .filter((vertex) => ctx.hooks.placementRules.city(state, seat, vertex, true))
        .map((vertex) => ({ type: 'BUILD_CITY', vertex })),
    );
  }
  if ((state.decks.dev?.remaining ?? 0) > 0 && canPay(state, seat, 'devCard', DEV_COST, ctx, priv))
    commands.push({ type: 'BUY_DEV_CARD' });
  if (options.playerTrades) {
    templates.push({ type: 'OFFER_TRADE', give: 'resources', want: 'resources', to: 'seats' });
    for (const offer of baseExt(state.ext.base).offers) {
      commands.push({ type: 'CANCEL_TRADE', offerId: offer.id });
      const possible = offer.proposer === seat ? offer.acceptedBy : [offer.proposer];
      if (offer.valid && privateCanPay(priv, offer.proposer === seat ? offer.give : offer.want))
        commands.push(
          ...possible.map((withSeat) => ({ type: 'CONFIRM_TRADE', offerId: offer.id, withSeat })),
        );
    }
  }
  return { commands, templates };
}

export function discardLegal(state: GameState, seat: Seat, priv?: PrivateState): LegalCommandSet {
  const phase = top(state);
  const data = phase.data;
  const remaining =
    typeof data === 'object' &&
    data !== null &&
    'remaining' in data &&
    Array.isArray(data.remaining)
      ? data.remaining
      : [];
  const claim = claimCommands(state, seat, priv);
  if (!remaining.includes(seat)) return claim;
  return {
    commands: claim.commands,
    templates: [
      ...claim.templates,
      {
        type: 'DISCARD',
        count: Math.floor(ownSeat(state, seat).resources.total / 2),
        from: ownSeat(state, seat).resources,
      },
    ],
  };
}

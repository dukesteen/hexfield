import type { HandlerContext } from '../../core/modules/index.js';
import type { LegalCommandSet } from '../../core/pipeline/index.js';
import type { GameState, PrivateState } from '../../core/state/index.js';
import type { CardCounts, Seat } from '../../core/types/index.js';
import { legalCityVertices, legalRoadEdges, legalSettlementVertices } from './placement/index.js';
import { affordable, buildCost, inTurnFlow, ownSeat, top } from './shared.js';
import { baseExt, baseOptions } from './types.js';
import { automaticVictoryClaim } from './victory.js';

export function claimCommands(
  state: GameState,
  seat: Seat,
  priv: PrivateState | undefined,
  ctx: HandlerContext,
): LegalCommandSet {
  if (seat !== state.turn.activeSeat || inTurnFlow(state)) return { commands: [], templates: [] };
  if (!priv)
    return { commands: [], templates: [{ type: 'CLAIM_VICTORY', slotIds: 'owned VP slots' }] };
  const claim = automaticVictoryClaim(state, new Map([[seat, priv]]), ctx);
  return claim ? { commands: [claim.command], templates: [] } : { commands: [], templates: [] };
}

function playableDev(state: GameState, seat: Seat, priv?: PrivateState): LegalCommandSet {
  if (baseExt(state.ext.base).devPlayedTurn === state.turn.number)
    return { commands: [], templates: [] };
  const commands: LegalCommandSet['commands'] = [];
  const templates: LegalCommandSet['templates'] = [];
  for (const slot of ownSeat(state, seat).cardSlots) {
    // Module decks (progress cards) have their own play command.
    if (slot.deck !== 'dev' || slot.revealed || slot.acquiredTurn === state.turn.number) continue;
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
  ctx: HandlerContext,
  priv?: PrivateState,
): boolean {
  const adjusted = buildCost(state, type, ctx);
  if (!adjusted.ok) return false;
  if (priv) return privateCanPay(priv, adjusted.value);
  return affordable(state, seat, adjusted.value).ok;
}

function privateCanPay(priv: PrivateState | undefined, cost: CardCounts): boolean {
  return !priv || Object.entries(cost).every(([kind, count]) => (priv.hand[kind] ?? 0) >= count);
}

/** Concrete pre-roll actions plus private card and victory choices. */
export function preRollLegal(
  state: GameState,
  seat: Seat,
  priv: PrivateState | undefined,
  ctx: HandlerContext,
): LegalCommandSet {
  if (seat !== state.turn.activeSeat) return { commands: [], templates: [] };
  const cards = playableDev(state, seat, priv);
  const claim = claimCommands(state, seat, priv, ctx);
  return {
    commands: [{ type: 'ROLL_DICE' }, ...cards.commands, ...claim.commands],
    templates: [...cards.templates, ...claim.templates],
  };
}

/** Affordable, legal road, settlement and city placements plus a development-card purchase. */
export function buildCommands(
  state: GameState,
  seat: Seat,
  priv: PrivateState | undefined,
  ctx: HandlerContext,
): LegalCommandSet['commands'] {
  const commands: LegalCommandSet['commands'] = [];
  if ((ownSeat(state, seat).piecesLeft.road ?? 0) > 0 && canPay(state, seat, 'road', ctx, priv)) {
    commands.push(
      ...legalRoadEdges(state, seat, {}, ctx)
        .filter((edge) => ctx.hooks.placement.road(state, seat, edge, true))
        .map((edge) => ({ type: 'BUILD_ROAD', edge })),
    );
  }
  if (
    (ownSeat(state, seat).piecesLeft.settlement ?? 0) > 0 &&
    canPay(state, seat, 'settlement', ctx, priv)
  ) {
    commands.push(
      ...legalSettlementVertices(state, seat, {}, ctx)
        .filter((vertex) => ctx.hooks.placement.settlement(state, seat, vertex, true))
        .map((vertex) => ({ type: 'BUILD_SETTLEMENT', vertex })),
    );
  }
  if ((ownSeat(state, seat).piecesLeft.city ?? 0) > 0 && canPay(state, seat, 'city', ctx, priv)) {
    commands.push(
      ...legalCityVertices(state, seat)
        .filter((vertex) => ctx.hooks.placement.city(state, seat, vertex, true))
        .map((vertex) => ({ type: 'BUILD_CITY', vertex })),
    );
  }
  if ((state.decks.dev?.remaining ?? 0) > 0 && canPay(state, seat, 'devCard', ctx, priv))
    commands.push({ type: 'BUY_DEV_CARD' });
  return commands;
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
  const claim = claimCommands(state, seat, priv, ctx);
  commands.push(...claim.commands);
  templates.push(...claim.templates);
  const cards = playableDev(state, seat, priv);
  commands.push(...cards.commands);
  templates.push(...cards.templates);
  commands.push(...buildCommands(state, seat, priv, ctx));
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

export function discardLegal(
  state: GameState,
  seat: Seat,
  priv: PrivateState | undefined,
  ctx: HandlerContext,
): LegalCommandSet {
  const phase = top(state);
  const data = phase.data;
  const remaining =
    typeof data === 'object' &&
    data !== null &&
    'remaining' in data &&
    Array.isArray(data.remaining)
      ? data.remaining
      : [];
  const claim = claimCommands(state, seat, priv, ctx);
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

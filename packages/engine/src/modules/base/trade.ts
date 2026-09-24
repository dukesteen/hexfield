import type { CommandHandler } from '../../core/modules/index.js';
import type { Pending } from '../../core/pipeline/index.js';
import { gainKnown, loseKnown } from '../../core/resources/index.js';
import type { GameState, PrivateState } from '../../core/state/index.js';
import { RESOURCES, failure, success } from '../../core/types/index.js';
import type { ResourceCounts, Result, Seat } from '../../core/types/index.js';
import { harborRate } from './board/index.js';
import { baseExt, baseOptions } from './types.js';
import type { TradeOffer } from './types.js';
import {
  affordable,
  bankHas,
  countTotal,
  exchangeBank,
  ownSeat,
  parseCounts,
  privateExchange,
  timer,
  updateBase,
  updateSeat,
} from './shared.js';

function offerById(state: GameState, value: unknown): TradeOffer | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? baseExt(state.ext.base).offers.find((offer) => offer.id === value)
    : undefined;
}

function seatFrom(state: GameState, value: unknown): Seat | undefined {
  return state.config.seats.find((seat) => seat === value);
}

function validatedSides(
  give: unknown,
  want: unknown,
): Result<{ give: ResourceCounts; want: ResourceCounts }> {
  const parsedGive = parseCounts(give);
  if (!parsedGive.ok) return parsedGive;
  const parsedWant = parseCounts(want);
  if (!parsedWant.ok) return parsedWant;
  if (countTotal(parsedGive.value) === 0 || countTotal(parsedWant.value) === 0)
    return failure('empty-trade-side', 'Both sides must offer resources');
  if (RESOURCES.some((kind) => parsedGive.value[kind] > 0 && parsedWant.value[kind] > 0))
    return failure('overlapping-trade', 'Cannot give and receive the same resource');
  return success({ give: parsedGive.value, want: parsedWant.value });
}

function enabled(state: GameState): Result<void> {
  return baseOptions(state.config.options.base).playerTrades
    ? success(undefined)
    : failure('trades-disabled', 'Player trades are disabled');
}

function recipients(state: GameState, value: unknown): Result<Seat[]> {
  if (value === undefined)
    return success(state.config.seats.filter((seat) => seat !== state.turn.activeSeat));
  if (!Array.isArray(value) || value.length === 0)
    return failure('invalid-recipients', 'Trade recipients must be a nonempty seat list');
  const chosen: Seat[] = [];
  for (const item of value) {
    const seat = seatFrom(state, item);
    if (seat === undefined || seat === state.turn.activeSeat || chosen.includes(seat))
      return failure('invalid-recipients', 'Recipients must be distinct other seats');
    chosen.push(seat);
  }
  return success(chosen.toSorted((a, b) => a - b));
}

/** Optional non-active trade responses and proposals during main. */
export function tradePendings(state: GameState): Pending[] {
  if (!baseOptions(state.config.options.base).playerTrades) return [];
  const offers = baseExt(state.ext.base).offers;
  return state.config.seats
    .filter((seat) => seat !== state.turn.activeSeat)
    .map((seat) => {
      const canRespond = offers.some(
        (offer) =>
          offer.proposer === state.turn.activeSeat &&
          offer.to.includes(seat) &&
          !offer.acceptedBy.includes(seat) &&
          !offer.declinedBy.includes(seat),
      );
      const canCancel = offers.some(
        (offer) =>
          offer.proposer === seat ||
          (offer.proposer === state.turn.activeSeat && offer.acceptedBy.includes(seat)),
      );
      const deadline = canRespond ? timer(state, 'main') : undefined;
      return {
        kind: 'player',
        seat,
        allowed: [
          'PROPOSE_TRADE',
          ...(canRespond ? ['RESPOND_TRADE'] : []),
          ...(canCancel ? ['CANCEL_TRADE'] : []),
        ],
        ...(deadline ? { deadline } : {}),
      };
    });
}

export const maritimeTrade: CommandHandler = {
  validate: (state, input) => {
    const sides = validatedSides(input.command.give, input.command.get);
    if (!sides.ok) return sides;
    let due = 0;
    for (const resource of RESOURCES) {
      const given = sides.value.give[resource];
      if (given === 0) continue;
      const rate = harborRate(state, input.seat, resource);
      if (given % rate !== 0)
        return failure('invalid-maritime-rate', `${resource} requires a ${rate}:1 rate`);
      due += given / rate;
    }
    if (due !== countTotal(sides.value.want))
      return failure('invalid-maritime-output', 'Output count does not match trade rates');
    if (!bankHas(state, sides.value.want))
      return failure('bank-shortage', 'Bank lacks the requested resources');
    return affordable(state, input.seat, sides.value.give);
  },
  apply: (state, input) => {
    const sides = validatedSides(input.command.give, input.command.get);
    if (!sides.ok) throw new Error('Validated maritime trade missing');
    const afterGive = exchangeBank(state, input.seat, sides.value.give, false);
    const afterGet = exchangeBank(afterGive, input.seat, sides.value.want, true);
    return { state: afterGet, events: [{ type: 'maritimeTrade', seat: input.seat }] };
  },
  applyPrivate: (priv, _before, input) => {
    if (priv.seat !== input.seat) return success(priv);
    const sides = validatedSides(input.command.give, input.command.get);
    if (!sides.ok) return sides;
    const afterGive = privateExchange(priv, sides.value.give, false);
    return afterGive.ok ? privateExchange(afterGive.value, sides.value.want, true) : afterGive;
  },
};

export const offerTrade: CommandHandler = {
  validate: (state, input) => {
    const allowed = enabled(state);
    if (!allowed.ok) return allowed;
    const sides = validatedSides(input.command.give, input.command.want);
    if (!sides.ok) return sides;
    const to = recipients(state, input.command.to);
    if (!to.ok) return to;
    return affordable(state, input.seat, sides.value.give);
  },
  apply: (state, input) => {
    const sides = validatedSides(input.command.give, input.command.want);
    const to = recipients(state, input.command.to);
    if (!sides.ok || !to.ok) throw new Error('Validated trade offer missing');
    const id = state.counters.nextOfferId;
    const offer: TradeOffer = {
      id,
      proposer: input.seat,
      give: sides.value.give,
      want: sides.value.want,
      to: to.value,
      acceptedBy: [],
      declinedBy: [],
      valid: true,
    };
    const next = updateBase(
      { ...state, counters: { ...state.counters, nextOfferId: id + 1 } },
      (old) => ({
        ...old,
        offers: [...old.offers.filter((item) => item.proposer !== input.seat), offer],
      }),
    );
    return { state: next, events: [{ type: 'tradeOffered', offerId: id }] };
  },
};

export const proposeTrade: CommandHandler = {
  validate: (state, input) => {
    const allowed = enabled(state);
    if (!allowed.ok) return allowed;
    if (input.seat === state.turn.activeSeat)
      return failure('wrong-proposer', 'Only another seat may propose a counter-offer');
    const sides = validatedSides(input.command.give, input.command.want);
    return sides.ok ? affordable(state, input.seat, sides.value.give) : sides;
  },
  apply: (state, input) => {
    const sides = validatedSides(input.command.give, input.command.want);
    if (!sides.ok) throw new Error('Validated counter-offer missing');
    const id = state.counters.nextOfferId;
    const offer: TradeOffer = {
      id,
      proposer: input.seat,
      give: sides.value.give,
      want: sides.value.want,
      to: [state.turn.activeSeat],
      acceptedBy: [],
      declinedBy: [],
      valid: true,
    };
    const next = updateBase(
      { ...state, counters: { ...state.counters, nextOfferId: id + 1 } },
      (old) => ({
        ...old,
        offers: [...old.offers.filter((item) => item.proposer !== input.seat), offer],
      }),
    );
    return { state: next, events: [{ type: 'tradeProposed', offerId: id, seat: input.seat }] };
  },
};

export const respondTrade: CommandHandler = {
  validate: (state, input) => {
    const offer = offerById(state, input.command.offerId);
    if (!offer || offer.proposer !== state.turn.activeSeat || !offer.to.includes(input.seat))
      return failure('unknown-offer', 'No offer is pending for this seat');
    if (offer.acceptedBy.includes(input.seat) || offer.declinedBy.includes(input.seat))
      return failure('already-responded', 'Seat already responded');
    return typeof input.command.accept === 'boolean'
      ? success(undefined)
      : failure('invalid-response', 'Accept must be boolean');
  },
  apply: (state, input) => {
    const id = input.command.offerId;
    const accept = input.command.accept;
    const next = updateBase(state, (old) => ({
      ...old,
      offers: old.offers.map((offer) =>
        offer.id === id
          ? {
              ...offer,
              acceptedBy:
                accept === true
                  ? [...offer.acceptedBy, input.seat].toSorted((a, b) => a - b)
                  : offer.acceptedBy,
              declinedBy:
                accept === false
                  ? [...offer.declinedBy, input.seat].toSorted((a, b) => a - b)
                  : offer.declinedBy,
            }
          : offer,
      ),
    }));
    return {
      state: next,
      events: [{ type: 'tradeResponded', offerId: id, seat: input.seat, accept }],
    };
  },
};

function counterparty(state: GameState, offer: TradeOffer, withSeat: unknown): Seat | undefined {
  const seat = seatFrom(state, withSeat);
  if (seat === undefined) return undefined;
  if (offer.proposer === state.turn.activeSeat)
    return offer.acceptedBy.includes(seat) ? seat : undefined;
  return offer.proposer === seat && offer.to.includes(state.turn.activeSeat) ? seat : undefined;
}

function movedBounds(state: GameState, from: Seat, to: Seat, counts: ResourceCounts): GameState {
  const outgoing = loseKnown(ownSeat(state, from).resources, counts);
  if (!outgoing.ok) throw new Error(`Validated trade debit failed: ${outgoing.error.code}`);
  const debited = updateSeat(state, from, (old) => ({ ...old, resources: outgoing.value }));
  const incoming = gainKnown(ownSeat(debited, to).resources, counts);
  if (!incoming.ok) throw new Error(`Validated trade credit failed: ${incoming.error.code}`);
  return updateSeat(debited, to, (old) => ({ ...old, resources: incoming.value }));
}

export const confirmTrade: CommandHandler = {
  validate: (state, input) => {
    const offer = offerById(state, input.command.offerId);
    if (!offer || !offer.valid) return failure('invalid-offer', 'Offer is missing or unaffordable');
    const other = counterparty(state, offer, input.command.withSeat);
    if (other === undefined)
      return failure('unaccepted-offer', 'Counterparty has not accepted this offer');
    const proposer = offer.proposer;
    const recipient = proposer === state.turn.activeSeat ? other : state.turn.activeSeat;
    const proposerCanPay = affordable(state, proposer, offer.give);
    if (!proposerCanPay.ok) return proposerCanPay;
    return affordable(state, recipient, offer.want);
  },
  apply: (state, input) => {
    const offer = offerById(state, input.command.offerId);
    if (!offer) throw new Error('Validated offer missing');
    const other = counterparty(state, offer, input.command.withSeat);
    if (other === undefined) throw new Error('Validated counterparty missing');
    const recipient = offer.proposer === state.turn.activeSeat ? other : state.turn.activeSeat;
    let next = movedBounds(state, offer.proposer, recipient, offer.give);
    next = movedBounds(next, recipient, offer.proposer, offer.want);
    next = updateBase(next, (old) => ({
      ...old,
      offers: old.offers.filter((item) => item.id !== offer.id),
    }));
    return { state: next, events: [{ type: 'tradeConfirmed', offerId: offer.id }] };
  },
  applyPrivate: (priv, before, input): Result<PrivateState> => {
    const offer = offerById(before, input.command.offerId);
    if (!offer) return failure('invalid-offer', 'Offer missing');
    const other = counterparty(before, offer, input.command.withSeat);
    if (other === undefined) return failure('unaccepted-offer', 'Counterparty missing');
    const recipient = offer.proposer === before.turn.activeSeat ? other : before.turn.activeSeat;
    if (priv.seat === offer.proposer) {
      const paid = privateExchange(priv, offer.give, false);
      return paid.ok ? privateExchange(paid.value, offer.want, true) : paid;
    }
    if (priv.seat === recipient) {
      const paid = privateExchange(priv, offer.want, false);
      return paid.ok ? privateExchange(paid.value, offer.give, true) : paid;
    }
    return success(priv);
  },
};

export const cancelTrade: CommandHandler = {
  validate: (state, input) => {
    const offer = offerById(state, input.command.offerId);
    if (!offer) return failure('unknown-offer', 'Offer does not exist');
    if (
      input.seat !== state.turn.activeSeat &&
      offer.proposer !== input.seat &&
      !(offer.proposer === state.turn.activeSeat && offer.acceptedBy.includes(input.seat))
    )
      return failure('not-trade-party', 'Seat cannot cancel this offer or acceptance');
    return success(undefined);
  },
  apply: (state, input) => {
    const id = input.command.offerId;
    const offer = offerById(state, id);
    if (!offer) throw new Error('Validated offer missing');
    const removesOffer = input.seat === state.turn.activeSeat || offer.proposer === input.seat;
    const next = updateBase(state, (old) => ({
      ...old,
      offers: removesOffer
        ? old.offers.filter((item) => item.id !== id)
        : old.offers.map((item) =>
            item.id === id
              ? {
                  ...item,
                  acceptedBy: item.acceptedBy.filter((seat) => seat !== input.seat),
                  declinedBy: [...item.declinedBy, input.seat].toSorted((a, b) => a - b),
                }
              : item,
          ),
    }));
    return {
      state: next,
      events: [
        {
          type: removesOffer ? 'tradeCancelled' : 'tradeAcceptanceWithdrawn',
          offerId: id,
          seat: input.seat,
        },
      ],
    };
  },
};

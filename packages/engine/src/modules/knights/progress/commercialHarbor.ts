import type { EngineEffect } from '../../../core/effects/index.js';
import type { CommandHandler, PhaseHandler } from '../../../core/modules/index.js';
import type { CommandShape, PrivateInputData } from '../../../core/pipeline/index.js';
import { kindBounds, revealExact, seatBounds } from '../../../core/resources/index.js';
import type { GameState, PrivateState } from '../../../core/state/index.js';
import { RESOURCES, failure, success } from '../../../core/types/index.js';
import type { Result, Seat } from '../../../core/types/index.js';
import { claimCommands } from '../../base/legal.js';
import {
  affordable,
  cardKindsOf,
  ownSeat,
  playerPending,
  privateExchange,
  updateSeat,
  withClaim,
} from '../../base/shared.js';
import { COMMODITIES } from '../config.js';
import { slotOf } from '../slot.js';
import { knightsExt, updateKnights } from '../types.js';
import { changed, plainCard } from './card.js';
import type { CardFlow, CardModule } from './card.js';
import { frameData, popPhase, pushKnights } from './frames.js';
import { moveCards } from './transfer.js';

export const HARBOR_FRAME = 'harborReply';

/** A pending offer: the player offered one resource (a kind, or `hidden`) to `seat`. */
interface HarborReplyData {
  actor: Seat;
  seat: Seat;
  offered: string;
}

function replyData(state: GameState): HarborReplyData | undefined {
  return frameData<HarborReplyData>(state, HARBOR_FRAME);
}

/** Whether public bounds allow the seat to hold a commodity. */
function mayHoldCommodity(state: GameState, seat: Seat): boolean {
  const bounds = kindBounds(ownSeat(state, seat).resources);
  return COMMODITIES.some((kind) => (bounds.max[kind] ?? 0) > 0);
}

/** Whether public bounds allow the seat to hold a resource card (a base resource). */
function mayHoldResource(state: GameState, seat: Seat): boolean {
  const bounds = kindBounds(ownSeat(state, seat).resources);
  return RESOURCES.some((kind) => (bounds.max[kind] ?? 0) > 0);
}

function offersTo(state: GameState, seat: Seat): number {
  return knightsExt(state).harbor?.offered.filter((item) => item === seat).length ?? 0;
}

/** Seats the player may still offer a card to: each at most once per harbor played this turn. */
export function offerTargets(state: GameState, actor: Seat): Seat[] {
  const harbor = knightsExt(state).harbor;
  if (harbor?.seat !== actor) return [];
  return state.config.seats.filter(
    (seat) =>
      seat !== actor && offersTo(state, seat) < harbor.cards && mayHoldCommodity(state, seat),
  );
}

function offerProblem(state: GameState, seat: Seat, to: unknown, resource: unknown): Result<void> {
  const where = slotOf(state);
  if (where?.slot !== 'main' || where.seat !== seat)
    return failure('not-acting', 'Offer a card in your main phase');
  const target = state.config.seats.find((item) => item === to);
  if (target === undefined || !offerTargets(state, seat).includes(target))
    return failure('no-offer', 'You cannot offer a card to that seat now');
  if (resource === 'hidden')
    return mayHoldResource(state, seat)
      ? success(undefined)
      : failure('no-resource', 'You hold no resource card');
  return typeof resource === 'string' && RESOURCES.some((kind) => kind === resource)
    ? affordable(state, seat, { [resource]: 1 })
    : failure('invalid-resource', 'Offer one resource card, never a commodity');
}

/** The player offers a resource face down to another seat, which must answer with a commodity. */
export const harborOffer: CommandHandler = {
  keys: { allowed: ['to', 'resource'] },
  validate: (state, input) =>
    offerProblem(state, input.seat, input.command.to, input.command.resource),
  apply: (state, input) => {
    const to = state.config.seats.find((seat) => seat === input.command.to);
    const resource = input.command.resource;
    if (to === undefined || typeof resource !== 'string')
      throw new Error('Validated offer missing');
    const next = updateKnights(state, (old) =>
      old.harbor
        ? { ...old, harbor: { ...old.harbor, offered: [...old.harbor.offered, to] } }
        : old,
    );
    return {
      state: pushKnights(next, HARBOR_FRAME, { actor: input.seat, seat: to, offered: resource }),
      events: [{ type: 'harborOffered', seat: input.seat, to }],
      effects: [],
    };
  },
  applyPrivate: (priv, before, input, data) => {
    if (priv.seat !== input.seat) return success(priv);
    const resource = input.command.resource === 'hidden' ? data?.offered : input.command.resource;
    return typeof resource === 'string' && (priv.hand[resource] ?? 0) > 0
      ? success(priv)
      : failure('missing-private-offer', 'The offered resource is not in the hand');
  },
};

/** The commodity kinds the answer may name: explicit, hidden, or none. */
function answerProblem(state: GameState, seat: Seat, answer: unknown): Result<void> {
  const bounds = kindBounds(ownSeat(state, seat).resources);
  if (answer === 'none')
    return COMMODITIES.every((kind) => (bounds.min[kind] ?? 0) === 0)
      ? success(undefined)
      : failure('has-commodity', 'A seat holding a commodity must give one back');
  if (answer === 'hidden')
    return mayHoldCommodity(state, seat)
      ? success(undefined)
      : failure('no-commodity', 'Answer none: no commodity can be held');
  return typeof answer === 'string' && COMMODITIES.includes(answer)
    ? affordable(state, seat, { [answer]: 1 })
    : failure('invalid-commodity', 'Give back one commodity');
}

function kindOf(value: unknown, disclosed: unknown): string | undefined {
  const kind = value === 'hidden' ? disclosed : value;
  return typeof kind === 'string' ? kind : undefined;
}

/**
 * The offered seat gives one commodity back, or answers `none` when it has none (it shows the
 * three commodity counts as zero). The two cards swap. Each card is explicit (public) or `hidden`
 * (only the swap is public; the kinds reach the two parties as private data `{ offered, returned }`).
 */
export const harborReply: CommandHandler = {
  keys: { allowed: ['commodity'] },
  validate: (state, input) => {
    const frame = replyData(state);
    if (frame === undefined || frame.seat !== input.seat)
      return failure('not-answering', 'No commercial harbor offer awaits this seat');
    return answerProblem(state, input.seat, input.command.commodity);
  },
  apply: (state, input) => {
    const frame = replyData(state);
    const answer = input.command.commodity;
    if (frame === undefined || typeof answer !== 'string')
      throw new Error('Validated answer missing');
    if (answer === 'none') {
      const kinds = cardKindsOf(state);
      let bounds = kindBounds(ownSeat(state, frame.seat).resources);
      const effects: EngineEffect[] = [];
      for (const kind of COMMODITIES) {
        if ((bounds.max[kind] ?? 0) === 0) continue;
        const exact = revealExact(bounds, kind, 0, kinds);
        if (!exact.ok) throw new Error('Validated commodity reveal failed');
        bounds = exact.value;
        effects.push({
          type: 'resource-count-revealed',
          seat: frame.seat,
          resource: kind,
          count: 0,
        });
      }
      return {
        state: popPhase(
          updateSeat(state, frame.seat, (old) => ({ ...old, resources: seatBounds(bounds) })),
        ),
        events: [{ type: 'harborReturned', seat: frame.actor, from: frame.seat }],
        effects,
      };
    }
    const give =
      frame.offered === 'hidden'
        ? moveCards(state, frame.actor, frame.seat, 'hidden', 1)
        : moveCards(state, frame.actor, frame.seat, { [frame.offered]: 1 }, 1);
    const back =
      answer === 'hidden'
        ? moveCards(give.state, frame.seat, frame.actor, 'hidden', 1)
        : moveCards(give.state, frame.seat, frame.actor, { [answer]: 1 }, 1);
    return {
      state: popPhase(back.state),
      events: [{ type: 'harborSwapped', seat: frame.actor, with: frame.seat }],
      effects: [...give.effects, ...back.effects],
    };
  },
  applyPrivate: (priv, before, input, data: PrivateInputData | undefined) => {
    const frame = replyData(before);
    const answer = input.command.commodity;
    if (frame === undefined || typeof answer !== 'string')
      return failure('not-answering', 'No commercial harbor offer is open');
    if (answer === 'none') {
      if (priv.seat !== frame.seat) return success(priv);
      return COMMODITIES.every((kind) => (priv.hand[kind] ?? 0) === 0)
        ? success(priv)
        : failure('hidden-commodity', 'The seat claimed no commodity but holds one');
    }
    if (priv.seat !== frame.actor && priv.seat !== frame.seat) return success(priv);
    const offered = kindOf(frame.offered, data?.offered);
    const returned = kindOf(answer, data?.returned);
    if (offered === undefined || returned === undefined)
      return failure('missing-private-cards', 'The two parties must know the swapped cards');
    const actor = priv.seat === frame.actor;
    const out = privateExchange(priv, { [actor ? offered : returned]: 1 }, false);
    return out.ok ? privateExchange(out.value, { [actor ? returned : offered]: 1 }, true) : out;
  },
};

export const harborPhase: PhaseHandler = {
  pending: (state) => {
    const frame = replyData(state);
    return withClaim(
      state,
      frame ? [playerPending(state, frame.seat, ['HARBOR_REPLY'], HARBOR_FRAME)] : [],
    );
  },
  legalCommands: (state, _frame, seat, priv, ctx) => {
    const claim = claimCommands(state, seat, priv, ctx);
    if (replyData(state)?.seat !== seat) return claim;
    const held = priv ? COMMODITIES.filter((kind) => (priv.hand[kind] ?? 0) > 0) : [];
    const commands: CommandShape[] = priv
      ? held.length
        ? held.map((commodity) => ({ type: 'HARBOR_REPLY', commodity }))
        : [{ type: 'HARBOR_REPLY', commodity: 'none' }]
      : [];
    return {
      commands: [...commands, ...claim.commands],
      templates: priv
        ? claim.templates
        : [...claim.templates, { type: 'HARBOR_REPLY', commodity: 'own commodity or none' }],
    };
  },
};

/** Offers the player can make: one resource it holds to each seat that may hold a commodity. */
function legalOffers(
  state: GameState,
  seat: Seat,
  priv: PrivateState | undefined,
): { commands: CommandShape[]; templates: { type: string; [key: string]: unknown }[] } {
  const where = slotOf(state);
  if (where?.slot !== 'main' || where.seat !== seat) return { commands: [], templates: [] };
  const targets = offerTargets(state, seat);
  if (!priv)
    return {
      commands: [],
      templates: targets.map((to) => ({ type: 'HARBOR_OFFER', to, resource: 'own resource' })),
    };
  return {
    commands: targets.flatMap((to) =>
      RESOURCES.filter((resource) => (priv.hand[resource] ?? 0) > 0).map((resource) => ({
        type: 'HARBOR_OFFER',
        to,
        resource,
      })),
    ),
    templates: [],
  };
}

const flow: CardFlow = {
  commands: { HARBOR_OFFER: harborOffer, HARBOR_REPLY: harborReply },
  phases: { [HARBOR_FRAME]: harborPhase },
  legal: (state, seat, priv) => legalOffers(state, seat, priv),
  mainCommands: (state, seat) => (offerTargets(state, seat).length > 0 ? ['HARBOR_OFFER'] : []),
  timeout: (state, request) => {
    const frame = replyData(state);
    if (request.phase !== HARBOR_FRAME || frame?.seat !== request.seat) return null;
    const bounds = kindBounds(ownSeat(state, request.seat).resources);
    if (cardKindsOf(state).some((kind) => (bounds.min[kind] ?? 0) !== (bounds.max[kind] ?? 0)))
      return null;
    const commodity = COMMODITIES.find((kind) => (bounds.min[kind] ?? 0) > 0);
    return { type: 'HARBOR_REPLY', commodity: commodity ?? 'none' };
  },
};

/**
 * Commercial Harbor: for the rest of the turn, offer each other seat (at most once per harbor
 * played) one resource card face down. The seat gives back one commodity of its own choice, or
 * returns the offer when it has none. The card is spent even if nobody had a commodity.
 */
export const commercialHarbor: CardModule = {
  card: plainCard({
    id: 'commercialHarbor',
    timing: 'main',
    problem: (state, seat) => {
      const someone = state.config.seats.some(
        (other) => other !== seat && mayHoldCommodity(state, other),
      );
      return someone && mayHoldResource(state, seat)
        ? success(undefined)
        : failure('no-trade', 'Nobody could take part in the swap');
    },
    apply: (state, seat) => {
      const old = knightsExt(state).harbor;
      return changed(
        updateKnights(state, (ext) => ({
          ...ext,
          harbor: {
            seat,
            cards: old?.seat === seat ? old.cards + 1 : 1,
            offered: old?.seat === seat ? old.offered : [],
          },
        })),
        { type: 'harborOpened', seat },
      );
    },
  }),
  flow,
};

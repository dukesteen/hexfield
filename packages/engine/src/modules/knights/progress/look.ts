import type { PhaseHandler, SystemInputHandler } from '../../../core/modules/index.js';
import type { GameState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { Seat } from '../../../core/types/index.js';
import { claimCommands } from '../../base/legal.js';
import { updateSeat, withClaim } from '../../base/shared.js';
import { frameData, popPhase, replaceKnights } from './frames.js';
import { findSlot } from './hand.js';
import { movable, moveCards, movePrivate, parseCards } from './transfer.js';
import { trackOfDeck } from './catalogue.js';

export const LOOK_FRAME = 'look';

/**
 * A seat looks at another seat's hidden cards and takes some. The target shows them to the actor
 * alone (a `reveal` pending answered by `SHOW_HAND`, whose content is private input data), then
 * the actor answers a second `reveal` pending with what it takes.
 */
export interface LookData {
  what: 'cards' | 'progress';
  actor: Seat;
  target: Seat;
  stage: 'show' | 'take';
  /** Cards the actor takes (Master Merchant); unused for progress cards. */
  count: number;
}

export function lookData(state: GameState): LookData | undefined {
  return frameData<LookData>(state, LOOK_FRAME);
}

export const lookPhase: PhaseHandler = {
  pending: (state) => {
    const look = lookData(state);
    if (look === undefined) return withClaim(state, []);
    return withClaim(state, [
      look.stage === 'show'
        ? {
            kind: 'reveal',
            seat: look.target,
            request: { type: 'showHand', to: look.actor, what: look.what },
            systemType: 'SHOW_HAND',
          }
        : look.what === 'cards'
          ? {
              kind: 'reveal',
              seat: look.actor,
              request: { type: 'takeCards', from: look.target, count: look.count },
              systemType: 'TAKE_CARDS',
            }
          : {
              kind: 'reveal',
              seat: look.actor,
              request: { type: 'takeProgress', from: look.target },
              systemType: 'TAKE_PROGRESS',
            },
    ]);
  },
  legalCommands: (state, _frame, seat, priv, ctx) => claimCommands(state, seat, priv, ctx),
};

/** The target shows its hidden cards to the actor. The public input carries nothing secret. */
export const showHand: SystemInputHandler = {
  keys: { allowed: ['seat', 'to', 'what'] },
  validate: (state, input) => {
    const look = lookData(state);
    return look?.stage === 'show' &&
      input.seat === look.target &&
      input.to === look.actor &&
      input.what === look.what
      ? success(undefined)
      : failure('show-mismatch', 'This is not the hand the actor asked to see');
  },
  apply: (state) => {
    const look = lookData(state);
    if (look === undefined) throw new Error('Validated look missing');
    return {
      state: replaceKnights(state, LOOK_FRAME, { ...look, stage: 'take' }),
      events: [{ type: 'handShown', seat: look.target, to: look.actor, what: look.what }],
      effects: [],
    };
  },
  // The shown cards are not kept anywhere: the actor uses them to choose and names its choice in
  // the next input. Delivering them is the transport's job (private input data `{ hand }` or
  // `{ progress }`), so nothing here depends on them.
};

/** The actor takes cards from the shown hand (Master Merchant). */
export const takeCards: SystemInputHandler = {
  keys: { allowed: ['seat', 'from', 'cards'] },
  validate: (state, input) => {
    const look = lookData(state);
    if (
      look?.what !== 'cards' ||
      look.stage !== 'take' ||
      input.seat !== look.actor ||
      input.from !== look.target
    )
      return failure('take-mismatch', 'No cards are waiting to be taken from that seat');
    const cards = parseCards(state, input.cards);
    return cards.ok ? movable(state, look.target, cards.value, look.count) : cards;
  },
  apply: (state, input) => {
    const look = lookData(state);
    const cards = parseCards(state, input.cards);
    if (look === undefined || !cards.ok) throw new Error('Validated take missing');
    const moved = moveCards(state, look.target, look.actor, cards.value, look.count);
    return {
      state: popPhase(moved.state),
      events: [{ type: 'cardsTaken', seat: look.actor, from: look.target, count: look.count }],
      effects: moved.effects,
    };
  },
  applyPrivate: (priv, before, input, data) => {
    const look = lookData(before);
    const cards = parseCards(before, input.cards);
    if (look === undefined || !cards.ok) return failure('take-mismatch', 'No take is open');
    return movePrivate(priv, before, look.target, look.actor, cards.value, look.count, data);
  },
};

/** The actor takes one progress card from the target's hand, or none (Spy). */
export const takeProgress: SystemInputHandler = {
  keys: { allowed: ['seat', 'from', 'slotId', 'card'], optional: ['card'] },
  validate: (state, input) => {
    const look = lookData(state);
    if (
      look?.what !== 'progress' ||
      look.stage !== 'take' ||
      input.seat !== look.actor ||
      input.from !== look.target
    )
      return failure('take-mismatch', 'No progress card is waiting to be taken from that seat');
    if (input.slotId === null) return success(undefined);
    const slot = findSlot(state, look.target, input.slotId);
    if (slot === undefined || slot.revealed !== undefined || trackOfDeck(slot.deck) === null)
      return failure('invalid-slot', 'That is not a progress card in the target’s hand');
    if (input.card !== undefined && typeof input.card !== 'string')
      return failure('invalid-card', 'The card identity must be a card name');
    if (slot.known !== undefined && input.card !== undefined && input.card !== slot.known)
      return failure('card-mismatch', 'That slot holds another card');
    return success(undefined);
  },
  apply: (state, input) => {
    const look = lookData(state);
    if (look === undefined) throw new Error('Validated take missing');
    if (input.slotId === null)
      return {
        state: popPhase(state),
        events: [{ type: 'spyTookNothing', seat: look.actor }],
        effects: [],
      };
    const slot = findSlot(state, look.target, input.slotId);
    if (slot === undefined) throw new Error('Validated slot missing');
    let next = updateSeat(popPhase(state), look.target, (old) => ({
      ...old,
      cardSlots: old.cardSlots.filter((held) => held.slotId !== slot.slotId),
    }));
    next = updateSeat(next, look.actor, (old) => ({ ...old, cardSlots: [...old.cardSlots, slot] }));
    return {
      state: next,
      events: [{ type: 'progressCardTaken', seat: look.actor, from: look.target }],
      effects: [
        {
          type: 'card-slot-moved',
          from: look.target,
          to: look.actor,
          deck: slot.deck,
          slotId: slot.slotId,
        },
      ],
    };
  },
  applyPrivate: (priv, before, input, data) => {
    const look = lookData(before);
    if (look === undefined) return failure('take-mismatch', 'No take is open');
    if (input.slotId === null || typeof input.slotId !== 'string') return success(priv);
    const slot = findSlot(before, look.target, input.slotId);
    if (slot === undefined) return failure('invalid-slot', 'The taken slot is missing');
    if (priv.seat === look.target) {
      return success({
        ...priv,
        slots: Object.fromEntries(Object.entries(priv.slots).filter(([id]) => id !== slot.slotId)),
      });
    }
    if (priv.seat !== look.actor || slot.known !== undefined) return success(priv);
    const card = input.card ?? data?.card;
    return typeof card === 'string' && trackOfDeck(slot.deck) !== null
      ? success({ ...priv, slots: { ...priv.slots, [slot.slotId]: card } })
      : failure('missing-private-card', 'The actor must learn the taken card');
  },
};

import { failure, knightsLook, success } from '@cp2p/engine';
import type { GameState, Input, Result, Seat } from '@cp2p/engine';
import { slotHolder, validateDeckLedger } from './deck-ledger.js';
import type { DeckLedger, LedgerDeck, LedgerSlot } from './deck-ledger.js';
import type { HandTransitionPlan, SlotMove } from './hand-transition.js';
import {
  spyRequestSchema,
  spyUnlockSchema,
  verifySpyRequest,
  verifySpyUnlock,
} from './spy-look.js';
import type { SpyLook } from './spy-look.js';
import { parseCanonical } from './validation.js';
import type { DeckRevealContext } from './deck-draw.js';
import { preproofNeed } from './preproof.js';

/**
 * The steps of a private look at another seat's hidden cards (the Spy and the Master Merchant).
 * `spy-request` is the actor's play, `spy-unlock` the target's answer and `spy-take` the actor's
 * choice; the Master Merchant's `hand-show` is the target's sealed opening and `hand-take` the
 * actor's take, proven with the opening it received.
 */
export type LookStep =
  | 'spy-request'
  | 'spy-unlock'
  | 'spy-take'
  | 'hand-show'
  | 'hand-take'
  | 'harbor-offer';

/** Which look step an input is, derived only from the engine's own transition. */
export function lookStep(input: Input, after: GameState): LookStep | null {
  if (input.kind === 'command') {
    if (input.command.type === 'HARBOR_OFFER') return 'harbor-offer';
    if (input.command.type !== 'PLAY_PROGRESS_CARD') return null;
    const look = knightsLook(after);
    return look?.what === 'progress' && look.stage === 'show' && look.actor === input.seat
      ? 'spy-request'
      : null;
  }
  switch (input.type) {
    case 'SHOW_HAND':
      return input.what === 'progress' ? 'spy-unlock' : 'hand-show';
    case 'TAKE_PROGRESS':
      return 'spy-take';
    case 'TAKE_CARDS':
      return 'hand-take';
    default:
      return null;
  }
}

/**
 * Whether an input's evidence includes a `look` section: a Spy's request and unlock, a Master
 * Merchant's sealed hand, and a Commercial Harbor offer whose card public bounds do not vouch for.
 */
export function stepHasEvidence(step: LookStep | null, before: GameState, input: Input): boolean {
  if (step === 'harbor-offer') return preproofNeed(before, input) !== null;
  return step === 'spy-request' || step === 'spy-unlock' || step === 'hand-show';
}

/**
 * The hidden slots a seat holds, in the ledger's canonical order (deck id, then deal order).
 * Slots with a public identity are not in the ledger and need no lock.
 */
export function hiddenSlotsOf(
  ledger: DeckLedger,
  state: GameState,
  seat: Seat,
): { deck: LedgerDeck; slot: LedgerSlot }[] {
  const held = state.seats.find((item) => item.seat === seat)?.cardSlots ?? [];
  return ledger.decks.flatMap((deck) =>
    deck.slots.flatMap((slot) => {
      const pub = held.find((item) => item.slotId === slot.slotId);
      return slot.seat === seat && pub && pub.revealed === undefined && pub.known === undefined
        ? [{ deck, slot }]
        : [];
    }),
  );
}

/** The actor's request: a lock for every hidden card the target holds. */
export function openSpyLook(
  ledger: DeckLedger,
  before: GameState,
  after: GameState,
  action: DeckRevealContext,
  evidence: unknown,
): Result<DeckLedger> {
  const current = validateDeckLedger(ledger);
  if (!current.ok) return current;
  if (current.value.spy) return failure('spy-open', 'Another Spy look is already open');
  const look = knightsLook(after);
  if (!look || look.what !== 'progress' || look.stage !== 'show' || look.actor !== action.seat)
    return failure('spy-context', 'The play does not open a Spy look');
  const parsed = parseCanonical(evidence, spyRequestSchema);
  if (!parsed.ok) return parsed;
  const hidden = hiddenSlotsOf(current.value, before, look.target);
  if (hidden.length !== parsed.value.slots.length)
    return failure('spy-request-slots', 'A Spy request must cover every hidden card of its target');
  const slots: SpyLook['slots'][number][] = [];
  for (const [index, { deck, slot }] of hidden.entries()) {
    const item = parsed.value.slots[index];
    if (!item) return failure('spy-request-slots', 'A Spy request is missing a card');
    const checked = verifySpyRequest(slotHolder(slot), item, {
      action,
      deckId: deck.commitment.definition.deckId,
      slotId: slot.slotId,
    });
    if (!checked.ok) return checked;
    slots.push({
      slotId: slot.slotId,
      deck: deck.commitment.definition.deckId,
      key: checked.value.key,
      masked: checked.value.masked,
    });
  }
  return validateDeckLedger({
    ...current.value,
    spy: {
      actor: look.actor,
      target: look.target,
      request: { seq: action.anchor.seq, hash: action.anchor.hash },
      slots,
    },
  });
}

/** The target's answer: it removes its own lock from every masked card. */
export function unlockSpyLook(
  ledger: DeckLedger,
  action: DeckRevealContext,
  evidence: unknown,
): Result<DeckLedger> {
  const current = validateDeckLedger(ledger);
  if (!current.ok) return current;
  const spy = current.value.spy;
  if (!spy || spy.target !== action.seat || spy.slots.some((item) => item.point !== undefined))
    return failure('spy-unlock-state', 'No Spy look awaits this seat’s unlock');
  const parsed = parseCanonical(evidence, spyUnlockSchema);
  if (!parsed.ok) return parsed;
  if (parsed.value.slots.length !== spy.slots.length)
    return failure('spy-unlock-slots', 'An unlock must cover every requested card');
  const slots: SpyLook['slots'][number][] = [];
  for (const [index, requested] of spy.slots.entries()) {
    const item = parsed.value.slots[index];
    const deck = current.value.decks.find(
      (candidate) => candidate.commitment.definition.deckId === requested.deck,
    );
    const slot = deck?.slots.find((candidate) => candidate.slotId === requested.slotId);
    if (!item || !slot) return failure('spy-unlock-slots', 'An unlock is missing a card');
    const checked = verifySpyUnlock(
      slotHolder(slot),
      requested.masked,
      item,
      requested.slotId,
      spy.request,
      action,
    );
    if (!checked.ok) return checked;
    slots.push({ ...requested, point: checked.value.point });
  }
  return validateDeckLedger({ ...current.value, spy: { ...spy, slots } });
}

/**
 * The actor's choice: the slot it takes becomes its own, locked under the key it requested, or
 * nothing is taken. Either way the look is over.
 */
export function takeSpySlot(ledger: DeckLedger, moves: readonly SlotMove[]): Result<DeckLedger> {
  const current = validateDeckLedger(ledger);
  if (!current.ok) return current;
  const spy = current.value.spy;
  if (!spy || spy.slots.some((item) => item.point === undefined))
    return failure('spy-take-state', 'The target has not unlocked its cards for this Spy');
  const { spy: _closed, ...rest } = current.value;
  if (moves.length === 0) return validateDeckLedger(rest);
  const move = moves[0];
  if (moves.length !== 1 || !move || move.from !== spy.target || move.to !== spy.actor)
    return failure('spy-take-move', 'A Spy takes at most one card from its target');
  const requested = spy.slots.find((item) => item.slotId === move.slotId);
  const decks = rest.decks.map((deck) => ({
    ...deck,
    slots: deck.slots.map((slot) =>
      slot.slotId === move.slotId && requested?.point !== undefined
        ? {
            ...slot,
            seat: spy.actor,
            relock: { point: requested.point, lockKey: requested.key, request: spy.request },
          }
        : slot,
    ),
  }));
  // A card whose identity is public was never locked, so only the public state moves it.
  if (
    !requested &&
    rest.decks.some((deck) => deck.slots.some((slot) => slot.slotId === move.slotId))
  )
    return failure('spy-take-slot', 'The taken card was not part of the Spy request');
  return validateDeckLedger({ ...rest, decks });
}

/** Fold the ledger consequences of one look step, after its proofs verified. */
export function applyLook(
  ledger: DeckLedger,
  step: LookStep | null,
  before: GameState,
  after: GameState,
  plan: HandTransitionPlan,
  action: DeckRevealContext,
  evidence: unknown,
): Result<DeckLedger> {
  if (step === 'spy-request') return openSpyLook(ledger, before, after, action, evidence);
  if (step === 'spy-unlock') return unlockSpyLook(ledger, action, evidence);
  if (step === 'spy-take') return takeSpySlot(ledger, plan.moves);
  // The Master Merchant's show and take and a Harbor offer change no deck slot.
  return success(ledger);
}

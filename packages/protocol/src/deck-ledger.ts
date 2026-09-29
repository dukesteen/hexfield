import { hashValue, toHex } from '@cp2p/codec';
import { parsePeerId } from '@cp2p/crypto';
import { decksFor, failure, publicDrawInput, success } from '@cp2p/engine';
import type { GameState, Result, Seat, SystemInput } from '@cp2p/engine';
import * as v from 'valibot';
import {
  completeDeckDraw,
  decodePublicDeckCard,
  deckUnlockers,
  freezeDeckDraw,
  validateDeckDrawOperation,
  verifyDeckReveal,
  deckUnlockSchema,
} from './deck-draw.js';
import type { DealtDeckCard, DeckDrawOperation } from './deck-draw.js';
import { ceremonyDeckIds, deckPassHash, validateDeckGenesisCommitments } from './deck-genesis.js';
import type { DeckGenesisCommitment } from './deck-genesis.js';
import { genesisDigest } from './genesis.js';
import { applyDeckPass, initDeckSetup, validateDeckSetupState } from './deck-setup.js';
import type { DeckSetupState } from './deck-setup.js';
import { hashSchema, key32Schema, nonnegativeIntegerSchema, seatSchema } from './schema-values.js';
import type { Genesis, SignedCommand } from './types.js';
import { parseCanonical } from './validation.js';
import type { EntryRef } from './beacon-state.js';
import type { RandomPending } from './random-derivations.js';
import type { ArtifactSigner } from './authority-types.js';

export const DECK_DRAW_PROTOCOL = 'deck-draw-v1';
export const DECK_REVEAL_PROTOCOL = 'deck-reveal-v1';

const MAX_DECKS = 32;
const MAX_CARDS = 128;
const labelSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
const positionSchema = v.pipe(nonnegativeIntegerSchema, v.maxValue(MAX_CARDS));
const entryRefSchema = v.strictObject({ seq: nonnegativeIntegerSchema, hash: hashSchema });
const commitmentSchema = v.strictObject({
  definition: v.unknown(),
  passHashes: v.pipe(v.array(hashSchema), v.maxLength(12)),
  finalStateHash: hashSchema,
});
const slotSchema = v.strictObject({
  slotId: labelSchema,
  seat: seatSchema,
  receipt: v.unknown(),
  deal: entryRefSchema,
  unlockSigners: v.pipe(
    v.array(
      v.strictObject({ seat: seatSchema, publicKey: key32Schema, generation: entryRefSchema }),
    ),
    v.maxLength(6),
  ),
});
const deckSchema = v.strictObject({
  commitment: commitmentSchema,
  setup: v.unknown(),
  nextPass: v.pipe(nonnegativeIntegerSchema, v.maxValue(12)),
  nextPosition: positionSchema,
  slots: v.pipe(v.array(slotSchema), v.maxLength(MAX_CARDS)),
});
const ledgerSchema = v.strictObject({
  genesisDigest: key32Schema,
  decks: v.pipe(v.array(deckSchema), v.maxLength(MAX_DECKS)),
  active: v.nullable(v.unknown()),
});
const proofSchema = v.strictObject({
  commitments: v.tuple([key32Schema, key32Schema]),
  response: key32Schema,
});
const receiptSchema = v.strictObject({
  operation: v.unknown(),
  point: key32Schema,
  unlocks: v.pipe(v.array(deckUnlockSchema), v.maxLength(6)),
});
const drawFields = {
  deck: labelSchema,
  seat: seatSchema,
  slotId: labelSchema,
  remaining: positionSchema,
};
const drawPendingSchema = v.union([
  v.strictObject({
    kind: v.literal('random'),
    request: v.strictObject({ type: v.literal('draw'), ...drawFields }),
    systemType: v.literal('CARD_DEALT'),
  }),
  // A public draw echoes its request under a module-owned system input, so extras are allowed.
  v.strictObject({
    kind: v.literal('random'),
    request: v.looseObject({ type: v.literal('draw'), ...drawFields, public: v.literal(true) }),
    systemType: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(64),
      v.check((type) => type !== 'CARD_DEALT'),
    ),
  }),
]);
const dealInputSchema = v.strictObject({
  kind: v.literal('system'),
  type: v.literal('CARD_DEALT'),
  deck: labelSchema,
  seat: seatSchema,
  slotId: labelSchema,
});
const dealEvidenceSchema = v.strictObject({
  kind: v.literal('proof'),
  protocol: v.literal(DECK_DRAW_PROTOCOL),
  data: v.pipe(v.array(deckUnlockSchema), v.maxLength(6)),
});
const revealEvidenceSchema = v.strictObject({
  protocol: v.literal(DECK_REVEAL_PROTOCOL),
  data: v.pipe(
    v.array(v.strictObject({ slotId: labelSchema, identity: labelSchema, proof: proofSchema })),
    v.minLength(1),
    v.maxLength(MAX_CARDS),
  ),
});
const passEvidenceSchema = v.strictObject({ deckId: labelSchema, pass: v.unknown() });

export interface LedgerSlot {
  slotId: string;
  seat: Seat;
  receipt: DealtDeckCard;
  deal: EntryRef;
  /** Signers verified at the certified deal, retained across later controller changes. */
  unlockSigners: readonly ArtifactSigner[];
}

export interface LedgerDeck {
  commitment: DeckGenesisCommitment;
  setup: DeckSetupState;
  nextPass: number;
  nextPosition: number;
  /** Only still-hidden slots remain; historical IDs are in the public engine state. */
  slots: readonly LedgerSlot[];
}

export interface DeckLedger {
  genesisDigest: string;
  decks: readonly LedgerDeck[];
  active: DeckDrawOperation | null;
}

function same(left: unknown, right: unknown): boolean {
  return toHex(hashValue(left)) === toHex(hashValue(right));
}

function lockedHash(setup: DeckSetupState): string {
  return toHex(hashValue({ domain: 'cp2p/v1/locked-deck', deck: setup }));
}

function ready(deck: LedgerDeck): boolean {
  return deck.nextPass === deck.commitment.passHashes.length;
}

function checkedOperation(setup: DeckSetupState, operation: DeckDrawOperation): boolean {
  const expected = freezeDeckDraw(setup, {
    genesisDigest: operation.genesisDigest,
    epoch: operation.epoch,
    anchor: operation.anchor,
    position: operation.position,
    seat: operation.seat,
    slotId: operation.slotId,
    ...(operation.public ? { public: true as const } : {}),
  });
  return expected.ok && same(expected.value, operation);
}

/** Canonical, bounded shape check; only certified replay makes a ledger authoritative. */
export function validateDeckLedger(value: unknown): Result<DeckLedger> {
  const parsed = parseCanonical(value, ledgerSchema);
  if (!parsed.ok) return parsed;
  const decks: LedgerDeck[] = [];
  const allSlots = new Set<string>();
  let previousId = '';
  for (const item of parsed.value.decks) {
    const setup = validateDeckSetupState(item.setup);
    if (!setup.ok) return setup;
    const definition = setup.value.definition;
    if (
      !same(item.commitment.definition, definition) ||
      definition.deckId <= previousId ||
      item.commitment.passHashes.length !== definition.participants.length * 2 ||
      new Set(item.commitment.passHashes).size !== item.commitment.passHashes.length ||
      item.nextPass !== setup.value.shuffleKeys.length + setup.value.lockKeys.length ||
      item.nextPass > item.commitment.passHashes.length ||
      item.nextPosition > definition.cards.length
    )
      return failure('deck-ledger-shape', 'Deck cursor or definition is inconsistent');
    if (
      item.nextPass === item.commitment.passHashes.length &&
      lockedHash(setup.value) !== item.commitment.finalStateHash
    )
      return failure('deck-ledger-final', 'Final locked deck differs from genesis');
    previousId = definition.deckId;
    const slots: LedgerSlot[] = [];
    let previousPosition = -1;
    for (const slot of item.slots) {
      const parsedReceipt = parseCanonical(slot.receipt, receiptSchema);
      if (!parsedReceipt.ok) return parsedReceipt;
      const operation = validateDeckDrawOperation(parsedReceipt.value.operation);
      if (!operation.ok) return operation;
      const unlockers = deckUnlockers(operation.value);
      if (
        operation.value.public ||
        item.nextPass !== item.commitment.passHashes.length ||
        operation.value.deckId !== definition.deckId ||
        operation.value.genesisDigest !== parsed.value.genesisDigest ||
        operation.value.slotId !== slot.slotId ||
        operation.value.seat !== slot.seat ||
        operation.value.position <= previousPosition ||
        operation.value.position >= item.nextPosition ||
        slot.deal.seq <= operation.value.anchor.seq ||
        allSlots.has(slot.slotId) ||
        slot.unlockSigners.length !== unlockers.length ||
        slot.unlockSigners.some(
          (signer, index) =>
            signer.seat !== unlockers[index]?.seat || signer.generation.seq >= slot.deal.seq,
        ) ||
        new Set(slot.unlockSigners.map(({ publicKey }) => publicKey)).size !== unlockers.length ||
        !checkedOperation(setup.value, operation.value)
      )
        return failure('deck-ledger-slot', 'Unrevealed slot is inconsistent with its deck');
      try {
        for (const signer of slot.unlockSigners) parsePeerId(signer.publicKey);
      } catch {
        return failure('deck-ledger-signer', 'A historical unlock signing key is invalid');
      }
      previousPosition = operation.value.position;
      allSlots.add(slot.slotId);
      slots.push({
        slotId: slot.slotId,
        seat: slot.seat,
        receipt: { ...parsedReceipt.value, operation: operation.value },
        deal: slot.deal,
        unlockSigners: slot.unlockSigners,
      });
    }
    decks.push({
      commitment: { ...item.commitment, definition },
      setup: setup.value,
      nextPass: item.nextPass,
      nextPosition: item.nextPosition,
      slots,
    });
  }
  let active: DeckDrawOperation | null = null;
  if (parsed.value.active !== null) {
    const operation = validateDeckDrawOperation(parsed.value.active);
    if (!operation.ok) return operation;
    const deck = decks.find((item) => item.commitment.definition.deckId === operation.value.deckId);
    if (
      !deck ||
      !ready(deck) ||
      operation.value.genesisDigest !== parsed.value.genesisDigest ||
      operation.value.position !== deck.nextPosition ||
      allSlots.has(operation.value.slotId) ||
      !checkedOperation(deck.setup, operation.value)
    )
      return failure('deck-ledger-active', 'Active draw differs from its locked deck');
    active = operation.value;
  }
  return success({ genesisDigest: parsed.value.genesisDigest, decks, active });
}

/** Genesis must already be certified; this crosschecks every public deck at height zero. */
export function initializeDeckLedger(genesis: Genesis, state: GameState): Result<DeckLedger> {
  const commitments = validateDeckGenesisCommitments(genesis);
  if (!commitments.ok) return commitments;
  const expectedIds = commitments.value.map(({ definition }) => definition.deckId);
  // Decks a module declares empty carry no ceremony; the engine still keeps their counter.
  const engineIds = Object.keys(state.decks).filter((id) =>
    ceremonyDeckIds(state.config).includes(id),
  );
  if (
    engineIds.length !== expectedIds.length ||
    expectedIds.some((id) => !Object.hasOwn(state.decks, id))
  )
    return failure('deck-genesis-state', 'Engine decks differ from signed genesis');
  const decks: LedgerDeck[] = [];
  for (const commitment of commitments.value) {
    const id = commitment.definition.deckId;
    const publicDeck = state.decks[id];
    if (
      !publicDeck ||
      publicDeck.remaining !== commitment.definition.cards.length ||
      publicDeck.drawn.length !== 0
    )
      return failure('deck-genesis-state', 'Engine deck count is not at genesis');
    const initial = initDeckSetup(commitment.definition);
    if (!initial.ok) return initial;
    decks.push({ commitment, setup: initial.value, nextPass: 0, nextPosition: 0, slots: [] });
  }
  return validateDeckLedger({
    genesisDigest: genesisDigest(genesis),
    decks,
    active: null,
  });
}

/** Readiness of an already validated, replay-derived ledger, never a peer-supplied object. */
export function decksReady(ledger: DeckLedger): boolean {
  return ledger.decks.every(ready);
}

/** One certified signed pass advances only the first incomplete deck. */
export function applyDeckSetupEntry(ledger: DeckLedger, evidence: unknown): Result<DeckLedger> {
  const current = validateDeckLedger(ledger);
  if (!current.ok) return current;
  const parsed = parseCanonical(evidence, passEvidenceSchema);
  if (!parsed.ok) return parsed;
  if (current.value.active)
    return failure('deck-pass-draw', 'A deck pass cannot replace an active draw');
  const index = current.value.decks.findIndex((deck) => !ready(deck));
  const deck = current.value.decks[index];
  if (!deck || deck.commitment.definition.deckId !== parsed.value.deckId)
    return failure('deck-pass-order', 'Deck pass is not for the first incomplete deck');
  try {
    // applyDeckPass performs the signed-pass shape and proof validation below.
    if (deckPassHash(parsed.value.pass) !== deck.commitment.passHashes[deck.nextPass])
      return failure('deck-pass-commitment', 'Deck pass differs from signed genesis');
  } catch {
    return failure('deck-pass-commitment', 'Deck pass cannot be hashed');
  }
  const applied = applyDeckPass(deck.setup, parsed.value.pass);
  if (!applied.ok) return applied;
  const nextPass = deck.nextPass + 1;
  if (
    nextPass === deck.commitment.passHashes.length &&
    lockedHash(applied.value) !== deck.commitment.finalStateHash
  )
    return failure('deck-pass-final', 'Locked deck differs from signed genesis');
  const decks = current.value.decks.map((item, at) =>
    at === index ? { ...item, setup: applied.value, nextPass } : item,
  );
  return validateDeckLedger({ ...current.value, decks });
}

interface DrawRequest {
  deck: string;
  seat: Seat;
  slotId: string;
  remaining: number;
  public: boolean;
  pending: RandomPending;
}

function drawPending(value: RandomPending | null): Result<DrawRequest> {
  const parsed = parseCanonical(value, drawPendingSchema);
  if (!parsed.ok) return parsed;
  const { request } = parsed.value;
  return success({
    deck: request.deck,
    seat: request.seat,
    slotId: request.slotId,
    remaining: request.remaining,
    public: 'public' in request,
    // Retained exactly as certified: the public answer echoes every request field.
    pending: parsed.value,
  });
}

/** The reveal mode the game's modules declare for a deck; a draw must use exactly that mode. */
function declaredReveal(state: GameState, deckId: string): 'private' | 'public' | null {
  try {
    const decks = decksFor(state.config);
    return Object.hasOwn(decks, deckId) ? (decks[deckId]?.reveal ?? null) : null;
  } catch {
    return null;
  }
}

function publicDeckMatches(deck: LedgerDeck, state: GameState): boolean {
  const publicDeck = state.decks[deck.commitment.definition.deckId];
  const count = deck.commitment.definition.cards.length;
  if (
    !publicDeck ||
    publicDeck.remaining !== count - deck.nextPosition ||
    publicDeck.drawn.length !== deck.nextPosition
  )
    return false;
  const seen = new Set<string>();
  for (const slot of publicDeck.drawn) {
    if (
      typeof slot.slotId !== 'string' ||
      slot.slotId.length === 0 ||
      slot.seat < 0 ||
      slot.seat > 5 ||
      seen.has(slot.slotId)
    )
      return false;
    seen.add(slot.slotId);
  }
  return true;
}

/** Freeze the engine's current draw request once, at its certified parent. */
export function captureDeckPending(
  ledger: DeckLedger,
  state: GameState,
  pending: RandomPending | null,
  anchor: EntryRef,
  epoch: number,
): Result<DeckLedger> {
  const current = validateDeckLedger(ledger);
  if (!current.ok) return current;
  if (pending?.request.type !== 'draw')
    return current.value.active
      ? failure('deck-request-changed', 'An unfinished draw request cannot change')
      : current;
  const request = drawPending(pending);
  if (!request.ok) return request;
  const deck = current.value.decks.find(
    (item) => item.commitment.definition.deckId === request.value.deck,
  );
  if (
    !deck ||
    !decksReady(current.value) ||
    !publicDeckMatches(deck, state) ||
    request.value.remaining !== deck.commitment.definition.cards.length - deck.nextPosition
  )
    return failure('deck-request-state', 'Draw request differs from the certified deck cursor');
  if (declaredReveal(state, request.value.deck) !== (request.value.public ? 'public' : 'private'))
    return failure(
      'deck-reveal-mode',
      'Draw request differs from the reveal mode its deck declares',
    );
  const { seat, slotId } = request.value;
  if (state.decks[request.value.deck]?.drawn.some((slot) => slot.slotId === slotId))
    return failure('deck-slot-reused', 'The requested slot was already dealt');
  if (current.value.active) {
    const active = current.value.active;
    return active.deckId === request.value.deck &&
      active.seat === seat &&
      active.slotId === slotId &&
      (active.public === true) === request.value.public &&
      active.position === deck.nextPosition
      ? current
      : failure('deck-request-changed', 'An unfinished draw request cannot change');
  }
  const operation = freezeDeckDraw(deck.setup, {
    genesisDigest: current.value.genesisDigest,
    epoch,
    anchor,
    position: deck.nextPosition,
    seat,
    slotId,
    ...(request.value.public ? { public: true as const } : {}),
  });
  return operation.ok
    ? validateDeckLedger({ ...current.value, active: operation.value })
    : operation;
}

/** Evidence is the full proof envelope; data contains only the ordered unlocks. */
export function completeDeckDeal(
  ledger: DeckLedger,
  state: GameState,
  pending: RandomPending | null,
  input: SystemInput,
  evidence: unknown,
  deal: EntryRef,
  signers: readonly ArtifactSigner[],
): Result<DeckLedger> {
  const current = validateDeckLedger(ledger);
  if (!current.ok) return current;
  const active = current.value.active;
  if (!active) return failure('deck-draw-absent', 'No certified deck draw is active');
  const request = drawPending(pending);
  if (!request.ok) return request;
  const proof = parseCanonical(evidence, dealEvidenceSchema);
  if (!proof.ok) return proof;
  const deckIndex = current.value.decks.findIndex(
    (item) => item.commitment.definition.deckId === active.deckId,
  );
  const deck = current.value.decks[deckIndex];
  if (
    !deck ||
    !publicDeckMatches(deck, state) ||
    request.value.deck !== active.deckId ||
    request.value.seat !== active.seat ||
    request.value.slotId !== active.slotId ||
    request.value.public !== (active.public === true) ||
    request.value.remaining !== deck.commitment.definition.cards.length - deck.nextPosition ||
    active.position !== deck.nextPosition ||
    deal.seq <= active.anchor.seq
  )
    return failure('deck-deal-context', 'Deal does not match the frozen request');
  const receipt = completeDeckDraw(active, proof.value.data, signers);
  if (!receipt.ok) return receipt;
  if (active.public) {
    // The revealed card is public: every peer decodes it from the verified unlock chain and the
    // certified input must be exactly the echo of the request naming that card.
    const revealed = decodePublicDeckCard(deck.setup, receipt.value, signers);
    if (!revealed.ok) return revealed;
    if (!same(input, publicDrawInput(request.value.pending, revealed.value.card)))
      return failure('deck-reveal-input', 'Public draw input differs from the verified reveal');
  } else {
    const dealt = parseCanonical(input, dealInputSchema);
    if (!dealt.ok) return dealt;
    if (
      dealt.value.deck !== active.deckId ||
      dealt.value.seat !== active.seat ||
      dealt.value.slotId !== active.slotId
    )
      return failure('deck-deal-context', 'Deal does not match the frozen request');
  }
  // This projection is produced only after the log resolves the authorized keys
  // and verifies every unlock. Later reveals must use these historical keys,
  // not the genesis roster or the controllers active when the card is played.
  const decks = current.value.decks.map((item, index) =>
    index === deckIndex
      ? {
          ...item,
          nextPosition: item.nextPosition + 1,
          // A public card is shown to everyone, so no hidden slot remains to reveal later.
          slots: active.public
            ? item.slots
            : [
                ...item.slots,
                {
                  slotId: active.slotId,
                  seat: active.seat,
                  receipt: receipt.value,
                  deal,
                  unlockSigners: signers,
                },
              ],
        }
      : item,
  );
  return validateDeckLedger({ ...current.value, decks, active: null });
}

/** Caller has already validated command signature, exact parent, nonce and engine legality. */
export function revealDeckCards(
  ledger: DeckLedger,
  state: GameState,
  signed: SignedCommand,
  epoch: number,
): Result<DeckLedger> {
  const current = validateDeckLedger(ledger);
  if (!current.ok) return current;
  const { body } = signed;
  const command = body.command;
  if (command.type !== 'PLAY_DEV_CARD' && command.type !== 'CLAIM_VICTORY') return current;
  if (body.genesisDigest !== current.value.genesisDigest)
    return failure('deck-reveal-context', 'Command belongs to another genesis');
  const evidence = parseCanonical(body.evidence, revealEvidenceSchema);
  if (!evidence.ok) return evidence;
  const requested: unknown = command.type === 'PLAY_DEV_CARD' ? [command.slotId] : command.slotIds;
  if (
    !Array.isArray(requested) ||
    requested.length !== evidence.value.data.length ||
    requested.length === 0 ||
    requested.length > MAX_CARDS ||
    requested.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 64) ||
    new Set(requested).size !== requested.length
  )
    return failure('deck-reveal-slots', 'Command must reveal exactly its requested slots');
  const removed = new Set<string>();
  for (const [index, reveal] of evidence.value.data.entries()) {
    if (requested[index] !== reveal.slotId)
      return failure('deck-reveal-order', 'Reveal order differs from the command');
    const deck = current.value.decks.find((item) =>
      item.slots.some((slot) => slot.slotId === reveal.slotId),
    );
    const slot = deck?.slots.find((item) => item.slotId === reveal.slotId);
    const publicSlot = state.seats
      .find((item) => item.seat === body.seat)
      ?.cardSlots.find((item) => item.slotId === reveal.slotId);
    const drawn = deck?.commitment.definition.deckId
      ? state.decks[deck.commitment.definition.deckId]?.drawn[
          slot?.receipt.operation.position ?? -1
        ]
      : undefined;
    if (
      !deck ||
      !slot ||
      slot.seat !== body.seat ||
      !publicSlot ||
      publicSlot.revealed ||
      publicSlot.deck !== deck.commitment.definition.deckId ||
      drawn?.slotId !== reveal.slotId ||
      drawn?.seat !== body.seat ||
      body.headSeq < slot.deal.seq ||
      (body.headSeq === slot.deal.seq && body.headHash !== slot.deal.hash)
    )
      return failure(
        'deck-reveal-owner',
        'Revealed slot is not an owned hidden card at this parent',
      );
    const verified = verifyDeckReveal(
      deck.setup,
      slot.receipt,
      { identity: reveal.identity, proof: reveal.proof },
      {
        genesisDigest: current.value.genesisDigest,
        epoch,
        anchor: { seq: body.headSeq, hash: body.headHash },
        seat: body.seat,
        nonce: body.nonce,
        command,
      },
      slot.unlockSigners,
    );
    if (!verified.ok) return verified;
    if (
      command.type === 'PLAY_DEV_CARD'
        ? verified.value.card !== command.card
        : verified.value.card !== 'victoryPoint'
    )
      return failure('deck-reveal-kind', 'Proved card kind does not match the command');
    removed.add(reveal.slotId);
  }
  const decks = current.value.decks.map((deck) => ({
    ...deck,
    slots: deck.slots.filter((slot) => !removed.has(slot.slotId)),
  }));
  return validateDeckLedger({ ...current.value, decks });
}

import { hashValue, toHex } from '@cp2p/codec';
import {
  G,
  decodePoint,
  encodePoint,
  hashToPoint,
  identityFromSecret,
  invertScalar,
  parsePeerId,
  proveDleq,
  proveDleqOr,
  scalePoint,
  signObject,
  verifyDleq,
  verifyDleqOr,
  verifyObject,
} from '@cp2p/crypto';
import type { DleqOrProof, DleqProof } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { validateDeckSetupState } from './deck-setup.js';
import type { DeckSetupState } from './deck-setup.js';
import {
  hashSchema,
  key32Schema,
  nonnegativeIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import { parseCanonical } from './validation.js';
import type { ArtifactSigner } from './authority-types.js';

export interface DeckDrawRequest {
  genesisDigest: string;
  epoch: number;
  anchor: { seq: number; hash: string };
  position: number;
  seat: Seat;
  slotId: string;
  /** Public draw: every seat, the requester included, removes its lock and the card is shown. */
  public?: true;
}

/** Derived from a certified engine request and the verified setup transcript. */
export interface DeckDrawOperation extends DeckDrawRequest {
  setupHash: string;
  deckId: string;
  deckEpoch: number;
  initialPoint: string;
  participants: readonly { seat: Seat; publicKey: string; lockKey: string }[];
}

export interface SignedDeckUnlock {
  body: { operationId: string; step: number; seat: Seat; point: string; proof: DleqProof };
  sig: string;
}

/** Public receipt. It contains no plaintext identity or secret lock scalar. */
export interface DealtDeckCard {
  operation: DeckDrawOperation;
  point: string;
  unlocks: readonly SignedDeckUnlock[];
}

export interface DeckRevealContext {
  genesisDigest: string;
  epoch: number;
  anchor: { seq: number; hash: string };
  seat: Seat;
  nonce: number;
  /** The entire command, so a proof cannot be moved to another choice or action. */
  command: unknown;
}

export interface DeckCardReveal {
  identity: string;
  proof: DleqProof;
}

const label = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
const anchorSchema = v.strictObject({ seq: nonnegativeIntegerSchema, hash: hashSchema });
const requestFields = {
  genesisDigest: key32Schema,
  epoch: nonnegativeIntegerSchema,
  anchor: anchorSchema,
  position: v.pipe(nonnegativeIntegerSchema, v.maxValue(127)),
  seat: seatSchema,
  slotId: label,
  public: v.exactOptional(v.literal(true)),
};
const operationSchema = v.strictObject({
  ...requestFields,
  setupHash: hashSchema,
  deckId: label,
  deckEpoch: nonnegativeIntegerSchema,
  initialPoint: key32Schema,
  participants: v.pipe(
    v.array(v.strictObject({ seat: seatSchema, publicKey: key32Schema, lockKey: key32Schema })),
    v.minLength(1),
    v.maxLength(6),
  ),
});
const proofSchema = v.strictObject({
  commitments: v.tuple([key32Schema, key32Schema]),
  response: key32Schema,
});
export const deckUnlockSchema = v.strictObject({
  body: v.strictObject({
    operationId: hashSchema,
    step: v.pipe(nonnegativeIntegerSchema, v.maxValue(5)),
    seat: seatSchema,
    point: key32Schema,
    proof: proofSchema,
  }),
  sig: signature64Schema,
});
const revealSchema = v.strictObject({ identity: label, proof: proofSchema });
const revealContextSchema = v.strictObject({
  genesisDigest: key32Schema,
  epoch: nonnegativeIntegerSchema,
  anchor: anchorSchema,
  seat: seatSchema,
  nonce: nonnegativeIntegerSchema,
  command: v.unknown(),
});

function checked<T>(result: Result<T>): T {
  if (!result.ok) throw new TypeError(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** Shape validation does not authorize the request; callers freeze it from certified history. */
export function validateDeckDrawOperation(value: unknown): Result<DeckDrawOperation> {
  const parsed = parseCanonical(value, operationSchema);
  if (!parsed.ok) return parsed;
  const operation = parsed.value;
  try {
    decodePoint(operation.initialPoint, { nonIdentity: true });
    let previous = -1;
    const keys = new Set<string>();
    for (const participant of operation.participants) {
      if (participant.seat <= previous || keys.has(participant.publicKey))
        return failure('deck-participants', 'Deck participants must be unique and in seat order');
      previous = participant.seat;
      keys.add(participant.publicKey);
      parsePeerId(participant.publicKey);
      decodePoint(participant.lockKey, { nonIdentity: true });
    }
    if (!operation.participants.some((participant) => participant.seat === operation.seat))
      return failure('deck-drawer', 'The drawer must have a lock in this deck');
    return success(operation);
  } catch {
    return failure('deck-key', 'The frozen deck contains an invalid point or signing key');
  }
}

/**
 * The seats that remove a lock, in order. A private draw is unlocked by every seat but the
 * drawer, who opens the last layer alone. A public draw is unlocked by every seat.
 */
export function deckUnlockers(
  operation: Pick<DeckDrawOperation, 'seat' | 'participants' | 'public'>,
): DeckDrawOperation['participants'] {
  return operation.public
    ? operation.participants
    : operation.participants.filter((participant) => participant.seat !== operation.seat);
}

export function freezeDeckDraw(
  setup: DeckSetupState,
  request: DeckDrawRequest,
): Result<DeckDrawOperation> {
  const validated = validateDeckSetupState(setup);
  if (!validated.ok) return validated;
  const parsed = parseCanonical(request, v.strictObject(requestFields));
  if (!parsed.ok) return parsed;
  const deck = validated.value;
  const definition = deck.definition;
  if (deck.lockKeys.length !== definition.participants.length)
    return failure('deck-incomplete', 'Every seat must finish locking before a draw');
  if (definition.creation.kind === 'certified') {
    const creation = definition.creation;
    if (creation.genesisDigest !== parsed.value.genesisDigest)
      return failure('deck-genesis', 'The draw and deck creation belong to different games');
    if (
      parsed.value.epoch < creation.epoch ||
      parsed.value.anchor.seq < creation.anchor.seq ||
      (parsed.value.anchor.seq === creation.anchor.seq &&
        parsed.value.anchor.hash !== creation.anchor.hash)
    )
      return failure('deck-creation-order', 'The draw cannot precede its certified deck creation');
  }
  const initialPoint = deck.points[parsed.value.position];
  if (!initialPoint) return failure('deck-position', 'The draw position is outside this deck');
  const participants = definition.participants.map((participant, index) => ({
    ...participant,
    lockKey: deck.lockKeys[index]?.[parsed.value.position] ?? '',
  }));
  return validateDeckDrawOperation({
    ...parsed.value,
    setupHash: toHex(hashValue({ domain: 'cp2p/v1/locked-deck', deck })),
    deckId: definition.deckId,
    deckEpoch: definition.deckEpoch,
    initialPoint,
    participants,
  });
}

export function deckDrawOperationId(operation: DeckDrawOperation): string {
  return toHex(
    hashValue({
      domain: 'cp2p/v1/deck-draw',
      operation: checked(validateDeckDrawOperation(operation)),
    }),
  );
}

function unlockStatement(previous: string, point: string, lockKey: string) {
  return { base1: point, point1: previous, base2: encodePoint(G), point2: lockKey };
}

function unlockContext(operationId: string, step: number, seat: Seat) {
  return { domain: 'cp2p/v1/deck-unlock', operationId, step, seat };
}

const VERIFIED_UNLOCK_PROOF_LIMIT = 64;
const verifiedUnlockProofs = new Set<string>();

function verifiedUnlockProof(
  statement: ReturnType<typeof unlockStatement>,
  proof: DleqProof,
  context: ReturnType<typeof unlockContext>,
): boolean {
  const key = toHex(
    hashValue({ domain: 'cp2p/v1/deck-unlock-proof-cache', statement, proof, context }),
  );
  if (verifiedUnlockProofs.delete(key)) {
    verifiedUnlockProofs.add(key);
    return true;
  }
  if (!verifyDleq(statement, proof, context)) return false;
  // Repeated proposals and growing prefixes reuse this exact public proof.
  // Retain only its success hash; signatures, order and operation checks still run.
  verifiedUnlockProofs.add(key);
  if (verifiedUnlockProofs.size > VERIFIED_UNLOCK_PROOF_LIMIT) {
    const oldest = verifiedUnlockProofs.values().next().value;
    if (oldest !== undefined) verifiedUnlockProofs.delete(oldest);
  }
  return true;
}

export function verifyDeckUnlockPrefix(
  operation: DeckDrawOperation,
  value: unknown,
  signers?: readonly ArtifactSigner[],
): Result<{ operation: DeckDrawOperation; point: string; unlocks: SignedDeckUnlock[] }> {
  const parsedOperation = validateDeckDrawOperation(operation);
  if (!parsedOperation.ok) return parsedOperation;
  const op = parsedOperation.value;
  const expected = deckUnlockers(op);
  if (
    signers &&
    (signers.length !== expected.length ||
      signers.some((signer, index) => signer.seat !== expected[index]?.seat))
  )
    return failure('deck-unlock-authority', 'Unlock signer roster differs from the frozen draw');
  try {
    for (const signer of signers ?? []) parsePeerId(signer.publicKey);
  } catch {
    return failure('deck-unlock-authority', 'An unlock signing key is invalid');
  }
  const parsed = parseCanonical(
    value,
    v.pipe(v.array(deckUnlockSchema), v.maxLength(expected.length)),
  );
  if (!parsed.ok) return parsed;
  const operationId = deckDrawOperationId(op);
  let point = op.initialPoint;
  for (const [step, unlock] of parsed.value.entries()) {
    const participant = expected[step];
    if (
      !participant ||
      unlock.body.step !== step ||
      unlock.body.seat !== participant.seat ||
      unlock.body.operationId !== operationId
    )
      return failure('deck-unlock-order', 'Unlocks must follow the frozen draw and seat order');
    if (
      !verifyObject(
        'deck-unlock',
        unlock.body,
        unlock.sig,
        parsePeerId(signers?.[step]?.publicKey ?? participant.publicKey),
      )
    )
      return failure('deck-unlock-signature', 'The partial unlock signature is invalid');
    try {
      decodePoint(unlock.body.point, { nonIdentity: true });
    } catch {
      return failure('deck-unlock-point', 'The partial unlock point is invalid');
    }
    if (
      !verifiedUnlockProof(
        unlockStatement(point, unlock.body.point, participant.lockKey),
        unlock.body.proof,
        unlockContext(operationId, step, participant.seat),
      )
    )
      return failure('deck-unlock-proof', 'The partial unlock did not remove the required lock');
    point = unlock.body.point;
  }
  return success({ operation: op, point, unlocks: parsed.value });
}

/** Each signer derives the next point only after verifying every earlier unlock. */
export function signDeckUnlock(
  operation: DeckDrawOperation,
  prefix: readonly SignedDeckUnlock[],
  lock: bigint,
  seed: Uint8Array,
  key: Uint8Array,
  signers?: readonly ArtifactSigner[],
): SignedDeckUnlock {
  const previous = checked(verifyDeckUnlockPrefix(operation, prefix, signers));
  const step = previous.unlocks.length;
  const participant = deckUnlockers(previous.operation)[step];
  if (!participant) throw new RangeError('This draw has no remaining unlock');
  const identity = identityFromSecret(key);
  const signer = signers?.[step];
  const own =
    identity.peerId === (signer?.publicKey ?? participant.publicKey) &&
    (!signer || signer.seat === participant.seat);
  identity.secretKey.fill(0);
  if (!own) throw new RangeError('The signer is not the next unlocking seat');
  if (encodePoint(scalePoint(G, lock)) !== participant.lockKey)
    throw new RangeError('The secret does not match the frozen position lock');
  const point = encodePoint(scalePoint(decodePoint(previous.point), invertScalar(lock)));
  const operationId = deckDrawOperationId(previous.operation);
  const proof = proveDleq(
    unlockStatement(previous.point, point, participant.lockKey),
    lock,
    seed,
    unlockContext(operationId, step, participant.seat),
  );
  const body = { operationId, step, seat: participant.seat, point, proof };
  return { body, sig: signObject('deck-unlock', body, key) };
}

export function verifyDeckUnlock(
  operation: DeckDrawOperation,
  prefix: readonly SignedDeckUnlock[],
  value: unknown,
  signers?: readonly ArtifactSigner[],
): Result<SignedDeckUnlock> {
  const parsed = parseCanonical(value, deckUnlockSchema);
  if (!parsed.ok) return parsed;
  const verified = verifyDeckUnlockPrefix(operation, [...prefix, parsed.value], signers);
  return verified.ok ? success(parsed.value) : verified;
}

export function completeDeckDraw(
  operation: DeckDrawOperation,
  evidence: unknown,
  signers?: readonly ArtifactSigner[],
): Result<DealtDeckCard> {
  const verified = verifyDeckUnlockPrefix(operation, evidence, signers);
  if (!verified.ok) return verified;
  if (verified.value.unlocks.length !== deckUnlockers(verified.value.operation).length)
    return failure(
      'deck-unlock-incomplete',
      verified.value.operation.public
        ? 'Every seat must unlock before a public reveal'
        : 'Every other seat must unlock before dealing',
    );
  return success(verified.value);
}

function verifiedReceipt(
  setup: DeckSetupState,
  receipt: DealtDeckCard,
  signers?: readonly ArtifactSigner[],
): Result<{ setup: DeckSetupState; receipt: DealtDeckCard }> {
  const parsedSetup = validateDeckSetupState(setup);
  if (!parsedSetup.ok) return parsedSetup;
  const parsed = parseCanonical(
    receipt,
    v.strictObject({
      operation: operationSchema,
      point: key32Schema,
      unlocks: v.pipe(v.array(deckUnlockSchema), v.maxLength(6)),
    }),
  );
  if (!parsed.ok) return parsed;
  const { genesisDigest, epoch, anchor, position, seat, slotId } = parsed.value.operation;
  const expected = freezeDeckDraw(parsedSetup.value, {
    genesisDigest,
    epoch,
    anchor,
    position,
    seat,
    slotId,
    ...(parsed.value.operation.public ? { public: true as const } : {}),
  });
  if (!expected.ok) return expected;
  if (deckDrawOperationId(expected.value) !== deckDrawOperationId(parsed.value.operation))
    return failure('deck-receipt-setup', 'This receipt belongs to another deck');
  const complete = completeDeckDraw(expected.value, parsed.value.unlocks, signers);
  if (!complete.ok) return complete;
  if (complete.value.point !== parsed.value.point)
    return failure('deck-receipt-point', 'The claimed dealt point differs from its unlock chain');
  return success({ setup: parsedSetup.value, receipt: complete.value });
}

function identityPoint(setup: DeckSetupState, identity: string): string {
  const { ceremonyId, deckId, deckEpoch } = setup.definition;
  return encodePoint(hashToPoint('card', { ceremonyId, deckId, deckEpoch, identity }));
}

/**
 * Call only for the owner after certification. Provisional decoding never publishes a hand.
 * Replacement signers must come from the replayed deal, never a peer-supplied receipt.
 */
export function decodeDeckCard(
  setup: DeckSetupState,
  receipt: DealtDeckCard,
  lock: bigint,
  signers?: readonly ArtifactSigner[],
  held?: SlotHolder,
): Result<{ identity: string; card: string }> {
  const verified = verifiedReceipt(setup, receipt, signers);
  if (!verified.ok) return verified;
  const deck = verified.value.setup;
  const dealt = verified.value.receipt;
  try {
    // The holder is the drawer, or the seat a take re-locked the card for.
    const owner = held ?? dealtHolder(dealt);
    if (!owner || encodePoint(scalePoint(G, lock)) !== owner.lockKey)
      return failure('deck-owner-lock', "The secret is not the holder's position lock");
    const point = encodePoint(scalePoint(decodePoint(owner.point), invertScalar(lock)));
    const card = deck.definition.cards.find((item) => identityPoint(deck, item.identity) === point);
    return card
      ? success({ ...card })
      : failure('deck-decode', 'The opened point has no canonical card identity');
  } catch {
    return failure('deck-owner-lock', "The drawer's position lock is invalid");
  }
}

/**
 * The identity a completed public draw shows. Everything is checked: the frozen operation is
 * public, every seat's unlock verifies, and the final point is a canonical card of this deck.
 */
export function decodePublicDeckCard(
  setup: DeckSetupState,
  receipt: DealtDeckCard,
  signers?: readonly ArtifactSigner[],
): Result<{ identity: string; card: string }> {
  if (receipt.operation.public !== true)
    return failure('deck-public-mode', 'Only a public draw can be decoded without a lock');
  const verified = verifiedReceipt(setup, receipt, signers);
  if (!verified.ok) return verified;
  const deck = verified.value.setup;
  try {
    const point = verified.value.receipt.point;
    const card = deck.definition.cards.find((item) => identityPoint(deck, item.identity) === point);
    return card
      ? success({ ...card })
      : failure('deck-decode', 'The opened point has no canonical card identity');
  } catch {
    return failure('deck-decode', 'The opened point is invalid');
  }
}

/**
 * Who can open a dealt card and against which public values: the seat holding it, the point
 * still locked by that seat alone, and the public key of that seat's lock. A card is first held
 * by its drawer; a Spy's take re-locks it under the taker's own key.
 */
export interface SlotHolder {
  seat: Seat;
  point: string;
  lockKey: string;
  /** Present after a re-lock: the certified transfer this holder derives from. */
  relock?: unknown;
}

/** The drawer's holding of its own dealt card. */
export function dealtHolder(receipt: DealtDeckCard): SlotHolder | null {
  const owner = receipt.operation.participants.find((item) => item.seat === receipt.operation.seat);
  return owner
    ? { seat: receipt.operation.seat, point: receipt.point, lockKey: owner.lockKey }
    : null;
}

function revealStatement(
  setup: DeckSetupState,
  receipt: DealtDeckCard,
  identity: string,
  context: DeckRevealContext,
  signers?: readonly ArtifactSigner[],
  held?: SlotHolder,
) {
  const verified = checked(verifiedReceipt(setup, receipt, signers));
  const deck = verified.setup;
  const checkedContext = checked(parseCanonical(context, revealContextSchema));
  const operation = verified.receipt.operation;
  const holder = held ?? dealtHolder(verified.receipt);
  if (!holder) throw new RangeError('The owner has no deck lock');
  if (
    checkedContext.genesisDigest !== operation.genesisDigest ||
    checkedContext.seat !== holder.seat ||
    checkedContext.epoch < operation.epoch ||
    checkedContext.anchor.seq <= operation.anchor.seq
  )
    throw new RangeError('The reveal must belong to the owner and a later certified context');
  const card = deck.definition.cards.find((item) => item.identity === identity);
  if (!card) throw new RangeError('Unknown card identity');
  return {
    card,
    statement: {
      base1: identityPoint(deck, identity),
      point1: holder.point,
      base2: encodePoint(G),
      point2: holder.lockKey,
    },
    context: {
      domain: 'cp2p/v1/deck-reveal',
      draw: deckDrawOperationId(operation),
      identity,
      action: checkedContext,
      ...(held?.relock === undefined ? {} : { relock: held.relock }),
    },
  };
}

export function proveDeckReveal(
  setup: DeckSetupState,
  receipt: DealtDeckCard,
  identity: string,
  lock: bigint,
  seed: Uint8Array,
  context: DeckRevealContext,
  signers?: readonly ArtifactSigner[],
  holder?: SlotHolder,
): DeckCardReveal {
  const statement = revealStatement(setup, receipt, identity, context, signers, holder);
  return { identity, proof: proveDleq(statement.statement, lock, seed, statement.context) };
}

export function verifyDeckReveal(
  setup: DeckSetupState,
  receipt: DealtDeckCard,
  value: unknown,
  context: DeckRevealContext,
  signers?: readonly ArtifactSigner[],
  holder?: SlotHolder,
): Result<{ identity: string; card: string }> {
  const parsed = parseCanonical(value, revealSchema);
  if (!parsed.ok) return parsed;
  try {
    const statement = revealStatement(
      setup,
      receipt,
      parsed.value.identity,
      context,
      signers,
      holder,
    );
    return verifyDleq(statement.statement, parsed.value.proof, statement.context)
      ? success({ ...statement.card })
      : failure('deck-reveal-proof', 'The card identity does not match the held position');
  } catch {
    return failure('deck-reveal-context', 'The reveal does not belong to this card and command');
  }
}

const denialSchema = v.strictObject({
  branches: v.pipe(
    v.array(v.strictObject({ challenge: key32Schema, response: key32Schema })),
    v.minLength(1),
    v.maxLength(64),
  ),
});

function denialStatement(
  setup: DeckSetupState,
  receipt: DealtDeckCard,
  excluded: readonly string[],
  context: DeckRevealContext,
  signers?: readonly ArtifactSigner[],
  held?: SlotHolder,
) {
  const verified = checked(verifiedReceipt(setup, receipt, signers));
  const deck = verified.setup;
  const checkedContext = checked(parseCanonical(context, revealContextSchema));
  const operation = verified.receipt.operation;
  const holder = held ?? dealtHolder(verified.receipt);
  if (!holder) throw new RangeError('The owner has no deck lock');
  if (
    checkedContext.genesisDigest !== operation.genesisDigest ||
    checkedContext.seat !== holder.seat ||
    checkedContext.epoch < operation.epoch ||
    checkedContext.anchor.seq <= operation.anchor.seq
  )
    throw new RangeError('The denial must belong to the owner and a later certified context');
  // Every physical card of the deck that is not excluded is a possible identity.
  const candidates = deck.definition.cards.filter((item) => !excluded.includes(item.card));
  if (candidates.length === 0 || candidates.length > 64)
    throw new RangeError('The denial has no candidate identity or too many');
  return {
    candidates,
    statement: {
      branches: candidates.map((item) => ({
        base1: identityPoint(deck, item.identity),
        point1: holder.point,
        base2: encodePoint(G),
        point2: holder.lockKey,
      })),
    },
    context: {
      domain: 'cp2p/v1/deck-denial',
      draw: deckDrawOperationId(operation),
      excluded: [...excluded],
      action: checkedContext,
      ...(held?.relock === undefined ? {} : { relock: held.relock }),
    },
  };
}

/**
 * The owner proves that its hidden card is none of the `excluded` card types (for example, not a
 * victory card) without saying which card it is. `identity` is the card's true identity.
 */
export function proveDeckDenial(
  setup: DeckSetupState,
  receipt: DealtDeckCard,
  identity: string,
  excluded: readonly string[],
  lock: bigint,
  seed: Uint8Array,
  context: DeckRevealContext,
  signers?: readonly ArtifactSigner[],
  holder?: SlotHolder,
): DleqOrProof {
  const statement = denialStatement(setup, receipt, excluded, context, signers, holder);
  const known = statement.candidates.findIndex((item) => item.identity === identity);
  if (known < 0) throw new RangeError('The card is excluded, so it cannot be denied');
  return proveDleqOr(statement.statement, known, lock, seed, statement.context);
}

export function verifyDeckDenial(
  setup: DeckSetupState,
  receipt: DealtDeckCard,
  value: unknown,
  excluded: readonly string[],
  context: DeckRevealContext,
  signers?: readonly ArtifactSigner[],
  holder?: SlotHolder,
): Result<void> {
  const parsed = parseCanonical(value, denialSchema);
  if (!parsed.ok) return parsed;
  try {
    const statement = denialStatement(setup, receipt, excluded, context, signers, holder);
    return verifyDleqOr(statement.statement, parsed.value, statement.context)
      ? success(undefined)
      : failure('deck-denial-proof', 'The card may be one of the excluded identities');
  } catch {
    return failure('deck-denial-context', 'The denial does not belong to this card and input');
  }
}

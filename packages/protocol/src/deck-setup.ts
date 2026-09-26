import { hashValue, toHex } from '@cp2p/codec';
import {
  G,
  SCALAR_ORDER,
  decodePoint,
  encodePoint,
  identityFromSecret,
  invertScalar,
  modScalar,
  parsePeerId,
  proveDleq,
  proveShuffle,
  scalePoint,
  signObject,
  verifyDleq,
  verifyObject,
  verifyShuffle,
} from '@cp2p/crypto';
import { hashToPoint } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import {
  hashSchema,
  key32Schema,
  nonnegativeIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import { parseCanonical } from './validation.js';
import type { ShuffleProof, DleqProof } from '@cp2p/crypto';

const labelSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
const pointListSchema = v.pipe(v.array(key32Schema), v.minLength(1), v.maxLength(128));
const deckDefinitionSchema = v.strictObject({
  ceremonyId: key32Schema,
  deckId: labelSchema,
  deckEpoch: nonnegativeIntegerSchema,
  creation: v.variant('kind', [
    v.strictObject({ kind: v.literal('ceremony') }),
    v.strictObject({
      kind: v.literal('certified'),
      genesisDigest: key32Schema,
      epoch: nonnegativeIntegerSchema,
      anchor: v.strictObject({ seq: nonnegativeIntegerSchema, hash: hashSchema }),
    }),
  ]),
  cards: v.pipe(
    v.array(v.strictObject({ identity: labelSchema, card: labelSchema })),
    v.minLength(1),
    v.maxLength(128),
  ),
  participants: v.pipe(
    v.array(v.strictObject({ seat: seatSchema, publicKey: key32Schema })),
    v.minLength(1),
    v.maxLength(6),
  ),
});
const deckStateSchema = v.strictObject({
  definition: deckDefinitionSchema,
  points: pointListSchema,
  shuffleKeys: v.pipe(v.array(key32Schema), v.maxLength(6)),
  lockKeys: v.pipe(v.array(pointListSchema), v.maxLength(6)),
});
const shuffleBodySchema = v.strictObject({
  phase: v.literal('shuffle'),
  operationId: hashSchema,
  seat: seatSchema,
  output: pointListSchema,
  publicKey: key32Schema,
  proof: v.unknown(),
});
const lockBodySchema = v.strictObject({
  phase: v.literal('lock'),
  operationId: hashSchema,
  seat: seatSchema,
  output: pointListSchema,
  lockKeys: pointListSchema,
  proofs: v.pipe(v.array(v.unknown()), v.minLength(1), v.maxLength(128)),
});
const signedPassSchema = v.strictObject({
  body: v.variant('phase', [shuffleBodySchema, lockBodySchema]),
  sig: signature64Schema,
});

export type DeckDefinition = v.InferOutput<typeof deckDefinitionSchema>;
export type DeckSetupState = v.InferOutput<typeof deckStateSchema>;
export type SignedDeckPass =
  | {
      body: Omit<v.InferOutput<typeof shuffleBodySchema>, 'proof'> & { proof: ShuffleProof };
      sig: string;
    }
  | {
      body: Omit<v.InferOutput<typeof lockBodySchema>, 'proofs'> & { proofs: readonly DleqProof[] };
      sig: string;
    };

function validatedDefinition(value: unknown): Result<DeckDefinition> {
  const parsed = parseCanonical(value, deckDefinitionSchema);
  if (!parsed.ok) return parsed;
  const definition = parsed.value;
  if (new Set(definition.cards.map(({ identity }) => identity)).size !== definition.cards.length)
    return failure('deck-identities', 'Every card needs a unique identity');
  let previousSeat = -1;
  const keys = new Set<string>();
  for (const participant of definition.participants) {
    if (participant.seat <= previousSeat || keys.has(participant.publicKey))
      return failure(
        'deck-participants',
        'Deck participants must have ordered unique seats and keys',
      );
    try {
      parsePeerId(participant.publicKey);
    } catch {
      return failure('deck-participants', 'Deck participant key is invalid');
    }
    previousSeat = participant.seat;
    keys.add(participant.publicKey);
  }
  return success(definition);
}

function checkedPoints(points: readonly string[], size: number): boolean {
  if (points.length !== size || new Set(points).size !== size) return false;
  try {
    for (const point of points) decodePoint(point, { nonIdentity: true });
    return true;
  } catch {
    return false;
  }
}

/** Only the signed-pass fold makes this state authoritative; shape validation cannot replay proofs. */
export function validateDeckSetupState(value: unknown): Result<DeckSetupState> {
  const parsed = parseCanonical(value, deckStateSchema);
  if (!parsed.ok) return parsed;
  const state = parsed.value;
  const definition = validatedDefinition(state.definition);
  if (!definition.ok) return definition;
  const size = definition.value.cards.length;
  const players = definition.value.participants.length;
  if (
    !checkedPoints(state.points, size) ||
    state.shuffleKeys.length > players ||
    state.lockKeys.length > players ||
    (state.lockKeys.length > 0 && state.shuffleKeys.length !== players)
  )
    return failure('deck-state', 'Deck setup dimensions or points are invalid');
  try {
    for (const key of state.shuffleKeys) decodePoint(key, { nonIdentity: true });
    for (const row of state.lockKeys)
      if (!checkedPoints(row, size))
        return failure('deck-state', 'Deck lock keys must be distinct nonidentity points');
  } catch {
    return failure('deck-state', 'Deck setup key is invalid');
  }
  if (state.shuffleKeys.length === 0 && state.lockKeys.length === 0) {
    const initial = definition.value.cards.map(({ identity }) =>
      encodePoint(
        hashToPoint('card', {
          ceremonyId: definition.value.ceremonyId,
          deckId: definition.value.deckId,
          deckEpoch: definition.value.deckEpoch,
          identity,
        }),
      ),
    );
    if (initial.some((point, index) => state.points[index] !== point))
      return failure('deck-state', 'Unshuffled points differ from the canonical cards');
  }
  return success(state);
}

export function initDeckSetup(value: unknown): Result<DeckSetupState> {
  const definition = validatedDefinition(value);
  if (!definition.ok) return definition;
  const points = definition.value.cards.map(({ identity }) =>
    encodePoint(
      hashToPoint('card', {
        ceremonyId: definition.value.ceremonyId,
        deckId: definition.value.deckId,
        deckEpoch: definition.value.deckEpoch,
        identity,
      }),
    ),
  );
  return validateDeckSetupState({
    definition: definition.value,
    points,
    shuffleKeys: [],
    lockKeys: [],
  });
}

export function deckSetupId(value: DeckDefinition): string {
  const checked = validatedDefinition(value);
  if (!checked.ok) throw new TypeError(checked.error.message);
  return toHex(hashValue({ domain: 'cp2p/v1/deck-setup', definition: checked.value }));
}

/** Full pre-pass state, so a proof or signature cannot move to another pass. */
export function deckPassOperationId(value: DeckSetupState): string {
  const checked = validateDeckSetupState(value);
  if (!checked.ok) throw new TypeError(checked.error.message);
  return toHex(hashValue({ domain: 'cp2p/v1/deck-pass', state: checked.value }));
}

function nextActor(state: DeckSetupState): { phase: 'shuffle' | 'lock'; seat: Seat } | null {
  const participants = state.definition.participants;
  const shuffler = participants[state.shuffleKeys.length];
  if (shuffler) return { phase: 'shuffle', seat: shuffler.seat };
  const locker = participants[state.lockKeys.length];
  if (locker) return { phase: 'lock', seat: locker.seat };
  return null;
}

function proofContext(
  operationId: string,
  phase: 'shuffle' | 'lock',
  seat: Seat,
  position?: number,
) {
  return position === undefined
    ? { operationId, phase, seat }
    : { operationId, phase, seat, position };
}

export function applyDeckPass(value: DeckSetupState, signed: unknown): Result<DeckSetupState> {
  const current = validateDeckSetupState(value);
  if (!current.ok) return current;
  const parsed = parseCanonical(signed, signedPassSchema);
  if (!parsed.ok) return parsed;
  const state = current.value;
  const { body, sig } = parsed.value;
  const actor = nextActor(state);
  if (!actor || body.phase !== actor.phase || body.seat !== actor.seat)
    return failure('deck-order', 'Deck pass actor or phase is out of order');
  if (body.operationId !== deckPassOperationId(state))
    return failure('deck-operation', 'Deck pass belongs to another certified state');
  if (
    body.output.length !== state.points.length ||
    (body.phase === 'lock' &&
      (body.lockKeys.length !== state.points.length || body.proofs.length !== state.points.length))
  )
    return failure('deck-dimensions', 'Deck pass has the wrong card count');
  const owner = state.definition.participants.find(({ seat }) => seat === actor.seat);
  if (!owner || !verifyObject('deck-pass', body, sig, parsePeerId(owner.publicKey)))
    return failure('deck-signature', 'Deck pass signature does not match its actor');
  if (!checkedPoints(body.output, state.points.length))
    return failure('deck-points', 'Deck output must contain distinct nonidentity points');
  if (body.phase === 'shuffle') {
    try {
      decodePoint(body.publicKey, { nonIdentity: true });
    } catch {
      return failure('deck-key', 'Shuffle public key is invalid');
    }
    if (
      !verifyShuffle(
        { input: state.points, output: body.output, publicKey: body.publicKey },
        body.proof,
        proofContext(body.operationId, body.phase, body.seat),
      )
    )
      return failure('deck-shuffle-proof', 'Shuffle proof does not match the pass');
    return validateDeckSetupState({
      ...state,
      points: body.output,
      shuffleKeys: [...state.shuffleKeys, body.publicKey],
    });
  }
  if (!checkedPoints(body.lockKeys, state.points.length))
    return failure('deck-key', 'Lock keys must be distinct nonidentity points');
  const shuffleKey = state.shuffleKeys[state.lockKeys.length];
  if (!shuffleKey) return failure('deck-state', 'Lock pass has no matching shuffle key');
  for (let position = 0; position < state.points.length; position += 1) {
    const input = state.points[position];
    const output = body.output[position];
    const lockKey = body.lockKeys[position];
    if (
      !input ||
      !output ||
      !lockKey ||
      !verifyDleq(
        { base1: input, point1: output, base2: shuffleKey, point2: lockKey },
        body.proofs[position],
        proofContext(body.operationId, body.phase, body.seat, position),
      )
    )
      return failure('deck-lock-proof', 'Lock proof does not match its card position');
  }
  return validateDeckSetupState({
    ...state,
    points: body.output,
    lockKeys: [...state.lockKeys, body.lockKeys],
  });
}

function checkedSigner(state: DeckSetupState, key: Uint8Array, phase: 'shuffle' | 'lock'): Seat {
  const actor = nextActor(state);
  if (!actor || actor.phase !== phase) throw new RangeError('Deck pass is not in this phase');
  const owner = state.definition.participants.find(({ seat }) => seat === actor.seat);
  if (!owner) throw new RangeError('Deck actor is missing');
  const identity = identityFromSecret(key);
  const matches = identity.peerId === owner.publicKey;
  identity.secretKey.fill(0);
  if (!matches) throw new RangeError('Deck signer does not own the next seat');
  return actor.seat;
}

function scalar(secret: bigint): void {
  if (typeof secret !== 'bigint' || secret <= 0n || secret >= SCALAR_ORDER)
    throw new RangeError('Deck key must be a canonical nonzero scalar');
}

/** Build one signed shuffle pass; a caller must persist it before retransmission. */
export function signDeckShuffle(
  value: DeckSetupState,
  secret: bigint,
  permutation: readonly number[],
  proofSeed: Uint8Array,
  key: Uint8Array,
): SignedDeckPass {
  const checked = validateDeckSetupState(value);
  if (!checked.ok) throw new TypeError(checked.error.message);
  const state = checked.value;
  const seat = checkedSigner(state, key, 'shuffle');
  scalar(secret);
  if (
    permutation.length !== state.points.length ||
    new Set(permutation).size !== permutation.length ||
    permutation.some(
      (index) => !Number.isSafeInteger(index) || index < 0 || index >= permutation.length,
    )
  )
    throw new RangeError('Deck permutation must be a bijection');
  const output = state.points.slice();
  for (let index = 0; index < state.points.length; index += 1) {
    const destination = permutation[index];
    const input = state.points[index];
    if (destination === undefined || input === undefined)
      throw new RangeError('Deck permutation or input is missing');
    output[destination] = encodePoint(
      scalePoint(decodePoint(input, { nonIdentity: true }), secret),
    );
  }
  const operationId = deckPassOperationId(state);
  const publicKey = encodePoint(scalePoint(G, secret));
  const proof = proveShuffle(
    { input: state.points, output, publicKey },
    secret,
    permutation,
    proofSeed,
    proofContext(operationId, 'shuffle', seat),
  );
  const body = { phase: 'shuffle' as const, operationId, seat, output, publicKey, proof };
  return { body, sig: signObject('deck-pass', body, key) };
}

/** Remove this seat's shuffle key and install a separate lock for each position. */
export function signDeckLock(
  value: DeckSetupState,
  shuffleSecret: bigint,
  lockSecrets: readonly bigint[],
  proofSeed: Uint8Array,
  key: Uint8Array,
): SignedDeckPass {
  const checked = validateDeckSetupState(value);
  if (!checked.ok) throw new TypeError(checked.error.message);
  const state = checked.value;
  const seat = checkedSigner(state, key, 'lock');
  scalar(shuffleSecret);
  const shuffleKey = state.shuffleKeys[state.lockKeys.length];
  if (!shuffleKey || !scalePoint(G, shuffleSecret).equals(decodePoint(shuffleKey)))
    throw new RangeError('Shuffle secret does not open this seat key');
  if (lockSecrets.length !== state.points.length)
    throw new RangeError('Lock count differs from deck size');
  const operationId = deckPassOperationId(state);
  const output: string[] = [];
  const lockKeys: string[] = [];
  const proofs: DleqProof[] = [];
  for (let position = 0; position < state.points.length; position += 1) {
    const lock = lockSecrets[position];
    if (lock === undefined) throw new RangeError('Missing deck lock key');
    scalar(lock);
    const exponent = modScalar(lock * invertScalar(shuffleSecret));
    const input = state.points[position];
    if (input === undefined) throw new RangeError('Deck input is missing');
    const result = encodePoint(scalePoint(decodePoint(input, { nonIdentity: true }), exponent));
    const lockKey = encodePoint(scalePoint(G, lock));
    output.push(result);
    lockKeys.push(lockKey);
    proofs.push(
      proveDleq(
        { base1: input, point1: result, base2: shuffleKey, point2: lockKey },
        exponent,
        proofSeed,
        proofContext(operationId, 'lock', seat, position),
      ),
    );
  }
  if (!checkedPoints(output, state.points.length) || !checkedPoints(lockKeys, state.points.length))
    throw new RangeError('Deck lock pass produced duplicate or identity points');
  const body = { phase: 'lock' as const, operationId, seat, output, lockKeys, proofs };
  return { body, sig: signObject('deck-pass', body, key) };
}

export function replayDeckSetup(value: unknown, passes: unknown): Result<DeckSetupState> {
  const initial = initDeckSetup(value);
  if (!initial.ok) return initial;
  const count = initial.value.definition.participants.length * 2;
  const items: unknown[] = [];
  try {
    if (
      !Array.isArray(passes) ||
      passes.length !== count ||
      Reflect.ownKeys(passes).length !== count + 1
    )
      return failure('deck-pass-count', 'Deck setup needs every shuffle and lock pass');
    for (let index = 0; index < count; index += 1) {
      const item = Object.getOwnPropertyDescriptor(passes, String(index));
      if (!item?.enumerable || !('value' in item))
        return failure('deck-pass-count', 'Deck pass list contains a hole or accessor');
      items.push(item.value);
    }
  } catch {
    return failure('deck-pass-count', 'Deck pass list could not be inspected');
  }
  let current = initial.value;
  for (const item of items) {
    const applied = applyDeckPass(current, item);
    if (!applied.ok) return applied;
    current = applied.value;
  }
  return success(current);
}

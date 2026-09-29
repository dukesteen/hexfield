import {
  DERIVATION_LABELS,
  G,
  decodePoint,
  deriveScalar,
  encodePoint,
  invertScalar,
  proveDleq,
  scalePoint,
  verifyDleq,
} from '@cp2p/crypto';
import type { DleqProof } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import type { DeckRevealContext, SlotHolder } from './deck-draw.js';
import type { DeckSecretSource } from './deck-source.js';
import { key32Schema, nonnegativeIntegerSchema, seatSchema } from './schema-values.js';
import { hashSchema } from './schema-values.js';
import { parseCanonical } from './validation.js';

/**
 * A Spy looks at the target's hidden progress cards and may take one, without the target or
 * anyone else revealing a card to the table. It is a mental-poker card transfer between two
 * seats, verified publicly at each step:
 *
 * 1. The actor's play carries, for each hidden card the target holds (point `Z`, locked by the
 *    target alone), a fresh lock key `C = c·G` and `M = c·Z`, with a DLEQ that the same `c` is
 *    behind both. The actor derives every `c` from its master secret.
 * 2. The target answers by removing exactly its own layer: `Z' = b⁻¹·M` with a DLEQ against its
 *    public lock key `B = b·G`. Now `Z' = c·P` is locked by the actor alone.
 * 3. The actor opens `P = c⁻¹·Z'` itself and reads the identity, choosing a card to take. The
 *    slot's holder becomes the actor with lock `C` and point `Z'`; it reveals the card later
 *    with a DLEQ against `C` like a card it drew.
 *
 * No identity, key or opening is ever sent; a peer that verifies the two DLEQs knows the target
 * showed exactly what it holds and the actor holds the lock of what it took.
 */
export interface SpyRequestItem {
  slotId: string;
  /** The actor's lock key `C = c·G` for this card. */
  key: string;
  /** `c·Z`: the card's point with the actor's lock added on top of the target's. */
  masked: string;
  proof: DleqProof;
}

export interface SpyUnlockItem {
  slotId: string;
  /** `Z' = b⁻¹·(c·Z)`: the target's layer removed, the actor's remaining. */
  point: string;
  proof: DleqProof;
}

export interface SpyRequestContext {
  action: DeckRevealContext;
  deckId: string;
  slotId: string;
}

const dleqProofSchema = v.strictObject({
  commitments: v.tuple([key32Schema, key32Schema]),
  response: key32Schema,
});
export const spyRequestSchema = v.strictObject({
  kind: v.literal('spy-request'),
  slots: v.pipe(
    v.array(
      v.strictObject({
        slotId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
        key: key32Schema,
        masked: key32Schema,
        proof: dleqProofSchema,
      }),
    ),
    v.maxLength(16),
  ),
});
export const spyUnlockSchema = v.strictObject({
  kind: v.literal('spy-unlock'),
  slots: v.pipe(
    v.array(
      v.strictObject({
        slotId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
        point: key32Schema,
        proof: dleqProofSchema,
      }),
    ),
    v.maxLength(16),
  ),
});
export const spyLookSchema = v.strictObject({
  actor: seatSchema,
  target: seatSchema,
  request: v.strictObject({ seq: nonnegativeIntegerSchema, hash: hashSchema }),
  slots: v.pipe(
    v.array(
      v.strictObject({
        slotId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
        deck: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
        key: key32Schema,
        masked: key32Schema,
        /** Set once the target unlocked the card. */
        point: v.exactOptional(key32Schema),
      }),
    ),
    v.maxLength(16),
  ),
});

export interface SpyLook {
  actor: Seat;
  target: Seat;
  /** The certified parent of the actor's play; derivations and freshness anchor here. */
  request: { seq: number; hash: string };
  slots: readonly { slotId: string; deck: string; key: string; masked: string; point?: string }[];
}

/** The actor's lock scalar for one card it looks at, reproducible from its master secret. */
export function relockScalar(
  source: DeckSecretSource,
  context: { deckId: string; slotId: string; request: { seq: number; hash: string } },
): bigint {
  const seed = source.proofSeed('relock', context);
  try {
    return deriveScalar(seed, DERIVATION_LABELS.deckLock, { domain: 'spy-relock', context });
  } finally {
    seed.fill(0);
  }
}

function requestStatement(holder: SlotHolder, item: { key: string; masked: string }) {
  return {
    base1: holder.point,
    point1: item.masked,
    base2: encodePoint(G),
    point2: item.key,
  };
}

function requestProofContext(context: SpyRequestContext, holder: SlotHolder) {
  return {
    domain: 'cp2p/v1/spy-request',
    deckId: context.deckId,
    slotId: context.slotId,
    holder: { seat: holder.seat, point: holder.point, lockKey: holder.lockKey },
    action: context.action,
  };
}

export function proveSpyRequest(
  holder: SlotHolder,
  secret: bigint,
  seed: Uint8Array,
  context: SpyRequestContext,
): SpyRequestItem {
  const key = encodePoint(scalePoint(G, secret));
  const masked = encodePoint(scalePoint(decodePoint(holder.point), secret));
  return {
    slotId: context.slotId,
    key,
    masked,
    proof: proveDleq(
      requestStatement(holder, { key, masked }),
      secret,
      seed,
      requestProofContext(context, holder),
    ),
  };
}

export function verifySpyRequest(
  holder: SlotHolder,
  item: unknown,
  context: SpyRequestContext,
): Result<SpyRequestItem> {
  const parsed = parseCanonical(item, spyRequestSchema.entries.slots.item);
  if (!parsed.ok) return parsed;
  if (parsed.value.slotId !== context.slotId)
    return failure('spy-request-slot', 'Spy request is for another slot');
  try {
    decodePoint(parsed.value.key, { nonIdentity: true });
    decodePoint(parsed.value.masked, { nonIdentity: true });
    return verifyDleq(
      requestStatement(holder, parsed.value),
      parsed.value.proof,
      requestProofContext(context, holder),
    )
      ? success(parsed.value)
      : failure('spy-request-proof', 'The Spy lock does not match the held card');
  } catch {
    return failure('spy-request-proof', 'The Spy request has an invalid point');
  }
}

function unlockStatement(holder: SlotHolder, masked: string, point: string) {
  return { base1: point, point1: masked, base2: encodePoint(G), point2: holder.lockKey };
}

function unlockProofContext(
  action: DeckRevealContext,
  slotId: string,
  request: { seq: number; hash: string },
  holder: SlotHolder,
) {
  return {
    domain: 'cp2p/v1/spy-unlock',
    slotId,
    request,
    holder: { seat: holder.seat, point: holder.point, lockKey: holder.lockKey },
    action,
  };
}

export function proveSpyUnlock(
  holder: SlotHolder,
  masked: string,
  slotId: string,
  request: { seq: number; hash: string },
  lock: bigint,
  seed: Uint8Array,
  action: DeckRevealContext,
): SpyUnlockItem {
  const point = encodePoint(scalePoint(decodePoint(masked), invertScalar(lock)));
  return {
    slotId,
    point,
    proof: proveDleq(
      unlockStatement(holder, masked, point),
      lock,
      seed,
      unlockProofContext(action, slotId, request, holder),
    ),
  };
}

export function verifySpyUnlock(
  holder: SlotHolder,
  masked: string,
  item: unknown,
  slotId: string,
  request: { seq: number; hash: string },
  action: DeckRevealContext,
): Result<SpyUnlockItem> {
  const parsed = parseCanonical(item, spyUnlockSchema.entries.slots.item);
  if (!parsed.ok) return parsed;
  if (parsed.value.slotId !== slotId)
    return failure('spy-unlock-slot', 'Spy unlock is for another slot');
  try {
    decodePoint(parsed.value.point, { nonIdentity: true });
    return verifyDleq(
      unlockStatement(holder, masked, parsed.value.point),
      parsed.value.proof,
      unlockProofContext(action, slotId, request, holder),
    )
      ? success(parsed.value)
      : failure('spy-unlock-proof', 'The unlock did not remove exactly the holder’s lock');
  } catch {
    return failure('spy-unlock-proof', 'The Spy unlock has an invalid point');
  }
}

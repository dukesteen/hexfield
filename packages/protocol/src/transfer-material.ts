import { identityFromSecret } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import type { EntryRef } from './beacon-state.js';
import { genesisDigest } from './genesis.js';
import { verifyRevealedMaster } from './genesis-secrets.js';
import type { LogContext } from './log-types.js';
import { key32Schema, seatSchema } from './schema-values.js';

const secretSchema = v.custom<Uint8Array>(
  (value) => value instanceof Uint8Array && value.byteLength === 32,
);
const materialSchema = v.strictObject({
  protocol: v.literal('online-game-keys-v1'),
  genesisDigest: key32Schema,
  devicePeer: key32Schema,
  humanSeat: seatSchema,
  seats: v.pipe(
    v.array(
      v.strictObject({
        seat: seatSchema,
        kind: v.picklist(['human', 'bot']),
        peerId: key32Schema,
        signingKey: secretSchema,
        master: secretSchema,
      }),
    ),
    v.minLength(1),
    v.maxLength(6),
  ),
});

/** Local private material. Successful validation returns owned buffers; callers wipe them. */
export type TransferOwnedMaterial = v.InferOutput<typeof materialSchema>;
export type TransferOwnedSeat = TransferOwnedMaterial['seats'][number];

interface ExpectedMaterial {
  readonly devicePeer: string;
  readonly humanSeat: Seat;
  readonly seats: readonly { seat: Seat; kind: 'human' | 'bot'; publicKey: string }[];
}

function sameRef(left: EntryRef, right: EntryRef): boolean {
  return left.seq === right.seq && left.hash === right.hash;
}

function validateMaterial(
  value: unknown,
  context: LogContext,
  expected: ExpectedMaterial,
): Result<TransferOwnedMaterial> {
  if (context.genesis.security !== 'verified' || !context.crypto)
    return failure('transfer-material-context', 'Private import requires verified game history');
  const parsed = v.safeParse(materialSchema, value);
  if (!parsed.success)
    return failure('transfer-material-schema', 'Private import has an invalid bounded shape');
  // No canonical round-trip: that would leave an extra encoded copy of the secrets.
  const material: TransferOwnedMaterial = {
    ...parsed.output,
    seats: parsed.output.seats.map((seat) => ({
      ...seat,
      signingKey: new Uint8Array(seat.signingKey),
      master: new Uint8Array(seat.master),
    })),
  };
  let accepted = false;
  try {
    const seats = expected.seats.toSorted((left, right) => left.seat - right.seat);
    if (
      material.genesisDigest !== genesisDigest(context.genesis) ||
      material.devicePeer !== expected.devicePeer ||
      material.humanSeat !== expected.humanSeat ||
      !material.seats.some((seat) => seat.seat === expected.humanSeat && seat.kind === 'human') ||
      material.seats.length !== seats.length ||
      material.seats.some((seat, index) => {
        const owner = seats[index];
        return (
          !owner ||
          seat.seat !== owner.seat ||
          seat.kind !== owner.kind ||
          seat.peerId !== owner.publicKey
        );
      })
    )
      return failure('transfer-material-owner', 'Private import differs from certified ownership');
    for (const seat of material.seats) {
      const identity = identityFromSecret(seat.signingKey);
      try {
        if (identity.peerId !== seat.peerId)
          return failure(
            'transfer-material-key',
            'Private signing key differs from its controller',
          );
      } finally {
        identity.secretKey.fill(0);
      }
      const master = verifyRevealedMaster(
        context.genesis,
        context.crypto.decks,
        seat.seat,
        seat.master,
      );
      if (!master.ok) return master;
    }
    accepted = true;
    return success(material);
  } catch {
    return failure('transfer-material-invalid', 'Private import contains invalid key material');
  } finally {
    if (!accepted)
      for (const seat of material.seats) {
        seat.signingKey.fill(0);
        seat.master.fill(0);
      }
  }
}

/** Validate active material only against a context produced by certified replay. */
export function validateTransferOwnedMaterial(
  value: unknown,
  context: LogContext,
): Result<TransferOwnedMaterial> {
  const parsed = v.safeParse(materialSchema, value);
  if (!parsed.success)
    return failure('transfer-material-schema', 'Private import has an invalid bounded shape');
  const human = context.authority?.controllers.find(
    (seat) => seat.seat === parsed.output.humanSeat,
  );
  const route = context.transfer?.routes.find((seat) => seat.seat === human?.seat);
  if (!human || human.kind !== 'human' || human.status !== 'active' || !route?.devicePeer)
    return failure('transfer-material-authority', 'No active certified human owns this material');
  return validateMaterial(value, context, {
    humanSeat: human.seat,
    devicePeer: route.devicePeer,
    seats:
      context.authority?.controllers.filter(
        (seat) => seat.status === 'active' && seat.hostSeat === human.seat,
      ) ?? [],
  });
}

/** Pending keys can be stored and checked, but do not authorize voting before activation. */
export function validatePendingTransferMaterial(
  value: unknown,
  context: LogContext,
  authorization: EntryRef,
): Result<TransferOwnedMaterial> {
  const transfer = context.transfer;
  const pending = transfer?.authorizations.find((item) => sameRef(item.entry, authorization));
  if (!transfer?.pending || !sameRef(transfer.pending, authorization) || !pending)
    return failure('transfer-material-pending', 'Private import has no current authorization');
  const statement = pending.statement;
  return validateMaterial(value, context, {
    humanSeat: statement.seat,
    devicePeer: statement.destination.devicePeer,
    seats: statement.replacements.map((seat) => ({
      seat: seat.seat,
      kind: seat.seat === statement.seat ? 'human' : 'bot',
      publicKey: seat.newPublicKey,
    })),
  });
}

/**
 * Check an old local binding before erasing it. Its controller context is the
 * certified generation that installed that key, while the later master context
 * supplies completed deck commitments. Later recovery-owned slots need not be
 * in this original binding. This result never authorizes an active destination.
 */
export function validateRetiredTransferBinding(
  value: unknown,
  controllerContext: LogContext,
  masterContext: LogContext,
): Result<TransferOwnedMaterial> {
  const parsed = v.safeParse(materialSchema, value);
  if (!parsed.success)
    return failure('transfer-material-schema', 'Private import has an invalid bounded shape');
  if (
    genesisDigest(controllerContext.genesis) !== genesisDigest(masterContext.genesis) ||
    controllerContext.head.seq > masterContext.head.seq
  )
    return failure('transfer-material-history', 'Old binding belongs to another certified history');
  const human = controllerContext.authority?.controllers.find(
    (seat) => seat.seat === parsed.output.humanSeat,
  );
  const route = controllerContext.transfer?.routes.find((seat) => seat.seat === human?.seat);
  if (!human || human.kind !== 'human' || human.status !== 'active' || !route?.devicePeer)
    return failure('transfer-material-authority', 'Old binding has no certified human generation');
  const listed = new Set(parsed.output.seats.map((seat) => seat.seat));
  return validateMaterial(value, masterContext, {
    humanSeat: human.seat,
    devicePeer: route.devicePeer,
    seats:
      controllerContext.authority?.controllers.filter(
        (seat) => seat.status === 'active' && seat.hostSeat === human.seat && listed.has(seat.seat),
      ) ?? [],
  });
}

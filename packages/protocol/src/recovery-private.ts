import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import type { EntryRef } from './beacon-state.js';
import { genesisDigest } from './genesis.js';
import { verifyRevealedMaster } from './genesis-secrets.js';
import type { LogContext } from './log-types.js';
import { hashSchema, key32Schema, positiveIntegerSchema, seatSchema } from './schema-values.js';

const secretSchema = v.strictObject({
  seat: seatSchema,
  master: v.custom<Uint8Array>(
    (item): item is Uint8Array => item instanceof Uint8Array && item.length === 32,
  ),
});
const privateRecordSchema = v.strictObject({
  version: v.literal(1),
  genesisDigest: key32Schema,
  authorization: v.strictObject({ seq: positiveIntegerSchema, hash: hashSchema }),
  recipientSeat: seatSchema,
  secrets: v.pipe(v.array(secretSchema), v.minLength(1), v.maxLength(6)),
});
type PrivateRecord = v.InferOutput<typeof privateRecordSchema>;
type Secret = PrivateRecord['secrets'][number];

/**
 * Local private storage; never publish these bytes in messages or public saves.
 * load returns a fresh owned buffer. putIfAbsent copies its input before awaiting,
 * resolves only after durable commit, and never retains the caller's array.
 * Callers wipe both returned and supplied buffers after each operation.
 */
export interface RecoveryPrivateStore {
  load(id: string): Promise<Uint8Array | null>;
  putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean>;
}

function sameRef(a: EntryRef, b: EntryRef): boolean {
  return a.seq === b.seq && a.hash === b.hash;
}

function privateScope(context: LogContext, authorization: EntryRef, recipientSeat: Seat) {
  const recovery = context.recovery;
  const approved = recovery?.authorizations.find((item) => sameRef(item.entry, authorization));
  const active = context.authority?.controllers.find((item) => item.seat === recipientSeat);
  const recipient = approved?.statement.recoverers.find((item) => item.seat === recipientSeat);
  if (
    !approved ||
    !recipient ||
    !context.crypto ||
    active?.kind !== 'human' ||
    active.status !== 'active' ||
    active.publicKey !== recipient.publicKey ||
    !(
      (recovery?.pending && sameRef(recovery.pending, authorization)) ||
      recovery?.completed.some((item) => sameRef(item.authorization, authorization))
    )
  )
    return failure(
      'recovery-private-authority',
      'Recovery secrets require certified authorization',
    );
  return success({
    version: 1 as const,
    genesisDigest: genesisDigest(context.genesis),
    authorization: { ...authorization },
    recipientSeat,
    seats: approved.statement.replacements.map(({ seat }) => seat),
  });
}

function recordId(record: Omit<PrivateRecord, 'secrets'>): string {
  return `recovery-private/${record.genesisDigest}/${record.authorization.seq}-${record.authorization.hash}/${record.recipientSeat}`;
}

function validateSecrets(context: LogContext, secrets: readonly Secret[], seats: readonly Seat[]) {
  if (
    !context.crypto ||
    secrets.length !== seats.length ||
    secrets.some((secret, index) => secret.seat !== seats[index])
  )
    return failure('recovery-private-seats', 'Private record must contain every affected seat');
  for (const { seat, master } of secrets) {
    const verified = verifyRevealedMaster(context.genesis, context.crypto.decks, seat, master);
    if (!verified.ok) return verified;
  }
  return success(undefined);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Persist verified masters before publishing the activation check that depends on them. */
export async function persistRecoveryPrivate(
  context: LogContext,
  authorization: EntryRef,
  recipientSeat: Seat,
  secrets: readonly Secret[],
  store: RecoveryPrivateStore,
): Promise<Result<void>> {
  const scope = privateScope(context, authorization, recipientSeat);
  if (!scope.ok) return scope;
  let record: PrivateRecord | undefined;
  const copies: Secret[] = [];
  let bytes: Uint8Array | undefined;
  let existing: Uint8Array | null = null;
  try {
    const { seats, ...binding } = scope.value;
    for (const { seat, master } of secrets) copies.push({ seat, master: master.slice() });
    record = v.parse(privateRecordSchema, { ...binding, secrets: copies });
    const verified = validateSecrets(context, record.secrets, seats);
    if (!verified.ok) return verified;
    bytes = canonicalEncode(record);
    const id = recordId(record);
    if (await store.putIfAbsent(id, bytes)) return success(undefined);
    existing = await store.load(id);
    return existing && sameBytes(existing, bytes)
      ? success(undefined)
      : failure(
          'recovery-private-conflict',
          'An inconsistent private record occupies this authorization',
        );
  } catch {
    return failure('recovery-private-storage', 'Could not durably retain recovered secrets');
  } finally {
    copies.forEach(({ master }) => master.fill(0));
    bytes?.fill(0);
    existing?.fill(0);
  }
}

/** Restart reads only secrets authorized by the caller's fully replayed certified history. */
export async function loadRecoveryPrivate(
  context: LogContext,
  authorization: EntryRef,
  recipientSeat: Seat,
  store: RecoveryPrivateStore,
): Promise<Result<{ readonly secrets: readonly Secret[]; dispose(): void }>> {
  const scope = privateScope(context, authorization, recipientSeat);
  if (!scope.ok) return scope;
  // Retain an owned public snapshot across the storage await.
  const snapshot = canonicalClone({ genesis: context.genesis, crypto: context.crypto });
  let bytes: Uint8Array | null = null;
  let record: PrivateRecord | undefined;
  let canonicalRecord: Uint8Array | undefined;
  let decoded: unknown;
  try {
    bytes = await store.load(recordId(scope.value));
    if (!bytes || bytes.length > 4096)
      return failure(
        'recovery-private-storage',
        'Recovered private record is missing or oversized',
      );
    decoded = canonicalDecode(bytes);
    record = v.parse(privateRecordSchema, decoded);
    canonicalRecord = canonicalEncode(record);
    if (
      !sameBytes(bytes, canonicalRecord) ||
      record.genesisDigest !== scope.value.genesisDigest ||
      !sameRef(record.authorization, scope.value.authorization) ||
      record.recipientSeat !== scope.value.recipientSeat
    )
      return failure('recovery-private-binding', 'Private record belongs to another recovery');
    const verified = validateSecrets(
      { ...context, ...snapshot },
      record.secrets,
      scope.value.seats,
    );
    if (!verified.ok) return verified;
    const secrets = record.secrets.map(({ seat, master }) => ({ seat, master: master.slice() }));
    const buffers = secrets.map(({ master }) => master);
    return success({ secrets, dispose: () => buffers.forEach((master) => master.fill(0)) });
  } catch {
    return failure(
      'recovery-private-storage',
      'Recovered private record is malformed or unreadable',
    );
  } finally {
    wipeDecodedSecrets(decoded);
    bytes?.fill(0);
    canonicalRecord?.fill(0);
  }
}

function wipeDecodedSecrets(value: unknown): void {
  if (!value || typeof value !== 'object' || !('secrets' in value) || !Array.isArray(value.secrets))
    return;
  for (const secret of value.secrets) {
    if (
      secret &&
      typeof secret === 'object' &&
      'master' in secret &&
      secret.master instanceof Uint8Array
    )
      secret.master.fill(0);
  }
}

function canonicalClone<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only validated canonical public domain data is copied.
  return canonicalDecode(canonicalEncode(value)) as T;
}

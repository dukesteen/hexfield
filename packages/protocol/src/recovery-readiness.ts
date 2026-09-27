import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { identityFromSecret, parsePeerId, signObject, verifyObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import {
  RECOVERY_READINESS_DOMAIN,
  recoveryChangeSchema,
  recoveryReadinessSchema,
  validateRecoveryTransition,
} from './recovery-membership.js';
import { entryHash, genesisDigest, signEntry } from './genesis.js';
import type { LogContext } from './log-types.js';
import type { RecoveryAuthorization, RecoveryReadiness } from './recovery-types.js';
import { seatSchema, signature64Schema } from './schema-values.js';
import type { LogEntry } from './types.js';
import { MAX_MESSAGE_BYTES } from './validation.js';

const secretKeySchema = v.custom<Uint8Array>(
  (value): value is Uint8Array => value instanceof Uint8Array && value.byteLength === 32,
);
const readinessStoreEntrySchema = v.strictObject({
  version: v.literal(1),
  slot: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  statement: v.unknown(),
  authorization: v.strictObject({
    kind: v.literal('recovery-authorize'),
    statement: v.unknown(),
    hostSig: signature64Schema,
    keySigs: v.array(v.strictObject({ seat: seatSchema, sig: signature64Schema })),
  }),
  replacements: v.pipe(
    v.array(v.strictObject({ seat: seatSchema, secretKey: secretKeySchema })),
    v.minLength(1),
    v.maxLength(6),
  ),
});

export interface RecoveryReadinessReplacement {
  readonly seat: Seat;
  readonly secretKey: Uint8Array;
}

/** The store must return owned byte copies and must not retain the caller's input buffer. */
export interface RecoveryReadinessStore {
  load(key: string): Promise<Uint8Array | null>;
  putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean>;
}

export interface ActivatedRecoveryKey {
  readonly seat: Seat;
  readonly secretKey: Uint8Array;
}

export interface ActivatedRecoveryKeySet {
  /** Owned copies for currently active recovered bot seats hosted by the requested human. */
  readonly keys: readonly ActivatedRecoveryKey[];
  /** Zero every returned signing key. Safe to call more than once. */
  dispose(): void;
}

interface FrozenInput {
  statement: RecoveryReadiness;
  context: LogContext;
  hostKey: Uint8Array;
  replacements: { seat: Seat; secretKey: Uint8Array }[];
  slot: string;
}

/** Persist fresh replacement keys and their exact readiness statement before exposing signatures. */
export async function prepareRecoveryReadiness(
  statement: RecoveryReadiness,
  context: LogContext,
  hostSigningKey: Uint8Array,
  replacements: readonly RecoveryReadinessReplacement[],
  store: RecoveryReadinessStore,
): Promise<Result<RecoveryAuthorization>> {
  let frozen: FrozenInput;
  try {
    frozen = freezeInput(statement, context, hostSigningKey, replacements);
  } catch {
    return failure('recovery-readiness-input', 'Readiness inputs are malformed');
  }
  const temporaryKeys = [frozen.hostKey, ...frozen.replacements.map((item) => item.secretKey)];
  const derivedKeys: Uint8Array[] = [];
  let encodedRecord: Uint8Array | null = null;
  let writeBuffer: Uint8Array | null = null;
  try {
    const hostIdentity = identityFromSecret(frozen.hostKey);
    derivedKeys.push(hostIdentity.secretKey);
    const replacementRows = frozen.replacements.map(({ seat, secretKey }) => {
      const identity = identityFromSecret(secretKey);
      derivedKeys.push(identity.secretKey);
      return { seat, publicKey: identity.peerId };
    });
    if (!sameValue(replacementRows, frozen.statement.replacements))
      return failure(
        'recovery-readiness-keys',
        'Replacement keys do not match the signed readiness statement',
      );

    const authorization: RecoveryAuthorization = {
      kind: 'recovery-authorize',
      statement: frozen.statement,
      hostSig: signObject(RECOVERY_READINESS_DOMAIN, frozen.statement, frozen.hostKey),
      keySigs: frozen.replacements.map(({ seat, secretKey }) => ({
        seat,
        sig: signObject(RECOVERY_READINESS_DOMAIN, frozen.statement, secretKey),
      })),
    };
    const provisional = provisionalEntry(
      frozen.context,
      authorization,
      frozen.hostKey,
      hostIdentity.peerId,
    );
    const validated = validateRecoveryTransition(
      authorization,
      provisional,
      frozen.context,
      frozen.context.crypto,
    );
    if (!validated.ok) return validated;

    const existing = await readStored(
      frozen.slot,
      frozen.statement,
      frozen.replacements,
      frozen.context,
      frozen.hostKey,
      hostIdentity.peerId,
      store,
    );
    if (existing.kind === 'match') return success(existing.authorization);
    if (existing.kind === 'conflict')
      return failure(
        'recovery-readiness-conflict',
        'A different readiness statement or replacement key set already occupies this slot',
      );
    if (existing.kind === 'corrupt')
      return failure('recovery-readiness-store', 'Stored readiness record is corrupt or invalid');

    encodedRecord = canonicalEncode({
      version: 1,
      slot: frozen.slot,
      statement: frozen.statement,
      authorization,
      replacements: frozen.replacements,
    });
    if (encodedRecord.byteLength > MAX_MESSAGE_BYTES)
      return failure('recovery-readiness-size', 'Readiness record exceeds its storage limit');

    let inserted: boolean;
    try {
      writeBuffer = encodedRecord.slice();
      inserted = await store.putIfAbsent(frozen.slot, writeBuffer);
    } catch {
      const uncertain = await readStored(
        frozen.slot,
        frozen.statement,
        frozen.replacements,
        frozen.context,
        frozen.hostKey,
        hostIdentity.peerId,
        store,
      );
      return uncertain.kind === 'match'
        ? success(uncertain.authorization)
        : failure('recovery-readiness-write', 'Could not confirm durable readiness storage');
    }
    if (inserted) return success(authorization);

    const raced = await readStored(
      frozen.slot,
      frozen.statement,
      frozen.replacements,
      frozen.context,
      frozen.hostKey,
      hostIdentity.peerId,
      store,
    );
    if (raced.kind === 'match') return success(raced.authorization);
    return raced.kind === 'corrupt'
      ? failure('recovery-readiness-store', 'Stored readiness record is corrupt or invalid')
      : failure(
          'recovery-readiness-conflict',
          'A different readiness statement or replacement key set already occupies this slot',
        );
  } catch {
    return failure('recovery-readiness-store', 'Could not read or persist readiness data');
  } finally {
    for (const key of temporaryKeys) key.fill(0);
    for (const key of derivedKeys) key.fill(0);
    writeBuffer?.fill(0);
    encodedRecord?.fill(0);
  }
}

/** Restore a pre-certification reservation without regenerating or exposing its secret keys. */
export async function loadPreparedRecoveryReadiness(
  context: LogContext,
  hostSeat: Seat,
  departedSeat: Seat,
  hostSigningKey: Uint8Array,
  store: RecoveryReadinessStore,
): Promise<Result<RecoveryAuthorization | null>> {
  if (!(hostSigningKey instanceof Uint8Array) || hostSigningKey.byteLength !== 32)
    return failure('recovery-readiness-input', 'Host signing key is invalid');
  const key = hostSigningKey.slice();
  let stored: Uint8Array | null = null;
  let decoded: unknown;
  let canonical: Uint8Array | null = null;
  let identityKey: Uint8Array | null = null;
  try {
    const snapshot: LogContext = {
      genesis: canonicalClone(context.genesis),
      engine: context.engine,
      head: canonicalClone(context.head),
      state: canonicalClone(context.state),
      lastNonces: new Map(context.lastNonces),
      crypto: context.crypto === null ? null : canonicalClone(context.crypto),
      ...(context.authority === undefined ? {} : { authority: canonicalClone(context.authority) }),
      ...(context.recovery === undefined ? {} : { recovery: canonicalClone(context.recovery) }),
    };
    const slot = [
      'recovery-readiness',
      genesisDigest(snapshot.genesis),
      snapshot.head.seq,
      entryHash(snapshot.head),
      (snapshot.authority?.epoch ?? -1) + 1,
      departedSeat,
      hostSeat,
    ].join('/');
    stored = await store.load(slot);
    if (stored === null) return success(null);
    if (stored.byteLength > MAX_MESSAGE_BYTES)
      return failure('recovery-readiness-store', 'Stored readiness record is too large');
    decoded = canonicalDecode(stored);
    const record = v.parse(readinessStoreEntrySchema, decoded);
    canonical = canonicalEncode(record);
    if (record.slot !== slot || !sameBytes(canonical, stored))
      return failure('recovery-readiness-store', 'Stored readiness record is invalid');
    const statement = v.parse(recoveryReadinessSchema, record.statement);
    const parsed = v.parse(recoveryChangeSchema, record.authorization);
    if (
      parsed.kind !== 'recovery-authorize' ||
      !sameValue(parsed.statement, statement) ||
      statement.departedSeat !== departedSeat ||
      statement.hostSeat !== hostSeat ||
      record.replacements.length !== statement.replacements.length
    )
      return failure('recovery-readiness-store', 'Stored readiness binding is invalid');
    const hostIdentity = identityFromSecret(key);
    identityKey = hostIdentity.secretKey;
    const host = snapshot.authority?.controllers.find((item) => item.seat === hostSeat);
    if (
      host?.kind !== 'human' ||
      host.status !== 'active' ||
      host.publicKey !== hostIdentity.peerId
    )
      return failure('recovery-readiness-host', 'Local host key differs from certified authority');
    for (const [index, replacement] of record.replacements.entries()) {
      const identity = identityFromSecret(replacement.secretKey);
      try {
        if (
          replacement.seat !== statement.replacements[index]?.seat ||
          identity.peerId !== statement.replacements[index]?.publicKey
        )
          return failure(
            'recovery-readiness-store',
            'Stored replacement key differs from its statement',
          );
      } finally {
        identity.secretKey.fill(0);
      }
    }
    const provisional = provisionalEntry(snapshot, parsed, key, hostIdentity.peerId);
    const checked = validateRecoveryTransition(parsed, provisional, snapshot, snapshot.crypto);
    return checked.ok ? success(parsed) : checked;
  } catch {
    return failure('recovery-readiness-store', 'Could not validate stored readiness');
  } finally {
    key.fill(0);
    identityKey?.fill(0);
    stored?.fill(0);
    canonical?.fill(0);
    if (decoded && typeof decoded === 'object' && 'replacements' in decoded) {
      const replacements = (decoded as { replacements?: unknown }).replacements;
      if (Array.isArray(replacements))
        for (const replacement of replacements)
          if (replacement && typeof replacement === 'object' && 'secretKey' in replacement) {
            const secretKey = replacement.secretKey;
            if (secretKey instanceof Uint8Array) secretKey.fill(0);
          }
    }
  }
}

/** Restore only keys activated by the certified authority and recovery history in context. */
export async function loadActivatedRecoveryKeys(
  context: LogContext,
  hostSeat: Seat,
  store: RecoveryReadinessStore,
): Promise<Result<ActivatedRecoveryKeySet>> {
  let plans: ActivatedReadinessPlan[];
  try {
    plans = activatedReadinessPlans(context, hostSeat);
  } catch {
    return failure('recovery-readiness-context', 'Certified recovery context is malformed');
  }
  if (!plans.length)
    return failure(
      'recovery-readiness-unavailable',
      'No completed recovery keys are active for this host',
    );

  const keys: ActivatedRecoveryKey[] = [];
  try {
    const settled = await Promise.allSettled(plans.map((plan) => readActivatedRecord(plan, store)));
    const loaded = settled.flatMap((item) => (item.status === 'fulfilled' ? [item.value] : []));
    if (settled.some((item) => item.status === 'rejected')) {
      disposeKeys(loaded.flatMap((item) => (item.ok ? item.value : [])));
      return failure('recovery-readiness-store', 'Could not restore activated recovery keys');
    }
    const failureResult = loaded.find((item) => !item.ok);
    if (failureResult && !failureResult.ok) {
      disposeKeys([...keys, ...loaded.flatMap((item) => (item.ok ? item.value : []))]);
      return failureResult;
    }
    for (const item of loaded) if (item.ok) keys.push(...item.value);
    return success({
      keys,
      dispose: () => disposeKeys(keys),
    });
  } catch {
    disposeKeys(keys);
    return failure('recovery-readiness-store', 'Could not restore activated recovery keys');
  }
}

function freezeInput(
  statement: RecoveryReadiness,
  context: LogContext,
  hostSigningKey: Uint8Array,
  replacements: readonly RecoveryReadinessReplacement[],
): FrozenInput {
  const parsedStatement = v.parse(
    recoveryReadinessSchema,
    canonicalDecode(canonicalEncode(statement)),
  );
  if (!(hostSigningKey instanceof Uint8Array) || hostSigningKey.byteLength !== 32)
    throw new TypeError('Host signing key is invalid');
  if (!Array.isArray(replacements) || replacements.length === 0 || replacements.length > 6)
    throw new TypeError('Replacement key list is invalid');
  const hostKey = hostSigningKey.slice();
  const copiedReplacements: { seat: Seat; secretKey: Uint8Array }[] = [];
  try {
    for (const replacement of replacements) {
      if (
        !replacement ||
        !Number.isSafeInteger(replacement.seat) ||
        !(replacement.secretKey instanceof Uint8Array) ||
        replacement.secretKey.byteLength !== 32
      )
        throw new TypeError('Replacement key is invalid');
      copiedReplacements.push({ seat: replacement.seat, secretKey: replacement.secretKey.slice() });
    }
    const contextSnapshot: LogContext = {
      genesis: canonicalClone(context.genesis),
      engine: context.engine,
      head: canonicalClone(context.head),
      state: canonicalClone(context.state),
      lastNonces: new Map(context.lastNonces),
      crypto: context.crypto === null ? null : canonicalClone(context.crypto),
      ...(context.authority === undefined ? {} : { authority: canonicalClone(context.authority) }),
      ...(context.recovery === undefined ? {} : { recovery: canonicalClone(context.recovery) }),
    };
    const slot = readinessSlot(parsedStatement);
    return {
      statement: parsedStatement,
      context: contextSnapshot,
      hostKey,
      replacements: copiedReplacements,
      slot,
    };
  } catch (error) {
    hostKey.fill(0);
    for (const replacement of copiedReplacements) replacement.secretKey.fill(0);
    throw error;
  }
}

function provisionalEntry(
  context: LogContext,
  authorization: RecoveryAuthorization,
  signingKey: Uint8Array,
  publicKey: string,
): LogEntry {
  return signEntry(
    {
      seq: context.head.seq + 1,
      term: Math.max(1, context.head.term),
      prevHash: entryHash(context.head),
      payload: { kind: 'membership', change: authorization },
      stateHash: context.head.stateHash,
      sequencer: publicKey,
    },
    signingKey,
  );
}

function readinessSlot(statement: RecoveryReadiness): string {
  return [
    'recovery-readiness',
    statement.genesisDigest,
    statement.parent.seq,
    statement.parent.hash,
    statement.nextEpoch,
    statement.departedSeat,
    statement.hostSeat,
  ].join('/');
}

interface ActivatedReadinessPlan {
  slot: string;
  statement: RecoveryReadiness;
  authorizationEntry: { seq: number; hash: string };
  hostPublicKey: string;
  targets: readonly { seat: Seat; publicKey: string }[];
}

function activatedReadinessPlans(context: LogContext, hostSeat: Seat): ActivatedReadinessPlan[] {
  v.parse(seatSchema, hostSeat);
  if (!context.authority || !context.recovery)
    throw new TypeError('Certified recovery authority and history are required');
  const authority = canonicalClone(context.authority);
  const recovery = canonicalClone(context.recovery);
  const gameDigest = genesisDigest(context.genesis);
  const host = authority.controllers.find(
    (controller) => controller.seat === hostSeat && controller.kind === 'human',
  );
  if (!host || host.status !== 'active')
    throw new TypeError('Recovery host must be a current active human');

  const grouped = new Map<string, ActivatedReadinessPlan>();
  for (const controller of authority.controllers) {
    if (
      controller.kind !== 'bot' ||
      controller.status !== 'active' ||
      controller.hostSeat !== hostSeat ||
      controller.activatedAt.seq === 0
    )
      continue;
    const completion = recovery.completed.find((item) =>
      sameValue(item.activation, controller.activatedAt),
    );
    if (!completion) throw new TypeError('Active recovered controller has no matching completion');
    const authorization = recovery.authorizations.find((item) =>
      sameValue(item.entry, completion.authorization),
    );
    if (!authorization) throw new TypeError('Completed recovery has no matching authorization');
    const statement = v.parse(recoveryReadinessSchema, authorization.statement);
    const replacement = statement.replacements.find((item) => item.seat === controller.seat);
    if (
      statement.genesisDigest !== gameDigest ||
      statement.hostSeat !== hostSeat ||
      !replacement ||
      replacement.publicKey !== controller.publicKey ||
      !sameValue(authorization.entry, completion.authorization)
    )
      throw new TypeError('Certified recovery history does not reserve the active controller');

    const slot = readinessSlot(statement);
    const existing = grouped.get(slot);
    if (existing) {
      if (
        !sameValue(existing.statement, statement) ||
        !sameValue(existing.authorizationEntry, authorization.entry)
      )
        throw new TypeError('Recovery history has conflicting records for one readiness slot');
      grouped.set(slot, {
        ...existing,
        targets: [...existing.targets, { seat: controller.seat, publicKey: controller.publicKey }],
      });
    } else {
      grouped.set(slot, {
        slot,
        statement,
        authorizationEntry: canonicalClone(authorization.entry),
        hostPublicKey: host.publicKey,
        targets: [{ seat: controller.seat, publicKey: controller.publicKey }],
      });
    }
  }
  return [...grouped.values()];
}

async function readActivatedRecord(
  plan: ActivatedReadinessPlan,
  store: RecoveryReadinessStore,
): Promise<Result<ActivatedRecoveryKey[]>> {
  let returned: Uint8Array | null;
  try {
    returned = await store.load(plan.slot);
  } catch {
    return failure('recovery-readiness-store', 'Could not read an activated recovery record');
  }
  if (returned === null)
    return failure(
      'recovery-readiness-unavailable',
      'An activated recovery signing key is not stored on this device',
    );

  const bytes = returned.slice();
  let decoded: unknown;
  let canonicalRecord: Uint8Array | null = null;
  const identitySecrets: Uint8Array[] = [];
  const keys: ActivatedRecoveryKey[] = [];
  try {
    if (bytes.byteLength > MAX_MESSAGE_BYTES)
      return failure('recovery-readiness-store', 'Stored recovery record is oversized');
    decoded = canonicalDecode(bytes);
    const record = v.parse(readinessStoreEntrySchema, decoded);
    canonicalRecord = canonicalEncode(record);
    if (!sameBytes(canonicalRecord, bytes) || record.slot !== plan.slot)
      return failure('recovery-readiness-store', 'Stored recovery record is not canonical');

    const statement = v.parse(recoveryReadinessSchema, record.statement);
    const authorization = v.parse(recoveryChangeSchema, record.authorization);
    if (
      authorization.kind !== 'recovery-authorize' ||
      !sameValue(statement, plan.statement) ||
      !sameValue(authorization.statement, plan.statement)
    )
      return failure(
        'recovery-readiness-store',
        'Stored readiness statement differs from the certified authorization',
      );
    if (
      record.replacements.length !== statement.replacements.length ||
      record.replacements.some(
        (stored, index) =>
          stored.seat !== statement.replacements[index]?.seat ||
          statement.replacements[index]?.publicKey !==
            identityFromStoredKey(stored.secretKey, identitySecrets),
      )
    )
      return failure(
        'recovery-readiness-store',
        'Stored replacement keys do not match the certified replacement set',
      );
    if (!validReadinessSignatures(authorization, plan.hostPublicKey))
      return failure('recovery-readiness-store', 'Stored readiness signatures are invalid');

    const targets = plan.targets.map((target) => ({
      target,
      stored: record.replacements.find((item) => item.seat === target.seat),
    }));
    if (
      targets.some(
        ({ target, stored }) =>
          !stored ||
          statement.replacements.find((item) => item.seat === target.seat)?.publicKey !==
            target.publicKey,
      )
    )
      return failure(
        'recovery-readiness-store',
        'Stored readiness record does not contain the activated seat key',
      );
    for (const { target, stored } of targets) {
      if (!stored) throw new TypeError('Activated key disappeared during restore');
      keys.push({ seat: target.seat, secretKey: stored.secretKey.slice() });
    }
    return success(keys);
  } catch {
    disposeKeys(keys);
    return failure('recovery-readiness-store', 'Stored recovery record is corrupt or invalid');
  } finally {
    returned.fill(0);
    bytes.fill(0);
    canonicalRecord?.fill(0);
    for (const secretKey of identitySecrets) secretKey.fill(0);
    disposeDecodedSecrets(decoded);
  }
}

function identityFromStoredKey(secretKey: Uint8Array, identitySecrets: Uint8Array[]): string {
  const identity = identityFromSecret(secretKey);
  identitySecrets.push(identity.secretKey);
  return identity.peerId;
}

function validReadinessSignatures(
  authorization: RecoveryAuthorization,
  currentHostPublicKey: string,
): boolean {
  try {
    const statement = authorization.statement;
    const host = statement.recoverers.find((member) => member.seat === statement.hostSeat);
    return (
      host !== undefined &&
      host.publicKey === currentHostPublicKey &&
      verifyObject(
        RECOVERY_READINESS_DOMAIN,
        statement,
        authorization.hostSig,
        parsePeerId(host.publicKey),
      ) &&
      authorization.keySigs.length === statement.replacements.length &&
      statement.replacements.every((replacement, index) => {
        const signature = authorization.keySigs[index];
        return (
          signature?.seat === replacement.seat &&
          verifyObject(
            RECOVERY_READINESS_DOMAIN,
            statement,
            signature.sig,
            parsePeerId(replacement.publicKey),
          )
        );
      })
    );
  } catch {
    return false;
  }
}

function disposeDecodedSecrets(decoded: unknown): void {
  if (decoded && typeof decoded === 'object' && 'replacements' in decoded) {
    const storedReplacements = (decoded as { replacements?: unknown }).replacements;
    if (Array.isArray(storedReplacements))
      for (const replacement of storedReplacements)
        if (replacement && typeof replacement === 'object' && 'secretKey' in replacement) {
          const secretKey = replacement.secretKey;
          if (secretKey instanceof Uint8Array) secretKey.fill(0);
        }
  }
}

function disposeKeys(keys: readonly ActivatedRecoveryKey[]): void {
  for (const key of keys) key.secretKey.fill(0);
}

type StoredReadiness =
  | { kind: 'missing' }
  | { kind: 'match'; authorization: RecoveryAuthorization }
  | { kind: 'conflict' }
  | { kind: 'corrupt' };

async function readStored(
  slot: string,
  statement: RecoveryReadiness,
  replacements: readonly { seat: Seat; secretKey: Uint8Array }[],
  context: LogContext,
  hostSigningKey: Uint8Array,
  hostPublicKey: string,
  store: RecoveryReadinessStore,
): Promise<StoredReadiness> {
  let returned: Uint8Array | null;
  try {
    returned = await store.load(slot);
  } catch {
    return { kind: 'corrupt' };
  }
  if (returned === null) return { kind: 'missing' };
  const bytes = returned.slice();
  let decoded: unknown;
  let canonicalRecord: Uint8Array | null = null;
  try {
    if (bytes.byteLength > MAX_MESSAGE_BYTES) return { kind: 'corrupt' };
    decoded = canonicalDecode(bytes);
    const record = v.parse(readinessStoreEntrySchema, decoded);
    canonicalRecord = canonicalEncode(record);
    if (!sameBytes(canonicalRecord, bytes)) return { kind: 'corrupt' };
    if (
      record.slot !== slot ||
      !sameValue(record.statement, statement) ||
      record.authorization.kind !== 'recovery-authorize' ||
      !sameValue(record.authorization.statement, statement) ||
      record.replacements.length !== replacements.length ||
      record.replacements.some(
        (stored, index) =>
          stored.seat !== replacements[index]?.seat ||
          !sameBytes(stored.secretKey, replacements[index]?.secretKey),
      )
    )
      return { kind: 'conflict' };
    const checkedStatement = v.parse(recoveryReadinessSchema, record.statement);
    const checkedAuthorization = v.parse(recoveryChangeSchema, record.authorization);
    if (checkedAuthorization.kind !== 'recovery-authorize') return { kind: 'corrupt' };
    if (!sameValue(checkedStatement, checkedAuthorization.statement)) return { kind: 'corrupt' };
    const provisional = provisionalEntry(
      context,
      checkedAuthorization,
      hostSigningKey,
      hostPublicKey,
    );
    const validated = validateRecoveryTransition(
      checkedAuthorization,
      provisional,
      context,
      context.crypto,
    );
    if (!validated.ok) return { kind: 'corrupt' };
    return { kind: 'match', authorization: checkedAuthorization };
  } catch {
    return { kind: 'corrupt' };
  } finally {
    bytes.fill(0);
    returned.fill(0);
    canonicalRecord?.fill(0);
    if (decoded && typeof decoded === 'object' && 'replacements' in decoded) {
      const storedReplacements = (decoded as { replacements?: unknown }).replacements;
      if (Array.isArray(storedReplacements))
        for (const replacement of storedReplacements)
          if (replacement && typeof replacement === 'object' && 'secretKey' in replacement) {
            const secretKey = replacement.secretKey;
            if (secretKey instanceof Uint8Array) secretKey.fill(0);
          }
    }
  }
}

function canonicalClone<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Caller supplies a replay-validated canonical value; decoding creates its detached snapshot.
  return canonicalDecode(canonicalEncode(value)) as T;
}

function sameValue(left: unknown, right: unknown): boolean {
  return sameBytes(canonicalEncode(left), canonicalEncode(right));
}

function sameBytes(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

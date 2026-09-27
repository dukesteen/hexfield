import { canonicalDecode, canonicalEncode, fromBase64Url, toBase64Url } from '@cp2p/codec';
import {
  DERIVATION_LABELS,
  deriveScalar,
  encodePoint,
  G,
  identityFromSecret,
  parsePeerId,
  scalarFromBytes,
  scalarToBytes,
  scalePoint,
  signObject,
} from '@cp2p/crypto';
import type { Seat } from '@cp2p/engine';
import {
  TRANSFER_BOT_KEY_DOMAIN,
  TRANSFER_DEVICE_DOMAIN,
  TRANSFER_GAME_KEY_DOMAIN,
  transferAuthorizationStatementSchema,
} from '@cp2p/protocol';
import type { SeatTransferAuthorizationStatement, TransferReplacement } from '@cp2p/protocol';
import * as v from 'valibot';
import type {
  DisposableOnlineIdentity,
  OnlineCredentialStore,
  RandomBytes,
} from './online-credentials.js';

const RECORD_PROTOCOL = 'cp2p/online-transfer-credentials/v1';
const SLOT_PREFIX = 'online-transfer-credentials/v1';
const MAX_RECORD_BYTES = 16 * 1024;
const VALID_SEATS: readonly Seat[] = [0, 1, 2, 3, 4, 5];

/** The generated public keys and encryption point are deliberately absent from this scope. */
export interface OnlineTransferCredentialScope {
  readonly attemptId: string;
  readonly genesisDigest: string;
  readonly anchor: SeatTransferAuthorizationStatement['anchor'];
  readonly validUntilSeq: number;
  readonly mode: SeatTransferAuthorizationStatement['mode'];
  readonly seat: Seat;
  readonly currentController: SeatTransferAuthorizationStatement['currentController'];
  readonly recovery: SeatTransferAuthorizationStatement['recovery'];
  readonly nextEpoch: number;
  readonly devicePeer: string;
  readonly replacements: readonly Omit<TransferReplacement, 'newPublicKey'>[];
}

export interface OwnedOnlineTransferKey {
  readonly seat: Seat;
  readonly peerId: string;
  readonly signingKey: Uint8Array;
}

export interface OwnedOnlineTransferCredentials {
  readonly authorization: {
    readonly kind: 'transfer-authorize';
    readonly statement: SeatTransferAuthorizationStatement;
    readonly destinationDeviceSig: string;
    readonly destinationGameSig: string;
    readonly replacementKeySigs: readonly { readonly seat: Seat; readonly sig: string }[];
  };
  readonly keys: readonly OwnedOnlineTransferKey[];
  readonly encryptionSecret: Uint8Array;
  dispose(): void;
}

interface StoredKey {
  readonly seat: Seat;
  readonly signingKey: Uint8Array;
}

interface StoredRecord {
  readonly protocol: typeof RECORD_PROTOCOL;
  readonly attemptId: string;
  readonly statement: SeatTransferAuthorizationStatement;
  readonly encryptionSecret: Uint8Array;
  readonly keys: readonly StoredKey[];
}

const bytes32Schema = v.custom<Uint8Array>(
  (value) => value instanceof Uint8Array && value.length === 32,
);
const storedKeySchema = v.strictObject({
  seat: v.picklist(VALID_SEATS),
  signingKey: bytes32Schema,
});
const storedRecordSchema = v.strictObject({
  protocol: v.literal(RECORD_PROTOCOL),
  attemptId: v.string(),
  statement: transferAuthorizationStatementSchema,
  encryptionSecret: bytes32Schema,
  keys: v.pipe(v.array(storedKeySchema), v.minLength(1), v.maxLength(6)),
});

function browserRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function randomSeed(randomBytes: RandomBytes): Uint8Array {
  const supplied = randomBytes(32);
  if (!(supplied instanceof Uint8Array) || supplied.length !== 32) {
    if (supplied instanceof Uint8Array) supplied.fill(0);
    throw new TypeError('Transfer credential entropy must return exactly 32 bytes');
  }
  const copy = new Uint8Array(supplied);
  supplied.fill(0);
  return copy;
}

function wipe(value: unknown, seen = new Set<object>()): void {
  if (value instanceof Uint8Array) {
    value.fill(0);
    return;
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) wipe(Reflect.get(value, key), seen);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function slotKey(scope: OnlineTransferCredentialScope, devicePeer: string): string {
  return `${SLOT_PREFIX}/${scope.genesisDigest}/${devicePeer}/${scope.seat}/${scope.attemptId}`;
}

function snapshotScope(input: OnlineTransferCredentialScope): OnlineTransferCredentialScope {
  const bytes = canonicalEncode(input);
  if (bytes.length > 8 * 1024) {
    bytes.fill(0);
    throw new RangeError('Transfer authorization scope exceeds the supported size');
  }
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Detach the typed input; validateScope checks the decoded fields before use.
    return canonicalDecode(bytes) as OnlineTransferCredentialScope;
  } finally {
    bytes.fill(0);
  }
}

function validateScope(scope: OnlineTransferCredentialScope, devicePeer: string): void {
  if (scope.devicePeer !== devicePeer)
    throw new TypeError('Transfer device identity does not match scope');
  if (!/^[A-Za-z0-9_-]{43}$/.test(scope.genesisDigest))
    throw new TypeError('Transfer genesis digest must be a canonical 32-byte value');
  if (fromBase64Url(scope.genesisDigest).length !== 32)
    throw new TypeError('Transfer genesis digest must be a canonical 32-byte value');
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(scope.attemptId) ||
    toBase64Url(fromBase64Url(scope.attemptId)) !== scope.attemptId
  )
    throw new TypeError('Transfer attempt ID must be a canonical 32-byte token');
  if (scope.replacements.length < 1 || scope.replacements.length > 6)
    throw new TypeError('Transfer must replace one to six seats');
  const seen = new Set<number>();
  let previousBotSeat = -1;
  for (const [index, replacement] of scope.replacements.entries()) {
    if (!VALID_SEATS.includes(replacement.seat) || seen.has(replacement.seat))
      throw new TypeError('Transfer replacements must be unique');
    if (index === 0 && replacement.seat !== scope.seat)
      throw new TypeError('The first replacement must be the destination human seat');
    if (index > 0 && replacement.seat <= previousBotSeat)
      throw new TypeError('Hosted bot replacements must be ordered by seat');
    if (index > 0) previousBotSeat = replacement.seat;
    seen.add(replacement.seat);
    parsePeerId(replacement.oldPublicKey);
    if (!VALID_SEATS.includes(replacement.newHostSeat))
      throw new TypeError('Invalid replacement host seat');
  }
  if (!VALID_SEATS.includes(scope.seat)) throw new TypeError('Invalid transfer seat');
  const firstReplacement = scope.replacements[0];
  if (!firstReplacement) throw new TypeError('Transfer primary replacement is missing');
  v.parse(transferAuthorizationStatementSchema, {
    protocol: 'seat-transfer-v1',
    genesisDigest: scope.genesisDigest,
    anchor: scope.anchor,
    validUntilSeq: scope.validUntilSeq,
    mode: scope.mode,
    seat: scope.seat,
    currentController: scope.currentController,
    recovery: scope.recovery,
    nextEpoch: scope.nextEpoch,
    destination: {
      devicePeer,
      gamePeer: firstReplacement.oldPublicKey,
      transferEncryptionKey: encodePoint(G),
    },
    replacements: scope.replacements.map((replacement) => ({
      ...replacement,
      newPublicKey: replacement.oldPublicKey,
    })),
  });
}

function parseStored(bytes: Uint8Array): StoredRecord {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_RECORD_BYTES)
    throw new TypeError('Stored transfer credentials are oversized');
  let decoded: unknown;
  try {
    decoded = canonicalDecode(bytes);
    const parsed = v.safeParse(storedRecordSchema, decoded);
    if (!parsed.success) throw new TypeError('Stored transfer credentials are malformed');
    const canonical = canonicalEncode(parsed.output);
    const matches = sameBytes(canonical, bytes);
    canonical.fill(0);
    if (!matches) throw new TypeError('Stored transfer credentials are malformed');
    return parsed.output;
  } catch {
    wipe(decoded);
    throw new TypeError('Stored transfer credentials are malformed');
  }
}

function statementMatchesScope(
  statement: SeatTransferAuthorizationStatement,
  scope: OnlineTransferCredentialScope,
): boolean {
  return (
    statement.protocol === 'seat-transfer-v1' &&
    statement.genesisDigest === scope.genesisDigest &&
    statement.anchor.seq === scope.anchor.seq &&
    statement.anchor.hash === scope.anchor.hash &&
    statement.validUntilSeq === scope.validUntilSeq &&
    statement.mode === scope.mode &&
    statement.seat === scope.seat &&
    canonicalEncode(statement.currentController).toString() ===
      canonicalEncode(scope.currentController).toString() &&
    canonicalEncode(statement.recovery).toString() === canonicalEncode(scope.recovery).toString() &&
    statement.nextEpoch === scope.nextEpoch &&
    statement.destination.devicePeer === scope.devicePeer &&
    statement.replacements.length === scope.replacements.length &&
    statement.replacements.every((item, index) => {
      const expected = scope.replacements[index];
      return (
        expected !== undefined &&
        item.seat === expected.seat &&
        item.oldPublicKey === expected.oldPublicKey &&
        item.newHostSeat === expected.newHostSeat
      );
    })
  );
}

function disposeOwned(
  authorization: OwnedOnlineTransferCredentials['authorization'],
  keys: OwnedOnlineTransferKey[],
  encryptionSecret: Uint8Array,
): OwnedOnlineTransferCredentials {
  let disposed = false;
  return {
    authorization,
    keys,
    encryptionSecret,
    dispose() {
      if (disposed) return;
      disposed = true;
      encryptionSecret.fill(0);
      for (const key of keys) key.signingKey.fill(0);
    },
  };
}

function restoreRecord(
  bytes: Uint8Array,
  scope: OnlineTransferCredentialScope,
  attemptId: string,
  deviceSecret: Uint8Array,
): OwnedOnlineTransferCredentials {
  let record: StoredRecord | undefined;
  const keys: OwnedOnlineTransferKey[] = [];
  try {
    record = parseStored(bytes);
    if (record.attemptId !== attemptId || !statementMatchesScope(record.statement, scope))
      throw new TypeError(
        'Transfer credential slot is already bound to another authorization scope',
      );
    if (record.keys.length !== scope.replacements.length)
      throw new TypeError('Stored transfer key set does not match authorization scope');
    const derived = record.keys.map((stored, index) => {
      const expected = scope.replacements[index];
      if (!expected || stored.seat !== expected.seat)
        throw new TypeError('Stored transfer key order is invalid');
      const identity = identityFromSecret(stored.signingKey);
      keys.push({ seat: stored.seat, peerId: identity.peerId, signingKey: identity.secretKey });
      return identity.peerId;
    });
    const gamePeer = derived[0];
    const gameKey = keys[0];
    if (!gamePeer || !gameKey) throw new TypeError('Stored destination game key is missing');
    const encryptionScalar = scalarFromBytes(record.encryptionSecret, { nonzero: true });
    const encryptionPoint = encodePoint(scalePoint(G, encryptionScalar));
    const expectedStatement: SeatTransferAuthorizationStatement = {
      ...record.statement,
      destination: {
        devicePeer: scope.devicePeer,
        gamePeer,
        transferEncryptionKey: encryptionPoint,
      },
      replacements: scope.replacements.map((item, index) => {
        const newPublicKey = derived[index];
        if (!newPublicKey) throw new TypeError('Stored replacement key is missing');
        return { ...item, newPublicKey };
      }),
    };
    const parsedStatement = v.parse(transferAuthorizationStatementSchema, expectedStatement);
    if (!sameBytes(canonicalEncode(parsedStatement), canonicalEncode(record.statement)))
      throw new TypeError('Stored transfer public keys do not match its private keys');
    const authorization = {
      kind: 'transfer-authorize' as const,
      statement: parsedStatement,
      destinationDeviceSig: signObject(TRANSFER_DEVICE_DOMAIN, parsedStatement, deviceSecret),
      destinationGameSig: signObject(TRANSFER_GAME_KEY_DOMAIN, parsedStatement, gameKey.signingKey),
      replacementKeySigs: keys.slice(1).map(({ seat, signingKey }) => ({
        seat,
        sig: signObject(TRANSFER_BOT_KEY_DOMAIN, parsedStatement, signingKey),
      })),
    };
    return disposeOwned(authorization, keys, new Uint8Array(record.encryptionSecret));
  } catch (error) {
    for (const key of keys) key.signingKey.fill(0);
    throw error;
  } finally {
    bytes.fill(0);
    if (record) wipe(record);
  }
}

/** Reserve immutable transfer keys before returning any public key or possession signature. */
export async function prepareOnlineTransferCredentials(input: {
  readonly store: OnlineCredentialStore;
  readonly identity: DisposableOnlineIdentity;
  readonly scope: OnlineTransferCredentialScope;
  readonly randomBytes?: RandomBytes;
}): Promise<OwnedOnlineTransferCredentials> {
  const scope = snapshotScope(input.scope);
  const identitySeed = new Uint8Array(input.identity.secretKey);
  let identity: ReturnType<typeof identityFromSecret>;
  try {
    identity = identityFromSecret(identitySeed);
  } finally {
    identitySeed.fill(0);
  }
  try {
    validateScope(scope, input.identity.peerId);
    if (identity.peerId !== input.identity.peerId)
      throw new TypeError('Device identity key does not match its PeerId');
    const attemptBytes = scope.attemptId;
    const expectedDeviceSecret = identity.secretKey;
    const id = slotKey(scope, identity.peerId);
    const random = input.randomBytes ?? browserRandomBytes;
    return await input.store.withCeremonyLock(id, async () => {
      const prior = await input.store.load(id);
      if (prior !== null) {
        try {
          return restoreRecord(prior, scope, attemptBytes, expectedDeviceSecret);
        } finally {
          prior.fill(0);
        }
      }

      const keys: StoredKey[] = [];
      let encryptionSecret: Uint8Array | undefined;
      let recordBytes: Uint8Array | undefined;
      try {
        for (const replacement of scope.replacements) {
          const entropy = randomSeed(random);
          try {
            const signing = identityFromSecret(entropy);
            keys.push({ seat: replacement.seat, signingKey: signing.secretKey });
            signing.publicKey.fill(0);
          } finally {
            entropy.fill(0);
          }
        }
        const encryptionEntropy = randomSeed(random);
        try {
          const scalar = deriveScalar(encryptionEntropy, DERIVATION_LABELS.encryptionKey, {
            domain: 'cp2p/v1/online-transfer-encryption-key',
            genesisDigest: scope.genesisDigest,
            devicePeer: identity.peerId,
            seat: scope.seat,
            attemptId: attemptBytes,
          });
          encryptionSecret = scalarToBytes(scalar);
        } finally {
          encryptionEntropy.fill(0);
        }
        const publicKeys = keys.map(({ signingKey }) => {
          const generated = identityFromSecret(signingKey);
          generated.secretKey.fill(0);
          const peerId = generated.peerId;
          generated.publicKey.fill(0);
          return peerId;
        });
        const reservedKeys = new Set(scope.replacements.map(({ oldPublicKey }) => oldPublicKey));
        reservedKeys.add(identity.peerId);
        for (const publicKey of publicKeys) {
          if (reservedKeys.has(publicKey))
            throw new Error('Fresh transfer key collides with a reserved game key');
          reservedKeys.add(publicKey);
        }
        const encryptionScalar = scalarFromBytes(encryptionSecret, { nonzero: true });
        const encryptionPublicKey = encodePoint(scalePoint(G, encryptionScalar));
        if (reservedKeys.has(encryptionPublicKey))
          throw new Error('Transfer encryption key collides with a reserved game key');
        const statement: SeatTransferAuthorizationStatement = v.parse(
          transferAuthorizationStatementSchema,
          {
            protocol: 'seat-transfer-v1',
            genesisDigest: scope.genesisDigest,
            anchor: scope.anchor,
            validUntilSeq: scope.validUntilSeq,
            mode: scope.mode,
            seat: scope.seat,
            currentController: scope.currentController,
            recovery: scope.recovery,
            nextEpoch: scope.nextEpoch,
            destination: {
              devicePeer: identity.peerId,
              gamePeer: publicKeys[0],
              transferEncryptionKey: encryptionPublicKey,
            },
            replacements: scope.replacements.map((replacement, index) => ({
              ...replacement,
              newPublicKey: publicKeys[index],
            })),
          },
        );
        const record: StoredRecord = {
          protocol: RECORD_PROTOCOL,
          attemptId: attemptBytes,
          statement,
          encryptionSecret,
          keys,
        };
        recordBytes = canonicalEncode(record);
        if (recordBytes.length > MAX_RECORD_BYTES)
          throw new RangeError('Transfer credential record exceeds the supported size');
        let saved: boolean;
        try {
          saved = await input.store.putIfAbsent(id, recordBytes);
        } catch (writeError) {
          const winner = await input.store.load(id).catch(() => null);
          if (winner === null) throw writeError;
          try {
            return restoreRecord(winner, scope, attemptBytes, expectedDeviceSecret);
          } finally {
            winner.fill(0);
          }
        }
        if (!saved) {
          const winner = await input.store.load(id);
          if (winner === null) throw new Error('Transfer credential reservation winner is missing');
          try {
            return restoreRecord(winner, scope, attemptBytes, expectedDeviceSecret);
          } finally {
            winner.fill(0);
          }
        }
        return restoreRecord(
          new Uint8Array(recordBytes),
          scope,
          attemptBytes,
          expectedDeviceSecret,
        );
      } finally {
        recordBytes?.fill(0);
        for (const key of keys) key.signingKey.fill(0);
        encryptionSecret?.fill(0);
      }
    });
  } finally {
    identity.secretKey.fill(0);
    identity.publicKey.fill(0);
    wipe(scope);
  }
}

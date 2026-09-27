import { canonicalDecode, canonicalEncode, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import {
  DERIVATION_LABELS,
  deriveScalar,
  identityFromSecret,
  parsePeerId,
  scalarFromBytes,
  scalarToBytes,
} from '@cp2p/crypto';
import type { PeerId } from '@cp2p/protocol';
import type { Seat } from '@cp2p/engine';
import * as v from 'valibot';

const DEVICE_ID = 'online-credentials/device-identity/v1';
const IDENTITY_PROTOCOL = 'cp2p/online-device-identity/v1';
const MATERIAL_PROTOCOL = 'cp2p/online-ceremony-material/v1';
const SEAT_LIMIT = 6;
const VALID_SEATS: Seat[] = [0, 1, 2, 3, 4, 5];

export interface OnlineCredentialStore {
  load(id: string): Promise<Uint8Array | null>;
  putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean>;
  withCeremonyLock<T>(id: string, task: () => Promise<T>): Promise<T>;
}

export type RandomBytes = (length: number) => Uint8Array;

export type OnlineSeatLayout =
  | { readonly seat: Seat; readonly kind: 'human'; readonly devicePeerId: PeerId }
  | { readonly seat: Seat; readonly kind: 'bot'; readonly botHost: PeerId };

export interface DisposableOnlineIdentity {
  readonly peerId: PeerId;
  readonly secretKey: Uint8Array;
  dispose(): void;
}

export interface OwnedSeatMaterial {
  readonly seat: Seat;
  readonly kind: 'human' | 'bot';
  readonly peerId: PeerId;
  readonly signingKey: Uint8Array;
  readonly master: Uint8Array;
}

export interface OwnedCeremonyMaterial {
  readonly ceremonyNonce: string;
  readonly layoutHash: string;
  readonly keys: readonly OwnedSeatMaterial[];
  dispose(): void;
}

interface IdentityRecord {
  readonly protocol: typeof IDENTITY_PROTOCOL;
  readonly peerId: PeerId;
  readonly secretKey: Uint8Array;
}

interface MaterialRecord {
  readonly protocol: typeof MATERIAL_PROTOCOL;
  readonly ceremonyNonce: string;
  readonly devicePeerId: PeerId;
  readonly layoutHash: string;
  readonly layout: readonly OnlineSeatLayout[];
  readonly seats: readonly OwnedSeatMaterial[];
}

const identityRecordSchema = v.strictObject({
  protocol: v.literal(IDENTITY_PROTOCOL),
  peerId: v.string(),
  secretKey: v.custom<Uint8Array>((value) => value instanceof Uint8Array && value.length === 32),
});

const layoutSeatSchema = v.variant('kind', [
  v.strictObject({
    seat: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5)),
    kind: v.literal('human'),
    devicePeerId: v.string(),
  }),
  v.strictObject({
    seat: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5)),
    kind: v.literal('bot'),
    botHost: v.string(),
  }),
]);

const storedSeatSchema = v.strictObject({
  seat: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5)),
  kind: v.picklist(['human', 'bot']),
  peerId: v.string(),
  signingKey: v.custom<Uint8Array>((value) => value instanceof Uint8Array && value.length === 32),
  master: v.custom<Uint8Array>((value) => value instanceof Uint8Array && value.length === 32),
});

const materialRecordSchema = v.strictObject({
  protocol: v.literal(MATERIAL_PROTOCOL),
  ceremonyNonce: v.string(),
  devicePeerId: v.string(),
  layoutHash: v.string(),
  layout: v.pipe(v.array(layoutSeatSchema), v.minLength(2), v.maxLength(SEAT_LIMIT)),
  seats: v.pipe(v.array(storedSeatSchema), v.minLength(1), v.maxLength(SEAT_LIMIT)),
});

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function checkedSeat(value: number): Seat {
  const seat = VALID_SEATS[value];
  if (seat === undefined || seat !== value)
    throw new TypeError('Stored seat is outside the supported range');
  return seat;
}

function randomSeed(randomBytes: RandomBytes): Uint8Array {
  const supplied = randomBytes(32);
  if (!(supplied instanceof Uint8Array))
    throw new TypeError('Credential entropy must return a 32-byte Uint8Array');
  if (supplied.length !== 32) {
    supplied.fill(0);
    throw new TypeError('Credential entropy must return a 32-byte Uint8Array');
  }
  const copy = supplied.slice();
  supplied.fill(0);
  return copy;
}

function wipeStoredBytes(value: unknown, seen = new Set<object>()): void {
  if (value instanceof Uint8Array) {
    value.fill(0);
    return;
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) wipeStoredBytes(Reflect.get(value, key), seen);
}

function browserRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function parseRecord<T>(bytes: Uint8Array, schema: v.GenericSchema<unknown, T>): T {
  let decoded: unknown;
  try {
    decoded = canonicalDecode(bytes);
    const parsed = v.safeParse(schema, decoded);
    if (!parsed.success || !sameBytes(canonicalEncode(parsed.output), bytes))
      throw new TypeError('Stored online credentials are malformed');
    return parsed.output;
  } catch {
    wipeStoredBytes(decoded);
    throw new TypeError('Stored online credentials are malformed');
  }
}

function disposeIdentity(peerId: PeerId, secretKey: Uint8Array): DisposableOnlineIdentity {
  let disposed = false;
  return {
    peerId,
    secretKey,
    dispose() {
      if (disposed) return;
      disposed = true;
      secretKey.fill(0);
    },
  };
}

function identityFromRecord(bytes: Uint8Array): DisposableOnlineIdentity {
  let record: IdentityRecord | null = null;
  try {
    record = parseRecord(bytes, identityRecordSchema);
    const derived = identityFromSecret(record.secretKey);
    try {
      if (derived.peerId !== record.peerId)
        throw new TypeError('Stored device identity does not match its key');
      return disposeIdentity(derived.peerId, derived.secretKey);
    } finally {
      record.secretKey.fill(0);
      derived.publicKey.fill(0);
    }
  } finally {
    bytes.fill(0);
  }
}

/** Load or durably pin one device identity before returning its private key. */
export async function loadOrCreateOnlineIdentity(
  store: OnlineCredentialStore,
  randomBytes: RandomBytes = browserRandomBytes,
): Promise<DisposableOnlineIdentity> {
  return store.withCeremonyLock(DEVICE_ID, async () => {
    const prior = await store.load(DEVICE_ID);
    if (prior !== null) return identityFromRecord(prior);

    const seed = randomSeed(randomBytes);
    let identity: ReturnType<typeof identityFromSecret>;
    try {
      identity = identityFromSecret(seed);
    } finally {
      seed.fill(0);
    }
    const encoded = canonicalEncode({
      protocol: IDENTITY_PROTOCOL,
      peerId: identity.peerId,
      secretKey: identity.secretKey,
    });
    try {
      let saved: boolean;
      try {
        saved = await store.putIfAbsent(DEVICE_ID, encoded);
      } catch (writeError) {
        const winner = await store.load(DEVICE_ID).catch(() => null);
        if (winner === null) throw writeError;
        identity.secretKey.fill(0);
        return identityFromRecord(winner);
      }
      if (saved) return disposeIdentity(identity.peerId, identity.secretKey);
      identity.secretKey.fill(0);
      const winner = await store.load(DEVICE_ID);
      if (winner === null) throw new Error('Device identity reservation winner is missing');
      return identityFromRecord(winner);
    } catch (error) {
      identity.secretKey.fill(0);
      throw error;
    } finally {
      identity.publicKey.fill(0);
      encoded.fill(0);
    }
  });
}

function checkedLayout(
  layout: readonly OnlineSeatLayout[],
  devicePeerId: PeerId,
): OnlineSeatLayout[] {
  if (!Array.isArray(layout) || layout.length < 2 || layout.length > SEAT_LIMIT)
    throw new TypeError('Ceremony layout must contain two through six seats');
  const copied: OnlineSeatLayout[] = [];
  for (const [index, raw] of layout.entries()) {
    if (typeof raw !== 'object' || raw === null) throw new TypeError('Ceremony seat is malformed');
    const seat = VALID_SEATS[index];
    if (seat === undefined || raw.seat !== seat)
      throw new TypeError('Ceremony seats must be unique and contiguous from zero');
    if (raw.kind === 'human') copied.push({ seat, kind: 'human', devicePeerId: raw.devicePeerId });
    else if (raw.kind === 'bot') copied.push({ seat, kind: 'bot', botHost: raw.botHost });
    else throw new TypeError('Ceremony seat kind is invalid');
  }
  const humans = copied.filter((seat) => seat.kind === 'human');
  if (!humans.some((seat) => seat.devicePeerId === devicePeerId))
    throw new TypeError('This device does not own a human seat in the ceremony');
  for (const seat of copied) {
    parsePeerId(seat.kind === 'human' ? seat.devicePeerId : seat.botHost);
    if (seat.kind === 'bot' && !humans.some((human) => human.devicePeerId === seat.botHost))
      throw new TypeError('Bot host must own a human seat in the ceremony');
  }
  return copied;
}

function layoutDigest(
  nonce: string,
  devicePeerId: PeerId,
  layout: readonly OnlineSeatLayout[],
): string {
  return toHex(
    hashValue({
      domain: 'cp2p/v1/online-ceremony-layout',
      ceremonyNonce: nonce,
      devicePeerId,
      layout,
    }),
  );
}

function materialKey(nonce: string, devicePeerId: PeerId): string {
  return `online-credentials/ceremony/${nonce}/${devicePeerId}`;
}

function disposeRecord(record: MaterialRecord): void {
  wipeSeatMaterial(record.seats);
}

function wipeSeatMaterial(seats: readonly OwnedSeatMaterial[]): void {
  for (const seat of seats) {
    seat.signingKey.fill(0);
    seat.master.fill(0);
  }
}

function materialFromRecord(
  bytes: Uint8Array,
  expected: {
    nonce: string;
    devicePeerId: PeerId;
    layoutHash: string;
    layout: readonly OnlineSeatLayout[];
  },
): OwnedCeremonyMaterial {
  let recordForWipe: MaterialRecord | null = null;
  try {
    const decoded = parseRecord(bytes, materialRecordSchema);
    const record: MaterialRecord = {
      ...decoded,
      layout: decoded.layout.map((seat) => ({ ...seat, seat: checkedSeat(seat.seat) })),
      seats: decoded.seats.map((seat) => ({ ...seat, seat: checkedSeat(seat.seat) })),
    };
    recordForWipe = record;
    if (
      record.ceremonyNonce !== expected.nonce ||
      record.devicePeerId !== expected.devicePeerId ||
      record.layoutHash !== expected.layoutHash ||
      !sameBytes(canonicalEncode(record.layout), canonicalEncode(expected.layout))
    )
      throw new TypeError('Ceremony credentials are already bound to another layout');

    const expectedSeats = expected.layout.filter(
      (seat) =>
        (seat.kind === 'human' && seat.devicePeerId === expected.devicePeerId) ||
        (seat.kind === 'bot' && seat.botHost === expected.devicePeerId),
    );
    if (
      record.seats.length !== expectedSeats.length ||
      record.seats.some(
        (stored, index) =>
          stored.seat !== expectedSeats[index]?.seat || stored.kind !== expectedSeats[index]?.kind,
      )
    )
      throw new TypeError('Stored credentials do not match the device-owned seats');

    const keys: OwnedSeatMaterial[] = [];
    try {
      for (const stored of record.seats) {
        const identity = identityFromSecret(stored.signingKey);
        try {
          if (identity.peerId !== stored.peerId)
            throw new TypeError('Stored game signing key is corrupt');
          scalarFromBytes(stored.master, { nonzero: true });
          keys.push({
            seat: stored.seat,
            kind: stored.kind,
            peerId: identity.peerId,
            signingKey: identity.secretKey,
            master: stored.master.slice(),
          });
        } catch (error) {
          identity.secretKey.fill(0);
          throw error;
        } finally {
          identity.publicKey.fill(0);
        }
      }
    } catch (error) {
      wipeSeatMaterial(keys);
      throw error;
    }
    return {
      ceremonyNonce: record.ceremonyNonce,
      layoutHash: record.layoutHash,
      keys,
      dispose: () => wipeSeatMaterial(keys),
    };
  } finally {
    if (recordForWipe) disposeRecord(recordForWipe);
    bytes.fill(0);
  }
}

/** Persist one immutable set of game signing keys and independent master scalars. */
export async function prepareCeremonyMaterial(input: {
  readonly store: OnlineCredentialStore;
  readonly identity: DisposableOnlineIdentity;
  readonly ceremonyNonce: Uint8Array;
  readonly layout: readonly OnlineSeatLayout[];
  readonly randomBytes?: RandomBytes;
}): Promise<OwnedCeremonyMaterial> {
  const nonceBytes = input.ceremonyNonce.slice();
  if (nonceBytes.length !== 32) {
    nonceBytes.fill(0);
    throw new TypeError('Ceremony nonce must be exactly 32 bytes');
  }
  const nonce = toBase64Url(nonceBytes);
  nonceBytes.fill(0);

  const identitySeed = input.identity.secretKey.slice();
  let identity: ReturnType<typeof identityFromSecret>;
  try {
    identity = identityFromSecret(identitySeed);
  } finally {
    identitySeed.fill(0);
  }
  try {
    if (identity.peerId !== input.identity.peerId)
      throw new TypeError('Device identity key does not match its PeerId');
    const layout = checkedLayout(input.layout, identity.peerId);
    const layoutHash = layoutDigest(nonce, identity.peerId, layout);
    const expected = { nonce, devicePeerId: identity.peerId, layoutHash, layout };
    const id = materialKey(nonce, identity.peerId);
    const random = input.randomBytes ?? browserRandomBytes;

    return await input.store.withCeremonyLock(id, async () => {
      const prior = await input.store.load(id);
      if (prior !== null) return materialFromRecord(prior, expected);

      const ownedSeats = layout.filter(
        (seat) =>
          (seat.kind === 'human' && seat.devicePeerId === identity.peerId) ||
          (seat.kind === 'bot' && seat.botHost === identity.peerId),
      );
      const storedSeats: OwnedSeatMaterial[] = [];
      try {
        for (const seat of ownedSeats) {
          const signingEntropy = randomSeed(random);
          try {
            const masterEntropy = randomSeed(random);
            try {
              const signing = identityFromSecret(signingEntropy);
              let retained = false;
              try {
                const masterScalar = deriveScalar(
                  masterEntropy,
                  DERIVATION_LABELS.escrowCoefficient,
                  {
                    domain: 'cp2p/v1/online-seat-master',
                    ceremonyNonce: nonce,
                    devicePeerId: identity.peerId,
                    seat: seat.seat,
                  },
                );
                storedSeats.push({
                  seat: seat.seat,
                  kind: seat.kind,
                  peerId: signing.peerId,
                  signingKey: signing.secretKey,
                  master: scalarToBytes(masterScalar),
                });
                retained = true;
              } finally {
                signing.publicKey.fill(0);
                if (!retained) signing.secretKey.fill(0);
              }
            } finally {
              masterEntropy.fill(0);
            }
          } finally {
            signingEntropy.fill(0);
          }
        }

        const record: MaterialRecord = {
          protocol: MATERIAL_PROTOCOL,
          ceremonyNonce: nonce,
          devicePeerId: identity.peerId,
          layoutHash,
          layout,
          seats: storedSeats,
        };
        const bytes = canonicalEncode(record);
        try {
          let saved: boolean;
          try {
            saved = await input.store.putIfAbsent(id, bytes);
          } catch (writeError) {
            const winner = await input.store.load(id).catch(() => null);
            if (winner === null) throw writeError;
            return materialFromRecord(winner, expected);
          }
          if (saved) return materialFromRecord(bytes.slice(), expected);
          const winner = await input.store.load(id);
          if (winner === null) throw new Error('Ceremony material reservation winner is missing');
          return materialFromRecord(winner, expected);
        } finally {
          bytes.fill(0);
        }
      } finally {
        for (const stored of storedSeats) {
          stored.signingKey.fill(0);
          stored.master.fill(0);
        }
      }
    });
  } finally {
    identity.secretKey.fill(0);
    identity.publicKey.fill(0);
  }
}

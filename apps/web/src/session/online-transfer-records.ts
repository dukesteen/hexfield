import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { parsePeerId } from '@cp2p/crypto';
import { transferChangeSchema } from '@cp2p/protocol';
import type { EscrowCeremonyStore, SeatTransferAuthorization } from '@cp2p/protocol';
import type { Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { decodeTransferInvite, encodeTransferInvite } from './online-transfer-link.js';
import type { OnlineTransferInvite } from './online-transfer-link.js';

type TransferRecordStorage = Pick<
  EscrowCeremonyStore,
  'load' | 'putIfAbsent' | 'compareAndSwap' | 'withCeremonyLock'
>;

const MAX_BYTES = 65_536;
const token = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
const ref = v.strictObject({
  seq: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  hash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
});
const recordSchema = v.strictObject({
  protocol: v.literal('online-transfer-exchange-v1'),
  role: v.picklist(['source', 'destination']),
  attemptId: token,
  gameId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/)),
  genesisDigest: token,
  sourceDevice: token,
  destinationDevice: token,
  seat: v.picklist([0, 1, 2, 3, 4, 5] as const),
  offer: v.nullable(v.unknown()),
  approved: v.nullable(v.unknown()),
  authorization: v.nullable(ref),
  cancelRequested: v.boolean(),
});
const envelopeSchema = v.strictObject({
  protocol: v.literal('online-transfer-ui-v1'),
  invite: v.pipe(v.string(), v.maxLength(2731)),
  role: v.picklist(['source', 'destination']),
  self: token,
  record: v.nullable(recordSchema),
  finished: v.boolean(),
});

/** Public decisions only. Private imports and voting permission remain worker-owned. */
export interface OnlineTransferExchangeRecord {
  readonly protocol: 'online-transfer-exchange-v1';
  readonly role: 'source' | 'destination';
  readonly attemptId: string;
  readonly gameId: string;
  readonly genesisDigest: string;
  readonly sourceDevice: string;
  readonly destinationDevice: string;
  readonly seat: Seat;
  readonly offer: SeatTransferAuthorization | null;
  readonly approved: SeatTransferAuthorization | null;
  readonly authorization: { readonly seq: number; readonly hash: string } | null;
  readonly cancelRequested: boolean;
}

function same(left: unknown, right: unknown): boolean {
  const a = canonicalEncode(left);
  const b = canonicalEncode(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function authorization(value: unknown): SeatTransferAuthorization | null {
  if (value === null) return null;
  const parsed = v.parse(transferChangeSchema, value);
  if (parsed.kind !== 'transfer-authorize') throw new TypeError('Expected transfer authorization');
  return parsed;
}

function checkedRecord(raw: unknown): OnlineTransferExchangeRecord {
  const value = v.parse(recordSchema, raw);
  const offer = authorization(value.offer);
  const approved = authorization(value.approved);
  parsePeerId(value.sourceDevice);
  parsePeerId(value.destinationDevice);
  if (value.sourceDevice === value.destinationDevice)
    throw new TypeError('Transfer devices must differ');
  for (const entry of [offer, approved]) {
    if (!entry) continue;
    const statement = entry.statement;
    if (
      statement.genesisDigest !== value.genesisDigest ||
      statement.seat !== value.seat ||
      statement.destination.devicePeer !== value.destinationDevice
    )
      throw new TypeError('Transfer decision differs from its pinned game, seat or device');
  }
  if (approved && (!offer || !same(approved.statement, offer.statement)))
    throw new TypeError('Transfer approval differs from its chosen offer');
  if (value.authorization && !offer)
    throw new TypeError('Certified transfer reference requires the chosen offer');
  if (value.role === 'source' && value.authorization && !approved)
    throw new TypeError('Source transfer reference requires the durable approval');
  return { ...value, offer, approved };
}

/** Durable browser progress is a locator, never evidence of certified activation. */
export class OnlineTransferRecordStore {
  readonly #code: string;
  readonly #key: string;
  readonly #invite: OnlineTransferInvite;

  constructor(
    private readonly store: TransferRecordStorage,
    private readonly self: string,
    invite: OnlineTransferInvite,
    private readonly role: 'source' | 'destination',
  ) {
    parsePeerId(self);
    this.#code = encodeTransferInvite(invite);
    this.#invite = decodeTransferInvite(this.#code);
    if ((role === 'source') !== (self === invite.body.sourceDevice))
      throw new TypeError('Transfer record role differs from the invitation');
    this.#key = `online-transfer-ui/${self}/${invite.body.attemptId}`;
  }

  async load(): Promise<{ record: OnlineTransferExchangeRecord | null; finished: boolean }> {
    const bytes = await this.store.load(this.#key);
    if (!bytes) return { record: null, finished: false };
    return this.#read(bytes);
  }

  async save(record: OnlineTransferExchangeRecord): Promise<void> {
    const next = checkedRecord(record);
    this.#checkScope(next);
    await this.#update((prior) => {
      if (prior.finished) throw new Error('Transfer browser attempt is finished');
      const previous = prior.record;
      if (previous) {
        if (previous.cancelRequested && !next.cancelRequested)
          throw new Error('Transfer cancellation intent cannot be cleared');
        const pins = [
          'protocol',
          'role',
          'attemptId',
          'gameId',
          'genesisDigest',
          'sourceDevice',
          'destinationDevice',
          'seat',
        ] as const;
        if (pins.some((key) => previous[key] !== next[key]))
          throw new Error('Transfer browser attempt cannot change its pinned destination');
        for (const key of ['offer', 'approved', 'authorization'] as const)
          if (previous[key] !== null && !same(previous[key], next[key]))
            throw new Error('Transfer browser decision cannot be replaced');
      }
      return { record: next, finished: false };
    });
  }

  /** Only called after the exchange reports a certified outcome or cancels before approval. */
  finish(): Promise<void> {
    return this.#update((prior) => ({ ...prior, finished: true }));
  }

  async #update(
    update: (prior: { record: OnlineTransferExchangeRecord | null; finished: boolean }) => {
      record: OnlineTransferExchangeRecord | null;
      finished: boolean;
    },
  ): Promise<void> {
    await this.store.withCeremonyLock(this.#key, async () => {
      const before = await this.store.load(this.#key);
      const prior = before ? this.#read(before) : { record: null, finished: false };
      const next = update(prior);
      const bytes = canonicalEncode({
        protocol: 'online-transfer-ui-v1',
        invite: this.#code,
        self: this.self,
        role: this.role,
        ...next,
      });
      if (bytes.length > MAX_BYTES) throw new RangeError('Transfer browser record is oversized');
      const stored = before
        ? await this.store.compareAndSwap(this.#key, before, bytes)
        : await this.store.putIfAbsent(this.#key, bytes);
      if (!stored) throw new Error('Transfer browser record changed in another tab');
    });
  }

  #checkScope(record: OnlineTransferExchangeRecord): void {
    const body = this.#invite.body;
    if (
      record.role !== this.role ||
      record.attemptId !== body.attemptId ||
      record.gameId !== body.gameId ||
      record.seat !== body.seat ||
      record.genesisDigest !== body.genesisDigest ||
      record.sourceDevice !== body.sourceDevice ||
      (this.role === 'destination' && record.destinationDevice !== this.self)
    )
      throw new TypeError('Transfer browser record belongs to another invitation');
  }

  #read(bytes: Uint8Array): { record: OnlineTransferExchangeRecord | null; finished: boolean } {
    if (bytes.length > MAX_BYTES) throw new RangeError('Transfer browser record is oversized');
    const value = v.parse(envelopeSchema, canonicalDecode(bytes));
    if (value.invite !== this.#code || value.self !== this.self || value.role !== this.role)
      throw new TypeError('Stored transfer belongs to another invitation');
    const record = value.record ? checkedRecord(value.record) : null;
    if (record) this.#checkScope(record);
    return { record, finished: value.finished };
  }
}

/** One recoverable source invitation per game, with explicit replacement after completion. */
export async function saveCurrentTransferInvite(
  store: TransferRecordStorage,
  self: string,
  invite: OnlineTransferInvite,
): Promise<void> {
  const records = new OnlineTransferRecordStore(store, self, invite, 'source');
  const key = `online-transfer-current/${self}/${invite.body.gameId}`;
  const encoded = canonicalEncode(encodeTransferInvite(invite));
  await store.withCeremonyLock(key, async () => {
    const prior = await store.load(key);
    if (prior) {
      if (prior.length > 4096) throw new RangeError('Stored transfer invitation is oversized');
      if (same(canonicalDecode(prior), encodeTransferInvite(invite))) return;
      const previous = await loadCurrentTransferInvite(store, self, invite.body.gameId);
      if (!previous) throw new Error('Current transfer invitation disappeared');
      const progress = await new OnlineTransferRecordStore(store, self, previous, 'source').load();
      if (!progress.finished) throw new Error('A transfer is already in progress');
    }
    if ((await records.load()).finished) throw new Error('Transfer invitation is already finished');
    const stored = prior
      ? await store.compareAndSwap(key, prior, encoded)
      : await store.putIfAbsent(key, encoded);
    if (!stored) throw new Error('Current transfer changed in another tab');
  });
}

export async function loadCurrentTransferInvite(
  store: TransferRecordStorage,
  self: string,
  gameId: string,
): Promise<OnlineTransferInvite | null> {
  parsePeerId(self);
  if (!/^[A-Za-z0-9_-]{22}$/.test(gameId)) throw new TypeError('Invalid transfer game');
  const bytes = await store.load(`online-transfer-current/${self}/${gameId}`);
  if (!bytes) return null;
  if (bytes.length > 4096) throw new RangeError('Stored transfer invitation is oversized');
  const code = canonicalDecode(bytes);
  if (typeof code !== 'string') throw new TypeError('Stored transfer invitation is malformed');
  const invite = decodeTransferInvite(code);
  if (invite.body.gameId !== gameId || invite.body.sourceDevice !== self)
    throw new TypeError('Stored transfer invitation belongs to another game or device');
  return invite;
}

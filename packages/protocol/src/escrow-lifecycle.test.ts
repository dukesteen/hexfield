import { canonicalDecode, canonicalEncode, fromBase64Url } from '@cp2p/codec';
import {
  decodePoint,
  encodePoint,
  encodeScalar,
  G,
  identityFromSecret,
  proveDleq,
  scalePoint,
  signObject,
} from '@cp2p/crypto';
import type { Result, Seat } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import * as v from 'valibot';
import { deckCeremonyId } from './deck-genesis.js';
import { createEscrowShareEnvelopes, escrowShareEnvelopeHash } from './escrow-distribution.js';
import type { EscrowShareEnvelope } from './escrow-distribution.js';
import type { EscrowShareDispute } from './escrow-dispute.js';
import {
  MemoryEscrowLifecycleStore,
  prepareEscrowDistribution,
  prepareEscrowManifestApproval,
  reserveEscrowGenesisConsent,
  checkEscrowCeremonyActive,
  retireEscrowCeremony,
  verifyEscrowManifestApprovals,
  verifyAndRetireEscrowShareDispute,
} from './escrow-lifecycle.js';
import type { EscrowLifecycleStore, EscrowManifestApproval } from './escrow-lifecycle.js';
import type { GenesisBody, GenesisSeat } from './types.js';
import { protocolFixture } from './testing/fixtures.js';

const identities = Array.from({ length: 6 }, (_, index) =>
  identityFromSecret(new Uint8Array(32).fill(index + 11)),
);
const encryptionSecrets = [201n, 202n, 203n, 204n, 205n, 206n] as const;
const masterSecrets = [71n, 72n, 73n, 74n, 75n, 76n] as const;
const seatOrder: Seat[] = [0, 1, 2, 3, 4, 5];
const masterSecretValues: readonly bigint[] = masterSecrets;
const encryptionSecretValues: readonly bigint[] = encryptionSecrets;

function masterSecretAt(seat: Seat): bigint {
  const value = masterSecretValues[seat];
  if (value === undefined) throw new RangeError('Invalid seat');
  return value;
}

function encryptionSecretAt(seat: Seat): bigint {
  const value = encryptionSecretValues[seat];
  if (value === undefined) throw new RangeError('Invalid seat');
  return value;
}

function manifest(nonceByte = 30): GenesisBody {
  const fixture = protocolFixture();
  const seats: GenesisSeat[] = identities.slice(0, 4).map((identity, index) => ({
    seat: seatOrder[index] ?? 0,
    kind: 'human',
    publicKey: identity.peerId,
    encryptionKey: encodePoint(scalePoint(G, encryptionSecrets[index] ?? 201n)),
    name: `Human ${index}`,
    colour: `#${(index + 1).toString(16).repeat(6)}`,
  }));
  return {
    ...fixture.body,
    config: { ...fixture.body.config, seats: [0, 1, 2, 3] },
    seats,
    ceremonyNonce: encodeScalar(BigInt(nonceByte)),
    security: 'verified',
    commitments: {
      masters: seats.map(({ seat }) => ({
        seat,
        masterPub: encodePoint(scalePoint(G, masterSecretAt(seat))),
      })),
    },
  };
}

function fourHumanTwoBotManifest(): GenesisBody {
  const fixture = protocolFixture();
  const seats: GenesisSeat[] = identities.map((identity, index) => {
    const common = {
      seat: seatOrder[index] ?? 0,
      publicKey: identity.peerId,
      encryptionKey: encodePoint(scalePoint(G, encryptionSecretAt(seatOrder[index] ?? 0))),
      name: `Seat ${index}`,
      colour: `#${(index + 1).toString(16).repeat(6)}`,
    };
    return index < 4
      ? { ...common, kind: 'human' }
      : { ...common, kind: 'bot', botHost: identities[0]?.peerId ?? '' };
  });
  return {
    ...fixture.body,
    config: { ...fixture.body.config, seats: [0, 1, 2, 3, 4, 5] },
    seats,
    security: 'verified',
    commitments: {
      masters: seats.map(({ seat }) => ({
        seat,
        masterPub: encodePoint(scalePoint(G, masterSecretAt(seat))),
      })),
    },
  };
}

function get<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

async function approve(
  genesis: GenesisBody,
  store: EscrowLifecycleStore,
): Promise<EscrowManifestApproval[]> {
  return Promise.all(
    genesis.seats
      .filter((entry) => entry.kind === 'human')
      .map(async ({ seat }) => {
        const identity = identities[seat];
        if (!identity) throw new Error(`Missing identity ${seat}`);
        return get(
          await prepareEscrowManifestApproval(genesis, genesis, seat, identity.secretKey, store),
        );
      }),
  );
}

const dealerMaster = fromBase64Url(encodeScalar(masterSecrets[0]));

test('an irreversible signed-genesis intent prevents local retirement and further distribution', async () => {
  const frozen = manifest();
  const store = new MemoryEscrowLifecycleStore();
  const digest = encodeScalar(918n);
  expect((await reserveEscrowGenesisConsent(frozen, digest, store)).ok).toBe(true);
  expect((await reserveEscrowGenesisConsent(frozen, digest, store)).ok).toBe(true);
  const changed = await reserveEscrowGenesisConsent(frozen, encodeScalar(919n), store);
  expect(changed.ok ? '' : changed.error.code).toBe('escrow-ceremony-consent-conflict');
  const retired = await retireEscrowCeremony(frozen, store);
  expect(retired.ok ? '' : retired.error.code).toBe('escrow-ceremony-consenting');
  const active = await checkEscrowCeremonyActive(frozen, store);
  expect(active.ok ? '' : active.error.code).toBe('escrow-ceremony-consenting');
});

class FailingReservationStore extends MemoryEscrowLifecycleStore {
  override async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (id === 'escrow-lifecycle/device-index-v1') throw new Error('disk unavailable');
    return super.putIfAbsent(id, bytes);
  }
}

class AbortRaceStore extends MemoryEscrowLifecycleStore {
  readonly reservationWriteWaiting: Promise<void>;
  readonly #releaseReservationWrite: Promise<void>;
  #signalWaiting!: () => void;
  #release!: () => void;

  constructor() {
    super();
    this.reservationWriteWaiting = new Promise((resolve) => {
      this.#signalWaiting = resolve;
    });
    this.#releaseReservationWrite = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  resumeReservationWrite(): void {
    this.#release();
  }

  override async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (
      id === 'escrow-lifecycle/device-index-v1' &&
      JSON.stringify(canonicalDecode(bytes)).includes('"status":"active"')
    ) {
      this.#signalWaiting();
      await this.#releaseReservationWrite;
    }
    return super.putIfAbsent(id, bytes);
  }
}

class RawLifecycleStore implements EscrowLifecycleStore {
  readonly records = new Map<string, Uint8Array>();
  compareAndSwapCalls = 0;
  failCompareAndSwap = false;

  async load(id: string): Promise<Uint8Array | null> {
    return this.records.get(id)?.slice() ?? null;
  }

  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (this.records.has(id)) return false;
    this.records.set(id, bytes.slice());
    return true;
  }

  async compareAndSwap(
    id: string,
    expected: Uint8Array,
    replacement: Uint8Array,
  ): Promise<boolean> {
    this.compareAndSwapCalls += 1;
    if (this.failCompareAndSwap) throw new Error('durable registry unavailable');
    const current = this.records.get(id);
    if (
      !current ||
      current.length !== expected.length ||
      current.some((byte, i) => byte !== expected[i])
    )
      return false;
    this.records.set(id, replacement.slice());
    return true;
  }
}

function signedComplaintForGoodShare(envelope: EscrowShareEnvelope): EscrowShareDispute {
  const holderSeat = envelope.body.holder.seat;
  const recipientSecret = encryptionSecretAt(holderSeat);
  const identity = identities[holderSeat];
  if (recipientSecret === undefined || !identity) throw new Error('Missing holder secret');
  const context = {
    protocol: 'escrow-share-dispute-v1' as const,
    ceremonyId: envelope.body.ceremonyId,
    dealerSeat: envelope.body.dealer.seat,
    holderSeat,
    envelopeHash: escrowShareEnvelopeHash(envelope),
  };
  const sharedPoint = encodePoint(
    scalePoint(decodePoint(envelope.body.sealed.ephemeral), recipientSecret),
  );
  const statement = {
    base1: encodePoint(G),
    point1: envelope.body.holder.encryptionKey,
    base2: envelope.body.sealed.ephemeral,
    point2: sharedPoint,
  };
  const seed = new Uint8Array(32).fill(99);
  const proof = proveDleq(statement, recipientSecret, seed, context);
  seed.fill(0);
  const body = { ...context, sharedPoint, proof };
  return { body, sig: signObject('escrow-share-dispute', body, identity.secretKey) };
}

async function makeFirstEnvelope(genesis: GenesisBody, store: EscrowLifecycleStore) {
  const approvals = await approve(genesis, store);
  const prepared = await prepareEscrowDistribution({
    genesis,
    localFrozenManifest: genesis,
    approvals,
    dealerSeat: 0,
    master: dealerMaster,
    dealerSigningKey: identities[0]?.secretKey ?? new Uint8Array(),
    store,
  });
  if (!prepared.ok) throw new Error(`${prepared.error.code}: ${prepared.error.message}`);
  const envelope = prepared.value[0];
  if (!envelope) throw new Error('Missing holder envelope');
  return { approvals, envelope };
}

describe('approved, durable escrow distribution lifecycle', () => {
  test('requires every original human approval over the local frozen manifest', async () => {
    const genesis = manifest();
    const store = new MemoryEscrowLifecycleStore();
    const approvals = await approve(genesis, store);
    expect(verifyEscrowManifestApprovals(genesis, approvals).ok).toBe(true);
    expect(
      await prepareEscrowManifestApproval(
        { ...genesis, ceremonyNonce: encodeScalar(999n) },
        genesis,
        0,
        identities[0]?.secretKey ?? new Uint8Array(),
        store,
      ),
    ).toMatchObject({ ok: false, error: { code: 'escrow-manifest-conflict' } });
    const forged = approvals.map((approval, index) =>
      index === 2 ? { ...approval, sig: approvals[0]?.sig ?? '' } : approval,
    );
    expect(verifyEscrowManifestApprovals(genesis, forged).ok).toBe(false);
    const missing = approvals.slice(0, -1);
    const result = await prepareEscrowDistribution({
      genesis,
      localFrozenManifest: genesis,
      approvals: missing,
      dealerSeat: 0,
      master: dealerMaster,
      dealerSigningKey: identities[0]?.secretKey ?? new Uint8Array(),
      store,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'escrow-manifest-approvals' } });
  });

  test('does not deal to attacker approvals after a victim is relabelled as a bot', async () => {
    const localFrozenManifest = fourHumanTwoBotManifest();
    const victim = localFrozenManifest.seats[3];
    if (!victim || victim.kind !== 'human') throw new Error('Missing original victim seat');
    const attackerManifest: GenesisBody = {
      ...localFrozenManifest,
      seats: localFrozenManifest.seats.map((seat) => {
        if (seat.seat === victim.seat) {
          return {
            seat: seat.seat,
            kind: 'bot',
            publicKey: seat.publicKey,
            encryptionKey: encodePoint(scalePoint(G, encryptionSecretAt(seat.seat))),
            name: seat.name,
            colour: seat.colour,
            botHost: identities[0]?.peerId ?? '',
          };
        }
        if (seat.seat >= 4) {
          return {
            seat: seat.seat,
            kind: 'human',
            publicKey: seat.publicKey,
            encryptionKey: encodePoint(scalePoint(G, encryptionSecretAt(seat.seat))),
            name: seat.name,
            colour: seat.colour,
          };
        }
        return seat;
      }),
    };
    const store = new MemoryEscrowLifecycleStore();
    const attackerApprovals = await approve(attackerManifest, store);
    expect(attackerApprovals.map(({ body }) => body.seat)).toEqual([0, 1, 2, 4, 5]);
    expect(verifyEscrowManifestApprovals(attackerManifest, attackerApprovals).ok).toBe(true);
    expect(
      createEscrowShareEnvelopes({
        genesis: attackerManifest,
        dealerSeat: 0,
        expectedMasterPub: encodePoint(scalePoint(G, masterSecrets[0])),
        masterSecret: masterSecrets[0],
        entropy: new Uint8Array(32).fill(122),
        dealerSigningKey: identities[0]?.secretKey ?? new Uint8Array(),
      }).ok,
    ).toBe(true);
    expect(
      await prepareEscrowDistribution({
        genesis: attackerManifest,
        localFrozenManifest,
        approvals: attackerApprovals,
        dealerSeat: 0,
        master: dealerMaster,
        dealerSigningKey: identities[0]?.secretKey ?? new Uint8Array(),
        store,
      }),
    ).toMatchObject({ ok: false, error: { code: 'escrow-manifest-conflict' } });
    expect(
      await verifyAndRetireEscrowShareDispute({
        dispute: null,
        envelope: null,
        genesis: attackerManifest,
        localFrozenManifest,
        store,
      }),
    ).toMatchObject({ ok: false, error: { code: 'escrow-manifest-conflict' } });
    const localApprovals = await approve(localFrozenManifest, store);
    expect(
      (
        await prepareEscrowDistribution({
          genesis: localFrozenManifest,
          localFrozenManifest,
          approvals: localApprovals,
          dealerSeat: 0,
          master: dealerMaster,
          dealerSigningKey: identities[0]?.secretKey ?? new Uint8Array(),
          store,
        })
      ).ok,
    ).toBe(true);
  });

  test('persists before returning and restores byte-identical envelopes on retry', async () => {
    const genesis = manifest();
    const store = new MemoryEscrowLifecycleStore();
    const approvals = await approve(genesis, store);
    const first = get(
      await prepareEscrowDistribution({
        genesis,
        localFrozenManifest: genesis,
        approvals,
        dealerSeat: 0,
        master: dealerMaster,
        dealerSigningKey: identities[0]?.secretKey ?? new Uint8Array(),
        store,
      }),
    );
    expect(first).toHaveLength(3);
    const retry = get(
      await prepareEscrowDistribution({
        genesis,
        localFrozenManifest: genesis,
        approvals,
        dealerSeat: 0,
        master: dealerMaster,
        dealerSigningKey: identities[0]?.secretKey ?? new Uint8Array(),
        store,
      }),
    );
    expect(retry).toEqual(first);
    expect(first.every(({ body }) => body.ceremonyId === deckCeremonyId(genesis))).toBe(true);
  });

  test('a master stays reserved after retirement and cannot be reused under another manifest', async () => {
    const genesis = manifest();
    const changed = manifest(31);
    const store = new MemoryEscrowLifecycleStore();
    const approvals = await approve(genesis, store);
    const changedApprovals = await approve(changed, store);
    get(
      await prepareEscrowDistribution({
        genesis,
        localFrozenManifest: genesis,
        approvals,
        dealerSeat: 0,
        master: dealerMaster,
        dealerSigningKey: identities[0]?.secretKey ?? new Uint8Array(),
        store,
      }),
    );
    get(
      await prepareEscrowDistribution({
        genesis,
        localFrozenManifest: genesis,
        approvals,
        dealerSeat: 1,
        master: fromBase64Url(encodeScalar(masterSecrets[1])),
        dealerSigningKey: identities[1]?.secretKey ?? new Uint8Array(),
        store,
      }),
    );
    get(await retireEscrowCeremony(genesis, store));
    const registryAfterAbort = await store.load('escrow-lifecycle/device-index-v1');
    if (!registryAfterAbort) throw new Error('Retired registry was missing');
    const retiredReservations = v.parse(
      v.object({
        reservations: v.array(
          v.object({
            masterPub: v.string(),
            ceremonyId: v.string(),
            dealerSeat: v.number(),
            status: v.string(),
            envelopes: v.array(v.unknown()),
          }),
        ),
      }),
      canonicalDecode(registryAfterAbort),
    ).reservations;
    for (const [seat, masterPub] of [0, 1].map((item) => [
      item,
      encodePoint(scalePoint(G, masterSecrets[item] ?? 71n)),
    ])) {
      expect(retiredReservations.find((row) => row.masterPub === masterPub)).toMatchObject({
        ceremonyId: deckCeremonyId(genesis),
        dealerSeat: seat,
        status: 'retired',
        envelopes: [],
      });
    }
    expect(
      await prepareEscrowDistribution({
        genesis,
        localFrozenManifest: genesis,
        approvals,
        dealerSeat: 0,
        master: dealerMaster,
        dealerSigningKey: identities[0]?.secretKey ?? new Uint8Array(),
        store,
      }),
    ).toMatchObject({ ok: false, error: { code: 'escrow-ceremony-retired' } });
    expect(
      await prepareEscrowDistribution({
        genesis,
        localFrozenManifest: genesis,
        approvals,
        dealerSeat: 1,
        master: fromBase64Url(encodeScalar(masterSecrets[1])),
        dealerSigningKey: identities[1]?.secretKey ?? new Uint8Array(),
        store,
      }),
    ).toMatchObject({ ok: false, error: { code: 'escrow-ceremony-retired' } });
    expect(
      await prepareEscrowDistribution({
        genesis: changed,
        localFrozenManifest: changed,
        approvals: changedApprovals,
        dealerSeat: 0,
        master: dealerMaster,
        dealerSigningKey: identities[0]?.secretKey ?? new Uint8Array(),
        store,
      }),
    ).toMatchObject({ ok: false, error: { code: 'escrow-master-reserved' } });
  });

  test('a durable abort tombstone blocks dealing even before any master is reserved', async () => {
    const genesis = manifest(34);
    const changed = manifest(38);
    const store = new MemoryEscrowLifecycleStore();
    const approvals = await approve(genesis, store);
    const changedApprovals = await approve(changed, store);
    get(await retireEscrowCeremony(genesis, store));
    expect(
      await prepareEscrowDistribution({
        genesis,
        localFrozenManifest: genesis,
        approvals,
        dealerSeat: 0,
        master: dealerMaster,
        dealerSigningKey: identities[0]?.secretKey ?? new Uint8Array(),
        store,
      }),
    ).toMatchObject({ ok: false, error: { code: 'escrow-ceremony-retired' } });
    expect(
      await prepareEscrowDistribution({
        genesis: changed,
        localFrozenManifest: changed,
        approvals: changedApprovals,
        dealerSeat: 0,
        master: dealerMaster,
        dealerSigningKey: identities[0]?.secretKey ?? new Uint8Array(),
        store,
      }),
    ).toMatchObject({ ok: false, error: { code: 'escrow-master-reserved' } });
  });

  test('reads registries above the protocol message limit and keeps retirement idempotent', async () => {
    const frozenManifest = manifest(37);
    const ceremonyId = deckCeremonyId(frozenManifest);
    const registryId = 'escrow-lifecycle/device-index-v1';
    const store = new RawLifecycleStore();
    const oldRetired = Array.from({ length: 7_000 }, (_, index) => encodeScalar(BigInt(index + 1)));
    const registryBytes = canonicalEncode({
      protocol: 'escrow-device-index-v1',
      reservations: [],
      retiredCeremonies: oldRetired.filter((id) => id !== ceremonyId),
    });
    expect(registryBytes.byteLength).toBeGreaterThan(256 * 1024);
    store.records.set(registryId, registryBytes);
    get(await retireEscrowCeremony(frozenManifest, store));
    expect(store.compareAndSwapCalls).toBe(1);
    const persisted = store.records.get(registryId);
    if (!persisted) throw new Error('Registry write was missing');
    expect(canonicalDecode(persisted)).toMatchObject({
      retiredCeremonies: expect.arrayContaining([ceremonyId]),
    });
    get(await retireEscrowCeremony(frozenManifest, store));
    expect(store.compareAndSwapCalls).toBe(1);
  });

  test('clears envelopes and retains headroom when retiring a near-capacity registry', async () => {
    const genesis = manifest(40);
    const ceremonyId = deckCeremonyId(genesis);
    const foreignCeremonyId = encodeScalar(91_001n);
    const maxRegistryBytes = 16 * 1024 * 1024;
    const rows = [
      ...seatOrder.slice(0, 4).map((seat) => ({
        protocol: 'escrow-master-reservation-v1',
        ceremonyId,
        masterPub: encodePoint(scalePoint(G, masterSecretAt(seat))),
        dealerSeat: seat,
        status: 'active',
        envelopes: [],
      })),
      ...Array.from({ length: 7 }, (_, index) => encodeScalar(BigInt(90_001 + index))).map(
        (masterPub, index) => ({
          protocol: 'escrow-master-reservation-v1',
          ceremonyId: foreignCeremonyId,
          masterPub,
          dealerSeat: seatOrder[index % seatOrder.length] ?? 0,
          status: 'active',
          envelopes: Array.from({ length: 5 }, () => 'y'.repeat(478_500)),
        }),
      ),
    ];
    const original = canonicalEncode({
      protocol: 'escrow-device-index-v1',
      reservations: rows,
      retiredCeremonies: [],
    });
    expect(original.byteLength).toBeGreaterThan(maxRegistryBytes - 64 * 1024);
    expect(original.byteLength).toBeLessThan(maxRegistryBytes);
    const store = new RawLifecycleStore();
    store.records.set('escrow-lifecycle/device-index-v1', original);
    get(await retireEscrowCeremony(genesis, store));
    expect(store.compareAndSwapCalls).toBe(1);
    const retiredBytes = store.records.get('escrow-lifecycle/device-index-v1');
    if (!retiredBytes) throw new Error('Retired registry was missing');
    expect(retiredBytes.byteLength).toBeLessThan(maxRegistryBytes);
    expect(retiredBytes.byteLength).toBeGreaterThan(maxRegistryBytes - 64 * 1024);
    const retiredRegistry = v.parse(
      v.object({
        reservations: v.array(
          v.object({
            ceremonyId: v.string(),
            masterPub: v.string(),
            status: v.string(),
            envelopes: v.array(v.string()),
          }),
        ),
        retiredCeremonies: v.array(v.string()),
      }),
      canonicalDecode(retiredBytes),
    );
    expect(retiredRegistry.retiredCeremonies).toContain(ceremonyId);
    const foreignReservation = retiredRegistry.reservations.find(
      (row) => row.masterPub === encodeScalar(90_001n),
    );
    expect(foreignReservation).toMatchObject({
      ceremonyId: foreignCeremonyId,
      status: 'active',
    });
    expect(foreignReservation?.envelopes).toEqual(
      Array.from({ length: 5 }, () => 'y'.repeat(478_500)),
    );
  });

  test('rejects malformed retirement identifiers without changing the registry', async () => {
    const store = new RawLifecycleStore();
    const before = canonicalEncode({
      protocol: 'escrow-device-index-v1',
      reservations: [],
      retiredCeremonies: [],
    });
    store.records.set('escrow-lifecycle/device-index-v1', before);
    const invalidManifest = { ...manifest(39), ceremonyNonce: 'not-a-key32' };
    expect(await retireEscrowCeremony(invalidManifest, store)).toMatchObject({
      ok: false,
      error: { code: 'escrow-lifecycle-genesis' },
    });
    expect(store.compareAndSwapCalls).toBe(0);
    expect(store.records.get('escrow-lifecycle/device-index-v1')).toEqual(before);
  });

  test('an abort racing with master reservation wins before any envelopes are returned', async () => {
    const genesis = manifest(35);
    const store = new AbortRaceStore();
    const approvals = await approve(genesis, store);
    const preparing = prepareEscrowDistribution({
      genesis,
      localFrozenManifest: genesis,
      approvals,
      dealerSeat: 0,
      master: dealerMaster,
      dealerSigningKey: identities[0]?.secretKey ?? new Uint8Array(),
      store,
    });
    await store.reservationWriteWaiting;
    get(await retireEscrowCeremony(genesis, store));
    store.resumeReservationWrite();
    expect(await preparing).toMatchObject({
      ok: false,
      error: { code: 'escrow-ceremony-retired' },
    });
  });

  test('any authenticated share disclosure aborts the whole ceremony, including a false complaint', async () => {
    const genesis = manifest(36);
    const store = new MemoryEscrowLifecycleStore();
    const { approvals, envelope } = await makeFirstEnvelope(genesis, store);
    const secondMaster = fromBase64Url(encodeScalar(masterSecrets[1]));
    get(
      await prepareEscrowDistribution({
        genesis,
        localFrozenManifest: genesis,
        approvals,
        dealerSeat: 1,
        master: secondMaster,
        dealerSigningKey: identities[1]?.secretKey ?? new Uint8Array(),
        store,
      }),
    );
    const validFalseComplaint = signedComplaintForGoodShare(envelope);
    const invalidSignature = {
      ...validFalseComplaint,
      sig: signObject(
        'escrow-share-dispute',
        validFalseComplaint.body,
        identities[0]?.secretKey ?? new Uint8Array(),
      ),
    };
    expect(
      await verifyAndRetireEscrowShareDispute({
        dispute: invalidSignature,
        envelope,
        genesis,
        localFrozenManifest: genesis,
        store,
      }),
    ).toMatchObject({ ok: false });
    const invalidBody = {
      ...validFalseComplaint.body,
      proof: {
        ...validFalseComplaint.body.proof,
        response: encodeScalar(0n),
      },
    };
    const invalid = {
      body: invalidBody,
      sig: signObject(
        'escrow-share-dispute',
        invalidBody,
        identities[envelope.body.holder.seat]?.secretKey ?? new Uint8Array(),
      ),
    };
    expect(
      await verifyAndRetireEscrowShareDispute({
        dispute: invalid,
        envelope,
        genesis,
        localFrozenManifest: genesis,
        store,
      }),
    ).toMatchObject({ ok: false });
    expect(
      (
        await prepareEscrowDistribution({
          genesis,
          localFrozenManifest: genesis,
          approvals,
          dealerSeat: 1,
          master: secondMaster,
          dealerSigningKey: identities[1]?.secretKey ?? new Uint8Array(),
          store,
        })
      ).ok,
    ).toBe(true);
    // A valid authenticated disclosure is not returned as a verdict until the
    // all-master retirement tombstone has been durably committed.
    const failingRetirement = new RawLifecycleStore();
    const { approvals: failureApprovals, envelope: secondEnvelope } = await makeFirstEnvelope(
      genesis,
      failingRetirement,
    );
    const validDisclosure = signedComplaintForGoodShare(secondEnvelope);
    failingRetirement.failCompareAndSwap = true;
    expect(
      await verifyAndRetireEscrowShareDispute({
        dispute: validDisclosure,
        envelope: secondEnvelope,
        genesis,
        localFrozenManifest: genesis,
        store: failingRetirement,
      }),
    ).toMatchObject({ ok: false, error: { code: 'escrow-registry-write' } });
    failingRetirement.failCompareAndSwap = false;
    expect(
      (
        await prepareEscrowDistribution({
          genesis,
          localFrozenManifest: genesis,
          approvals: failureApprovals,
          dealerSeat: 0,
          master: dealerMaster,
          dealerSigningKey: identities[0]?.secretKey ?? new Uint8Array(),
          store: failingRetirement,
        })
      ).ok,
    ).toBe(true);
    expect(
      await verifyAndRetireEscrowShareDispute({
        dispute: validFalseComplaint,
        envelope,
        genesis,
        localFrozenManifest: genesis,
        store,
      }),
    ).toMatchObject({ ok: true, value: { kind: 'false-complaint' } });
    expect(
      await prepareEscrowDistribution({
        genesis,
        localFrozenManifest: genesis,
        approvals,
        dealerSeat: 1,
        master: secondMaster,
        dealerSigningKey: identities[1]?.secretKey ?? new Uint8Array(),
        store,
      }),
    ).toMatchObject({ ok: false, error: { code: 'escrow-ceremony-retired' } });
  });

  test('competing ceremony reservations have exactly one durable winner', async () => {
    const first = manifest(32);
    const second = manifest(33);
    const store = new MemoryEscrowLifecycleStore();
    const [firstApprovals, secondApprovals] = await Promise.all([
      approve(first, store),
      approve(second, store),
    ]);
    const results = await Promise.all([
      prepareEscrowDistribution({
        genesis: first,
        localFrozenManifest: first,
        approvals: firstApprovals,
        dealerSeat: 0,
        master: dealerMaster,
        dealerSigningKey: identities[0]?.secretKey ?? new Uint8Array(),
        store,
      }),
      prepareEscrowDistribution({
        genesis: second,
        localFrozenManifest: second,
        approvals: secondApprovals,
        dealerSeat: 0,
        master: dealerMaster,
        dealerSigningKey: identities[0]?.secretKey ?? new Uint8Array(),
        store,
      }),
    ]);
    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.filter(({ ok }) => !ok)).toHaveLength(1);
  });

  test('a storage failure returns no dealer envelopes', async () => {
    const genesis = manifest();
    const store = new FailingReservationStore();
    const approvals = await approve(genesis, store);
    const result = await prepareEscrowDistribution({
      genesis,
      localFrozenManifest: genesis,
      approvals,
      dealerSeat: 0,
      master: dealerMaster,
      dealerSigningKey: identities[0]?.secretKey ?? new Uint8Array(),
      store,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'escrow-registry-write' } });
  });
});

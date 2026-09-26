import { canonicalDecode, canonicalEncode, toBase64Url } from '@cp2p/codec';
import {
  encodePoint,
  encodeScalar,
  G,
  identityFromSecret,
  pedersenCommit,
  scalePoint,
  signObject,
} from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { describe, expect, test, vi } from 'vitest';
import {
  MemoryStealDeliveryStore,
  prepareStealContribution,
  prepareStealResponse,
} from './steal-contributions.js';
import type {
  StealContributionProducer,
  StealDeliveryStore,
  StealResponseProducer,
} from './steal-contributions.js';
import {
  createStealContribution,
  createStealReceipt,
  stealOperationId,
  verifyStealContribution,
} from './steal-delivery.js';
import type { FixedSteal, StealOperation } from './steal-delivery.js';
import type { LogContext } from './log.js';
import { protocolFixture } from './testing/fixtures.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function fixture() {
  const victim = identityFromSecret(new Uint8Array(32).fill(31));
  const thief = identityFromSecret(new Uint8Array(32).fill(32));
  const counts = { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 } as const;
  const blindings = {
    brick: encodeScalar(2n),
    lumber: encodeScalar(3n),
    wool: encodeScalar(4n),
    grain: encodeScalar(5n),
    ore: encodeScalar(6n),
  } as const;
  const operation: StealOperation = {
    protocol: 'hidden-steal-v1',
    genesisDigest: toBase64Url(new Uint8Array(32).fill(19)),
    epoch: 0,
    anchor: { seq: 12, hash: 'a'.repeat(64) },
    beaconOperationId: 'b'.repeat(64),
    thief: {
      seat: 1,
      publicKey: thief.peerId,
      encryptionKey: encodePoint(scalePoint(G, 23n)),
    },
    victim: { seat: 0, publicKey: victim.peerId },
    handSize: 1,
    index: 0,
    commitments: {
      brick: pedersenCommit(1n, 2n),
      lumber: pedersenCommit(0n, 3n),
      wool: pedersenCommit(0n, 4n),
      grain: pedersenCommit(0n, 5n),
      ore: pedersenCommit(0n, 6n),
    },
  };
  const protocol = protocolFixture();
  const context: LogContext = {
    genesis: protocol.genesis,
    engine: protocol.engine,
    head: protocol.entry,
    state: protocol.state,
    lastNonces: new Map(),
    crypto: null,
  };
  const makeContribution = (seedByte: number) =>
    value(
      createStealContribution(
        operation,
        counts,
        blindings,
        new Uint8Array(32).fill(seedByte),
        victim.secretKey,
      ),
    );
  const contribution = makeContribution(41);
  const fixed: FixedSteal = {
    operation,
    contribution,
    entry: { seq: 13, hash: 'c'.repeat(64) },
  };
  const receipt = value(createStealReceipt(fixed, 23n, thief.secretKey));
  return { victim, thief, operation, context, contribution, fixed, receipt, makeContribution };
}

function contributionId(operation: StealOperation): string {
  return `steal-contribution/${stealOperationId(operation)}/0`;
}

function responseId(fixed: FixedSteal): string {
  return `steal-response/${stealOperationId(fixed.operation)}/${fixed.entry.hash}/1`;
}

describe('durable hidden-steal contributions and responses', () => {
  test('persists exact contribution bytes and restores them without calling the producer', async () => {
    const { victim, operation, context, contribution } = fixture();
    const store = new MemoryStealDeliveryStore();
    const write = vi.spyOn(store, 'putIfAbsent');
    const producer = vi.fn<StealContributionProducer>(() => success(contribution));
    const first = value(
      await prepareStealContribution(operation, 0, victim.secretKey, context, producer, store),
    );
    const bytes = await store.load(contributionId(operation));
    expect(bytes).not.toBeNull();
    expect(canonicalDecode(bytes ?? new Uint8Array())).toEqual(first);
    expect(write).toHaveBeenCalledOnce();
    expect(
      value(
        await prepareStealContribution(
          operation,
          0,
          victim.secretKey,
          context,
          () => {
            throw new Error('a restart must restore before producing');
          },
          store,
        ),
      ),
    ).toEqual(first);
    expect(producer).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
  });

  test('returns a competing valid put-if-absent winner', async () => {
    const { victim, operation, context, contribution, makeContribution } = fixture();
    const winner = makeContribution(42);
    expect(verifyStealContribution(winner, operation).ok).toBe(true);
    expect(winner).not.toEqual(contribution);
    const id = contributionId(operation);
    let loads = 0;
    let record: Uint8Array | null = null;
    const store: StealDeliveryStore = {
      async load(requested) {
        expect(requested).toBe(id);
        loads += 1;
        return loads === 1 ? null : (record?.slice() ?? null);
      },
      async putIfAbsent(requested, bytes) {
        expect(requested).toBe(id);
        expect(canonicalDecode(bytes)).toEqual(contribution);
        record = canonicalEncode(winner);
        return false;
      },
    };
    const result = await prepareStealContribution(
      operation,
      0,
      victim.secretKey,
      context,
      () => success(contribution),
      store,
    );
    expect(result).toEqual({ ok: true, value: winner });
    expect(loads).toBe(2);
  });

  test('rejects wrong signer and corrupt or misplaced stored contributions without replacement', async () => {
    const { victim, thief, operation, context, contribution } = fixture();
    const store = new MemoryStealDeliveryStore();
    const id = contributionId(operation);
    const producer = vi.fn<StealContributionProducer>(() => success(contribution));
    expect(
      await prepareStealContribution(operation, 0, thief.secretKey, context, producer, store),
    ).toMatchObject({ ok: false, error: { code: 'steal-outbox-key' } });
    expect(producer).not.toHaveBeenCalled();

    await store.putIfAbsent(id, new Uint8Array([1, 2, 3]));
    const writes = vi.spyOn(store, 'putIfAbsent');
    expect(
      await prepareStealContribution(operation, 0, victim.secretKey, context, producer, store),
    ).toMatchObject({ ok: false, error: { code: 'steal-outbox-record' } });
    expect(writes).not.toHaveBeenCalled();
    expect(producer).not.toHaveBeenCalled();

    const misplacedBody = { ...contribution.body, seat: 1 };
    const misplaced = {
      body: misplacedBody,
      sig: signObject('steal-contribution', misplacedBody, victim.secretKey),
    };
    const misplacedStore = new MemoryStealDeliveryStore();
    await misplacedStore.putIfAbsent(id, canonicalEncode(misplaced));
    expect(
      await prepareStealContribution(
        operation,
        0,
        victim.secretKey,
        context,
        producer,
        misplacedStore,
      ),
    ).toMatchObject({ ok: false, error: { code: 'steal-outbox-record' } });
    expect(producer).not.toHaveBeenCalled();
  });

  test('does not report success when durable insertion fails', async () => {
    const { victim, operation, context, contribution } = fixture();
    const store: StealDeliveryStore = {
      async load() {
        return null;
      },
      async putIfAbsent() {
        throw new Error('storage unavailable');
      },
    };
    expect(
      await prepareStealContribution(
        operation,
        0,
        victim.secretKey,
        context,
        () => success(contribution),
        store,
      ),
    ).toMatchObject({ ok: false, error: { code: 'steal-outbox-write' } });
  });

  test('copies the signing key before awaiting and zeroes only its owned copy', async () => {
    const { victim, operation, context, contribution } = fixture();
    const callerKey = victim.secretKey.slice();
    let beginLoad: (() => void) | undefined;
    let releaseLoad: (() => void) | undefined;
    const loading = new Promise<void>((resolve) => {
      beginLoad = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const store: StealDeliveryStore = {
      async load() {
        beginLoad?.();
        await blocked;
        return null;
      },
      async putIfAbsent() {
        return true;
      },
    };
    let producerKey: Uint8Array | undefined;
    const pending = prepareStealContribution(
      operation,
      0,
      callerKey,
      context,
      (_operation, _seat, _context, key) => {
        producerKey = key;
        const identity = identityFromSecret(key);
        expect(identity.peerId).toBe(operation.victim.publicKey);
        identity.secretKey.fill(0);
        return success(contribution);
      },
      store,
    );
    await loading;
    callerKey.fill(0);
    releaseLoad?.();
    expect((await pending).ok).toBe(true);
    expect(producerKey?.every((byte) => byte === 0)).toBe(true);
    expect(callerKey.every((byte) => byte === 0)).toBe(true);
  });

  test('stores receipt and dispute choices in one response slot and restores the winner', async () => {
    const { thief, fixed, context, receipt } = fixture();
    const store = new MemoryStealDeliveryStore();
    const producer = vi.fn<StealResponseProducer>(() =>
      success({ kind: 'receipt', value: receipt }),
    );
    const first = value(
      await prepareStealResponse(fixed, 1, thief.secretKey, context, producer, store),
    );
    expect(first).toEqual({ kind: 'receipt', value: receipt });
    expect(canonicalDecode((await store.load(responseId(fixed))) ?? new Uint8Array())).toEqual(
      first,
    );

    const attemptedSecondChoice = vi.fn<StealResponseProducer>(() =>
      failure('should-not-run', 'The existing response occupies the shared slot'),
    );
    const restored = await prepareStealResponse(
      fixed,
      1,
      thief.secretKey,
      context,
      attemptedSecondChoice,
      store,
    );
    expect(restored).toEqual({ ok: true, value: first });
    expect(attemptedSecondChoice).not.toHaveBeenCalled();
  });

  test('rejects a wrong response signer before reading or producing', async () => {
    const { victim, fixed, context, receipt } = fixture();
    const store = new MemoryStealDeliveryStore();
    const load = vi.spyOn(store, 'load');
    const producer = vi.fn<StealResponseProducer>(() =>
      success({ kind: 'receipt', value: receipt }),
    );
    expect(
      await prepareStealResponse(fixed, 1, victim.secretKey, context, producer, store),
    ).toMatchObject({ ok: false, error: { code: 'steal-response-key' } });
    expect(load).not.toHaveBeenCalled();
    expect(producer).not.toHaveBeenCalled();
  });
});

import { canonicalEncode, toBase64Url } from '@cp2p/codec';
import { createHashChain, identityFromSecret, scalarToBytes } from '@cp2p/crypto';
import type { Seat } from '@cp2p/engine';
import { describe, expect, test, vi } from 'vitest';
import { beaconOperationId, signBeaconReveal, verifyBeaconReveal } from './beacon.js';
import {
  MemoryBeaconContributionStore,
  prepareBeaconContribution,
  type BeaconContributionStore,
  type BeaconSecretSource,
} from './beacon-contributions.js';
import { beaconExtensionOperationId } from './beacon-extension.js';
import {
  extendBeaconState,
  getBeaconExtensionOperation,
  getBeaconOperation,
} from './beacon-state.js';
import type { BeaconState } from './beacon-state.js';
import { createBeaconSecretSource } from './beacon-source.js';
import type { CryptoContext } from './crypto-context.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing beacon contribution fixture element');
  return value;
}

function fixture(exhausted = false) {
  const seats: readonly Seat[] = [0, 1];
  const identities = [1, 2].map((number) => identityFromSecret(new Uint8Array(32).fill(number)));
  const chains = [11, 12].map((number) => createHashChain(new Uint8Array(32).fill(number), 2));
  const renewed = createHashChain(new Uint8Array(32).fill(21), 3);
  const publicChains = identities.map((identity, index) => {
    const consumed = exhausted && index === 0 ? 2 : 0;
    return {
      seat: required(seats[index]),
      publicKey: identity.peerId,
      chainEpoch: 0,
      index: consumed,
      length: 2,
      tip: toBase64Url(required(required(chains[index])[consumed])),
    };
  });
  const beacon: BeaconState = {
    genesisDigest: toBase64Url(new Uint8Array(32).fill(9)),
    chains: publicChains,
    round: 0,
    active: {
      genesisDigest: toBase64Url(new Uint8Array(32).fill(9)),
      epoch: 0,
      anchor: { seq: 17, hash: 'a'.repeat(64) },
      round: 1,
      pending: { kind: 'random', request: { type: 'dice', dice: 2 }, systemType: 'DICE_RESULT' },
      participants: publicChains,
    },
    fixed: null,
  };
  const crypto: CryptoContext = {
    epoch: 0,
    beacon,
    decks: { genesisDigest: beacon.genesisDigest, decks: [], active: null },
  };
  const link = vi.fn<BeaconSecretSource['link']>((chainEpoch, index) => {
    if (chainEpoch !== 0 || index !== 1) throw new Error('Unexpected link request');
    return required(required(chains[0])[1]);
  });
  const extension = vi.fn<BeaconSecretSource['extension']>((chainEpoch) => {
    if (chainEpoch !== 1) throw new Error('Unexpected extension request');
    return { length: 3, tip: required(renewed[0]) };
  });
  const source: BeaconSecretSource = { link, extension };
  return { crypto, identities, chains, renewed, source, link, extension };
}

describe('durable outgoing beacon contributions', () => {
  test('reports a local source failure separately and writes no contribution', async () => {
    const { crypto, identities, source } = fixture();
    const store = new MemoryBeaconContributionStore();
    const write = vi.spyOn(store, 'putIfAbsent');
    const result = await prepareBeaconContribution(
      crypto,
      0,
      required(identities[0]).secretKey,
      {
        ...source,
        link() {
          throw new Error('source disposed');
        },
      },
      store,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'beacon-contribution-source' } });
    expect(write).not.toHaveBeenCalled();
  });

  test('persists before returning and retries exact signed bytes without using the secret source', async () => {
    const { crypto, identities, source, link, extension } = fixture();
    const memory = new MemoryBeaconContributionStore();
    let release: (() => void) | undefined;
    let signalWrite: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      signalWrite = resolve;
    });
    const allowWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store: BeaconContributionStore = {
      load: (id) => memory.load(id),
      async putIfAbsent(id, bytes) {
        signalWrite?.();
        await allowWrite;
        return memory.putIfAbsent(id, bytes);
      },
    };
    let returned = false;
    const pending = prepareBeaconContribution(
      crypto,
      0,
      required(identities[0]).secretKey,
      source,
      store,
    ).then((result) => {
      returned = true;
      return result;
    });
    await writeStarted;
    expect(returned).toBe(false);
    release?.();
    const first = await pending;
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value) throw new Error('Missing signed beacon contribution');
    expect(first.value.kind).toBe('beacon-reveal');
    const operation = getBeaconOperation(crypto.beacon);
    if (!operation.ok) throw new Error(operation.error.message);
    const operationId = beaconOperationId(operation.value);
    expect(await memory.load(operationId)).toEqual(canonicalEncode(first.value));
    const detached = await memory.load(operationId);
    detached?.fill(0);
    expect(await memory.load(operationId)).toEqual(canonicalEncode(first.value));
    const inserted = canonicalEncode(first.value);
    expect(await memory.putIfAbsent('copy-check', inserted)).toBe(true);
    inserted.fill(0);
    expect(await memory.load('copy-check')).toEqual(canonicalEncode(first.value));
    const second = await prepareBeaconContribution(
      crypto,
      0,
      required(identities[0]).secretKey,
      source,
      store,
    );
    expect(second).toEqual(first);
    expect(link).toHaveBeenCalledTimes(1);
    expect(extension).not.toHaveBeenCalled();
  });

  test('does not emit after failed persistence or missing winning race record', async () => {
    const { crypto, identities, source } = fixture();
    const key = required(identities[0]).secretKey;
    const writeFails: BeaconContributionStore = {
      async load() {
        return null;
      },
      async putIfAbsent() {
        throw new Error('disk failure');
      },
    };
    expect((await prepareBeaconContribution(crypto, 0, key, source, writeFails)).ok).toBe(false);
    const noWinner: BeaconContributionStore = {
      async load() {
        return null;
      },
      async putIfAbsent() {
        return false;
      },
    };
    expect((await prepareBeaconContribution(crypto, 0, key, source, noWinner)).ok).toBe(false);
  });

  test('returns the atomically persisted winner when two extensions race', async () => {
    const { crypto, identities, source } = fixture(true);
    const memory = new MemoryBeaconContributionStore();
    const possibleTips = [
      createHashChain(new Uint8Array(32).fill(31), 3),
      createHashChain(new Uint8Array(32).fill(32), 3),
    ];
    let extensionCalls = 0;
    const raceExtension = vi.fn<BeaconSecretSource['extension']>(() => ({
      length: 3,
      tip: required(required(possibleTips[extensionCalls++])[0]),
    }));
    const raceSource = { ...source, extension: raceExtension };
    let loads = 0;
    const store: BeaconContributionStore = {
      async load(id) {
        return ++loads <= 2 ? null : memory.load(id);
      },
      putIfAbsent: (id, bytes) => memory.putIfAbsent(id, bytes),
    };
    const args = [crypto, 0, required(identities[0]).secretKey, raceSource, store] as const;
    const [first, second] = await Promise.all([
      prepareBeaconContribution(...args),
      prepareBeaconContribution(...args),
    ]);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(raceExtension).toHaveBeenCalledTimes(2);
    const operation = getBeaconExtensionOperation(crypto.beacon);
    if (!operation.ok || !first.ok || !first.value) throw new Error('Missing extension');
    expect(await memory.load(beaconExtensionOperationId(operation.value))).toEqual(
      canonicalEncode(first.value),
    );
  });

  test('recreates a failed pre-write extension from the same master, then reveals its certified chain', async () => {
    const { crypto, identities } = fixture(true);
    const context = { ceremonyId: toBase64Url(new Uint8Array(32).fill(61)), seat: 0 as Seat };
    const first = createBeaconSecretSource(scalarToBytes(7n), context, 2);
    const initialCommitment = first.initialCommitment;
    const active = crypto.beacon.active;
    if (!active) throw new Error('Expected a frozen beacon request');
    const key = required(identities[0]).secretKey;
    const initialChain = {
      ...required(crypto.beacon.chains[0]),
      length: initialCommitment.length,
      index: 0,
      tip: toBase64Url(initialCommitment.tip),
    };
    const initialState: BeaconState = {
      ...crypto.beacon,
      chains: [initialChain],
      active: { ...active, participants: [initialChain] },
    };
    const firstOperation = getBeaconOperation(initialState);
    if (!firstOperation.ok) throw new Error(firstOperation.error.message);
    const firstLink = first.source.link(0, 1);
    expect(
      verifyBeaconReveal(
        signBeaconReveal(firstOperation.value, 0, firstLink, key),
        firstOperation.value,
      ).ok,
    ).toBe(true);
    const onceConsumed = { ...initialChain, index: 1, tip: toBase64Url(firstLink) };
    const secondState: BeaconState = {
      ...initialState,
      round: 1,
      chains: [onceConsumed],
      active: { ...active, round: 2, participants: [onceConsumed] },
    };
    const secondOperation = getBeaconOperation(secondState);
    if (!secondOperation.ok) throw new Error(secondOperation.error.message);
    const finalLink = first.source.link(0, 2);
    expect(
      verifyBeaconReveal(
        signBeaconReveal(secondOperation.value, 0, finalLink, key),
        secondOperation.value,
      ).ok,
    ).toBe(true);
    const exhausted = {
      ...onceConsumed,
      index: initialCommitment.length,
      tip: toBase64Url(finalLink),
    };
    const atExtension: CryptoContext = {
      ...crypto,
      beacon: {
        ...secondState,
        round: 2,
        chains: [exhausted],
        active: { ...active, round: 3, participants: [exhausted] },
      },
    };
    let firstTip = '';
    const firstSource: BeaconSecretSource = {
      link: (epoch, index) => first.source.link(epoch, index),
      extension(epoch) {
        const next = first.source.extension(epoch);
        firstTip = toBase64Url(next.tip);
        return next;
      },
    };
    const failedStore: BeaconContributionStore = {
      async load() {
        return null;
      },
      async putIfAbsent() {
        throw new Error('storage unavailable before durable write');
      },
    };
    const failed = await prepareBeaconContribution(atExtension, 0, key, firstSource, failedStore);
    expect(failed.ok).toBe(false);
    expect(firstTip).not.toBe('');
    first.dispose();

    const restarted = createBeaconSecretSource(scalarToBytes(7n), context, 2);
    expect(restarted.initialCommitment).toEqual(initialCommitment);
    const store = new MemoryBeaconContributionStore();
    const extension = await prepareBeaconContribution(atExtension, 0, key, restarted.source, store);
    expect(extension.ok).toBe(true);
    if (!extension.ok || extension.value?.kind !== 'beacon-extension')
      throw new Error('Expected a persisted extension after restart');
    expect(extension.value.signed.body.tip).toBe(firstTip);
    const operation = getBeaconExtensionOperation(atExtension.beacon);
    if (!operation.ok) throw new Error(operation.error.message);
    expect(await store.load(beaconExtensionOperationId(operation.value))).toEqual(
      canonicalEncode(extension.value),
    );
    const extended = extendBeaconState(atExtension.beacon, [extension.value.signed]);
    if (!extended.ok) throw new Error(extended.error.message);
    restarted.dispose();
    const restoredForReveal = createBeaconSecretSource(scalarToBytes(7n), context, 2);
    const afterExtension = { ...atExtension, beacon: extended.value };
    const next = await prepareBeaconContribution(
      afterExtension,
      0,
      key,
      restoredForReveal.source,
      store,
    );
    expect(next.ok).toBe(true);
    if (!next.ok || next.value?.kind !== 'beacon-reveal')
      throw new Error('Expected the first reveal from the certified extension');
    const revealOperation = getBeaconOperation(extended.value);
    if (!revealOperation.ok) throw new Error(revealOperation.error.message);
    expect(verifyBeaconReveal(next.value.signed, revealOperation.value).ok).toBe(true);
    restoredForReveal.dispose();
  });

  test('rejects corrupt or wrong-context stored records without generating another contribution', async () => {
    const { crypto, identities, chains, source, link, extension } = fixture();
    const key = required(identities[0]).secretKey;
    const operation = getBeaconOperation(crypto.beacon);
    if (!operation.ok) throw new Error(operation.error.message);
    const id = beaconOperationId(operation.value);
    const corrupt = new MemoryBeaconContributionStore();
    await corrupt.putIfAbsent(id, new Uint8Array([1, 2, 3]));
    expect((await prepareBeaconContribution(crypto, 0, key, source, corrupt)).ok).toBe(false);
    const other = { ...operation.value, anchor: { ...operation.value.anchor, seq: 18 } };
    const wrong = {
      kind: 'beacon-reveal',
      signed: signBeaconReveal(other, 0, required(required(chains[0])[1]), key),
    };
    const wrongContext = new MemoryBeaconContributionStore();
    await wrongContext.putIfAbsent(id, canonicalEncode(wrong));
    expect((await prepareBeaconContribution(crypto, 0, key, source, wrongContext)).ok).toBe(false);
    expect(link).not.toHaveBeenCalled();
    expect(extension).not.toHaveBeenCalled();
  });

  test('waits for every exhausted tip, then permits the next reveal', async () => {
    const { crypto, identities, renewed, source, link, extension: extensionSource } = fixture(true);
    const store = new MemoryBeaconContributionStore();
    const otherSeat = await prepareBeaconContribution(
      crypto,
      1,
      required(identities[1]).secretKey,
      source,
      store,
    );
    expect(otherSeat).toEqual({ ok: true, value: null });
    expect(link).not.toHaveBeenCalled();
    const extension = await prepareBeaconContribution(
      crypto,
      0,
      required(identities[0]).secretKey,
      source,
      store,
    );
    expect(extension.ok).toBe(true);
    if (!extension.ok || extension.value?.kind !== 'beacon-extension')
      throw new Error('Missing signed extension');
    expect(extension.value.signed.body.tip).toBe(toBase64Url(required(renewed[0])));
    const extended = extendBeaconState(crypto.beacon, [extension.value.signed]);
    if (!extended.ok) throw new Error(extended.error.message);
    const next = { ...crypto, beacon: extended.value };
    const nowRevealed = await prepareBeaconContribution(
      next,
      0,
      required(identities[0]).secretKey,
      { ...source, link: () => required(renewed[1]) },
      store,
    );
    expect(nowRevealed.ok).toBe(true);
    expect(nowRevealed.ok && nowRevealed.value?.kind).toBe('beacon-reveal');
    expect(extensionSource).toHaveBeenCalledTimes(1);
    expect(
      await prepareBeaconContribution(
        { ...crypto, beacon: { ...crypto.beacon, active: null } },
        0,
        required(identities[0]).secretKey,
        source,
        store,
      ),
    ).toEqual({ ok: true, value: null });
    expect(
      await prepareBeaconContribution(next, 4, required(identities[0]).secretKey, source, store),
    ).toEqual({ ok: true, value: null });
  });
});

import { toBase64Url } from '@cp2p/codec';
import {
  G,
  hashToPoint,
  encodePoint,
  identityFromSecret,
  scalePoint,
  signObject,
} from '@cp2p/crypto';
import type { Result } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import {
  applyDeckPass,
  deckPassOperationId,
  deckSetupId,
  initDeckSetup,
  replayDeckSetup,
  signDeckLock,
  signDeckShuffle,
  validateDeckSetupState,
} from './deck-setup.js';
import type { DeckDefinition, DeckSetupState, SignedDeckPass } from './deck-setup.js';

const keys = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)] as const;
const identities = keys.map((key) => identityFromSecret(key));
const ceremonyId = toBase64Url(new Uint8Array(32).fill(9));
const definition: DeckDefinition = {
  ceremonyId,
  deckId: 'development',
  deckEpoch: 0,
  creation: { kind: 'ceremony' },
  cards: [
    { identity: 'knight#1', card: 'knight' },
    { identity: 'knight#2', card: 'knight' },
    { identity: 'road#1', card: 'roadBuilding' },
  ],
  participants: identities.map(({ peerId }, seat) => ({
    seat: seat === 0 ? 0 : 1,
    publicKey: peerId,
  })),
};
const proofSeed = new Uint8Array(32).fill(12);

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function errorCode(result: Result<unknown>): string | undefined {
  return result.ok ? undefined : result.error.code;
}

function completed(): { state: DeckSetupState; passes: SignedDeckPass[] } {
  let state = value(initDeckSetup(definition));
  const passes: SignedDeckPass[] = [];
  for (const [index, secret, permutation] of [
    [0, 13n, [2, 0, 1]],
    [1, 17n, [1, 2, 0]],
  ] as const) {
    const pass = signDeckShuffle(state, secret, permutation, proofSeed, keys[index]);
    passes.push(pass);
    state = value(applyDeckPass(state, pass));
  }
  for (const [index, secret, locks] of [
    [0, 13n, [3n, 5n, 7n]],
    [1, 17n, [11n, 19n, 23n]],
  ] as const) {
    const pass = signDeckLock(state, secret, locks, proofSeed, keys[index]);
    passes.push(pass);
    state = value(applyDeckPass(state, pass));
  }
  return { state, passes };
}

describe('signed deck setup', () => {
  test('maps unique card identities and replays ordered shuffle and lock proofs', () => {
    const initial = value(initDeckSetup(definition));
    expect(initial.points[0]).toBe(
      encodePoint(
        hashToPoint('card', {
          ceremonyId,
          deckId: 'development',
          deckEpoch: 0,
          identity: 'knight#1',
        }),
      ),
    );
    expect(initial.points[0]).not.toBe(initial.points[1]);
    const { state, passes } = completed();
    expect(state.shuffleKeys).toHaveLength(2);
    expect(state.lockKeys).toHaveLength(2);
    expect(state.points).toHaveLength(3);
    expect(value(replayDeckSetup(definition, passes))).toEqual(state);
    expect(deckSetupId({ ...definition, deckEpoch: 1 })).not.toBe(deckSetupId(definition));
    expect(
      deckSetupId({
        ...definition,
        creation: {
          kind: 'certified',
          genesisDigest: ceremonyId,
          epoch: 0,
          anchor: { seq: 5, hash: 'a'.repeat(64) },
        },
      }),
    ).not.toBe(deckSetupId(definition));
  });

  test('requires the elected actor, current full state, valid signatures and complete replay', () => {
    const initial = value(initDeckSetup(definition));
    const first = signDeckShuffle(initial, 13n, [2, 0, 1], proofSeed, keys[0]);
    const after = value(applyDeckPass(initial, first));
    expect(
      applyDeckPass(initial, signDeckShuffle(after, 17n, [1, 2, 0], proofSeed, keys[1])),
    ).toMatchObject({ ok: false, error: { code: 'deck-order' } });
    expect(applyDeckPass(after, first)).toMatchObject({
      ok: false,
      error: { code: 'deck-order' },
    });
    expect(deckPassOperationId(initial)).not.toBe(deckPassOperationId(after));
    const wrongSignature = { ...first, sig: 'A'.repeat(86) };
    expect(applyDeckPass(initial, wrongSignature)).toMatchObject({
      ok: false,
      error: { code: 'deck-signature' },
    });
    expect(() => signDeckShuffle(initial, 13n, [2, 0, 1], proofSeed, keys[1])).toThrow(/seat/);
    expect(replayDeckSetup(definition, [first])).toMatchObject({
      ok: false,
      error: { code: 'deck-pass-count' },
    });
    const sparse = [first, first, first, first];
    Reflect.deleteProperty(sparse, '1');
    expect(replayDeckSetup(definition, sparse)).toMatchObject({
      ok: false,
      error: { code: 'deck-pass-count' },
    });
    const hostile = new Proxy([first, first, first, first], {
      ownKeys: () => {
        throw new Error('revoked pass list');
      },
    });
    expect(replayDeckSetup(definition, hostile)).toMatchObject({
      ok: false,
      error: { code: 'deck-pass-count' },
    });
  });

  test('rejects substituted points, re-keyed shuffles and altered lock proofs even when re-signed', () => {
    const initial = value(initDeckSetup(definition));
    const first = signDeckShuffle(initial, 13n, [2, 0, 1], proofSeed, keys[0]);
    if (first.body.phase !== 'shuffle') throw new Error('Expected shuffle');
    const substituted = {
      ...first.body,
      output: [first.body.output[1], first.body.output[0], first.body.output[2]],
    };
    expect(
      errorCode(
        applyDeckPass(initial, {
          body: substituted,
          sig: signObject('deck-pass', substituted, keys[0]),
        }),
      ),
    ).toBe('deck-shuffle-proof');
    const rekeyed = {
      ...first.body,
      publicKey: encodePoint(
        hashToPoint('card', { ceremonyId, deckId: 'other', deckEpoch: 0, identity: 'x' }),
      ),
    };
    expect(
      errorCode(
        applyDeckPass(initial, { body: rekeyed, sig: signObject('deck-pass', rekeyed, keys[0]) }),
      ),
    ).toBe('deck-shuffle-proof');
    const { passes } = completed();
    let beforeLock = initial;
    for (const pass of passes.slice(0, 2)) beforeLock = value(applyDeckPass(beforeLock, pass));
    const lock = passes[2];
    if (!lock || lock.body.phase !== 'lock') throw new Error('Expected lock');
    const altered = {
      ...lock.body,
      proofs: [lock.body.proofs[1], lock.body.proofs[0], lock.body.proofs[2]],
    };
    expect(
      errorCode(
        applyDeckPass(beforeLock, {
          body: altered,
          sig: signObject('deck-pass', altered, keys[0]),
        }),
      ),
    ).toBe('deck-lock-proof');

    const wrongLockOperation = {
      ...lock.body,
      operationId: 'f'.repeat(64),
    };
    expect(
      errorCode(
        applyDeckPass(beforeLock, {
          body: wrongLockOperation,
          sig: signObject('deck-pass', wrongLockOperation, keys[0]),
        }),
      ),
    ).toBe('deck-operation');

    const substitutedOutput = {
      ...lock.body,
      output: [lock.body.output[1], lock.body.output[0], lock.body.output[2]],
    };
    expect(
      errorCode(
        applyDeckPass(beforeLock, {
          body: substitutedOutput,
          sig: signObject('deck-pass', substitutedOutput, keys[0]),
        }),
      ),
    ).toBe('deck-lock-proof');

    const identity = encodePoint(scalePoint(G, 0n));
    const identityOutput = {
      ...first.body,
      output: [identity, first.body.output[1], first.body.output[2]],
    };
    expect(
      errorCode(
        applyDeckPass(initial, {
          body: identityOutput,
          sig: signObject('deck-pass', identityOutput, keys[0]),
        }),
      ),
    ).toBe('deck-points');

    const identityShuffleKey = { ...first.body, publicKey: identity };
    expect(
      errorCode(
        applyDeckPass(initial, {
          body: identityShuffleKey,
          sig: signObject('deck-pass', identityShuffleKey, keys[0]),
        }),
      ),
    ).toBe('deck-key');

    const duplicateLockKeys = {
      ...lock.body,
      lockKeys: [lock.body.lockKeys[0], lock.body.lockKeys[0], lock.body.lockKeys[2]],
    };
    expect(
      errorCode(
        applyDeckPass(beforeLock, {
          body: duplicateLockKeys,
          sig: signObject('deck-pass', duplicateLockKeys, keys[0]),
        }),
      ),
    ).toBe('deck-key');
  });

  test('rejects invalid definitions and detached state corruption', () => {
    expect(
      initDeckSetup({ ...definition, cards: [definition.cards[0], definition.cards[0]] }).ok,
    ).toBe(false);
    expect(
      initDeckSetup({ ...definition, participants: [...definition.participants].toReversed() }).ok,
    ).toBe(false);
    expect(initDeckSetup({ ...definition, cards: [] }).ok).toBe(false);
    const initial = value(initDeckSetup(definition));
    expect(
      validateDeckSetupState({
        ...initial,
        points: [initial.points[0], initial.points[0], initial.points[2]],
      }).ok,
    ).toBe(false);
    expect(
      validateDeckSetupState({ ...initial, points: [...initial.points].toReversed() }).ok,
    ).toBe(false);
    expect(validateDeckSetupState({ ...initial, lockKeys: [[...initial.points]] }).ok).toBe(false);
  });
});

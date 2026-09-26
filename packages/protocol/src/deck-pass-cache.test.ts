import { toBase64Url } from '@cp2p/codec';
import {
  decodeScalar,
  encodeScalar,
  identityFromSecret,
  modScalar,
  signObject,
} from '@cp2p/crypto';
import type { Result } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { applyDeckPass, initDeckSetup, signDeckLock, signDeckShuffle } from './deck-setup.js';
import type { DeckDefinition, DeckSetupState, SignedDeckPass } from './deck-setup.js';

const keys = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)] as const;
const definition: DeckDefinition = {
  ceremonyId: toBase64Url(new Uint8Array(32).fill(13)),
  deckId: 'cache-check',
  deckEpoch: 0,
  creation: { kind: 'ceremony' },
  cards: [
    { identity: 'a', card: 'knight' },
    { identity: 'b', card: 'victoryPoint' },
    { identity: 'c', card: 'roadBuilding' },
  ],
  participants: keys.map((key, seat) => ({
    seat: seat === 0 ? 0 : 1,
    publicKey: identityFromSecret(key).peerId,
  })),
};

function checked<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function fixture() {
  const initial = checked(initDeckSetup(definition));
  const first = signDeckShuffle(initial, 17n, [1, 2, 0], new Uint8Array(32).fill(31), keys[0]);
  const afterFirst = checked(applyDeckPass(initial, first));
  const second = signDeckShuffle(afterFirst, 19n, [2, 0, 1], new Uint8Array(32).fill(32), keys[1]);
  const beforeLock = checked(applyDeckPass(afterFirst, second));
  const lock = signDeckLock(beforeLock, 17n, [23n, 29n, 31n], new Uint8Array(32).fill(33), keys[0]);
  return { initial, first, afterFirst, beforeLock, lock };
}

function changeScalar(encoded: string): string {
  return encodeScalar(modScalar(decodeScalar(encoded) + 1n));
}

describe('bounded success-only deck pass proof memo', () => {
  test('a warm shuffle/lock pass still returns detached validated state', () => {
    const data = fixture();
    const expectedShuffle = checked(applyDeckPass(data.initial, data.first));
    const returnedShuffle = checked(applyDeckPass(data.initial, data.first));
    returnedShuffle.points[0] = 'corrupted by caller';
    expect(checked(applyDeckPass(data.initial, data.first))).toEqual(expectedShuffle);

    const expectedLock = checked(applyDeckPass(data.beforeLock, data.lock));
    const returnedLock = checked(applyDeckPass(data.beforeLock, data.lock));
    returnedLock.lockKeys[0]?.splice(0, 1, 'corrupted by caller');
    expect(checked(applyDeckPass(data.beforeLock, data.lock))).toEqual(expectedLock);
  });

  test('resigned changed proof bytes cannot borrow a cached successful shuffle or lock proof', () => {
    const data = fixture();
    checked(applyDeckPass(data.initial, data.first));
    const firstBody = data.first.body;
    if (firstBody.phase !== 'shuffle') throw new Error('Expected shuffle pass');
    const changedShuffleBody: typeof firstBody = {
      ...firstBody,
      proof: {
        ...firstBody.proof,
        responses: firstBody.proof.responses.map((response, index) =>
          index === 0 ? { ...response, scalar: changeScalar(response.scalar) } : response,
        ),
      },
    };
    const changedShuffle: SignedDeckPass = {
      body: changedShuffleBody,
      sig: signObject('deck-pass', changedShuffleBody, keys[0]),
    };
    expect(applyDeckPass(data.initial, changedShuffle)).toMatchObject({
      ok: false,
      error: { code: 'deck-shuffle-proof' },
    });

    checked(applyDeckPass(data.beforeLock, data.lock));
    const lockBody = data.lock.body;
    if (lockBody.phase !== 'lock') throw new Error('Expected lock pass');
    const changedLockBody: typeof lockBody = {
      ...lockBody,
      proofs: lockBody.proofs.map((proof, index) =>
        index === 0 ? { ...proof, response: changeScalar(proof.response) } : proof,
      ),
    };
    const changedLock: SignedDeckPass = {
      body: changedLockBody,
      sig: signObject('deck-pass', changedLockBody, keys[0]),
    };
    expect(applyDeckPass(data.beforeLock, changedLock)).toMatchObject({
      ok: false,
      error: { code: 'deck-lock-proof' },
    });
  });

  test('the same actor at a divergent validated predecessor cannot use a warmed result', () => {
    const data = fixture();
    checked(
      applyDeckPass(
        data.afterFirst,
        signDeckShuffle(data.afterFirst, 19n, [2, 0, 1], new Uint8Array(32).fill(32), keys[1]),
      ),
    );
    const alternate = signDeckShuffle(
      data.initial,
      17n,
      [2, 1, 0],
      new Uint8Array(32).fill(31),
      keys[0],
    );
    const otherParent: DeckSetupState = checked(applyDeckPass(data.initial, alternate));
    const secondForOriginal = signDeckShuffle(
      data.afterFirst,
      19n,
      [2, 0, 1],
      new Uint8Array(32).fill(32),
      keys[1],
    );
    expect(applyDeckPass(otherParent, secondForOriginal)).toMatchObject({
      ok: false,
      error: { code: 'deck-operation' },
    });
  });
});

import { toBase64Url } from '@cp2p/codec';
import { identityFromSecret, signObject } from '@cp2p/crypto';
import { expect, test } from 'vitest';
import { applyDeckPass, initDeckSetup, signDeckShuffle } from './deck-setup.js';
import type { DeckSetupState } from './deck-setup.js';

const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);

function setup(): { state: DeckSetupState; keys: Uint8Array[] } {
  const keys = [bytes(1), bytes(2), bytes(3)];
  const identities = keys.map(identityFromSecret);
  const initial = initDeckSetup({
    ceremonyId: toBase64Url(bytes(12)),
    deckId: 'dev',
    deckEpoch: 0,
    creation: { kind: 'ceremony' },
    cards: [
      { identity: 'knight#1', card: 'knight' },
      { identity: 'monopoly#1', card: 'monopoly' },
      { identity: 'victoryPoint#1', card: 'victoryPoint' },
    ],
    participants: identities.map((identity, seat) => ({ seat, publicKey: identity.peerId })),
  });
  if (!initial.ok) throw new Error(initial.error.message);
  return { state: initial.value, keys };
}

/**
 * The ceremony and genesis consent check deck passes structurally (a user-approved speed
 * trade-off); certified in-game deck-pass entries verify the proofs before any deal. This
 * pins the boundary: a correctly signed pass with a wrong proof passes only the structural check.
 */
test('a signed pass with a wrong proof passes the structural check but not the full check', () => {
  const { state, keys } = setup();
  const key = keys[0];
  if (!key) throw new Error('missing key');
  const honest = signDeckShuffle(state, 5n, [2, 0, 1], bytes(31), key);
  const other = signDeckShuffle(state, 7n, [1, 2, 0], bytes(32), key);
  expect(applyDeckPass(state, honest).ok).toBe(true);
  // The seat signs its own output together with a proof made for a different shuffle.
  if (honest.body.phase !== 'shuffle' || other.body.phase !== 'shuffle')
    throw new Error('expected shuffle passes');
  const body = { ...honest.body, proof: other.body.proof };
  const forged: unknown = { body, sig: signObject('deck-pass', body, key) };
  expect(applyDeckPass(state, forged, { proofs: 'structural' }).ok).toBe(true);
  expect(applyDeckPass(state, forged)).toMatchObject({
    ok: false,
    error: { code: 'deck-shuffle-proof' },
  });
  // Structural checks still bind the actor: another seat's signature is refused.
  const wrongSigner = { body, sig: signObject('deck-pass', body, keys[1] ?? key) };
  expect(applyDeckPass(state, wrongSigner, { proofs: 'structural' })).toMatchObject({
    ok: false,
    error: { code: 'deck-signature' },
  });
});

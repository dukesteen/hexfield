import { toBase64Url } from '@cp2p/codec';
import { identityFromSecret, scalarToBytes } from '@cp2p/crypto';
import { describe, expect, test } from 'vitest';
import { createDeckSecretSource } from './deck-source.js';
import type { DeckDefinition } from './deck-setup.js';

const master = scalarToBytes(31n);
const ceremonyId = toBase64Url(new Uint8Array(32).fill(7));
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
  participants: [
    { seat: 0, publicKey: identityFromSecret(new Uint8Array(32).fill(1)).peerId },
    { seat: 1, publicKey: identityFromSecret(new Uint8Array(32).fill(2)).peerId },
  ],
};

describe('deterministic deck secret source', () => {
  test('reproduces shuffle, permutation, locks and proof seeds after recreation', () => {
    const first = createDeckSecretSource(master, definition, 0);
    const expected = {
      shuffle: first.shuffle(),
      permutation: first.permutation(),
      locks: [0, 1, 2].map((position) => first.lock(position)),
      proofSeed: first.proofSeed('shuffle', { operationId: 'a' }),
    };
    first.dispose();
    const restored = createDeckSecretSource(master, definition, 0);
    expect(restored.shuffle()).toBe(expected.shuffle);
    expect(restored.permutation()).toEqual(expected.permutation);
    expect([0, 1, 2].map((position) => restored.lock(position))).toEqual(expected.locks);
    expect(restored.proofSeed('shuffle', { operationId: 'a' })).toEqual(expected.proofSeed);
    expect(new Set(expected.permutation)).toEqual(new Set([0, 1, 2]));
    restored.dispose();
  });

  test('separates seats, epochs, deck manifests, positions and proof roles', () => {
    const baseline = createDeckSecretSource(master, definition, 0);
    const otherSeat = createDeckSecretSource(master, definition, 1);
    const otherEpoch = createDeckSecretSource(master, { ...definition, deckEpoch: 1 }, 0);
    const otherManifest = createDeckSecretSource(
      master,
      { ...definition, cards: [{ identity: 'other#1', card: 'knight' }] },
      0,
    );
    expect(otherSeat.shuffle()).not.toBe(baseline.shuffle());
    expect(otherEpoch.shuffle()).not.toBe(baseline.shuffle());
    expect(otherManifest.shuffle()).not.toBe(baseline.shuffle());
    expect(baseline.lock(0)).not.toBe(baseline.lock(1));
    expect(baseline.proofSeed('shuffle', 1)).not.toEqual(baseline.proofSeed('lock', 1));
    expect(baseline.proofSeed('shuffle', 1)).not.toEqual(baseline.proofSeed('shuffle', 2));
    for (const provider of [baseline, otherSeat, otherEpoch, otherManifest]) provider.dispose();
  });

  test('copies master and definition, returns owned seed bytes, and rejects disposed use', () => {
    const callerMaster = master.slice();
    const callerDefinition = structuredClone(definition);
    const provider = createDeckSecretSource(callerMaster, callerDefinition, 0);
    const expected = createDeckSecretSource(master, definition, 0);
    callerMaster.fill(0);
    callerDefinition.cards[0] = { identity: 'changed', card: 'changed' };
    provider.proofSeed('shuffle', null).fill(0);
    expect(provider.shuffle()).toBe(expected.shuffle());
    expect(provider.proofSeed('shuffle', null)).toEqual(expected.proofSeed('shuffle', null));
    provider.dispose();
    expected.dispose();
    expect(() => provider.shuffle()).toThrow(/disposed/);
    expect(() => provider.permutation()).toThrow(/disposed/);
    expect(() => provider.lock(0)).toThrow(/disposed/);
    expect(() => provider.proofSeed('shuffle', null)).toThrow(/disposed/);
  });

  test('rejects bad secrets, seats, positions, roles and noncanonical proof contexts', () => {
    expect(() => createDeckSecretSource(new Uint8Array(31), definition, 0)).toThrow(/master/);
    expect(() => createDeckSecretSource(new Uint8Array(32), definition, 0)).toThrow(/zero/);
    expect(() => createDeckSecretSource(new Uint8Array(32).fill(255), definition, 0)).toThrow(
      /noncanonical/,
    );
    expect(() => Reflect.apply(createDeckSecretSource, undefined, [master, definition, 5])).toThrow(
      /seat/,
    );
    const provider = createDeckSecretSource(master, definition, 0);
    for (const position of [-1, 3, 1.5]) expect(() => provider.lock(position)).toThrow(/position/);
    expect(() => provider.proofSeed('BAD ROLE', null)).toThrow(/role/);
    expect(() => provider.proofSeed('shuffle', { missing: undefined })).toThrow(/undefined/);
    provider.dispose();
  });
});

import { toBase64Url } from '@cp2p/codec';
import { scalarToBytes } from '@cp2p/crypto';
import { describe, expect, test } from 'vitest';
import { createHandSecretSource } from './hand-source.js';

const master = scalarToBytes(31n);
const digest = toBase64Url(new Uint8Array(32).fill(7));
const context = {
  epoch: 2,
  parent: { seq: 14, hash: 'ab'.repeat(32) },
  seat: 3,
  nonce: 8,
  input: { kind: 'command', command: { type: 'BUILD_ROAD' } },
  effect: { resource: 'brick', count: 1 },
  commitment: 'cd'.repeat(32),
};

describe('deterministic hand proof source', () => {
  test('reconstructs deterministic proof seeds and separates statements, seats, and games', () => {
    const first = createHandSecretSource(master, digest, 0);
    const expected = first.proofSeed(context);
    first.dispose();
    const restored = createHandSecretSource(master, digest, 0);
    expect(restored.proofSeed(context)).toEqual(expected);
    expect(restored.proofSeed({ ...context, nonce: 9 })).not.toEqual(expected);
    const otherSeat = createHandSecretSource(master, digest, 1);
    const otherGame = createHandSecretSource(master, toBase64Url(new Uint8Array(32).fill(8)), 0);
    expect(otherSeat.proofSeed(context)).not.toEqual(expected);
    expect(otherGame.proofSeed(context)).not.toEqual(expected);
    restored.dispose();
    otherSeat.dispose();
    otherGame.dispose();
  });

  test('copies and zeroizes its retained master, returns fresh seeds, and rejects disposed use', () => {
    const callerMaster = master.slice();
    const source = createHandSecretSource(callerMaster, digest, 2);
    const expected = createHandSecretSource(master, digest, 2);
    expect(callerMaster).toEqual(master);
    callerMaster.fill(0);
    const returned = source.proofSeed(context);
    returned.fill(0);
    expect(source.proofSeed(context)).toEqual(expected.proofSeed(context));
    source.dispose();
    source.dispose();
    expected.dispose();
    expect(() => source.proofSeed(context)).toThrow(/disposed/);
  });

  test('rejects malformed masters, noncanonical digests, invalid seats and contexts', () => {
    expect(() => createHandSecretSource(new Uint8Array(31), digest, 0)).toThrow(/master/);
    expect(() => createHandSecretSource(new Uint8Array(32), digest, 0)).toThrow(/master/);
    expect(() => createHandSecretSource(new Uint8Array(32).fill(255), digest, 0)).toThrow(/master/);
    expect(() => createHandSecretSource(master, 'not-a-digest', 0)).toThrow(/genesis digest/);
    expect(() => createHandSecretSource(master, `${digest.slice(0, -1)}!`, 0)).toThrow(
      /genesis digest/,
    );
    for (const seat of [-1, 6, 1.5]) {
      expect(() =>
        Reflect.apply(createHandSecretSource, undefined, [master, digest, seat]),
      ).toThrow(/seat/);
    }
    const source = createHandSecretSource(master, digest, 0);
    expect(() => source.proofSeed({ missing: undefined })).toThrow(/undefined/);
    source.dispose();
  });
});

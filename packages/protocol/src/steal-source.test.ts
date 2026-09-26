import { toBase64Url } from '@cp2p/codec';
import { identityFromSecret, scalarToBytes } from '@cp2p/crypto';
import { describe, expect, test } from 'vitest';
import { createStealSecretSource } from './steal-source.js';

const master = scalarToBytes(17n);
const nonce = toBase64Url(new Uint8Array(32).fill(91));
const otherNonce = toBase64Url(new Uint8Array(32).fill(92));
const publicKey = identityFromSecret(new Uint8Array(32).fill(7)).peerId;
const otherPublicKey = identityFromSecret(new Uint8Array(32).fill(8)).peerId;

describe('steal secret source', () => {
  test('reconstructs the same encryption key and proof seeds regardless of call order', () => {
    const first = createStealSecretSource(master, nonce, 0, publicKey);
    const key = first.encryptionSecret();
    const transfer = first.proofSeed('transfer', { operation: 'a', index: 2 });
    const dispute = first.proofSeed('dispute', { operation: 'a', index: 2 });
    expect(first.encryptionSecret()).toBe(key);
    first.dispose();

    const second = createStealSecretSource(master, nonce, 0, publicKey);
    expect(second.proofSeed('dispute', { operation: 'a', index: 2 })).toEqual(dispute);
    expect(second.encryptionSecret()).toBe(key);
    expect(second.proofSeed('transfer', { operation: 'a', index: 2 })).toEqual(transfer);
    expect(transfer).not.toEqual(dispute);
    second.dispose();
  });

  test('separates role, statement, nonce, seat, and signing identity', () => {
    const source = createStealSecretSource(master, nonce, 0, publicKey);
    const baseline = source.proofSeed('transfer', { operation: 'a' });
    expect(source.proofSeed('transfer', { operation: 'b' })).not.toEqual(baseline);
    expect(source.proofSeed('dispute', { operation: 'a' })).not.toEqual(baseline);
    for (const [candidateNonce, seat, key] of [
      [otherNonce, 0, publicKey],
      [nonce, 1, publicKey],
      [nonce, 0, otherPublicKey],
    ] as const) {
      const other = createStealSecretSource(master, candidateNonce, seat, key);
      expect(other.encryptionSecret()).not.toBe(source.encryptionSecret());
      expect(other.proofSeed('transfer', { operation: 'a' })).not.toEqual(baseline);
      other.dispose();
    }
    source.dispose();
  });

  test('copies caller master and rejects use after disposal', () => {
    const caller = master.slice();
    const source = createStealSecretSource(caller, nonce, 0, publicKey);
    const key = source.encryptionSecret();
    caller.fill(0);
    expect(source.encryptionSecret()).toBe(key);
    source.dispose();
    source.dispose();
    expect(() => source.encryptionSecret()).toThrow('disposed');
    expect(() => source.proofSeed('transfer', {})).toThrow('disposed');
  });

  test('rejects malformed master, nonce, roster seat, key, and role', () => {
    expect(() => createStealSecretSource(new Uint8Array(31), nonce, 0, publicKey)).toThrow(
      'canonical nonzero',
    );
    expect(() => createStealSecretSource(new Uint8Array(32), nonce, 0, publicKey)).toThrow(
      'canonical nonzero',
    );
    expect(() =>
      createStealSecretSource(new Uint8Array(32).fill(255), nonce, 0, publicKey),
    ).toThrow('canonical nonzero');
    expect(() =>
      createStealSecretSource(master, toBase64Url(new Uint8Array(31)), 0, publicKey),
    ).toThrow('canonical 32-byte');
    expect(() => createStealSecretSource(master, `${nonce}=`, 0, publicKey)).toThrow(
      'canonical 32-byte',
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- exercise an untyped caller's invalid seat.
    expect(() => createStealSecretSource(master, nonce, -1 as 0, publicKey)).toThrow('0 through 5');
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- exercise an untyped caller's invalid seat.
    expect(() => createStealSecretSource(master, nonce, 6 as 0, publicKey)).toThrow('0 through 5');
    expect(() => createStealSecretSource(master, nonce, 0, 'invalid')).toThrow('signing peer ID');
    const source = createStealSecretSource(master, nonce, 0, publicKey);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- exercise the runtime boundary against an untyped caller.
    expect(() => source.proofSeed('other' as 'transfer', {})).toThrow('Unknown steal proof role');
    source.dispose();
  });
});

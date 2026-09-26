import * as crypto from '@cp2p/crypto';
import { pedersenCommit, proveHiddenTransfer } from '@cp2p/crypto';
import type { HiddenTransferStatement } from '@cp2p/crypto';
import { expect, test, vi } from 'vitest';
import { verifyStealTransfer } from './steal-proof-cache.js';

test('memoizes exact valid transfer proofs, without accepting changed statements, proofs or contexts', () => {
  const statement: HiddenTransferStatement = {
    commitments: [pedersenCommit(1n, 4n)],
    transfer: [pedersenCommit(1n, 7n)],
    handSize: 1,
    index: 0,
    payloadHash: '9'.repeat(64),
  };
  const context = { protocol: 'steal-cache-test', operation: 'original' };
  const proof = proveHiddenTransfer(
    statement,
    { counts: [1], blindings: [4n], transferBlindings: [7n] },
    new Uint8Array(32).fill(98),
    context,
  );
  const verifier = vi.spyOn(crypto, 'verifyHiddenTransfer');
  try {
    expect(verifyStealTransfer(statement, proof, context)).toBe(true);
    expect(verifyStealTransfer({ ...statement }, structuredClone(proof), { ...context })).toBe(
      true,
    );
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(verifyStealTransfer({ ...statement, payloadHash: '8'.repeat(64) }, proof, context)).toBe(
      false,
    );
    expect(verifyStealTransfer(statement, proof, { ...context, operation: 'changed' })).toBe(false);
    const malformed = { ...proof, extra: true };
    expect(verifyStealTransfer(statement, malformed, context)).toBe(false);
    expect(verifyStealTransfer(statement, malformed, context)).toBe(false);
    expect(verifier).toHaveBeenCalledTimes(5);
    expect(verifyStealTransfer(statement, proof, context)).toBe(true);
    expect(verifier).toHaveBeenCalledTimes(5);

    // Even a warmed cache must reject accessors before reading or hashing them.
    const getter = vi.fn<() => typeof proof.bits>(() => proof.bits);
    const accessorProof = Object.defineProperty({ ...proof }, 'bits', {
      enumerable: true,
      get: getter,
    });
    expect(verifyStealTransfer(statement, accessorProof, context)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(verifier).toHaveBeenCalledTimes(5);
  } finally {
    verifier.mockRestore();
  }
});

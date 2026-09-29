import { pedersenCommit } from '@cp2p/crypto';
import { describe, expect, test } from 'vitest';
import type { DeckRevealContext } from './deck-draw.js';
import {
  coversDebit,
  proveDebitPreproof,
  prunePreproofs,
  verifyDebitPreproof,
} from './preproof.js';
import type { PreproofNeed } from './preproof.js';

const SEED = new Uint8Array(32).fill(4);
const ACTION: DeckRevealContext = {
  genesisDigest: 'a'.repeat(43),
  epoch: 0,
  anchor: { seq: 7, hash: 'b'.repeat(64) },
  seat: 1,
  nonce: 3,
  command: { type: 'HARBOR_OFFER', to: 2, resource: 'ore' },
};
const NEED: PreproofNeed = { seat: 1, resource: 'ore', count: 1 };
const BLINDING = 987654321n;

describe('debit pre-proofs', () => {
  test('prove that a committed hand holds the offered card, and nothing else', () => {
    const commitment = pedersenCommit(2n, BLINDING);
    const proof = proveDebitPreproof(NEED, commitment, 2, BLINDING, SEED, ACTION);
    const checked = verifyDebitPreproof(NEED, commitment, proof, ACTION);
    expect(checked).toMatchObject({ ok: true, value: { ...NEED, commitment } });
    // The same proof does not vouch for another commitment, count, seat or action.
    expect(verifyDebitPreproof(NEED, pedersenCommit(2n, BLINDING + 1n), proof, ACTION).ok).toBe(
      false,
    );
    expect(verifyDebitPreproof({ ...NEED, count: 2 }, commitment, proof, ACTION).ok).toBe(false);
    expect(verifyDebitPreproof({ ...NEED, seat: 2 }, commitment, proof, ACTION).ok).toBe(false);
    expect(verifyDebitPreproof(NEED, commitment, proof, { ...ACTION, nonce: 4 }).ok).toBe(false);
    expect(verifyDebitPreproof(NEED, commitment, { kind: 'debit-preproof' }, ACTION).ok).toBe(
      false,
    );
  });

  test('a seat that does not hold the card cannot make the proof', () => {
    const commitment = pedersenCommit(0n, BLINDING);
    expect(() => proveDebitPreproof(NEED, commitment, 0, BLINDING, SEED, ACTION)).toThrow(/hold/);
    // Claiming a hand that is larger than the commitment hides yields no valid proof either.
    const forged = proveDebitPreproof(
      NEED,
      pedersenCommit(1n, BLINDING),
      1,
      BLINDING,
      SEED,
      ACTION,
    );
    expect(verifyDebitPreproof(NEED, commitment, forged, ACTION).ok).toBe(false);
  });

  test('a proof lasts while its commitment does and covers debits up to its count', () => {
    const commitment = pedersenCommit(2n, BLINDING);
    const stored = [{ ...NEED, commitment }];
    expect(coversDebit(stored, 1, 'ore', 1, commitment)).toBe(true);
    expect(coversDebit(stored, 1, 'ore', 2, commitment)).toBe(false);
    expect(coversDebit(stored, 0, 'ore', 1, commitment)).toBe(false);
    expect(coversDebit(stored, 1, 'grain', 1, commitment)).toBe(false);
    expect(coversDebit(stored, 1, 'ore', 1, pedersenCommit(2n, BLINDING + 1n))).toBe(false);
    const zero = pedersenCommit(0n, 0n);
    const row = (seat: 0 | 1, ore: string) => ({
      seat,
      commitments: { brick: zero, lumber: zero, wool: zero, grain: zero, ore },
    });
    const hands = [row(0, zero), row(1, commitment)];
    expect(prunePreproofs(hands, stored)).toEqual(stored);
    const changed = [row(0, zero), row(1, pedersenCommit(1n, 5n))];
    expect(prunePreproofs(changed, stored)).toEqual([]);
    expect(prunePreproofs(hands, undefined)).toEqual([]);
  });
});

import { describe, expect, test } from 'vitest';
import { hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { quorumSize, signVote, validateVote, verifyCertificate } from './votes.js';
import type { ExpectedVote, VoteBody, VoteContext } from './votes.js';

const identities = [
  identityFromSecret(new Uint8Array(32).fill(11)),
  identityFromSecret(new Uint8Array(32).fill(12)),
  identityFromSecret(new Uint8Array(32).fill(13)),
  identityFromSecret(new Uint8Array(32).fill(14)),
] as const;
const genesisDigest = toBase64Url(hashValue({ game: 'vote-fixture' }));
const valueHash = toHex(hashValue({ seq: 1, input: 'BUILD_ROAD' }));
const expected: ExpectedVote = { seq: 1, term: 1, phase: 'precommit', valueHash };
const fourVoters: VoteContext['voters'] = [
  { seat: 0, publicKey: identities[0].peerId },
  { seat: 1, publicKey: identities[1].peerId },
  { seat: 2, publicKey: identities[2].peerId },
  { seat: 3, publicKey: identities[3].peerId },
];
const context: VoteContext = { genesisDigest, epoch: 0, voters: fourVoters };

function signed(seat: 0 | 1 | 2 | 3, overrides: Partial<VoteBody> = {}) {
  return signVote(
    { genesisDigest, epoch: 0, seat, ...expected, ...overrides },
    identities[seat].secretKey,
  );
}

describe('signed BFT votes and certificates', () => {
  test('uses the bounded BFT quorum for one through six voters', () => {
    expect([1, 2, 3, 4, 5, 6].map(quorumSize)).toEqual([1, 2, 3, 3, 4, 4]);
    for (const invalid of [0, 7, -1, 2.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => quorumSize(invalid)).toThrow(RangeError);
    }
  });

  test('requires all three votes in a three-voter game but three of four in a four-voter game', () => {
    const three: VoteContext = { ...context, voters: fourVoters.slice(0, 3) };
    const votes = [signed(0), signed(1), signed(2)];
    expect(verifyCertificate(votes.slice(0, 2), three, expected).ok).toBe(false);
    expect(verifyCertificate(votes, three, expected).ok).toBe(true);
    expect(verifyCertificate(votes, context, expected).ok).toBe(true);
    const one: VoteContext = { ...context, voters: fourVoters.slice(0, 1) };
    expect(verifyCertificate([signed(0)], one, expected).ok).toBe(true);
  });

  test('rejects duplicate, out-of-order, nonmember and forged votes', () => {
    expect(verifyCertificate([signed(0), signed(0), signed(2)], context, expected).ok).toBe(false);
    expect(verifyCertificate([signed(1), signed(0), signed(2)], context, expected).ok).toBe(false);
    expect(validateVote(signed(3), { ...context, voters: fourVoters.slice(0, 3) }).ok).toBe(false);
    const forged = { ...signed(1), sig: signed(0).sig };
    expect(validateVote(forged, context).ok).toBe(false);
    expect(verifyCertificate([signed(0), forged, signed(2)], context, expected).ok).toBe(false);
    expect(
      validateVote(signed(0), {
        ...context,
        voters: [fourVoters[1], fourVoters[0], ...fourVoters.slice(2)] as VoteContext['voters'],
      }).ok,
    ).toBe(false);
    expect(
      validateVote(signed(0), {
        ...context,
        voters: [
          { seat: 0, publicKey: identities[0].peerId },
          { seat: 1, publicKey: identities[0].peerId },
        ],
      }).ok,
    ).toBe(false);
  });

  test('rejects cross-genesis, cross-epoch, height, round, phase and value replays', () => {
    const votes = [signed(0), signed(1), signed(2)];
    expect(
      validateVote(votes[0], {
        ...context,
        genesisDigest: toBase64Url(hashValue({ game: 'other' })),
      }).ok,
    ).toBe(false);
    expect(validateVote(votes[0], { ...context, epoch: 1 }).ok).toBe(false);
    for (const mismatch of [
      { seq: 2 },
      { term: 2 },
      { phase: 'prevote' as const },
      { valueHash: null },
    ]) {
      expect(verifyCertificate(votes, context, { ...expected, ...mismatch }).ok).toBe(false);
    }
    expect(
      verifyCertificate([signed(0), signed(1, { term: 2 }), signed(2)], context, expected).ok,
    ).toBe(false);
  });

  test('accepts nil prevotes, but rejects malformed signed envelopes and memberships', () => {
    const nil: ExpectedVote = { seq: 4, term: 3, phase: 'prevote', valueHash: null };
    const votes = [signed(0, nil), signed(1, nil), signed(2, nil)];
    expect(verifyCertificate(votes, context, nil).ok).toBe(true);
    expect(validateVote({ ...votes[0], extra: true }, context).ok).toBe(false);
    expect(
      validateVote({ ...votes[0], body: { ...votes[0]?.body, extra: true } }, context).ok,
    ).toBe(false);
    expect(validateVote({ ...votes[0], body: { ...votes[0]?.body, seq: 0 } }, context).ok).toBe(
      false,
    );
    expect(verifyCertificate([...votes, ...votes, signed(3, nil)], context, nil).ok).toBe(false);
    expect(
      validateVote(votes[0], {
        ...context,
        voters: [{ seat: 0, publicKey: 'A'.repeat(43) }],
      }).ok,
    ).toBe(false);
  });
});

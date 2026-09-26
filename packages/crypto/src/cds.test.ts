import { canonicalEncode, sha256 } from '@cp2p/codec';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { describe, expect, test } from 'vitest';
import { proveCdsOr, verifyCdsOr } from './cds.js';
import type { CdsOrProof, CdsOrStatement } from './cds.js';
import {
  G,
  H,
  decodePoint,
  decodeScalar,
  encodePoint,
  encodeScalar,
  modScalar,
  scalePoint,
} from './group.js';
import {
  inspectRangeProof,
  pedersenCommit,
  prepareRangeProof,
  simulateRangeProof,
} from './range.js';
import { inspectSchnorrProof, prepareSchnorrProof, simulateSchnorrProof } from './sigma.js';

const SEED = new Uint8Array(32).fill(37);
const CONTEXT = { game: 'cds-test', parent: 'c'.repeat(64), operation: 11 };

function claim(): CdsOrStatement {
  return {
    branches: [
      {
        opening: { base: encodePoint(H), publicPoint: encodePoint(scalePoint(H, 19n).subtract(G)) },
        ranges: [{ commitment: pedersenCommit(4n, 7n), bits: 2 }],
      },
      {
        opening: { base: encodePoint(H), publicPoint: encodePoint(scalePoint(H, 23n)) },
        ranges: [{ commitment: pedersenCommit(2n, 17n), bits: 2 }],
      },
    ],
  };
}

const WITNESS = { secret: 23n, ranges: [{ value: 2n, blinding: 17n }] };

/** Build the outer CDS transcript directly, without the OR prover or challenge helper. */
function independentProof(statement: CdsOrStatement, separateRangeChallenge?: bigint): CdsOrProof {
  const [falseBranch, honestBranch] = statement.branches;
  const falseRange = falseBranch?.ranges[0];
  const honestRange = honestBranch?.ranges[0];
  if (!falseBranch || !honestBranch || !falseRange || !honestRange)
    throw new Error('Missing fixture');
  const falseChallenge = 13n;
  const falseResponse = 29n;
  const falseOpening = {
    commitment: encodePoint(
      scalePoint(H, falseResponse).subtract(
        scalePoint(decodePoint(falseBranch.opening.publicPoint), falseChallenge),
      ),
    ),
    response: encodeScalar(falseResponse),
  };
  const simulated = simulateRangeProof(falseRange, falseChallenge, SEED, { fixture: 'false' });
  const inspected = inspectRangeProof(falseRange, simulated);
  const realRange = (() => {
    if (separateRangeChallenge === undefined)
      return prepareRangeProof(honestRange, 2n, 17n, SEED, { fixture: 'honest' });
    const proof = simulateRangeProof(honestRange, separateRangeChallenge, SEED, {
      fixture: 'forged',
    });
    return { ...inspectRangeProof(honestRange, proof), respond: () => proof };
  })();
  const honestNonce = 31n;
  const honestOpening = encodePoint(scalePoint(H, honestNonce));
  const firstMessages = [
    {
      opening: falseOpening.commitment,
      ranges: [{ commitments: inspected.commitments, announcements: inspected.announcements }],
    },
    {
      opening: honestOpening,
      ranges: [{ commitments: realRange.commitments, announcements: realRange.announcements }],
    },
  ];
  const globalChallenge = modScalar(
    bytesToNumberLE(
      sha256(canonicalEncode(['cp2p/v1/fiat-shamir', 'cds-or', CONTEXT, statement, firstMessages])),
    ),
  );
  const honestChallenge = modScalar(globalChallenge - falseChallenge);
  return {
    branches: [
      { challenge: encodeScalar(falseChallenge), opening: falseOpening, ranges: [simulated] },
      {
        challenge: encodeScalar(honestChallenge),
        opening: {
          commitment: honestOpening,
          response: encodeScalar(modScalar(honestNonce + honestChallenge * 23n)),
        },
        ranges: [realRange.respond(honestChallenge)],
      },
    ],
  };
}

describe('CDS OR composition', () => {
  test('rejects a false range at its own challenge even when every equation and outer hash match', () => {
    const original = claim();
    const statement = {
      branches: original.branches.map((branch, index) =>
        index === 1
          ? {
              ...branch,
              ranges: [{ commitment: pedersenCommit(5n, 17n), bits: 2 }],
            }
          : branch,
      ),
    };
    const proof = independentProof(statement, 7n);
    const branch = statement.branches[1];
    const forged = proof.branches[1];
    const range = branch?.ranges[0];
    if (!branch || !forged || !range) throw new Error('Missing fixture');
    const challenge = decodeScalar(forged.challenge);
    expect(inspectRangeProof(range, forged.ranges[0]).challenge).toBe(7n);
    expect(challenge).not.toBe(7n);
    expect(inspectSchnorrProof(branch.opening, forged.opening, challenge)).toBe(
      forged.opening.commitment,
    );
    expect(verifyCdsOr(statement, proof, CONTEXT)).toBe(false);
  });

  test('separates CDS entropy from a direct Sigma call with its exact component context', () => {
    const statement = claim();
    const branch = statement.branches[1];
    if (!branch) throw new Error('Missing fixture');
    const proof = proveCdsOr(statement, 1, WITNESS, SEED, CONTEXT);
    const direct = prepareSchnorrProof(branch.opening, WITNESS.secret, SEED, {
      context: CONTEXT,
      statement,
      branch: 1,
      component: 'opening',
    });
    expect(direct.commitment).not.toBe(proof.branches[1]?.opening.commitment);
  });

  test('accepts an independent shared-challenge transcript with a false range branch', () => {
    const statement = claim();
    expect(verifyCdsOr(statement, independentProof(statement), CONTEXT)).toBe(true);
    const proof = proveCdsOr(statement, 1, WITNESS, SEED, CONTEXT);
    expect(verifyCdsOr(statement, proof, CONTEXT)).toBe(true);
    expect(proveCdsOr(statement, 1, WITNESS, SEED, CONTEXT)).toEqual(proof);
    expect(() =>
      proveCdsOr(
        statement,
        0,
        { secret: 19n, ranges: [{ value: 4n, blinding: 7n }] },
        SEED,
        CONTEXT,
      ),
    ).toThrow(/witness/);
  });

  test('proves an opening AND two six-bit ranges in the selected resource interval', () => {
    const counts = [2, 4, 1];
    const index = 3;
    let prefix = 0;
    const statement: CdsOrStatement = {
      branches: counts.map((count, branch) => {
        const low = modScalar(BigInt(index - prefix));
        const high = modScalar(BigInt(prefix + count - index - 1));
        prefix += count;
        const opening = pedersenCommit(branch === 1 ? 1n : 0n, 23n);
        return {
          opening: {
            base: encodePoint(H),
            publicPoint: encodePoint(decodePoint(opening).subtract(G)),
          },
          ranges: [
            { commitment: pedersenCommit(low, 17n), bits: 6 },
            { commitment: pedersenCommit(high, 19n), bits: 6 },
          ],
        };
      }),
    };
    const proof = proveCdsOr(
      statement,
      1,
      {
        secret: 23n,
        ranges: [
          { value: 1n, blinding: 17n },
          { value: 2n, blinding: 19n },
        ],
      },
      SEED,
      CONTEXT,
    );
    expect(verifyCdsOr(statement, proof, CONTEXT)).toBe(true);
  });

  test('rejects changed challenges, opening, range, branch order, statements and context', () => {
    const statement = claim();
    const proof = independentProof(statement);
    const [first, second] = proof.branches;
    const range = second?.ranges[0];
    const bit = range?.proofs[0];
    if (!first || !second || !range || !bit) throw new Error('Missing fixture');
    const changedRange = {
      ...range,
      proofs: [
        {
          ...bit,
          challenges: [
            encodeScalar(modScalar(decodeScalar(bit.challenges[0]) + 1n)),
            bit.challenges[1],
          ],
        },
        ...range.proofs.slice(1),
      ],
    };
    const invalid = [
      { branches: [second, first] },
      {
        branches: [
          first,
          { ...second, challenge: encodeScalar(modScalar(decodeScalar(second.challenge) + 1n)) },
        ],
      },
      {
        branches: [
          first,
          { ...second, opening: { ...second.opening, commitment: encodePoint(G) } },
        ],
      },
      {
        branches: [
          first,
          {
            ...second,
            opening: {
              ...second.opening,
              response: encodeScalar(modScalar(decodeScalar(second.opening.response) + 1n)),
            },
          },
        ],
      },
      { branches: [first, { ...second, ranges: [changedRange] }] },
      { branches: [first, { ...second, ranges: first.ranges }] },
      { branches: [first] },
      { branches: [first, second, second] },
      { ...proof, extra: true },
    ];
    for (const value of invalid) expect(verifyCdsOr(statement, value, CONTEXT)).toBe(false);
    expect(verifyCdsOr(statement, proof, { ...CONTEXT, operation: 12 })).toBe(false);
    expect(verifyCdsOr({ branches: statement.branches.toReversed() }, proof, CONTEXT)).toBe(false);
    expect(verifyCdsOr(statement, null, CONTEXT)).toBe(false);
    expect(verifyCdsOr({ branches: [] }, proof, CONTEXT)).toBe(false);
    const hole = [...proof.branches];
    Reflect.deleteProperty(hole, '0');
    expect(verifyCdsOr(statement, { branches: hole }, CONTEXT)).toBe(false);
  });

  test('rejects all-simulated branches and independent per-component challenges', () => {
    const statement = claim();
    const proof: CdsOrProof = {
      branches: statement.branches.map((branch, index) => {
        const challenge = BigInt(index + 5);
        return {
          challenge: encodeScalar(challenge),
          opening: simulateSchnorrProof(branch.opening, challenge, SEED, CONTEXT),
          ranges: branch.ranges.map((range) => simulateRangeProof(range, challenge, SEED, CONTEXT)),
        };
      }),
    };
    expect(verifyCdsOr(statement, proof, CONTEXT)).toBe(false);
    const honest = proveCdsOr(statement, 1, WITNESS, SEED, CONTEXT);
    const second = honest.branches[1];
    const branch = statement.branches[1];
    if (!second || !branch) throw new Error('Missing fixture');
    expect(
      verifyCdsOr(
        statement,
        {
          branches: [
            honest.branches[0],
            { ...second, opening: simulateSchnorrProof(branch.opening, 11n, SEED, CONTEXT) },
          ],
        },
        CONTEXT,
      ),
    ).toBe(false);
  });
});

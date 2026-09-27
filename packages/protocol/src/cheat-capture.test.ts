import { canonicalEncode, toBase64Url } from '@cp2p/codec';
import { signObject } from '@cp2p/crypto';
import type { Seat } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { verifyCheatProof } from './cheat-proof.js';
import { rejectedProofCandidates, rejectedWireProofCandidates } from './cheat-capture.js';
import { entryHash, genesisDigest } from './genesis.js';
import { decodeProtocolMessage } from './messages.js';
import { initialProposalContext } from './replay.js';
import { createVerifiedDeckSession } from './testing/verified-deck-session.js';
import type { RawSignedArtifact } from './cheat-types.js';
import { MAX_MESSAGE_BYTES } from './validation.js';

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing cheat-capture fixture value');
  return value;
}

const fixture = createVerifiedDeckSession(317, 2, 4);
const initial = initialProposalContext(fixture.entry, fixture.simulation.engine, fixture.policy);
if (!initial.ok)
  throw new Error(`Could not create verified capture context: ${initial.error.code}`);
const context = initial.value.log;
const digest = genesisDigest(context.genesis);

function signed(domain: string, body: unknown, seat: Seat = 0): RawSignedArtifact {
  const identity = required(fixture.simulation.identities.get(seat));
  return { body, sig: signObject(domain, body, identity.secretKey) };
}

function wire(value: unknown): Uint8Array {
  return canonicalEncode(value);
}

describe('raw rejected proof capture', () => {
  test('retains malformed command, count, and unlock proof bytes while gameplay decoding stays strict', () => {
    const commandBody = {
      seat: 0,
      command: { type: 'BUILD_ROAD' },
      evidence: { protocol: 'command-proofs-v1', data: { hands: 'malformed' } },
    };
    const command = signed('cmd', commandBody);
    const commandBytes = wire({ t: 'SUBMIT', cmd: command });
    expect(decodeProtocolMessage(commandBytes).ok).toBe(false);
    const commandClaims = rejectedProofCandidates({ t: 'SUBMIT', cmd: command }, context);
    expect(commandClaims).toHaveLength(1);
    expect(commandClaims[0]?.evidence).toMatchObject({ kind: 'command-proof', artifact: command });

    const count = signed(
      'monopoly-count',
      {
        operationId: 'a'.repeat(64),
        seat: 1,
        count: 2,
        proof: { malformed: true },
      },
      1,
    );
    const countMessage = { t: 'COUNT_CONTRIB', genesisDigest: digest, contribution: count };
    const countBytes = wire(countMessage);
    expect(decodeProtocolMessage(countBytes).ok).toBe(false);
    const countClaims = rejectedWireProofCandidates(countBytes, context);
    expect(countClaims).toHaveLength(1);
    expect(countClaims[0]?.evidence).toMatchObject({ kind: 'count-proof', artifact: count });

    const unlock = signed(
      'deck-unlock',
      {
        operationId: 'b'.repeat(64),
        step: 0,
        seat: 1,
        point: 'malformed-point',
        proof: { commitments: ['bad'], response: 'bad' },
      },
      1,
    );
    const unlockMessage = {
      t: 'DECK_CONTRIB',
      genesisDigest: digest,
      contribution: { kind: 'deck-unlock', operationId: 'b'.repeat(64), unlocks: [unlock] },
    };
    const unlockBytes = wire(unlockMessage);
    expect(decodeProtocolMessage(unlockBytes).ok).toBe(false);
    const unlockClaims = rejectedWireProofCandidates(unlockBytes, context);
    expect(unlockClaims).toHaveLength(1);
    expect(unlockClaims[0]?.evidence).toMatchObject({ kind: 'deck-unlock', artifact: unlock });
  });

  test('enforces the wire size and signed-artifact count bounds', () => {
    const oversized = wire({
      t: 'SUBMIT',
      cmd: { body: { seat: 0, value: 'x'.repeat(MAX_MESSAGE_BYTES) }, sig: 'x'.repeat(86) },
    });
    expect(oversized.byteLength).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(rejectedWireProofCandidates(oversized, context)).toEqual([]);

    const unlocks = Array.from({ length: 6 }, (_, seat) => signed('deck-unlock', { seat }));
    expect(
      rejectedProofCandidates(
        {
          t: 'DECK_CONTRIB',
          genesisDigest: digest,
          contribution: { kind: 'deck-unlock', operationId: 'c'.repeat(64), unlocks },
        },
        context,
      ),
    ).toEqual([]);

    const reveals = Array.from({ length: 7 }, (_, seat) => signed('beacon-reveal', { seat }));
    const proposal = {
      body: {
        genesisDigest: digest,
        entry: {
          seq: context.head.seq + 1,
          prevHash: entryHash(context.head),
          payload: { kind: 'crypto', action: 'beacon-fixed', evidence: reveals },
        },
      },
      sig: signed('proposal', {}).sig,
    };
    expect(rejectedProofCandidates({ t: 'PROPOSAL', proposal }, context)).toEqual([]);
  });

  test('rejects contributions from another genesis and proposals not extending this parent', () => {
    const count = signed('monopoly-count', { seat: 0 });
    expect(
      rejectedProofCandidates(
        {
          t: 'COUNT_CONTRIB',
          genesisDigest: toBase64Url(new Uint8Array(32).fill(99)),
          contribution: count,
        },
        context,
      ),
    ).toEqual([]);

    const payload = { kind: 'command', signed: signed('cmd', { seat: 0 }) };
    const proposal = (overrides: { genesisDigest?: string; prevHash?: string }) => ({
      t: 'PROPOSAL',
      proposal: {
        body: {
          genesisDigest: overrides.genesisDigest ?? digest,
          entry: {
            seq: context.head.seq + 1,
            prevHash: overrides.prevHash ?? entryHash(context.head),
            payload,
          },
        },
        sig: signed('proposal', {}).sig,
      },
    });
    expect(
      rejectedProofCandidates(
        proposal({ genesisDigest: toBase64Url(new Uint8Array(32).fill(98)) }),
        context,
      ),
    ).toEqual([]);
    expect(rejectedProofCandidates(proposal({ prevHash: 'f'.repeat(64) }), context)).toEqual([]);
    expect(rejectedProofCandidates(proposal({}), context)).toHaveLength(1);
  });

  test('keeps unlock candidates in prefix order and requires verification after capture', () => {
    const unlocks = [0, 1, 0].map((seat, index) =>
      signed('deck-unlock', { seat, step: index, proof: { malformed: index } }),
    );
    const claims = rejectedProofCandidates(
      {
        t: 'DECK_CONTRIB',
        genesisDigest: digest,
        contribution: { kind: 'deck-unlock', operationId: 'd'.repeat(64), unlocks },
      },
      context,
    );
    expect(claims).toHaveLength(3);
    for (const [index, claim] of claims.entries()) {
      expect(claim?.evidence).toMatchObject({
        kind: 'deck-unlock',
        artifact: unlocks[index],
        prefix: unlocks.slice(0, index),
        at: { seq: context.head.seq, hash: entryHash(context.head) },
      });
    }

    const commandBody = {
      gameId: context.genesis.gameId,
      genesisDigest: digest,
      seat: 0,
      nonce: 1,
      headSeq: context.head.seq,
      headHash: entryHash(context.head),
      command: { type: 'BUY_DEV_CARD' },
      evidence: { protocol: 'command-proofs-v1', data: { malformed: true } },
    };
    const forged = signed('cmd', commandBody, 1);
    const candidate = required(rejectedProofCandidates({ t: 'SUBMIT', cmd: forged }, context)[0]);
    expect(candidate.evidence.kind).toBe('command-proof');
    expect(verifyCheatProof(candidate, context)).toMatchObject({
      ok: false,
      error: { code: 'cheat-unproven' },
    });
  });
});

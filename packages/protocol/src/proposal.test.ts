import { hashValue, toBase64Url, toHex } from '@cp2p/codec';
import type { Result, SystemInput } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { entryHash, genesisDigest, signEntry } from './genesis.js';
import { stubEvidence } from './log.js';
import type { LogContext } from './log.js';
import { proposerFor, signProposal, validateCertifiedEntry, validateProposal } from './proposal.js';
import type { ProposalBody, ProposalContext } from './proposal.js';
import { fixtureAt, protocolFixture } from './testing/fixtures.js';
import type { LogEntry } from './types.js';
import { signVote } from './votes.js';
import type { SignedVote, VoteBody, VotePhase } from './votes.js';

function errorCode(result: Result<unknown>): string | undefined {
  return result.ok ? undefined : result.error.code;
}

function setup() {
  const fixture = protocolFixture();
  const log: LogContext = {
    genesis: fixture.genesis,
    engine: fixture.engine,
    head: fixture.entry,
    state: fixture.state,
    lastNonces: new Map(),
  };
  const digest = genesisDigest(fixture.genesis);
  const context: ProposalContext = {
    log,
    membership: {
      genesisDigest: digest,
      epoch: 0,
      voters: [
        { seat: 0, publicKey: fixtureAt(fixture.identities, 0).peerId },
        { seat: 1, publicKey: fixtureAt(fixture.identities, 1).peerId },
      ],
    },
    excludedProposers: [],
    policy: { allowStub: true },
  };
  const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
  const applied = fixture.engine.apply(fixture.state, input);
  if (!applied.ok) throw new Error(`Fixture input rejected: ${applied.error.code}`);
  const payload = { kind: 'system', input, evidence: stubEvidence(log, input) } as const;
  const stateHash = toHex(hashValue(applied.value.state));

  function entryFor(term: number, seat?: 0 | 1): LogEntry {
    const proposer =
      seat === undefined
        ? proposerFor(1, term, context.membership, context.excludedProposers)
        : context.membership.voters.find((voter) => voter.seat === seat);
    if (!proposer) throw new Error('Fixture proposer missing');
    const identity = fixtureAt(fixture.identities, proposer.seat);
    return signEntry(
      {
        seq: 1,
        term,
        prevHash: entryHash(log.head),
        payload,
        stateHash,
        sequencer: identity.peerId,
      },
      identity.secretKey,
    );
  }

  function votesFor(
    entry: LogEntry,
    phase: VotePhase,
    term = entry.term,
    overrides: Partial<VoteBody> = {},
  ): SignedVote[] {
    return context.membership.voters.map((voter) =>
      signVote(
        {
          genesisDigest: digest,
          epoch: 0,
          seat: voter.seat,
          seq: entry.seq,
          term,
          phase,
          valueHash: entryHash(entry),
          ...overrides,
        },
        fixtureAt(fixture.identities, voter.seat).secretKey,
      ),
    );
  }

  function proposalFor(
    entry: LogEntry,
    validRound: number | null = null,
    prevotes: SignedVote[] = [],
  ) {
    const proposer = fixture.identities.find((identity) => identity.peerId === entry.sequencer);
    if (!proposer) throw new Error('Fixture proposal signer missing');
    const body: ProposalBody = { genesisDigest: digest, epoch: 0, entry, validRound, prevotes };
    return signProposal(body, proposer.secretKey);
  }

  return { context, entryFor, proposalFor, votesFor, fixture };
}

describe('signed proposals and certified entries', () => {
  test('accepts an initial proposal and a quorum precommit certificate', () => {
    const { context, entryFor, proposalFor, votesFor } = setup();
    const entry = entryFor(1);
    const proposal = proposalFor(entry);
    const validated = validateProposal(proposal, context);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value.derived.hash).toBe(entryHash(entry));
    expect(validated.value.derived.state.turn.activeSeat).toBe(0);

    const certificate = votesFor(entry, 'precommit');
    const committed = validateCertifiedEntry({ entry, certificate }, context);
    expect(committed.ok).toBe(true);
    if (!committed.ok) throw new Error(`Certificate rejected: ${committed.error.code}`);
    expect(committed.value.hash).toBe(entryHash(entry));
    expect(committed.value.certificate).toEqual(certificate);
  });

  test('reproposes the same value in a later round with the next deterministic proposer', () => {
    const { context, entryFor, proposalFor, votesFor } = setup();
    const first = entryFor(1);
    const second = entryFor(2);
    expect(first.sequencer).not.toBe(second.sequencer);
    expect(first.sig).not.toBe(second.sig);
    expect(entryHash(first)).toBe(entryHash(second));
    expect(proposerFor(1, 1, context.membership).seat).toBe(0);
    expect(proposerFor(1, 2, context.membership).seat).toBe(1);
    expect(proposerFor(1, 1, context.membership, [0]).seat).toBe(1);

    const justified = proposalFor(second, 1, votesFor(first, 'prevote'));
    expect(validateProposal(justified, context).ok).toBe(true);
    const laterCommit = validateCertifiedEntry(
      { entry: second, certificate: votesFor(second, 'precommit') },
      context,
    );
    expect(laterCommit.ok).toBe(true);
    // An older certified round remains valid regardless of which proposal was observed last.
    expect(
      validateCertifiedEntry({ entry: first, certificate: votesFor(first, 'precommit') }, context)
        .ok,
    ).toBe(true);
  });

  test('rejects absent, same-round, future-round, or conflicting prevote justifications', () => {
    const { context, entryFor, proposalFor, votesFor } = setup();
    const first = entryFor(1);
    const second = entryFor(2);
    const prevotes = votesFor(first, 'prevote');
    expect(errorCode(validateProposal(proposalFor(first, null, prevotes), context))).toBe(
      'proposal-justification',
    );
    expect(errorCode(validateProposal(proposalFor(second, 2, prevotes), context))).toBe(
      'proposal-justification',
    );
    expect(errorCode(validateProposal(proposalFor(second, 3, prevotes), context))).toBe(
      'proposal-justification',
    );
    expect(validateProposal(proposalFor(second, 1, []), context).ok).toBe(false);
    expect(validateProposal(proposalFor(second, 1, [fixtureAt(prevotes, 0)]), context).ok).toBe(
      false,
    );
    expect(
      errorCode(
        validateProposal(
          proposalFor(second, 1, [fixtureAt(prevotes, 0), fixtureAt(prevotes, 0)]),
          context,
        ),
      ),
    ).toBe('vote-order');
    expect(
      errorCode(validateProposal(proposalFor(second, 1, votesFor(first, 'precommit')), context)),
    ).toBe('vote-conflict');
    expect(
      errorCode(
        validateProposal(
          proposalFor(second, 1, votesFor(first, 'prevote', 1, { valueHash: 'f'.repeat(64) })),
          context,
        ),
      ),
    ).toBe('vote-conflict');
  });

  test('rejects altered proposal metadata, signature, proposer, and game context', () => {
    const { context, entryFor, proposalFor, fixture } = setup();
    const entry = entryFor(1);
    const proposal = proposalFor(entry);
    expect(errorCode(validateProposal({ ...proposal, sig: 'A'.repeat(86) }, context))).toBe(
      'proposal-signature',
    );
    expect(
      errorCode(validateProposal({ ...proposal, body: { ...proposal.body, epoch: 1 } }, context)),
    ).toBe('proposal-context');
    expect(
      errorCode(
        validateProposal(
          signProposal(
            { ...proposal.body, genesisDigest: toBase64Url(new Uint8Array(32).fill(8)) },
            fixtureAt(fixture.identities, 0).secretKey,
          ),
          context,
        ),
      ),
    ).toBe('proposal-context');
    expect(validateProposal(proposalFor(entryFor(1, 1)), context).ok).toBe(false);
    expect(
      errorCode(
        validateProposal(proposal, {
          ...context,
          membership: { ...context.membership, genesisDigest: toBase64Url(new Uint8Array(32)) },
        }),
      ),
    ).toBe('proposal-context');
  });

  test('rejects commit certificates for another epoch, game, round, height, phase, or value', () => {
    const { context, entryFor, votesFor } = setup();
    const entry = entryFor(1);
    const reject = (certificate: SignedVote[]) =>
      errorCode(validateCertifiedEntry({ entry, certificate }, context));
    expect(reject(votesFor(entry, 'precommit', 1, { epoch: 1 }))).toBe('vote-context');
    expect(
      reject(
        votesFor(entry, 'precommit', 1, {
          genesisDigest: toBase64Url(new Uint8Array(32).fill(9)),
        }),
      ),
    ).toBe('vote-context');
    expect(reject(votesFor(entry, 'precommit', 2))).toBe('vote-conflict');
    expect(reject(votesFor(entry, 'precommit', 1, { seq: 2 }))).toBe('vote-conflict');
    expect(reject(votesFor(entry, 'prevote'))).toBe('vote-conflict');
    expect(reject(votesFor(entry, 'precommit', 1, { valueHash: 'f'.repeat(64) }))).toBe(
      'vote-conflict',
    );
    expect(reject([fixtureAt(votesFor(entry, 'precommit'), 0)])).toBe('invalid-envelope');
    const vote = fixtureAt(votesFor(entry, 'precommit'), 0);
    expect(reject([vote, vote])).toBe('vote-order');
  });

  test('malformed wire values fail closed without throwing', () => {
    const { context, entryFor, proposalFor, votesFor } = setup();
    const entry = entryFor(1);
    const proposal = proposalFor(entry);
    const certificate = votesFor(entry, 'precommit');
    const malformedProposals: unknown[] = [
      null,
      {},
      { ...proposal, extra: true },
      { ...proposal, body: { ...proposal.body, extra: true } },
      { ...proposal, body: { ...proposal.body, epoch: -1 } },
      { ...proposal, body: { ...proposal.body, validRound: 1.5 } },
      { ...proposal, body: { ...proposal.body, prevotes: Array(7).fill(certificate[0]) } },
      {
        ...proposal,
        body: { ...proposal.body, entry: { ...entry, seq: Number.MAX_SAFE_INTEGER + 1 } },
      },
    ];
    for (const malformed of malformedProposals) {
      expect(() => validateProposal(malformed, context)).not.toThrow();
      expect(validateProposal(malformed, context).ok).toBe(false);
    }
    const malformedCertificates: unknown[] = [
      null,
      { entry, certificate, extra: true },
      { entry: { ...entry, extra: true }, certificate },
      { entry, certificate: Array(7).fill(certificate[0]) },
      { entry, certificate: 'not votes' },
    ];
    for (const malformed of malformedCertificates) {
      expect(() => validateCertifiedEntry(malformed, context)).not.toThrow();
      expect(validateCertifiedEntry(malformed, context).ok).toBe(false);
    }
  });
});

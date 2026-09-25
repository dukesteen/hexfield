import { hashValue, toHex } from '@cp2p/codec';
import { describe, expect, test } from 'vitest';
import type { Result, SystemInput } from '@cp2p/engine';
import { validateExcludeProposerControl, validateObjectiveAccusation } from './control.js';
import { entryHash, genesisId, signEntry, signGenesis } from './genesis.js';
import { signCommand, stubEvidence } from './log.js';
import { advanceContext, proposerFor, signProposal, validateCertifiedEntry } from './proposal.js';
import { initialProposalContext, replayCertifiedPrefix } from './replay.js';
import { fixtureAt, protocolFixture } from './testing/fixtures.js';
import type { ExcludeProposerControl, LogEntry } from './types.js';
import { signVote } from './votes.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function setup() {
  const fixture = protocolFixture();
  const policy = { genesis: { allowStub: true }, entry: { allowStub: true } };
  const context = value(initialProposalContext(fixture.entry, fixture.engine, policy));
  const controlContext = {
    log: context.log,
    membership: context.membership,
    excludedProposers: context.excludedProposers,
    proposerFor: (seq: number, term: number) =>
      proposerFor(seq, term, context.membership, context.excludedProposers),
  };
  const vote = (seat: 0 | 1, valueHash: string) =>
    signVote(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: 0,
        seat,
        seq: context.log.head.seq + 1,
        term: 1,
        phase: 'prevote',
        valueHash,
      },
      fixtureAt(fixture.identities, seat).secretKey,
    );
  const signedEntry = (
    payload: LogEntry['payload'],
    term = 1,
    stateHash = toHex(hashValue(context.log.state)),
  ) => {
    const elected = proposerFor(
      context.log.head.seq + 1,
      term,
      context.membership,
      context.excludedProposers,
    );
    return signEntry(
      {
        seq: context.log.head.seq + 1,
        term,
        prevHash: entryHash(context.log.head),
        payload,
        stateHash,
        sequencer: elected.publicKey,
      },
      fixtureAt(fixture.identities, elected.seat).secretKey,
    );
  };
  const proposal = (entry: LogEntry) =>
    signProposal(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: 0,
        entry,
        validRound: null,
        prevotes: [],
      },
      fixtureAt(fixture.identities, 0).secretKey,
    );
  return { fixture, policy, context, controlContext, vote, signedEntry, proposal };
}

describe('certified proposer exclusion', () => {
  test('cannot certify exclusion of the sole human proposer', () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const body = {
      ...fixture.body,
      seats: fixture.body.seats.map((seat) =>
        seat.seat === 1
          ? { ...seat, kind: 'bot' as const, botHost: first.peerId }
          : seat.kind === 'bot'
            ? { ...seat, botHost: first.peerId }
            : seat,
      ),
    };
    const genesis = {
      ...body,
      gameId: genesisId(body),
      signatures: [signGenesis(body, 0, first.secretKey)],
    };
    const head = signEntry(
      { ...fixture.entry, payload: { kind: 'genesis', genesis } },
      first.secretKey,
    );
    const context = value(
      initialProposalContext(head, fixture.engine, {
        genesis: { allowStub: true },
        entry: { allowStub: true },
      }),
    );
    const vote = (valueHash: string) =>
      signVote(
        {
          genesisDigest: context.membership.genesisDigest,
          epoch: 0,
          seat: 0,
          seq: 1,
          term: 1,
          phase: 'prevote',
          valueHash,
        },
        first.secretKey,
      );
    const control: ExcludeProposerControl = {
      kind: 'control',
      action: 'exclude-proposer',
      offender: 0,
      evidence: {
        kind: 'vote-equivocation',
        first: vote('a'.repeat(64)),
        second: vote('b'.repeat(64)),
      },
    };
    const entry = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(head),
        payload: control,
        stateHash: head.stateHash,
        sequencer: first.peerId,
      },
      first.secretKey,
    );
    const certificate = [
      signVote(
        {
          genesisDigest: context.membership.genesisDigest,
          epoch: 0,
          seat: 0,
          seq: 1,
          term: 1,
          phase: 'precommit',
          valueHash: entryHash(entry),
        },
        first.secretKey,
      ),
    ];
    expect(validateCertifiedEntry({ entry, certificate }, context)).toMatchObject({
      ok: false,
      error: { code: 'control-fault-limit' },
    });
  });

  test('a signed vote equivocation control preserves game state and changes only next-height proposer', () => {
    const { fixture, policy, context, controlContext, vote, signedEntry } = setup();
    const evidence: ExcludeProposerControl = {
      kind: 'control',
      action: 'exclude-proposer',
      offender: 0,
      evidence: {
        kind: 'vote-equivocation',
        first: vote(0, 'a'.repeat(64)),
        second: vote(0, 'b'.repeat(64)),
      },
    };
    expect(validateExcludeProposerControl(evidence, controlContext).ok).toBe(true);
    const entry = signedEntry(evidence);
    const certificate = ([0, 1] as const).map((seat) =>
      signVote(
        {
          genesisDigest: context.membership.genesisDigest,
          epoch: 0,
          seat,
          seq: 1,
          term: 1,
          phase: 'precommit',
          valueHash: entryHash(entry),
        },
        fixtureAt(fixture.identities, seat).secretKey,
      ),
    );
    const certified = { entry, certificate };
    const validated = value(validateCertifiedEntry(certified, context));
    expect(validated.input).toBeNull();
    expect(validated.events).toEqual([]);
    expect(validated.state).toEqual(context.log.state);
    expect([...validated.lastNonces]).toEqual([]);
    const next = value(advanceContext(context, validated));
    expect(next.excludedProposers).toEqual([0]);
    expect(next.membership.voters).toEqual(context.membership.voters);
    expect(proposerFor(2, 1, next.membership, next.excludedProposers).seat).toBe(1);
    const replayed = value(
      replayCertifiedPrefix(fixture.entry, [certified], fixture.engine, policy),
    );
    expect(replayed.context.excludedProposers).toEqual([0]);
    expect(replayed.inputs).toEqual([]);
    const alteredState = signedEntry(evidence, 1, 'f'.repeat(64));
    const alteredCertificate = ([0, 1] as const).map((seat) =>
      signVote(
        {
          genesisDigest: context.membership.genesisDigest,
          epoch: 0,
          seat,
          seq: 1,
          term: 1,
          phase: 'precommit',
          valueHash: entryHash(alteredState),
        },
        fixtureAt(fixture.identities, seat).secretKey,
      ),
    );
    expect(
      validateCertifiedEntry({ entry: alteredState, certificate: alteredCertificate }, context),
    ).toMatchObject({
      ok: false,
      error: { code: 'control-state' },
    });
  });

  test('rejects forged, nonconflicting and second-offender vote evidence', () => {
    const { fixture, controlContext, vote } = setup();
    const first = vote(0, 'a'.repeat(64));
    const second = vote(0, 'b'.repeat(64));
    const control: ExcludeProposerControl = {
      kind: 'control',
      action: 'exclude-proposer',
      offender: 0,
      evidence: { kind: 'vote-equivocation', first, second },
    };
    expect(
      validateExcludeProposerControl(
        { ...control, evidence: { kind: 'vote-equivocation', first, second: first } },
        controlContext,
      ).ok,
    ).toBe(false);
    const laterVote = signVote(
      { ...second.body, seq: second.body.seq + 1 },
      fixtureAt(fixture.identities, 0).secretKey,
    );
    expect(
      validateExcludeProposerControl(
        { ...control, evidence: { kind: 'vote-equivocation', first, second: laterVote } },
        controlContext,
      ).ok,
    ).toBe(false);
    expect(
      validateExcludeProposerControl(
        {
          ...control,
          evidence: { kind: 'vote-equivocation', first, second: { ...second, sig: first.sig } },
        },
        controlContext,
      ).ok,
    ).toBe(false);
    expect(
      validateExcludeProposerControl(control, { ...controlContext, excludedProposers: [1] }).ok,
    ).toBe(false);
    expect(
      validateObjectiveAccusation(control, { ...controlContext, excludedProposers: [1] }).ok,
    ).toBe(true);
    expect(
      validateExcludeProposerControl(control, { ...controlContext, excludedProposers: [0] }).ok,
    ).toBe(false);
  });

  test('authenticates conflicting proposals and objectively invalid signed commands, not hash disagreement', () => {
    const { fixture, context, controlContext, signedEntry, proposal } = setup();
    const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
    const first = proposal(
      signedEntry({ kind: 'system', input, evidence: stubEvidence(context.log, input) }),
    );
    const second = proposal(
      signedEntry(
        { kind: 'system', input, evidence: stubEvidence(context.log, input) },
        1,
        'a'.repeat(64),
      ),
    );
    const equivocation: ExcludeProposerControl = {
      kind: 'control',
      action: 'exclude-proposer',
      offender: 0,
      evidence: { kind: 'proposal-equivocation', first, second },
    };
    expect(validateExcludeProposerControl(equivocation, controlContext).ok).toBe(true);
    const wrongSigner = fixtureAt(fixture.identities, 1);
    const forged = signProposal(second.body, wrongSigner.secretKey);
    expect(
      validateExcludeProposerControl(
        { ...equivocation, evidence: { kind: 'proposal-equivocation', first, second: forged } },
        controlContext,
      ).ok,
    ).toBe(false);

    const invalidCommand = signCommand(
      {
        gameId: fixture.genesis.gameId,
        genesisDigest: context.membership.genesisDigest,
        seat: 0,
        nonce: 1,
        headSeq: 0,
        headHash: entryHash(context.log.head),
        command: { type: 'END_TURN' },
      },
      wrongSigner.secretKey,
    );
    const accused = proposal(signedEntry({ kind: 'command', signed: invalidCommand }));
    expect(
      validateExcludeProposerControl(
        {
          kind: 'control',
          action: 'exclude-proposer',
          offender: 0,
          evidence: { kind: 'invalid-command', proposal: accused },
        },
        controlContext,
      ).ok,
    ).toBe(true);

    const delayed = signCommand(
      {
        gameId: fixture.genesis.gameId,
        genesisDigest: context.membership.genesisDigest,
        seat: 0,
        nonce: 1,
        headSeq: 0,
        headHash: 'f'.repeat(64),
        command: { type: 'END_TURN' },
      },
      fixtureAt(fixture.identities, 0).secretKey,
    );
    expect(
      validateExcludeProposerControl(
        {
          kind: 'control',
          action: 'exclude-proposer',
          offender: 0,
          evidence: {
            kind: 'invalid-command',
            proposal: proposal(signedEntry({ kind: 'command', signed: delayed })),
          },
        },
        controlContext,
      ).ok,
    ).toBe(false);

    // A claim about only the proposed state hash is not an invalid-command proof.
    expect(
      validateExcludeProposerControl(
        {
          kind: 'control',
          action: 'exclude-proposer',
          offender: 0,
          evidence: { kind: 'invalid-command', proposal: second },
        },
        controlContext,
      ).ok,
    ).toBe(false);
  });
});

import { canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import type { Result, SystemInput } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { ConsensusController } from './consensus-controller.js';
import type { ConsensusEffect } from './consensus.js';
import {
  createConsensusState,
  propose,
  receiveCommit,
  receiveProposal,
  receiveVote,
  restoreConsensusState,
  resumeAfterReplay,
  stageAccusation,
} from './consensus.js';
import {
  entryBody as unsignedEntryBody,
  entryHash,
  genesisDigest,
  genesisId,
  signEntry,
  signGenesis,
} from './genesis.js';
import { signCommand, stubEvidence } from './log.js';
import type { LogContext } from './log.js';
import { signProposal } from './proposal.js';
import type { ProposalContext } from './proposal.js';
import { replayCertifiedPrefix } from './replay.js';
import { MemorySafetyStore } from './safety-store.js';
import { fixtureAt, protocolFixture } from './testing/fixtures.js';
import { signVote } from './votes.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function setup() {
  const fixture = protocolFixture();
  const first = fixtureAt(fixture.identities, 0);
  const second = fixtureAt(fixture.identities, 1);
  const third = fixtureAt(fixture.identities, 2);
  const fourth = fixtureAt(fixture.identities, 3);
  const body = {
    ...fixture.body,
    seats: fixture.body.seats.map((seat) => ({
      seat: seat.seat,
      kind: 'human' as const,
      publicKey: seat.publicKey,
      name: seat.name,
      colour: seat.colour,
    })),
  };
  const genesis = {
    ...body,
    gameId: genesisId(body),
    signatures: fixture.identities.map((identity, seat) =>
      signGenesis(body, seat === 0 ? 0 : seat === 1 ? 1 : seat === 2 ? 2 : 3, identity.secretKey),
    ),
  };
  const head = signEntry(
    {
      ...unsignedEntryBody(fixture.entry),
      payload: { kind: 'genesis', genesis },
      sequencer: first.peerId,
    },
    first.secretKey,
  );
  const log: LogContext = {
    genesis,
    engine: fixture.engine,
    head,
    state: fixture.state,
    lastNonces: new Map(),
  };
  const digest = genesisDigest(genesis);
  const context: ProposalContext = {
    log,
    membership: {
      genesisDigest: digest,
      epoch: 0,
      voters: [first, second, third, fourth].map((identity, seat) => ({
        seat: seat === 0 ? 0 : seat === 1 ? 1 : seat === 2 ? 2 : 3,
        publicKey: identity.peerId,
      })),
    },
    excludedProposers: [],
    policy: { allowStub: true },
  };
  const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
  const applied = value(fixture.engine.apply(fixture.state, input));
  const entryBody = {
    seq: 1,
    term: 1,
    prevHash: entryHash(head),
    payload: { kind: 'system', input, evidence: stubEvidence(log, input) } as const,
    sequencer: first.peerId,
  };
  const correct = signEntry(
    { ...entryBody, stateHash: toHex(hashValue(applied.state)) },
    first.secretKey,
  );
  const wrong = signEntry({ ...entryBody, stateHash: 'f'.repeat(64) }, first.secretKey);
  const certificateFor = (entry: typeof correct, seats: readonly (0 | 1 | 2 | 3)[] = [1, 2, 3]) =>
    seats.map((seat) =>
      signVote(
        {
          genesisDigest: digest,
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
  return { context, first, second, third, fourth, correct, wrong, certificateFor };
}

describe('certified deterministic failure handling', () => {
  test('restore reconciles a retained second equivocation before a queued accusation runs', () => {
    const { context, first, second, fourth, correct, certificateFor } = setup();
    const invalidCommand = signCommand(
      {
        gameId: context.log.genesis.gameId,
        genesisDigest: context.membership.genesisDigest,
        seat: 0,
        nonce: 1,
        headSeq: 0,
        headHash: entryHash(context.log.head),
        command: { type: 'END_TURN' },
      },
      second.secretKey,
    );
    const accusedEntry = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(context.log.head),
        payload: { kind: 'command', signed: invalidCommand },
        stateHash: context.log.head.stateHash,
        sequencer: first.peerId,
      },
      first.secretKey,
    );
    const control = {
      kind: 'control' as const,
      action: 'exclude-proposer' as const,
      offender: 0 as const,
      evidence: {
        kind: 'invalid-command' as const,
        proposal: signProposal(
          {
            genesisDigest: context.membership.genesisDigest,
            epoch: 0,
            entry: accusedEntry,
            validRound: null,
            prevotes: [],
          },
          first.secretKey,
        ),
      },
    };
    let state = value(
      stageAccusation(value(createConsensusState(context, 3)), context, control),
    ).state;
    const voteBody = {
      genesisDigest: context.membership.genesisDigest,
      epoch: 0,
      seat: 1 as const,
      seq: 1,
      term: 1,
      phase: 'prevote' as const,
      valueHash: null,
    };
    const secondA = signVote(voteBody, second.secretKey);
    const secondB = signVote({ ...voteBody, valueHash: 'a'.repeat(64) }, second.secretKey);
    state = value(receiveVote(state, context, fourth.secretKey, secondA)).state;
    const newlyProven = value(receiveVote(state, context, fourth.secretKey, secondB));
    state = newlyProven.state;
    expect(state.equivocations).toHaveLength(1);
    expect(state.haltKind).toBe('terminal');
    expect(
      newlyProven.effects.filter(
        (effect) => effect.kind === 'broadcast-vote' || effect.kind === 'commit',
      ),
    ).toEqual([]);
    const priorRecord = { ...state, halted: null, haltKind: null };
    expect(value(restoreConsensusState(priorRecord, context, 3)).haltKind).toBe('terminal');
    const decided = {
      ...priorRecord,
      decision: { entry: correct, certificate: certificateFor(correct, [0, 1, 2]) },
    };
    expect(value(restoreConsensusState(decided, context, 3)).haltKind).toBe('terminal');
  });

  test('a policy-rejected proposal with authenticated self or second-offender evidence halts', () => {
    const { context, first, second, third, fourth } = setup();
    const excludedContext: ProposalContext = { ...context, excludedProposers: [0] };
    const body = {
      genesisDigest: context.membership.genesisDigest,
      epoch: 0,
      seat: 3 as const,
      seq: 1,
      term: 1,
      phase: 'prevote' as const,
      valueHash: null,
    };
    const control = {
      kind: 'control' as const,
      action: 'exclude-proposer' as const,
      offender: 3 as const,
      evidence: {
        kind: 'vote-equivocation' as const,
        first: signVote(body, fourth.secretKey),
        second: signVote({ ...body, valueHash: 'b'.repeat(64) }, fourth.secretKey),
      },
    };
    const entry = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(context.log.head),
        payload: control,
        stateHash: context.log.head.stateHash,
        sequencer: second.peerId,
      },
      second.secretKey,
    );
    const proposal = signProposal(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: 0,
        entry,
        validRound: null,
        prevotes: [],
      },
      second.secretKey,
    );
    const state = value(createConsensusState(excludedContext, 3));
    expect(
      value(receiveProposal(state, excludedContext, fourth.secretKey, proposal)).state.haltKind,
    ).toBe('terminal');
    const forged = { ...proposal, sig: signProposal(proposal.body, first.secretKey).sig };
    expect(receiveProposal(state, excludedContext, fourth.secretKey, forged).ok).toBe(false);
    const forgedControl = {
      ...control,
      evidence: {
        ...control.evidence,
        second: signVote({ ...body, valueHash: 'b'.repeat(64) }, first.secretKey),
      },
    };
    const forgedEntry = signEntry({ ...entry, payload: forgedControl }, second.secretKey);
    const forgedEvidenceProposal = signProposal(
      { ...proposal.body, entry: forgedEntry },
      second.secretKey,
    );
    expect(
      receiveProposal(state, excludedContext, fourth.secretKey, forgedEvidenceProposal).ok,
    ).toBe(false);
    expect(state.halted).toBeNull();

    const otherControl = {
      ...control,
      offender: 2 as const,
      evidence: {
        ...control.evidence,
        first: signVote({ ...body, seat: 2 as const }, third.secretKey),
        second: signVote({ ...body, seat: 2 as const, valueHash: 'b'.repeat(64) }, third.secretKey),
      },
    };
    const otherEntry = signEntry({ ...entry, payload: otherControl }, second.secretKey);
    const otherProposal = signProposal({ ...proposal.body, entry: otherEntry }, second.secretKey);
    expect(
      value(receiveProposal(state, excludedContext, fourth.secretKey, otherProposal)).state
        .haltKind,
    ).toBe('terminal');
  });

  test('retains first proof from a control proposal and stops on a distinct second proof', () => {
    const { context, first, second, third, fourth } = setup();
    const proposedControl = (offender: 1 | 2, signer: typeof second) => {
      const body = {
        genesisDigest: context.membership.genesisDigest,
        epoch: 0,
        seat: offender,
        seq: 1,
        term: 1,
        phase: 'prevote' as const,
        valueHash: null,
      };
      const control = {
        kind: 'control' as const,
        action: 'exclude-proposer' as const,
        offender,
        evidence: {
          kind: 'vote-equivocation' as const,
          first: signVote(body, signer.secretKey),
          second: signVote({ ...body, valueHash: 'e'.repeat(64) }, signer.secretKey),
        },
      };
      const entry = signEntry(
        {
          seq: 1,
          term: 1,
          prevHash: entryHash(context.log.head),
          payload: control,
          stateHash: context.log.head.stateHash,
          sequencer: first.peerId,
        },
        first.secretKey,
      );
      return {
        control,
        proposal: signProposal(
          {
            genesisDigest: context.membership.genesisDigest,
            epoch: 0,
            entry,
            validRound: null,
            prevotes: [],
          },
          first.secretKey,
        ),
      };
    };
    const firstProof = proposedControl(1, second);
    const secondProof = proposedControl(2, third);
    const initial = value(createConsensusState(context, 3));
    const observed = value(
      receiveProposal(initial, context, fourth.secretKey, firstProof.proposal),
    );
    expect(observed.state.provenOffender?.control).toEqual(firstProof.control);
    expect(observed.state.pendingAccusation).toEqual(firstProof.control);
    const conflicting = value(
      receiveProposal(observed.state, context, fourth.secretKey, secondProof.proposal),
    );
    expect(conflicting.state.haltKind).toBe('terminal');
    expect(conflicting.state.decision).toBeNull();
    expect(value(restoreConsensusState(conflicting.state, context, 3)).haltKind).toBe('terminal');
  });

  test('clears only a stale pending accusation after its exclusion is certified', async () => {
    const { context, first, second, third, fourth } = setup();
    const voteBody = {
      genesisDigest: context.membership.genesisDigest,
      epoch: 0,
      seat: 0 as const,
      seq: 1,
      term: 1,
      phase: 'prevote' as const,
      valueHash: null,
    };
    const control = {
      kind: 'control' as const,
      action: 'exclude-proposer' as const,
      offender: 0 as const,
      evidence: {
        kind: 'vote-equivocation' as const,
        first: signVote(voteBody, first.secretKey),
        second: signVote({ ...voteBody, valueHash: 'c'.repeat(64) }, first.secretKey),
      },
    };
    const entry = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(context.log.head),
        payload: control,
        stateHash: context.log.head.stateHash,
        sequencer: first.peerId,
      },
      first.secretKey,
    );
    const certificate = [second, third, fourth].map((identity, index) =>
      signVote(
        {
          genesisDigest: context.membership.genesisDigest,
          epoch: 0,
          seat: index === 0 ? 1 : index === 1 ? 2 : 3,
          seq: 1,
          term: 1,
          phase: 'precommit',
          valueHash: entryHash(entry),
        },
        identity.secretKey,
      ),
    );
    const replayed = value(
      replayCertifiedPrefix(context.log.head, [{ entry, certificate }], context.log.engine, {
        genesis: { allowStub: true },
        entry: { allowStub: true },
      }),
    );
    const proven = { control, atSeq: 1, parentHash: entryHash(context.log.head) };
    const stale = value(createConsensusState(replayed.context, 2, proven, control));
    const store = new MemorySafetyStore();
    expect(await store.save(null, canonicalEncode(stale))).toBe(true);
    const controller = value(
      await ConsensusController.restore({
        context: replayed.context,
        seat: 2,
        secretKey: third.secretKey,
        store,
        onEffects: () => undefined,
      }),
    );
    expect(value(controller.snapshot()).pendingAccusation).toEqual(control);
    expect((await controller.dispatch({ kind: 'clear-stale-accusation' })).ok).toBe(true);
    expect(value(controller.snapshot()).pendingAccusation).toBeNull();
    expect(
      value(
        await ConsensusController.restore({
          context: replayed.context,
          seat: 2,
          secretKey: third.secretKey,
          store,
          onEffects: () => undefined,
        }),
      ).snapshot().ok,
    ).toBe(true);
  });
  test('validated self-accusation halts, but a forged self vote does not', () => {
    const { context, first, second } = setup();
    const voteBody = {
      genesisDigest: context.membership.genesisDigest,
      epoch: 0,
      seat: 0 as const,
      seq: 1,
      term: 1,
      phase: 'prevote' as const,
      valueHash: null,
    };
    const firstVote = signVote(voteBody, first.secretKey);
    const conflictingBody = { ...voteBody, valueHash: 'a'.repeat(64) };
    const genuine = {
      kind: 'control' as const,
      action: 'exclude-proposer' as const,
      offender: 0 as const,
      evidence: {
        kind: 'vote-equivocation' as const,
        first: firstVote,
        second: signVote(conflictingBody, first.secretKey),
      },
    };
    const initial = value(createConsensusState(context, 0));
    const forged = {
      ...genuine,
      evidence: { ...genuine.evidence, second: signVote(conflictingBody, second.secretKey) },
    };
    expect(stageAccusation(initial, context, forged).ok).toBe(false);
    expect(initial.halted).toBeNull();
    const observed = value(stageAccusation(initial, context, genuine));
    expect(observed.state.haltKind).toBe('terminal');
    expect(observed.state.pendingAccusation).toBeNull();
    expect(observed.effects.map((effect) => effect.kind)).toEqual(['halt']);
  });

  test('self exclusion and a second proven offender halt before proposal vote or commit', () => {
    const { context, first, second, third, fourth } = setup();
    const control = (offender: 0 | 1) => {
      const signer = offender === 0 ? first : second;
      const voteBody = {
        genesisDigest: context.membership.genesisDigest,
        epoch: 0,
        seat: offender,
        seq: 1,
        term: 1,
        phase: 'prevote' as const,
        valueHash: null,
      };
      return {
        kind: 'control' as const,
        action: 'exclude-proposer' as const,
        offender,
        evidence: {
          kind: 'vote-equivocation' as const,
          first: signVote(voteBody, signer.secretKey),
          second: signVote({ ...voteBody, valueHash: 'a'.repeat(64) }, signer.secretKey),
        },
      };
    };
    const signedControl = (
      evidence: ReturnType<typeof control>,
      proposer: typeof first,
      term: number,
    ) =>
      signEntry(
        {
          seq: 1,
          term,
          prevHash: entryHash(context.log.head),
          payload: evidence,
          stateHash: context.log.head.stateHash,
          sequencer: proposer.peerId,
        },
        proposer.secretKey,
      );
    const selfEntry = signedControl(control(0), second, 2);
    const selfProposal = signProposal(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: 0,
        entry: selfEntry,
        validRound: null,
        prevotes: [],
      },
      second.secretKey,
    );
    const selfState = value(createConsensusState(context, 0));
    const proposedSelf = value(receiveProposal(selfState, context, first.secretKey, selfProposal));
    expect(proposedSelf.state.haltKind).toBe('terminal');
    expect(proposedSelf.state.votes).toHaveLength(0);
    const selfCertificate = [1, 2, 3].map((seat) =>
      signVote(
        {
          genesisDigest: context.membership.genesisDigest,
          epoch: 0,
          seat: seat === 1 ? 1 : seat === 2 ? 2 : 3,
          seq: 1,
          term: 2,
          phase: 'precommit',
          valueHash: entryHash(selfEntry),
        },
        (seat === 1 ? second : seat === 2 ? third : fourth).secretKey,
      ),
    );
    const certifiedSelf = value(
      receiveCommit(selfState, context, { entry: selfEntry, certificate: selfCertificate }),
    );
    expect(certifiedSelf.state.haltKind).toBe('terminal');
    expect(certifiedSelf.state.decision).toBeNull();

    const firstProof = control(0);
    const proven = value(
      stageAccusation(value(createConsensusState(context, 3)), context, firstProof),
    );
    const otherEntry = signedControl(control(1), first, 1);
    const otherProposal = signProposal(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: 0,
        entry: otherEntry,
        validRound: null,
        prevotes: [],
      },
      first.secretKey,
    );
    const proposedOther = value(
      receiveProposal(proven.state, context, fourth.secretKey, otherProposal),
    );
    expect(proposedOther.state.haltKind).toBe('terminal');
    expect(proposedOther.state.votes).toHaveLength(0);
    const otherCertificate = [first, second, third].map((identity, seat) =>
      signVote(
        {
          genesisDigest: context.membership.genesisDigest,
          epoch: 0,
          seat: seat === 0 ? 0 : seat === 1 ? 1 : 2,
          seq: 1,
          term: 1,
          phase: 'precommit',
          valueHash: entryHash(otherEntry),
        },
        identity.secretKey,
      ),
    );
    const certifiedOther = value(
      receiveCommit(proven.state, context, { entry: otherEntry, certificate: otherCertificate }),
    );
    expect(certifiedOther.state.haltKind).toBe('terminal');
    expect(certifiedOther.state.decision).toBeNull();
  });

  test('restore durably terminalizes a retained proof against a different certified exclusion', async () => {
    const { context, first, fourth } = setup();
    const body = {
      genesisDigest: context.membership.genesisDigest,
      epoch: 0,
      seat: 0 as const,
      seq: 1,
      term: 1,
      phase: 'prevote' as const,
      valueHash: null,
    };
    const control = {
      kind: 'control' as const,
      action: 'exclude-proposer' as const,
      offender: 0 as const,
      evidence: {
        kind: 'vote-equivocation' as const,
        first: signVote(body, first.secretKey),
        second: signVote({ ...body, valueHash: 'b'.repeat(64) }, first.secretKey),
      },
    };
    const excludedContext: ProposalContext = { ...context, excludedProposers: [1] };
    const proven = {
      control,
      atSeq: 1,
      parentHash: entryHash(context.log.head),
    };
    const halted = value(createConsensusState(excludedContext, 3, proven));
    expect(halted.haltKind).toBe('terminal');
    const oldUnsafeRecord = { ...halted, halted: null, haltKind: null };
    const store = new MemorySafetyStore();
    expect(await store.save(null, canonicalEncode(oldUnsafeRecord))).toBe(true);
    const effects: ConsensusEffect[] = [];
    const restored = value(
      await ConsensusController.restore({
        context: excludedContext,
        seat: 3,
        secretKey: fourth.secretKey,
        store,
        onEffects: (next) => {
          effects.push(...next);
        },
      }),
    );
    expect(value(restored.snapshot()).haltKind).toBe('terminal');
    expect((await store.load())?.revision).toBe(1);
    expect((await restored.resume()).ok).toBe(true);
    expect(effects.map((effect) => effect.kind)).toEqual(['halt']);
    expect((await restored.dispatch({ kind: 'input-available' })).ok).toBe(true);
    expect(value(restored.snapshot()).votes).toHaveLength(0);

    const selfHalted = value(createConsensusState(context, 0, proven));
    const selfStore = new MemorySafetyStore();
    expect(
      await selfStore.save(null, canonicalEncode({ ...selfHalted, halted: null, haltKind: null })),
    ).toBe(true);
    const selfRestored = value(
      await ConsensusController.restore({
        context,
        seat: 0,
        secretKey: first.secretKey,
        store: selfStore,
        onEffects: () => undefined,
      }),
    );
    expect(value(selfRestored.snapshot()).haltKind).toBe('terminal');
    expect((await selfStore.load())?.revision).toBe(1);

    const excludedLocalContext: ProposalContext = { ...context, excludedProposers: [3] };
    const excludedLocal = value(createConsensusState(excludedLocalContext, 3));
    expect(excludedLocal.haltKind).toBe('terminal');
    const excludedStore = new MemorySafetyStore();
    expect(
      await excludedStore.save(
        null,
        canonicalEncode({ ...excludedLocal, halted: null, haltKind: null }),
      ),
    ).toBe(true);
    const recoveredExclusion = value(
      await ConsensusController.restore({
        context: excludedLocalContext,
        seat: 3,
        secretKey: fourth.secretKey,
        store: excludedStore,
        onEffects: () => undefined,
      }),
    );
    expect(value(recoveredExclusion.snapshot()).haltKind).toBe('terminal');
    expect((await excludedStore.load())?.revision).toBe(1);
  });

  test('an authenticated old-height self accusation terminal-halts at the current height', () => {
    const { context, first, second, third, correct, certificateFor, fourth } = setup();
    const replayed = value(
      replayCertifiedPrefix(
        context.log.head,
        [{ entry: correct, certificate: certificateFor(correct, [0, 1, 2]) }],
        context.log.engine,
        { genesis: { allowStub: true }, entry: { allowStub: true } },
      ),
    );
    const body = {
      genesisDigest: context.membership.genesisDigest,
      epoch: 0,
      seat: 3 as const,
      seq: 1,
      term: 1,
      phase: 'prevote' as const,
      valueHash: null,
    };
    const control = {
      kind: 'control' as const,
      action: 'exclude-proposer' as const,
      offender: 3 as const,
      evidence: {
        kind: 'vote-equivocation' as const,
        first: signVote(body, fourth.secretKey),
        second: signVote({ ...body, valueHash: 'c'.repeat(64) }, fourth.secretKey),
      },
    };
    const state = value(createConsensusState(replayed.context, 3));
    const result = value(stageAccusation(state, replayed.context, control));
    expect(result.state.haltKind).toBe('terminal');
    expect(result.state.pendingAccusation).toBeNull();
    const entry = signEntry(
      {
        seq: 2,
        term: 1,
        prevHash: entryHash(replayed.context.log.head),
        payload: control,
        stateHash: replayed.context.log.head.stateHash,
        sequencer: second.peerId,
      },
      second.secretKey,
    );
    const proposal = signProposal(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: 0,
        entry,
        validRound: null,
        prevotes: [],
      },
      second.secretKey,
    );
    const proposed = value(receiveProposal(state, replayed.context, fourth.secretKey, proposal));
    expect(proposed.state.haltKind).toBe('terminal');
    expect(proposed.state.votes).toHaveLength(0);
    const certificate = [first, second, third].map((identity, seat) =>
      signVote(
        {
          genesisDigest: context.membership.genesisDigest,
          epoch: 0,
          seat: seat === 0 ? 0 : seat === 1 ? 1 : 2,
          seq: 2,
          term: 1,
          phase: 'precommit',
          valueHash: entryHash(entry),
        },
        identity.secretKey,
      ),
    );
    const committed = value(receiveCommit(state, replayed.context, { entry, certificate }));
    expect(committed.state.haltKind).toBe('terminal');
    expect(committed.state.decision).toBeNull();
  });

  test('halts on a certified entry signed by the local key but absent from its proposal record', () => {
    const { context, correct, certificateFor } = setup();
    const state = value(createConsensusState(context, 0));
    const received = value(
      receiveCommit(state, context, {
        entry: correct,
        certificate: certificateFor(correct),
      }),
    );
    expect(received.state.haltKind).toBe('terminal');
    expect(received.state.decision).toBeNull();
    expect(received.effects.map((effect) => effect.kind)).toEqual(['halt']);
  });

  test('halts on an authenticated commit carrying an unrecorded local precommit', () => {
    const { context, correct, certificateFor } = setup();
    const state = value(createConsensusState(context, 0));
    const received = value(
      receiveCommit(state, context, {
        entry: correct,
        certificate: certificateFor(correct, [0, 1, 2]),
      }),
    );
    expect(received.state.decision).toBeNull();
    expect(received.state.haltKind).toBe('terminal');
    expect(received.effects.some((effect) => effect.kind === 'halt')).toBe(true);
    expect(received.effects.some((effect) => effect.kind === 'commit')).toBe(false);
  });

  test('halts on an authenticated valid-round proof carrying an unrecorded local prevote', () => {
    const { context, first, second, third, correct } = setup();
    const entry = signEntry(
      { ...unsignedEntryBody(correct), term: 2, sequencer: second.peerId },
      second.secretKey,
    );
    const proof = [first, second, third].map((identity, seat) =>
      signVote(
        {
          genesisDigest: context.membership.genesisDigest,
          epoch: 0,
          seat: seat === 0 ? 0 : seat === 1 ? 1 : 2,
          seq: 1,
          term: 1,
          phase: 'prevote',
          valueHash: entryHash(entry),
        },
        identity.secretKey,
      ),
    );
    const proposal = signProposal(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: 0,
        entry,
        validRound: 1,
        prevotes: proof,
      },
      second.secretKey,
    );
    const state = value(createConsensusState(context, 0));
    const received = value(receiveProposal(state, context, first.secretKey, proposal));
    expect(received.state.haltKind).toBe('terminal');
    expect(received.effects.some((effect) => effect.kind === 'halt')).toBe(true);
    expect(received.effects.some((effect) => effect.kind === 'broadcast-vote')).toBe(false);
  });

  test('restore rejects decisions and unapplied certificates with missing local votes', () => {
    const { context, correct, certificateFor } = setup();
    const state = value(createConsensusState(context, 0));
    const certified = { entry: correct, certificate: certificateFor(correct, [0, 1, 2]) };
    expect(restoreConsensusState({ ...state, decision: certified }, context, 0).ok).toBe(false);
    expect(
      restoreConsensusState(
        {
          ...state,
          halted: 'Certified value failed deterministic validation',
          haltKind: 'certified-validation',
          unappliedCertificate: certified,
        },
        context,
        0,
      ).ok,
    ).toBe(false);
  });

  test('halts on a valid quorum certificate whose value fails deterministic state validation', () => {
    const { context, wrong, certificateFor } = setup();
    const state = value(createConsensusState(context, 0));
    const received = receiveCommit(state, context, {
      entry: wrong,
      certificate: certificateFor(wrong),
    });
    expect(received.ok).toBe(true);
    if (!received.ok) throw new Error(`${received.error.code}: ${received.error.message}`);
    expect(received.value.state.halted).not.toBeNull();
    expect(received.value.effects.some((effect) => effect.kind === 'halt')).toBe(true);
  });

  test('rejects an invalid certificate without halting an otherwise live voter', () => {
    const { context, first, correct, wrong, certificateFor } = setup();
    const state = value(createConsensusState(context, 0));
    const malformed = receiveCommit(state, context, {
      entry: wrong,
      certificate: [fixtureAt(certificateFor(wrong), 0)],
    });
    expect(malformed.ok).toBe(false);
    expect(state.halted).toBeNull();
    expect(propose(state, context, first.secretKey, correct).ok).toBe(true);
  });

  test('a certified value rejected only by corrupt local derived state suspends voting', () => {
    const { context, correct, certificateFor } = setup();
    const corrupt: ProposalContext = {
      ...context,
      log: {
        ...context.log,
        state: {
          ...context.log.state,
          counters: {
            ...context.log.state.counters,
            nextOfferId: context.log.state.counters.nextOfferId + 1,
          },
        },
      },
    };
    const state = value(createConsensusState(corrupt, 3));
    const received = value(
      receiveCommit(state, corrupt, {
        entry: correct,
        certificate: certificateFor(correct, [0, 1, 2]),
      }),
    );
    expect(received.state.halted).not.toBeNull();
    expect(received.state.haltKind).toBe('certified-validation');
    expect(received.state.unappliedCertificate?.entry).toEqual(correct);
    expect(received.effects.some((effect) => effect.kind === 'halt')).toBe(true);
  });

  test('persists a failed certificate and commits it only after a fresh replay repairs local state', async () => {
    const { context, fourth, correct, certificateFor } = setup();
    const corrupt: ProposalContext = {
      ...context,
      log: {
        ...context.log,
        state: {
          ...context.log.state,
          counters: {
            ...context.log.state.counters,
            nextOfferId: context.log.state.counters.nextOfferId + 1,
          },
        },
      },
    };
    const store = new MemorySafetyStore();
    const before: ConsensusEffect[] = [];
    const created = value(
      await ConsensusController.create({
        context: corrupt,
        seat: 3,
        secretKey: fourth.secretKey,
        store,
        onEffects: (effects) => {
          before.push(...effects);
        },
      }),
    );
    const certified = { entry: correct, certificate: certificateFor(correct, [0, 1, 2]) };
    expect((await created.dispatch({ kind: 'commit', certified })).ok).toBe(true);
    expect(before.map((effect) => effect.kind)).toEqual(['halt']);
    expect(value(created.snapshot()).unappliedCertificate).toEqual(certified);
    expect((await store.load())?.revision).toBe(1);
    created.dispose();

    const after: ConsensusEffect[] = [];
    const restored = value(
      await ConsensusController.restore({
        context,
        seat: 3,
        secretKey: fourth.secretKey,
        store,
        onEffects: (effects) => {
          after.push(...effects);
        },
      }),
    );
    expect(value(restored.snapshot()).unappliedCertificate).toEqual(certified);
    expect((await restored.dispatch({ kind: 'resume-after-replay' })).ok).toBe(true);
    expect(after.map((effect) => effect.kind)).toEqual(['commit']);
    const resumed = value(restored.snapshot());
    expect(resumed.decision).toEqual(certified);
    expect(resumed.halted).toBeNull();
    expect(resumed.haltKind).toBeNull();
    expect(resumed.unappliedCertificate).toBeNull();
    expect((await store.load())?.revision).toBe(2);
  });

  test('repair cannot commit a now-valid certificate excluding the local signing key', async () => {
    const { context, first, second, third, fourth } = setup();
    const voteBody = {
      genesisDigest: context.membership.genesisDigest,
      epoch: 0,
      seat: 3 as const,
      seq: 1,
      term: 1,
      phase: 'prevote' as const,
      valueHash: null,
    };
    const control = {
      kind: 'control' as const,
      action: 'exclude-proposer' as const,
      offender: 3 as const,
      evidence: {
        kind: 'vote-equivocation' as const,
        first: signVote(voteBody, fourth.secretKey),
        second: signVote({ ...voteBody, valueHash: 'd'.repeat(64) }, fourth.secretKey),
      },
    };
    const entry = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(context.log.head),
        payload: control,
        stateHash: context.log.head.stateHash,
        sequencer: first.peerId,
      },
      first.secretKey,
    );
    const certificate = [first, second, third].map((identity, seat) =>
      signVote(
        {
          genesisDigest: context.membership.genesisDigest,
          epoch: 0,
          seat: seat === 0 ? 0 : seat === 1 ? 1 : 2,
          seq: 1,
          term: 1,
          phase: 'precommit',
          valueHash: entryHash(entry),
        },
        identity.secretKey,
      ),
    );
    const corrupt: ProposalContext = {
      ...context,
      log: {
        ...context.log,
        state: {
          ...context.log.state,
          counters: {
            ...context.log.state.counters,
            nextOfferId: context.log.state.counters.nextOfferId + 1,
          },
        },
      },
    };
    const initial = value(createConsensusState(corrupt, 3));
    const suspended = value(receiveCommit(initial, corrupt, { entry, certificate })).state;
    expect(suspended.haltKind).toBe('certified-validation');
    const repaired = value(resumeAfterReplay(suspended, context));
    expect(repaired.state.haltKind).toBe('terminal');
    expect(repaired.state.decision).toBeNull();
    expect(repaired.effects.map((effect) => effect.kind)).toEqual(['halt']);
    const store = new MemorySafetyStore();
    expect(await store.save(null, canonicalEncode(suspended))).toBe(true);
    const effects: ConsensusEffect[] = [];
    const controller = value(
      await ConsensusController.restore({
        context,
        seat: 3,
        secretKey: fourth.secretKey,
        store,
        onEffects: (next) => {
          effects.push(...next);
        },
      }),
    );
    expect((await controller.dispatch({ kind: 'resume-after-replay' })).ok).toBe(true);
    expect(value(controller.snapshot()).haltKind).toBe('terminal');
    expect((await store.load())?.revision).toBe(1);
    expect(effects.map((effect) => effect.kind)).toEqual(['halt']);
  });

  test('keeps a genuinely invalid certified value halted after replay', () => {
    const { context, wrong, certificateFor } = setup();
    const initial = value(createConsensusState(context, 3));
    const halted = value(
      receiveCommit(initial, context, {
        entry: wrong,
        certificate: certificateFor(wrong, [0, 1, 2]),
      }),
    ).state;
    const resumed = resumeAfterReplay(halted, context);
    expect(resumed.ok).toBe(false);
    if (resumed.ok) throw new Error('Invalid certified value resumed');
    expect(resumed.error.code).toBe('consensus-repair-incomplete');
    expect(halted.unappliedCertificate?.entry).toEqual(wrong);
    expect(halted.haltKind).toBe('certified-validation');
  });

  test('repair preserves earlier votes and locks instead of starting a fresh round', () => {
    const { context, first, second, third, correct, certificateFor } = setup();
    const initial = value(createConsensusState(context, 0));
    const proposed = value(propose(initial, context, first.secretKey, correct)).state;
    const otherPrevote = signVote(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: 0,
        seat: 1,
        seq: 1,
        term: 1,
        phase: 'prevote',
        valueHash: entryHash(correct),
      },
      second.secretKey,
    );
    const withOnePrevote = value(
      receiveVote(proposed, context, first.secretKey, otherPrevote),
    ).state;
    const thirdPrevote = signVote({ ...otherPrevote.body, seat: 2 }, third.secretKey);
    const locked = value(receiveVote(withOnePrevote, context, first.secretKey, thirdPrevote)).state;
    expect(locked.locked).not.toBeNull();
    // This is the durable record after a transient derived-state failure; the
    // certificate is independently authenticated on restore before resuming.
    const halted = {
      ...locked,
      halted: 'Certified value failed deterministic validation: state-hash',
      haltKind: 'certified-validation' as const,
      unappliedCertificate: { entry: correct, certificate: certificateFor(correct) },
    };
    const resumed = value(resumeAfterReplay(halted, context));
    expect(resumed.state.votes).toEqual(locked.votes);
    expect(resumed.state.locked).toEqual(locked.locked);
    expect(resumed.state.valid).toEqual(locked.valid);
    expect(resumed.state.decision?.entry).toEqual(correct);
  });

  test('does not clear a terminal safety halt after replay', () => {
    const { context, first, correct } = setup();
    const initial = value(createConsensusState(context, 0));
    const unknownOwnVote = signVote(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: 0,
        seat: 0,
        seq: 1,
        term: 1,
        phase: 'prevote',
        valueHash: entryHash(correct),
      },
      first.secretKey,
    );
    const halted = value(receiveVote(initial, context, first.secretKey, unknownOwnVote)).state;
    expect(halted.haltKind).toBe('terminal');
    expect(halted.unappliedCertificate).toBeNull();
    const resumed = resumeAfterReplay(halted, context);
    expect(resumed.ok).toBe(false);
    if (resumed.ok) throw new Error('Terminal safety halt resumed');
    expect(resumed.error.code).toBe('consensus-repair-unavailable');
  });

  test('restore rejects a tampered or unauthenticated unapplied certificate', () => {
    const { context, wrong, certificateFor } = setup();
    const initial = value(createConsensusState(context, 0));
    const halted = value(
      receiveCommit(initial, context, {
        entry: wrong,
        certificate: certificateFor(wrong),
      }),
    ).state;
    const forged = {
      ...halted,
      unappliedCertificate: {
        entry: wrong,
        certificate: [
          { ...certificateFor(wrong)[0], sig: 'A'.repeat(86) },
          certificateFor(wrong)[1],
        ],
      },
    };
    expect(restoreConsensusState(forged, context, 0).ok).toBe(false);
  });

  test('a valid quorum cannot turn a forged outer signature into a halt', () => {
    const { context, first, correct, certificateFor } = setup();
    const state = value(createConsensusState(context, 0));
    const forged = { ...correct, sig: 'A'.repeat(86) };
    const received = receiveCommit(state, context, {
      entry: forged,
      certificate: certificateFor(correct),
    });
    expect(received.ok).toBe(false);
    if (received.ok) throw new Error('Forged entry was accepted');
    expect(received.error.code).toBe('sequencer-signature');
    expect(state.halted).toBeNull();
    expect(propose(state, context, first.secretKey, correct).ok).toBe(true);
  });

  test('a certified wrong parent halts, while a certified future height requests history', () => {
    const { context, first, second, third, fourth, correct, certificateFor } = setup();
    const state = value(createConsensusState(context, 0));
    const fork = signEntry({ ...correct, prevHash: 'e'.repeat(64) }, first.secretKey);
    const halted = value(
      receiveCommit(state, context, {
        entry: fork,
        certificate: certificateFor(fork),
      }),
    );
    expect(halted.state.halted).not.toBeNull();

    const future = signEntry({ ...correct, seq: 2, sequencer: second.peerId }, second.secretKey);
    const futureCertificate = [second, third, fourth].map((identity, index) =>
      signVote(
        {
          genesisDigest: context.membership.genesisDigest,
          epoch: 0,
          seat: index === 0 ? 1 : index === 1 ? 2 : 3,
          seq: 2,
          term: 1,
          phase: 'precommit',
          valueHash: entryHash(future),
        },
        identity.secretKey,
      ),
    );
    const missing = receiveCommit(state, context, {
      entry: future,
      certificate: futureCertificate,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('Future height was accepted');
    expect(missing.error.code).toBe('missing-ancestor');
    expect(state.halted).toBeNull();
  });
});

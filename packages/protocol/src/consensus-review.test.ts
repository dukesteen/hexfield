import { hashValue, toHex } from '@cp2p/codec';
import type { Result, SystemInput } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { ConsensusController } from './consensus-controller.js';
import type { ConsensusEffect } from './consensus.js';
import {
  createConsensusState,
  propose,
  receiveCommit,
  receiveVote,
  restoreConsensusState,
  resumeAfterReplay,
} from './consensus.js';
import { entryHash, genesisDigest, signEntry } from './genesis.js';
import { stubEvidence } from './log.js';
import type { LogContext } from './log.js';
import type { ProposalContext } from './proposal.js';
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
        { seat: 0, publicKey: first.peerId },
        { seat: 1, publicKey: second.peerId },
      ],
    },
    excludedProposers: [],
    policy: { allowStub: true },
  };
  const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
  const applied = value(fixture.engine.apply(fixture.state, input));
  const entryBody = {
    seq: 1,
    term: 1,
    prevHash: entryHash(fixture.entry),
    payload: { kind: 'system', input, evidence: stubEvidence(log, input) } as const,
    sequencer: first.peerId,
  };
  const correct = signEntry(
    { ...entryBody, stateHash: toHex(hashValue(applied.state)) },
    first.secretKey,
  );
  const wrong = signEntry({ ...entryBody, stateHash: 'f'.repeat(64) }, first.secretKey);
  const certificateFor = (entry: typeof correct) =>
    [first, second].map((identity, index) =>
      signVote(
        {
          genesisDigest: digest,
          epoch: 0,
          seat: index === 0 ? 0 : 1,
          seq: 1,
          term: 1,
          phase: 'precommit',
          valueHash: entryHash(entry),
        },
        identity.secretKey,
      ),
    );
  return { context, first, second, correct, wrong, certificateFor };
}

describe('certified deterministic failure handling', () => {
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
    const state = value(createConsensusState(corrupt, 0));
    const received = value(
      receiveCommit(state, corrupt, {
        entry: correct,
        certificate: certificateFor(correct),
      }),
    );
    expect(received.state.halted).not.toBeNull();
    expect(received.state.haltKind).toBe('certified-validation');
    expect(received.state.unappliedCertificate?.entry).toEqual(correct);
    expect(received.effects.some((effect) => effect.kind === 'halt')).toBe(true);
  });

  test('persists a failed certificate and commits it only after a fresh replay repairs local state', async () => {
    const { context, first, correct, certificateFor } = setup();
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
        seat: 0,
        secretKey: first.secretKey,
        store,
        onEffects: (effects) => {
          before.push(...effects);
        },
      }),
    );
    const certified = { entry: correct, certificate: certificateFor(correct) };
    expect((await created.dispatch({ kind: 'commit', certified })).ok).toBe(true);
    expect(before.map((effect) => effect.kind)).toEqual(['halt']);
    expect(value(created.snapshot()).unappliedCertificate).toEqual(certified);
    expect((await store.load())?.revision).toBe(1);
    created.dispose();

    const after: ConsensusEffect[] = [];
    const restored = value(
      await ConsensusController.restore({
        context,
        seat: 0,
        secretKey: first.secretKey,
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

  test('keeps a genuinely invalid certified value halted after replay', () => {
    const { context, wrong, certificateFor } = setup();
    const initial = value(createConsensusState(context, 0));
    const halted = value(
      receiveCommit(initial, context, {
        entry: wrong,
        certificate: certificateFor(wrong),
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
    const { context, first, second, correct, certificateFor } = setup();
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
    const locked = value(receiveVote(proposed, context, first.secretKey, otherPrevote)).state;
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
    const { context, first, second, correct, certificateFor } = setup();
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
    const futureCertificate = [first, second].map((identity, index) =>
      signVote(
        {
          genesisDigest: context.membership.genesisDigest,
          epoch: 0,
          seat: index === 0 ? 0 : 1,
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

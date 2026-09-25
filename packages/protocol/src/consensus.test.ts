import { hashValue, toHex } from '@cp2p/codec';
import type { Result, Seat, SystemInput } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import {
  createConsensusState,
  inputAvailable,
  propose,
  receiveCommit,
  receiveProposal,
  receiveVote,
  recoverConsensusEffects,
  restoreConsensusState,
  timeout,
} from './consensus.js';
import { entryHash, genesisDigest, genesisId, signEntry, signGenesis } from './genesis.js';
import { stubEvidence } from './log.js';
import type { LogContext } from './log.js';
import { proposerFor, signProposal } from './proposal.js';
import type { ProposalContext } from './proposal.js';
import { fixtureAt, protocolFixture } from './testing/fixtures.js';
import { signVote } from './votes.js';
import type { VotePhase } from './votes.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function errorCode(result: Result<unknown>): string | undefined {
  return result.ok ? undefined : result.error.code;
}

function seatAt(index: number): Seat {
  switch (index) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
      return index;
    default:
      throw new RangeError('No protocol test seat at this index');
  }
}

function setup() {
  const fixture = protocolFixture();
  const seats = fixture.body.seats.map((seat) => ({
    seat: seat.seat,
    kind: 'human' as const,
    publicKey: seat.publicKey,
    name: seat.name,
    colour: seat.colour,
  }));
  const body = { ...fixture.body, seats };
  const genesis = {
    ...body,
    gameId: genesisId(body),
    signatures: fixture.identities.map((identity, seat) =>
      signGenesis(body, seatAt(seat), identity.secretKey),
    ),
  };
  const head = signEntry(
    {
      ...fixture.entry,
      payload: { kind: 'genesis', genesis },
      sequencer: fixtureAt(fixture.identities, 0).peerId,
    },
    fixtureAt(fixture.identities, 0).secretKey,
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
      voters: fixture.identities.map((identity, seat) => ({
        seat: seatAt(seat),
        publicKey: identity.peerId,
      })),
    },
    excludedProposers: [],
    policy: { allowStub: true },
  };
  const key = (seat: number) => fixtureAt(fixture.identities, seat).secretKey;
  const entry = (round: number, activeSeat = 0) => {
    const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: activeSeat };
    const applied = value(fixture.engine.apply(fixture.state, input));
    const proposer = proposerFor(1, round, context.membership, context.excludedProposers);
    return signEntry(
      {
        seq: 1,
        term: round,
        prevHash: entryHash(head),
        payload: { kind: 'system', input, evidence: stubEvidence(log, input) },
        stateHash: toHex(hashValue(applied.state)),
        sequencer: fixtureAt(fixture.identities, proposer.seat).peerId,
      },
      key(proposer.seat),
    );
  };
  const vote = (seat: number, round: number, phase: VotePhase, hash: string | null) =>
    signVote(
      {
        genesisDigest: digest,
        epoch: 0,
        seat: seatAt(seat),
        seq: 1,
        term: round,
        phase,
        valueHash: hash,
      },
      key(seat),
    );
  const proposal = (round: number, activeSeat = 0) => {
    const proposed = entry(round, activeSeat);
    const proposer = proposerFor(1, round, context.membership);
    return signProposal(
      { genesisDigest: digest, epoch: 0, entry: proposed, validRound: null, prevotes: [] },
      key(proposer.seat),
    );
  };
  return { context, key, entry, vote, proposal };
}

describe('one-height consensus core', () => {
  test('four voters prevote, lock, precommit and commit only on quorum', () => {
    const f = setup();
    let state = value(createConsensusState(f.context, 0));
    const proposal = f.proposal(1);
    const hash = entryHash(proposal.body.entry);
    let next = value(propose(state, f.context, f.key(0), proposal.body.entry));
    state = next.state;
    expect(next.effects.map((effect) => effect.kind)).toEqual([
      'broadcast-proposal',
      'broadcast-vote',
    ]);
    expect(state.votes[0]?.body.valueHash).toBe(hash);
    state = value(receiveVote(state, f.context, f.key(0), f.vote(1, 1, 'prevote', hash))).state;
    expect(state.locked).toBeNull();
    next = value(receiveVote(state, f.context, f.key(0), f.vote(2, 1, 'prevote', hash)));
    state = next.state;
    expect(state.locked?.hash).toBe(hash);
    expect(state.valid?.prevotes).toHaveLength(3);
    expect(
      state.votes.find((vote) => vote.body.seat === 0 && vote.body.phase === 'precommit')?.body
        .valueHash,
    ).toBe(hash);
    expect(next.effects.some((effect) => effect.kind === 'commit')).toBe(false);
    state = value(receiveVote(state, f.context, f.key(0), f.vote(1, 1, 'precommit', hash))).state;
    expect(state.decision).toBeNull();
    next = value(receiveVote(state, f.context, f.key(0), f.vote(2, 1, 'precommit', hash)));
    expect(next.state.decision?.certificate).toHaveLength(3);
    expect(next.effects.filter((effect) => effect.kind === 'commit')).toHaveLength(1);
    expect(
      value(
        receiveVote(next.state, f.context, f.key(0), f.vote(2, 1, 'precommit', hash)),
      ).effects.filter((effect) => effect.kind === 'commit'),
    ).toHaveLength(0);
    expect(
      value(recoverConsensusEffects(next.state, f.context)).filter(
        (effect) => effect.kind === 'commit',
      ),
    ).toHaveLength(1);
  });

  test('two votes and a 2|2 split cannot decide four-voter height', () => {
    const f = setup();
    let state = value(createConsensusState(f.context, 3));
    const proposed = f.proposal(1, 0);
    const a = entryHash(proposed.body.entry);
    const b = entryHash(f.entry(1, 1));
    state = value(receiveProposal(state, f.context, f.key(3), proposed)).state;
    for (const seat of [1, 2])
      state = value(receiveVote(state, f.context, f.key(3), f.vote(seat, 1, 'prevote', a))).state;
    for (const [seat, hash] of [
      [1, a],
      [2, b],
      [0, b],
    ] as const)
      state = value(
        receiveVote(state, f.context, f.key(3), f.vote(seat, 1, 'precommit', hash)),
      ).state;
    expect(state.decision).toBeNull();
    expect(state.votes.filter((vote) => vote.body.phase === 'precommit')).toHaveLength(4);
  });

  test('nil own prevote does not prevent later non-nil lock on quorum proof', () => {
    const f = setup();
    let state = value(createConsensusState(f.context, 3));
    state = value(inputAvailable(state, f.context)).state;
    state = value(timeout(state, f.context, f.key(3), 'propose', 1)).state;
    expect(state.votes[0]?.body.valueHash).toBeNull();
    const proposal = f.proposal(1);
    state = value(receiveProposal(state, f.context, f.key(3), proposal)).state;
    const hash = entryHash(proposal.body.entry);
    for (const seat of [0, 1, 2])
      state = value(
        receiveVote(state, f.context, f.key(3), f.vote(seat, 1, 'prevote', hash)),
      ).state;
    expect(state.locked?.hash).toBe(hash);
    expect(
      state.votes.filter((vote) => vote.body.seat === 3 && vote.body.phase === 'prevote'),
    ).toHaveLength(1);
    expect(
      state.votes.find((vote) => vote.body.seat === 3 && vote.body.phase === 'precommit')?.body
        .valueHash,
    ).toBe(hash);
  });

  test('signed future hints need two voters; old-round full certificate still commits', () => {
    const f = setup();
    let state = value(createConsensusState(f.context, 3));
    const a = f.proposal(1);
    const hash = entryHash(a.body.entry);
    state = value(receiveProposal(state, f.context, f.key(3), a)).state;
    for (const seat of [1, 2])
      state = value(
        receiveVote(state, f.context, f.key(3), f.vote(seat, 1, 'prevote', hash)),
      ).state;
    state = value(receiveVote(state, f.context, f.key(3), f.vote(1, 100, 'prevote', null))).state;
    expect(state.round).toBe(1);
    state = value(receiveVote(state, f.context, f.key(3), f.vote(2, 100, 'prevote', null))).state;
    expect(state.round).toBe(100);
    expect(state.locked?.hash).toBe(hash);
    const recovered = value(restoreConsensusState(state, f.context, 3));
    expect(recovered.round).toBe(100);
    const certified = {
      entry: a.body.entry,
      certificate: [0, 1, 2].map((seat) => f.vote(seat, 1, 'precommit', hash)),
    };
    const committed = value(receiveCommit(recovered, f.context, certified));
    expect(committed.state.decision?.entry).toEqual(a.body.entry);
    expect(committed.effects.some((effect) => effect.kind === 'commit')).toBe(true);
  });

  test('a hidden old certificate wins over a later unjustified conflicting proposal', () => {
    const f = setup();
    let state = value(createConsensusState(f.context, 3));
    const a = f.proposal(1, 0);
    const hashA = entryHash(a.body.entry);
    state = value(receiveProposal(state, f.context, f.key(3), a)).state;
    for (const seat of [1, 2])
      state = value(
        receiveVote(state, f.context, f.key(3), f.vote(seat, 1, 'prevote', hashA)),
      ).state;
    expect(state.locked?.hash).toBe(hashA);
    state = value(receiveVote(state, f.context, f.key(3), f.vote(1, 2, 'precommit', null))).state;
    state = value(receiveVote(state, f.context, f.key(3), f.vote(2, 2, 'precommit', null))).state;
    expect(state.round).toBe(2);
    const b = f.proposal(2, 1);
    const hashB = entryHash(b.body.entry);
    state = value(receiveProposal(state, f.context, f.key(3), b)).state;
    expect(
      state.votes.find(
        (vote) => vote.body.seat === 3 && vote.body.term === 2 && vote.body.phase === 'prevote',
      )?.body.valueHash,
    ).toBeNull();
    for (const seat of [1, 2])
      state = value(
        receiveVote(state, f.context, f.key(3), f.vote(seat, 2, 'prevote', hashB)),
      ).state;
    expect(state.locked?.hash).toBe(hashA);
    expect(state.decision).toBeNull();
    const committed = value(
      receiveCommit(state, f.context, {
        entry: a.body.entry,
        certificate: [0, 1, 2].map((seat) => f.vote(seat, 1, 'precommit', hashA)),
      }),
    );
    expect(entryHash(committed.state.decision?.entry ?? b.body.entry)).toBe(hashA);
  });

  test('restart retransmits signed votes, re-arms known-input timer, and ignores stale timeout', () => {
    const f = setup();
    let state = value(createConsensusState(f.context, 0));
    state = value(inputAvailable(state, f.context)).state;
    expect(value(recoverConsensusEffects(state, f.context))).toContainEqual({
      kind: 'schedule-timeout',
      phase: 'propose',
      round: 1,
    });
    state = value(timeout(state, f.context, f.key(0), 'propose', 1)).state;
    expect(
      value(recoverConsensusEffects(state, f.context)).filter(
        (effect) => effect.kind === 'broadcast-vote',
      ),
    ).toHaveLength(1);
    for (const seat of [1, 2, 3])
      state = value(
        receiveVote(state, f.context, f.key(0), f.vote(seat, 1, 'prevote', null)),
      ).state;
    expect(state.step).toBe('precommit');
    for (const seat of [1, 2, 3])
      state = value(
        receiveVote(state, f.context, f.key(0), f.vote(seat, 1, 'precommit', null)),
      ).state;
    expect(state.timers.precommit).toBe(true);
    state = value(timeout(state, f.context, f.key(0), 'precommit', 1)).state;
    expect(state.round).toBe(2);
    expect(state.timers.propose).toBe(true);
    const restored = value(restoreConsensusState(JSON.parse(JSON.stringify(state)), f.context, 0));
    expect(value(timeout(restored, f.context, f.key(0), 'propose', 1)).state).toEqual(restored);
    expect(value(recoverConsensusEffects(restored, f.context))).toContainEqual({
      kind: 'schedule-timeout',
      phase: 'propose',
      round: 2,
    });
  });

  test('a buffered next-round proposal is prevoted immediately after two signed hints', () => {
    const f = setup();
    let state = value(createConsensusState(f.context, 0));
    const nextProposal = f.proposal(2);
    const hash = entryHash(nextProposal.body.entry);
    state = value(receiveProposal(state, f.context, f.key(0), nextProposal)).state;
    expect(state.round).toBe(1);
    expect(state.inputKnown).toBe(true);
    const jumped = value(receiveVote(state, f.context, f.key(0), f.vote(2, 2, 'prevote', hash)));
    expect(jumped.state.round).toBe(2);
    expect(
      jumped.state.votes.find(
        (vote) => vote.body.seat === 0 && vote.body.term === 2 && vote.body.phase === 'prevote',
      )?.body.valueHash,
    ).toBe(hash);
    expect(jumped.effects.some((effect) => effect.kind === 'broadcast-vote')).toBe(true);
  });

  test('prevote timeout can finish a round whose proposal was withheld', () => {
    const f = setup();
    let state = value(createConsensusState(f.context, 0));
    const hidden = f.proposal(1);
    const hash = entryHash(hidden.body.entry);
    for (const seat of [1, 2, 3])
      state = value(
        receiveVote(state, f.context, f.key(0), f.vote(seat, 1, 'prevote', hash)),
      ).state;
    expect(state.step).toBe('propose');
    expect(state.timers.prevote).toBe(true);
    const timed = value(timeout(state, f.context, f.key(0), 'prevote', 1));
    expect(timed.state.step).toBe('precommit');
    expect(
      timed.state.votes
        .filter((vote) => vote.body.seat === 0)
        .map((vote) => [vote.body.phase, vote.body.valueHash]),
    ).toEqual([
      ['prevote', null],
      ['precommit', null],
    ]);
    expect(timed.state.locked).toBeNull();
  });

  test('restart rejects altered binding, erased lock, duplicate vote and forged proof', () => {
    const f = setup();
    let state = value(createConsensusState(f.context, 3));
    const proposal = f.proposal(1);
    const hash = entryHash(proposal.body.entry);
    state = value(receiveProposal(state, f.context, f.key(3), proposal)).state;
    for (const seat of [1, 2])
      state = value(
        receiveVote(state, f.context, f.key(3), f.vote(seat, 1, 'prevote', hash)),
      ).state;
    expect(state.locked).not.toBeNull();
    expect(
      errorCode(restoreConsensusState({ ...state, parentHash: 'a'.repeat(64) }, f.context, 3)),
    ).toBe('consensus-context');
    expect(
      errorCode(restoreConsensusState(state, { ...f.context, excludedProposers: [1] }, 3)),
    ).toBe('consensus-context');
    expect(errorCode(restoreConsensusState({ ...state, locked: null }, f.context, 3))).toBe(
      'consensus-restore',
    );
    expect(
      errorCode(
        restoreConsensusState({ ...state, votes: [...state.votes, state.votes[0]] }, f.context, 3),
      ),
    ).toBe('consensus-restore');
    expect(
      errorCode(
        restoreConsensusState({ ...state, valid: { ...state.valid, prevotes: [] } }, f.context, 3),
      ),
    ).toBe('consensus-restore');
    expect(
      value(recoverConsensusEffects(state, f.context)).filter(
        (effect) => effect.kind === 'broadcast-vote',
      ),
    ).toHaveLength(2);
  });

  test('forged signatures, wrong heights and invalid proposal contexts cannot enter state', () => {
    const f = setup();
    const state = value(createConsensusState(f.context, 0));
    const hash = entryHash(f.entry(1));
    const forged = { ...f.vote(1, 1, 'prevote', hash), sig: f.vote(2, 1, 'prevote', hash).sig };
    expect(receiveVote(state, f.context, f.key(0), forged).ok).toBe(false);
    const wrongHeight = signVote(
      {
        genesisDigest: state.genesisDigest,
        epoch: 0,
        seat: 1,
        seq: 2,
        term: 1,
        phase: 'prevote',
        valueHash: hash,
      },
      f.key(1),
    );
    expect(errorCode(receiveVote(state, f.context, f.key(0), wrongHeight))).toBe(
      'consensus-height',
    );
    expect(
      value(receiveVote(state, f.context, f.key(0), f.vote(0, 1, 'prevote', hash))).state.halted,
    ).toMatch(/Unrecorded local vote/);
    expect(value(receiveProposal(state, f.context, f.key(0), f.proposal(1))).state.halted).toMatch(
      /Unrecorded local proposal/,
    );
    const p = f.proposal(1);
    expect(
      receiveProposal(state, f.context, f.key(0), { ...p, sig: f.vote(1, 1, 'prevote', hash).sig })
        .ok,
    ).toBe(false);
    expect(state.votes).toHaveLength(0);
  });

  test('another voter cannot stand in for a missing persisted local signature', () => {
    const f = setup();
    const initial = value(createConsensusState(f.context, 0));
    const hash = entryHash(f.entry(1));
    const observed = value(
      receiveVote(initial, f.context, f.key(0), f.vote(1, 1, 'prevote', hash)),
    );
    const stale = value(
      receiveVote(observed.state, f.context, f.key(0), f.vote(0, 1, 'prevote', hash)),
    );
    expect(stale.state.halted).toMatch(/Unrecorded local vote/);
    expect(stale.effects.map((effect) => effect.kind)).toEqual(['halt']);
    expect(stale.state.votes.some((vote) => vote.body.seat === 0)).toBe(false);
    expect(value(recoverConsensusEffects(stale.state, f.context))[0]?.kind).toBe('halt');
  });
});

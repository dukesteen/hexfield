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
  restoreConsensusState,
  timeout,
} from './consensus.js';
import type { ConsensusEffect, ConsensusState, ConsensusTransition } from './consensus.js';
import { entryHash, genesisDigest, genesisId, signEntry, signGenesis } from './genesis.js';
import { stubEvidence } from './log.js';
import type { LogContext } from './log.js';
import { proposerFor, signProposal } from './proposal.js';
import type { ProposalContext, SignedProposal } from './proposal.js';
import { fixtureAt, protocolFixture } from './testing/fixtures.js';
import type { GenesisBody, LogEntry } from './types.js';
import { signVote } from './votes.js';
import type { SignedVote, VotePhase } from './votes.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function setup(voterSeats: readonly Seat[], excludedProposers: readonly Seat[] = []) {
  const fixture = protocolFixture();
  const body: GenesisBody = {
    ...fixture.body,
    seats: fixture.body.seats.map((seat) =>
      voterSeats.includes(seat.seat)
        ? {
            seat: seat.seat,
            kind: 'human',
            publicKey: seat.publicKey,
            name: seat.name,
            colour: seat.colour,
          }
        : seat,
    ),
  };
  const genesis = {
    ...body,
    gameId: genesisId(body),
    signatures: voterSeats.map((seat) =>
      signGenesis(body, seat, fixtureAt(fixture.identities, seat).secretKey),
    ),
  };
  const head = signEntry(
    {
      ...fixture.entry,
      payload: { kind: 'genesis', genesis },
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
      voters: voterSeats.map((seat) => ({
        seat,
        publicKey: fixtureAt(fixture.identities, seat).peerId,
      })),
    },
    excludedProposers,
    policy: { allowStub: true },
  };

  function candidate(round: number, activeSeat = 0): LogEntry {
    const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: activeSeat };
    const applied = value(fixture.engine.apply(fixture.state, input));
    const selected = proposerFor(1, round, context.membership, excludedProposers);
    const signer = fixtureAt(fixture.identities, selected.seat);
    return signEntry(
      {
        seq: 1,
        term: round,
        prevHash: entryHash(head),
        payload: { kind: 'system', input, evidence: stubEvidence(log, input) },
        stateHash: toHex(hashValue(applied.state)),
        sequencer: signer.peerId,
      },
      signer.secretKey,
    );
  }

  /** This is used only for the explicitly Byzantine voter in the adversarial traces. */
  function byzantineProposal(round: number, activeSeat: number): SignedProposal {
    const selected = proposerFor(1, round, context.membership, excludedProposers);
    const signer = fixtureAt(fixture.identities, selected.seat);
    return signProposal(
      {
        genesisDigest: digest,
        epoch: 0,
        entry: candidate(round, activeSeat),
        validRound: null,
        prevotes: [],
      },
      signer.secretKey,
    );
  }

  function byzantineVote(
    seat: Seat,
    round: number,
    phase: VotePhase,
    valueHash: string | null,
  ): SignedVote {
    return signVote(
      { genesisDigest: digest, epoch: 0, seat, seq: 1, term: round, phase, valueHash },
      fixtureAt(fixture.identities, seat).secretKey,
    );
  }

  return { context, fixture, candidate, byzantineProposal, byzantineVote };
}

type WireEffect = Extract<ConsensusEffect, { kind: 'broadcast-proposal' | 'broadcast-vote' }>;
type Outbound = { from: Seat; effect: WireEffect };

/** Only core-returned broadcasts enter this outbox; honest peers never sign test-authored votes. */
class Trace {
  readonly states = new Map<Seat, ConsensusState>();
  readonly outbox: Outbound[] = [];
  readonly effects: { from: Seat; effect: ConsensusEffect }[] = [];

  constructor(
    readonly context: ProposalContext,
    readonly keys: ReadonlyMap<Seat, Uint8Array>,
  ) {
    for (const seat of keys.keys())
      this.states.set(seat, value(createConsensusState(context, seat)));
  }

  state(seat: Seat): ConsensusState {
    const state = this.states.get(seat);
    if (!state) throw new Error(`Honest peer ${seat} is missing`);
    return state;
  }

  key(seat: Seat): Uint8Array {
    const key = this.keys.get(seat);
    if (!key) throw new Error(`Honest key ${seat} is missing`);
    return key;
  }

  apply(seat: Seat, result: Result<ConsensusTransition>): readonly ConsensusEffect[] {
    const transition = value(result);
    this.states.set(seat, transition.state);
    for (const effect of transition.effects) {
      this.effects.push({ from: seat, effect });
      if (effect.kind === 'broadcast-proposal' || effect.kind === 'broadcast-vote')
        this.outbox.push({ from: seat, effect });
    }
    return transition.effects;
  }

  input(seat: Seat): void {
    this.apply(seat, inputAvailable(this.state(seat), this.context));
  }

  propose(seat: Seat, candidate: LogEntry): void {
    this.apply(seat, propose(this.state(seat), this.context, this.key(seat), candidate));
  }

  timeout(seat: Seat, phase: 'propose' | 'prevote' | 'precommit', round: number): void {
    this.apply(seat, timeout(this.state(seat), this.context, this.key(seat), phase, round));
  }

  broadcast(from: Seat, kind: WireEffect['kind'], round: number): Outbound {
    const message = this.outbox.findLast(
      (item) =>
        item.from === from &&
        item.effect.kind === kind &&
        (item.effect.kind === 'broadcast-proposal'
          ? item.effect.proposal.body.entry.term
          : item.effect.vote.body.term) === round,
    );
    if (!message) throw new Error(`Core broadcast ${kind} from ${from} at round ${round} missing`);
    return message;
  }

  vote(from: Seat, round: number, phase: VotePhase): Outbound {
    const message = this.outbox.find(
      (item) =>
        item.from === from &&
        item.effect.kind === 'broadcast-vote' &&
        item.effect.vote.body.term === round &&
        item.effect.vote.body.phase === phase,
    );
    if (!message) throw new Error(`Core ${phase} from ${from} at round ${round} missing`);
    return message;
  }

  deliver(message: Outbound, to: Seat): void {
    if (!this.outbox.includes(message))
      throw new Error('Honest message was not emitted by the core');
    if (message.effect.kind === 'broadcast-proposal')
      this.apply(
        to,
        receiveProposal(this.state(to), this.context, this.key(to), message.effect.proposal),
      );
    else
      this.apply(to, receiveVote(this.state(to), this.context, this.key(to), message.effect.vote));
  }

  /** Only tests for the explicitly Byzantine seat call these injection methods. */
  injectProposal(to: Seat, proposal: SignedProposal): void {
    this.apply(to, receiveProposal(this.state(to), this.context, this.key(to), proposal));
  }

  injectVote(to: Seat, vote: SignedVote): void {
    this.apply(to, receiveVote(this.state(to), this.context, this.key(to), vote));
  }
}

function honestKeys(
  fixture: ReturnType<typeof protocolFixture>,
  seats: readonly Seat[],
): ReadonlyMap<Seat, Uint8Array> {
  return new Map(seats.map((seat) => [seat, fixtureAt(fixture.identities, seat).secretKey]));
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items];
  let current = seed;
  for (let index = copy.length - 1; index > 0; index--) {
    current = (Math.imul(current, 1_664_525) + 1_013_904_223) >>> 0;
    const swap = current % (index + 1);
    const held = copy[index];
    const replacement = copy[swap];
    if (held === undefined || replacement === undefined) throw new Error('Shuffle index missing');
    copy[index] = replacement;
    copy[swap] = held;
  }
  return copy;
}

describe('adversarial multi-core traces', () => {
  test('a middle Byzantine proposer splits A/B across three voters without either pair committing', () => {
    const f = setup([0, 1, 2]);
    const trace = new Trace(f.context, honestKeys(f.fixture, [0, 2]));
    // Seat 0 is the elected round-one proposer. A nil quorum moves both honest
    // peers to round two, where seat 1 is legitimately elected proposer.
    for (const seat of [0, 2] as const) {
      trace.input(seat);
      trace.timeout(seat, 'propose', 1);
    }
    for (const seat of [0, 2] as const) {
      trace.deliver(trace.vote(seat === 0 ? 2 : 0, 1, 'prevote'), seat);
      trace.injectVote(seat, f.byzantineVote(1, 1, 'prevote', null));
    }
    for (const seat of [0, 2] as const) {
      trace.deliver(trace.vote(seat === 0 ? 2 : 0, 1, 'precommit'), seat);
      trace.injectVote(seat, f.byzantineVote(1, 1, 'precommit', null));
      trace.timeout(seat, 'precommit', 1);
      expect(trace.state(seat).round).toBe(2);
    }
    const a = f.byzantineProposal(2, 0);
    const b = f.byzantineProposal(2, 1);
    const hashA = entryHash(a.body.entry);
    const hashB = entryHash(b.body.entry);
    expect(hashA).not.toBe(hashB);
    trace.injectProposal(0, a);
    trace.injectProposal(2, b);
    trace.injectVote(0, f.byzantineVote(1, 2, 'prevote', hashA));
    trace.injectVote(2, f.byzantineVote(1, 2, 'prevote', hashB));
    trace.deliver(trace.vote(0, 2, 'prevote'), 2);
    trace.deliver(trace.vote(2, 2, 'prevote'), 0);
    for (const seat of [0, 2] as const) {
      expect(trace.state(seat).decision).toBeNull();
      expect(trace.state(seat).locked).toBeNull();
      expect(
        trace
          .state(seat)
          .votes.filter((vote) => vote.body.term === 2 && vote.body.phase === 'precommit'),
      ).toEqual([]);
    }
    expect(trace.effects.filter(({ effect }) => effect.kind === 'commit')).toHaveLength(0);
  });

  test('one hidden old certificate survives a later Byzantine conflicting attempt and honest restart', () => {
    const f = setup([0, 1, 2, 3]);
    const trace = new Trace(f.context, honestKeys(f.fixture, [0, 2, 3]));
    trace.propose(0, f.candidate(1, 0));
    const proposal = trace.broadcast(0, 'broadcast-proposal', 1);
    const hashA = entryHash(f.candidate(1, 0));
    trace.deliver(proposal, 2);
    const byzantinePrevote = f.byzantineVote(1, 1, 'prevote', hashA);
    for (const seat of [0, 2] as const) {
      trace.deliver(trace.vote(seat === 0 ? 2 : 0, 1, 'prevote'), seat);
      trace.injectVote(seat, byzantinePrevote);
      expect(trace.state(seat).locked?.hash).toBe(hashA);
    }
    const precommit0 = trace.vote(0, 1, 'precommit');
    const precommit2 = trace.vote(2, 1, 'precommit');
    const byzantinePrecommit = f.byzantineVote(1, 1, 'precommit', hashA);
    trace.deliver(precommit2, 0);
    trace.injectVote(0, byzantinePrecommit);
    const commit = trace.effects.find(({ from, effect }) => from === 0 && effect.kind === 'commit');
    if (!commit || commit.effect.kind !== 'commit') throw new Error('Hidden certificate missing');
    expect(entryHash(commit.effect.certified.entry)).toBe(hashA);
    expect(trace.state(2).decision).toBeNull();

    // Seat 3 sees a quorum of precommits, but no proposal, so it cannot decide yet.
    trace.deliver(precommit0, 3);
    trace.deliver(precommit2, 3);
    trace.injectVote(3, byzantinePrecommit);
    expect(trace.state(3).decision).toBeNull();
    expect(trace.state(3).timers.precommit).toBe(true);
    trace.timeout(3, 'precommit', 1);
    expect(trace.state(3).round).toBe(2);

    const b = f.byzantineProposal(2, 1);
    const hashB = entryHash(b.body.entry);
    trace.injectProposal(3, b);
    expect(
      trace.state(3).votes.find((vote) => vote.body.seat === 3 && vote.body.term === 2)?.body
        .valueHash,
    ).toBe(hashB);
    trace.injectProposal(2, b);
    trace.deliver(trace.vote(3, 2, 'prevote'), 2);
    expect(trace.state(2).round).toBe(2);
    const restored = value(restoreConsensusState(trace.state(2), f.context, 2));
    trace.states.set(2, restored);
    expect(restored.locked?.hash).toBe(hashA);
    expect(
      restored.votes.find(
        (vote) => vote.body.seat === 2 && vote.body.term === 2 && vote.body.phase === 'prevote',
      )?.body.valueHash,
    ).toBeNull();
    trace.injectVote(3, f.byzantineVote(1, 2, 'prevote', hashB));
    expect(trace.state(3).decision).toBeNull();
    expect(trace.state(2).decision).toBeNull();
    for (const seat of [2, 3] as const) {
      trace.apply(seat, receiveCommit(trace.state(seat), f.context, commit.effect.certified));
      expect(entryHash(trace.state(seat).decision?.entry ?? b.body.entry)).toBe(hashA);
    }
    const honestDecisions = ([0, 2, 3] as const).map((seat) => trace.state(seat).decision);
    expect(honestDecisions.every((decision) => decision !== null)).toBe(true);
    expect(
      new Set(honestDecisions.map((decision) => entryHash(decision?.entry ?? b.body.entry))),
    ).toEqual(new Set([hashA]));
  });

  test.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])(
    'a 2|2 partition pauses, then reordered duplicated honest messages heal (seed %i)',
    (seed) => {
      const f = setup([0, 1, 2, 3]);
      const trace = new Trace(f.context, honestKeys(f.fixture, [0, 1, 2, 3]));
      trace.propose(0, f.candidate(1));
      const proposal = trace.broadcast(0, 'broadcast-proposal', 1);
      trace.deliver(proposal, 1);
      trace.deliver(trace.vote(0, 1, 'prevote'), 1);
      trace.deliver(trace.vote(1, 1, 'prevote'), 0);
      for (const seat of [0, 1, 2, 3] as const) expect(trace.state(seat).decision).toBeNull();

      trace.deliver(proposal, 2);
      trace.deliver(proposal, 3);
      const prevotes = trace.outbox.filter(
        ({ effect }) => effect.kind === 'broadcast-vote' && effect.vote.body.phase === 'prevote',
      );
      const delivery = prevotes.flatMap((message) =>
        ([0, 1, 2, 3] as const)
          .filter((seat) => seat !== message.from)
          .map((to) => ({ message, to })),
      );
      for (const { message, to } of shuffle(delivery, seed)) {
        trace.deliver(message, to);
        trace.deliver(message, to);
      }
      const precommits = trace.outbox.filter(
        ({ effect }) => effect.kind === 'broadcast-vote' && effect.vote.body.phase === 'precommit',
      );
      expect(precommits).toHaveLength(4);
      const commitDelivery = precommits.flatMap((message) =>
        ([0, 1, 2, 3] as const)
          .filter((seat) => seat !== message.from)
          .map((to) => ({ message, to })),
      );
      for (const { message, to } of shuffle(commitDelivery, seed + 37)) {
        trace.deliver(message, to);
        trace.deliver(message, to);
      }
      const seats: Seat[] = [0, 1, 2, 3];
      const decisions = seats.map((seat) => trace.state(seat).decision);
      expect(decisions.every((decision) => decision !== null)).toBe(true);
      const hashes = decisions.map((decision) => {
        if (!decision) throw new Error('Honest peer did not commit');
        return entryHash(decision.entry);
      });
      expect(new Set(hashes).size).toBe(1);
      expect(trace.effects.filter(({ effect }) => effect.kind === 'commit')).toHaveLength(4);
    },
  );

  test('an honest nil prevote can later lock a value supported by valid quorum prevotes', () => {
    const f = setup([0, 1, 2, 3]);
    const trace = new Trace(f.context, honestKeys(f.fixture, [0, 1, 2, 3]));
    trace.input(3);
    trace.timeout(3, 'propose', 1);
    expect(trace.state(3).votes.find((vote) => vote.body.seat === 3)?.body.valueHash).toBeNull();
    trace.propose(0, f.candidate(1));
    const proposal = trace.broadcast(0, 'broadcast-proposal', 1);
    trace.deliver(proposal, 1);
    trace.deliver(proposal, 2);
    for (const sender of [0, 1, 2] as const) trace.deliver(trace.vote(sender, 1, 'prevote'), 3);
    expect(trace.state(3).locked).toBeNull();
    trace.deliver(proposal, 3);
    if (proposal.effect.kind !== 'broadcast-proposal') throw new Error('Proposal effect missing');
    const hash = entryHash(proposal.effect.proposal.body.entry);
    expect(trace.state(3).locked?.hash).toBe(hash);
    expect(
      trace.state(3).votes.find((vote) => vote.body.seat === 3 && vote.body.phase === 'prevote')
        ?.body.valueHash,
    ).toBeNull();
    expect(
      trace.state(3).votes.find((vote) => vote.body.seat === 3 && vote.body.phase === 'precommit')
        ?.body.valueHash,
    ).toBe(hash);
  });

  test('a buffered future proposal and two honest future hints trigger a local prevote after jump', () => {
    const f = setup([0, 1, 2, 3]);
    const trace = new Trace(f.context, honestKeys(f.fixture, [0, 1, 2, 3]));
    for (const seat of [0, 1, 2, 3] as const) {
      trace.input(seat);
      trace.timeout(seat, 'propose', 1);
    }
    const nilPrevotes = trace.outbox.filter(
      ({ effect }) => effect.kind === 'broadcast-vote' && effect.vote.body.phase === 'prevote',
    );
    for (const message of nilPrevotes)
      for (const seat of [0, 1, 2, 3] as const)
        if (seat !== message.from) trace.deliver(message, seat);
    const nilPrecommits = trace.outbox.filter(
      ({ effect }) => effect.kind === 'broadcast-vote' && effect.vote.body.phase === 'precommit',
    );
    expect(nilPrecommits).toHaveLength(4);
    for (const message of nilPrecommits)
      for (const seat of [0, 1, 2, 3] as const)
        if (seat !== message.from) trace.deliver(message, seat);
    for (const seat of [1, 2, 3] as const) {
      expect(trace.state(seat).timers.precommit).toBe(true);
      trace.timeout(seat, 'precommit', 1);
      expect(trace.state(seat).round).toBe(2);
    }
    trace.propose(1, f.candidate(2));
    const futureProposal = trace.broadcast(1, 'broadcast-proposal', 2);
    trace.deliver(futureProposal, 2);
    trace.deliver(futureProposal, 3);
    trace.deliver(futureProposal, 0);
    expect(trace.state(0).round).toBe(1);
    trace.deliver(trace.vote(2, 2, 'prevote'), 0);
    expect(trace.state(0).round).toBe(2);
    expect(
      trace
        .state(0)
        .votes.some(
          (vote) => vote.body.seat === 0 && vote.body.term === 2 && vote.body.phase === 'prevote',
        ),
    ).toBe(true);
  });
});

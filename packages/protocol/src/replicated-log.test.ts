import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Engine, Result, Seat, SystemInput } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import type { ConsensusState } from './consensus.js';
import { createConsensusState, openOwnedConsensusState } from './consensus.js';
import { entryHash, genesisDigest, genesisId, signEntry, signGenesis } from './genesis.js';
import { MemoryProtocolJournal } from './journal.js';
import { signCommand, stubEvidence } from './log.js';
import { decodeProtocolMessage, encodeProtocolMessage } from './messages.js';
import type { ProtocolMessage } from './messages.js';
import { advanceContext, proposerFor, signProposal, validateCertifiedEntry } from './proposal.js';
import type { CertifiedEntry, ProposalContext } from './proposal.js';
import { ReplicatedLog } from './replicated-log.js';
import { initialProposalContext, replayCertifiedPrefix, snapshotFromContext } from './replay.js';
import { fixtureAt, protocolFixture } from './testing/fixtures.js';
import { createVerifiedNetworkFixture } from './testing/verified-network-fixture.js';
import type { PeerId, ProtocolClock, Transport, Unsubscribe } from './transport.js';
import { signVote } from './votes.js';
import { signTradeProofRequest } from './trade-proof-delivery.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function mutateNonceMap(nonces: ReadonlyMap<Seat, number>): void {
  if (nonces instanceof Map) nonces.set(0, 999);
}

class PausableJournal extends MemoryProtocolJournal {
  pauseUpdates = false;
  pauseSafetyReadHeight: number | null = null;
  safetyWrites = 0;
  loads = 0;
  private notify: () => void = () => undefined;
  private release: () => void = () => undefined;
  readonly entered = new Promise<void>((resolve) => {
    this.notify = resolve;
  });
  private readonly resumed = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  private notifyRead: () => void = () => undefined;
  private releaseRead: () => void = () => undefined;
  readonly readEntered = new Promise<void>((resolve) => {
    this.notifyRead = resolve;
  });
  private readonly readResumed = new Promise<void>((resolve) => {
    this.releaseRead = resolve;
  });

  releaseWrite(): void {
    this.pauseUpdates = false;
    this.release();
  }

  releaseSafetyRead(): void {
    this.pauseSafetyReadHeight = null;
    this.releaseRead();
  }

  override async loadSafety(height: number) {
    if (this.pauseSafetyReadHeight === height) {
      this.notifyRead();
      await this.readResumed;
    }
    return super.loadSafety(height);
  }

  override load() {
    this.loads++;
    return super.load();
  }

  override async saveSafety(height: number, revision: number, bytes: Uint8Array): Promise<boolean> {
    this.safetyWrites++;
    if (this.pauseUpdates) {
      this.notify();
      await this.resumed;
    }
    return super.saveSafety(height, revision, bytes);
  }
}

class ManualClock implements ProtocolClock {
  private nextId = 1;
  private time = 0;
  readonly scheduled = new Map<number, () => void>();
  now(): number {
    return this.time;
  }
  advance(ms: number): void {
    this.time += ms;
  }
  setTimeout(callback: () => void, _delayMs: number): unknown {
    const id = this.nextId++;
    this.scheduled.set(id, callback);
    return id;
  }
  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.scheduled.delete(handle);
  }
  fireLatest(): void {
    const latest = [...this.scheduled].at(-1);
    if (!latest) throw new Error('No scheduled timeout');
    this.scheduled.delete(latest[0]);
    latest[1]();
  }
  fireFirst(): void {
    const first = this.scheduled.entries().next().value;
    if (!first) throw new Error('No scheduled timeout');
    this.scheduled.delete(first[0]);
    first[1]();
  }
  fire(handle: unknown): void {
    if (typeof handle !== 'number') throw new Error('Missing timer handle');
    const callback = this.scheduled.get(handle);
    if (!callback) throw new Error('Timer is not scheduled');
    this.scheduled.delete(handle);
    callback();
  }
}

class CapturingTransport implements Transport {
  readonly sent: ProtocolMessage[] = [];
  readonly disconnected: PeerId[] = [];
  private listener: ((from: PeerId, bytes: Uint8Array) => void) | null = null;
  constructor(
    readonly self: PeerId,
    private readonly connected: PeerId[] = [],
  ) {}
  peers(): PeerId[] {
    return [...this.connected];
  }
  send(_to: PeerId, bytes: Uint8Array): void {
    this.sent.push(value(decodeProtocolMessage(bytes)));
  }
  broadcast(bytes: Uint8Array): void {
    this.sent.push(value(decodeProtocolMessage(bytes)));
  }
  disconnect(peer: PeerId): void {
    this.disconnected.push(peer);
  }
  onMessage(listener: (from: PeerId, bytes: Uint8Array) => void): Unsubscribe {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  onPeerChange(_listener: (peer: PeerId, online: boolean) => void): Unsubscribe {
    return () => undefined;
  }
  inject(from: PeerId, message: unknown): void {
    this.listener?.(from, value(encodeProtocolMessage(message)));
  }
  injectBytes(from: PeerId, bytes: Uint8Array): void {
    this.listener?.(from, bytes);
  }
}

class FlakySubmitTransport extends CapturingTransport {
  failedSubmit = false;
  override broadcast(bytes: Uint8Array): void {
    if (!this.failedSubmit && value(decodeProtocolMessage(bytes)).t === 'SUBMIT') {
      this.failedSubmit = true;
      throw new Error('Temporary network send failure');
    }
    super.broadcast(bytes);
  }
}

class FailingRetransmitTransport extends CapturingTransport {
  submitBroadcasts = 0;
  override broadcast(bytes: Uint8Array): void {
    if (value(decodeProtocolMessage(bytes)).t === 'SUBMIT') {
      this.submitBroadcasts++;
      if (this.submitBroadcasts === 2) throw new Error('Temporary retransmit failure');
    }
    super.broadcast(bytes);
  }
}

function fourHumanFixture(): ReturnType<typeof protocolFixture> {
  const source = protocolFixture();
  const body = {
    ...source.body,
    seats: source.body.seats.map((seat) => ({
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
    signatures: source.identities.map((identity, index) =>
      signGenesis(body, fixtureAt(source.body.seats, index).seat, identity.secretKey),
    ),
  };
  return {
    ...source,
    body,
    genesis,
    entry: signEntry(
      { ...source.entry, payload: { kind: 'genesis', genesis } },
      fixtureAt(source.identities, 0).secretKey,
    ),
  };
}

describe('replicated certified log adapter', () => {
  test('proposal retries after a local validator exception neither accuse nor disconnect the proposer', async () => {
    const fixture = protocolFixture();
    const proposer = fixtureAt(fixture.identities, 0);
    const local = fixtureAt(fixture.identities, 1);
    const transport = new CapturingTransport(local.peerId);
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: {
          ...fixture.engine,
          validate() {
            throw new Error('Injected local validator failure');
          },
        },
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 1,
        secretKey: local.secretKey,
        transport,
        clock: new ManualClock(),
        journal: new MemoryProtocolJournal(),
      }),
    );
    const context = replica.getContext();
    // The signatures are authentic. A failed local validator cannot establish
    // whether this command is illegal, so it cannot justify an accusation.
    const signed = signCommand(
      {
        gameId: fixture.genesis.gameId,
        genesisDigest: context.membership.genesisDigest,
        seat: 0,
        nonce: 1,
        headSeq: 0,
        headHash: entryHash(context.log.head),
        command: { type: 'END_TURN' },
      },
      proposer.secretKey,
    );
    const entry = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(context.log.head),
        payload: { kind: 'command', signed },
        stateHash: context.log.head.stateHash,
        sequencer: proposer.peerId,
      },
      proposer.secretKey,
    );
    const proposal = signProposal(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: 0,
        entry,
        validRound: null,
        prevotes: [],
      },
      proposer.secretKey,
    );
    for (let retry = 0; retry < 8; retry++) {
      transport.inject(proposer.peerId, { t: 'PROPOSAL', proposal });
      // oxlint-disable-next-line no-await-in-loop -- Exercise actual transport retries after local validation fails.
      await replica.flush();
    }
    expect(transport.disconnected).toEqual([]);
    expect(transport.sent.some((message) => message.t === 'ACCUSE' || message.t === 'VOTE')).toBe(
      false,
    );
    expect(replica.getContext().log.head.seq).toBe(0);
    expect(replica.getContext().excludedProposers).toEqual([]);
    expect(replica['disposed']).toBe(false);
    const snapshot = value(replica['activeController']().snapshot());
    expect(snapshot.halted).toBeNull();
    expect(snapshot.provenOffender).toBeNull();
    replica.dispose();
  });

  test('bounds fresh invalid proposal variants from an elected proposer before they starve votes', async () => {
    const fixture = protocolFixture();
    const proposer = fixtureAt(fixture.identities, 0);
    const local = fixtureAt(fixture.identities, 1);
    const transport = new CapturingTransport(local.peerId);
    let derivations = 0;
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: {
          ...fixture.engine,
          apply(state, input) {
            derivations++;
            return fixture.engine.apply(state, input);
          },
        },
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 1,
        secretKey: local.secretKey,
        transport,
        clock: new ManualClock(),
        journal: new MemoryProtocolJournal(),
      }),
    );
    const context = replica.getContext();
    const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
    for (let variant = 0; variant < 8; variant++) {
      const entry = signEntry(
        {
          seq: 1,
          term: 1,
          prevHash: entryHash(context.log.head),
          payload: { kind: 'system', input, evidence: stubEvidence(context.log, input) },
          stateHash: variant.toString(16).padStart(64, '0'),
          sequencer: proposer.peerId,
        },
        proposer.secretKey,
      );
      transport.inject(proposer.peerId, {
        t: 'PROPOSAL',
        proposal: signProposal(
          {
            genesisDigest: context.membership.genesisDigest,
            epoch: 0,
            entry,
            validRound: null,
            prevotes: [],
          },
          proposer.secretKey,
        ),
      });
      // oxlint-disable-next-line no-await-in-loop -- Model a sender refilling the queue after each invalid proposal.
      await replica.flush();
    }
    expect(derivations).toBe(5);
    expect(transport.disconnected).toEqual([proposer.peerId]);
    expect(replica.getContext().log.head.seq).toBe(0);
    expect(replica['disposed']).toBe(false);
    expect(transport.sent.some((message) => message.t === 'VOTE')).toBe(false);
    replica.dispose();
  });

  test('rejects bad command proofs before queueing and cannot let them block a valid command', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const transport = new CapturingTransport(first.peerId);
    let checks = 0;
    let rejectAll = false;
    let rejectApply = false;
    let rejectInvariants = false;
    let throwValidate = false;
    let throwApply = false;
    const engine: Engine = {
      ...fixture.engine,
      validate(state, input) {
        if (throwValidate) throw new Error('Injected validator failure');
        return fixture.engine.validate(state, input);
      },
      apply: (state, input) => {
        if (throwApply) throw new Error('Injected reducer failure');
        return rejectApply
          ? failure('test-apply', 'Injected reducer rejection')
          : fixture.engine.apply(state, input);
      },
      checkInvariants: (state) =>
        rejectInvariants ? ['Injected invariant violation'] : fixture.engine.checkInvariants(state),
    };
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine,
        policy: {
          genesis: { allowStub: true },
          entry: {
            allowStub: true,
            verifyCommand: (signed) => {
              checks++;
              return !rejectAll && signed.body.evidence?.data === true
                ? success(undefined)
                : failure('test-bad-proof', 'Invalid command proof');
            },
          },
        },
        seat: 0,
        secretKey: first.secretKey,
        transport,
        clock: new ManualClock(),
        journal: new MemoryProtocolJournal(),
        systemInput: (context) => {
          if (context.log.head.seq !== 0) return null;
          const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
          return { input, evidence: stubEvidence(context.log, input) };
        },
      }),
    );
    const firstProposal = transport.sent.find((message) => message.t === 'PROPOSAL');
    if (firstProposal?.t !== 'PROPOSAL') throw new Error('Expected initial system proposal');
    const finishVotes = async (entry: typeof firstProposal.proposal.body.entry) => {
      const vote = (phase: 'prevote' | 'precommit') =>
        signVote(
          {
            genesisDigest: genesisDigest(fixture.genesis),
            epoch: 0,
            seat: 1,
            seq: entry.seq,
            term: entry.term,
            phase,
            valueHash: entryHash(entry),
          },
          second.secretKey,
        );
      transport.inject(second.peerId, { t: 'VOTE', vote: vote('prevote') });
      await replica.flush();
      transport.inject(second.peerId, { t: 'VOTE', vote: vote('precommit') });
      await replica.flush();
    };
    await finishVotes(firstProposal.proposal.body.entry);
    expect(replica.getContext().log.head.seq).toBe(1);
    const context = replica.getContext();
    const command = context.log.engine.getLegalCommands(context.log.state, 0).commands[0];
    if (!command) throw new Error('Expected a real legal setup command');
    const signed = (proof: boolean, nonce = 1) =>
      signCommand(
        {
          gameId: fixture.genesis.gameId,
          genesisDigest: context.membership.genesisDigest,
          seat: 0,
          nonce,
          headSeq: context.log.head.seq,
          headHash: entryHash(context.log.head),
          command,
          evidence: { protocol: 'test-proof', data: proof },
        },
        first.secretKey,
      );
    const bad = signed(false);
    expect(await replica.submit(bad)).toMatchObject({
      ok: false,
      error: { code: 'test-bad-proof' },
    });
    transport.inject(second.peerId, { t: 'SUBMIT', cmd: bad });
    await replica.flush();
    expect(replica['commands']).toEqual([]);
    expect(transport.sent.some((message) => message.t === 'ACCUSE')).toBe(false);
    const good = signed(true, 4);
    // Public command legality alone is insufficient. Admission must also run
    // the reducer and invariants before followers mark an input as available.
    rejectApply = true;
    expect(await replica.submit(good)).toMatchObject({ ok: false, error: { code: 'test-apply' } });
    rejectApply = false;
    rejectInvariants = true;
    expect(await replica.submit(good)).toMatchObject({ ok: false, error: { code: 'entry-state' } });
    transport.inject(second.peerId, { t: 'SUBMIT', cmd: signed(true, 1) });
    await replica.flush();
    expect(replica['commands']).toEqual([]);
    const afterInvariantFailure = checks;
    for (let retry = 0; retry < 6; retry++) {
      transport.inject(second.peerId, { t: 'SUBMIT', cmd: signed(true, 1) });
      // oxlint-disable-next-line no-await-in-loop -- Retries after a local fault must not spend more strikes or proof work.
      await replica.flush();
    }
    expect(checks).toBe(afterInvariantFailure);
    expect(transport.disconnected).toEqual([]);
    rejectInvariants = false;
    throwApply = true;
    expect(await replica.submit(good)).toMatchObject({
      ok: false,
      error: { code: 'entry-verification-failed' },
    });
    transport.inject(second.peerId, { t: 'SUBMIT', cmd: signed(true, 2) });
    await replica.flush();
    throwApply = false;
    throwValidate = true;
    expect(await replica.submit(good)).toMatchObject({
      ok: false,
      error: { code: 'entry-verification-failed' },
    });
    transport.inject(second.peerId, { t: 'SUBMIT', cmd: signed(true, 3) });
    await replica.flush();
    throwValidate = false;
    expect(replica['disposed']).toBe(false);
    expect(replica['commands']).toEqual([]);
    transport.inject(second.peerId, { t: 'SUBMIT', cmd: good });
    await replica.flush();
    expect(replica['commands']).toEqual([good]);
    const afterAdmission = checks;
    transport.inject(second.peerId, { t: 'SUBMIT', cmd: good });
    await replica.flush();
    expect(checks).toBe(afterAdmission);
    // Even a local policy change after admission cannot leave an invalid head item blocking the queue.
    rejectAll = true;
    expect(replica['candidate'](value(replica['activeController']().snapshot()))).toBeNull();
    expect(replica['commands']).toEqual([]);
    rejectAll = false;
    transport.inject(second.peerId, { t: 'SUBMIT', cmd: good });
    await replica.flush();
    const applied = value(
      fixture.engine.apply(context.log.state, { kind: 'command', seat: 0, command }),
    );
    const entry = signEntry(
      {
        seq: 2,
        term: 1,
        prevHash: entryHash(context.log.head),
        payload: { kind: 'command', signed: good },
        stateHash: toHex(hashValue(applied.state)),
        sequencer: second.peerId,
      },
      second.secretKey,
    );
    transport.inject(second.peerId, {
      t: 'PROPOSAL',
      proposal: signProposal(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          entry,
          validRound: null,
          prevotes: [],
        },
        second.secretKey,
      ),
    });
    await replica.flush();
    await finishVotes(entry);
    expect(replica.getContext().log.head.seq).toBe(2);
    expect(replica.getContext().excludedProposers).toEqual([]);
    // Honest retransmissions from the previous parent are cheap and are not strikes.
    const afterCommit = checks;
    for (let retry = 0; retry < 6; retry++) {
      transport.inject(second.peerId, { t: 'SUBMIT', cmd: bad });
      // oxlint-disable-next-line no-await-in-loop -- Model sequential retries, not queue overflow.
      await replica.flush();
    }
    expect(checks).toBe(afterCommit);
    expect(transport.disconnected).toEqual([]);
    const current = replica.getContext();
    const nextCommand = current.log.engine.getLegalCommands(current.log.state, 0).commands[0];
    if (!nextCommand) throw new Error('Expected the road after the setup settlement');
    const invalidProof = (nonce: number) =>
      signCommand(
        {
          ...good.body,
          nonce,
          headSeq: current.log.head.seq,
          headHash: entryHash(current.log.head),
          command: nextCommand,
          evidence: { protocol: 'test-proof', data: false },
        },
        first.secretKey,
      );
    // The bad proof, invariant and thrown validators used four strikes. One more failure
    // disconnects the sender, including when the callback uses its own error code.
    for (let retry = 0; retry < 8; retry++) {
      transport.inject(second.peerId, { t: 'SUBMIT', cmd: invalidProof(5 + retry) });
      // oxlint-disable-next-line no-await-in-loop -- Each fresh invalid value spends one strike before the next variant.
      await replica.flush();
    }
    expect(checks - afterCommit).toBe(1);
    expect(transport.disconnected).toEqual([second.peerId]);
    expect(replica['commands']).toEqual([]);
    expect(transport.sent.some((message) => message.t === 'ACCUSE')).toBe(false);
    replica.dispose();
  });

  test('one signed sender cannot evict another seat from pending command admission', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const transport = new CapturingTransport(first.peerId);
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: fixture.engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 0,
        secretKey: first.secretKey,
        transport,
        clock: new ManualClock(),
        journal: new MemoryProtocolJournal(),
      }),
    );
    const context = replica.getContext();
    const signed = (seat: 0 | 1, nonce: number) =>
      signCommand(
        {
          gameId: fixture.genesis.gameId,
          genesisDigest: context.membership.genesisDigest,
          seat,
          nonce,
          headSeq: 0,
          headHash: entryHash(context.log.head),
          command: { type: 'END_TURN' },
        },
        fixtureAt(fixture.identities, seat).secretKey,
      );
    // Admission runs after command validation; exercise its bounded queue directly.
    const otherSeat = signed(1, 1);
    expect(replica['rememberCommand'](otherSeat)).toBe(true);
    for (let nonce = 1; nonce <= 40; nonce++)
      expect(replica['rememberCommand'](signed(0, nonce))).toBe(nonce <= 4);
    expect(replica['commands'].map(({ body }) => [body.seat, body.nonce])).toEqual([
      [1, 1],
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
    ]);
    replica.dispose();
  });

  test('a forged local prevote embedded in an offender proposal cannot halt the honest voter', async () => {
    const fixture = protocolFixture();
    const offender = fixtureAt(fixture.identities, 0);
    const local = fixtureAt(fixture.identities, 1);
    const transport = new CapturingTransport(local.peerId);
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: fixture.engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 1,
        secretKey: local.secretKey,
        transport,
        clock: new ManualClock(),
        journal: new MemoryProtocolJournal(),
      }),
    );
    const context = replica.getContext();
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
      local.secretKey,
    );
    const entry = signEntry(
      {
        seq: 1,
        term: 3,
        prevHash: entryHash(context.log.head),
        payload: { kind: 'command', signed: invalidCommand },
        stateHash: context.log.head.stateHash,
        sequencer: offender.peerId,
      },
      offender.secretKey,
    );
    const forgedLocalVote = signVote(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: 0,
        seat: 1,
        seq: 1,
        term: 1,
        phase: 'prevote',
        valueHash: entryHash(entry),
      },
      offender.secretKey,
    );
    const proposal = signProposal(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: 0,
        entry,
        validRound: 1,
        prevotes: [forgedLocalVote],
      },
      offender.secretKey,
    );
    transport.inject(offender.peerId, { t: 'PROPOSAL', proposal });
    await replica.flush();
    expect(transport.sent.some((message) => message.t === 'ACCUSE')).toBe(true);
    const safety = replica['activeController']().snapshot();
    expect(value(safety).halted).toBeNull();
    expect(value(safety).pendingAccusation?.offender).toBe(0);
    replica.dispose();
  });

  test('gossips only authenticated objective invalid-command accusations without changing voters', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const transport = new CapturingTransport(second.peerId);
    const clock = new ManualClock();
    const journal = new MemoryProtocolJournal();
    const options = {
      genesisEntry: fixture.entry,
      engine: fixture.engine,
      policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
      seat: 1 as const,
      secretKey: second.secretKey,
      transport,
      clock,
      journal,
    };
    const replica = value(await ReplicatedLog.create(options));
    const context = replica.getContext();
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
      second.secretKey,
    );
    const entry = signEntry(
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
    const proposal = signProposal(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: 0,
        entry,
        validRound: null,
        prevotes: [],
      },
      first.secretKey,
    );
    transport.inject(first.peerId, { t: 'PROPOSAL', proposal });
    await replica.flush();
    const accusation = transport.sent.find((message) => message.t === 'ACCUSE');
    expect(accusation).toMatchObject({
      t: 'ACCUSE',
      control: {
        action: 'exclude-proposer',
        offender: 0,
        evidence: { kind: 'invalid-command' },
      },
    });
    expect(replica.getContext().membership.voters).toHaveLength(2);
    expect(replica.getContext().excludedProposers).toEqual([]);
    expect(replica.getContext().log.head.seq).toBe(0);

    clock.fireLatest();
    await replica.flush();
    const nilVote = (phase: 'prevote' | 'precommit') =>
      signVote(
        {
          genesisDigest: context.membership.genesisDigest,
          epoch: 0,
          seat: 0,
          seq: 1,
          term: 1,
          phase,
          valueHash: null,
        },
        first.secretKey,
      );
    transport.inject(first.peerId, { t: 'VOTE', vote: nilVote('prevote') });
    await replica.flush();
    transport.inject(first.peerId, { t: 'VOTE', vote: nilVote('precommit') });
    await replica.flush();
    clock.fireLatest();
    await replica.flush();
    expect(
      transport.sent.some(
        (message) =>
          message.t === 'PROPOSAL' && message.proposal.body.entry.payload.kind === 'control',
      ),
    ).toBe(true);

    const forged = signProposal(
      {
        ...proposal.body,
        entry: signEntry({ ...entry, stateHash: 'f'.repeat(64) }, first.secretKey),
      },
      second.secretKey,
    );
    transport.inject(first.peerId, { t: 'PROPOSAL', proposal: forged });
    await replica.flush();
    expect(transport.sent.filter((message) => message.t === 'ACCUSE')).toHaveLength(1);
    const beforeCrash = await journal.load();
    expect(beforeCrash).not.toBeNull();
    replica.dispose();
    const restartedTransport = new CapturingTransport(second.peerId);
    const restarted = value(
      await ReplicatedLog.restore({ ...options, transport: restartedTransport }),
    );
    await restarted.flush();
    expect(restartedTransport.sent.filter((message) => message.t === 'ACCUSE')).toEqual(
      transport.sent.filter((message) => message.t === 'ACCUSE'),
    );
    expect((await journal.load())?.safety.bytes).toEqual(beforeCrash?.safety.bytes);
    restarted.dispose();
  });

  test('restores and revalidates persisted equivocation evidence after an ACCUSE send crash', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const journal = new MemoryProtocolJournal();
    const clock = new ManualClock();
    const transport = new CapturingTransport(second.peerId);
    const options = {
      genesisEntry: fixture.entry,
      engine: fixture.engine,
      policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
      seat: 1 as const,
      secretKey: second.secretKey,
      transport,
      clock,
      journal,
    };
    const replica = value(await ReplicatedLog.create(options));
    const vote = (valueHash: string | null) =>
      signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat: 0,
          seq: 1,
          term: 1,
          phase: 'prevote',
          valueHash,
        },
        first.secretKey,
      );
    transport.inject(first.peerId, { t: 'VOTE', vote: vote(null) });
    transport.inject(first.peerId, { t: 'VOTE', vote: vote('a'.repeat(64)) });
    await replica.flush();
    expect(transport.sent.filter((message) => message.t === 'ACCUSE')).toHaveLength(1);
    const saved = await journal.load();
    expect(saved?.height).toBe(1);
    replica.dispose();

    const restartedTransport = new CapturingTransport(second.peerId);
    const restarted = value(
      await ReplicatedLog.restore({ ...options, transport: restartedTransport }),
    );
    await restarted.flush();
    expect(restartedTransport.sent.filter((message) => message.t === 'ACCUSE')).toEqual(
      transport.sent.filter((message) => message.t === 'ACCUSE'),
    );
    expect((await journal.load())?.height).toBe(1);
    expect(restarted.getContext().excludedProposers).toEqual([]);
    restarted.dispose();
  });

  test('retains an accepted peer accusation before gossip and replays it after restart', async () => {
    const fixture = fourHumanFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const local = fixtureAt(fixture.identities, 2);
    const journal = new MemoryProtocolJournal();
    const transport = new CapturingTransport(local.peerId);
    const options = {
      genesisEntry: fixture.entry,
      engine: fixture.engine,
      policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
      seat: 2 as const,
      secretKey: local.secretKey,
      transport,
      clock: new ManualClock(),
      journal,
    };
    const replica = value(await ReplicatedLog.create(options));
    const vote = (valueHash: string | null) =>
      signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat: 0,
          seq: 1,
          term: 1,
          phase: 'prevote',
          valueHash,
        },
        first.secretKey,
      );
    const control = {
      kind: 'control' as const,
      action: 'exclude-proposer' as const,
      offender: 0 as const,
      evidence: {
        kind: 'vote-equivocation' as const,
        first: vote(null),
        second: vote('a'.repeat(64)),
      },
    };
    transport.inject(second.peerId, { t: 'ACCUSE', control });
    await replica.flush();
    expect(transport.sent.filter((message) => message.t === 'ACCUSE')).toEqual([
      { t: 'ACCUSE', control },
    ]);
    const beforeCrash = await journal.load();
    replica.dispose();

    const restartedTransport = new CapturingTransport(local.peerId);
    const restarted = value(
      await ReplicatedLog.restore({ ...options, transport: restartedTransport }),
    );
    await restarted.flush();
    expect(restartedTransport.sent.filter((message) => message.t === 'ACCUSE')).toEqual([
      { t: 'ACCUSE', control },
    ]);
    expect((await journal.load())?.safety.bytes).toEqual(beforeCrash?.safety.bytes);
    expect(restarted.getContext().excludedProposers).toEqual([]);
    restarted.dispose();
  });

  test('carries a first proof across a gameplay commit and durably halts on a second offender', async () => {
    const fixture = fourHumanFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const local = fixtureAt(fixture.identities, 2);
    const journal = new MemoryProtocolJournal();
    const transport = new CapturingTransport(local.peerId);
    const options = {
      genesisEntry: fixture.entry,
      engine: fixture.engine,
      policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
      seat: 2 as const,
      secretKey: local.secretKey,
      transport,
      clock: new ManualClock(),
      journal,
    };
    const replica = value(await ReplicatedLog.create(options));
    const accusation = (seat: 0 | 1, seq: number) => {
      const owner = fixtureAt(fixture.identities, seat);
      const vote = (valueHash: string | null) =>
        signVote(
          {
            genesisDigest: genesisDigest(fixture.genesis),
            epoch: 0,
            seat,
            seq,
            term: 1,
            phase: 'prevote',
            valueHash,
          },
          owner.secretKey,
        );
      return {
        kind: 'control' as const,
        action: 'exclude-proposer' as const,
        offender: seat,
        evidence: {
          kind: 'vote-equivocation' as const,
          first: vote(null),
          second: vote('a'.repeat(64)),
        },
      };
    };
    transport.inject(second.peerId, { t: 'ACCUSE', control: accusation(0, 1) });
    await replica.flush();

    const before = replica.getContext();
    const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
    const applied = value(fixture.engine.apply(before.log.state, input));
    const entry = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(before.log.head),
        payload: { kind: 'system', input, evidence: stubEvidence(before.log, input) },
        stateHash: toHex(hashValue(applied.state)),
        sequencer: first.peerId,
      },
      first.secretKey,
    );
    const hash = entryHash(entry);
    const certificate = [0, 1, 3].map((seat) =>
      signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat: fixtureAt(fixture.body.seats, seat).seat,
          seq: 1,
          term: 1,
          phase: 'precommit',
          valueHash: hash,
        },
        fixtureAt(fixture.identities, seat).secretKey,
      ),
    );
    transport.inject(second.peerId, { t: 'COMMIT', certified: { entry, certificate } });
    await replica.flush();
    expect(replica.getContext().log.head.seq).toBe(1);
    expect(replica.getContext().excludedProposers).toEqual([]);
    replica.dispose();

    const restartedTransport = new CapturingTransport(local.peerId);
    const restarted = value(
      await ReplicatedLog.restore({ ...options, transport: restartedTransport }),
    );
    restartedTransport.inject(first.peerId, { t: 'ACCUSE', control: accusation(1, 2) });
    await restarted.flush();
    const savedHalt = await journal.load();
    expect(savedHalt?.height).toBe(2);
    expect(restarted.getContext().log.head.seq).toBe(1);
    restarted.dispose();

    const again = value(
      await ReplicatedLog.restore({
        ...options,
        transport: new CapturingTransport(local.peerId),
      }),
    );
    expect((await journal.load())?.safety.bytes).toEqual(savedHalt?.safety.bytes);
    expect(
      await again.submit(
        signCommand(
          {
            gameId: fixture.genesis.gameId,
            genesisDigest: genesisDigest(fixture.genesis),
            seat: 2,
            nonce: 1,
            headSeq: 1,
            headHash: entryHash(entry),
            command: { type: 'END_TURN' },
          },
          local.secretKey,
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: 'replica-halted' } });
    again.dispose();

    const retained = await journal.load();
    if (!retained) throw new Error('Missing retained voting record');
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The journal record was already verified on restore above.
    const state = canonicalDecode(retained.safety.bytes) as ConsensusState;
    if (!state.provenOffender) throw new Error('Missing retained first-offender proof');
    expect(
      await journal.saveSafety(
        retained.height,
        retained.safety.revision,
        canonicalEncode({
          ...state,
          provenOffender: { ...state.provenOffender, parentHash: 'f'.repeat(64) },
        }),
      ),
    ).toBe(true);
    expect(
      await ReplicatedLog.restore({
        ...options,
        transport: new CapturingTransport(local.peerId),
      }),
    ).toMatchObject({ ok: false, error: { code: 'consensus-restore' } });
  });

  test('certifies an old first-offender proof only against its replayed historical parent', async () => {
    const fixture = fourHumanFixture();
    const policy = { genesis: { allowStub: true }, entry: { allowStub: true } };
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const initial = value(initialProposalContext(fixture.entry, fixture.engine, policy));
    const proofVote = (hash: string | null) =>
      signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat: 0,
          seq: 1,
          term: 1,
          phase: 'prevote',
          valueHash: hash,
        },
        first.secretKey,
      );
    const control = {
      kind: 'control' as const,
      action: 'exclude-proposer' as const,
      offender: 0 as const,
      evidence: {
        kind: 'vote-equivocation' as const,
        first: proofVote(null),
        second: proofVote('a'.repeat(64)),
      },
    };
    const precommit = (seq: number, hash: string) =>
      [0, 1, 3].map((index) =>
        signVote(
          {
            genesisDigest: genesisDigest(fixture.genesis),
            epoch: 0,
            seat: fixtureAt(fixture.body.seats, index).seat,
            seq,
            term: 1,
            phase: 'precommit',
            valueHash: hash,
          },
          fixtureAt(fixture.identities, index).secretKey,
        ),
      );
    const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
    const state = value(fixture.engine.apply(initial.log.state, input));
    const gameplay = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(initial.log.head),
        payload: { kind: 'system', input, evidence: stubEvidence(initial.log, input) },
        stateHash: toHex(hashValue(state.state)),
        sequencer: first.peerId,
      },
      first.secretKey,
    );
    const firstCertified = { entry: gameplay, certificate: precommit(1, entryHash(gameplay)) };
    const current = value(
      replayCertifiedPrefix(fixture.entry, [firstCertified], fixture.engine, policy),
    );
    const exclusion = signEntry(
      {
        seq: 2,
        term: 1,
        prevHash: entryHash(gameplay),
        payload: control,
        stateHash: gameplay.stateHash,
        sequencer: second.peerId,
      },
      second.secretKey,
    );
    const secondCertified = { entry: exclusion, certificate: precommit(2, entryHash(exclusion)) };
    expect(current.context.excludedProposers).toEqual([]);
    const replayed = value(
      replayCertifiedPrefix(
        fixture.entry,
        [firstCertified, secondCertified],
        fixture.engine,
        policy,
      ),
    );
    expect(replayed.context.excludedProposers).toEqual([0]);
    expect(replayed.context.membership.voters).toHaveLength(4);

    // A lagging peer never saw the ACCUSE, only the certified entries.
    const local = fixtureAt(fixture.identities, 2);
    const journal = new MemoryProtocolJournal();
    const transport = new CapturingTransport(local.peerId);
    const options = {
      genesisEntry: fixture.entry,
      engine: fixture.engine,
      policy,
      seat: 2 as const,
      secretKey: local.secretKey,
      transport,
      clock: new ManualClock(),
      journal,
    };
    const lagging = value(await ReplicatedLog.create(options));
    transport.inject(second.peerId, {
      t: 'SYNC_RES',
      genesisDigest: genesisDigest(fixture.genesis),
      entries: [firstCertified, secondCertified],
      more: false,
    });
    await lagging.flush();
    expect(lagging.getContext().log.head.seq).toBe(2);
    expect(lagging.getContext().excludedProposers).toEqual([0]);
    lagging.dispose();
    const restoredTransport = new CapturingTransport(local.peerId);
    const restored = value(
      await ReplicatedLog.restore({ ...options, transport: restoredTransport }),
    );
    expect(restored.getContext().excludedProposers).toEqual([0]);
    const conflicting = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(fixture.entry),
        payload: control,
        stateHash: fixture.entry.stateHash,
        sequencer: first.peerId,
      },
      first.secretKey,
    );
    restoredTransport.inject(second.peerId, {
      t: 'COMMIT',
      certified: { entry: conflicting, certificate: precommit(1, entryHash(conflicting)) },
    });
    await restored.flush();
    restored.dispose();
    const terminal = value(
      await ReplicatedLog.restore({
        ...options,
        transport: new CapturingTransport(local.peerId),
      }),
    );
    expect(
      await terminal.submit(
        signCommand(
          {
            gameId: fixture.genesis.gameId,
            genesisDigest: genesisDigest(fixture.genesis),
            seat: 2,
            nonce: 1,
            headSeq: 2,
            headHash: entryHash(exclusion),
            command: { type: 'END_TURN' },
          },
          local.secretKey,
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: 'replica-halted' } });
    terminal.dispose();
  });

  test('commits a retained historical accusation after ordinary gameplay won the first height', async () => {
    const fixture = fourHumanFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const local = fixtureAt(fixture.identities, 2);
    const transport = new CapturingTransport(local.peerId);
    const journal = new MemoryProtocolJournal();
    let replayCreates = 0;
    let proofChecks = 0;
    const engine: Engine = {
      ...fixture.engine,
      createGame(config, seed) {
        replayCreates++;
        return fixture.engine.createGame(config, seed);
      },
      checkInvariants(state) {
        proofChecks++;
        return fixture.engine.checkInvariants(state);
      },
    };
    const options = {
      genesisEntry: fixture.entry,
      engine,
      policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
      seat: 2 as const,
      secretKey: local.secretKey,
      transport,
      clock: new ManualClock(),
      journal,
    };
    const replica = value(await ReplicatedLog.create(options));
    const digest = genesisDigest(fixture.genesis);
    const vote = (
      seat: 0 | 1 | 2 | 3,
      seq: number,
      phase: 'prevote' | 'precommit',
      hash: string | null,
    ) =>
      signVote(
        { genesisDigest: digest, epoch: 0, seat, seq, term: 1, phase, valueHash: hash },
        fixtureAt(fixture.identities, seat).secretKey,
      );
    const control = {
      kind: 'control' as const,
      action: 'exclude-proposer' as const,
      offender: 0 as const,
      evidence: {
        kind: 'vote-equivocation' as const,
        first: vote(0, 1, 'prevote', null),
        second: vote(0, 1, 'prevote', 'a'.repeat(64)),
      },
    };
    transport.inject(fixtureAt(fixture.identities, 3).peerId, { t: 'ACCUSE', control });
    await replica.flush();
    const before = replica.getContext();
    const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
    const applied = value(fixture.engine.apply(before.log.state, input));
    const gameplay = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(before.log.head),
        payload: { kind: 'system', input, evidence: stubEvidence(before.log, input) },
        stateHash: toHex(hashValue(applied.state)),
        sequencer: first.peerId,
      },
      first.secretKey,
    );
    const certificate = (seq: number, hash: string) =>
      ([0, 1, 3] as const).map((seat) => vote(seat, seq, 'precommit', hash));
    transport.inject(second.peerId, {
      t: 'COMMIT',
      certified: { entry: gameplay, certificate: certificate(1, entryHash(gameplay)) },
    });
    await replica.flush();
    expect(replica.getContext().log.head.seq).toBe(1);
    expect(transport.sent.filter((message) => message.t === 'ACCUSE')).toHaveLength(2);
    const invalidHistoricalProposal = (index: number) => {
      const term = 1 + index * 4;
      const badControl = {
        ...control,
        evidence: {
          ...control.evidence,
          second: signVote({ ...control.evidence.second.body, term: index + 2 }, first.secretKey),
        },
      };
      const invalidEntry = signEntry(
        {
          seq: 2,
          term,
          prevHash: entryHash(gameplay),
          payload: badControl,
          stateHash: gameplay.stateHash,
          sequencer: second.peerId,
        },
        second.secretKey,
      );
      return signProposal(
        {
          genesisDigest: digest,
          epoch: 0,
          entry: invalidEntry,
          validRound: null,
          prevotes: [],
        },
        second.secretKey,
      );
    };
    const firstInvalid = invalidHistoricalProposal(0);
    const badSignature = signProposal(firstInvalid.body, first.secretKey);
    const budgetBeforeBadSignature = replica['expensiveByPeer'].get(second.peerId)?.seen.size ?? 0;
    transport.inject(second.peerId, { t: 'PROPOSAL', proposal: badSignature });
    await replica.flush();
    expect(replica['expensiveByPeer'].get(second.peerId)?.seen.size ?? 0).toBe(
      budgetBeforeBadSignature,
    );
    transport.inject(second.peerId, { t: 'PROPOSAL', proposal: firstInvalid });
    await replica.flush();
    const afterFirstReplay = replayCreates;
    const afterFirstCheck = proofChecks;
    transport.inject(second.peerId, { t: 'PROPOSAL', proposal: firstInvalid });
    await replica.flush();
    expect(replayCreates).toBe(afterFirstReplay);
    expect(proofChecks).toBe(afterFirstCheck);
    for (let index = 1; index < 3; index++) {
      transport.inject(second.peerId, {
        t: 'PROPOSAL',
        proposal: invalidHistoricalProposal(index),
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each attack arrives after the prior replay settles.
      await replica.flush();
    }
    const afterBudget = replayCreates;
    const checksAfterBudget = proofChecks;
    expect(checksAfterBudget).toBeGreaterThan(afterFirstCheck);
    for (let index = 3; index < 7; index++) {
      transport.inject(second.peerId, {
        t: 'PROPOSAL',
        proposal: invalidHistoricalProposal(index),
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Keep the sender's flood distinct from queue overflow.
      await replica.flush();
    }
    expect(replayCreates).toBe(afterBudget);
    expect(proofChecks).toBe(checksAfterBudget);
    const exclusion = signEntry(
      {
        seq: 2,
        term: 1,
        prevHash: entryHash(gameplay),
        payload: control,
        stateHash: gameplay.stateHash,
        sequencer: second.peerId,
      },
      second.secretKey,
    );
    transport.inject(second.peerId, {
      t: 'COMMIT',
      certified: { entry: exclusion, certificate: certificate(2, entryHash(exclusion)) },
    });
    await replica.flush();
    expect(replica.getContext().log.head.seq).toBe(2);
    expect(replica.getContext().excludedProposers).toEqual([0]);
    expect(replica.getContext().membership.voters).toHaveLength(4);

    // The already-excluded offender remains a certified voter and may replay old proof.
    transport.inject(first.peerId, { t: 'ACCUSE', control });
    await replica.flush();
    expect(value(replica['activeController']().snapshot()).pendingAccusation).toBeNull();
    expect(value(replica['activeController']().snapshot()).halted).toBeNull();

    const afterAccusation = replica.getContext();
    const setupCommand = afterAccusation.log.engine.getLegalCommands(afterAccusation.log.state, 0)
      .commands[0];
    if (!setupCommand) throw new Error('Expected a legal setup command after offender exclusion');
    const signed = signCommand(
      {
        gameId: fixture.genesis.gameId,
        genesisDigest: digest,
        seat: 0,
        nonce: 1,
        headSeq: 2,
        headHash: entryHash(afterAccusation.log.head),
        command: setupCommand,
      },
      first.secretKey,
    );
    const ordinaryApplied = value(
      fixture.engine.apply(afterAccusation.log.state, {
        kind: 'command',
        seat: 0,
        command: setupCommand,
      }),
    );
    const proposerSeat = proposerFor(
      3,
      1,
      afterAccusation.membership,
      afterAccusation.excludedProposers,
    ).seat;
    const proposer = fixtureAt(fixture.identities, proposerSeat);
    const ordinary = signEntry(
      {
        seq: 3,
        term: 1,
        prevHash: entryHash(afterAccusation.log.head),
        payload: { kind: 'command', signed },
        stateHash: toHex(hashValue(ordinaryApplied.state)),
        sequencer: proposer.peerId,
      },
      proposer.secretKey,
    );
    const ordinaryHash = entryHash(ordinary);
    const ordinaryCertificate = certificate(3, ordinaryHash);
    const locallyChecked = validateCertifiedEntry(
      { entry: ordinary, certificate: ordinaryCertificate },
      afterAccusation,
    );
    if (!locallyChecked.ok)
      throw new Error(`Test fixture commit invalid: ${locallyChecked.error.code}`);
    expect(replica['blockedPeers'].has(second.peerId)).toBe(false);
    transport.inject(second.peerId, {
      t: 'COMMIT',
      certified: { entry: ordinary, certificate: ordinaryCertificate },
    });
    await replica.flush();
    expect(replica.getContext().log.head.seq).toBe(3);
    expect(value(replica['activeController']().snapshot()).pendingAccusation).toBeNull();
    for (const hash of ['a'.repeat(64), 'b'.repeat(64)]) {
      transport.inject(first.peerId, {
        t: 'VOTE',
        vote: vote(0, 4, 'prevote', hash),
      });
      // Equivocation detection runs only after each vote is persisted in order.
      // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential vote evidence is the case under test.
      await replica.flush();
    }
    expect(value(replica['activeController']().snapshot()).pendingAccusation).toBeNull();
    expect(value(replica['activeController']().snapshot()).halted).toBeNull();

    const saved = await journal.load();
    if (!saved) throw new Error('Missing exclusion journal');
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test deliberately injects a stale persisted field into a decoded safety snapshot.
    const safety = canonicalDecode(saved.safety.bytes) as ConsensusState;
    expect(
      await journal.saveSafety(
        saved.height,
        saved.safety.revision,
        canonicalEncode({ ...safety, pendingAccusation: control }),
      ),
    ).toBe(true);
    replica.dispose();
    const restored = value(
      await ReplicatedLog.restore({
        ...options,
        transport: new CapturingTransport(local.peerId),
      }),
    );
    expect(restored.getContext().excludedProposers).toEqual([0]);
    expect(value(restored['activeController']().snapshot()).pendingAccusation).toBeNull();
    expect((await journal.load())?.safety.revision).toBe(saved.safety.revision + 2);
    restored.dispose();
  });

  test('halts when objective evidence implicates two distinct voters', async () => {
    const fixture = fourHumanFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const local = fixtureAt(fixture.identities, 2);
    const transport = new CapturingTransport(local.peerId);
    const statuses: string[] = [];
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: fixture.engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 2,
        secretKey: local.secretKey,
        transport,
        clock: new ManualClock(),
        journal: new MemoryProtocolJournal(),
        onStatus: (status) => {
          if (status.kind === 'halted') statuses.push(status.code);
        },
      }),
    );
    const evidenceFor = (seat: 0 | 1) => {
      const owner = fixtureAt(fixture.identities, seat);
      const vote = (valueHash: string | null) =>
        signVote(
          {
            genesisDigest: genesisDigest(fixture.genesis),
            epoch: 0,
            seat,
            seq: 1,
            term: 1,
            phase: 'prevote',
            valueHash,
          },
          owner.secretKey,
        );
      return {
        kind: 'control' as const,
        action: 'exclude-proposer' as const,
        offender: seat,
        evidence: {
          kind: 'vote-equivocation' as const,
          first: vote(null),
          second: vote('a'.repeat(64)),
        },
      };
    };
    transport.inject(first.peerId, { t: 'ACCUSE', control: evidenceFor(0) });
    await replica.flush();
    expect(statuses).toEqual([]);
    expect(replica.getContext().membership.voters).toHaveLength(4);
    transport.inject(second.peerId, { t: 'ACCUSE', control: evidenceFor(1) });
    await replica.flush();
    expect(statuses).toContain('replica-fault-limit');
    expect(replica.getContext().log.head.seq).toBe(0);
  });

  test('halts durably when peer accusation contains an unrecorded local signature', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const journal = new MemoryProtocolJournal();
    const transport = new FlakySubmitTransport(first.peerId);
    const options = {
      genesisEntry: fixture.entry,
      engine: fixture.engine,
      policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
      seat: 0 as const,
      secretKey: first.secretKey,
      transport,
      clock: new ManualClock(),
      journal,
    };
    const replica = value(await ReplicatedLog.create(options));
    const vote = (valueHash: string | null) =>
      signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat: 0,
          seq: 1,
          term: 1,
          phase: 'prevote',
          valueHash,
        },
        first.secretKey,
      );
    transport.inject(second.peerId, {
      t: 'ACCUSE',
      control: {
        kind: 'control',
        action: 'exclude-proposer',
        offender: 0,
        evidence: {
          kind: 'vote-equivocation',
          first: vote(null),
          second: vote('a'.repeat(64)),
        },
      },
    });
    await replica.flush();
    expect(transport.sent.some((message) => message.t === 'ACCUSE')).toBe(false);
    replica.dispose();
    const restarted = value(
      await ReplicatedLog.restore({
        ...options,
        transport: new CapturingTransport(first.peerId),
      }),
    );
    expect(
      await restarted.submit(
        signCommand(
          {
            gameId: fixture.genesis.gameId,
            genesisDigest: genesisDigest(fixture.genesis),
            seat: 0,
            nonce: 1,
            headSeq: 0,
            headHash: entryHash(fixture.entry),
            command: { type: 'END_TURN' },
          },
          first.secretKey,
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: 'replica-halted' } });
    restarted.dispose();
  });

  test('bounds ingress and disconnects a repeatedly malformed certified peer', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const transport = new CapturingTransport(first.peerId);
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: fixture.engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 0,
        secretKey: first.secretKey,
        transport,
        clock: new ManualClock(),
        journal: new MemoryProtocolJournal(),
      }),
    );
    const malformed = new TextEncoder().encode('{not-json');
    for (let index = 0; index < 4; index += 1) {
      transport.injectBytes(second.peerId, malformed);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each strike must drain before checking the threshold.
      await replica.flush();
    }
    expect(transport.disconnected).toEqual([]);
    transport.inject(second.peerId, {
      t: 'VOTE',
      vote: signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat: 1,
          seq: 1,
          term: 1,
          phase: 'prevote',
          valueHash: null,
        },
        first.secretKey,
      ),
    });
    await replica.flush();
    expect(transport.disconnected).toEqual([second.peerId]);
    transport.injectBytes(second.peerId, malformed);
    await replica.flush();
    expect(transport.disconnected).toEqual([second.peerId]);
    replica.dispose();
  });

  test('bounds expensive peer replay requests while a legal submitted command still commits', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    let replayCreates = 0;
    const engine: Engine = {
      ...fixture.engine,
      createGame(config, seed) {
        replayCreates++;
        return fixture.engine.createGame(config, seed);
      },
    };
    const transport = new FlakySubmitTransport(first.peerId, [second.peerId]);
    const clock = new ManualClock();
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 0,
        secretKey: first.secretKey,
        transport,
        clock,
        journal: new MemoryProtocolJournal(),
        systemInput: (context) => {
          if (context.log.head.seq !== 0) return null;
          const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
          return { input, evidence: stubEvidence(context.log, input) };
        },
      }),
    );
    await replica.flush();
    const initial = transport.sent.find((message) => message.t === 'PROPOSAL');
    if (initial?.t !== 'PROPOSAL') throw new Error('Missing initial proposal');
    const initialHash = entryHash(initial.proposal.body.entry);
    const vote = (
      seat: 0 | 1,
      seq: number,
      phase: 'prevote' | 'precommit',
      valueHash: string | null,
      term = 1,
    ) =>
      signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat,
          seq,
          term,
          phase,
          valueHash,
        },
        fixtureAt(fixture.identities, seat).secretKey,
      );
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 1, 'prevote', initialHash) });
    await replica.flush();
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 1, 'precommit', initialHash) });
    await replica.flush();
    expect(replica.getContext().log.head.seq).toBe(1);

    const beforeRequests = replayCreates;
    const snapshotRequest = {
      t: 'SNAPSHOT_REQ' as const,
      genesisDigest: genesisDigest(fixture.genesis),
      atSeq: 1,
    };
    transport.inject(second.peerId, snapshotRequest);
    await replica.flush();
    expect(replayCreates).toBe(beforeRequests + 1);
    transport.inject(second.peerId, snapshotRequest);
    await replica.flush();
    expect(replayCreates).toBe(beforeRequests + 1);
    const accusationFor = (term: number) => {
      const sameVote = vote(1, 2, 'prevote', null, term);
      return {
        t: 'ACCUSE',
        control: {
          kind: 'control',
          action: 'exclude-proposer',
          offender: 1,
          evidence: { kind: 'vote-equivocation', first: sameVote, second: sameVote },
        },
      };
    };
    transport.inject(second.peerId, accusationFor(1));
    await replica.flush();
    const afterFirstAccusation = replayCreates;
    transport.inject(second.peerId, accusationFor(1));
    await replica.flush();
    expect(replayCreates).toBe(afterFirstAccusation);
    for (let term = 2; term <= 12; term++) {
      transport.inject(second.peerId, accusationFor(term));
      // oxlint-disable-next-line eslint/no-await-in-loop -- A streaming peer refills the bounded queue after each request.
      await replica.flush();
    }
    expect(replayCreates).toBeLessThanOrEqual(beforeRequests + 3);
    clock.advance(10_000);
    transport.inject(second.peerId, snapshotRequest);
    await replica.flush();
    expect(replayCreates).toBe(beforeRequests + 4);

    const before = replica.getContext();
    const command = before.log.engine.getLegalCommands(before.log.state, 0).commands[0];
    if (!command) throw new Error('Expected a legal setup command');
    const signed = signCommand(
      {
        gameId: fixture.genesis.gameId,
        genesisDigest: before.membership.genesisDigest,
        seat: 0,
        nonce: 1,
        headSeq: 1,
        headHash: entryHash(before.log.head),
        command,
      },
      first.secretKey,
    );
    let settled = false;
    const submitted = replica.submit(signed).then((result) => {
      settled = true;
      return result;
    });
    await replica.flush();
    expect(transport.failedSubmit).toBe(true);
    expect(settled).toBe(false);
    const applied = value(engine.apply(before.log.state, { kind: 'command', seat: 0, command }));
    const entry = signEntry(
      {
        seq: 2,
        term: 1,
        prevHash: entryHash(before.log.head),
        payload: { kind: 'command', signed },
        stateHash: toHex(hashValue(applied.state)),
        sequencer: second.peerId,
      },
      second.secretKey,
    );
    const proposal = signProposal(
      {
        genesisDigest: before.membership.genesisDigest,
        epoch: 0,
        entry,
        validRound: null,
        prevotes: [],
      },
      second.secretKey,
    );
    const hash = entryHash(entry);
    transport.inject(second.peerId, { t: 'PROPOSAL', proposal });
    await replica.flush();
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 2, 'prevote', hash) });
    await replica.flush();
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 2, 'precommit', hash) });
    await replica.flush();
    expect(await submitted).toMatchObject({ ok: true });
    expect(settled).toBe(true);
    expect(replica.getContext().log.head.seq).toBe(2);

    const beforeForged = replayCreates;
    const old = fixtureAt(replica.getEntries(), 0);
    clock.advance(10_000);
    const budgetBeforeInvalidOldCommit =
      replica['expensiveByPeer'].get(second.peerId)?.seen.size ?? 0;
    const conflicting = signEntry(
      { ...old.entry, stateHash: 'f'.repeat(64), sequencer: second.peerId },
      second.secretKey,
    );
    transport.inject(second.peerId, {
      t: 'COMMIT',
      certified: { entry: conflicting, certificate: old.certificate },
    });
    await replica.flush();
    expect(replica['expensiveByPeer'].get(second.peerId)?.seen.size ?? 0).toBe(
      budgetBeforeInvalidOldCommit,
    );
    expect(replayCreates).toBe(beforeForged);
    const syncs = transport.sent.filter((message) => message.t === 'SYNC_REQ').length;
    transport.inject(second.peerId, {
      t: 'SYNC_RES',
      genesisDigest: genesisDigest(fixture.genesis),
      entries: [old],
      more: true,
    });
    await replica.flush();
    expect(transport.sent.filter((message) => message.t === 'SYNC_REQ')).toHaveLength(syncs);
    const future = signEntry(
      {
        ...old.entry,
        seq: 4,
        prevHash: 'a'.repeat(64),
        sequencer: second.peerId,
      },
      second.secretKey,
    );
    const futureHash = entryHash(future);
    transport.inject(second.peerId, {
      t: 'SYNC_RES',
      genesisDigest: genesisDigest(fixture.genesis),
      entries: [
        {
          entry: future,
          certificate: [vote(0, 4, 'precommit', futureHash), vote(1, 4, 'precommit', futureHash)],
        },
      ],
      more: true,
    });
    await replica.flush();
    expect(transport.sent.filter((message) => message.t === 'SYNC_REQ')).toHaveLength(syncs + 1);
    const authenticatedConflict = signEntry(
      { ...old.entry, stateHash: 'e'.repeat(64), sequencer: second.peerId },
      second.secretKey,
    );
    const authenticatedConflictHash = entryHash(authenticatedConflict);
    clock.advance(10_000);
    transport.inject(second.peerId, {
      t: 'COMMIT',
      certified: {
        entry: authenticatedConflict,
        certificate: [
          vote(0, 1, 'precommit', authenticatedConflictHash),
          vote(1, 1, 'precommit', authenticatedConflictHash),
        ],
      },
    });
    await replica.flush();
    expect(value(replica['activeController']().snapshot()).halted).toBeTruthy();
    const blocked = await replica.submit(
      signCommand(
        {
          gameId: fixture.genesis.gameId,
          genesisDigest: genesisDigest(fixture.genesis),
          seat: 0,
          nonce: 2,
          headSeq: 2,
          headHash: entryHash(replica.getContext().log.head),
          command: { type: 'END_TURN' },
        },
        first.secretKey,
      ),
    );
    expect(blocked).toMatchObject({ ok: false, error: { code: 'replica-halted' } });
    replica.dispose();
  });

  test('reports an accepted command as outcome-unknown after a failed retransmission', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const transport = new FailingRetransmitTransport(first.peerId);
    const clock = new ManualClock();
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: fixture.engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 0,
        secretKey: first.secretKey,
        transport,
        clock,
        journal: new MemoryProtocolJournal(),
        systemInput: (context) => {
          if (context.log.head.seq !== 0) return null;
          const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
          return { input, evidence: stubEvidence(context.log, input) };
        },
      }),
    );
    await replica.flush();
    const proposal = transport.sent.find((message) => message.t === 'PROPOSAL');
    if (proposal?.t !== 'PROPOSAL') throw new Error('Expected initial system proposal');
    const initialHash = entryHash(proposal.proposal.body.entry);
    for (const phase of ['prevote', 'precommit'] as const) {
      transport.inject(second.peerId, {
        t: 'VOTE',
        vote: signVote(
          {
            genesisDigest: genesisDigest(fixture.genesis),
            epoch: 0,
            seat: 1,
            seq: 1,
            term: proposal.proposal.body.entry.term,
            phase,
            valueHash: initialHash,
          },
          second.secretKey,
        ),
      });
      // The second vote is meaningful only after the first advances the local phase.
      // oxlint-disable-next-line eslint/no-await-in-loop -- Consensus phases are sequential.
      await replica.flush();
    }
    const context = replica.getContext();
    const command = context.log.engine.getLegalCommands(context.log.state, 0).commands[0];
    if (!command) throw new Error('Expected a legal player command after setup starts');
    const pending = replica.submit(
      signCommand(
        {
          gameId: fixture.genesis.gameId,
          genesisDigest: genesisDigest(fixture.genesis),
          seat: 0,
          nonce: 1,
          headSeq: 1,
          headHash: entryHash(context.log.head),
          command,
        },
        first.secretKey,
      ),
    );
    await replica.flush();
    expect(transport.submitBroadcasts).toBe(1);
    clock.fire(replica['pulseTimer']);
    await replica.flush();
    expect(transport.submitBroadcasts).toBe(2);
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'replica-outcome-unknown' },
    });
  });

  test('rejects oversized packets and drops a valid burst without disconnecting its peer', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const transport = new CapturingTransport(first.peerId);
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: fixture.engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 0,
        secretKey: first.secretKey,
        transport,
        clock: new ManualClock(),
        journal: new MemoryProtocolJournal(),
      }),
    );
    const oversized = new Uint8Array(256 * 1024 + 1);
    for (let index = 0; index < 5; index += 1) transport.injectBytes(second.peerId, oversized);
    expect(transport.disconnected).toEqual([second.peerId]);
    await replica.flush();
    replica.dispose();

    const thirdTransport = new CapturingTransport(first.peerId);
    const third = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: fixture.engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 0,
        secretKey: first.secretKey,
        transport: thirdTransport,
        clock: new ManualClock(),
        journal: new MemoryProtocolJournal(),
      }),
    );
    const valid = value(encodeProtocolMessage({ t: 'PING', n: 1 }));
    for (let index = 0; index < 13; index += 1) thirdTransport.injectBytes(second.peerId, valid);
    expect(thirdTransport.disconnected).toEqual([]);
    await third.flush();
    const answered = thirdTransport.sent.filter((message) => message.t === 'PONG').length;
    expect(answered).toBeGreaterThan(0);
    expect(answered).toBeLessThanOrEqual(8);
    thirdTransport.injectBytes(second.peerId, valid);
    await third.flush();
    expect(thirdTransport.sent.filter((message) => message.t === 'PONG')).toHaveLength(
      answered + 1,
    );
    expect(thirdTransport.disconnected).toEqual([]);
    third.dispose();
  });

  test('restore refuses a missing journal or a different valid genesis', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const journal = new MemoryProtocolJournal();
    const options = {
      genesisEntry: fixture.entry,
      engine: fixture.engine,
      policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
      seat: 0 as const,
      secretKey: first.secretKey,
      transport: new CapturingTransport(first.peerId),
      clock: new ManualClock(),
      journal,
    };
    expect(await ReplicatedLog.restore(options)).toMatchObject({
      ok: false,
      error: { code: 'replica-missing' },
    });
    const created = value(await ReplicatedLog.create(options));
    created.dispose();

    const alternateBody = { ...fixture.body, createdAt: fixture.body.createdAt + 1 };
    const alternateGenesis = {
      ...alternateBody,
      gameId: genesisId(alternateBody),
      signatures: [
        signGenesis(alternateBody, 0, first.secretKey),
        signGenesis(alternateBody, 1, second.secretKey),
      ],
    };
    const alternateEntry = signEntry(
      {
        seq: 0,
        term: 1,
        prevHash: fixture.entry.prevHash,
        payload: { kind: 'genesis', genesis: alternateGenesis },
        stateHash: fixture.entry.stateHash,
        sequencer: first.peerId,
      },
      first.secretKey,
    );
    expect(await ReplicatedLog.restore({ ...options, genesisEntry: alternateEntry })).toMatchObject(
      {
        ok: false,
        error: { code: 'replica-genesis' },
      },
    );
    expect((await journal.load())?.height).toBe(1);
  });

  test('persists genesis, certified entries and next-height safety before notifying; restores without reset', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const journal = new PausableJournal();
    const clock = new ManualClock();
    const transport = new CapturingTransport(first.peerId);
    const notifications: number[] = [];
    const options = {
      genesisEntry: fixture.entry,
      engine: fixture.engine,
      policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
      seat: 0 as const,
      secretKey: first.secretKey,
      transport,
      clock,
      journal,
      systemInput: (
        context: Parameters<
          NonNullable<Parameters<typeof ReplicatedLog.create>[0]['systemInput']>
        >[0],
      ) => {
        if (context.log.head.seq !== 0) return null;
        const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
        return { input, evidence: stubEvidence(context.log, input) };
      },
      onCommit: (_validated: unknown, _before: unknown, next: ProposalContext) => {
        notifications.push(next.log.head.seq);
        mutateNonceMap(next.log.lastNonces);
        Reflect.set(next.log.authority?.controllers[0] ?? {}, 'status', 'pending-recovery');
        Reflect.set(next.log.recovery ?? {}, 'pending', { seq: 999, hash: '0'.repeat(64) });
      },
    };
    const replica = value(await ReplicatedLog.create(options));
    await replica.flush();
    const proposalMessage = transport.sent.find((message) => message.t === 'PROPOSAL');
    if (proposalMessage?.t !== 'PROPOSAL') throw new Error('Initial proposal not sent');
    const proposed = proposalMessage.proposal;
    const hash = entryHash(proposed.body.entry);
    const vote = (
      seat: 0 | 1,
      seq: number,
      term: number,
      phase: 'prevote' | 'precommit',
      valueHash: string,
    ) =>
      signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat,
          seq,
          term,
          phase,
          valueHash,
        },
        fixtureAt(fixture.identities, seat).secretKey,
      );
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 1, 1, 'prevote', hash) });
    await replica.flush();
    journal.pauseSafetyReadHeight = 2;
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 1, 1, 'precommit', hash) });
    await journal.readEntered;
    // The old controller is disposed, but its certified snapshot remains valid
    // while the next height's controller awaits its durable safety record.
    expect(replica['activeController']().snapshot().ok).toBe(true);
    transport.injectBytes(second.peerId, new Uint8Array(256 * 1024 + 1));
    expect(replica['disposed']).toBe(false);
    expect(notifications).toHaveLength(0);
    journal.releaseSafetyRead();
    await replica.flush();
    expect((await journal.load())?.height).toBe(2);
    expect(replica.getContext().log.head.seq).toBe(1);
    expect(notifications).toEqual([1]);

    const before = replica.getContext();
    const command = before.log.engine.getLegalCommands(before.log.state, 0).commands[0];
    if (!command) throw new Error('Expected a legal setup command');
    const signed = signCommand(
      {
        gameId: fixture.genesis.gameId,
        genesisDigest: genesisDigest(fixture.genesis),
        seat: 0,
        nonce: 1,
        headSeq: before.log.head.seq,
        headHash: entryHash(before.log.head),
        command,
      },
      first.secretKey,
    );
    let finished = false;
    const submitted = replica.submit(signed).then((result) => {
      finished = true;
      return result;
    });
    await replica.flush();
    expect(finished).toBe(false);
    const applied = value(
      fixture.engine.apply(before.log.state, { kind: 'command', seat: 0, command }),
    );
    const proposer = proposerFor(2, 1, {
      genesisDigest: genesisDigest(fixture.genesis),
      epoch: 0,
      voters: [
        { seat: 0, publicKey: first.peerId },
        { seat: 1, publicKey: second.peerId },
      ],
    });
    expect(proposer.seat).toBe(1);
    const entry = signEntry(
      {
        seq: 2,
        term: 1,
        prevHash: entryHash(before.log.head),
        payload: { kind: 'command', signed },
        stateHash: toHex(hashValue(applied.state)),
        sequencer: second.peerId,
      },
      second.secretKey,
    );
    const commandValueHash = entryHash(entry);
    transport.inject(second.peerId, {
      t: 'PROPOSAL',
      proposal: signProposal(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          entry,
          validRound: null,
          prevotes: [],
        },
        second.secretKey,
      ),
    });
    await replica.flush();
    transport.inject(second.peerId, {
      t: 'VOTE',
      vote: vote(1, 2, 1, 'prevote', commandValueHash),
    });
    await replica.flush();
    transport.inject(second.peerId, {
      t: 'VOTE',
      vote: vote(1, 2, 1, 'precommit', commandValueHash),
    });
    await replica.flush();
    expect(value(await submitted)).toBeUndefined();
    expect((await journal.load())?.height).toBe(3);
    expect(notifications).toEqual([1, 2]);
    expect(replica.getContext().log.lastNonces.get(0)).toBe(1);

    const repeated = replica.getEntries()[0];
    if (!repeated) throw new Error('Expected committed entry');
    transport.inject(second.peerId, {
      t: 'COMMIT',
      certified: { entry: repeated.entry, certificate: [] },
    });
    await replica.flush();
    expect((await journal.load())?.height).toBe(3);
    expect(notifications).toEqual([1, 2]);

    const detached = replica.getContext();
    mutateNonceMap(detached.log.lastNonces);
    Reflect.set(detached.log.authority?.controllers[0] ?? {}, 'publicKey', second.peerId);
    Reflect.set(detached.log.recovery ?? {}, 'pending', { seq: 999, hash: '0'.repeat(64) });
    expect(replica.getContext().log.lastNonces.get(0)).toBe(1);
    expect(replica.getContext().log.authority?.controllers[0]?.publicKey).toBe(first.peerId);
    expect(replica.getContext().log.authority?.controllers[0]?.status).toBe('active');
    expect(replica.getContext().log.recovery?.pending).toBeNull();
    const detachedEntries = replica.getEntries();
    expect(detachedEntries).toHaveLength(2);
    const originalBytes = canonicalEncode(detachedEntries);
    expect(detachedEntries).toEqual(canonicalDecode(originalBytes));
    expect(canonicalEncode((await journal.load())?.entries)).toEqual(originalBytes);
    if (process.env.CP2P_ENTRY_EXPORT_BENCH === '1') {
      const baseline = () => canonicalDecode(canonicalEncode(detachedEntries));
      const optimized = () => replica.getEntries();
      const samples: { baselineMs: number; optimizedMs: number }[] = [];
      const iterations = 1_000;
      const measureExport = (exportEntries: () => unknown): number => {
        const started = performance.now();
        for (let index = 0; index < iterations; index += 1) exportEntries();
        return performance.now() - started;
      };
      for (let round = 0; round < 5; round += 1) {
        let baselineMs: number;
        let optimizedMs: number;
        if (round % 2 === 0) {
          baselineMs = measureExport(baseline);
          optimizedMs = measureExport(optimized);
        } else {
          optimizedMs = measureExport(optimized);
          baselineMs = measureExport(baseline);
        }
        samples.push({ baselineMs, optimizedMs });
      }
      // oxlint-disable-next-line no-console -- Opt-in bounded clone benchmark, never a runtime acceptance threshold.
      console.log(
        'PUBLIC_ENTRY_EXPORT_BENCHMARK',
        JSON.stringify({
          entries: detachedEntries.length,
          bytes: originalBytes.byteLength,
          iterations,
          samples,
        }),
      );
    }
    Reflect.set(detachedEntries[0]?.entry ?? {}, 'seq', 999);
    Reflect.set(detachedEntries[0]?.certificate[0]?.body ?? {}, 'seat', 5);
    Reflect.set(detachedEntries[0]?.certificate[0] ?? {}, 'sig', 'invalid');
    const commandPayload = detachedEntries[1]?.entry.payload;
    if (commandPayload?.kind !== 'command') throw new Error('Expected nested signed command');
    Reflect.set(commandPayload.signed.body, 'nonce', 999);
    Reflect.set(commandPayload.signed.body.command, 'type', 'invalid');
    expect(canonicalEncode(replica.getEntries())).toEqual(originalBytes);
    expect(replica.getEntries()[0]?.entry.seq).toBe(1);
    replica.dispose();
    const restored = value(
      await ReplicatedLog.restore({ ...options, transport: new CapturingTransport(first.peerId) }),
    );
    expect(restored.getContext().log.head.seq).toBe(2);
    expect((await journal.load())?.height).toBe(3);
    const stale = await restored.submit(signed);
    expect(stale).toMatchObject({ ok: false, error: { code: 'replayed-nonce' } });
    restored.dispose();
    expect((await ReplicatedLog.create(options)).ok).toBe(false);
  });

  test('a committed private-state callback failure stops voting after durable commit', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const journal = new MemoryProtocolJournal();
    const transport = new CapturingTransport(first.peerId);
    const statuses: string[] = [];
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: fixture.engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 0,
        secretKey: first.secretKey,
        transport,
        clock: new ManualClock(),
        journal,
        systemInput: (context) => {
          if (context.log.head.seq !== 0) return null;
          const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
          return { input, evidence: stubEvidence(context.log, input) };
        },
        onCommit: () => {
          throw new Error('Private driver failed');
        },
        onStatus: (status) => {
          if (status.kind === 'halted') statuses.push(status.code);
        },
      }),
    );
    await replica.flush();
    const sent = transport.sent.find((message) => message.t === 'PROPOSAL');
    if (sent?.t !== 'PROPOSAL') throw new Error('Expected the initial proposal');
    const hash = entryHash(sent.proposal.body.entry);
    const signedVote = (phase: 'prevote' | 'precommit') =>
      signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat: 1,
          seq: 1,
          term: 1,
          phase,
          valueHash: hash,
        },
        second.secretKey,
      );
    transport.inject(second.peerId, { t: 'VOTE', vote: signedVote('prevote') });
    await replica.flush();
    transport.inject(second.peerId, { t: 'VOTE', vote: signedVote('precommit') });
    await replica.flush();
    expect((await journal.load())?.height).toBe(2);
    expect(statuses).toContain('commit-application');
    expect(
      await replica.submit(
        signCommand(
          {
            gameId: fixture.genesis.gameId,
            genesisDigest: genesisDigest(fixture.genesis),
            seat: 0,
            nonce: 1,
            headSeq: 1,
            headHash: hash,
            command: { type: 'END_TURN' },
          },
          first.secretKey,
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: 'replica-disposed' } });
  });

  test('does not report command success when post-commit private application fails', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const journal = new MemoryProtocolJournal();
    const transport = new CapturingTransport(first.peerId);
    const statuses: string[] = [];
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: fixture.engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 0,
        secretKey: first.secretKey,
        transport,
        clock: new ManualClock(),
        journal,
        systemInput: (context) => {
          if (context.log.head.seq !== 0) return null;
          const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
          return { input, evidence: stubEvidence(context.log, input) };
        },
        onCommit: (_validated, _previous, next) => {
          if (next.log.head.seq === 2) throw new Error('Private driver failed');
        },
        onStatus: (status) => {
          if (status.kind === 'halted') statuses.push(status.code);
        },
      }),
    );
    await replica.flush();
    const proposal = transport.sent.find((message) => message.t === 'PROPOSAL');
    if (proposal?.t !== 'PROPOSAL') throw new Error('Initial proposal was not sent');
    const firstHash = entryHash(proposal.proposal.body.entry);
    const vote = (seat: 0 | 1, seq: number, phase: 'prevote' | 'precommit', hash: string) =>
      signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat,
          seq,
          term: 1,
          phase,
          valueHash: hash,
        },
        fixtureAt(fixture.identities, seat).secretKey,
      );
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 1, 'prevote', firstHash) });
    await replica.flush();
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 1, 'precommit', firstHash) });
    await replica.flush();
    const before = replica.getContext();
    const command = before.log.engine.getLegalCommands(before.log.state, 0).commands[0];
    if (!command) throw new Error('Expected legal setup command');
    const signed = signCommand(
      {
        gameId: fixture.genesis.gameId,
        genesisDigest: genesisDigest(fixture.genesis),
        seat: 0,
        nonce: 1,
        headSeq: before.log.head.seq,
        headHash: entryHash(before.log.head),
        command,
      },
      first.secretKey,
    );
    const pending = replica.submit(signed);
    await replica.flush();
    const applied = value(
      fixture.engine.apply(before.log.state, {
        kind: 'command',
        seat: 0,
        command,
      }),
    );
    const entry = signEntry(
      {
        seq: 2,
        term: 1,
        prevHash: entryHash(before.log.head),
        payload: { kind: 'command', signed },
        stateHash: toHex(hashValue(applied.state)),
        sequencer: second.peerId,
      },
      second.secretKey,
    );
    const hash = entryHash(entry);
    transport.inject(second.peerId, {
      t: 'PROPOSAL',
      proposal: signProposal(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          entry,
          validRound: null,
          prevotes: [],
        },
        second.secretKey,
      ),
    });
    await replica.flush();
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 2, 'prevote', hash) });
    await replica.flush();
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 2, 'precommit', hash) });
    await replica.flush();
    expect((await journal.load())?.height).toBe(3);
    expect(statuses).toContain('commit-application');
    expect(await pending).toMatchObject({ ok: false, error: { code: 'replica-outcome-unknown' } });
  });

  test.each(['unchanged', 'changed-engine'] as const)(
    'repair retains a certified value until a fresh replay accepts it (%s)',
    async (runtime) => {
      // A valid remote quorum excludes this replica's key while its local engine
      // cannot derive the certified value.
      const fixture = fourHumanFixture();
      const first = fixtureAt(fixture.identities, 0);
      const second = fixtureAt(fixture.identities, 1);
      const local = fixtureAt(fixture.identities, 3);
      const journal = new MemoryProtocolJournal();
      const transport = new CapturingTransport(local.peerId);
      let broken = true;
      const engine: Engine = {
        ...fixture.engine,
        apply: (state, input) =>
          broken
            ? failure('test-engine-failure', 'Engine cannot derive the certified value')
            : fixture.engine.apply(state, input),
      };
      const replica = value(
        await ReplicatedLog.create({
          genesisEntry: fixture.entry,
          engine,
          policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
          seat: 3,
          secretKey: local.secretKey,
          transport,
          clock: new ManualClock(),
          journal,
        }),
      );
      const context = replica.getContext();
      transport.inject(second.peerId, {
        t: 'SNAPSHOT_REQ',
        genesisDigest: context.membership.genesisDigest,
        atSeq: 0,
      });
      await replica.flush();
      expect(transport.sent.find((message) => message.t === 'SNAPSHOT_RES')).toMatchObject({
        t: 'SNAPSHOT_RES',
        atSeq: 0,
        snapshot: snapshotFromContext(context),
      });
      const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
      const applied = value(fixture.engine.apply(context.log.state, input));
      const entry = signEntry(
        {
          seq: 1,
          term: 1,
          prevHash: entryHash(context.log.head),
          payload: { kind: 'system', input, evidence: stubEvidence(context.log, input) },
          stateHash: toHex(hashValue(applied.state)),
          sequencer: first.peerId,
        },
        first.secretKey,
      );
      const hash = entryHash(entry);
      const vote = (seat: 0 | 1 | 2) =>
        signVote(
          {
            genesisDigest: genesisDigest(fixture.genesis),
            epoch: 0,
            seat,
            seq: 1,
            term: 1,
            phase: 'precommit',
            valueHash: hash,
          },
          fixtureAt(fixture.identities, seat).secretKey,
        );
      transport.inject(second.peerId, {
        t: 'COMMIT',
        certified: { entry, certificate: [vote(0), vote(1), vote(2)] },
      });
      await replica.flush();
      expect((await journal.load())?.height).toBe(1);
      expect(transport.sent.some((message) => message.t === 'SNAPSHOT_REQ')).toBe(true);
      expect(
        await replica.submit(
          signCommand(
            {
              gameId: fixture.genesis.gameId,
              genesisDigest: genesisDigest(fixture.genesis),
              seat: 0,
              nonce: 1,
              headSeq: 0,
              headHash: entryHash(context.log.head),
              command: { type: 'END_TURN' },
            },
            first.secretKey,
          ),
        ),
      ).toMatchObject({ ok: false, error: { code: 'replica-halted' } });
      expect(await replica.repair()).toMatchObject({
        ok: false,
        error: { code: 'consensus-repair-incomplete' },
      });
      expect((await journal.load())?.height).toBe(1);
      expect(replica.getContext().log.head.seq).toBe(0);
      broken = false;
      if (runtime === 'changed-engine') {
        const durable = await journal.load();
        const load = journal.load.bind(journal);
        const originalApply = engine.apply.bind(engine);
        journal.load = async () => {
          // Change identity after the halted controller's snapshot check, while
          // repair awaits its durable parent. The replacement has the same behavior.
          engine.apply = (state, nextInput) => originalApply(state, nextInput);
          return load();
        };
        const rejected = await replica.repair();
        if (rejected.ok || rejected.error.code !== 'replica-authority')
          throw new Error('Repair blessed a changed engine function');
        if (toHex(hashValue(await load())) !== toHex(hashValue(durable)))
          throw new Error('Rejected repair changed durable safety or history');
        if (replica.getContext().log.head.seq !== 0)
          throw new Error('Rejected repair advanced the certified head');
        replica.dispose();
        return;
      }
      transport.inject(second.peerId, {
        t: 'SNAPSHOT_RES',
        genesisDigest: context.membership.genesisDigest,
        atSeq: 0,
        snapshot: { bogus: true },
      });
      await replica.flush();
      expect((await journal.load())?.height).toBe(1);
      transport.inject(second.peerId, {
        t: 'SNAPSHOT_RES',
        genesisDigest: context.membership.genesisDigest,
        atSeq: 0,
        snapshot: snapshotFromContext(context),
      });
      await replica.flush();
      expect((await journal.load())?.height).toBe(2);
      expect(replica.getContext().log.head.seq).toBe(1);
      replica.dispose();
    },
  );

  test('verified incremental contexts match durable replay at genesis and two certified deck passes', () => {
    const fixture = createVerifiedNetworkFixture({ seed: 42 });
    try {
      const options = fixture.sessionOptions(0);
      let context = value(
        replayCertifiedPrefix(fixture.entry, [], fixture.engine, options.policy),
      ).context;
      const entries: CertifiedEntry[] = [];
      const passes = options.deckSetupPasses?.slice(0, 2);
      if (!passes || passes.length !== 2)
        throw new Error('Missing representative public deck passes');
      for (let prefix = 0; prefix <= passes.length; prefix++) {
        const opened = value(
          openOwnedConsensusState(value(createConsensusState(context, 3)), context, 3),
        );
        const replayed = value(
          replayCertifiedPrefix(fixture.entry, entries, fixture.engine, options.policy),
        );
        expect(opened.matchesOpenedContext(replayed.context)).toBe(true);
        expect([...context.log.lastNonces]).toEqual([...replayed.context.log.lastNonces]);
        const pass = passes[prefix];
        if (!pass) break;
        const proposer = fixtureAt(
          [...fixture.identities.values()],
          proposerFor(context.log.head.seq + 1, 1, context.membership).seat,
        );
        const entry = signEntry(
          {
            seq: context.log.head.seq + 1,
            term: 1,
            prevHash: entryHash(context.log.head),
            payload: { kind: 'crypto', action: 'deck-pass', evidence: pass },
            stateHash: context.log.head.stateHash,
            sequencer: proposer.peerId,
          },
          proposer.secretKey,
        );
        const certified = {
          entry,
          certificate: ([0, 1, 2] as const).map((seat) =>
            signVote(
              {
                genesisDigest: context.membership.genesisDigest,
                epoch: 0,
                seat,
                seq: entry.seq,
                term: 1,
                phase: 'precommit',
                valueHash: entryHash(entry),
              },
              fixtureAt([...fixture.identities.values()], seat).secretKey,
            ),
          ),
        };
        context = value(advanceContext(context, value(validateCertifiedEntry(certified, context))));
        entries.push(certified);
      }
    } finally {
      fixture.dispose();
    }
  }, 30_000);

  test.each([
    'unchanged',
    'locked',
    'proposal',
    'pending',
    'pending-strike',
    'commit-strike',
    'trade-unobserved',
    'blocked-peer',
    'swallowed',
    'bad-submit',
    'safety',
    'locked-safety',
    'engine',
  ] as const)(
    'repairs a corrupted derived context only with unchanged durable authority (%s)',
    async (mutation) => {
      const fixture = fourHumanFixture();
      const engine = { ...fixture.engine };
      const first = fixtureAt(fixture.identities, 0);
      const second = fixtureAt(fixture.identities, 1);
      const local = fixtureAt(fixture.identities, 3);
      const journal = new PausableJournal();
      const transport = new CapturingTransport(local.peerId);
      const clock = new ManualClock();
      const statuses: string[] = [];
      const replica = value(
        await ReplicatedLog.create({
          genesisEntry: fixture.entry,
          engine,
          policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
          seat: 3,
          secretKey: local.secretKey,
          transport,
          clock,
          journal,
          onStatus: (status) => statuses.push(status.kind === 'halted' ? status.code : status.kind),
        }),
      );
      const parent = replica.getContext();
      if (mutation === 'blocked-peer')
        for (let index = 0; index < 5; index++)
          transport.injectBytes(
            fixtureAt(fixture.identities, 2).peerId,
            new Uint8Array(256 * 1024 + 1),
          );
      let safetyBefore = await journal.loadSafety(1);
      if (!safetyBefore) throw new Error('Missing initial durable safety record');

      const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
      const applied = value(fixture.engine.apply(parent.log.state, input));
      const entry = signEntry(
        {
          seq: 1,
          term: 1,
          prevHash: entryHash(parent.log.head),
          payload: { kind: 'system', input, evidence: stubEvidence(parent.log, input) },
          stateHash: toHex(hashValue(applied.state)),
          sequencer: first.peerId,
        },
        first.secretKey,
      );
      const certified = {
        entry,
        certificate: ([0, 1, 2] as const).map((seat) =>
          signVote(
            {
              genesisDigest: genesisDigest(fixture.genesis),
              epoch: 0,
              seat,
              seq: 1,
              term: 1,
              phase: 'precommit',
              valueHash: entryHash(entry),
            },
            fixtureAt(fixture.identities, seat).secretKey,
          ),
        ),
      };

      const proposal = signProposal(
        {
          genesisDigest: parent.membership.genesisDigest,
          epoch: 0,
          entry,
          validRound: null,
          prevotes: [],
        },
        first.secretKey,
      );
      const commandBody = {
        gameId: parent.log.genesis.gameId,
        genesisDigest: parent.membership.genesisDigest,
        seat: 0 as const,
        nonce: 1,
        headSeq: 0,
        headHash: entryHash(parent.log.head),
        command: { type: 'END_TURN' },
      };
      if (mutation === 'locked' || mutation === 'locked-safety') {
        transport.inject(first.peerId, {
          t: 'PROPOSAL',
          proposal,
        });
        await replica.flush();
        for (const seat of [0, 1] as const) {
          transport.inject(fixtureAt(fixture.identities, seat).peerId, {
            t: 'VOTE',
            vote: signVote(
              { ...fixtureAt(certified.certificate, seat).body, phase: 'prevote' },
              fixtureAt(fixture.identities, seat).secretKey,
            ),
          });
          // oxlint-disable-next-line no-await-in-loop -- Persist each authentic prevote before reaching the polka.
          await replica.flush();
        }
        const locked = value(replica['activeController']().snapshot());
        if (
          locked.locked?.hash !== entryHash(entry) ||
          !locked.votes.some((vote) => vote.body.seat === 3 && vote.body.phase === 'precommit')
        )
          throw new Error('Fixture did not persist a real local lock and precommit');
        safetyBefore = await journal.loadSafety(1);
        if (!safetyBefore) throw new Error('Missing locked safety');
      }
      let capturedRejectedProofs = 0;
      const capture = replica['captureRejectedProofs'];
      replica['captureRejectedProofs'] = async (from, bytes) => {
        capturedRejectedProofs++;
        return capture.call(replica, from, bytes);
      };
      const votesBefore = transport.sent.filter((message) => message.t === 'VOTE').length;
      if (mutation === 'pending' || mutation === 'pending-strike') {
        journal.pauseUpdates = true;
        transport.inject(first.peerId, {
          t: 'PROPOSAL',
          proposal,
        });
        await journal.entered;
      } else if (mutation === 'commit-strike') {
        journal.pauseSafetyReadHeight = 1;
        transport.inject(second.peerId, { t: 'COMMIT', certified });
        await journal.readEntered;
      }
      let derived: unknown = replica;
      for (const property of ['context', 'log', 'state', 'bank']) {
        if (typeof derived !== 'object' || derived === null)
          throw new Error(`Cannot corrupt derived state at ${property}`);
        derived = Reflect.get(derived, property);
      }
      if (typeof derived !== 'object' || derived === null)
        throw new Error('Missing derived bank state');
      const brick = Reflect.get(derived, 'brick');
      if (typeof brick !== 'number' || !Reflect.set(derived, 'brick', brick + 1))
        throw new Error('Could not corrupt derived bank state');

      if (mutation === 'trade-unobserved') {
        const request = replica.requestTradeProof(
          signTradeProofRequest(
            {
              ...commandBody,
              seat: 3,
              command: { type: 'CONFIRM_TRADE', offerId: 0, withSeat: 1 },
            },
            local.secretKey,
          ),
        );
        if (request.ok || request.error.code !== 'replica-repairing')
          throw new Error('Unobserved corrupt context was used for an outbound trade request');
      } else if (mutation === 'commit-strike') {
        transport.injectBytes(second.peerId, new Uint8Array(256 * 1024 + 1));
        journal.releaseSafetyRead();
      } else if (mutation === 'pending-strike') {
        transport.injectBytes(second.peerId, new Uint8Array(256 * 1024 + 1));
        journal.releaseWrite();
      } else if (mutation === 'pending') journal.releaseWrite();
      else if (mutation === 'swallowed') {
        const fault = replica['activeController']().snapshot();
        if (fault.ok || fault.error.code !== 'consensus-context')
          throw new Error('Swallowed snapshot did not detect the context fault');
        transport.inject(second.peerId, { t: 'VOTE', vote: fixtureAt(certified.certificate, 1) });
      } else if (mutation === 'bad-submit')
        transport.inject(first.peerId, {
          t: 'SUBMIT',
          cmd: signCommand(commandBody, second.secretKey),
        });
      else if (mutation === 'locked')
        transport.inject(second.peerId, { t: 'VOTE', vote: fixtureAt(certified.certificate, 1) });
      else if (mutation === 'proposal')
        transport.inject(first.peerId, {
          t: 'PROPOSAL',
          proposal,
        });
      else transport.inject(second.peerId, { t: 'COMMIT', certified });
      await replica.flush();
      if (mutation === 'pending' || mutation === 'pending-strike' || mutation === 'commit-strike') {
        safetyBefore = await journal.loadSafety(1);
        if (!safetyBefore || safetyBefore.revision !== 1)
          throw new Error('Pending write did not durably retain the signed prevote');
      }
      expect(statuses).toContain('consensus-context');
      expect(replica['disposed']).toBe(false);
      expect(capturedRejectedProofs).toBe(mutation === 'bad-submit' ? 1 : 0);
      expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(votesBefore);
      expect(transport.sent).toContainEqual({
        t: 'SNAPSHOT_REQ',
        genesisDigest: parent.membership.genesisDigest,
        atSeq: parent.log.head.seq,
      });
      expect((await journal.load())?.height).toBe(1);
      expect(await journal.loadSafety(1)).toEqual(safetyBefore);
      expect(replica.getContext().log.head.seq).toBe(0);

      const writesBeforeHoldTraffic = journal.safetyWrites;
      const tradeRequest = replica.requestTradeProof(
        signTradeProofRequest(
          {
            gameId: parent.log.genesis.gameId,
            genesisDigest: parent.membership.genesisDigest,
            seat: 3,
            nonce: 1,
            headSeq: 0,
            headHash: entryHash(parent.log.head),
            command: { type: 'CONFIRM_TRADE', offerId: 0, withSeat: 1 },
          },
          local.secretKey,
        ),
      );
      expect(tradeRequest.ok ? null : tradeRequest.error.code).toBe('replica-repairing');
      expect(replica['pendingTradeProofs'].size).toBe(0);
      replica.cancelTradeProofRequest('absent');
      transport.inject(first.peerId, {
        t: 'SUBMIT',
        cmd: signCommand(commandBody, first.secretKey),
      });
      transport.inject(second.peerId, { t: 'VOTE', vote: fixtureAt(certified.certificate, 1) });
      transport.inject(second.peerId, {
        t: 'COMMIT',
        certified: {
          entry,
          certificate: certified.certificate.map((vote) => ({
            ...vote,
            sig: fixtureAt(certified.certificate, 0).sig,
          })),
        },
      });
      transport.inject(first.peerId, {
        t: 'SYS_CONTRIB',
        genesisDigest: parent.membership.genesisDigest,
        contribution: {
          kind: 'beacon-reveal',
          signed: {
            body: {
              operationId: entryHash(entry),
              seat: 0,
              index: 1,
              value: parent.membership.genesisDigest,
            },
            sig: fixtureAt(certified.certificate, 0).sig,
          },
        },
      });
      clock.advance(2_000);
      clock.fireFirst();
      await replica.flush();
      expect(journal.safetyWrites).toBe(writesBeforeHoldTraffic);
      expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(votesBefore);
      expect(transport.sent.filter((message) => message.t === 'CHEAT_CLAIM')).toHaveLength(0);
      expect(transport.sent.filter((message) => message.t === 'TRADE_PROOF_REQUEST')).toHaveLength(
        0,
      );
      expect(transport.disconnected).toHaveLength(mutation === 'blocked-peer' ? 1 : 0);

      transport.inject(second.peerId, {
        t: 'SNAPSHOT_RES',
        genesisDigest: parent.membership.genesisDigest,
        atSeq: parent.log.head.seq,
        snapshot: { forged: true },
      });
      await replica.flush();
      expect((await journal.load())?.height).toBe(1);
      expect(await journal.loadSafety(1)).toEqual(safetyBefore);
      expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(votesBefore);
      const loadedAfterReplay = journal.loads;
      transport.inject(second.peerId, {
        t: 'SNAPSHOT_RES',
        genesisDigest: parent.membership.genesisDigest,
        atSeq: 0,
        snapshot: { forged: 'distinct' },
      });
      await replica.flush();
      expect(journal.loads).toBe(loadedAfterReplay);

      if (mutation === 'safety') {
        if (!(await journal.saveSafety(1, safetyBefore.revision, safetyBefore.bytes)))
          throw new Error('Could not inject a competing durable safety revision');
      } else if (mutation === 'locked-safety') {
        const changed: unknown = canonicalDecode(safetyBefore.bytes);
        if (typeof changed !== 'object' || changed === null || !journal['record'])
          throw new Error('Missing durable safety fixture');
        Reflect.set(changed, 'locked', null);
        // Deliberately corrupt durable bytes without advancing its CAS revision.
        Reflect.set(journal['record'].safety, 'bytes', canonicalEncode(changed));
      } else if (mutation === 'engine') {
        const apply = engine.apply.bind(engine);
        engine.apply = (state, nextInput) => apply(state, nextInput);
      }

      transport.inject(second.peerId, {
        t: 'SNAPSHOT_RES',
        genesisDigest: parent.membership.genesisDigest,
        atSeq: parent.log.head.seq,
        snapshot: snapshotFromContext(parent),
      });
      await replica.flush();
      // oxlint-disable vitest/no-conditional-expect -- Parameterized authority mutations intentionally have different terminal outcomes.
      if (mutation === 'safety' || mutation === 'locked-safety' || mutation === 'engine') {
        expect((await journal.load())?.height).toBe(1);
        expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(votesBefore);
        expect(statuses).toContain(
          mutation === 'engine' ? 'replica-authority' : 'consensus-write-conflict',
        );
        replica.dispose();
        return;
      }
      // oxlint-enable vitest/no-conditional-expect
      if (
        mutation === 'locked' ||
        mutation === 'proposal' ||
        mutation === 'pending' ||
        mutation === 'pending-strike' ||
        mutation === 'trade-unobserved' ||
        mutation === 'swallowed' ||
        mutation === 'bad-submit'
      ) {
        if (JSON.stringify(await journal.loadSafety(1)) !== JSON.stringify(safetyBefore))
          throw new Error('Repair changed locked durable safety');
        if (mutation === 'pending' || mutation === 'pending-strike') {
          const saved: unknown = canonicalDecode(safetyBefore.bytes);
          if (typeof saved !== 'object' || saved === null)
            throw new Error('Missing decoded pending safety');
          const durableVotes: unknown = Reflect.get(saved, 'votes');
          const emitted = transport.sent
            .filter((message) => message.t === 'VOTE')
            .map((message) => message.vote);
          if (
            !Array.isArray(durableVotes) ||
            durableVotes.length !== 1 ||
            toHex(canonicalEncode(emitted)) !== toHex(canonicalEncode(durableVotes))
          )
            throw new Error('Repair did not retransmit exactly the persisted local prevote');
        }
        transport.inject(second.peerId, { t: 'COMMIT', certified });
        await replica.flush();
      }
      expect((await journal.load())?.height).toBe(2);
      expect(replica.getContext().log.head).toEqual(entry);
      expect((await journal.load())?.entries).toEqual([certified]);
      const replayed = value(
        replayCertifiedPrefix(fixture.entry, [certified], engine, replica['options'].policy),
      );
      expect(replica['activeController']().opensOn(replayed.context)).toBe(true);
      expect(replica['blockedPeers'].has(fixtureAt(fixture.identities, 2).peerId)).toBe(
        mutation === 'blocked-peer',
      );
      replica.dispose();
    },
  );
});

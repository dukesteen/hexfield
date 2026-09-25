import { hashValue, toHex } from '@cp2p/codec';
import { failure } from '@cp2p/engine';
import type { Engine, Result, Seat, SystemInput } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { entryHash, genesisDigest, genesisId, signEntry, signGenesis } from './genesis.js';
import { MemoryProtocolJournal } from './journal.js';
import { signCommand, stubEvidence } from './log.js';
import { decodeProtocolMessage, encodeProtocolMessage } from './messages.js';
import type { ProtocolMessage } from './messages.js';
import { proposerFor } from './proposal.js';
import type { ProposalContext } from './proposal.js';
import { ReplicatedLog } from './replicated-log.js';
import { fixtureAt, protocolFixture } from './testing/fixtures.js';
import type { PeerId, ProtocolClock, Transport, Unsubscribe } from './transport.js';
import { signVote } from './votes.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function mutateNonceMap(nonces: ReadonlyMap<Seat, number>): void {
  if (nonces instanceof Map) nonces.set(0, 999);
}

class ManualClock implements ProtocolClock {
  private nextId = 1;
  readonly scheduled = new Map<number, () => void>();
  now(): number {
    return 0;
  }
  setTimeout(callback: () => void, _delayMs: number): unknown {
    const id = this.nextId++;
    this.scheduled.set(id, callback);
    return id;
  }
  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.scheduled.delete(handle);
  }
}

class CapturingTransport implements Transport {
  readonly sent: ProtocolMessage[] = [];
  private listener: ((from: PeerId, bytes: Uint8Array) => void) | null = null;
  constructor(readonly self: PeerId) {}
  peers(): PeerId[] {
    return [];
  }
  send(_to: PeerId, bytes: Uint8Array): void {
    this.sent.push(value(decodeProtocolMessage(bytes)));
  }
  broadcast(bytes: Uint8Array): void {
    this.sent.push(value(decodeProtocolMessage(bytes)));
  }
  disconnect(_peer: PeerId): void {}
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
}

describe('replicated certified log adapter', () => {
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
    const journal = new MemoryProtocolJournal();
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
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 1, 1, 'precommit', hash) });
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
      t: 'COMMIT',
      certified: {
        entry,
        certificate: [
          vote(0, 2, 1, 'precommit', commandValueHash),
          vote(1, 2, 1, 'precommit', commandValueHash),
        ],
      },
    });
    await replica.flush();
    expect(value(await submitted)).toBeUndefined();
    expect((await journal.load())?.height).toBe(3);
    expect(notifications).toEqual([1, 2]);
    expect(replica.getContext().log.lastNonces.get(0)).toBe(1);

    const detached = replica.getContext();
    mutateNonceMap(detached.log.lastNonces);
    expect(replica.getContext().log.lastNonces.get(0)).toBe(1);
    const detachedEntries = replica.getEntries();
    expect(detachedEntries).toHaveLength(2);
    Reflect.set(detachedEntries[0]?.entry ?? {}, 'seq', 999);
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

  test('repair retains a certified value until a fresh replay accepts it', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const journal = new MemoryProtocolJournal();
    const transport = new CapturingTransport(first.peerId);
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
        seat: 0,
        secretKey: first.secretKey,
        transport,
        clock: new ManualClock(),
        journal,
      }),
    );
    const context = replica.getContext();
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
    const vote = (seat: 0 | 1) =>
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
      certified: { entry, certificate: [vote(0), vote(1)] },
    });
    await replica.flush();
    expect((await journal.load())?.height).toBe(1);
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
    expect(await replica.repair()).toMatchObject({ ok: true });
    expect((await journal.load())?.height).toBe(2);
    expect(replica.getContext().log.head.seq).toBe(1);
    replica.dispose();
  });
});

import { toBase64Url } from '@cp2p/codec';
import { success } from '@cp2p/engine';
import type { Engine, Result } from '@cp2p/engine';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { entryHash, genesisDigest, signEntry } from './genesis.js';
import { MemoryProtocolJournal } from './journal.js';
import type { JournalRecord, ProtocolJournal } from './journal.js';
import { signCommand } from './log.js';
import { MasterRevealCoordinator } from './master-reveal.js';
import type { MasterRevealStore } from './master-reveal.js';
import { decodeProtocolMessage, encodeProtocolMessage } from './messages.js';
import type { ProtocolMessage } from './messages.js';
import { proposerFor } from './proposal.js';
import type { CertifiedEntry } from './proposal.js';
import { ReplicatedLog } from './replicated-log.js';
import type { ReplicatedLogOptions } from './replicated-log.js';
import { replayCertifiedPrefix, snapshotFromContext } from './replay.js';
import type { ReplayPolicy } from './replay.js';
import { createMemnet } from './testing/memnet.js';
import { createVerifiedNetworkFixture } from './testing/verified-network-fixture.js';
import { VirtualClock } from './testing/virtual-clock.js';
import type { Transport } from './transport.js';
import { signVote } from './votes.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing live reveal fixture value');
  return item;
}
function corruptLiveBank(replica: ReplicatedLog) {
  const context: unknown = Reflect.get(replica, 'context');
  if (!context || typeof context !== 'object' || !('log' in context))
    throw new Error('Missing actual replica context');
  const log = context.log;
  if (!log || typeof log !== 'object' || !('state' in log)) throw new Error('Missing live log');
  const state = log.state;
  if (!state || typeof state !== 'object' || !('bank' in state))
    throw new Error('Missing live state');
  const bank = state.bank;
  if (!bank || typeof bank !== 'object') throw new Error('Missing live bank');
  Reflect.set(bank, 'brick', 999);
}
function gate() {
  let enter!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    resumed: new Promise<void>((resolve) => {
      release = resolve;
    }),
    enter: () => enter(),
    release: () => release(),
  };
}
type Gate = ReturnType<typeof gate>;

class RevealStore implements MasterRevealStore {
  readonly records = new Map<string, Uint8Array>();
  writes = 0;
  writeGate: Gate | null = null;
  async load(id: string) {
    return this.records.get(id)?.slice() ?? null;
  }
  async putIfAbsent(id: string, bytes: Uint8Array) {
    this.writes++;
    const owned = bytes.slice();
    if (this.writeGate) {
      this.writeGate.enter();
      await this.writeGate.resumed;
    }
    if (this.records.has(id)) return false;
    this.records.set(id, owned);
    return true;
  }
}
class JournalView implements ProtocolJournal {
  readGate: Gate | null = null;
  safetyGate: Gate | null = null;
  safetyReadsBeforeGate = 0;
  alter: ((record: JournalRecord) => void) | null = null;
  constructor(readonly original: ProtocolJournal) {}
  async load() {
    if (this.readGate) {
      this.readGate.enter();
      await this.readGate.resumed;
    }
    const record = await this.original.load();
    if (record) this.alter?.(record);
    return record;
  }
  initialize(...args: Parameters<ProtocolJournal['initialize']>) {
    return this.original.initialize(...args);
  }
  async loadSafety(...args: Parameters<ProtocolJournal['loadSafety']>) {
    if (this.safetyGate && this.safetyReadsBeforeGate-- === 0) {
      this.safetyGate.enter();
      await this.safetyGate.resumed;
    }
    return this.original.loadSafety(...args);
  }
  saveSafety(...args: Parameters<ProtocolJournal['saveSafety']>) {
    return this.original.saveSafety(...args);
  }
  commit(...args: Parameters<ProtocolJournal['commit']>) {
    return this.original.commit(...args);
  }
}
class CapturingTransport implements Transport {
  readonly sent: ProtocolMessage[] = [];
  private listener: ((from: string, bytes: Uint8Array) => void) | null = null;
  constructor(readonly self: string) {}
  peers() {
    return [];
  }
  send(_to: string, bytes: Uint8Array) {
    this.sent.push(value(decodeProtocolMessage(bytes)));
  }
  broadcast(bytes: Uint8Array) {
    this.sent.push(value(decodeProtocolMessage(bytes)));
  }
  disconnect(_peer: string) {}
  onMessage(listener: (from: string, bytes: Uint8Array) => void) {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  onPeerChange() {
    return () => undefined;
  }
  inject(from: string, message: unknown) {
    this.listener?.(from, value(encodeProtocolMessage(message)));
  }
}

type Fixture = ReturnType<typeof createVerifiedNetworkFixture>;
let fixture: Fixture;
let terminalJournal: MemoryProtocolJournal;
let certified: CertifiedEntry[];
let fixtureMilliseconds = 0;

// This custom terminal engine certifies one real, legal base setup command.
// It isolates checkpoint mechanics and makes no base-game victory/audit claim.
function unusedHiddenProof(): never {
  throw new Error('Custom terminal fixture must not request a hidden count/steal proof');
}

function terminalEngine(base: Engine) {
  let applications = 0;
  const engine: Engine = {
    ...base,
    apply(state, input) {
      applications++;
      const applied = base.apply(state, input);
      return applied.ok && input.kind === 'command'
        ? success({
            ...applied.value,
            state: {
              ...applied.value.state,
              result: {
                winner: input.seat,
                reason: 'test-terminal-checkpoint',
                atTurn: state.turn.number,
              },
            },
          })
        : applied;
    },
  };
  return {
    engine,
    count: () => applications,
    reset: () => {
      applications = 0;
    },
  };
}
async function settle(replicas: readonly ReplicatedLog[], clock: VirtualClock, passes = 24) {
  for (let pass = 0; pass < passes; pass++) {
    // oxlint-disable-next-line no-await-in-loop -- Drain the genuine consensus wire batch.
    await Promise.all(replicas.map((replica) => replica.flush()));
    clock.advanceBy(0);
    // oxlint-disable-next-line no-await-in-loop -- Yield without altering consensus time.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

beforeAll(async () => {
  const started = Date.now();
  fixture = createVerifiedNetworkFixture({ seed: 42, gameIndex: 0 });
  const peers = fixture.genesis.seats.map((seat) => seat.publicKey);
  const network = createMemnet({ peers });
  const journals = peers.map(() => new MemoryProtocolJournal());
  const counted = terminalEngine(fixture.engine);
  const replicas: ReplicatedLog[] = [];
  try {
    for (const seat of fixture.genesis.config.seats) {
      const identity = required(fixture.identities.get(seat));
      const options = { ...fixture.sessionOptions(seat) };
      delete options.masterReveal;
      replicas.push(
        value(
          // oxlint-disable-next-line no-await-in-loop -- Each live replica owns its own journal and signer.
          await ReplicatedLog.create({
            ...options,
            engine: counted.engine,
            seat,
            secretKey: identity.secretKey,
            transport: network.transport(identity.peerId),
            clock: network.clock,
            journal: required(journals[seat]),
            countProof: unusedHiddenProof,
            stealContribution: unusedHiddenProof,
            stealResponse: unusedHiddenProof,
          }),
        ),
      );
    }
    await settle(replicas, network.clock, 48);
    const context = required(replicas[0]).getContext();
    const pending = required(counted.engine.getPending(context.log.state)[0]);
    if (pending.kind !== 'player') throw new Error('Expected a genuine setup command');
    const command = required(
      counted.engine.getLegalCommands(context.log.state, pending.seat).commands[0],
    );
    const signer = required(fixture.identities.get(pending.seat));
    const submitted = required(replicas[pending.seat]).submit(
      signCommand(
        {
          gameId: fixture.genesis.gameId,
          genesisDigest: genesisDigest(fixture.genesis),
          seat: pending.seat,
          nonce: 1,
          headSeq: context.log.head.seq,
          headHash: entryHash(context.log.head),
          command,
        },
        signer.secretKey,
      ),
    );
    await settle(replicas, network.clock, 48);
    value(await submitted);
    if (!replicas.every((replica) => replica.getContext().log.state.result !== null))
      throw new Error('Tiny terminal command did not certify on every replica');
    terminalJournal = required(journals[0]);
    certified = required(await terminalJournal.load()).entries;
    const last = required(certified.at(-1));
    if (last.entry.payload.kind !== 'command' || last.certificate.length < 3)
      throw new Error('Terminal prefix lacks a quorum-certified command');
    value(replayCertifiedPrefix(fixture.entry, certified, counted.engine, fixture.policy));
  } finally {
    for (const replica of replicas) replica.dispose();
    network.dispose();
    fixtureMilliseconds = Date.now() - started;
  }
}, 60_000);
afterAll(() => fixture?.dispose());

async function live() {
  const counted = terminalEngine(fixture.engine);
  const policy: ReplayPolicy = { ...fixture.policy, genesis: { ...fixture.policy.genesis } };
  const journal = new JournalView(terminalJournal);
  const store = new RevealStore();
  const identity = required(fixture.identities.get(0));
  const transport = new CapturingTransport(identity.peerId);
  const originalSource = required(fixture.sessionOptions(0).masterReveal).loadOwnedMaster;
  let available = false;
  let sourceCalls = 0;
  let masterReads = 0;
  let sourceGate: Gate | null = null;
  const copies: Uint8Array[] = [];
  const options: ReplicatedLogOptions = {
    ...fixture.sessionOptions(0),
    engine: counted.engine,
    policy,
    seat: 0,
    secretKey: identity.secretKey,
    transport,
    clock: new VirtualClock(),
    journal,
    countProof: unusedHiddenProof,
    stealContribution: unusedHiddenProof,
    stealResponse: unusedHiddenProof,
    masterReveal: {
      store,
      loadOwnedMaster: async (seat) => {
        sourceCalls++;
        if (!available) return null;
        masterReads++;
        const bytes = await originalSource(seat);
        if (bytes) copies.push(bytes);
        if (sourceGate) {
          sourceGate.enter();
          await sourceGate.resumed;
        }
        return bytes;
      },
    },
  };
  const replica = value(await ReplicatedLog.restore(options));
  await replica.flush();
  const coordinator: unknown = Reflect.get(replica, 'masterRevealCoordinator');
  if (!(coordinator instanceof MasterRevealCoordinator))
    throw new Error('Replica did not create its live reveal coordinator');
  // Availability changes only after restore; the unavailable provider never reads a master.
  available = true;
  sourceCalls = 0;
  return {
    replica,
    coordinator,
    counted,
    policy,
    journal,
    store,
    transport,
    options,
    copies,
    sourceCalls: () => sourceCalls,
    masterReads: () => masterReads,
    holdSource: (held: Gate) => {
      sourceGate = held;
    },
  };
}

test('live first reveal uses only restore replay, while the standalone coordinator replays its prefix', async () => {
  const baseline = terminalEngine(fixture.engine);
  value(replayCertifiedPrefix(fixture.entry, certified, baseline.engine, fixture.policy));
  const mandatoryApplications = baseline.count();
  expect(mandatoryApplications).toBeGreaterThan(0);
  const session = await live();
  try {
    expect(session.counted.count()).toBe(mandatoryApplications);
    session.counted.reset();
    const metadata = value(await session.coordinator.metadata());
    const prepared = value(await session.coordinator.prepare(0));
    expect(prepared.verdict).toBe('valid');
    expect(prepared.packet.body.result).toEqual(metadata.result);
    expect(session.counted.count()).toBe(0);
    expect(session.masterReads()).toBe(1);
    expect(session.store.writes).toBe(1);
    const cold = terminalEngine(fixture.engine);
    const standalone = new MasterRevealCoordinator({
      journal: terminalJournal,
      engine: cold.engine,
      policy: fixture.policy,
      localSeat: 0,
      signingKey: required(fixture.identities.get(0)).secretKey,
      store: new RevealStore(),
      loadOwnedMaster: required(fixture.sessionOptions(0).masterReveal).loadOwnedMaster,
    });
    try {
      expect(value(await standalone.metadata())).toMatchObject({
        result: metadata.result,
        head: metadata.head,
      });
      expect(cold.count()).toBe(mandatoryApplications);
    } finally {
      standalone.dispose();
    }
    expect(fixtureMilliseconds).toBeLessThan(60_000);
  } finally {
    session.replica.dispose();
  }
});

test.each(['state', 'engine', 'policy'] as const)(
  'live %s corruption rejects before master access or reveal persistence',
  async (mutation) => {
    const session = await live();
    try {
      if (mutation === 'state') corruptLiveBank(session.replica);
      else if (mutation === 'engine')
        session.counted.engine.apply = () => {
          throw new Error('Mutated engine must not execute');
        };
      else
        required(session.policy.genesis).verifyCommitments = () => {
          throw new Error('Mutated policy must not execute');
        };
      expect(await session.coordinator.prepare(0)).toMatchObject({ ok: false });
      expect(session.sourceCalls()).toBe(0);
      expect(session.masterReads()).toBe(0);
      expect(session.store.writes).toBe(0);
    } finally {
      session.replica.dispose();
    }
  },
);

test.each(['head', 'safety-bytes', 'safety-revision'] as const)(
  'live durable %s mismatch rejects at the same terminal height',
  async (mutation) => {
    const session = await live();
    try {
      session.journal.alter = (record) => {
        if (mutation === 'head') {
          const last = required(record.entries.at(-1));
          record.entries[record.entries.length - 1] = {
            ...last,
            entry: { ...last.entry, stateHash: 'f'.repeat(64) },
          };
        } else if (mutation === 'safety-bytes') {
          record.safety.bytes[0] = required(record.safety.bytes[0]) ^ 1;
        } else record.safety = { ...record.safety, revision: record.safety.revision + 1 };
      };
      expect(await session.coordinator.prepare(0)).toMatchObject({
        ok: false,
        error: { code: 'master-reveal-journal' },
      });
      expect(session.sourceCalls()).toBe(0);
      expect(session.masterReads()).toBe(0);
      expect(session.store.writes).toBe(0);
    } finally {
      session.replica.dispose();
    }
  },
);

test('full restore refuses an invalid earlier certificate even when the terminal head and safety match', async () => {
  const session = await live();
  session.replica.dispose();
  session.journal.alter = (record) => {
    const first = required(record.entries[0]);
    const vote = required(first.certificate[0]);
    record.entries[0] = {
      ...first,
      certificate: [
        { ...vote, sig: toBase64Url(new Uint8Array(64)) },
        ...first.certificate.slice(1),
      ],
    };
  };
  expect(await ReplicatedLog.restore(session.options)).toMatchObject({ ok: false });
  expect(session.sourceCalls()).toBe(0);
  expect(session.masterReads()).toBe(0);
  expect(session.store.writes).toBe(0);
});

test.each(['journal', 'source', 'write'] as const)(
  'disposal during a live %s await cannot output or resurrect a reveal',
  async (stage) => {
    const session = await live();
    const held = gate();
    if (stage === 'journal') session.journal.readGate = held;
    else if (stage === 'source') session.holdSource(held);
    else session.store.writeGate = held;
    const operation = session.coordinator.prepare(0);
    await held.entered;
    session.replica.dispose();
    held.release();
    expect(await operation).toMatchObject({ ok: false });
    expect(session.transport.sent.filter((message) => message.t === 'MASTER_REVEAL')).toHaveLength(
      0,
    );
    for (const bytes of session.copies) expect(bytes).toEqual(new Uint8Array(32));
    expect(await session.coordinator.metadata()).toMatchObject({
      ok: false,
      error: { code: 'master-reveal-disposed' },
    });
  },
);

function postResultControl(session: Awaited<ReturnType<typeof live>>): CertifiedEntry {
  const context = session.replica.getContext();
  const seq = context.log.head.seq + 1;
  const offender = required(fixture.identities.get(1));
  const vote = {
    genesisDigest: context.membership.genesisDigest,
    epoch: context.membership.epoch,
    seat: 1 as const,
    seq,
    term: 1,
    phase: 'prevote' as const,
  };
  const elected = proposerFor(seq, 1, context.membership, context.excludedProposers);
  const signer = required(fixture.identities.get(elected.seat));
  const entry = signEntry(
    {
      seq,
      term: 1,
      prevHash: entryHash(context.log.head),
      stateHash: context.log.head.stateHash,
      sequencer: elected.publicKey,
      payload: {
        kind: 'control',
        action: 'exclude-proposer',
        offender: 1,
        evidence: {
          kind: 'vote-equivocation',
          first: signVote({ ...vote, valueHash: 'a'.repeat(64) }, offender.secretKey),
          second: signVote({ ...vote, valueHash: 'b'.repeat(64) }, offender.secretKey),
        },
      },
    },
    signer.secretKey,
  );
  return {
    entry,
    certificate: ([1, 2, 3] as const).map((seat) =>
      signVote(
        {
          genesisDigest: context.membership.genesisDigest,
          epoch: context.membership.epoch,
          seat,
          seq,
          term: 1,
          phase: 'precommit',
          valueHash: entryHash(entry),
        },
        required(fixture.identities.get(seat)).secretKey,
      ),
    ),
  };
}

test.each([0, 1])(
  'disposal during repair safety read %i cannot resurrect a controller',
  async (read) => {
    const session = await live();
    try {
      const snapshot = snapshotFromContext(session.replica.getContext());
      corruptLiveBank(session.replica);
      expect(await session.replica.repair(snapshot)).toMatchObject({
        ok: false,
        error: { code: 'consensus-context' },
      });
      const waiting = gate();
      session.journal.safetyGate = waiting;
      session.journal.safetyReadsBeforeGate = read;
      const repairing = session.replica.repair(snapshot);
      await waiting.entered;
      session.replica.dispose();
      const sent = session.transport.sent.length;
      waiting.release();
      expect(await repairing).toMatchObject({ ok: false, error: { code: 'replica-disposed' } });
      expect(Reflect.get(session.replica, 'controller')).toBeNull();
      expect(session.transport.sent).toHaveLength(sent);
      expect(session.replica.getTimers()).toEqual([]);
    } finally {
      session.replica.dispose();
    }
  },
);

test('first certified result survives a validated post-result control and derived repair', async () => {
  const session = await live();
  try {
    const original = value(await session.coordinator.metadata());
    const control = postResultControl(session);
    session.transport.inject(required(fixture.identities.get(2)).peerId, {
      t: 'COMMIT',
      certified: control,
    });
    await session.replica.flush();
    expect(session.replica.getContext().log.head.seq).toBe(control.entry.seq);
    expect(value(await session.coordinator.metadata())).toMatchObject({
      result: original.result,
      head: { seq: control.entry.seq, hash: entryHash(control.entry) },
    });
    const snapshot = snapshotFromContext(session.replica.getContext());
    corruptLiveBank(session.replica);
    const detected = await session.replica.repair(snapshot);
    expect(detected).toMatchObject({ ok: false, error: { code: 'consensus-context' } });
    value(await session.replica.repair(snapshot));
    const repaired: unknown = Reflect.get(session.replica, 'masterRevealCoordinator');
    if (!(repaired instanceof MasterRevealCoordinator))
      throw new Error('Repair did not restore live reveal coordinator');
    expect(value(await repaired.metadata()).result).toEqual(original.result);
  } finally {
    session.replica.dispose();
  }
});

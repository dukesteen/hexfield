import { canonicalDecode, canonicalEncode, toBase64Url } from '@cp2p/codec';
import { scalarToBytes, signObject } from '@cp2p/crypto';
import { RandomBot, createBotRng } from '../../bots/src/index.js';
import type { Result, Seat } from '@cp2p/engine';
import { beforeAll, describe, expect, test } from 'vitest';
import { MemoryProtocolJournal } from './journal.js';
import type { ProtocolJournal } from './journal.js';
import { MasterRevealCoordinator } from './master-reveal.js';
import type { MasterRevealStore, SignedMasterReveal } from './master-reveal.js';
import { createTerminalAuditFixture } from './testing/audit-fixture.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

class MemoryRevealStore implements MasterRevealStore {
  private readonly records = new Map<string, Uint8Array>();
  async load(id: string): Promise<Uint8Array | null> {
    return this.records.get(id)?.slice() ?? null;
  }
  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (this.records.has(id)) return false;
    this.records.set(id, bytes.slice());
    return true;
  }
  values(): readonly Uint8Array[] {
    return [...this.records.values()].map((bytes) => bytes.slice());
  }
  alterAccepted(seat: Seat, alter: (value: object) => unknown): void {
    const id = [...this.records.keys()].find(
      (key) => key.includes('/accepted/') && key.endsWith(`/${seat}`),
    );
    if (!id) throw new Error('Missing accepted reveal');
    const bytes = this.records.get(id);
    if (!bytes) throw new Error('Missing accepted reveal bytes');
    const decoded: unknown = canonicalDecode(bytes);
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
      throw new Error('Accepted reveal is not an object');
    this.records.set(id, canonicalEncode(alter(decoded)));
  }
}

function deferred() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release?.() };
}

type Fixture = Awaited<ReturnType<typeof createTerminalAuditFixture>>;
let fixture: Fixture;
let journal: MemoryProtocolJournal;
let genesisOnly: MemoryProtocolJournal;

beforeAll(async () => {
  const bot = new RandomBot();
  const rng = createBotRng(new Uint8Array(32).fill(59));
  fixture = await createTerminalAuditFixture({
    yieldTask: () => new Promise<void>((resolve) => setImmediate(resolve)),
    chooseCommand(host, pending) {
      const priv = host.getPrivate(pending.seat);
      if (!priv) throw new Error('Audit bot lacks its private seat');
      return bot.decide({ state: host.getState(), priv, seat: pending.seat }, pending, rng);
    },
  });
  journal = new MemoryProtocolJournal();
  genesisOnly = new MemoryProtocolJournal();
  if (!(await journal.initialize(fixture.genesisEntry, new Uint8Array([1]))))
    throw new Error('Could not initialize terminal fixture journal');
  if (!(await genesisOnly.initialize(fixture.genesisEntry, new Uint8Array([1]))))
    throw new Error('Could not initialize genesis-only fixture journal');
  for (const entry of fixture.entries)
    // oxlint-disable-next-line eslint/no-await-in-loop -- This is the exact certified journal order.
    if (!(await journal.commit(entry.entry.seq, 0, entry, new Uint8Array([1]))))
      throw new Error('Could not append certified terminal entry');
}, 120_000);

function coordinator(
  seat: Seat,
  store: MasterRevealStore,
  localJournal: ProtocolJournal = journal,
  loadOwnedMaster: (seat: Seat) => Promise<Uint8Array | null> = async (original) =>
    fixture.masters.find((item) => item.seat === original)?.master.slice() ?? null,
) {
  const signingKey = fixture.identities.get(seat)?.secretKey;
  if (!signingKey) throw new Error('Missing publisher key');
  return new MasterRevealCoordinator({
    journal: localJournal,
    engine: fixture.engine,
    policy: fixture.policy,
    localSeat: seat,
    signingKey,
    store,
    loadOwnedMaster,
  });
}

function signed(body: SignedMasterReveal['body'], seat: Seat): SignedMasterReveal {
  const key = fixture.identities.get(seat)?.secretKey;
  if (!key) throw new Error('Missing signing key');
  return { body, sig: signObject('master-reveal', body, key) };
}

describe('post-result master disclosure', () => {
  test('refuses source access and output before a certified engine result', async () => {
    let calls = 0;
    const store = new MemoryRevealStore();
    const sender = coordinator(0, store, genesisOnly, async () => {
      calls += 1;
      return scalarToBytes(17n);
    });
    expect(await sender.prepare(0)).toMatchObject({
      ok: false,
      error: { code: 'master-reveal-unfinished' },
    });
    expect(await sender.eligibleSeats()).toMatchObject({
      ok: false,
      error: { code: 'master-reveal-unfinished' },
    });
    expect(calls).toBe(0);
    expect(store.values()).toHaveLength(0);
    sender.dispose();
  }, 120_000);

  test('persists exact signed output, retries after restart and accepts one authenticated master', async () => {
    const store = new MemoryRevealStore();
    let sourceCalls = 0;
    let supplied: Uint8Array | null = null;
    const sender = coordinator(0, store, journal, async (seat) => {
      sourceCalls += 1;
      supplied = fixture.masters.find((item) => item.seat === seat)?.master.slice() ?? null;
      return supplied;
    });
    expect(value(await sender.eligibleSeats())).toContain(0);
    const first = value(await sender.prepare(0));
    expect(first.verdict).toBe('valid');
    expect(store.values()).toEqual([canonicalEncode(first.packet)]);
    expect(supplied).toEqual(new Uint8Array(32));
    expect(sourceCalls).toBe(1);
    const restored = coordinator(0, store, journal, async () => {
      throw new Error('Private source must not be called on exact saved retry');
    });
    expect(value(await restored.prepare(0))).toEqual(first);
    const receivedStore = new MemoryRevealStore();
    const receiver = coordinator(1, receivedStore);
    expect(value(await receiver.receive(first.packet)).verdict).toBe('valid');
    expect(value(await receiver.receive(first.packet)).packet).toEqual(first.packet);
    const masters = receiver.acceptedMasters();
    expect(masters).toEqual([{ seat: 0, verdict: 'valid', master: fixture.masters[0]?.master }]);
    masters[0]?.master.fill(0);
    expect(receiver.acceptedMasters()[0]?.master).toEqual(fixture.masters[0]?.master);
    expect(value(await receiver.metadata()).accepted).toEqual([0]);
    receiver.dispose();
    expect(receiver.acceptedMasters()).toEqual([]);
    const restoredReceiver = coordinator(1, receivedStore);
    value(await restoredReceiver.restoreAccepted());
    expect(restoredReceiver.acceptedMasters()[0]?.master).toEqual(fixture.masters[0]?.master);
    restoredReceiver.dispose();
    sender.dispose();
    restored.dispose();
  }, 120_000);

  test('rejects forged sender, altered result and F0 mismatch before accepting disclosure', async () => {
    const sender = coordinator(0, new MemoryRevealStore());
    const packet = value(await sender.prepare(0)).packet;
    const receiver = coordinator(1, new MemoryRevealStore());
    const foreignKey = fixture.identities.get(1)?.secretKey;
    if (!foreignKey) throw new Error('Missing other publisher key');
    const badSignature = {
      ...packet,
      sig: signObject('master-reveal', packet.body, foreignKey),
    };
    expect(await receiver.receive(badSignature)).toMatchObject({
      ok: false,
      error: { code: 'master-reveal-signature' },
    });
    const wrongResult = signed(
      { ...packet.body, result: { ...packet.body.result, seq: packet.body.result.seq + 1 } },
      0,
    );
    expect(await receiver.receive(wrongResult)).toMatchObject({
      ok: false,
      error: { code: 'master-reveal-result' },
    });
    const wrongMaster = signed({ ...packet.body, master: toBase64Url(scalarToBytes(99n)) }, 0);
    expect(await receiver.receive(wrongMaster)).toMatchObject({
      ok: false,
      error: { code: 'master-reveal-f0' },
    });
    expect(receiver.reveals()).toHaveLength(0);
    expect(value(await receiver.receive(packet)).verdict).toBe('valid');
    expect(await receiver.receive(wrongMaster)).toMatchObject({
      ok: false,
      error: { code: 'master-reveal-f0' },
    });
    sender.dispose();
    receiver.dispose();
  }, 120_000);

  test('quarantines a corrupt accepted slot while restoring other durable reveals', async () => {
    const sender0 = coordinator(0, new MemoryRevealStore());
    const sender1 = coordinator(1, new MemoryRevealStore());
    const packet0 = value(await sender0.prepare(0)).packet;
    const packet1 = value(await sender1.prepare(1)).packet;
    const store = new MemoryRevealStore();
    const receiver = coordinator(1, store);
    value(await receiver.receive(packet0));
    value(await receiver.receive(packet1));
    receiver.dispose();
    store.alterAccepted(0, (record) => ({
      ...record,
      receivedAt: { seq: fixture.entries.length + 100, hash: '0'.repeat(64) },
    }));
    const restored = coordinator(1, store);
    value(await restored.restoreAccepted());
    expect(restored.quarantinedAccepted()).toEqual([{ seat: 0, code: 'master-reveal-scope' }]);
    expect(restored.acceptedMasters().map(({ seat }) => seat)).toEqual([1]);
    expect(await restored.receive(packet0)).toMatchObject({
      ok: false,
      error: { code: 'master-reveal-conflict' },
    });
    expect(restored.acceptedMasters().map(({ seat }) => seat)).toEqual([1]);
    restored.dispose();
    sender0.dispose();
    sender1.dispose();
  }, 120_000);

  test('disposal during journal, source, store and restore waits cannot resurrect a reveal', async () => {
    const journalEntered = deferred();
    const journalGate = deferred();
    const delayedJournal: ProtocolJournal = {
      load: async () => {
        journalEntered.release();
        await journalGate.promise;
        return journal.load();
      },
      initialize: (genesis, safety) => journal.initialize(genesis, safety),
      loadSafety: (height) => journal.loadSafety(height),
      saveSafety: (height, revision, bytes) => journal.saveSafety(height, revision, bytes),
      commit: (height, revision, entry, nextSafety) =>
        journal.commit(height, revision, entry, nextSafety),
    };
    const journalStore = new MemoryRevealStore();
    const journalWaiter = coordinator(0, journalStore, delayedJournal);
    const journalPending = journalWaiter.prepare(0);
    await journalEntered.promise;
    journalWaiter.dispose();
    journalGate.release();
    expect(await journalPending).toMatchObject({
      ok: false,
      error: { code: 'master-reveal-disposed' },
    });
    expect(journalStore.values()).toHaveLength(0);

    const sourceEntered = deferred();
    const sourceGate = deferred();
    const sourceStore = new MemoryRevealStore();
    const owned = fixture.masters[0]?.master.slice();
    if (!owned) throw new Error('Missing owner master');
    const sourceWaiter = coordinator(0, sourceStore, journal, async () => {
      sourceEntered.release();
      await sourceGate.promise;
      return owned;
    });
    const sourcePending = sourceWaiter.prepare(0);
    await sourceEntered.promise;
    sourceWaiter.dispose();
    sourceGate.release();
    expect(await sourcePending).toMatchObject({
      ok: false,
      error: { code: 'master-reveal-disposed' },
    });
    expect(owned).toEqual(new Uint8Array(32));
    expect(sourceStore.values()).toHaveLength(0);

    const sender = coordinator(0, new MemoryRevealStore());
    const packet = value(await sender.prepare(0)).packet;
    sender.dispose();
    const writeEntered = deferred();
    const writeGate = deferred();
    const durable = new MemoryRevealStore();
    const delayedWrite: MasterRevealStore = {
      load: (id) => durable.load(id),
      putIfAbsent: async (id, bytes) => {
        writeEntered.release();
        await writeGate.promise;
        return durable.putIfAbsent(id, bytes);
      },
    };
    const receiver = coordinator(1, delayedWrite);
    const receivePending = receiver.receive(packet);
    await writeEntered.promise;
    receiver.dispose();
    writeGate.release();
    expect(await receivePending).toMatchObject({
      ok: false,
      error: { code: 'master-reveal-disposed' },
    });
    expect(receiver.acceptedMasters()).toEqual([]);
    expect(durable.values()).toHaveLength(1);

    const restoreEntered = deferred();
    const restoreGate = deferred();
    const delayedRead: MasterRevealStore = {
      load: async (id) => {
        restoreEntered.release();
        await restoreGate.promise;
        return durable.load(id);
      },
      putIfAbsent: (id, bytes) => durable.putIfAbsent(id, bytes),
    };
    const restored = coordinator(1, delayedRead);
    const restorePending = restored.restoreAccepted();
    await restoreEntered.promise;
    restored.dispose();
    restoreGate.release();
    expect(await restorePending).toMatchObject({
      ok: false,
      error: { code: 'master-reveal-disposed' },
    });
    expect(restored.acceptedMasters()).toEqual([]);
  }, 120_000);
});

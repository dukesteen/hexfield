import { hashValue, toHex } from '@cp2p/codec';
import { describe, expect, test } from 'vitest';
import { entryHash, signEntry } from './genesis.js';
import { MemoryProtocolJournal, journalSafetyStore } from './journal.js';
import { initialProposalContext } from './replay.js';
import type { ReplayPolicy } from './replay.js';
import { stubEvidence } from './log.js';
import { signVote } from './votes.js';
import { fixtureAt, protocolFixture } from './testing/fixtures.js';
import type { CertifiedEntry } from './proposal.js';
import type { SystemInput } from '@cp2p/engine';

const replayPolicy: ReplayPolicy = {
  genesis: { allowStub: true },
  entry: { allowStub: true },
};

function certifiedStart(): {
  genesis: ReturnType<typeof protocolFixture>['entry'];
  certified: CertifiedEntry;
} {
  const fixture = protocolFixture();
  const context = initialProposalContext(fixture.entry, fixture.engine, replayPolicy);
  if (!context.ok) throw new Error(`Expected genesis context: ${context.error.code}`);
  const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
  const applied = fixture.engine.apply(context.value.log.state, input);
  if (!applied.ok) throw new Error(`Expected legal start: ${applied.error.code}`);
  const firstIdentity = fixtureAt(fixture.identities, 0);
  const entry = signEntry(
    {
      seq: 1,
      term: 1,
      prevHash: entryHash(fixture.entry),
      payload: { kind: 'system', input, evidence: stubEvidence(context.value.log, input) },
      stateHash: toHex(hashValue(applied.value.state)),
      sequencer: firstIdentity.peerId,
    },
    firstIdentity.secretKey,
  );
  const hash = entryHash(entry);
  const certificate = context.value.membership.voters.map((voter) => {
    const identity = fixtureAt(fixture.identities, voter.seat);
    return signVote(
      {
        genesisDigest: context.value.membership.genesisDigest,
        epoch: context.value.membership.epoch,
        seat: voter.seat,
        seq: 1,
        term: 1,
        phase: 'precommit',
        valueHash: hash,
      },
      identity.secretKey,
    );
  });
  return { genesis: fixture.entry, certified: { entry, certificate } };
}

describe('MemoryProtocolJournal', () => {
  test('initializes genesis, height, and first safety revision atomically', async () => {
    const { genesis } = certifiedStart();
    const journal = new MemoryProtocolJournal();
    const safetyBytes = Uint8Array.of(1, 2, 3);
    expect(await journal.initialize(genesis, safetyBytes)).toBe(true);
    safetyBytes.fill(9);

    expect(await journal.load()).toMatchObject({
      genesis,
      entries: [],
      height: 1,
      safety: { revision: 0, bytes: Uint8Array.of(1, 2, 3) },
    });
    expect(await journal.initialize(genesis, Uint8Array.of(4))).toBe(false);
  });

  test('commits one certified entry and rejects writers from the old height after revision reset', async () => {
    const { genesis, certified } = certifiedStart();
    const journal = new MemoryProtocolJournal();
    expect(await journal.initialize(genesis, Uint8Array.of(1))).toBe(true);
    expect(await journal.commit(1, 0, certified, Uint8Array.of(2))).toBe(true);
    expect(await journal.load()).toMatchObject({
      entries: [certified],
      height: 2,
      safety: { revision: 0, bytes: Uint8Array.of(2) },
    });

    expect(await journal.saveSafety(1, 0, Uint8Array.of(3))).toBe(false);
    expect(await journalSafetyStore(journal, 1).save(0, Uint8Array.of(3))).toBe(false);
    expect(await journal.saveSafety(2, 0, Uint8Array.of(4))).toBe(true);
    expect(await journal.loadSafety(2)).toEqual({ revision: 1, bytes: Uint8Array.of(4) });
  });

  test('a competing safety update makes a stale commit CAS fail without partial append', async () => {
    const { genesis, certified } = certifiedStart();
    const journal = new MemoryProtocolJournal();
    expect(await journal.initialize(genesis, Uint8Array.of(1))).toBe(true);
    const safety = journalSafetyStore(journal, 1);
    const stored = await safety.load();
    expect(stored).toEqual({ revision: 0, bytes: Uint8Array.of(1) });
    expect(await safety.save(0, Uint8Array.of(5))).toBe(true);

    expect(await journal.commit(1, 0, certified, Uint8Array.of(9))).toBe(false);
    expect(await journal.load()).toMatchObject({
      entries: [],
      height: 1,
      safety: { revision: 1, bytes: Uint8Array.of(5) },
    });
    expect(await journal.commit(1, 1, certified, Uint8Array.of(9))).toBe(true);
  });

  test('deep-copies genesis, certificates, and reads in both directions', async () => {
    const { genesis, certified } = certifiedStart();
    const journal = new MemoryProtocolJournal();
    const initialName =
      genesis.payload.kind === 'genesis' ? genesis.payload.genesis.seats[0]?.name : undefined;
    expect(initialName).toBeDefined();
    expect(await journal.initialize(genesis, Uint8Array.of(7))).toBe(true);
    if (genesis.payload.kind !== 'genesis') throw new Error('Expected genesis fixture');
    const firstSeat = genesis.payload.genesis.seats[0];
    if (!firstSeat) throw new Error('Expected first seat');
    firstSeat.name = 'mutated caller input';

    expect(await journal.commit(1, 0, certified, Uint8Array.of(8))).toBe(true);
    certified.entry.stateHash = 'f'.repeat(64);
    const loaded = await journal.load();
    if (!loaded || loaded.genesis.payload.kind !== 'genesis')
      throw new Error('Missing stored record');
    expect(loaded.genesis.payload.genesis.seats[0]?.name).toBe(initialName);
    expect(loaded.entries[0]?.entry.stateHash).not.toBe('f'.repeat(64));
    const loadedSeat = loaded.genesis.payload.genesis.seats[0];
    const loadedEntry = loaded.entries[0];
    const loadedVote = loadedEntry?.certificate[0];
    if (!loadedSeat || !loadedEntry || !loadedVote) throw new Error('Missing stored details');
    loadedSeat.name = 'mutated loaded value';
    loadedVote.sig = 'A'.repeat(86);
    loaded.safety.bytes.fill(0);

    const secondLoad = await journal.load();
    expect(
      secondLoad?.genesis.payload.kind === 'genesis' &&
        secondLoad.genesis.payload.genesis.seats[0]?.name,
    ).toBe(initialName);
    expect(secondLoad?.entries[0]?.certificate[0]?.sig).not.toBe('A'.repeat(86));
    expect(secondLoad?.safety.bytes).toEqual(Uint8Array.of(8));
  });

  test('height-scoped safety adapter cannot initialize a missing record', async () => {
    const journal = new MemoryProtocolJournal();
    const safety = journalSafetyStore(journal, 1);
    expect(await safety.load()).toBeNull();
    expect(await safety.save(null, Uint8Array.of(1))).toBe(false);
    expect(await journal.load()).toBeNull();
  });
});

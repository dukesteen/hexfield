import { canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { createSimulationGenesis } from '@cp2p/protocol/testing';
import { entryHash, signEntry } from '@cp2p/protocol';
import type { CertifiedEntry, LogEntry } from '@cp2p/protocol';
import {
  IDBCursor,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBRequest,
  IDBTransaction,
} from 'fake-indexeddb';
import { openDB } from 'idb';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { IndexedDbProtocolJournal } from './indexed-db-protocol-journal.js';

interface JournalDatabase {
  games: { key: string; value: Uint8Array };
  entries: { key: [string, number]; value: Uint8Array };
  consensus: { key: string; value: Uint8Array };
}

afterEach(() => vi.unstubAllGlobals());

function installFactory(): IDBFactory {
  const factory = new IDBFactory();
  vi.stubGlobal('indexedDB', factory);
  vi.stubGlobal('IDBCursor', IDBCursor);
  vi.stubGlobal('IDBDatabase', IDBDatabase);
  vi.stubGlobal('IDBIndex', IDBIndex);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('IDBObjectStore', IDBObjectStore);
  vi.stubGlobal('IDBRequest', IDBRequest);
  vi.stubGlobal('IDBTransaction', IDBTransaction);
  return factory;
}

function fixture() {
  const simulation = createSimulationGenesis({ seed: 904 });
  const identity = simulation.identities.get(0);
  if (!identity) throw new Error('Fixture identity is missing');
  return { ...simulation, identity };
}

function nextEntry(parent: LogEntry, sequence: number, secretKey: Uint8Array): CertifiedEntry {
  const identity = fixture().identity;
  const entry = signEntry(
    {
      seq: sequence,
      term: 1,
      prevHash: entryHash(parent),
      payload: { kind: 'membership', change: { sequence } },
      stateHash: toHex(hashValue({ sequence })),
      sequencer: identity.peerId,
    },
    secretKey,
  );
  return { entry, certificate: [] };
}

describe('IndexedDbProtocolJournal', () => {
  test('initializes, commits, and restores across close and reopen', async () => {
    installFactory();
    const source = fixture();
    const safety = Uint8Array.of(1, 2, 3);
    const first = new IndexedDbProtocolJournal(source.genesis.gameId);
    expect(await first.initialize(source.entry, safety)).toBe(true);
    safety.fill(9);
    const certified = nextEntry(source.entry, 1, source.identity.secretKey);
    const wrongParent = {
      ...certified,
      entry: { ...certified.entry, prevHash: 'f'.repeat(64) },
    };
    expect(await first.commit(1, 0, wrongParent, Uint8Array.of(8))).toBe(false);
    expect(await first.commit(1, 0, certified, Uint8Array.of(4, 5))).toBe(true);
    expect(await first.initialize(source.entry, Uint8Array.of(9))).toBe(false);
    await first.close();

    const reopened = new IndexedDbProtocolJournal(source.genesis.gameId);
    expect(await reopened.load()).toEqual({
      genesis: source.entry,
      entries: [certified],
      height: 2,
      safety: { revision: 0, bytes: Uint8Array.of(4, 5) },
    });
    const loaded = await reopened.load();
    loaded?.safety.bytes.fill(0);
    expect(await reopened.loadSafety(2)).toEqual({ revision: 0, bytes: Uint8Array.of(4, 5) });
    await reopened.close();
  });

  test('serializes initialize, safety revisions, and commits across connections', async () => {
    installFactory();
    const source = fixture();
    const first = new IndexedDbProtocolJournal(source.genesis.gameId);
    const second = new IndexedDbProtocolJournal(source.genesis.gameId);
    const initialized = await Promise.all([
      first.initialize(source.entry, Uint8Array.of(1)),
      second.initialize(source.entry, Uint8Array.of(2)),
    ]);
    expect(initialized.filter(Boolean)).toHaveLength(1);

    const saved = await Promise.all([
      first.saveSafety(1, 0, Uint8Array.of(3)),
      second.saveSafety(1, 0, Uint8Array.of(4)),
    ]);
    expect(saved.filter(Boolean)).toHaveLength(1);
    const certified = nextEntry(source.entry, 1, source.identity.secretKey);
    const committed = await Promise.all([
      first.commit(1, 1, certified, Uint8Array.of(5)),
      second.commit(1, 1, certified, Uint8Array.of(6)),
    ]);
    expect(committed.filter(Boolean)).toHaveLength(1);
    expect(await first.load()).toMatchObject({ height: 2, entries: [certified] });
    await Promise.all([first.close(), second.close()]);
  });

  test('aborts entry insertion and next-height safety as one transaction', async () => {
    installFactory();
    const source = fixture();
    const journal = new IndexedDbProtocolJournal(source.genesis.gameId);
    await journal.initialize(source.entry, Uint8Array.of(1));
    const certified = nextEntry(source.entry, 1, source.identity.secretKey);
    // oxlint-disable-next-line typescript/unbound-method -- Preserve the native store receiver.
    const originalAdd = IDBObjectStore.prototype.add;
    const add = vi.spyOn(IDBObjectStore.prototype, 'add');
    add.mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = originalAdd.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort(), { once: true });
      return request;
    });
    try {
      await expect(journal.commit(1, 0, certified, Uint8Array.of(2))).rejects.toMatchObject({
        name: expect.stringMatching(/AbortError|InvalidStateError/),
      });
    } finally {
      add.mockRestore();
    }
    await journal.close();

    const reopened = new IndexedDbProtocolJournal(source.genesis.gameId);
    expect(await reopened.load()).toMatchObject({
      entries: [],
      height: 1,
      safety: { revision: 0, bytes: Uint8Array.of(1) },
    });
    await reopened.close();
  });

  test('rejects malformed records and broken history instead of resetting it', async () => {
    installFactory();
    const source = fixture();
    const journal = new IndexedDbProtocolJournal(source.genesis.gameId);
    await journal.initialize(source.entry, Uint8Array.of(1));
    await journal.close();

    const database = await openDB<JournalDatabase>('cp2p', 2);
    await database.put('consensus', canonicalEncode({ height: 2 }), source.genesis.gameId);
    database.close();
    const reopened = new IndexedDbProtocolJournal(source.genesis.gameId);
    await expect(reopened.load()).rejects.toThrow(/.+/);
    await reopened.close();
  });

  test('rejects a stored entry that no longer extends its certified parent', async () => {
    installFactory();
    const source = fixture();
    const journal = new IndexedDbProtocolJournal(source.genesis.gameId);
    await journal.initialize(source.entry, Uint8Array.of(1));
    const certified = nextEntry(source.entry, 1, source.identity.secretKey);
    await journal.commit(1, 0, certified, Uint8Array.of(2));
    await journal.close();

    const database = await openDB<JournalDatabase>('cp2p', 2);
    const broken = {
      ...certified,
      entry: { ...certified.entry, prevHash: '0'.repeat(64) },
    };
    await database.put('entries', canonicalEncode(broken), [source.genesis.gameId, 1]);
    database.close();

    const reopened = new IndexedDbProtocolJournal(source.genesis.gameId);
    await expect(reopened.load()).rejects.toThrow('Journal entry history is not contiguous');
    await reopened.close();
  });

  test('pins initialization to the constructor gameId and enforces record bounds', async () => {
    installFactory();
    const source = fixture();
    const journal = new IndexedDbProtocolJournal(source.genesis.gameId, { maxRecordBytes: 2 });
    await expect(journal.initialize(source.entry, Uint8Array.of(1))).rejects.toThrow(
      'Journal record exceeds its byte limit',
    );
    expect(await journal.load()).toBeNull();
    await journal.close();
    expect(() => new IndexedDbProtocolJournal('../invalid')).toThrow('gameId is invalid');
  });
});

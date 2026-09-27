import { Buffer } from 'node:buffer';
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
  bytes: { key: string; value: Uint8Array };
  games: { key: string; value: Uint8Array };
  entries: { key: [string, number]; value: Uint8Array };
  consensus: { key: string; value: Uint8Array };
}

interface LegacyDatabase {
  bytes: { key: string; value: Uint8Array };
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
  test.each(['-', '_'])('reopens a base64url game identifier beginning with %s', async (prefix) => {
    installFactory();
    const source = fixture();
    const gameId = prefix + source.genesis.gameId.slice(1);
    const entry: LogEntry = {
      ...source.entry,
      payload: { kind: 'genesis', genesis: { ...source.genesis, gameId } },
    };
    const journal = new IndexedDbProtocolJournal(gameId);
    expect(await journal.initialize(entry, Uint8Array.of(1))).toBe(true);
    await journal.close();
    const reopened = new IndexedDbProtocolJournal(gameId);
    expect((await reopened.load())?.genesis.payload).toEqual(entry.payload);
    await reopened.close();
  });

  test.each([false, true])(
    'atomically pins a detached voting-key record with Buffer input %s',
    async (asBuffer) => {
      installFactory();
      const source = fixture();
      const keyBytes = asBuffer ? Buffer.from([17, 18, 19]) : Uint8Array.of(17, 18, 19);
      const journal = new IndexedDbProtocolJournal(source.genesis.gameId, {
        keyBinding: { recordKey: 'vote-key-game-1', bytes: keyBytes },
      });
      keyBytes.fill(0);
      expect(await journal.initialize(source.entry, Uint8Array.of(1, 2))).toBe(true);
      expect(await journal.load()).toMatchObject({ height: 1 });
      expect(await journal.initialize(source.entry, Uint8Array.of(9))).toBe(false);
      await journal.close();

      const database = await openDB<JournalDatabase>('cp2p', 3);
      expect(await database.get('bytes', 'vote-key-game-1')).toEqual(Uint8Array.of(17, 18, 19));
      database.close();

      const reopened = new IndexedDbProtocolJournal(source.genesis.gameId, {
        keyBinding: { recordKey: 'vote-key-game-1', bytes: Uint8Array.of(17, 18, 19) },
      });
      expect(await reopened.load()).toMatchObject({
        height: 1,
        safety: { bytes: Uint8Array.of(1, 2) },
      });
      await reopened.close();
    },
  );

  test('closes terminally, drains active work, and leaves caller key buffers untouched', async () => {
    installFactory();
    const source = fixture();
    const callerBytes = Uint8Array.of(21, 22, 23);
    const persistedBytes = callerBytes.slice();
    const journal = new IndexedDbProtocolJournal(source.genesis.gameId, {
      keyBinding: { recordKey: 'vote-key-terminal', bytes: callerBytes },
    });
    callerBytes.fill(0);
    expect(await journal.initialize(source.entry, Uint8Array.of(1))).toBe(true);

    const closing = journal.close();
    expect(journal.close()).toBe(closing);
    await closing;
    expect(callerBytes).toEqual(new Uint8Array(3));
    await expect(journal.load()).rejects.toThrow('Journal is closed');
    await expect(journal.loadSafety(1)).rejects.toThrow('Journal is closed');
    await expect(journal.initialize(source.entry, Uint8Array.of(2))).rejects.toThrow(
      'Journal is closed',
    );
    await expect(journal.saveSafety(1, 0, Uint8Array.of(2))).rejects.toThrow('Journal is closed');
    await expect(
      journal.commit(1, 0, nextEntry(source.entry, 1, source.identity.secretKey), Uint8Array.of(2)),
    ).rejects.toThrow('Journal is closed');

    const reopened = new IndexedDbProtocolJournal(source.genesis.gameId, {
      keyBinding: { recordKey: 'vote-key-terminal', bytes: persistedBytes },
    });
    expect(await reopened.load()).toMatchObject({ height: 1 });
    await reopened.close();
  });

  test('close waits for a pending database upgrade before resolving', async () => {
    installFactory();
    const blocker = await openDB<LegacyDatabase>('cp2p', 1, {
      upgrade(database) {
        database.createObjectStore('bytes');
      },
    });
    const source = fixture();
    const journal = new IndexedDbProtocolJournal(source.genesis.gameId);
    let loadSettled = false;
    const loading = journal.load().finally(() => {
      loadSettled = true;
    });
    let closeSettled = false;
    const closing = journal.close().then(() => {
      closeSettled = true;
      return undefined;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loadSettled).toBe(false);
    expect(closeSettled).toBe(false);
    blocker.close();
    await expect(loading).resolves.toBeNull();
    await closing;
    expect(closeSettled).toBe(true);
    await expect(journal.load()).rejects.toThrow('Journal is closed');
  });

  test('rejects a mismatched or missing voting-key binding for an existing journal', async () => {
    installFactory();
    const source = fixture();
    const binding = { recordKey: 'vote-key-game-2', bytes: Uint8Array.of(3, 4) };
    const initialized = new IndexedDbProtocolJournal(source.genesis.gameId, {
      keyBinding: binding,
    });
    await initialized.initialize(source.entry, Uint8Array.of(1));
    await initialized.close();

    const mismatched = new IndexedDbProtocolJournal(source.genesis.gameId, {
      keyBinding: { recordKey: binding.recordKey, bytes: Uint8Array.of(3, 5) },
    });
    await expect(mismatched.load()).rejects.toThrow(/binding.*mismatched/i);
    await expect(mismatched.loadSafety(1)).rejects.toThrow(/binding.*mismatched/i);
    await expect(mismatched.initialize(source.entry, Uint8Array.of(8))).rejects.toThrow(
      /binding.*mismatched/i,
    );
    await mismatched.close();

    const database = await openDB<JournalDatabase>('cp2p', 3);
    await database.delete('consensus', source.genesis.gameId);
    database.close();
    const incomplete = new IndexedDbProtocolJournal(source.genesis.gameId, { keyBinding: binding });
    await expect(incomplete.load()).rejects.toThrow('Journal metadata is incomplete');
    await expect(incomplete.loadSafety(1)).rejects.toThrow(
      'Journal safety or voting-key binding is missing',
    );
    await expect(incomplete.initialize(source.entry, Uint8Array.of(8))).rejects.toThrow(
      'Existing journal metadata is incomplete',
    );
    await incomplete.close();

    const missingDatabase = await openDB<JournalDatabase>('cp2p', 3);
    await missingDatabase.delete('bytes', binding.recordKey);
    missingDatabase.close();
    const missing = new IndexedDbProtocolJournal(source.genesis.gameId, { keyBinding: binding });
    await expect(missing.load()).rejects.toThrow(/binding.*missing/i);
    await expect(missing.loadSafety(1)).rejects.toThrow(
      'Journal safety or voting-key binding is missing',
    );
    await expect(missing.initialize(source.entry, Uint8Array.of(8))).rejects.toThrow(
      /binding.*missing/i,
    );
    await missing.close();
  });

  test('rejects a voting-key binding when its journal is absent', async () => {
    installFactory();
    const source = fixture();
    const binding = { recordKey: 'vote-key-game-3', bytes: Uint8Array.of(6) };
    const database = await openDB<JournalDatabase>('cp2p', 3, {
      upgrade(db) {
        db.createObjectStore('bytes');
        db.createObjectStore('games');
        db.createObjectStore('entries');
        db.createObjectStore('consensus');
        db.createObjectStore('deletedGames');
      },
    });
    await database.put('bytes', binding.bytes, binding.recordKey);
    database.close();

    const journal = new IndexedDbProtocolJournal(source.genesis.gameId, { keyBinding: binding });
    await expect(journal.load()).rejects.toThrow('Voting-key binding exists without its journal');
    await expect(journal.loadSafety(1)).rejects.toThrow(
      'Voting-key binding exists without its journal',
    );
    await expect(journal.initialize(source.entry, Uint8Array.of(1))).rejects.toThrow(
      'Voting-key binding exists without its journal',
    );
    await journal.close();
  });

  test('stops safety updates and commits when the bound voting-key record changes', async () => {
    installFactory();
    const source = fixture();
    const keyBinding = { recordKey: 'vote-key-game-5', bytes: Uint8Array.of(11, 12) };
    const journal = new IndexedDbProtocolJournal(source.genesis.gameId, { keyBinding });
    expect(await journal.initialize(source.entry, Uint8Array.of(1))).toBe(true);
    expect(await journal.load()).not.toBeNull();

    const database = await openDB<JournalDatabase>('cp2p', 3);
    await database.put('bytes', Uint8Array.of(11, 13), keyBinding.recordKey);
    database.close();
    await expect(journal.saveSafety(1, 0, Uint8Array.of(2))).rejects.toThrow(
      'Journal voting-key binding is missing or mismatched',
    );
    const certified = nextEntry(source.entry, 1, source.identity.secretKey);
    await expect(journal.commit(1, 0, certified, Uint8Array.of(3))).rejects.toThrow(
      'Journal voting-key binding is missing or mismatched',
    );

    const restoreBinding = await openDB<JournalDatabase>('cp2p', 3);
    await restoreBinding.put('bytes', keyBinding.bytes, keyBinding.recordKey);
    restoreBinding.close();
    expect(await journal.load()).toMatchObject({
      entries: [],
      height: 1,
      safety: { revision: 0, bytes: Uint8Array.of(1) },
    });
    await journal.close();
  });

  test('rolls back the voting-key binding if initialization aborts after its add succeeds', async () => {
    installFactory();
    const source = fixture();
    const keyBinding = { recordKey: 'vote-key-game-4', bytes: Uint8Array.of(7, 8) };
    const journal = new IndexedDbProtocolJournal(source.genesis.gameId, { keyBinding });
    // oxlint-disable-next-line typescript/unbound-method -- Preserve the native store receiver.
    const originalAdd = IDBObjectStore.prototype.add;
    const add = vi.spyOn(IDBObjectStore.prototype, 'add');
    add.mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = originalAdd.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort(), { once: true });
      return request;
    });
    try {
      await expect(journal.initialize(source.entry, Uint8Array.of(1))).rejects.toMatchObject({
        name: expect.stringMatching(/AbortError|InvalidStateError/),
      });
    } finally {
      add.mockRestore();
    }
    await journal.close();

    const database = await openDB<JournalDatabase>('cp2p', 3);
    expect(await database.get('bytes', keyBinding.recordKey)).toBeUndefined();
    expect(await database.get('games', source.genesis.gameId)).toBeUndefined();
    expect(await database.get('consensus', source.genesis.gameId)).toBeUndefined();
    database.close();
  });

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

  test('keeps identical initialization idempotent and rejects a different signed genesis', async () => {
    installFactory();
    const source = fixture();
    const alternateIdentity = source.identities.get(1);
    if (!alternateIdentity) throw new Error('Alternate fixture identity is missing');
    const { sig: _signature, ...body } = source.entry;
    const alternateGenesis = signEntry(
      { ...body, sequencer: alternateIdentity.peerId },
      alternateIdentity.secretKey,
    );
    const journal = new IndexedDbProtocolJournal(source.genesis.gameId);
    expect(await journal.initialize(source.entry, Uint8Array.of(1))).toBe(true);
    expect(await journal.initialize(source.entry, Uint8Array.of(2))).toBe(false);
    await expect(journal.initialize(alternateGenesis, Uint8Array.of(3))).rejects.toThrow(
      'Existing journal genesis differs from requested genesis',
    );
    await journal.close();
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

    const database = await openDB<JournalDatabase>('cp2p', 3);
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

    const database = await openDB<JournalDatabase>('cp2p', 3);
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

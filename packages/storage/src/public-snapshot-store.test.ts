import { canonicalEncode } from '@cp2p/codec';
import {
  entryHash,
  genesisDigest,
  initialProposalContext,
  snapshotFromContext,
} from '@cp2p/protocol';
import type { ProposalContext } from '@cp2p/protocol';
import { createSimulationGenesis } from '@cp2p/protocol/testing';
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
import { afterEach, expect, test, vi } from 'vitest';
import { DATABASE_VERSION } from './database.js';
import { IndexedDbProtocolJournal } from './indexed-db-protocol-journal.js';
import { IndexedDbPublicSnapshotStore } from './public-snapshot-store.js';

function installFactory(): void {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBCursor', IDBCursor);
  vi.stubGlobal('IDBDatabase', IDBDatabase);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('IDBIndex', IDBIndex);
  vi.stubGlobal('IDBObjectStore', IDBObjectStore);
  vi.stubGlobal('IDBRequest', IDBRequest);
  vi.stubGlobal('IDBTransaction', IDBTransaction);
}

afterEach(() => vi.unstubAllGlobals());

async function setup() {
  installFactory();
  const fixture = createSimulationGenesis({ seed: 742 });
  const initial = initialProposalContext(fixture.entry, fixture.engine, {
    genesis: { allowStub: true },
    entry: { allowStub: true },
  });
  if (!initial.ok) throw new Error(initial.error.message);
  const gameId = fixture.genesis.gameId;
  const journal = new IndexedDbProtocolJournal(gameId);
  expect(await journal.initialize(fixture.entry, Uint8Array.of(1))).toBe(true);
  const database = await openDB('cp2p', DATABASE_VERSION);
  const contextAt = async (seq: number): Promise<ProposalContext> => {
    // Storage checks the journal's exact entry hash. Full certificate validation
    // remains the independent replay caller's responsibility.
    const head = { ...fixture.entry, seq };
    await database.put('entries', canonicalEncode({ entry: head, certificate: [] }), [gameId, seq]);
    return { ...initial.value, log: { ...initial.value.log, head } };
  };
  return { gameId, journal, database, contextAt };
}

test('persists canonical hundred-entry snapshots and retains only the latest three', async () => {
  const { gameId, journal, database, contextAt } = await setup();
  const store = new IndexedDbPublicSnapshotStore(gameId);
  for (const seq of [100, 200, 300, 400]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each save advances the tested retention window.
    await store.saveCommitted(snapshotFromContext(await contextAt(seq)));
  }
  expect(await database.getAllKeys('snapshots')).toEqual([
    [gameId, 200],
    [gameId, 300],
    [gameId, 400],
  ]);
  await store.close();
  const reopened = new IndexedDbPublicSnapshotStore(gameId);
  const context = await contextAt(400);
  expect(await reopened.loadVerified(context)).toEqual(snapshotFromContext(context));
  const altered = {
    ...context,
    log: { ...context.log, state: { ...context.log.state, revision: 99 } },
  };
  await expect(reopened.loadVerified(altered)).rejects.toThrow('differs from certified replay');
  await reopened.close();
  database.close();
  await journal.close();
});

test('refuses uncommitted or mismatched heads and unscheduled writes', async () => {
  const { gameId, journal, database, contextAt } = await setup();
  const store = new IndexedDbPublicSnapshotStore(gameId);
  const context = await contextAt(100);
  const snapshot = snapshotFromContext(context);
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Fixture snapshot is malformed');
  await expect(store.saveCommitted({ ...snapshot, seq: 101 })).rejects.toThrow('scheduled head');
  await expect(store.saveCommitted({ ...snapshot, hash: 'f'.repeat(64) })).rejects.toThrow(
    'differs',
  );
  expect(await database.getAllKeys('snapshots')).toEqual([]);
  expect(entryHash(context.log.head)).toBeDefined();
  await store.close();
  database.close();
  await journal.close();
});

test('corrupt caches never verify and deletion tombstones stop later writes', async () => {
  const { gameId, journal, database, contextAt } = await setup();
  const store = new IndexedDbPublicSnapshotStore(gameId);
  const context = await contextAt(100);
  const deeplyNested = new Uint8Array(2_049).fill(0x81);
  deeplyNested[2_048] = 0xf6; // 2,048 nested CBOR arrays containing null.
  await database.put('snapshots', deeplyNested, [gameId, 100]);
  await expect(store.loadVerified(context)).rejects.toThrow('differs from certified replay');
  await database.put(
    'deletedGames',
    canonicalEncode({
      protocol: 'online-game-deletion-v1',
      gameId,
      genesisDigest: genesisDigest(context.log.genesis),
      deletedAt: 1,
    }),
    gameId,
  );
  await expect(store.saveCommitted(snapshotFromContext(context))).rejects.toThrow(
    'deleted locally',
  );
  await store.close();
  database.close();
  await journal.close();
});

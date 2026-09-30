import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { IndexedDbByteStore } from '@cp2p/storage';
import 'fake-indexeddb/auto';
import type { Result } from '@cp2p/engine';
import { validateGenesisOnlineStart } from '@cp2p/protocol';
import type { CertifiedEntry, EscrowCeremonyStore, LogEntry } from '@cp2p/protocol';
import { createRecoveryFixture } from '@cp2p/protocol/testing';
import { beforeAll, expect, test } from 'vitest';
import { saveOnlineGameRecord, validateOnlineGameStartRecord } from './online-game-records.js';
import type { SavedOnlineGameRecord } from './online-game-records.js';
import {
  encodeOnlinePublicArchive,
  MAX_ONLINE_PUBLIC_ARCHIVE_BYTES,
  peekOnlinePublicArchiveVersion,
  validateOnlinePublicArchive,
} from './online-public-archive.js';
import {
  importOnlinePublicArchive,
  listOnlinePublicArchiveSummaries,
  listOnlinePublicArchives,
  openOnlinePublicArchive,
} from './online-public-archive-store.js';
import { runPublicArchiveWorkerRequest } from './online-public-archive-worker.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

class MemoryStore implements EscrowCeremonyStore {
  readonly records = new Map<string, Uint8Array>();
  private readonly locks = new Map<string, Promise<void>>();
  failCatalogueOnce = false;

  async close(): Promise<void> {}

  async load(id: string): Promise<Uint8Array | null> {
    return this.records.get(id)?.slice() ?? null;
  }

  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (id.endsWith('/catalogue') && this.failCatalogueOnce) {
      this.failCatalogueOnce = false;
      return false;
    }
    if (this.records.has(id)) return false;
    this.records.set(id, bytes.slice());
    return true;
  }

  async compareAndSwap(id: string, expected: Uint8Array, next: Uint8Array): Promise<boolean> {
    const current = this.records.get(id);
    if (!current || !sameBytes(current, expected)) return false;
    this.records.set(id, next.slice());
    return true;
  }

  async withCeremonyLock<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    this.locks.set(id, current);
    await previous;
    try {
      return await task();
    } finally {
      if (this.locks.get(id) === current) this.locks.delete(id);
      release();
    }
  }
}

test('worker import and open return only verified public display data', async () => {
  const store = new MemoryStore();
  const imported = await runPublicArchiveWorkerRequest(
    { id: 7, kind: 'import', bytes: archiveBytes.slice() },
    store,
  );
  expect(imported.kind).toBe('imported');
  if (imported.kind !== 'imported') return;
  const opened = await runPublicArchiveWorkerRequest(
    { id: 8, kind: 'open', archiveId: imported.archiveId },
    store,
  );
  expect(opened.kind).toBe('opened');
  if (opened.kind !== 'opened' || !opened.archive) return;
  expect(opened.archive.state.config.seats).toEqual(start.result.genesis.config.seats);
  expect(opened.archive.players.map((player) => player.name)).toEqual(
    start.agreement.state.seats.map((seat) => (seat.kind === 'open' ? '' : seat.name)),
  );
  expect('start' in opened.archive).toBe(false);
  expect('entries' in opened.archive).toBe(false);
  expect('submit' in opened.archive).toBe(false);
  const listed = await runPublicArchiveWorkerRequest({ id: 11, kind: 'list' }, store);
  expect(listed.kind).toBe('listed');
  if (listed.kind !== 'listed') throw new Error('Public replay catalogue was not listed');
  expect(listed.archives.map((item) => item.id)).toEqual([imported.archiveId]);
  expect([...store.records.keys()].every((key) => key.startsWith('online-replay/v1/'))).toBe(true);
  const bad = await runPublicArchiveWorkerRequest(
    { id: 9, kind: 'import', bytes: new Uint8Array(MAX_ONLINE_PUBLIC_ARCHIVE_BYTES + 1) },
    store,
  );
  expect(bad.kind).toBe('error');
  expect(store.records.size).toBe(2);
}, 60_000);

test('worker exports a stored signed start and certified history as importable HXAR1 bytes', async () => {
  const store = new IndexedDbByteStore({ lockProvider: async (_name, task) => task() });
  try {
    await saveOnlineGameRecord(store, {
      invite: start.invite,
      agreement: start.agreement,
      result: start.result,
    });
    const response = await runPublicArchiveWorkerRequest(
      {
        id: 10,
        kind: 'encode',
        gameId: start.gameId,
        history: { mode: 'p2p', genesis: genesisEntry, entries: deckEntries },
      },
      store,
    );
    expect(response.kind).toBe('encoded');
    if (response.kind !== 'encoded') return;
    const download = new Blob([new Uint8Array(response.bytes)], {
      type: 'application/octet-stream',
    });
    const downloaded = new Uint8Array(await download.arrayBuffer());
    const imported = value(await importOnlinePublicArchive(new MemoryStore(), downloaded));
    expect(imported.gameId).toBe(start.gameId);
    expect(imported.head.seq).toBe(deckEntries.at(-1)?.entry.seq);
    expect(imported.start.invite.serverUrl).toBe('');
  } finally {
    await store.close();
  }
}, 60_000);

let start: SavedOnlineGameRecord;
let archiveBytes: Uint8Array;
let genesisEntry: LogEntry;
let deckEntries: readonly CertifiedEntry[];

beforeAll(() => {
  const fixture = createRecoveryFixture({
    seed: 72,
    offlineSeat: null,
    lobbyId: 'archivetst',
  });
  genesisEntry = fixture.genesisEntry;
  deckEntries = fixture.deckEntries;
  const online = value(validateGenesisOnlineStart(fixture.genesis));
  const agreement = online.bindings.agreement;
  start = value(
    validateOnlineGameStartRecord({
      protocol: 'online-browser-game-v1',
      invite: {
        roomId: agreement.state.lobbyId,
        hostPeer: agreement.state.hostPeer,
        serverUrl: 'wss://private.invalid',
      },
      agreement,
      result: {
        entry: fixture.genesisEntry,
        genesis: fixture.genesis,
        transcripts: fixture.deck.transcripts,
        bindings: online.bindings.bindings,
      },
    }),
  );
  archiveBytes = value(encodeOnlinePublicArchive({ start, entries: fixture.deckEntries }));
}, 60_000);

test('opens independently verified signed start and certified history without a live session', () => {
  const bytes = archiveBytes.slice();
  const verified = value(validateOnlinePublicArchive(bytes));
  expect(verified.gameId).toBe(start.gameId);
  expect(verified.start.result.transcripts.length).toBeGreaterThan(0);
  expect(start.invite.serverUrl).toBe('wss://private.invalid');
  expect(verified.start.invite.serverUrl).toBe('');
  expect(verified.entries.length).toBeGreaterThan(0);
  expect(verified.head.seq).toBe(verified.entries.at(-1)?.entry.seq);
  expect(verified.state.result).toBeNull();
  expect('submit' in verified).toBe(false);
  expect('safety' in verified).toBe(false);
  expect('keys' in verified).toBe(false);
  bytes.fill(0);
  expect(verified.entries.length).toBeGreaterThan(0);
  expect(verified.start.result.genesis.gameId).toBe(start.gameId);
});

test('imports only to the replay namespace, deduplicates, and verifies on every open', async () => {
  const store = new MemoryStore();
  const supplied = archiveBytes.slice();
  const first = value(await importOnlinePublicArchive(store, supplied));
  supplied.fill(0);
  const second = value(await importOnlinePublicArchive(store, archiveBytes));
  expect(second.id).toBe(first.id);
  expect(value(await listOnlinePublicArchives(store))).toEqual([first.id]);
  expect(value(await listOnlinePublicArchiveSummaries(store))).toEqual([
    {
      id: first.id,
      gameId: first.gameId,
      names: start.agreement.state.seats.map((seat) => (seat.kind === 'open' ? '' : seat.name)),
      createdAt: start.result.genesis.createdAt,
      headSeq: first.head.seq,
    },
  ]);
  expect([...store.records.keys()].toSorted()).toEqual([
    `online-replay/v1/archive/${first.id}`,
    'online-replay/v1/catalogue',
  ]);
  const opened = value(await openOnlinePublicArchive(store, first.id));
  expect(opened?.head).toEqual(first.head);
  expect(opened?.state).toEqual(first.state);
  expect(value(await openOnlinePublicArchive(store, 'f'.repeat(64)))).toBeNull();
});

test('rejects oversized, malformed, and tampered certified content before storage', async () => {
  const store = new MemoryStore();
  const oversized = new Uint8Array(MAX_ONLINE_PUBLIC_ARCHIVE_BYTES + 1);
  expect(await importOnlinePublicArchive(store, oversized)).toMatchObject({
    ok: false,
    error: { code: 'public-archive-size' },
  });
  const malformed = archiveBytes.slice();
  malformed[0] = 0;
  expect((await importOnlinePublicArchive(store, malformed)).ok).toBe(false);
  const headerTooLong = archiveBytes.slice();
  headerTooLong[5] = 1;
  headerTooLong[6] = 1;
  expect((await importOnlinePublicArchive(store, headerTooLong)).ok).toBe(false);
  const headerLength = (Number(archiveBytes[5]) << 8) | Number(archiveBytes[6]);
  const contentAt = 7 + headerLength;
  const originalHeader = canonicalDecode(archiveBytes.subarray(7, contentAt));
  if (typeof originalHeader !== 'object' || originalHeader === null)
    throw new Error('Expected a public archive header');
  const extraHeader = canonicalEncode({ ...originalHeader, private: { master: 'not allowed' } });
  const extra = new Uint8Array(7 + extraHeader.length + archiveBytes.length - contentAt);
  extra.set(archiveBytes.subarray(0, 5));
  extra[5] = extraHeader.length >>> 8;
  extra[6] = extraHeader.length & 0xff;
  extra.set(extraHeader, 7);
  extra.set(archiveBytes.subarray(contentAt), 7 + extraHeader.length);
  expect((await importOnlinePublicArchive(store, extra)).ok).toBe(false);
  const payload = canonicalDecode(archiveBytes.subarray(contentAt));
  if (typeof payload !== 'object' || payload === null || !('entries' in payload))
    throw new Error('Expected a public certified prefix');
  const entries = Reflect.get(payload, 'entries');
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Missing certified entry');
  const first = entries[0];
  if (typeof first !== 'object' || first === null) throw new Error('Malformed certified entry');
  const certificate = Reflect.get(first, 'certificate');
  if (!Array.isArray(certificate) || certificate.length === 0)
    throw new Error('Missing certificate');
  certificate[0] = { ...certificate[0], sig: 'A'.repeat(86) };
  const changed = canonicalEncode(payload);
  const tampered = new Uint8Array(contentAt + changed.length);
  tampered.set(archiveBytes.subarray(0, contentAt));
  tampered.set(changed, contentAt);
  expect((await importOnlinePublicArchive(store, tampered)).ok).toBe(false);
  expect(store.records.size).toBe(0);
});

test('a full replay catalogue refuses new blobs before writing', async () => {
  const store = new MemoryStore();
  store.records.set(
    'online-replay/v1/catalogue',
    canonicalEncode({
      protocol: 'online-public-archive-catalogue-v1',
      archives: Array.from({ length: 32 }, (_, index) => ({
        id: index.toString(16).padStart(64, '0'),
        gameId: start.gameId,
        names: start.agreement.state.seats.map((seat) => (seat.kind === 'open' ? '' : seat.name)),
        createdAt: start.result.genesis.createdAt,
        headSeq: deckEntries.at(-1)?.entry.seq ?? 0,
      })),
    }),
  );
  expect(await importOnlinePublicArchive(store, archiveBytes)).toMatchObject({
    ok: false,
    error: { code: 'public-archive-limit' },
  });
  expect([...store.records.keys()]).toEqual(['online-replay/v1/catalogue']);
});

test('an exact re-import repairs an orphan after catalogue persistence failed', async () => {
  const store = new MemoryStore();
  store.failCatalogueOnce = true;
  expect(await importOnlinePublicArchive(store, archiveBytes)).toMatchObject({
    ok: false,
    error: { code: 'public-archive-catalogue' },
  });
  expect(value(await listOnlinePublicArchives(store))).toEqual([]);
  expect([...store.records.keys()]).toEqual([
    expect.stringMatching(/^online-replay\/v1\/archive\//),
  ]);
  const repaired = value(await importOnlinePublicArchive(store, archiveBytes));
  expect(value(await listOnlinePublicArchives(store))).toEqual([repaired.id]);
  expect(value(await openOnlinePublicArchive(store, repaired.id))?.head).toEqual(repaired.head);
});

test('content-address mismatch and catalogue corruption do not open a voting path', async () => {
  const store = new MemoryStore();
  const imported = value(await importOnlinePublicArchive(store, archiveBytes));
  const wrongId = 'f'.repeat(64);
  store.records.set(`online-replay/v1/archive/${wrongId}`, archiveBytes.slice());
  expect(await openOnlinePublicArchive(store, wrongId)).toMatchObject({
    ok: false,
    error: { code: 'public-archive-id' },
  });
  store.records.set(
    'online-replay/v1/catalogue',
    canonicalEncode({
      protocol: 'online-public-archive-catalogue-v1',
      archives: [imported, imported].map((archive) => ({
        id: archive.id,
        gameId: archive.gameId,
        names: start.agreement.state.seats.map((seat) => (seat.kind === 'open' ? '' : seat.name)),
        createdAt: start.result.genesis.createdAt,
        headSeq: archive.head.seq,
      })),
    }),
  );
  expect((await listOnlinePublicArchives(store)).ok).toBe(false);
  expect([...store.records.keys()].every((key) => key.startsWith('online-replay/v1/'))).toBe(true);
});

/** Rewrites the declared engine version without re-signing, like an archive from another build. */
function withDeclaredEngineVersion(engineVersion: string): Uint8Array {
  const headerLength = (Number(archiveBytes[5]) << 8) | Number(archiveBytes[6]);
  const contentAt = 7 + headerLength;
  const payload = canonicalDecode(archiveBytes.subarray(contentAt));
  const genesis = Reflect.get(
    Reflect.get(Reflect.get(Object(payload), 'start'), 'result'),
    'genesis',
  );
  Reflect.set(genesis, 'engineVersion', engineVersion);
  const changed = canonicalEncode(payload);
  const bytes = new Uint8Array(contentAt + changed.length);
  bytes.set(archiveBytes.subarray(0, contentAt));
  bytes.set(changed, contentAt);
  return bytes;
}

test('an archive from another engine version stays closed and says which version made it', async () => {
  expect(peekOnlinePublicArchiveVersion(archiveBytes)).toBeNull();
  const older = withDeclaredEngineVersion('0.0.9');
  expect(peekOnlinePublicArchiveVersion(older)).toEqual({
    relation: 'older',
    version: 'engine 0.0.9',
  });
  expect(peekOnlinePublicArchiveVersion(withDeclaredEngineVersion('10.0.0'))).toEqual({
    relation: 'newer',
    version: 'engine 10.0.0',
  });

  const store = new MemoryStore();
  const imported = await runPublicArchiveWorkerRequest(
    { id: 21, kind: 'import', bytes: older.slice() },
    store,
  );
  expect(imported).toMatchObject({ kind: 'error', version: { relation: 'older' } });
  expect(store.records.size).toBe(0);

  // An archive imported by an earlier build, opened after an update: verification still decides.
  const id = '0'.repeat(64);
  store.records.set(`online-replay/v1/archive/${id}`, older);
  const opened = await runPublicArchiveWorkerRequest(
    { id: 22, kind: 'open', archiveId: id },
    store,
  );
  expect(opened).toMatchObject({
    kind: 'error',
    version: { relation: 'older', version: 'engine 0.0.9' },
  });
}, 60_000);

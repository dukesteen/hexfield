import { canonicalEncode } from '@cp2p/codec';
import { BASE_VERSION, createBaseEngine } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { genesisDigest, LobbyController, MemoryProtocolJournal } from '@cp2p/protocol';
import type { EscrowCeremonyStore, ProtocolClock, Transport } from '@cp2p/protocol';
import { createMemnet, MemoryEscrowLifecycleStore } from '@cp2p/protocol/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadOrCreateOnlineIdentity } from './online-credentials.js';
import type { DisposableOnlineIdentity } from './online-credentials.js';
import { OnlineStartup } from './online-startup.js';
import {
  listOnlineGameRecords,
  loadOnlineGameRecord,
  saveOnlineGameRecord,
  UnsupportedOnlineGameVersionError,
} from './online-game-records.js';

interface SharedMemory {
  records: Map<string, Uint8Array>;
  locks: Map<string, Promise<void>>;
}

class MemoryStore implements EscrowCeremonyStore {
  constructor(private readonly memory: SharedMemory) {}

  async load(id: string): Promise<Uint8Array | null> {
    return this.memory.records.get(id)?.slice() ?? null;
  }

  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (this.memory.records.has(id)) return false;
    this.memory.records.set(id, bytes.slice());
    return true;
  }

  async compareAndSwap(
    id: string,
    expected: Uint8Array,
    replacement: Uint8Array,
  ): Promise<boolean> {
    const current = this.memory.records.get(id);
    if (!current || !equalBytes(current, expected)) return false;
    this.memory.records.set(id, replacement.slice());
    return true;
  }

  async withCeremonyLock<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.memory.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    this.memory.locks.set(id, current);
    await previous;
    try {
      return await task();
    } finally {
      if (this.memory.locks.get(id) === current) this.memory.locks.delete(id);
      release();
    }
  }
}

interface Fixture {
  startKey: string;
  gameId: string;
  digest: string;
  invite: { roomId: string; hostPeer: string; serverUrl: string };
  genesis: NonNullable<ReturnType<OnlineStartup['game']>>['genesis'];
  startBytes: Uint8Array;
  identity: DisposableOnlineIdentity;
  transport: Transport;
  clock: ProtocolClock;
  close(): Promise<void>;
}

function unwrap<T>(value: Result<T>): T {
  if (!value.ok) throw new Error(value.error.message);
  return value.value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

async function createFixture(serverUrl = 'ws://localhost:3009'): Promise<Fixture> {
  const store = new MemoryEscrowLifecycleStore();
  const identity = await loadOrCreateOnlineIdentity(store, (length) =>
    new Uint8Array(length).fill(31),
  );
  const network = createMemnet({ peers: [identity.peerId] });
  const invite = {
    roomId: 'recordtest',
    hostPeer: identity.peerId,
    serverUrl,
  };
  const lobby = unwrap(
    LobbyController.createHost({
      lobbyId: invite.roomId,
      name: 'Saved game fixture',
      hostName: 'Avery',
      config: {
        modules: [{ id: 'base', version: BASE_VERSION }],
        seats: [0, 1],
        options: { base: { mapLayout: 'random', vpTarget: 3 } },
      },
      transport: network.transport(identity.peerId),
      clock: network.clock,
      secretKey: identity.secretKey,
    }),
  );
  unwrap(lobby.setBot(1, 'easy'));
  unwrap(lobby.request({ kind: 'setReady', ready: true }));
  const startup = new OnlineStartup({
    invite,
    identity,
    lobby,
    transport: network.transport(identity.peerId),
    store,
    clock: network.clock,
    engine: createBaseEngine(),
    freezePeers: () => undefined,
    gameRuntime: {
      acquireLease: async () => ({
        lockName: 'online-record-test',
        run: async <T>(task: () => T | PromiseLike<T>) => task(),
        close: async () => undefined,
      }),
      createJournal: () =>
        Object.assign(new MemoryProtocolJournal(), { close: async () => undefined }),
    },
  });
  unwrap(startup.begin());
  for (let step = 0; step < 600 && startup.snapshot()?.phase !== 'playing'; step += 1) {
    network.clock.advanceBy(step % 10 === 0 ? 100 : 0);
    // oxlint-disable-next-line no-await-in-loop -- Run bounded asynchronous ceremony/storage progress.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (startup.snapshot()?.phase === 'error')
      throw new Error(startup.snapshot()?.error ?? 'Fixture startup failed');
  }
  const game = startup.game();
  if (!game) throw new Error('Online startup fixture did not open its game');
  const digest = genesisDigest(game.genesis);
  const startKey = `online-game/${digest}/start`;
  const startBytes = await store.load(startKey);
  if (!startBytes) throw new Error('Online startup did not pin its start record');
  return {
    startKey,
    gameId: game.gameId,
    digest,
    invite,
    genesis: game.genesis,
    startBytes,
    identity,
    transport: network.transport(identity.peerId),
    clock: network.clock,
    async close() {
      await startup.close();
      lobby.dispose();
      identity.dispose();
      network.dispose();
    },
  };
}

function newStore(fixture: Fixture): { memory: SharedMemory; store: MemoryStore } {
  const memory: SharedMemory = {
    records: new Map([[fixture.startKey, fixture.startBytes.slice()]]),
    locks: new Map(),
  };
  return { memory, store: new MemoryStore(memory) };
}

async function installIndexes(store: MemoryStore, fixture: Fixture): Promise<void> {
  await store.putIfAbsent(
    `online-game/${fixture.gameId}/start-digest`,
    canonicalEncode({
      protocol: 'online-game-pointer-v1',
      gameId: fixture.gameId,
      digest: fixture.digest,
      invite: fixture.invite,
      genesis: fixture.genesis,
    }),
  );
  await store.putIfAbsent(
    'online-games/catalogue-v1',
    canonicalEncode({ protocol: 'online-games-catalogue-v1', gameIds: [fixture.gameId] }),
  );
}

describe('saved online game records', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await createFixture();
  }, 60_000);

  afterAll(async () => {
    await fixture?.close();
  });

  test('retains a manual-only invitation through durable save and reload', async () => {
    const manual = await createFixture('');
    try {
      const { store } = newStore(manual);
      await installIndexes(store, manual);
      const record = await loadOnlineGameRecord(store, manual.gameId);
      if (!record) throw new Error('Manual game record is missing');
      expect(record.invite.serverUrl).toBe('');
      const saved = await saveOnlineGameRecord(store, record);
      expect((await loadOnlineGameRecord(store, saved.gameId))?.invite.serverUrl).toBe('');
    } finally {
      await manual.close();
    }
  }, 60_000);

  test('repairs crash prefixes, preserves exact startup bytes, and returns detached records', async () => {
    const { memory, store } = newStore(fixture);
    const pointerKey = `online-game/${fixture.gameId}/start-digest`;
    await store.putIfAbsent(
      pointerKey,
      canonicalEncode({
        protocol: 'online-game-pointer-v1',
        gameId: fixture.gameId,
        digest: fixture.digest,
        invite: fixture.invite,
        genesis: fixture.genesis,
      }),
    );
    const record = await loadOnlineGameRecord(store, fixture.gameId);
    if (!record) throw new Error('Missing record after pointer setup');
    const saved = await saveOnlineGameRecord(store, record);
    expect(saved.gameId).toBe(fixture.gameId);
    expect(memory.records.get(fixture.startKey)).toEqual(fixture.startBytes);
    expect(await listOnlineGameRecords(store)).toEqual({
      games: [
        {
          gameId: fixture.gameId,
          genesisDigest: fixture.digest,
          invite: fixture.invite,
          genesis: fixture.genesis,
        },
      ],
      unavailableGameIds: [],
    });
    expect(await loadOnlineGameRecord(new MemoryStore(memory), fixture.gameId)).toEqual(saved);

    Object.assign(saved.invite, { roomId: 'mutated' });
    expect((await loadOnlineGameRecord(store, fixture.gameId))?.invite.roomId).toBe('recordtest');
  });

  test('serializes concurrent identical saves and rejects a conflicting immutable start', async () => {
    const { memory, store } = newStore(fixture);
    await installIndexes(store, fixture);
    const record = await loadOnlineGameRecord(store, fixture.gameId);
    if (!record) throw new Error('Missing valid test record');
    const results = await Promise.all([
      saveOnlineGameRecord(store, record),
      saveOnlineGameRecord(new MemoryStore(memory), record),
    ]);
    expect(results.map(({ gameId }) => gameId)).toEqual([fixture.gameId, fixture.gameId]);

    const changed = {
      ...record,
      invite: { ...record.invite, serverUrl: 'wss://elsewhere.example' },
    };
    await expect(saveOnlineGameRecord(store, changed)).rejects.toThrow(/differs|frozen|agreement/);
  });

  test('fails closed on tampered pointers, missing start bytes, and altered public records', async () => {
    const pointerTamper = newStore(fixture);
    await installIndexes(pointerTamper.store, fixture);
    pointerTamper.memory.records.set(
      `online-game/${fixture.gameId}/start-digest`,
      canonicalEncode({
        protocol: 'online-game-pointer-v1',
        gameId: fixture.gameId,
        digest: 'B'.repeat(43),
        invite: fixture.invite,
        genesis: fixture.genesis,
      }),
    );
    await expect(loadOnlineGameRecord(pointerTamper.store, fixture.gameId)).rejects.toThrow(
      /genesis/,
    );

    const malformedGenesis = { ...fixture.genesis };
    Object.assign(malformedGenesis, { seats: [null] });
    const malformedPointer = newStore(fixture);
    malformedPointer.memory.records.set(
      `online-game/${fixture.gameId}/start-digest`,
      canonicalEncode({
        protocol: 'online-game-pointer-v1',
        gameId: fixture.gameId,
        digest: genesisDigest(malformedGenesis),
        invite: fixture.invite,
        genesis: malformedGenesis,
      }),
    );
    malformedPointer.memory.records.set(
      'online-games/catalogue-v1',
      canonicalEncode({ protocol: 'online-games-catalogue-v1', gameIds: [fixture.gameId] }),
    );
    expect(await listOnlineGameRecords(malformedPointer.store)).toEqual({
      games: [],
      unavailableGameIds: [fixture.gameId],
    });

    const recordTamper = newStore(fixture);
    await installIndexes(recordTamper.store, fixture);
    recordTamper.memory.records.set(fixture.startKey, canonicalEncode({ protocol: 'wrong' }));
    await expect(loadOnlineGameRecord(recordTamper.store, fixture.gameId)).rejects.toThrow(
      /Expected|Stored/,
    );

    const lostRecord = newStore(fixture);
    await installIndexes(lostRecord.store, fixture);
    lostRecord.memory.records.delete(fixture.startKey);
    await expect(loadOnlineGameRecord(lostRecord.store, fixture.gameId)).rejects.toThrow(/missing/);
  });

  test('rejects a v2 pointer or start record before strict v3 parsing and leaves bytes intact', async () => {
    const legacyGenesis = { ...fixture.genesis, protocolVersion: 2 };
    Reflect.deleteProperty(legacyGenesis, 'takeover');
    const pointer = newStore(fixture);
    const pointerKey = `online-game/${fixture.gameId}/start-digest`;
    const pointerBytes = canonicalEncode({
      protocol: 'online-game-pointer-v1',
      gameId: fixture.gameId,
      digest: fixture.digest,
      invite: fixture.invite,
      genesis: legacyGenesis,
    });
    pointer.memory.records.set(pointerKey, pointerBytes);
    await expect(loadOnlineGameRecord(pointer.store, fixture.gameId)).rejects.toMatchObject({
      code: 'unsupported-version',
      savedVersion: 2,
    });
    expect(pointer.memory.records.get(pointerKey)).toEqual(pointerBytes);
    expect(pointer.memory.records.get(fixture.startKey)).toEqual(fixture.startBytes);

    const record = newStore(fixture);
    await installIndexes(record.store, fixture);
    const valid = await loadOnlineGameRecord(record.store, fixture.gameId);
    if (!valid) throw new Error('Missing test record');
    const legacyResult = {
      ...valid.result,
      genesis: legacyGenesis,
      entry: {
        ...valid.result.entry,
        payload: { kind: 'genesis', genesis: legacyGenesis },
      },
    };
    const recordBytes = canonicalEncode({
      protocol: 'online-browser-game-v1',
      invite: valid.invite,
      agreement: valid.agreement,
      result: legacyResult,
    });
    record.memory.records.set(fixture.startKey, recordBytes);
    await expect(loadOnlineGameRecord(record.store, fixture.gameId)).rejects.toBeInstanceOf(
      UnsupportedOnlineGameVersionError,
    );
    expect(record.memory.records.get(fixture.startKey)).toEqual(recordBytes);

    const legacyResume = structuredClone(valid);
    Object.assign(legacyResume.result.genesis, { protocolVersion: 2 });
    Reflect.deleteProperty(legacyResume.result.genesis, 'takeover');
    expect(
      () =>
        new OnlineStartup({
          invite: valid.invite,
          resume: legacyResume,
          identity: fixture.identity,
          transport: fixture.transport,
          store: record.store,
          clock: fixture.clock,
          engine: createBaseEngine(),
        }),
    ).toThrow(UnsupportedOnlineGameVersionError);
    expect(record.memory.records.get(fixture.startKey)).toEqual(recordBytes);
  });

  test('evicts old catalogue entries instead of blocking a newly approved game at capacity', async () => {
    const { memory, store } = newStore(fixture);
    await installIndexes(store, fixture);
    const record = await loadOnlineGameRecord(store, fixture.gameId);
    if (!record) throw new Error('Missing valid test record');

    const olderGameIds = Array.from(
      { length: 128 },
      (_, index) => `A${index.toString(36).padStart(21, '0')}`,
    );
    memory.records.set(
      'online-games/catalogue-v1',
      canonicalEncode({ protocol: 'online-games-catalogue-v1', gameIds: olderGameIds }),
    );

    await expect(saveOnlineGameRecord(store, record)).resolves.toMatchObject({
      gameId: fixture.gameId,
    });
    const list = await listOnlineGameRecords(store);
    expect(list.games.map((game) => game.gameId)).toEqual([fixture.gameId]);
    expect(list.unavailableGameIds).toEqual(olderGameIds.slice(1));
    expect(memory.records.has(`online-game/${fixture.gameId}/start-digest`)).toBe(true);
  });

  test('reports corrupt and missing pointers while retaining other valid summaries', async () => {
    const { memory, store } = newStore(fixture);
    await installIndexes(store, fixture);
    const corruptId = `B${'1'.repeat(21)}`;
    const missingId = `C${'2'.repeat(21)}`;
    memory.records.set(
      'online-games/catalogue-v1',
      canonicalEncode({
        protocol: 'online-games-catalogue-v1',
        gameIds: [fixture.gameId, corruptId, missingId],
      }),
    );
    memory.records.set(`online-game/${corruptId}/start-digest`, canonicalEncode({ broken: true }));

    expect(await listOnlineGameRecords(store)).toEqual({
      games: [
        {
          gameId: fixture.gameId,
          genesisDigest: fixture.digest,
          invite: fixture.invite,
          genesis: fixture.genesis,
        },
      ],
      unavailableGameIds: [corruptId, missingId],
    });
  });
});

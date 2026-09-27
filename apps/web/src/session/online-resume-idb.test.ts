import { BASE_VERSION, createBaseEngine } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { LobbyController } from '@cp2p/protocol';
import { createMemnet, MemoryEscrowLifecycleStore } from '@cp2p/protocol/testing';
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
import { afterEach, expect, test, vi } from 'vitest';
import { loadOnlineIdentity, loadOrCreateOnlineIdentity } from './online-credentials.js';
import { loadOnlineGameRecord } from './online-game-records.js';
import { createOnlineLobbyTransport } from './online-lobby-transport.js';
import { OnlineStartup } from './online-startup.js';

afterEach(() => vi.unstubAllGlobals());

function installIndexedDb(): void {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBCursor', IDBCursor);
  vi.stubGlobal('IDBDatabase', IDBDatabase);
  vi.stubGlobal('IDBIndex', IDBIndex);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('IDBObjectStore', IDBObjectStore);
  vi.stubGlobal('IDBRequest', IDBRequest);
  vi.stubGlobal('IDBTransaction', IDBTransaction);
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error('Missing IndexedDB resume fixture value');
  return value;
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function availableGameLease() {
  return {
    lockName: 'idb-resume-game',
    run: async <T>(task: () => T | PromiseLike<T>): Promise<T> => task(),
    close: async () => undefined,
  };
}

async function settle(
  clock: ReturnType<typeof createMemnet>['clock'],
  done: () => boolean,
  snapshot: () => unknown,
): Promise<void> {
  for (let step = 0; step < 500; step += 1) {
    clock.advanceBy(step % 10 === 0 ? 100 : 0);
    // oxlint-disable-next-line no-await-in-loop -- One browser-style event-loop turn per virtual tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (done()) return;
  }
  throw new Error(`IndexedDB resume stalled: ${JSON.stringify(snapshot())}`);
}

async function removeSafety(gameId: string): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open('cp2p');
    opening.addEventListener('success', () => resolve(opening.result), { once: true });
    opening.addEventListener('error', () => reject(opening.error), { once: true });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('consensus', 'readwrite');
      transaction.objectStore('consensus').delete(gameId);
      transaction.addEventListener('complete', () => resolve(), { once: true });
      transaction.addEventListener('error', () => reject(transaction.error), { once: true });
      transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
    });
  } finally {
    database.close();
  }
}

test('saved signed start resumes by initializing only a wholly absent IndexedDB journal', async () => {
  installIndexedDb();
  const store = new MemoryEscrowLifecycleStore();
  const identity = await loadOrCreateOnlineIdentity(store, (length) =>
    new Uint8Array(length).fill(51),
  );
  const invite = {
    roomId: 'idbresumea',
    hostPeer: identity.peerId,
    serverUrl: 'ws://localhost:3009',
  };
  const firstNetwork = createMemnet({ peers: [identity.peerId] });
  const lobby = unwrap(
    LobbyController.createHost({
      lobbyId: invite.roomId,
      transport: createOnlineLobbyTransport(firstNetwork.transport(identity.peerId)),
      clock: firstNetwork.clock,
      secretKey: identity.secretKey,
      name: 'IndexedDB restore',
      hostName: 'Avery',
      config: {
        modules: [{ id: 'base', version: BASE_VERSION }],
        seats: [0, 1],
        options: { base: { mapLayout: 'random', vpTarget: 3 } },
      },
    }),
  );
  const first = new OnlineStartup({
    invite,
    identity,
    lobby,
    transport: firstNetwork.transport(identity.peerId),
    store,
    clock: firstNetwork.clock,
    engine: createBaseEngine(),
    freezePeers: () => undefined,
    gameRuntime: { acquireLease: async () => null },
  });
  let gameId: string;
  try {
    firstNetwork.clock.advanceBy(0);
    unwrap(lobby.setBot(1, 'easy'));
    firstNetwork.clock.advanceBy(0);
    unwrap(lobby.request({ kind: 'setReady', ready: true }));
    firstNetwork.clock.advanceBy(0);
    unwrap(first.begin());
    await settle(
      firstNetwork.clock,
      () => first.snapshot()?.phase === 'error',
      () => first.snapshot(),
    );
    expect(first.snapshot()?.error).toContain('already active');
    gameId = required(first.snapshot()?.gameId);
    expect((await loadOnlineGameRecord(store, gameId))?.gameId).toBe(gameId);
  } finally {
    await first.close();
    lobby.dispose();
    identity.dispose();
    firstNetwork.dispose();
  }

  const record = required(await loadOnlineGameRecord(store, gameId));
  const restoredIdentity = await loadOnlineIdentity(store);
  const secondNetwork = createMemnet({ peers: [restoredIdentity.peerId] });
  const second = new OnlineStartup({
    invite,
    identity: restoredIdentity,
    resume: record,
    transport: secondNetwork.transport(restoredIdentity.peerId),
    store,
    clock: secondNetwork.clock,
    engine: createBaseEngine(),
    gameRuntime: { acquireLease: async () => availableGameLease() },
  });
  try {
    await settle(
      secondNetwork.clock,
      () => second.game() !== null || second.snapshot()?.phase === 'error',
      () => second.snapshot(),
    );
    expect(second.snapshot()?.phase).toBe('playing');
    expect(required(second.game()).gameId).toBe(gameId);
    expect(required(second.game()).session.getCommittedHead().seq).toBeGreaterThanOrEqual(0);
  } finally {
    await second.close();
    restoredIdentity.dispose();
    secondNetwork.dispose();
  }

  await removeSafety(gameId);
  const brokenIdentity = await loadOnlineIdentity(store);
  const thirdNetwork = createMemnet({ peers: [brokenIdentity.peerId] });
  const third = new OnlineStartup({
    invite,
    identity: brokenIdentity,
    resume: record,
    transport: thirdNetwork.transport(brokenIdentity.peerId),
    store,
    clock: thirdNetwork.clock,
    engine: createBaseEngine(),
    gameRuntime: { acquireLease: async () => availableGameLease() },
  });
  try {
    await settle(
      thirdNetwork.clock,
      () => third.snapshot()?.phase === 'error',
      () => third.snapshot(),
    );
    expect(third.snapshot()?.error).toContain('Journal metadata is incomplete');
    expect(third.game()).toBeNull();
  } finally {
    await third.close();
    brokenIdentity.dispose();
    thirdNetwork.dispose();
  }
}, 60_000);

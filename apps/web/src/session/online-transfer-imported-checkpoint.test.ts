import { canonicalEncode, toBase64Url } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import type { Result } from '@cp2p/engine';
import { createConsensusState, genesisDigest, validateGenesisOnlineStart } from '@cp2p/protocol';
import { certifyRecoveryFixtureFirstBeacon, createRecoveryFixture } from '@cp2p/protocol/testing';
import { IndexedDbByteStore } from '@cp2p/storage';
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
import { encodeOnlineFullSave } from './online-full-save.js';
import { importOnlineFullSave } from './online-full-save-store.js';
import { validateOnlineGameStartRecord } from './online-game-records.js';
import { encodeOnlinePublicArchive } from './online-public-archive.js';
import { encodeOnlineTransferBootstrap } from './online-transfer-bootstrap.js';
import { OnlineTransferDestination } from './online-transfer-destination.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function installFactory(): void {
  vi.stubGlobal('indexedDB', new IDBFactory());
  for (const [name, item] of Object.entries({
    IDBCursor,
    IDBDatabase,
    IDBIndex,
    IDBKeyRange,
    IDBObjectStore,
    IDBRequest,
    IDBTransaction,
  }))
    vi.stubGlobal(name, item);
  vi.stubGlobal('navigator', {
    locks: {
      async request<T>(
        name: string,
        optionsOrCallback: LockOptions | LockGrantedCallback<T>,
        callbackMaybe?: LockGrantedCallback<T>,
      ) {
        const callback =
          typeof optionsOrCallback === 'function' ? optionsOrCallback : callbackMaybe;
        if (!callback) throw new TypeError('Lock callback is missing');
        return callback({ name, mode: 'exclusive' });
      },
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

test('imported checkpoint pins one seat and exact certified prefix across offer, refresh and resume', async () => {
  installFactory();
  const fixture = createRecoveryFixture({
    seed: 72,
    offlineSeat: null,
    lobbyId: 'importsave',
    masterBackedBeacon: true,
  });
  const online = value(validateGenesisOnlineStart(fixture.genesis));
  const agreement = online.bindings.agreement;
  const start = value(
    validateOnlineGameStartRecord({
      protocol: 'online-browser-game-v1',
      invite: {
        roomId: agreement.state.lobbyId,
        hostPeer: agreement.state.hostPeer,
        serverUrl: '',
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
  const publicArchive = value(encodeOnlinePublicArchive({ start, entries: fixture.deckEntries }));
  const file = value(
    await encodeOnlineFullSave({
      publicArchive,
      safety: {
        revision: 1,
        seat: 0,
        publicKey: fixture.genesis.seats[0]?.publicKey ?? '',
        bytes: canonicalEncode(value(createConsensusState(fixture.ready, 0))),
      },
    }),
  );
  const store = new IndexedDbByteStore({ lockProvider: async (_name, task) => task() });
  const imported = value(await importOnlineFullSave(store, file));
  const expected = {
    gameId: fixture.genesis.gameId,
    genesisDigest: genesisDigest(fixture.genesis),
  };
  const bootstrap = value(encodeOnlineTransferBootstrap({ start, entries: fixture.deckEntries }));
  const short = value(
    encodeOnlineTransferBootstrap({
      start,
      entries: fixture.deckEntries.slice(0, -1),
    }),
  );
  const device = identityFromSecret(new Uint8Array(32).fill(111));
  const identity = {
    ...device,
    dispose() {
      this.secretKey.fill(0);
    },
  };
  const attemptId = toBase64Url(new Uint8Array(32).fill(51));
  try {
    await expect(
      OnlineTransferDestination.create({
        attemptId,
        mode: 'new',
        expected,
        identity,
        store,
        bootstrapBytes: short,
        importedArchiveId: imported.id,
      }),
    ).rejects.toThrow(/exact certified prefix/);
    expect(
      await store.load(`online-transfer/destination/${expected.genesisDigest}/${attemptId}`),
    ).toBeNull();
    const destination = await OnlineTransferDestination.create({
      attemptId,
      mode: 'new',
      expected,
      identity,
      store,
      bootstrapBytes: bootstrap,
      importedArchiveId: imported.id,
    });
    const put = vi.spyOn(store, 'putIfAbsent');
    const writesBeforeWrongSeat = put.mock.calls.length;
    await expect(destination.prepareOffer({ seat: 1, mode: 'live' })).rejects.toThrow(
      /imported full-save seat/,
    );
    expect(put.mock.calls).toHaveLength(writesBeforeWrongSeat);
    expect((await destination.prepareOffer({ seat: 0, mode: 'live' })).statement.seat).toBe(0);
    const ordinary = certifyRecoveryFixtureFirstBeacon(fixture, fixture.ready);
    const advanced = value(
      encodeOnlineTransferBootstrap({
        start,
        entries: [...fixture.deckEntries, ordinary],
      }),
    );
    await destination.refreshBootstrap(advanced);
    await destination.close();
    await expect(
      OnlineTransferDestination.create({
        attemptId,
        mode: 'resume',
        expected,
        identity,
        store,
      }),
    ).rejects.toThrow(/another game or device/);
    await expect(
      OnlineTransferDestination.create({
        attemptId,
        mode: 'resume',
        expected,
        identity,
        store,
        importedArchiveId: 'c'.repeat(64),
      }),
    ).rejects.toThrow(/another game or device/);
    const resumed = await OnlineTransferDestination.create({
      attemptId,
      mode: 'resume',
      expected,
      identity,
      store,
      importedArchiveId: imported.id,
    });
    expect(resumed.snapshot().head.seq).toBe(ordinary.entry.seq);
    await resumed.close();
  } finally {
    identity.dispose();
    file.fill(0);
    publicArchive.fill(0);
  }
}, 60_000);

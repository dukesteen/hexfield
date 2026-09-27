import { canonicalEncode, hashValue, sha256, toHex } from '@cp2p/codec';
import { encodeScalar, identityFromSecret, scalarToBytes } from '@cp2p/crypto';
import type { Result } from '@cp2p/engine';
import {
  createConsensusState,
  createStealSecretSource,
  deckCeremonyId,
  genesisDigest,
  validateGenesisEscrow,
  validateGenesisOnlineStart,
} from '@cp2p/protocol';
import {
  acceptEscrowShare,
  createRecoveryFixture,
  escrowShareEnvelopeHash,
} from '@cp2p/protocol/testing';
import { IndexedDbByteStore, IndexedDbProtocolJournal } from '@cp2p/storage';
import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { saveOnlineGameRecord } from './online-game-records.js';
import { MAX_ONLINE_FULL_SAVE_BYTES, validateOnlineFullSave } from './online-full-save.js';
import { runOnlineFullSaveWorkerRequest } from './online-full-save-worker.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

test('ID-only worker exports a real bound private save and opens imported history without exposing secrets', async () => {
  const fixture = createRecoveryFixture({
    seed: 173,
    lobbyId: 'fullsavejb',
    masterBackedBeacon: true,
    offlineSeat: null,
  });
  const online = value(validateGenesisOnlineStart(fixture.genesis));
  const agreement = online.bindings.agreement;
  const start = {
    invite: { roomId: agreement.state.lobbyId, hostPeer: agreement.state.hostPeer, serverUrl: '' },
    agreement,
    result: {
      entry: fixture.genesisEntry,
      genesis: fixture.genesis,
      transcripts: fixture.deck.transcripts,
      bindings: online.bindings.bindings,
    },
  };
  const digest = genesisDigest(fixture.genesis);
  const owner = fixture.source.identities.get(0);
  if (!owner) throw new Error('Missing original owner');
  const device = identityFromSecret(
    hashValue({ domain: 'cp2p/test/online-device/v1', gamePeer: owner.peerId }),
  );
  const store = new IndexedDbByteStore({ lockProvider: async (_name, task) => task() });
  const keyBinding = {
    recordKey: `online-game/${digest}/keys`,
    bytes: canonicalEncode({
      protocol: 'online-game-keys-v1',
      genesisDigest: digest,
      devicePeer: device.peerId,
      humanSeat: 0,
      seats: [
        {
          seat: 0,
          kind: 'human',
          peerId: owner.peerId,
          signingKey: owner.secretKey,
          master: scalarToBytes(17n),
        },
      ],
    }),
  };
  const journal = new IndexedDbProtocolJournal(fixture.genesis.gameId, { keyBinding });
  const work = {
    createStore: () =>
      new IndexedDbByteStore({
        lockProvider: async (_name, task) => task(),
      }),
  };
  try {
    await saveOnlineGameRecord(store, start);
    expect(
      await journal.initialize(
        fixture.genesisEntry,
        canonicalEncode(value(createConsensusState(fixture.beforeSetup, 0))),
      ),
    ).toBe(true);
    const finalSafety = canonicalEncode(value(createConsensusState(fixture.ready, 0)));
    for (const certified of fixture.deckEntries) {
      // oxlint-disable-next-line no-await-in-loop -- Build the genuine certified journal in sequence.
      expect(await journal.commit(certified.entry.seq, 0, certified, finalSafety)).toBe(true);
    }
    const publicOnly = await runOnlineFullSaveWorkerRequest(
      { id: 1, kind: 'export', gameId: fixture.genesis.gameId, includePrivate: false },
      work,
    );
    expect(publicOnly).toMatchObject({ id: 1, kind: 'exported' });
    expect(await store.load('online-credentials/device-identity/v1')).toBeNull();
    expect(
      await runOnlineFullSaveWorkerRequest(
        {
          id: 2,
          kind: 'export',
          gameId: fixture.genesis.gameId,
          includePrivate: true,
          passphrase: 'short',
        },
        work,
      ),
    ).toMatchObject({ kind: 'error', code: 'full-save-passphrase' });

    expect(
      await store.putIfAbsent(
        'online-credentials/device-identity/v1',
        canonicalEncode({
          protocol: 'cp2p/online-device-identity/v1',
          peerId: device.peerId,
          secretKey: device.secretKey,
        }),
      ),
    ).toBe(true);
    const transcript = value(validateGenesisEscrow(fixture.genesis));
    const master = scalarToBytes(17n);
    const holder = createStealSecretSource(master, fixture.genesis.ceremonyNonce, 0, owner.peerId);
    master.fill(0);
    try {
      for (const dealer of transcript) {
        const delivery = dealer.shares.find(({ envelope }) => envelope.body.holder.seat === 0);
        if (!delivery) continue;
        const accepted = value(
          acceptEscrowShare({
            envelope: delivery.envelope,
            genesis: fixture.genesis,
            dealerSeat: dealer.dealerSeat,
            expectedMasterPub: delivery.envelope.body.masterPub,
            holderSeat: 0,
            recipientEncryptionSecret: holder.encryptionSecret(),
            holderSigningKey: owner.secretKey,
          }),
        );
        // oxlint-disable-next-line no-await-in-loop -- Each independently signed accepted share is stored once.
        const saved = await store.putIfAbsent(
          `escrow-accepted/${deckCeremonyId(fixture.genesis)}/${dealer.dealerSeat}/0`,
          canonicalEncode({
            protocol: 'escrow-accepted-share-v1',
            ceremonyId: deckCeremonyId(fixture.genesis),
            envelopeHash: escrowShareEnvelopeHash(delivery.envelope),
            dealerSeat: dealer.dealerSeat,
            holderSeat: 0,
            index: accepted.index,
            share: encodeScalar(accepted.value),
            ack: accepted.ack,
          }),
        );
        expect(saved).toBe(true);
      }
    } finally {
      holder.dispose();
    }
    const exported = await runOnlineFullSaveWorkerRequest(
      {
        id: 3,
        kind: 'export',
        gameId: fixture.genesis.gameId,
        includePrivate: true,
        passphrase: 'a complete private passphrase',
      },
      work,
    );
    expect(exported.kind).toBe('exported');
    if (exported.kind !== 'exported') throw new Error('Private full-save export failed');
    const decoded = value(
      await validateOnlineFullSave(exported.bytes, 'a complete private passphrase'),
    );
    expect(decoded.private?.escrowComplete).toBe(true);
    expect(decoded.private?.masters.map(({ seat }) => seat)).toEqual([0]);
    decoded.dispose();
    expect(
      await runOnlineFullSaveWorkerRequest(
        { id: 31, kind: 'import', bytes: exported.bytes.slice() },
        work,
      ),
    ).toMatchObject({ kind: 'error', code: 'full-save-passphrase' });
    expect(
      await runOnlineFullSaveWorkerRequest(
        {
          id: 32,
          kind: 'import',
          bytes: exported.bytes.slice(),
          passphrase: 'a wrong private passphrase',
        },
        work,
      ),
    ).toMatchObject({ kind: 'error', code: 'full-save-decrypt' });
    const imported = await runOnlineFullSaveWorkerRequest(
      {
        id: 4,
        kind: 'import',
        bytes: exported.bytes.slice(),
        passphrase: 'a complete private passphrase',
      },
      work,
    );
    expect(imported).toMatchObject({ kind: 'imported', archiveId: toHex(sha256(exported.bytes)) });
    if (imported.kind !== 'imported') throw new Error('Full save did not import');
    const opened = await runOnlineFullSaveWorkerRequest(
      { id: 5, kind: 'open', archiveId: imported.archiveId },
      work,
    );
    expect(opened).toMatchObject({
      kind: 'opened',
      save: { mode: 'read-only-paused', privateCapsule: 'encrypted' },
    });
    if (opened.kind !== 'opened' || !opened.save) throw new Error('Full save did not open');
    expect(opened.save).not.toHaveProperty('private');
    expect(opened.save).not.toHaveProperty('safety');
    expect(opened.save).not.toHaveProperty('start');
    expect(opened.save).not.toHaveProperty('entries');
    const listed = await runOnlineFullSaveWorkerRequest({ id: 6, kind: 'list' }, work);
    expect(listed).toMatchObject({
      kind: 'listed',
      saves: [{ id: imported.archiveId, privateCapsule: 'encrypted' }],
    });
    expect(await store.load(`online-full-import/v1/manifest/${imported.archiveId}`)).not.toBeNull();
    const publicId = toHex(
      sha256(publicOnly.kind === 'exported' ? publicOnly.bytes : new Uint8Array()),
    );
    if (publicOnly.kind !== 'exported') throw new Error('Public full-save export failed');
    const failedCatalogue = {
      createStore: () => {
        const backing = new IndexedDbByteStore({ lockProvider: async (_name, task) => task() });
        return {
          load: (key: string) => backing.load(key),
          putIfAbsent: (key: string, bytes: Uint8Array) => backing.putIfAbsent(key, bytes),
          compareAndSwap: (key: string, old: Uint8Array, next: Uint8Array) =>
            key === 'online-full-import/v1/catalogue'
              ? Promise.resolve(false)
              : backing.compareAndSwap(key, old, next),
          withCeremonyLock: <T>(key: string, task: () => Promise<T>) =>
            backing.withCeremonyLock(key, task),
          close: () => backing.close(),
        };
      },
    };
    expect(
      await runOnlineFullSaveWorkerRequest(
        { id: 33, kind: 'import', bytes: publicOnly.bytes.slice() },
        failedCatalogue,
      ),
    ).toMatchObject({ kind: 'error', code: 'full-save-catalogue' });
    expect(await store.load(`online-full-import/v1/manifest/${publicId}`)).not.toBeNull();
    expect(
      await runOnlineFullSaveWorkerRequest(
        { id: 34, kind: 'import', bytes: publicOnly.bytes.slice() },
        work,
      ),
    ).toMatchObject({ kind: 'imported', archiveId: publicId });
    const repaired = await runOnlineFullSaveWorkerRequest({ id: 35, kind: 'list' }, work);
    expect(repaired).toMatchObject({
      kind: 'listed',
      saves: [{ id: imported.archiveId }, { id: publicId }],
    });
    expect(await store.load(`online-game/${digest}/keys`)).not.toBeNull();
    expect(
      await runOnlineFullSaveWorkerRequest(
        { id: 7, kind: 'import', bytes: new Uint8Array(MAX_ONLINE_FULL_SAVE_BYTES + 1) },
        work,
      ),
    ).toMatchObject({ kind: 'error', code: 'full-save-request' });
  } finally {
    await journal.close();
    await store.close();
    keyBinding.bytes.fill(0);
    device.secretKey.fill(0);
  }
}, 90_000);

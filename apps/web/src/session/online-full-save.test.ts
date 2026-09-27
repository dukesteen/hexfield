import { canonicalDecode, canonicalEncode, sha256, toHex } from '@cp2p/codec';
import { encodeScalar, scalarToBytes } from '@cp2p/crypto';
import type { Result } from '@cp2p/engine';
import {
  createConsensusState,
  createStealSecretSource,
  deckCeremonyId,
  validateGenesisEscrow,
  validateGenesisOnlineStart,
} from '@cp2p/protocol';
import type { JournalRecord } from '@cp2p/protocol';
import {
  acceptEscrowShare,
  createRecoveryFixture,
  escrowShareEnvelopeHash,
} from '@cp2p/protocol/testing';
import { beforeAll, expect, test } from 'vitest';
import { validateOnlineGameStartRecord } from './online-game-records.js';
import type { SavedOnlineGameRecord } from './online-game-records.js';
import { encodeOnlinePublicArchive } from './online-public-archive.js';
import {
  collectOnlineFullSavePrivate,
  encodeOnlineFullSave,
  exportOnlineFullSaveFromJournal,
  MAX_ONLINE_FULL_SAVE_BYTES,
  validateOnlineFullSave,
} from './online-full-save.js';
import { importOnlineFullSave, openOnlineFullSave } from './online-full-save-store.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

const records = new Map<string, Uint8Array>();
const store = {
  async load(id: string) {
    return records.get(id)?.slice() ?? null;
  },
  async putIfAbsent(id: string, bytes: Uint8Array) {
    if (records.has(id)) return false;
    records.set(id, new Uint8Array(bytes));
    return true;
  },
};

let publicArchive: Uint8Array;
let recoveryFixture: ReturnType<typeof createRecoveryFixture>;
let startRecord: SavedOnlineGameRecord;
let journalRecord: JournalRecord;
let safety: {
  revision: number;
  seat: 0;
  publicKey: string;
  bytes: Uint8Array;
};

beforeAll(() => {
  const fixture = createRecoveryFixture({
    seed: 72,
    offlineSeat: null,
    lobbyId: 'fullsavets',
    masterBackedBeacon: true,
  });
  recoveryFixture = fixture;
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
  publicArchive = value(encodeOnlinePublicArchive({ start, entries: fixture.deckEntries }));
  startRecord = start;
  safety = {
    revision: 4,
    seat: 0,
    publicKey: fixture.genesis.seats[0]?.publicKey ?? '',
    bytes: canonicalEncode(value(createConsensusState(fixture.ready, 0))),
  };
  journalRecord = {
    genesis: fixture.genesisEntry,
    entries: [...fixture.deckEntries],
    height: fixture.ready.log.head.seq + 1,
    safety: { revision: safety.revision, bytes: safety.bytes.slice() },
  };
}, 60_000);

test('journal exporter checks the durable head again and emits a read-only public package', async () => {
  let invalidReads = 0;
  expect(
    await exportOnlineFullSaveFromJournal({
      start: startRecord,
      journal: {
        async load() {
          invalidReads += 1;
          return journalRecord;
        },
      },
      includePrivate: true,
      passphrase: 'short',
      async loadOwnedMaster() {
        throw new Error('must not load a master');
      },
    }),
  ).toMatchObject({ ok: false, error: { code: 'full-save-passphrase' } });
  expect(invalidReads).toBe(0);
  const journal = {
    async load() {
      return journalRecord;
    },
  };
  const bytes = value(await exportOnlineFullSaveFromJournal({ start: startRecord, journal }));
  const opened = value(await validateOnlineFullSave(bytes));
  expect(opened.private).toBeNull();
  expect(opened.mode).toBe('read-only-paused');
  expect(opened.safety.revision).toBe(safety.revision);
  opened.dispose();
  let reads = 0;
  const moved = {
    async load() {
      reads += 1;
      return reads === 1
        ? journalRecord
        : { ...journalRecord, safety: { ...journalRecord.safety, revision: safety.revision + 1 } };
    },
  };
  expect(
    await exportOnlineFullSaveFromJournal({ start: startRecord, journal: moved }),
  ).toMatchObject({
    ok: false,
    error: { code: 'full-save-stale' },
  });
}, 90_000);

test('portable private save verifies history and safety, then imports read-only outside live namespaces', async () => {
  const privateMaterial = value(
    await collectOnlineFullSavePrivate({
      publicArchive,
      safety,
      localSeat: 0,
      includeEscrow: false,
      async loadOwnedMaster(seat) {
        return seat === 0 ? scalarToBytes(17n) : null;
      },
    }),
  );
  try {
    expect(privateMaterial.masters.map(({ seat }) => seat)).toEqual([0]);
    expect(privateMaterial.escrowComplete).toBe(false);
    const encoded = value(
      await encodeOnlineFullSave({
        publicArchive,
        safety,
        private: privateMaterial,
        passphrase: 'a long private backup passphrase',
      }),
    );
    const decoded: unknown = canonicalDecode(encoded);
    expect(decoded).not.toHaveProperty('signingKey');
    const interrupted = new Map<string, Uint8Array>();
    let failManifest = true;
    const interruptedStore = {
      async load(id: string) {
        return interrupted.get(id)?.slice() ?? null;
      },
      async putIfAbsent(id: string, bytes: Uint8Array) {
        if (id.includes('/manifest/') && failManifest) {
          failManifest = false;
          throw new Error('interrupted manifest write');
        }
        if (interrupted.has(id)) return false;
        interrupted.set(id, new Uint8Array(bytes));
        return true;
      },
    };
    expect(
      (await importOnlineFullSave(interruptedStore, encoded, 'a long private backup passphrase'))
        .ok,
    ).toBe(false);
    expect(value(await openOnlineFullSave(interruptedStore, toHex(sha256(encoded))))).toBeNull();
    expect(
      value(
        await importOnlineFullSave(interruptedStore, encoded, 'a long private backup passphrase'),
      ).id,
    ).toBe(toHex(sha256(encoded)));
    const imported = value(
      await importOnlineFullSave(store, encoded, 'a long private backup passphrase'),
    );
    expect(
      value(await importOnlineFullSave(store, encoded, 'a long private backup passphrase')).id,
    ).toBe(imported.id);
    expect([...records.keys()].every((key) => key.startsWith('online-full-import/v1/'))).toBe(true);
    const locked = value(await openOnlineFullSave(store, imported.id));
    expect(locked?.mode).toBe('read-only-paused');
    expect(locked?.privateLocked).toBe(true);
    locked?.dispose();
    const opened = value(
      await openOnlineFullSave(store, imported.id, 'a long private backup passphrase'),
    );
    expect(opened?.public.gameId).toBe(imported.gameId);
    expect(opened?.private?.masters.map(({ seat }) => seat)).toEqual([0]);
    const master = opened?.private?.masters[0]?.master;
    expect(master).toEqual(scalarToBytes(17n));
    opened?.dispose();
    expect(master?.every((byte) => byte === 0)).toBe(true);
  } finally {
    privateMaterial.dispose();
  }
}, 90_000);

test('complete private export verifies genuine accepted shares without erasing borrowed storage', async () => {
  const fixture = recoveryFixture;
  const transcript = value(validateGenesisEscrow(fixture.genesis));
  const acceptedRecords = new Map<string, Uint8Array>();
  const originalHolder = fixture.source.identities.get(0);
  if (!originalHolder) throw new Error('Original holder identity is missing');
  const holderMaster = scalarToBytes(17n);
  const holderSource = createStealSecretSource(
    holderMaster,
    fixture.genesis.ceremonyNonce,
    0,
    originalHolder.peerId,
  );
  holderMaster.fill(0);
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
          recipientEncryptionSecret: holderSource.encryptionSecret(),
          holderSigningKey: originalHolder.secretKey,
        }),
      );
      expect(accepted.ack).toEqual(delivery.ack);
      acceptedRecords.set(
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
    }
    const originals = [...acceptedRecords.values()].map((bytes) => new Uint8Array(bytes));
    const escrowStore = {
      async load(id: string) {
        return acceptedRecords.get(id) ?? null;
      },
      async putIfAbsent() {
        return false;
      },
      async compareAndSwap() {
        return false;
      },
      async withCeremonyLock<T>(_id: string, task: () => Promise<T>) {
        return task();
      },
    };
    const privateMaterial = value(
      await collectOnlineFullSavePrivate({
        publicArchive,
        safety,
        localSeat: 0,
        escrowStore,
        async loadOwnedMaster(seat) {
          return seat === 0 ? scalarToBytes(17n) : null;
        },
      }),
    );
    try {
      expect(privateMaterial.escrowComplete).toBe(true);
      expect(privateMaterial.escrow.length).toBe(originals.length);
      const encoded = value(
        await encodeOnlineFullSave({
          publicArchive,
          safety,
          private: privateMaterial,
          passphrase: 'complete private backup passphrase',
        }),
      );
      const opened = value(
        await validateOnlineFullSave(encoded, 'complete private backup passphrase'),
      );
      expect(opened.private?.escrowComplete).toBe(true);
      expect(opened.private?.escrow.length).toBe(originals.length);
      opened.dispose();
    } finally {
      privateMaterial.dispose();
    }
    expect([...acceptedRecords.values()]).toEqual(originals);
  } finally {
    holderSource.dispose();
  }
}, 90_000);

test('wrong password, corrupt ciphertext, and stale safety never enter the import namespace', async () => {
  expect(
    await collectOnlineFullSavePrivate({
      publicArchive,
      safety,
      localSeat: 0,
      async loadOwnedMaster(seat) {
        return seat === 0 ? scalarToBytes(17n) : null;
      },
    }),
  ).toMatchObject({ ok: false, error: { code: 'full-save-escrow' } });
  const privateMaterial = value(
    await collectOnlineFullSavePrivate({
      publicArchive,
      safety,
      localSeat: 0,
      includeEscrow: false,
      async loadOwnedMaster(seat) {
        return seat === 0 ? scalarToBytes(17n) : null;
      },
    }),
  );
  try {
    const encoded = value(
      await encodeOnlineFullSave({
        publicArchive,
        safety,
        private: privateMaterial,
        passphrase: 'a long private backup passphrase',
      }),
    );
    const isolated = new Map<string, Uint8Array>();
    const target = {
      async load(id: string) {
        return isolated.get(id)?.slice() ?? null;
      },
      async putIfAbsent(id: string, bytes: Uint8Array) {
        if (isolated.has(id)) return false;
        isolated.set(id, new Uint8Array(bytes));
        return true;
      },
    };
    expect(
      await importOnlineFullSave(target, encoded, 'incorrect private passphrase'),
    ).toMatchObject({
      ok: false,
      error: { code: 'full-save-decrypt' },
    });
    expect(await importOnlineFullSave(target, encoded)).toMatchObject({
      ok: false,
      error: { code: 'full-save-passphrase' },
    });
    const concurrent = await Promise.all([
      validateOnlineFullSave(encoded, 'a long private backup passphrase'),
      validateOnlineFullSave(encoded, 'a long private backup passphrase'),
    ]);
    expect(
      concurrent.filter((item) => !item.ok && item.error.code === 'full-save-busy'),
    ).toHaveLength(1);
    concurrent.forEach((item) => {
      if (item.ok) item.value.dispose();
    });
    const changedSafety: unknown = canonicalDecode(encoded);
    if (!changedSafety || typeof changedSafety !== 'object' || !('safety' in changedSafety))
      throw new Error('Full save safety is missing');
    const metadata = Reflect.get(changedSafety, 'safety');
    if (!metadata || typeof metadata !== 'object') throw new Error('Safety metadata is missing');
    Reflect.set(metadata, 'revision', safety.revision + 1);
    expect(
      await validateOnlineFullSave(
        canonicalEncode(changedSafety),
        'a long private backup passphrase',
      ),
    ).toMatchObject({ ok: false, error: { code: 'full-save-decrypt' } });
    const corrupt = encoded.slice();
    corrupt[corrupt.length - 20] = (corrupt[corrupt.length - 20] ?? 0) ^ 1;
    expect(
      (await importOnlineFullSave(target, corrupt, 'a long private backup passphrase')).ok,
    ).toBe(false);
    expect(isolated.size).toBe(0);
    expect(
      await encodeOnlineFullSave({
        publicArchive,
        safety: { ...safety, publicKey: 'A'.repeat(43) },
      }),
    ).toMatchObject({ ok: false });
    expect(
      await validateOnlineFullSave(new Uint8Array(MAX_ONLINE_FULL_SAVE_BYTES + 1)),
    ).toMatchObject({
      ok: false,
      error: { code: 'full-save-size' },
    });
    expect(
      await validateOnlineFullSave(new TextEncoder().encode(`[${'null,'.repeat(2050)}null]`)),
    ).toMatchObject({
      ok: false,
      error: { code: 'full-save-format' },
    });
  } finally {
    privateMaterial.dispose();
  }
}, 90_000);

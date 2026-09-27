import { canonicalEncode } from '@cp2p/codec';
import {
  G,
  encodePoint,
  identityFromSecret,
  scalePoint,
  scalarToBytes,
  signObject,
} from '@cp2p/crypto';
import { createBaseEngine } from '@cp2p/engine';
import {
  createConsensusState,
  genesisDigest,
  MemoryProtocolJournal,
  validateGenesisOnlineStart,
} from '@cp2p/protocol';
import {
  TRANSFER_DESTINATION_CHECK_DOMAIN,
  TRANSFER_DEVICE_DOMAIN,
  TRANSFER_GAME_KEY_DOMAIN,
  TRANSFER_OWNER_GAME_DOMAIN,
  advanceRecoveryFixture,
  certifyRecoveryFixtureEntry,
  createMemnet,
  createRecoveryFixture,
  MemoryEscrowLifecycleStore,
  recoveryFixtureKey,
  signRecoveryFixtureEntry,
  transferCheckDigest,
  transferEntryRef,
} from '@cp2p/protocol/testing';
import { expect, test } from 'vitest';
import type { SavedOnlineGameRecord } from './online-game-records.js';
import { loadActiveOnlineResume } from './online-resume-binding.js';
import { OnlineStartup } from './online-startup.js';

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing certified resume fixture');
  return value;
}

test('admits only a certified active replacement route and keeps its private keys inside the worker', async () => {
  const fixture = createRecoveryFixture({ masterBackedBeacon: true });
  const start = validateGenesisOnlineStart(fixture.genesis);
  if (!start.ok) throw new Error(start.error.message);
  const old = required(fixture.ready.log.authority?.controllers.find(({ seat }) => seat === 0));
  const destination = identityFromSecret(new Uint8Array(32).fill(111));
  const game = identityFromSecret(new Uint8Array(32).fill(112));
  const statement = {
    protocol: 'seat-transfer-v1' as const,
    genesisDigest: genesisDigest(fixture.genesis),
    anchor: transferEntryRef(fixture.ready.log.head),
    validUntilSeq: fixture.ready.log.head.seq + 64,
    mode: 'live' as const,
    seat: 0 as const,
    currentController: {
      publicKey: old.publicKey,
      kind: old.kind,
      activatedAt: old.activatedAt,
      hostSeat: old.hostSeat,
    },
    recovery: null,
    nextEpoch: 1,
    destination: {
      devicePeer: destination.peerId,
      gamePeer: game.peerId,
      transferEncryptionKey: encodePoint(scalePoint(G, 147n)),
    },
    replacements: [
      {
        seat: 0 as const,
        oldPublicKey: old.publicKey,
        newPublicKey: game.peerId,
        newHostSeat: 0 as const,
      },
    ],
  };
  const authorization = {
    kind: 'transfer-authorize' as const,
    statement,
    destinationDeviceSig: signObject(TRANSFER_DEVICE_DOMAIN, statement, destination.secretKey),
    destinationGameSig: signObject(TRANSFER_GAME_KEY_DOMAIN, statement, game.secretKey),
    replacementKeySigs: [],
    ownerIntent: {
      signer: 'current-game' as const,
      sig: signObject(TRANSFER_OWNER_GAME_DOMAIN, statement, recoveryFixtureKey(fixture, 0)),
    },
  };
  const authorizedEntry = signRecoveryFixtureEntry(
    fixture,
    fixture.ready,
    { kind: 'membership', change: authorization },
    fixture.ready.log.head.stateHash,
  );
  const authorizedCertificate = certifyRecoveryFixtureEntry(
    fixture,
    fixture.ready,
    authorizedEntry,
    [0, 1, 2, 3],
  );
  const authorized = advanceRecoveryFixture(fixture.ready, authorizedCertificate);
  const activationStatement = {
    protocol: 'seat-transfer-activation-v1' as const,
    genesisDigest: statement.genesisDigest,
    authorization: transferEntryRef(authorizedEntry),
    parent: transferEntryRef(authorized.log.head),
    nextEpoch: 1,
    destinationDevice: destination.peerId,
    destinationGame: game.peerId,
    replacements: statement.replacements,
    checkDigest: transferCheckDigest(authorized.log, transferEntryRef(authorizedEntry)),
  };
  const activationEntry = signRecoveryFixtureEntry(
    fixture,
    authorized,
    {
      kind: 'membership',
      change: {
        kind: 'transfer-activate',
        statement: activationStatement,
        destinationCheck: signObject(
          TRANSFER_DESTINATION_CHECK_DOMAIN,
          activationStatement,
          game.secretKey,
        ),
        replacementChecks: [],
      },
    },
    authorized.log.head.stateHash,
  );
  const activation = certifyRecoveryFixtureEntry(
    fixture,
    authorized,
    activationEntry,
    [0, 1, 2, 3],
  );
  const activated = advanceRecoveryFixture(authorized, activation);
  const safety = createConsensusState(activated, 0);
  if (!safety.ok) throw new Error(safety.error.message);
  const journal = new MemoryProtocolJournal();
  expect(await journal.initialize(fixture.genesisEntry, Uint8Array.of(1))).toBe(true);
  for (const certified of [...fixture.deckEntries, authorizedCertificate, activation]) {
    // oxlint-disable-next-line no-await-in-loop -- Preserve the certified ancestry in this fixture.
    const committed = await journal.commit(
      certified.entry.seq,
      0,
      certified,
      certified === activation ? canonicalEncode(safety.value) : Uint8Array.of(1),
    );
    expect(committed).toBe(true);
  }
  const record: SavedOnlineGameRecord = {
    gameId: fixture.genesis.gameId,
    genesisDigest: statement.genesisDigest,
    invite: {
      roomId: start.value.bindings.agreement.state.lobbyId,
      hostPeer: start.value.bindings.agreement.state.hostPeer,
      serverUrl: '',
    },
    agreement: start.value.bindings.agreement,
    result: {
      entry: fixture.genesisEntry,
      genesis: fixture.genesis,
      transcripts: fixture.deck.transcripts,
      bindings: start.value.bindings.bindings,
    },
  };
  const binding = canonicalEncode({
    protocol: 'online-game-keys-v1',
    genesisDigest: statement.genesisDigest,
    devicePeer: destination.peerId,
    humanSeat: 0,
    seats: [
      {
        seat: 0,
        kind: 'human',
        peerId: game.peerId,
        signingKey: game.secretKey,
        master: scalarToBytes(17n),
      },
    ],
  });
  const store = {
    load: async (key: string) =>
      key === `online-game/${statement.genesisDigest}/keys` ? binding.slice() : null,
  };
  const createJournal = () => Object.assign(journal, { close: async () => undefined });
  const common = { store, record, engine: createBaseEngine(), createJournal };
  const publicView = await loadActiveOnlineResume({
    ...common,
    devicePeer: destination.peerId,
  });
  expect(publicView.gamePeer).toBe(game.peerId);
  expect(publicView.material).toBeNull();
  expect(publicView.peers).toContain(destination.peerId);
  const withMaterial = await loadActiveOnlineResume({
    ...common,
    devicePeer: destination.peerId,
    includeMaterial: true,
  });
  expect(withMaterial.material?.keys[0]?.peerId).toBe(game.peerId);
  withMaterial.material?.dispose();
  expect(withMaterial.material?.keys[0]?.master).toEqual(new Uint8Array(32));
  const oldDevice = required(
    start.value.bindings.agreement.state.seats.find(
      (seat) => seat.seat === 0 && seat.kind === 'human',
    ),
  );
  if (oldDevice.kind !== 'human') throw new Error('Missing original device');
  await expect(
    loadActiveOnlineResume({
      ...common,
      devicePeer: oldDevice.peer,
    }),
  ).rejects.toThrow(/binding differs/);
  const forged = new MemoryProtocolJournal();
  expect(await forged.initialize(fixture.genesisEntry, Uint8Array.of(1))).toBe(true);
  for (const certified of fixture.deckEntries) {
    // oxlint-disable-next-line no-await-in-loop -- Build the older certified parent only.
    expect(await forged.commit(certified.entry.seq, 0, certified, Uint8Array.of(1))).toBe(true);
  }
  await expect(
    loadActiveOnlineResume({
      ...common,
      devicePeer: destination.peerId,
      createJournal: () => Object.assign(forged, { close: async () => undefined }),
    }),
  ).rejects.toThrow(/certified active generation/);

  const durable = new MemoryEscrowLifecycleStore();
  expect(await durable.putIfAbsent(`online-game/${statement.genesisDigest}/keys`, binding)).toBe(
    true,
  );
  const net = createMemnet({
    peers: [
      ...start.value.bindings.agreement.state.seats.flatMap((seat) =>
        seat.kind === 'human' ? [seat.peer] : [],
      ),
      destination.peerId,
    ],
  });
  const startup = new OnlineStartup({
    resume: record,
    invite: record.invite,
    identity: { ...destination, dispose: () => undefined },
    transport: net.transport(destination.peerId),
    store: durable,
    clock: net.clock,
    engine: fixture.source.engine,
    gameRuntime: {
      acquireLease: async () => ({
        lockName: 'transferred-resume-test',
        run: async <T>(task: () => T | PromiseLike<T>): Promise<T> => task(),
        close: async () => undefined,
      }),
      createJournal,
    },
  });
  try {
    for (let step = 0; step < 200 && startup.snapshot()?.phase !== 'playing'; step++) {
      // oxlint-disable-next-line no-await-in-loop -- Let the real certified restore yield.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(startup.snapshot()).toMatchObject({ phase: 'playing', gameId: record.gameId });
    expect(startup.game()?.seat).toBe(0);
  } finally {
    await startup.close();
    net.dispose();
  }
}, 30_000);

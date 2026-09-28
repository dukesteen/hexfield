import { canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import {
  G,
  decodePoint,
  parsePeerId,
  proveDleq,
  verifyDleq,
  verifyObject,
  encodePoint,
  identityFromSecret,
  scalePoint,
  scalarToBytes,
  signObject,
} from '@cp2p/crypto';
import { createBaseEngine } from '@cp2p/engine';
import {
  createConsensusState,
  encodeProtocolMessage,
  createStealSecretSource,
  validateGenesisEscrow,
  genesisDigest,
  MemoryProtocolJournal,
  P2PSession,
  validateGenesisOnlineStart,
} from '@cp2p/protocol';
import {
  TRANSFER_DESTINATION_CHECK_DOMAIN,
  TRANSFER_DEVICE_DOMAIN,
  TRANSFER_GAME_KEY_DOMAIN,
  TRANSFER_OWNER_GAME_DOMAIN,
  advanceRecoveryFixture,
  escrowShareEnvelopeHash,
  certifyRecoveryFixtureEntry,
  createMemnet,
  createRecoveryFixture,
  MemoryEscrowLifecycleStore,
  recoveryFixtureKey,
  signRecoveryFixtureEntry,
  transferCheckDigest,
  transferEntryRef,
} from '@cp2p/protocol/testing';
import { expect, test, vi } from 'vitest';
import type { SavedOnlineGameRecord } from './online-game-records.js';
import { loadActiveOnlineResume } from './online-resume-binding.js';
import { OnlineStartup } from './online-startup.js';

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing certified resume fixture');
  return value;
}

test.each([
  'clean',
  'disclosed',
  'during-open',
  'malformed',
  'foreign',
  'lossy',
  'overflow',
] as const)(
  'certified transferred resume with %s retained evidence',
  async (evidence) => {
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
    // oxlint-disable vitest/no-conditional-expect -- Only the disclosed parameter constructs and verifies this authenticated witness.
    let disclosureRecord: { key: string; bytes: Uint8Array } | null = null;
    if (evidence !== 'clean' && evidence !== 'lossy' && evidence !== 'overflow') {
      const escrow = validateGenesisEscrow(fixture.genesis);
      if (!escrow.ok) throw new Error(escrow.error.message);
      const envelope = required(required(escrow.value[0]).shares[0]).envelope;
      const holderSeat = envelope.body.holder.seat;
      const holderGame = required(fixture.source.identities.get(holderSeat));
      const holderDevice = identityFromSecret(
        hashValue({ domain: 'cp2p/test/online-device/v1', gamePeer: holderGame.peerId }),
      );
      const frozenHolder = required(
        record.agreement.state.seats.find((seat) => seat.seat === holderSeat),
      );
      if (frozenHolder.kind !== 'human') throw new Error('Expected frozen holder');
      expect(holderDevice.peerId).toBe(frozenHolder.peer);
      const source = createStealSecretSource(
        scalarToBytes(BigInt(17 + holderSeat)),
        fixture.genesis.ceremonyNonce,
        holderSeat,
        holderGame.peerId,
      );
      const secret = source.encryptionSecret();
      source.dispose();
      const context = {
        protocol: 'escrow-share-dispute-v1' as const,
        ceremonyId: envelope.body.ceremonyId,
        dealerSeat: envelope.body.dealer.seat,
        holderSeat,
        envelopeHash: escrowShareEnvelopeHash(envelope),
      };
      const sharedPoint = encodePoint(
        scalePoint(decodePoint(envelope.body.sealed.ephemeral), secret),
      );
      const dleqStatement = {
        base1: encodePoint(G),
        point1: envelope.body.holder.encryptionKey,
        base2: envelope.body.sealed.ephemeral,
        point2: sharedPoint,
      };
      const proof = proveDleq(dleqStatement, secret, new Uint8Array(32).fill(99), context);
      expect(verifyDleq(dleqStatement, proof, context)).toBe(true);
      const body = { ...context, sharedPoint, proof };
      const dispute = { body, sig: signObject('escrow-share-dispute', body, holderGame.secretKey) };
      expect(
        verifyObject('escrow-share-dispute', body, dispute.sig, parsePeerId(holderGame.peerId)),
      ).toBe(true);
      const freezeHash = toHex(hashValue(record.agreement.state));
      const ceremonyNonce = required(record.agreement.state.ceremonyNonce);
      const packetBody = {
        protocol: 'online-ceremony-v1' as const,
        freezeHash,
        ceremonyNonce,
        senderDevice: holderDevice.peerId,
        kind: 'escrow-dispute' as const,
        seat: holderSeat,
        step: envelope.body.dealer.seat,
        payload: { envelope, dispute },
      };
      const packet = {
        body: packetBody,
        sig: signObject('online-ceremony-message-v1', packetBody, holderDevice.secretKey),
      };
      expect(
        verifyObject(
          'online-ceremony-message-v1',
          packetBody,
          packet.sig,
          parsePeerId(frozenHolder.peer),
        ),
      ).toBe(true);
      const attempt = toHex(
        hashValue({ domain: 'cp2p/v1/online-attempt', freezeHash, nonce: ceremonyNonce }),
      );
      const foreignBody = {
        ...packetBody,
        ceremonyNonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      };
      const retained =
        evidence === 'foreign'
          ? {
              body: foreignBody,
              sig: signObject('online-ceremony-message-v1', foreignBody, holderDevice.secretKey),
            }
          : packet;
      disclosureRecord = {
        key: `online-ceremony/${attempt}/escrow-dispute/${holderSeat}/${envelope.body.dealer.seat}`,
        bytes: evidence === 'malformed' ? Uint8Array.of(1) : canonicalEncode(retained),
      };
      if (evidence !== 'during-open')
        expect(await durable.putIfAbsent(disclosureRecord.key, disclosureRecord.bytes)).toBe(true);
      holderDevice.secretKey.fill(0);
    }
    // oxlint-enable vitest/no-conditional-expect
    const net = createMemnet({
      peers: [
        ...start.value.bindings.agreement.state.seats.flatMap((seat) =>
          seat.kind === 'human' ? [seat.peer] : [],
        ),
        destination.peerId,
      ],
    });
    let injected = false;
    let queuedAttempts = 0;
    let failedPeer: string | undefined;
    const actualRestore = P2PSession.restore.bind(P2PSession);
    const restore = vi.spyOn(P2PSession, 'restore').mockImplementation(async (options) => {
      const actualSend = options.transport.send.bind(options.transport);
      const send = vi.spyOn(options.transport, 'send').mockImplementation((to, bytes) => {
        queuedAttempts += 1;
        actualSend(to, bytes);
      });
      const opened = await actualRestore(options);
      if (opened.ok) {
        const request = encodeProtocolMessage({
          t: 'SYNC_REQ',
          genesisDigest: genesisDigest(fixture.genesis),
          fromSeq: 1,
        });
        if (!request.ok) throw new Error(request.error.message);

        for (let index = 0; index < (evidence === 'overflow' ? 129 : 1); index++)
          options.transport.broadcast(request.value);
      }
      send.mockRestore();
      if (evidence === 'during-open' && !injected) {
        injected = true;
        const retained = required(disclosureRecord);
        await durable.putIfAbsent(retained.key, retained.bytes);
      }
      return opened;
    });
    const actualTransport = net.transport(destination.peerId);
    const delivered: [string, Uint8Array][] = [];
    const output = vi.fn<(to: string, bytes: Uint8Array) => void>((to, bytes) => {
      if (evidence === 'lossy') {
        failedPeer ??= to;
        if (to === failedPeer) throw new Error('Disconnected test peer');
      }
      actualTransport.send(to, bytes);
      delivered.push([to, bytes.slice()]);
    });
    const observedTransport = {
      self: actualTransport.self,
      peers: () => actualTransport.peers(),
      send: output,
      broadcast: (bytes: Uint8Array) => {
        for (const peer of actualTransport.peers()) output(peer, bytes);
      },
      onMessage: actualTransport.onMessage.bind(actualTransport),
      onPeerChange: actualTransport.onPeerChange.bind(actualTransport),
      disconnect: actualTransport.disconnect.bind(actualTransport),
    };
    const startup = new OnlineStartup({
      resume: record,
      invite: record.invite,
      identity: { ...destination, dispose: () => undefined },
      transport: observedTransport,
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
      expect(startup.snapshot()).toMatchObject({
        phase:
          evidence === 'disclosed' || evidence === 'during-open'
            ? 'halted'
            : evidence === 'overflow'
              ? 'error'
              : 'playing',
        gameId: record.gameId,
      });
      if (evidence === 'disclosed' || evidence === 'during-open') {
        // oxlint-disable-next-line vitest/no-conditional-expect -- These parameters require discarded opening output.
        expect(output).not.toHaveBeenCalled();
      }
      if (evidence !== 'disclosed') {
        // oxlint-disable-next-line vitest/no-conditional-expect -- Prove these paths actually attempted queued output.
        expect(queuedAttempts).toBeGreaterThan(0);
      }
      if (evidence === 'clean' || evidence === 'lossy') {
        // oxlint-disable-next-line vitest/no-conditional-expect -- Clean and lossy openings release queued output.
        expect(output).toHaveBeenCalled();
      }
      if (evidence === 'lossy') {
        // oxlint-disable-next-line vitest/no-conditional-expect -- Other peers receive the original FIFO after one peer fails.
        expect(delivered.length).toBeGreaterThan(0);
        // oxlint-disable-next-line vitest/no-conditional-expect
        expect(delivered).toEqual(output.mock.calls.filter(([to]) => to !== failedPeer));
      }
      if (evidence === 'overflow') {
        // oxlint-disable-next-line vitest/no-conditional-expect -- Overflow must fail before releasing any partial queue.
        expect(output).not.toHaveBeenCalled();
      }
      expect(injected).toBe(evidence === 'during-open');
      expect(startup.game()?.seat).toBe(
        evidence === 'disclosed' || evidence === 'during-open' || evidence === 'overflow'
          ? undefined
          : 0,
      );
    } finally {
      await startup.close();
      restore.mockRestore();
      net.dispose();
    }
  },
  30_000,
);

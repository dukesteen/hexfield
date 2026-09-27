import { canonicalEncode, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import {
  G,
  encodePoint,
  identityFromSecret,
  scalePoint,
  scalarToBytes,
  signObject,
} from '@cp2p/crypto';
import { BASE_VERSION, createBaseEngine, ENGINE_VERSION } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import { MAX_MESSAGE_BYTES as MAX_WEBRTC_MESSAGE_BYTES } from '@cp2p/p2p';
import {
  createConsensusState,
  decodeProtocolMessage,
  encodeProtocolMessage,
  MemoryProtocolJournal,
  genesisId,
  genesisDigest,
  LobbyController,
  MAX_MESSAGE_BYTES as MAX_PROTOCOL_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  signGameSeatBinding,
  validateGenesisOnlineStart,
  verifyGameSeatBindings,
} from '@cp2p/protocol';
import type {
  Genesis,
  GenesisBody,
  LobbyFreezeAgreement,
  PeerId,
  ValidatedGenesis,
} from '@cp2p/protocol';
import {
  advanceRecoveryFixture,
  certifyRecoveryFixtureEntry,
  createMemnet,
  MemoryEscrowLifecycleStore,
  createRecoveryFixture,
  recoveryFixtureKey,
  signRecoveryFixtureEntry,
  TRANSFER_DESTINATION_CHECK_DOMAIN,
  TRANSFER_DEVICE_DOMAIN,
  TRANSFER_GAME_KEY_DOMAIN,
  TRANSFER_OWNER_GAME_DOMAIN,
  transferCheckDigest,
  transferEntryRef,
} from '@cp2p/protocol/testing';
import { expect, test } from 'vitest';
import { createOnlineGameTransport } from './online-game-transport.js';
import { openOnlineGame } from './online-game.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing game transport fixture value');
  return item;
}

function fixture() {
  const seed = toBase64Url(new Uint8Array(32).fill(7));
  const deviceKeys = [1, 2, 3].map((byte) => new Uint8Array(32).fill(byte));
  const devices = deviceKeys.map((key) => identityFromSecret(key).peerId);
  const net = createMemnet({ peers: devices });
  const host = value(
    LobbyController.createHost({
      lobbyId: 'game_transport',
      name: 'Online game',
      hostName: 'Avery',
      config: {
        modules: [{ id: 'base', version: BASE_VERSION }],
        seats: [0, 1, 2, 3],
        options: { base: { mapLayout: 'random', vpTarget: 3 } },
      },
      transport: net.transport(required(devices[0])),
      clock: net.clock,
      secretKey: required(deviceKeys[0]),
      seedMode: { kind: 'fixed', seed },
    }),
  );
  const guest = value(
    LobbyController.join({
      lobbyId: 'game_transport',
      hostPeer: required(devices[0]),
      transport: net.transport(required(devices[1])),
      clock: net.clock,
      secretKey: required(deviceKeys[1]),
    }),
  );
  const spectator = value(
    LobbyController.join({
      lobbyId: 'game_transport',
      hostPeer: required(devices[0]),
      transport: net.transport(required(devices[2])),
      clock: net.clock,
      secretKey: required(deviceKeys[2]),
    }),
  );
  const flush = () => net.clock.advanceBy(0);
  flush();
  value(spectator.request({ kind: 'spectate' }));
  flush();
  value(guest.request({ kind: 'takeSeat', seat: 1 }));
  flush();
  value(host.setBot(2, 'easy'));
  flush();
  value(host.setBot(3, 'easy', required(devices[1])));
  flush();
  value(host.request({ kind: 'setReady', ready: true }));
  flush();
  value(guest.request({ kind: 'setReady', ready: true }));
  flush();
  value(host.start(toBase64Url(new Uint8Array(32).fill(91))));
  flush();
  value(host.ackFreeze());
  value(guest.ackFreeze());
  flush();
  const agreement = required(host.freezeAgreement());
  const seats: Seat[] = [0, 1, 2, 3];
  const bindings = seats.map((seat) => {
    const owner = seat === 3 ? 1 : seat === 2 ? 0 : seat;
    return value(
      signGameSeatBinding({
        agreement,
        seat,
        deviceSecretKey: required(deviceKeys[owner]),
        gamePeer: identityFromSecret(new Uint8Array(32).fill(11 + seat)).peerId,
        masterPub: encodePoint(scalePoint(G, BigInt(17 + seat))),
        encryptionKey: encodePoint(scalePoint(G, BigInt(37 + seat))),
      }),
    );
  });
  const verified = value(verifyGameSeatBindings(agreement, bindings));
  const body: GenesisBody = {
    protocolVersion: PROTOCOL_VERSION,
    engineVersion: ENGINE_VERSION,
    config: agreement.state.config,
    seats: [...verified.genesisSeats],
    genesisSeed: seed,
    ceremonyNonce: required(agreement.state.ceremonyNonce),
    security: 'verified',
    takeover: agreement.state.takeover,
    commitments: {
      masters: verified.masters,
      onlineStart: {
        protocol: 'online-start-v1',
        agreement,
        bindings,
        seed: { protocol: 'genesis-seed-v1', kind: 'fixed', seed },
      },
    },
    createdAt: 1,
  };
  value(validateGenesisOnlineStart(body));
  const genesis: Genesis = { ...body, gameId: genesisId(body), signatures: [] };
  // These tests isolate routing after admission; production supplies validateGenesis's output.
  const validatedGenesis: ValidatedGenesis = {
    genesis,
    state: createBaseEngine().createGame(body.config, new Uint8Array(32).fill(7)),
  };
  return {
    net,
    host,
    guest,
    spectator,
    agreement,
    bindings,
    validatedGenesis,
    devices,
    gameKeys: bindings.map((binding) => binding.body.gamePeer),
    open(device: PeerId, admitted = validatedGenesis) {
      return value(
        createOnlineGameTransport({
          deviceTransport: net.transport(device),
          validatedGenesis: admitted,
          agreement,
          bindings,
        }),
      );
    },
    flush,
    dispose() {
      spectator.dispose();
      guest.dispose();
      host.dispose();
      net.dispose();
    },
  };
}

test('routes only frozen human game keys and isolates gameplay from lobby, ceremony, and wrong-game frames', () => {
  const room = fixture();
  const left = room.open(required(room.devices[0]));
  const right = room.open(required(room.devices[1]));
  try {
    expect(left.self).toBe(room.gameKeys[0]);
    expect(left.peers()).toEqual([room.gameKeys[1]]);
    const received: [PeerId, number[]][] = [];
    right.onMessage((from, bytes) => {
      received.push([from, [...bytes]]);
      bytes[0] = 255;
    });
    right.onMessage((from, bytes) => received.push([from, [...bytes]]));
    const payload = new Uint8Array([5, 6]);
    left.send(required(room.gameKeys[1]), payload);
    payload[0] = 99;
    room.flush();
    expect(received).toEqual([
      [required(room.gameKeys[0]), [5, 6]],
      [required(room.gameKeys[0]), [5, 6]],
    ]);
    const sentToSpectator: Uint8Array[] = [];
    const frames: Uint8Array[] = [];
    room.net.transport(required(room.devices[1])).onMessage((from, bytes) => {
      if (from === room.devices[0] && bytes[0] === 0x43 && bytes[1] === 0x50)
        frames.push(bytes.slice());
    });
    room.net
      .transport(required(room.devices[2]))
      .onMessage((_from, bytes) => sentToSpectator.push(bytes));
    left.broadcast(new Uint8Array([7]));
    room.flush();
    expect(sentToSpectator).toEqual([]);
    const captured = required(frames.at(-1));
    room.net.transport(required(room.devices[2])).send(required(room.devices[1]), captured);
    const wrongChannel = captured.slice();
    wrongChannel[0] = required(wrongChannel[0]) ^ 1;
    room.net.transport(required(room.devices[0])).send(required(room.devices[1]), wrongChannel);
    const wrongVersion = captured.slice();
    wrongVersion[4] = required(wrongVersion[4]) ^ 1;
    room.net.transport(required(room.devices[0])).send(required(room.devices[1]), wrongVersion);
    room.flush();
    expect(received).toHaveLength(4);
    expect(() => left.send(required(room.gameKeys[2]), new Uint8Array([1]))).toThrow(
      /remote human/,
    );
    expect(() => left.send(required(room.devices[2]), new Uint8Array([1]))).toThrow(/remote human/);
    room.net
      .transport(required(room.devices[0]))
      .send(required(room.devices[1]), new Uint8Array([1]));
    room.flush();
    expect(received).toHaveLength(4);
    const otherBody = { ...room.validatedGenesis.genesis, createdAt: 2 };
    const other = room.open(required(room.devices[0]), {
      ...room.validatedGenesis,
      genesis: { ...otherBody, gameId: genesisId(otherBody) },
    });
    try {
      other.send(required(room.gameKeys[1]), new Uint8Array([8]));
      room.flush();
      expect(received).toHaveLength(4);
    } finally {
      other.dispose();
    }
  } finally {
    right.dispose();
    left.dispose();
    room.dispose();
  }
});

test('rejects forged binding and every mismatched certified genesis projection', () => {
  const room = fixture();
  try {
    const options = {
      deviceTransport: room.net.transport(required(room.devices[0])),
      agreement: room.agreement,
      bindings: room.bindings,
      validatedGenesis: room.validatedGenesis,
    };
    const first = required(room.bindings[0]);
    expect(
      createOnlineGameTransport({
        ...options,
        bindings: [{ ...first, sig: required(room.bindings[1]).sig }, ...room.bindings.slice(1)],
      }),
    ).toMatchObject({ ok: false, error: { code: 'online-binding-signature' } });
    for (const genesis of [
      { ...room.validatedGenesis.genesis, ceremonyNonce: 'other' },
      { ...room.validatedGenesis.genesis, seats: room.validatedGenesis.genesis.seats.toReversed() },
      { ...room.validatedGenesis.genesis, commitments: { masters: [] } },
      {
        ...room.validatedGenesis.genesis,
        config: {
          ...room.validatedGenesis.genesis.config,
          seats: room.validatedGenesis.genesis.config.seats.slice(1),
        },
      },
      { ...room.validatedGenesis.genesis, security: 'stub' as const },
    ])
      expect(
        createOnlineGameTransport({
          ...options,
          validatedGenesis: { ...room.validatedGenesis, genesis },
        }),
      ).toMatchObject({ ok: false, error: { code: 'online-transport-genesis' } });
    expect(
      createOnlineGameTransport({
        ...options,
        deviceTransport: room.net.transport(required(room.devices[2])),
      }),
    ).toMatchObject({ ok: false, error: { code: 'online-transport-self' } });
  } finally {
    room.dispose();
  }
});

test('certified activation retires the old route and restores only the new device and game key', async () => {
  const data = createRecoveryFixture({ masterBackedBeacon: true });
  const start = value(validateGenesisOnlineStart(data.genesis)).bindings;
  const oldGame = required(data.genesis.seats[0]).publicKey;
  const oldDevice = required(
    start.agreement.state.seats.find((seat) => seat.seat === 0 && seat.kind === 'human'),
  );
  if (oldDevice.kind !== 'human') throw new Error('Missing old device');
  const newDevice = identityFromSecret(new Uint8Array(32).fill(111));
  const newGame = identityFromSecret(new Uint8Array(32).fill(112));
  const devices = [
    ...start.agreement.state.seats
      .filter((seat): seat is Extract<typeof seat, { kind: 'human' }> => seat.kind === 'human')
      .map((seat) => seat.peer),
    newDevice.peerId,
  ];
  const net = createMemnet({ peers: devices });
  const history = {
    genesisEntry: data.genesisEntry,
    entries: data.deckEntries,
    engine: data.source.engine,
    policy: data.policy,
  };
  const validatedGenesis: ValidatedGenesis = {
    genesis: data.genesis,
    state: data.beforeSetup.log.state,
  };
  const open = (device: PeerId, entries = data.deckEntries) =>
    value(
      createOnlineGameTransport({
        deviceTransport: net.transport(device),
        validatedGenesis,
        agreement: start.agreement,
        bindings: start.bindings,
        certifiedHistory: { ...history, entries },
      }),
    );
  const old = open(oldDevice.peer);
  const survivorDevice = required(
    start.agreement.state.seats.find((seat) => seat.seat === 1 && seat.kind === 'human'),
  );
  if (survivorDevice.kind !== 'human') throw new Error('Missing survivor device');
  const survivor = open(survivorDevice.peer);
  try {
    const parent = data.ready;
    const controller = required(parent.log.authority?.controllers.find(({ seat }) => seat === 0));
    const statement = {
      protocol: 'seat-transfer-v1' as const,
      genesisDigest: genesisDigest(data.genesis),
      anchor: transferEntryRef(parent.log.head),
      validUntilSeq: parent.log.head.seq + 64,
      mode: 'live' as const,
      seat: 0 as const,
      currentController: {
        publicKey: controller.publicKey,
        kind: controller.kind,
        activatedAt: controller.activatedAt,
        hostSeat: controller.hostSeat,
      },
      recovery: null,
      nextEpoch: parent.membership.epoch + 1,
      destination: {
        devicePeer: newDevice.peerId,
        gamePeer: newGame.peerId,
        transferEncryptionKey: encodePoint(scalePoint(G, 147n)),
      },
      replacements: [
        {
          seat: 0 as const,
          oldPublicKey: oldGame,
          newPublicKey: newGame.peerId,
          newHostSeat: 0 as const,
        },
      ],
    };
    const authorization = {
      kind: 'transfer-authorize' as const,
      statement,
      destinationDeviceSig: signObject(TRANSFER_DEVICE_DOMAIN, statement, newDevice.secretKey),
      destinationGameSig: signObject(TRANSFER_GAME_KEY_DOMAIN, statement, newGame.secretKey),
      replacementKeySigs: [],
      ownerIntent: {
        signer: 'current-game' as const,
        sig: signObject(TRANSFER_OWNER_GAME_DOMAIN, statement, recoveryFixtureKey(data, 0)),
      },
    };
    const authorizedEntry = signRecoveryFixtureEntry(
      data,
      parent,
      { kind: 'membership', change: authorization },
      parent.log.head.stateHash,
    );
    const authorizedCertificate = certifyRecoveryFixtureEntry(
      data,
      parent,
      authorizedEntry,
      [0, 1, 2, 3],
    );
    const authorized = advanceRecoveryFixture(parent, authorizedCertificate);
    const throughAuthorization = [...data.deckEntries, authorizedCertificate];
    expect(old.self).toBe(oldGame);
    expect(survivor.advanceCertifiedHistory(throughAuthorization).ok).toBe(true);
    const activationStatement = {
      protocol: 'seat-transfer-activation-v1' as const,
      genesisDigest: statement.genesisDigest,
      authorization: transferEntryRef(authorizedEntry),
      parent: transferEntryRef(authorized.log.head),
      nextEpoch: statement.nextEpoch,
      destinationDevice: newDevice.peerId,
      destinationGame: newGame.peerId,
      replacements: statement.replacements,
      checkDigest: transferCheckDigest(authorized.log, transferEntryRef(authorizedEntry)),
    };
    const activationEntry = signRecoveryFixtureEntry(
      data,
      authorized,
      {
        kind: 'membership',
        change: {
          kind: 'transfer-activate',
          statement: activationStatement,
          destinationCheck: signObject(
            TRANSFER_DESTINATION_CHECK_DOMAIN,
            activationStatement,
            newGame.secretKey,
          ),
          replacementChecks: [],
        },
      },
      authorized.log.head.stateHash,
    );
    const activationCertificate = certifyRecoveryFixtureEntry(
      data,
      authorized,
      activationEntry,
      [0, 1, 2, 3],
    );
    expect(
      survivor.advanceCertifiedHistory([
        ...throughAuthorization,
        { ...activationCertificate, certificate: [] },
      ]),
    ).toMatchObject({ ok: false });
    expect(survivor.peers()).toContain(oldGame);
    const throughActivation = [...throughAuthorization, activationCertificate];
    const staleInbox: string[] = [];
    const retiredInbox: string[] = [];
    const rawHints: string[] = [];
    net.transport(oldDevice.peer).onMessage((from, frame) => {
      if (from !== survivorDevice.peer || frame[0] !== 0x43 || frame[1] !== 0x50) return;
      const message = decodeProtocolMessage(frame.slice(4 + 1 + 32));
      if (message.ok) rawHints.push(message.value.t);
    });
    survivor.onMessage((_from, bytes) => {
      const message = decodeProtocolMessage(bytes);
      if (message.ok) retiredInbox.push(message.value.t);
    });
    net.disconnect(oldDevice.peer, survivorDevice.peer);
    expect(survivor.advanceCertifiedHistory(throughActivation).ok).toBe(true);
    expect(survivor.peers()).not.toContain(oldGame);
    net.connect(oldDevice.peer, survivorDevice.peer);
    net.clock.advanceBy(0);
    expect(rawHints).toEqual(['COMMIT']);
    // The device receives the one-shot hint before the stale replica subscribes.
    old.onMessage((_from, bytes) => {
      const message = decodeProtocolMessage(bytes);
      if (message.ok) staleInbox.push(message.value.t);
    });
    expect(staleInbox).toEqual([]);
    expect(() => survivor.send(oldGame, value(encodeProtocolMessage({ t: 'PING', n: 1 })))).toThrow(
      /certified sync responses only/,
    );
    old.send(
      survivor.self,
      value(
        encodeProtocolMessage({
          t: 'SYNC_REQ',
          genesisDigest: statement.genesisDigest,
          fromSeq: authorizedEntry.seq,
        }),
      ),
    );
    old.send(survivor.self, value(encodeProtocolMessage({ t: 'PING', n: 2 })));
    net.clock.advanceBy(0);
    expect(retiredInbox).toEqual(['SYNC_REQ']);
    expect(rawHints.filter((kind) => kind === 'COMMIT')).toHaveLength(1);
    survivor.send(
      oldGame,
      value(
        encodeProtocolMessage({
          t: 'SYNC_RES',
          genesisDigest: statement.genesisDigest,
          entries: [authorizedCertificate, activationCertificate],
          more: false,
        }),
      ),
    );
    net.clock.advanceBy(0);
    expect(staleInbox).toContain('SYNC_RES');
    expect(survivor.peers()).not.toContain(oldGame);
    expect(old.advanceCertifiedHistory(throughActivation)).toMatchObject({
      ok: false,
      error: { code: 'online-transport-retired' },
    });
    expect(() => old.send(survivor.self, new Uint8Array([1]))).toThrow(/disposed/);
    const reopenedOld = open(oldDevice.peer, data.deckEntries);
    const restoredInbox: string[] = [];
    reopenedOld.onMessage((_from, bytes) => {
      const message = decodeProtocolMessage(bytes);
      if (message.ok) restoredInbox.push(message.value.t);
    });
    const reopenedSurvivor = open(survivorDevice.peer, throughActivation);
    const restoredRequests: string[] = [];
    reopenedSurvivor.onMessage((_from, bytes) => {
      const message = decodeProtocolMessage(bytes);
      if (message.ok) restoredRequests.push(message.value.t);
    });
    try {
      net.clock.advanceBy(0);
      expect(restoredInbox).toContain('COMMIT');
      reopenedOld.send(
        reopenedSurvivor.self,
        value(
          encodeProtocolMessage({
            t: 'SYNC_REQ',
            genesisDigest: statement.genesisDigest,
            fromSeq: authorizedEntry.seq,
          }),
        ),
      );
      net.clock.advanceBy(0);
      expect(restoredRequests).toEqual(['SYNC_REQ']);
      expect(reopenedSurvivor.peers()).not.toContain(oldGame);
    } finally {
      reopenedSurvivor.dispose();
      reopenedOld.dispose();
    }
    // Use the browser game factory with fresh destination safety, not genesis
    // credentials. The IndexedDB promotion transaction has separate storage tests.
    const journal = Object.assign(new MemoryProtocolJournal(), { close: async () => undefined });
    expect(
      await journal.initialize(
        data.genesisEntry,
        canonicalEncode(value(createConsensusState(data.beforeSetup, 0))),
      ),
    ).toBe(true);
    let restoredContext = data.beforeSetup;
    for (const certified of throughActivation) {
      restoredContext = advanceRecoveryFixture(restoredContext, certified);
      expect(
        // oxlint-disable-next-line no-await-in-loop -- Preserve contiguous certified history in this destination journal.
        await journal.commit(
          certified.entry.seq,
          0,
          certified,
          canonicalEncode(value(createConsensusState(restoredContext, 0))),
        ),
      ).toBe(true);
    }
    const input = {
      entry: data.genesisEntry,
      transcripts: data.deck.transcripts,
      agreement: start.agreement,
      bindings: start.bindings,
      material: [
        {
          seat: 0 as const,
          kind: 'human' as const,
          peerId: newGame.peerId,
          signingKey: newGame.secretKey,
          master: scalarToBytes(17n),
        },
      ],
      deviceTransport: net.transport(newDevice.peerId),
      store: new MemoryEscrowLifecycleStore(),
      clock: net.clock,
      engine: data.source.engine,
      journalMode: 'restore-only' as const,
    };
    const runtime = {
      acquireLease: async () => ({
        lockName: 'transfer-factory-test',
        run: async <T>(task: () => T | PromiseLike<T>): Promise<T> => task(),
        close: async () => undefined,
      }),
      createJournal: () => journal,
      auditRunner: () => {
        throw new Error('No terminal audit expected');
      },
    };
    const restored = await openOnlineGame(input, runtime);
    try {
      expect(restored.seat).toBe(0);
      expect(restored.session.getCommittedHead()).toMatchObject({ seq: activationEntry.seq });
      expect(restored.session.getPrivate(0)?.seat).toBe(0);
      expect(restored.session.getPrivate(1)).toBeNull();
      expect(restored.session.exportSave().entries).toEqual(throughActivation);
    } finally {
      await restored.close();
    }
    await expect(
      openOnlineGame(
        {
          ...input,
          material: [
            {
              ...required(input.material[0]),
              peerId: oldGame,
              signingKey: recoveryFixtureKey(data, 0),
            },
          ],
          deviceTransport: net.transport(oldDevice.peer),
        },
        runtime,
      ),
    ).rejects.toThrow(/Device has no|no longer controls/);
    input.material[0]?.master.fill(0);
    // Deliver the real session's queued startup announcement before probing one frame.
    net.clock.advanceBy(0);
    const replacement = open(newDevice.peerId, throughActivation);
    try {
      expect(replacement.self).toBe(newGame.peerId);
      expect(replacement.peers()).toContain(survivor.self);
      expect(survivor.peers()).toContain(newGame.peerId);
      expect(survivor.peers()).not.toContain(oldGame);
      const messages: PeerId[] = [];
      survivor.onMessage((from) => messages.push(from));
      replacement.send(survivor.self, new Uint8Array([2]));
      net.clock.advanceBy(0);
      expect(messages).toEqual([newGame.peerId]);
      expect(survivor.advanceCertifiedHistory(data.deckEntries)).toMatchObject({ ok: false });
    } finally {
      replacement.dispose();
    }
  } finally {
    survivor.dispose();
    old.dispose();
    net.dispose();
  }
}, 30_000);

test('rejects a separately signed device roster that claims the same public game keys', () => {
  const room = fixture();
  const sybilKeys = [41, 42].map((byte) => new Uint8Array(32).fill(byte));
  const sybils = sybilKeys.map((key) => identityFromSecret(key).peerId);
  const sybilNet = createMemnet({ peers: sybils });
  try {
    const state: LobbyFreezeAgreement['state'] = {
      ...room.agreement.state,
      hostPeer: required(sybils[0]),
      seats: room.agreement.state.seats.map((seat) => {
        if (seat.kind === 'human') return { ...seat, peer: required(sybils[seat.seat]) };
        if (seat.kind === 'bot')
          return { ...seat, botHost: required(sybils[seat.seat === 3 ? 1 : 0]) };
        return seat;
      }),
    };
    const stateHash = toHex(hashValue(state));
    const agreement: LobbyFreezeAgreement = {
      state,
      acks: [0, 1].map((seat) => {
        const body = {
          lobbyId: state.lobbyId,
          hostEpoch: state.hostEpoch,
          ceremonyNonce: required(state.ceremonyNonce),
          stateHash,
          peer: required(sybils[seat]),
        };
        return {
          body,
          sig: signObject('lobby-freeze-ack', body, required(sybilKeys[seat])),
        };
      }),
    };
    const bindings = room.bindings.map((binding) =>
      value(
        signGameSeatBinding({
          agreement,
          seat: binding.body.seat,
          deviceSecretKey: required(
            sybilKeys[binding.body.seat === 1 || binding.body.seat === 3 ? 1 : 0],
          ),
          gamePeer: binding.body.gamePeer,
          masterPub: binding.body.masterPub,
          encryptionKey: binding.body.encryptionKey,
        }),
      ),
    );
    expect(value(verifyGameSeatBindings(agreement, bindings)).genesisSeats).toEqual(
      room.validatedGenesis.genesis.seats,
    );
    expect(
      createOnlineGameTransport({
        deviceTransport: sybilNet.transport(required(sybils[0])),
        validatedGenesis: room.validatedGenesis,
        agreement,
        bindings,
      }),
    ).toMatchObject({ ok: false, error: { code: 'online-transport-genesis' } });
  } finally {
    sybilNet.dispose();
    room.dispose();
  }
});

test('one throwing gameplay listener cannot starve peers or other device subscribers', () => {
  const room = fixture();
  const left = room.open(required(room.devices[0]));
  const right = room.open(required(room.devices[1]));
  try {
    let delivered = 0;
    let raw = 0;
    right.onMessage(() => {
      throw new Error('broken view');
    });
    right.onMessage(() => delivered++);
    room.net.transport(required(room.devices[1])).onMessage(() => raw++);
    left.send(required(room.gameKeys[1]), new Uint8Array([9]));
    room.flush();
    expect(delivered).toBe(1);
    expect(raw).toBe(1);

    let peerChanges = 0;
    right.onPeerChange(() => {
      throw new Error('broken view');
    });
    right.onPeerChange(() => peerChanges++);
    room.net.disconnect(required(room.devices[0]), required(room.devices[1]));
    room.net.connect(required(room.devices[0]), required(room.devices[1]));
    expect(peerChanges).toBe(2);
  } finally {
    right.dispose();
    left.dispose();
    room.dispose();
  }
});

test('enforces message bounds, maps reconnects, and disposal keeps device transport alive', () => {
  const room = fixture();
  const left = room.open(required(room.devices[0]));
  const right = room.open(required(room.devices[1]));
  try {
    expect(MAX_PROTOCOL_MESSAGE_BYTES).toBeLessThan(MAX_WEBRTC_MESSAGE_BYTES);
    expect(() =>
      left.send(required(room.gameKeys[1]), new Uint8Array(MAX_PROTOCOL_MESSAGE_BYTES + 1)),
    ).toThrow(/transport limit/);
    const changes: string[] = [];
    left.onPeerChange((peer, online) => changes.push(`${peer}:${online}`));
    room.net.disconnect(required(room.devices[0]), required(room.devices[1]));
    expect(left.peers()).toEqual([]);
    room.net.connect(required(room.devices[0]), required(room.devices[1]));
    expect(left.peers()).toEqual([room.gameKeys[1]]);
    expect(changes).toEqual([`${room.gameKeys[1]}:false`, `${room.gameKeys[1]}:true`]);
    let gameplay = 0;
    let raw = 0;
    left.onMessage(() => gameplay++);
    room.net.transport(required(room.devices[0])).onMessage((_from, bytes) => {
      if (bytes[0] === 0x43 && bytes[1] === 0x50) raw++;
    });
    left.dispose();
    right.send(required(room.gameKeys[0]), new Uint8Array([3]));
    room.flush();
    expect(gameplay).toBe(0);
    expect(raw).toBe(1);
    expect(() => left.send(required(room.gameKeys[1]), new Uint8Array([1]))).toThrow(/disposed/);
  } finally {
    right.dispose();
    left.dispose();
    room.dispose();
  }
});

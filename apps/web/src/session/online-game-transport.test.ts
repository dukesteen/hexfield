import { hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { G, encodePoint, identityFromSecret, scalePoint, signObject } from '@cp2p/crypto';
import { BASE_VERSION, createBaseEngine, ENGINE_VERSION } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import { MAX_MESSAGE_BYTES as MAX_WEBRTC_MESSAGE_BYTES } from '@cp2p/p2p';
import {
  genesisId,
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
import { createMemnet } from '@cp2p/protocol/testing';
import { expect, test } from 'vitest';
import { createOnlineGameTransport } from './online-game-transport.js';

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

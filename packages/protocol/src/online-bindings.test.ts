import { toBase64Url } from '@cp2p/codec';
import { G, encodePoint, identityFromSecret, scalePoint, signObject } from '@cp2p/crypto';
import { BASE_VERSION } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { LobbyController } from './lobby.js';
import {
  ONLINE_SEAT_BINDING_DOMAIN,
  signGameSeatBinding,
  verifyGameSeatBindings,
} from './online-bindings.js';
import type { SignedGameSeatBinding } from './online-bindings.js';
import { createMemnet } from './testing/memnet.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing online binding fixture value');
  return item;
}

function material(seat: Seat) {
  return {
    gamePeer: identityFromSecret(new Uint8Array(32).fill(11 + seat)).peerId,
    masterPub: encodePoint(scalePoint(G, BigInt(17 + seat))),
    encryptionKey: encodePoint(scalePoint(G, BigInt(37 + seat))),
  };
}

function fixture() {
  const deviceKeys = [1, 2, 3].map((byte) => new Uint8Array(32).fill(byte));
  const devicePeers = deviceKeys.map((key) => identityFromSecret(key).peerId);
  const net = createMemnet({ peers: devicePeers });
  const host = value(
    LobbyController.createHost({
      lobbyId: 'bindings_room',
      name: 'Online game',
      hostName: 'Avery',
      config: {
        modules: [{ id: 'base', version: BASE_VERSION }],
        seats: [0, 1, 2, 3],
        options: { base: { mapLayout: 'random', vpTarget: 3 } },
      },
      transport: net.transport(required(devicePeers[0])),
      clock: net.clock,
      secretKey: required(deviceKeys[0]),
    }),
  );
  const guest = value(
    LobbyController.join({
      lobbyId: 'bindings_room',
      hostPeer: required(devicePeers[0]),
      transport: net.transport(required(devicePeers[1])),
      clock: net.clock,
      secretKey: required(deviceKeys[1]),
    }),
  );
  const spectator = value(
    LobbyController.join({
      lobbyId: 'bindings_room',
      hostPeer: required(devicePeers[0]),
      transport: net.transport(required(devicePeers[2])),
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
  value(host.setBot(2, 'medium'));
  flush();
  value(host.setBot(3, 'easy', required(devicePeers[1])));
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
  const sign = (seat: Seat, changes: Partial<ReturnType<typeof material>> = {}) =>
    value(
      signGameSeatBinding({
        agreement,
        seat,
        deviceSecretKey: required(deviceKeys[seat === 3 ? 1 : seat === 2 ? 0 : seat]),
        ...material(seat),
        ...changes,
      }),
    );
  const bindings = ([0, 1, 2, 3] as const).map((seat) => sign(seat));
  return {
    agreement,
    bindings,
    deviceKeys,
    devicePeers,
    material,
    sign,
    dispose() {
      spectator.dispose();
      guest.dispose();
      host.dispose();
      net.dispose();
    },
  };
}

test('binds every frozen device seat to independent game keys and maps bot hosts to game keys', () => {
  const room = fixture();
  try {
    const verified = value(verifyGameSeatBindings(room.agreement, room.bindings));
    expect(verified.bindings.map((binding) => binding.body.seat)).toEqual([0, 1, 2, 3]);
    expect(verified.freezeHash).toBe(verified.bindings[0]?.body.freezeHash);
    expect(verified.masters).toEqual(
      room.bindings.map(({ body }) => ({ seat: body.seat, masterPub: body.masterPub })),
    );
    expect(verified.genesisSeats).toMatchObject([
      { seat: 0, kind: 'human', publicKey: room.material(0).gamePeer, name: 'Avery' },
      { seat: 1, kind: 'human', publicKey: room.material(1).gamePeer },
      { seat: 2, kind: 'bot', botHost: room.material(0).gamePeer },
      { seat: 3, kind: 'bot', botHost: room.material(1).gamePeer },
    ]);
    expect(verified.genesisSeats.map((seat) => seat.encryptionKey)).toEqual(
      room.bindings.map((binding) => binding.body.encryptionKey),
    );
    const originalName = verified.agreement.state.name;
    const originalGamePeer = verified.bindings[0]?.body.gamePeer;
    Reflect.set(room.agreement.state, 'name', 'Changed after verification');
    Reflect.set(required(room.bindings[0]).body, 'gamePeer', room.material(3).gamePeer);
    expect(verified.agreement.state.name).toBe(originalName);
    expect(verified.bindings[0]?.body.gamePeer).toBe(originalGamePeer);
  } finally {
    room.dispose();
  }
});

test('rejects a wrong device, stale freeze, wrong version, and forged signature', () => {
  const room = fixture();
  try {
    expect(
      signGameSeatBinding({
        agreement: room.agreement,
        seat: 3,
        deviceSecretKey: required(room.deviceKeys[0]),
        ...room.material(3),
      }),
    ).toMatchObject({ ok: false, error: { code: 'online-binding-owner' } });
    const first = required(room.bindings[0]);
    const resign = (body: SignedGameSeatBinding['body']) => ({
      body,
      sig: signObject(ONLINE_SEAT_BINDING_DOMAIN, body, required(room.deviceKeys[0])),
    });
    for (const body of [
      { ...first.body, freezeHash: '0'.repeat(64) },
      { ...first.body, ceremonyNonce: toBase64Url(new Uint8Array(32).fill(92)) },
      { ...first.body, protocolVersion: first.body.protocolVersion + 1 },
      { ...first.body, engineVersion: 'other-engine' },
    ]) {
      expect(
        verifyGameSeatBindings(room.agreement, [resign(body), ...room.bindings.slice(1)]).ok,
      ).toBe(false);
    }
    expect(
      verifyGameSeatBindings(room.agreement, [
        { ...first, sig: signObject('wrong-domain', first.body, required(room.deviceKeys[0])) },
        ...room.bindings.slice(1),
      ]),
    ).toMatchObject({ ok: false, error: { code: 'online-binding-signature' } });
  } finally {
    room.dispose();
  }
});

test('requires exact ordered roster, unique fresh keys, and nonidentity points', () => {
  const room = fixture();
  try {
    expect(verifyGameSeatBindings(room.agreement, room.bindings.slice(1)).ok).toBe(false);
    expect(
      verifyGameSeatBindings(room.agreement, [
        room.bindings[1],
        room.bindings[0],
        ...room.bindings.slice(2),
      ]),
    ).toMatchObject({ ok: false, error: { code: 'online-binding-roster' } });
    expect(
      verifyGameSeatBindings(room.agreement, [
        room.bindings[0],
        room.sign(1, { gamePeer: room.material(0).gamePeer }),
        ...room.bindings.slice(2),
      ]),
    ).toMatchObject({ ok: false, error: { code: 'online-binding-duplicate' } });
    expect(
      verifyGameSeatBindings(room.agreement, [
        room.bindings[0],
        room.sign(1, { masterPub: room.material(0).masterPub }),
        ...room.bindings.slice(2),
      ]),
    ).toMatchObject({ ok: false, error: { code: 'online-binding-duplicate' } });
    expect(
      verifyGameSeatBindings(room.agreement, [
        room.bindings[0],
        room.sign(1, { encryptionKey: room.material(0).encryptionKey }),
        ...room.bindings.slice(2),
      ]),
    ).toMatchObject({ ok: false, error: { code: 'online-binding-duplicate' } });
    expect(
      signGameSeatBinding({
        agreement: room.agreement,
        seat: 0,
        deviceSecretKey: required(room.deviceKeys[0]),
        ...room.material(0),
        gamePeer: required(room.devicePeers[2]),
      }),
    ).toMatchObject({ ok: false, error: { code: 'online-binding-game-key' } });
    const identity = encodePoint(scalePoint(G, 0n));
    expect(
      signGameSeatBinding({
        agreement: room.agreement,
        seat: 0,
        deviceSecretKey: required(room.deviceKeys[0]),
        ...room.material(0),
        masterPub: identity,
      }),
    ).toMatchObject({ ok: false, error: { code: 'online-binding-point' } });
  } finally {
    room.dispose();
  }
});

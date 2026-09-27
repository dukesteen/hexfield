import { canonicalEncode, toBase64Url } from '@cp2p/codec';
import { identityFromSecret, signObject } from '@cp2p/crypto';
import { BASE_VERSION, ENGINE_VERSION } from '@cp2p/engine';
import type { GameConfig, Result } from '@cp2p/engine';
import { afterEach, describe, expect, test } from 'vitest';
import { LobbyController, verifyLobbyFreezeAgreement } from './lobby.js';
import { createMemnet } from './testing/memnet.js';
import type { Transport } from './transport.js';
import { PROTOCOL_VERSION } from './types.js';

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing lobby fixture value');
  return item;
}

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function setup() {
  const keys = [1, 2, 3].map((number) => new Uint8Array(32).fill(number));
  const peers = keys.map((key) => identityFromSecret(key).peerId);
  const net = createMemnet({ peers });
  const config: GameConfig = {
    modules: [{ id: 'base', version: BASE_VERSION }],
    seats: [0, 1, 2],
    options: { base: { mapLayout: 'random', vpTarget: 3 } },
  };
  const host = value(
    LobbyController.createHost({
      lobbyId: 'room_one',
      name: 'Friday game',
      hostName: 'Avery',
      config,
      transport: net.transport(required(peers[0])),
      clock: net.clock,
      secretKey: required(keys[0]),
    }),
  );
  const second = value(
    LobbyController.join({
      lobbyId: 'room_one',
      hostPeer: required(peers[0]),
      transport: net.transport(required(peers[1])),
      clock: net.clock,
      secretKey: required(keys[1]),
    }),
  );
  const third = value(
    LobbyController.join({
      lobbyId: 'room_one',
      hostPeer: required(peers[0]),
      transport: net.transport(required(peers[2])),
      clock: net.clock,
      secretKey: required(keys[2]),
    }),
  );
  const flush = () => net.clock.advanceBy(0);
  const dispose = () => {
    host.dispose();
    second.dispose();
    third.dispose();
    net.dispose();
  };
  return { keys, peers, net, config, host, second, third, flush, dispose };
}

const active: { dispose(): void }[] = [];
afterEach(() => {
  while (active.length) active.pop()?.dispose();
});

describe('signed lobby controller', () => {
  test('retries an initial pre-auth HELLO and a dropped authenticated HELLO', () => {
    const keys = [new Uint8Array(32).fill(31), new Uint8Array(32).fill(32)];
    const peers = keys.map((key) => identityFromSecret(key).peerId);
    const hostPeer = required(peers[0]);
    const guestPeer = required(peers[1]);
    const net = createMemnet({ peers });
    let authenticated = false;
    let dropNextHello = true;
    const actual = net.transport(guestPeer);
    const delayed: Transport = {
      self: actual.self,
      peers: () => (authenticated ? actual.peers() : []),
      send(to, bytes) {
        if (!authenticated) throw new Error('WebRTC peer is not authenticated');
        if (dropNextHello) {
          dropNextHello = false;
          return;
        }
        actual.send(to, bytes);
      },
      broadcast: (bytes) => actual.broadcast(bytes),
      onMessage: (listener) => actual.onMessage(listener),
      onPeerChange: (listener) => actual.onPeerChange(listener),
      disconnect: (peer) => actual.disconnect(peer),
    };
    const config: GameConfig = {
      modules: [{ id: 'base', version: BASE_VERSION }],
      seats: [0, 1],
      options: { base: { mapLayout: 'random', vpTarget: 3 } },
    };
    const host = value(
      LobbyController.createHost({
        lobbyId: 'delayed_room',
        name: 'Room',
        hostName: 'Host',
        config,
        transport: net.transport(hostPeer),
        clock: net.clock,
        secretKey: required(keys[0]),
      }),
    );
    const guest = value(
      LobbyController.join({
        lobbyId: 'delayed_room',
        hostPeer,
        transport: delayed,
        clock: net.clock,
        secretKey: required(keys[1]),
      }),
    );
    active.push({
      dispose() {
        guest.dispose();
        host.dispose();
        net.dispose();
      },
    });
    net.clock.advanceBy(0);
    expect(guest.state()).toBeNull();
    net.disconnect(hostPeer, guestPeer);
    authenticated = true;
    net.connect(hostPeer, guestPeer);
    net.clock.advanceBy(0);
    expect(guest.state()).toBeNull();
    net.clock.advanceBy(999);
    expect(guest.state()).toBeNull();
    net.clock.advanceBy(1);
    expect(guest.state()?.hostPeer).toBe(hostPeer);
    expect(guest.state()?.version).toBe(0);
    net.disconnect(hostPeer, guestPeer);
    value(host.configure({ ...config, options: { base: { vpTarget: 4 } } }));
    net.clock.advanceBy(0);
    expect(guest.state()?.version).toBe(0);
    net.clock.advanceBy(500);
    net.connect(hostPeer, guestPeer);
    net.clock.advanceBy(0);
    expect(guest.state()?.version).toBe(1);
  });

  test('three peers join, configure, ready, and agree on one exact freeze before ceremony', () => {
    const room = setup();
    active.push(room);
    room.flush();
    expect(room.second.state()?.hostPeer).toBe(room.peers[0]);
    value(room.second.request({ kind: 'takeSeat', seat: 1 }));
    room.flush();
    value(room.third.request({ kind: 'takeSeat', seat: 2 }));
    room.flush();
    value(room.second.request({ kind: 'setName', name: 'Blake' }));
    room.flush();
    value(room.third.request({ kind: 'setColour', colour: 'yellow' }));
    room.flush();
    value(room.host.request({ kind: 'setReady', ready: true }));
    room.flush();
    value(room.second.request({ kind: 'setReady', ready: true }));
    room.flush();
    value(room.third.request({ kind: 'setReady', ready: true }));
    room.flush();
    expect(room.host.state()?.seats.every((seat) => seat.ready)).toBe(true);
    expect(room.host.state()?.seedMode).toEqual({ kind: 'joint' });
    expect(room.host.state()?.takeover).toEqual({ mode: 'vote', afterSeconds: 120 });
    const fixedSeed = { kind: 'fixed' as const, seed: toBase64Url(new Uint8Array(32).fill(4)) };
    const takeover = { mode: 'auto' as const, afterSeconds: 30 };
    value(
      room.host.configure(
        { ...room.config, options: { base: { vpTarget: 4 } } },
        fixedSeed,
        takeover,
      ),
    );
    room.flush();
    expect(room.second.state()?.seats.every((seat) => !seat.ready)).toBe(true);
    expect(room.second.state()?.seedMode).toEqual(fixedSeed);
    expect(room.second.state()?.takeover).toEqual(takeover);
    expect(room.third.configure(room.config, { kind: 'joint' }).ok).toBe(false);
    expect(room.host.configure(room.config, { kind: 'fixed', seed: 'not-a-seed' }).ok).toBe(false);
    expect(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise malformed input from an untyped caller.
      room.host.configure(room.config, undefined, { mode: 'auto', afterSeconds: 'never' } as never)
        .ok,
    ).toBe(false);
    expect(room.host.configure(room.config, undefined, { mode: 'vote', afterSeconds: 14 }).ok).toBe(
      false,
    );
    expect(room.host.start(toBase64Url(new Uint8Array(32).fill(7))).ok).toBe(false);
    value(room.host.request({ kind: 'setReady', ready: true }));
    room.flush();
    value(room.second.request({ kind: 'setReady', ready: true }));
    room.flush();
    value(room.third.request({ kind: 'setReady', ready: true }));
    room.flush();
    const nonce = toBase64Url(new Uint8Array(32).fill(8));
    value(room.host.start(nonce));
    room.flush();
    expect(room.host.freezeAgreement()).toBeNull();
    value(room.host.ackFreeze());
    value(room.second.ackFreeze());
    value(room.third.ackFreeze());
    room.flush();
    const agreements = [room.host, room.second, room.third].map((peer) => peer.freezeAgreement());
    expect(agreements.every(Boolean)).toBe(true);
    expect(agreements.map((agreement) => agreement?.state.ceremonyNonce)).toEqual([
      nonce,
      nonce,
      nonce,
    ]);
    expect(agreements[0]?.acks).toHaveLength(3);
    const agreement = required(agreements[0]);
    const verified = value(
      verifyLobbyFreezeAgreement({
        state: agreement.state,
        acks: agreement.acks.toReversed(),
      }),
    );
    expect(verified.acks.map((ack) => ack.body.peer)).toEqual(
      agreement.state.seats.filter((seat) => seat.kind === 'human').map((seat) => seat.peer),
    );
    expect(verified).not.toBe(agreement);
    expect(verified.state).not.toBe(agreement.state);
    expect(verified.acks[0]).not.toBe(agreement.acks[0]);
    const changedState = { ...agreement.state, name: 'Different room' };
    expect(verifyLobbyFreezeAgreement({ ...agreement, state: changedState }).ok).toBe(false);
    expect(
      verifyLobbyFreezeAgreement({
        ...agreement,
        state: { ...agreement.state, seedMode: { kind: 'joint' } },
      }).ok,
    ).toBe(false);
    expect(
      verifyLobbyFreezeAgreement({
        ...agreement,
        state: { ...agreement.state, takeover: { mode: 'vote', afterSeconds: 30 } },
      }).ok,
    ).toBe(false);
    expect(
      verifyLobbyFreezeAgreement({ ...agreement, state: { ...agreement.state, status: 'started' } })
        .ok,
    ).toBe(false);
    expect(verifyLobbyFreezeAgreement({ ...agreement, acks: agreement.acks.slice(1) }).ok).toBe(
      false,
    );
    expect(
      verifyLobbyFreezeAgreement({
        ...agreement,
        acks: [agreement.acks[0], agreement.acks[0], agreement.acks[1]],
      }).ok,
    ).toBe(false);
    const firstAck = required(agreement.acks[0]);
    for (const body of [
      { ...firstAck.body, lobbyId: 'another_room' },
      { ...firstAck.body, hostEpoch: firstAck.body.hostEpoch + 1 },
      { ...firstAck.body, ceremonyNonce: toBase64Url(new Uint8Array(32).fill(9)) },
      { ...firstAck.body, stateHash: '0'.repeat(64) },
      { ...firstAck.body, peer: required(room.peers[2]) },
    ]) {
      expect(
        verifyLobbyFreezeAgreement({
          ...agreement,
          acks: [{ ...firstAck, body }, ...agreement.acks.slice(1)],
        }).ok,
      ).toBe(false);
    }
    expect(
      verifyLobbyFreezeAgreement({
        ...agreement,
        acks: [{ ...firstAck, sig: required(agreement.acks[1]).sig }, ...agreement.acks.slice(1)],
      }).ok,
    ).toBe(false);
    expect(room.host.start(nonce).ok).toBe(false);
  });

  test('rejects unauthorized edits, spoofed requests, stale replay, and reports version mismatch', () => {
    const room = setup();
    active.push(room);
    room.flush();
    expect(room.second.configure(room.config)).toMatchObject({
      ok: false,
      error: { code: 'lobby-host' },
    });
    expect(room.second.kick(required(room.peers[2]))).toMatchObject({
      ok: false,
      error: { code: 'lobby-host' },
    });
    expect(room.second.start(toBase64Url(new Uint8Array(32).fill(9)))).toMatchObject({
      ok: false,
      error: { code: 'lobby-host' },
    });
    const baseVersion = required(room.host.state()).version;
    const unauthorizedEdit = {
      lobbyId: 'room_one',
      hostEpoch: 0,
      baseVersion,
      nonce: 1,
      peer: required(room.peers[1]),
      config: room.config,
      seedMode: required(room.host.state()).seedMode,
      takeover: required(room.host.state()).takeover,
    };
    room.net.transport(required(room.peers[1])).send(
      required(room.peers[0]),
      canonicalEncode({
        t: 'LOBBY_CONFIG',
        edit: {
          body: unauthorizedEdit,
          sig: signObject('lobby-config', unauthorizedEdit, required(room.keys[1])),
        },
      }),
    );
    room.flush();
    expect(room.host.getDiagnostic()).toEqual({ kind: 'invalid-message', code: 'lobby-host-edit' });
    expect(room.host.state()?.version).toBe(baseVersion);
    const body = {
      lobbyId: 'room_one',
      hostEpoch: 0,
      baseVersion,
      nonce: 1,
      peer: room.peers[0],
      action: { kind: 'takeSeat', seat: 1 },
    };
    const spoof = canonicalEncode({
      t: 'LOBBY_REQ',
      request: { body, sig: signObject('lobby-request', body, required(room.keys[1])) },
    });
    room.net.transport(required(room.peers[1])).send(required(room.peers[0]), spoof);
    room.flush();
    expect(room.host.state()?.seats[1]?.kind).toBe('open');
    const realBody = { ...body, peer: room.peers[1] };
    const packet = canonicalEncode({
      t: 'LOBBY_REQ',
      request: {
        body: realBody,
        sig: signObject('lobby-request', realBody, required(room.keys[1])),
      },
    });
    room.net.transport(required(room.peers[1])).send(required(room.peers[0]), packet);
    room.flush();
    expect(room.host.state()?.seats[1]?.kind).toBe('human');
    const version = room.host.state()?.version;
    room.net.transport(required(room.peers[1])).send(required(room.peers[0]), packet);
    room.flush();
    expect(room.host.state()?.version).toBe(version);
    const state = required(room.host.state());
    const incompatible = {
      protocolVersion: PROTOCOL_VERSION + 1,
      engineVersion: ENGINE_VERSION,
      state,
    };
    room.net.transport(required(room.peers[0])).send(
      required(room.peers[1]),
      canonicalEncode({
        t: 'LOBBY_STATE',
        snapshot: {
          body: incompatible,
          sig: signObject('lobby-state', incompatible, required(room.keys[0])),
        },
      }),
    );
    room.flush();
    expect(room.second.getDiagnostic()).toEqual({
      kind: 'protocol-version',
      hostVersion: PROTOCOL_VERSION + 1,
    });
    const oldState = { ...state } as Record<string, unknown>;
    delete oldState.takeover;
    const oldBody = { protocolVersion: 2, engineVersion: ENGINE_VERSION, state: oldState };
    room.net.transport(required(room.peers[0])).send(
      required(room.peers[1]),
      canonicalEncode({
        t: 'LOBBY_STATE',
        snapshot: {
          body: oldBody,
          sig: signObject('lobby-state', oldBody, required(room.keys[0])),
        },
      }),
    );
    room.flush();
    expect(room.second.getDiagnostic()).toEqual({ kind: 'protocol-version', hostVersion: 2 });
  });

  test('requires every bot host to occupy a human seat before signing a freeze', () => {
    const room = setup();
    active.push(room);
    room.flush();
    value(room.second.request({ kind: 'spectate' }));
    room.flush();
    expect(room.host.setBot(2, 'easy', required(room.peers[1]))).toMatchObject({
      ok: false,
      error: { code: 'lobby-bot' },
    });
    const current = required(room.host.state());
    const forged = {
      ...current,
      version: current.version + 1,
      seats: current.seats.map((seat) =>
        seat.seat === 2
          ? {
              seat: 2,
              kind: 'bot',
              name: 'Bot',
              colour: seat.colour,
              ready: false,
              botLevel: 'easy',
              botHost: required(room.peers[1]),
            }
          : seat,
      ),
    };
    const body = {
      protocolVersion: PROTOCOL_VERSION,
      engineVersion: ENGINE_VERSION,
      state: forged,
    };
    room.net.transport(required(room.peers[0])).send(
      required(room.peers[1]),
      canonicalEncode({
        t: 'LOBBY_STATE',
        snapshot: { body, sig: signObject('lobby-state', body, required(room.keys[0])) },
      }),
    );
    room.flush();
    expect(room.second.state()?.version).toBe(current.version);
  });

  test('host departure resets readiness; a partition cannot complete stale freeze', () => {
    const room = setup();
    active.push(room);
    room.flush();
    value(room.second.request({ kind: 'takeSeat', seat: 1 }));
    room.flush();
    value(room.third.request({ kind: 'takeSeat', seat: 2 }));
    room.flush();
    value(room.host.request({ kind: 'setReady', ready: true }));
    room.flush();
    value(room.second.request({ kind: 'setReady', ready: true }));
    room.flush();
    value(room.third.request({ kind: 'setReady', ready: true }));
    room.flush();
    const nonce = toBase64Url(new Uint8Array(32).fill(10));
    value(room.host.start(nonce));
    room.flush();
    value(room.host.ackFreeze());
    room.net.partition([
      [required(room.peers[0])],
      [required(room.peers[1]), required(room.peers[2])],
    ]);
    room.flush();
    const electedIndex = required(room.peers[1]) < required(room.peers[2]) ? 1 : 2;
    const electedPeer = required(room.peers[electedIndex]);
    const elected = electedIndex === 1 ? room.second : room.third;
    expect(room.host.freezeAgreement()).toBeNull();
    expect(room.second.ackFreeze().ok).toBe(false);
    expect(room.third.state()?.hostPeer).toBe(electedPeer);
    expect(elected.state()?.status).toBe('open');
    expect(elected.state()?.seats.every((seat) => !seat.ready)).toBe(true);
    room.net.crash(required(room.peers[0]));
    room.flush();
    value(elected.kick(required(room.peers[0])));
    room.flush();
    value(elected.setBot(0, 'easy', electedPeer));
    room.flush();
    value(room.second.request({ kind: 'setReady', ready: true }));
    room.flush();
    value(room.third.request({ kind: 'setReady', ready: true }));
    room.flush();
    value(elected.start(toBase64Url(new Uint8Array(32).fill(11))));
    room.flush();
    value(elected.ackFreeze());
    value(electedIndex === 1 ? room.third.ackFreeze() : room.second.ackFreeze());
    room.flush();
    expect(room.second.freezeAgreement()?.acks).toHaveLength(2);
    expect(room.third.freezeAgreement()?.acks).toHaveLength(2);
  });
});

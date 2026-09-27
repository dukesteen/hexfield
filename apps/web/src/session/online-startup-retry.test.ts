import { canonicalDecode } from '@cp2p/codec';
import { BASE_VERSION, createBaseEngine } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { LobbyController, MemoryProtocolJournal, OnlineCeremony } from '@cp2p/protocol';
import type { OnlineCeremonyProgress } from '@cp2p/protocol';
import { createMemnet, MemoryEscrowLifecycleStore } from '@cp2p/protocol/testing';
import type { GameWriterLease } from '@cp2p/storage';
import { expect, test, vi } from 'vitest';
import { loadOrCreateOnlineIdentity } from './online-credentials.js';
import { createOnlineLobbyTransport } from './online-lobby-transport.js';
import { OnlineStartup } from './online-startup.js';
import type { OnlineGameRuntime } from './online-game.js';

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing retry fixture value');
  return value;
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function testLease(onClose: () => void = () => undefined): GameWriterLease {
  return {
    lockName: 'retry-test-game',
    run: async <T>(task: () => T | PromiseLike<T>): Promise<T> => task(),
    close: async () => onClose(),
  };
}

function captureCeremonyProgress() {
  const listeners = new Map<OnlineCeremony, (progress: OnlineCeremonyProgress) => void>();
  // oxlint-disable-next-line typescript/unbound-method -- The mock calls it with the captured coordinator as `this`.
  const original = OnlineCeremony.prototype.onChange;
  const spy = vi.spyOn(OnlineCeremony.prototype, 'onChange').mockImplementation(function (
    this: OnlineCeremony,
    listener,
  ) {
    listeners.set(this, listener);
    return original.call(this, listener);
  });
  return {
    dispute(startup: OnlineStartup) {
      const value: unknown = Reflect.get(startup, 'ceremony');
      if (!(value instanceof OnlineCeremony)) throw new Error('Startup has no owned ceremony');
      // The protocol clears its result before emitting the verified dispute progress.
      vi.spyOn(value, 'result').mockReturnValue(null);
      required(listeners.get(value))({
        phase: 'waiting',
        awaitingSeats: [],
        error: 'online-ceremony-disputed',
        locallyConsented: true,
      });
    },
    restore: () => spy.mockRestore(),
  };
}

async function setupTwoHumans(
  acquireHostLease: () => Promise<GameWriterLease | null>,
  freezeHost: () => void = () => undefined,
) {
  const stores = [new MemoryEscrowLifecycleStore(), new MemoryEscrowLifecycleStore()];
  const identities = await Promise.all(
    stores.map((store, index) =>
      loadOrCreateOnlineIdentity(store, (length) => new Uint8Array(length).fill(index + 1)),
    ),
  );
  const hostIdentity = required(identities[0]);
  const network = createMemnet({ peers: identities.map((identity) => identity.peerId) });
  const invite = {
    roomId: 'startretry',
    hostPeer: hostIdentity.peerId,
    serverUrl: 'ws://localhost:3009',
  };
  const lobbies = identities.map((identity, index) => {
    const options = {
      lobbyId: invite.roomId,
      transport: createOnlineLobbyTransport(network.transport(identity.peerId)),
      clock: network.clock,
      secretKey: identity.secretKey,
    };
    return unwrap(
      index === 0
        ? LobbyController.createHost({
            ...options,
            name: 'Retry test',
            hostName: 'Avery',
            config: {
              modules: [{ id: 'base', version: BASE_VERSION }],
              seats: [0, 1, 2, 3],
              options: { base: { mapLayout: 'random', vpTarget: 3 } },
            },
          })
        : LobbyController.join({ ...options, hostPeer: hostIdentity.peerId }),
    );
  });
  const journals = identities.map(() => new MemoryProtocolJournal());
  const journalCreations = [0, 0];
  let hostGameFrames = 0;
  const starts = identities.map((identity, index) => {
    const journal = required(journals[index]);
    const device = network.transport(identity.peerId);
    const runtime: OnlineGameRuntime = {
      acquireLease: index === 0 ? acquireHostLease : async () => testLease(),
      createJournal: (_id, binding) => {
        journalCreations[index] = required(journalCreations[index]) + 1;
        expect(canonicalDecode(binding.bytes)).toMatchObject({
          protocol: 'online-game-keys-v1',
        });
        return Object.assign(journal, { close: async () => undefined });
      },
      auditRunner: () => {
        throw new Error('Audit should not run before a result');
      },
    };
    return new OnlineStartup({
      invite,
      identity,
      lobby: required(lobbies[index]),
      transport:
        index === 0
          ? {
              self: device.self,
              peers: () => device.peers(),
              send(to, bytes) {
                if (
                  bytes[0] === 0x43 &&
                  bytes[1] === 0x50 &&
                  bytes[2] === 0x32 &&
                  bytes[3] === 0x47
                )
                  hostGameFrames += 1;
                device.send(to, bytes);
              },
              broadcast: (bytes) => device.broadcast(bytes),
              disconnect: (peer) => device.disconnect(peer),
              onMessage: (listener) => device.onMessage(listener),
              onPeerChange: (listener) => device.onPeerChange(listener),
            }
          : device,
      store: required(stores[index]),
      clock: network.clock,
      engine: createBaseEngine(),
      freezePeers: index === 0 ? freezeHost : () => undefined,
      gameRuntime: runtime,
    });
  });
  const settle = async (until: () => boolean) => {
    for (let step = 0; step < 500; step += 1) {
      network.clock.advanceBy(step % 10 === 0 ? 100 : 0);
      // Signature and deck proof work needs event-loop time between mesh ticks.
      // oxlint-disable-next-line no-await-in-loop -- Drive one bounded virtual tick at a time.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (until()) return;
    }
    throw new Error(
      `Online startup retry stalled: ${JSON.stringify(starts.map((start) => start.snapshot()))}`,
    );
  };
  network.clock.advanceBy(0);
  const host = required(lobbies[0]);
  const guest = required(lobbies[1]);
  unwrap(guest.request({ kind: 'takeSeat', seat: 1 }));
  network.clock.advanceBy(0);
  unwrap(host.setBot(2, 'easy'));
  network.clock.advanceBy(0);
  unwrap(host.setBot(3, 'easy', required(identities[1]).peerId));
  network.clock.advanceBy(0);
  unwrap(host.request({ kind: 'setReady', ready: true }));
  network.clock.advanceBy(0);
  unwrap(guest.request({ kind: 'setReady', ready: true }));
  network.clock.advanceBy(0);
  unwrap(required(starts[0]).begin());
  return {
    starts,
    journals,
    journalCreations,
    settle,
    hostGameFrames: () => hostGameFrames,
    async close() {
      await Promise.all(starts.map((start) => start.close()));
      for (const lobby of lobbies) lobby.dispose();
      for (const identity of identities) identity.dispose();
      network.dispose();
    },
  };
}

test('retries the exact consented game after its writer lease is briefly unavailable', async () => {
  const progress = captureCeremonyProgress();
  let hostLeaseAttempts = 0;
  const room = await setupTwoHumans(async () => (hostLeaseAttempts++ === 0 ? null : testLease()));
  try {
    await room.settle(
      () =>
        required(room.starts[0]).snapshot()?.phase === 'error' &&
        required(room.starts[1]).game() !== null,
    );
    const consent = required(required(room.starts[0]).agreement());
    const guestGame = required(required(room.starts[1]).game());
    expect(required(room.starts[0]).game()).toBeNull();
    expect(hostLeaseAttempts).toBe(1);

    unwrap(await required(room.starts[0]).retryFailed());
    await room.settle(() => required(room.starts[0]).game() !== null);
    const hostGame = required(required(room.starts[0]).game());
    expect(hostGame.gameId).toBe(guestGame.gameId);
    expect(required(room.starts[0]).agreement()).toEqual(consent);
    expect(hostLeaseAttempts).toBe(2);

    expect(hostGame.genesis).toEqual(guestGame.genesis);
    expect(hostGame.session.getPrivate(0)).not.toBeNull();
    expect(hostGame.session.getPrivate(1)).toBeNull();
    expect(guestGame.session.getPrivate(1)).not.toBeNull();
    expect(guestGame.session.getPrivate(0)).toBeNull();
    expect(await required(room.journals[0]).load()).not.toBeNull();

    const board = hostGame.session.getState();
    const beforeDispute = room.hostGameFrames();
    progress.dispute(required(room.starts[0]));
    await room.settle(() => required(room.starts[0]).snapshot()?.phase === 'halted');
    expect(required(room.starts[0]).game()).toBe(hostGame);
    expect(hostGame.session.getState()).toEqual(board);
    expect(hostGame.session.getPrivate(0)).toBeNull();
    expect(hostGame.session.getPending()).toEqual([]);
    expect(room.hostGameFrames()).toBe(beforeDispute);
    expect((await required(room.starts[0]).retryFailed()).ok).toBe(false);
  } finally {
    await room.close();
    progress.restore();
  }
}, 60_000);

test('retries peer freezing before accepting a signed agreement', async () => {
  let freezeCalls = 0;
  const room = await setupTwoHumans(
    async () => testLease(),
    () => {
      freezeCalls += 1;
      if (freezeCalls === 1) throw new Error('Temporary transport roster failure');
    },
  );
  try {
    await room.settle(() => required(room.starts[0]).snapshot()?.phase === 'error');
    const host = required(room.starts[0]);
    expect(host.snapshot()?.error).toContain('Temporary transport roster failure');
    expect(host.agreement()).toBeNull();
    unwrap(await host.retryFailed());
    await room.settle(() => host.game() !== null);
    expect(freezeCalls).toBe(2);
    expect(host.agreement()).not.toBeNull();
  } finally {
    await room.close();
  }
}, 60_000);

test('a consented dispute during opening cancels the late lease and permanently halts startup', async () => {
  const progress = captureCeremonyProgress();
  let releaseLease!: (lease: GameWriterLease) => void;
  const pendingLease = new Promise<GameWriterLease>((resolve) => {
    releaseLease = resolve;
  });
  let leaseRequested = false;
  let leaseClosed = false;
  let released = false;
  const room = await setupTwoHumans(() => {
    leaseRequested = true;
    return pendingLease;
  });
  try {
    await room.settle(() => leaseRequested);
    const host = required(room.starts[0]);
    expect(host.snapshot()?.phase).toBe('opening');
    const beforeDispute = room.hostGameFrames();
    progress.dispute(host);
    await room.settle(() => host.snapshot()?.phase === 'halted');
    expect((await host.retryFailed()).ok).toBe(false);
    releaseLease(
      testLease(() => {
        leaseClosed = true;
      }),
    );
    released = true;
    await room.settle(() => leaseClosed);
    expect(host.snapshot()).toMatchObject({
      phase: 'halted',
      error: 'online-ceremony-disputed',
      locallyConsented: true,
    });
    expect(host.game()).toBeNull();
    expect(required(room.journalCreations[0])).toBe(0);
    expect(await required(room.journals[0]).load()).toBeNull();
    expect(room.hostGameFrames()).toBe(beforeDispute);
    expect((await host.retryFailed()).ok).toBe(false);
  } finally {
    if (!released) releaseLease(testLease());
    await room.close();
    progress.restore();
  }
}, 60_000);

test('closing during a deferred game lease cannot initialize or transmit the game', async () => {
  const store = new MemoryEscrowLifecycleStore();
  const identity = await loadOrCreateOnlineIdentity(store, (length) =>
    new Uint8Array(length).fill(8),
  );
  const network = createMemnet({ peers: [identity.peerId] });
  const device = network.transport(identity.peerId);
  const lobby = unwrap(
    LobbyController.createHost({
      lobbyId: 'startclose',
      transport: createOnlineLobbyTransport(device),
      clock: network.clock,
      secretKey: identity.secretKey,
      name: 'Close test',
      hostName: 'Avery',
      config: {
        modules: [{ id: 'base', version: BASE_VERSION }],
        seats: [0, 1],
        options: { base: { mapLayout: 'random', vpTarget: 3 } },
      },
    }),
  );
  let releaseLease!: (lease: GameWriterLease) => void;
  const pendingLease = new Promise<GameWriterLease>((resolve) => {
    releaseLease = resolve;
  });
  let leaseRequested = false;
  let leaseClosed = false;
  let journalCreated = false;
  let gameFrames = 0;
  const startup = new OnlineStartup({
    invite: {
      roomId: 'startclose',
      hostPeer: identity.peerId,
      serverUrl: 'ws://localhost:3009',
    },
    identity,
    lobby,
    transport: {
      self: device.self,
      peers: () => device.peers(),
      send(to, bytes) {
        if (bytes[0] === 0x43 && bytes[1] === 0x50 && bytes[2] === 0x32 && bytes[3] === 0x47)
          gameFrames += 1;
        device.send(to, bytes);
      },
      broadcast: (bytes) => device.broadcast(bytes),
      disconnect: (peer) => device.disconnect(peer),
      onMessage: (listener) => device.onMessage(listener),
      onPeerChange: (listener) => device.onPeerChange(listener),
    },
    store,
    clock: network.clock,
    engine: createBaseEngine(),
    freezePeers: () => undefined,
    gameRuntime: {
      acquireLease: () => {
        leaseRequested = true;
        return pendingLease;
      },
      createJournal: () => {
        journalCreated = true;
        return Object.assign(new MemoryProtocolJournal(), { close: async () => undefined });
      },
    },
  });
  try {
    network.clock.advanceBy(0);
    unwrap(lobby.setBot(1, 'easy'));
    network.clock.advanceBy(0);
    unwrap(lobby.request({ kind: 'setReady', ready: true }));
    network.clock.advanceBy(0);
    unwrap(startup.begin());
    for (let step = 0; step < 500; step += 1) {
      network.clock.advanceBy(step % 10 === 0 ? 100 : 0);
      // oxlint-disable-next-line no-await-in-loop -- Drive one bounded ceremony tick at a time.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (leaseRequested) break;
    }
    expect(leaseRequested).toBe(true);
    const beforeClose = gameFrames;
    const closing = startup.close();
    releaseLease({
      lockName: 'close-test-game',
      run: async <T>(task: () => T | PromiseLike<T>): Promise<T> => task(),
      close: async () => {
        leaseClosed = true;
      },
    });
    await closing;
    expect(startup.game()).toBeNull();
    expect(journalCreated).toBe(false);
    expect(gameFrames).toBe(beforeClose);
    expect(leaseClosed).toBe(true);
  } finally {
    await startup.close();
    lobby.dispose();
    identity.dispose();
    network.dispose();
  }
}, 60_000);

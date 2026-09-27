import { RandomBot, createBotRng } from '@cp2p/bots';
import { BASE_VERSION, createBaseEngine } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { LobbyController, MemoryProtocolJournal, OnlineCeremony } from '@cp2p/protocol';
import type { EscrowCeremonyStore, OnlineCeremonyProgress } from '@cp2p/protocol';
import { createMemnet, MemoryEscrowLifecycleStore } from '@cp2p/protocol/testing';
import { expect, test, vi } from 'vitest';
import { loadOnlineIdentity, loadOrCreateOnlineIdentity } from './online-credentials.js';
import { loadOnlineGameRecord } from './online-game-records.js';
import type { OnlineGameRuntime } from './online-game.js';
import { createOnlineLobbyTransport } from './online-lobby-transport.js';
import { OnlineStartup } from './online-startup.js';

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing online resume fixture value');
  return value;
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function runtime(journal: MemoryProtocolJournal): OnlineGameRuntime {
  return {
    acquireLease: async () => ({
      lockName: 'resume-test-game',
      run: async <T>(task: () => T | PromiseLike<T>): Promise<T> => task(),
      close: async () => undefined,
    }),
    createJournal: () => Object.assign(journal, { close: async () => undefined }),
    auditRunner: () => {
      throw new Error('The audit cannot run before a result');
    },
  };
}

async function settle(
  clock: ReturnType<typeof createMemnet>['clock'],
  done: () => boolean,
  snapshots: () => unknown,
): Promise<void> {
  for (let step = 0; step < 600; step += 1) {
    clock.advanceBy(step % 10 === 0 ? 100 : 0);
    // oxlint-disable-next-line no-await-in-loop -- Allow the real proof work to yield between virtual ticks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (done()) return;
  }
  throw new Error(`Online resume stalled: ${JSON.stringify(snapshots())}`);
}

test('restores the exact signed game and first certified action without new consent or keys', async () => {
  const stores = [new MemoryEscrowLifecycleStore(), new MemoryEscrowLifecycleStore()];
  const identities = await Promise.all(
    stores.map((store, index) =>
      loadOrCreateOnlineIdentity(store, (length) => new Uint8Array(length).fill(index + 1)),
    ),
  );
  const journals = [new MemoryProtocolJournal(), new MemoryProtocolJournal()];
  const host = required(identities[0]);
  const invite = {
    roomId: 'resumetest',
    hostPeer: host.peerId,
    serverUrl: 'ws://localhost:3009',
  };
  const firstNetwork = createMemnet({ peers: identities.map((identity) => identity.peerId) });
  const lobbies = identities.map((identity, index) => {
    const common = {
      lobbyId: invite.roomId,
      transport: createOnlineLobbyTransport(firstNetwork.transport(identity.peerId)),
      clock: firstNetwork.clock,
      secretKey: identity.secretKey,
    };
    return unwrap(
      index === 0
        ? LobbyController.createHost({
            ...common,
            name: 'Resume test',
            hostName: 'Avery',
            config: {
              modules: [{ id: 'base', version: BASE_VERSION }],
              seats: [0, 1, 2, 3],
              options: { base: { mapLayout: 'random', vpTarget: 3 } },
            },
          })
        : LobbyController.join({ ...common, hostPeer: host.peerId }),
    );
  });
  const first = identities.map(
    (identity, index) =>
      new OnlineStartup({
        invite,
        identity,
        lobby: required(lobbies[index]),
        transport: firstNetwork.transport(identity.peerId),
        store: required(stores[index]),
        clock: firstNetwork.clock,
        engine: createBaseEngine(),
        freezePeers: () => undefined,
        gameRuntime: runtime(required(journals[index])),
      }),
  );
  let gameId = '';
  let certifiedSeq = 0;
  try {
    firstNetwork.clock.advanceBy(0);
    unwrap(required(lobbies[1]).request({ kind: 'takeSeat', seat: 1 }));
    firstNetwork.clock.advanceBy(0);
    unwrap(required(lobbies[0]).setBot(2, 'easy'));
    firstNetwork.clock.advanceBy(0);
    unwrap(required(lobbies[0]).setBot(3, 'easy', required(identities[1]).peerId));
    firstNetwork.clock.advanceBy(0);
    unwrap(required(lobbies[0]).request({ kind: 'setReady', ready: true }));
    firstNetwork.clock.advanceBy(0);
    unwrap(required(lobbies[1]).request({ kind: 'setReady', ready: true }));
    firstNetwork.clock.advanceBy(0);
    unwrap(required(first[0]).begin());
    await settle(
      firstNetwork.clock,
      () => first.every((start) => start.game() !== null),
      () => first.map((start) => start.snapshot()),
    );
    const games = first.map((start) => required(start.game()));
    gameId = required(games[0]).gameId;
    await settle(
      firstNetwork.clock,
      () =>
        games.some((game) =>
          game.session
            .getPending()
            .some((item) => item.kind === 'player' && item.seat === game.seat),
        ),
      () => games.map((game) => game.session.getCommittedHead()),
    );
    const actor = required(
      games.find((game) =>
        game.session.getPending().some((item) => item.kind === 'player' && item.seat === game.seat),
      ),
    );
    const pending = required(
      actor.session.getPending().find((item) => item.kind === 'player' && item.seat === actor.seat),
    );
    const command = new RandomBot().decide(
      {
        state: actor.session.getState(),
        priv: required(actor.session.getPrivate(actor.seat)),
        seat: actor.seat,
      },
      pending,
      createBotRng(new Uint8Array(32).fill(5)),
    );
    const before = actor.session.getCommittedHead().seq;
    const submitted = actor.session.submit(actor.seat, command);
    await settle(
      firstNetwork.clock,
      () => games.every((game) => game.session.getCommittedHead().seq > before),
      () => games.map((game) => game.session.getCommittedHead()),
    );
    unwrap(await submitted);
    certifiedSeq = required(games[0]).session.getCommittedHead().seq;
    expect(required(games[1]).session.getCommittedHead().seq).toBe(certifiedSeq);
  } finally {
    await Promise.all(first.map((start) => start.close()));
    for (const lobby of lobbies) lobby.dispose();
    for (const identity of identities) identity.dispose();
    firstNetwork.dispose();
  }

  const restoredIdentities = await Promise.all(stores.map((store) => loadOnlineIdentity(store)));
  const records = await Promise.all(stores.map((store) => loadOnlineGameRecord(store, gameId)));
  expect(records.every((record) => record?.gameId === gameId)).toBe(true);
  const listeners = new Map<OnlineCeremony, (progress: OnlineCeremonyProgress) => void>();
  // oxlint-disable-next-line typescript/unbound-method -- The wrapper retains the coordinator receiver.
  const onChange = OnlineCeremony.prototype.onChange;
  const progressSpy = vi.spyOn(OnlineCeremony.prototype, 'onChange').mockImplementation(function (
    this: OnlineCeremony,
    listener,
  ) {
    listeners.set(this, listener);
    return onChange.call(this, listener);
  });
  const secondNetwork = createMemnet({
    peers: restoredIdentities.map((identity) => identity.peerId),
  });
  const restored = restoredIdentities.map(
    (identity, index) =>
      new OnlineStartup({
        invite,
        identity,
        resume: required(records[index]),
        transport: secondNetwork.transport(identity.peerId),
        store: required(stores[index]),
        clock: secondNetwork.clock,
        engine: createBaseEngine(),
        gameRuntime: runtime(required(journals[index])),
      }),
  );
  try {
    expect(restored.map((start) => start.snapshot()?.gameId)).toEqual([gameId, gameId]);
    expect(restored.map((start) => start.begin().ok)).toEqual([false, false]);
    await settle(
      secondNetwork.clock,
      () => restored.every((start) => start.game() !== null),
      () => restored.map((start) => start.snapshot()),
    );
    for (const start of restored) {
      const game = required(start.game());
      expect(game.gameId).toBe(gameId);
      expect(game.session.getCommittedHead().seq).toBeGreaterThanOrEqual(certifiedSeq);
      expect(game.session.getPrivate(game.seat)).not.toBeNull();
      expect(game.session.getPrivate(game.seat === 0 ? 1 : 0)).toBeNull();
    }
    expect(required(restored[0]).game()?.session.getState()).toEqual(
      required(restored[1]).game()?.session.getState(),
    );
    const coordinator: unknown = Reflect.get(required(restored[0]), 'ceremony');
    if (!(coordinator instanceof OnlineCeremony)) throw new Error('Restored ceremony is missing');
    const gameBeforeDispute = required(restored[0]).game();
    vi.spyOn(coordinator, 'result').mockReturnValue(null);
    required(listeners.get(coordinator))({
      phase: 'waiting',
      awaitingSeats: [],
      locallyConsented: true,
      error: 'online-ceremony-disputed',
    });
    expect(required(restored[0]).snapshot()?.phase).toBe('halted');
    expect(required(restored[0]).game()).toBe(gameBeforeDispute);
    expect((await required(restored[0]).retryFailed()).ok).toBe(false);
  } finally {
    await Promise.all(restored.map((start) => start.close()));
    for (const identity of restoredIdentities) identity.dispose();
    secondNetwork.dispose();
    progressSpy.mockRestore();
  }

  const missingJournalNetwork = createMemnet({ peers: [host.peerId] });
  const missingIdentity = await loadOnlineIdentity(required(stores[0]));
  const missingJournal = new OnlineStartup({
    invite,
    identity: missingIdentity,
    resume: required(records[0]),
    transport: missingJournalNetwork.transport(missingIdentity.peerId),
    store: required(stores[0]),
    clock: missingJournalNetwork.clock,
    engine: createBaseEngine(),
    gameRuntime: runtime(new MemoryProtocolJournal()),
  });
  try {
    await settle(
      missingJournalNetwork.clock,
      () => missingJournal.snapshot()?.phase === 'error',
      () => missingJournal.snapshot(),
    );
    expect(missingJournal.snapshot()?.error).toContain('journal is missing');
    expect(missingJournal.game()).toBeNull();
  } finally {
    await missingJournal.close();
    missingIdentity.dispose();
    missingJournalNetwork.dispose();
  }

  const missingMaterialNetwork = createMemnet({ peers: [host.peerId] });
  const materialIdentity = await loadOnlineIdentity(required(stores[0]));
  const originalStore = required(stores[0]);
  const hiddenStore: EscrowCeremonyStore = {
    load: (id) =>
      id.startsWith('online-credentials/ceremony/')
        ? Promise.resolve(null)
        : originalStore.load(id),
    putIfAbsent: (id, bytes) => originalStore.putIfAbsent(id, bytes),
    compareAndSwap: (id, oldBytes, bytes) => originalStore.compareAndSwap(id, oldBytes, bytes),
    withCeremonyLock: (id, task) => originalStore.withCeremonyLock(id, task),
  };
  const missingMaterial = new OnlineStartup({
    invite,
    identity: materialIdentity,
    resume: required(records[0]),
    transport: missingMaterialNetwork.transport(materialIdentity.peerId),
    store: hiddenStore,
    clock: missingMaterialNetwork.clock,
    engine: createBaseEngine(),
    gameRuntime: runtime(required(journals[0])),
  });
  try {
    await settle(
      missingMaterialNetwork.clock,
      () => missingMaterial.snapshot()?.phase === 'error',
      () => missingMaterial.snapshot(),
    );
    expect(missingMaterial.snapshot()?.error).toContain('Stored ceremony material is missing');
    expect(missingMaterial.game()).toBeNull();
  } finally {
    await missingMaterial.close();
    materialIdentity.dispose();
    missingMaterialNetwork.dispose();
  }
}, 90_000);

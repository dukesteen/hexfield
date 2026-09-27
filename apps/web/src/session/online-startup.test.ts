import { canonicalDecode } from '@cp2p/codec';
import { RandomBot, createBotRng } from '@cp2p/bots';
import { BASE_VERSION, createBaseEngine } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { LobbyController, MemoryProtocolJournal } from '@cp2p/protocol';
import { createMemnet, MemoryEscrowLifecycleStore } from '@cp2p/protocol/testing';
import { describe, expect, test, vi } from 'vitest';
import { loadOrCreateOnlineIdentity } from './online-credentials.js';
import { createOnlineLobbyTransport } from './online-lobby-transport.js';
import { OnlineStartup } from './online-startup.js';
import type { OnlineGameRuntime } from './online-game.js';

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing startup fixture value');
  return value;
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

async function setup() {
  const stores = [new MemoryEscrowLifecycleStore(), new MemoryEscrowLifecycleStore()];
  const identities = await Promise.all(
    stores.map((store, index) =>
      loadOrCreateOnlineIdentity(store, (length) => new Uint8Array(length).fill(index + 1)),
    ),
  );
  const network = createMemnet({ peers: identities.map((identity) => identity.peerId) });
  const hostIdentity = required(identities[0]);
  const invite = {
    roomId: 'startuptst',
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
            name: 'Startup test',
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
  const frozen = identities.map(() => vi.fn<(peers: readonly string[]) => void>());
  const journals = identities.map(() => new MemoryProtocolJournal());
  const bindings: unknown[] = [];
  const leases = identities.map(() => ({
    lockName: 'test-game',
    run: async <T>(task: () => T | PromiseLike<T>): Promise<T> => task(),
    close: vi.fn<() => Promise<void>>(async () => undefined),
  }));
  const starts = identities.map((identity, index) => {
    const runtime: OnlineGameRuntime = {
      acquireLease: async () => required(leases[index]),
      createJournal: (_id, binding) => {
        bindings.push(canonicalDecode(binding.bytes));
        const journal = required(journals[index]);
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
      transport: network.transport(identity.peerId),
      store: required(stores[index]),
      clock: network.clock,
      engine: createBaseEngine(),
      freezePeers: required(frozen[index]),
      gameRuntime: runtime,
    });
  });
  return {
    starts,
    network,
    lobbies,
    journals,
    bindings,
    frozen,
    identities,
    leases,
    async settle(until: () => boolean) {
      for (let step = 0; step < 600; step += 1) {
        network.clock.advanceBy(step % 10 === 0 ? 100 : 0);
        // Real signature/proof work uses the same event-loop queue as the browser.
        // oxlint-disable-next-line no-await-in-loop -- Drive one bounded virtual mesh tick at a time.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (until()) return;
        if (starts.some((start) => start.snapshot()?.phase === 'error')) break;
      }
      throw new Error(
        `Browser startup stalled: ${JSON.stringify(starts.map((start) => start.snapshot()))}`,
      );
    },
    async close() {
      await Promise.all(starts.map((start) => start.close()));
      for (const lobby of lobbies) lobby.dispose();
      for (const identity of identities) identity.dispose();
      network.dispose();
    },
  };
}

describe('browser online startup', () => {
  test('freezes two humans and hosted bots, opens real sessions, and certifies the first board move', async () => {
    const room = await setup();
    try {
      expect(required(room.starts[1]).begin()).toMatchObject({ ok: false });
      unwrap(required(room.starts[0]).begin());
      await room.settle(() =>
        room.starts.every(
          (start) =>
            !!start
              .game()
              ?.session.getPending()
              .some((item) => item.kind === 'player'),
        ),
      );
      const games = room.starts.map((start) => required(start.game()));
      const first = required(games[0]);
      const second = required(games[1]);
      expect(first.gameId).toBe(second.gameId);
      expect(first.session.getState()).toEqual(second.session.getState());
      expect(first.session.controllableSeats()).toEqual([0]);
      expect(second.session.controllableSeats()).toEqual([1]);
      expect(first.session.getPrivate(1)).toBeNull();
      expect(second.session.getPrivate(0)).toBeNull();
      expect(first.session.getPrivate(2)).not.toBeNull();
      expect(second.session.getPrivate(3)).not.toBeNull();
      expect(room.bindings).toHaveLength(2);
      for (const freeze of room.frozen)
        expect(freeze).toHaveBeenCalledExactlyOnceWith(
          room.identities.map((identity) => identity.peerId),
        );
      for (const lobby of room.lobbies) expect(lobby.getDiagnostic()).toBeNull();
      await room.settle(() =>
        games.some((game) =>
          game.session
            .getPending()
            .some((item) => item.kind === 'player' && item.seat === game.seat),
        ),
      );
      const actor = required(
        games.find((game) =>
          game.session
            .getPending()
            .some((item) => item.kind === 'player' && item.seat === game.seat),
        ),
      );
      const pending = required(
        actor.session
          .getPending()
          .find((item) => item.kind === 'player' && item.seat === actor.seat),
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
      const previous = actor.session.getCommittedHead().seq;
      const submitted = actor.session.submit(actor.seat, command);
      await room.settle(() =>
        games.every((game) => game.session.getCommittedHead().seq > previous),
      );
      unwrap(await submitted);
      expect(first.session.getState()).toEqual(second.session.getState());
      expect(first.session.getCommittedHead()).toEqual(second.session.getCommittedHead());
      const saved = await required(room.journals[0]).load();
      expect(saved?.entries.length).toBeGreaterThan(0);
      expect(required(room.starts[0]).begin()).toMatchObject({ ok: false });
    } finally {
      await room.close();
    }
    for (const lease of room.leases) expect(lease.close).toHaveBeenCalledTimes(1);
  }, 60_000);
});

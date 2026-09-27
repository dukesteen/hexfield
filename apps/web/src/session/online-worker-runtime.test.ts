import { hashValue, toHex } from '@cp2p/codec';
import { BASE_VERSION } from '@cp2p/engine';
import { success } from '@cp2p/engine';
import type { LobbyState } from '@cp2p/protocol';
import { MemoryEscrowLifecycleStore } from '@cp2p/protocol/testing';
import { expect, test } from 'vitest';
import { loadOrCreateOnlineIdentity } from './online-credentials.js';
import { ONLINE_WORKER_PROTOCOL } from './online-worker-messages.js';
import type {
  OnlineWorkerEvent,
  OnlineWorkerRequest,
  OnlineWorkerRequestBody,
} from './online-worker-messages.js';
import { OnlineWorkerRuntime } from './online-worker-runtime.js';

function request(
  id: number,
  body: OnlineWorkerRequestBody,
  generation = 'room-one',
): OnlineWorkerRequest {
  return { protocol: ONLINE_WORKER_PROTOCOL, generation, id, body };
}

function update(revision: number) {
  return {
    revision,
    state: { public: true },
    events: [],
    pending: [],
    timers: [],
    status: { kind: 'running' },
  };
}

test('worker loads the durable device identity and refuses replayed or changed generations', async () => {
  const store = Object.assign(new MemoryEscrowLifecycleStore(), { close: async () => undefined });
  const identity = await loadOrCreateOnlineIdentity(store, (length) =>
    new Uint8Array(length).fill(9),
  );
  const invite = { roomId: 'workertest', hostPeer: identity.peerId, serverUrl: '' };
  const events: OnlineWorkerEvent[] = [];
  const worker = new OnlineWorkerRuntime({ store, emit: (event) => events.push(event) });
  try {
    const initialized = await worker.handle(
      request(1, { kind: 'initialize', mode: 'fresh', self: identity.peerId, invite }),
    );
    expect(initialized.result).toEqual({
      ok: true,
      value: { self: identity.peerId, invite, resume: null },
    });
    expect((await worker.handle(request(1, { kind: 'exportSave' }))).result).toMatchObject({
      ok: false,
    });
    expect(
      (await worker.handle(request(2, { kind: 'exportSave' }, 'another-room'))).result,
    ).toMatchObject({ ok: false });
    expect((await worker.handle(request(2, { kind: 'exportSave' }))).result).toMatchObject({
      ok: false,
    });
    expect(events).toEqual([]);
  } finally {
    await worker.close();
    identity.dispose();
  }
});

test('freeze pin is byte-exact before an ACK and cannot be replaced by a changed lobby state', async () => {
  const store = Object.assign(new MemoryEscrowLifecycleStore(), { close: async () => undefined });
  const identity = await loadOrCreateOnlineIdentity(store, (length) =>
    new Uint8Array(length).fill(7),
  );
  const invite = { roomId: 'pinworkert', hostPeer: identity.peerId, serverUrl: '' };
  const worker = new OnlineWorkerRuntime({ store, emit: () => undefined });
  const state: LobbyState = {
    lobbyId: invite.roomId,
    hostPeer: identity.peerId,
    hostEpoch: 0,
    version: 1,
    name: 'Pinned room',
    seats: [
      { seat: 0, kind: 'human', peer: identity.peerId, name: 'A', colour: 'blue', ready: true },
      { seat: 1, kind: 'open', colour: 'orange', ready: false },
    ],
    spectators: [],
    config: {
      modules: [{ id: 'base', version: BASE_VERSION }],
      seats: [0, 1],
      options: { base: { mapLayout: 'random', vpTarget: 3 } },
    },
    seedMode: { kind: 'joint' },
    takeover: { mode: 'vote', afterSeconds: 120 },
    status: 'starting',
    ceremonyNonce: 'a'.repeat(43),
  };
  try {
    expect(
      (
        await worker.handle(
          request(1, { kind: 'initialize', mode: 'fresh', self: identity.peerId, invite }),
        )
      ).result.ok,
    ).toBe(true);
    const first = await worker.handle(request(2, { kind: 'pinFreeze', state }));
    expect(first.result).toEqual({ ok: true, value: { freezeHash: toHex(hashValue(state)) } });
    const persisted = await store.load(`online-freeze/${identity.peerId}/${state.ceremonyNonce}`);
    expect(persisted).not.toBeNull();
    expect(
      (await worker.handle(request(3, { kind: 'pinFreeze', state: { ...state, name: 'Changed' } })))
        .result,
    ).toMatchObject({ ok: false });
    expect(await store.load(`online-freeze/${identity.peerId}/${state.ceremonyNonce}`)).toEqual(
      persisted,
    );
  } finally {
    await worker.close();
    identity.dispose();
  }
});

test('pending submit permits control; shutdown suppresses disposal updates and drains storage', async () => {
  let storeClosed = false;
  const store = Object.assign(new MemoryEscrowLifecycleStore(), {
    close: async () => {
      storeClosed = true;
    },
  });
  const identity = await loadOrCreateOnlineIdentity(store, (length) =>
    new Uint8Array(length).fill(5),
  );
  const invite = { roomId: 'workgameaa', hostPeer: identity.peerId, serverUrl: '' };
  const events: OnlineWorkerEvent[] = [];
  const worker = new OnlineWorkerRuntime({ store, emit: (event) => events.push(event) });
  let finishSubmit!: () => void;
  const submitted = new Promise<void>((resolve) => {
    finishSubmit = resolve;
  });
  const head = { seq: 0, hash: 'a'.repeat(64) };
  const listeners: ((value: unknown) => void)[] = [];
  let botPrivateReads = 0;
  const session = {
    getCommittedHead: () => head,
    subscribe(callback: (value: unknown) => void) {
      listeners.push(callback);
      callback(update(0));
      return () => {
        listeners.length = 0;
      };
    },
    getPrivate(seat: number) {
      if (seat !== 0) {
        botPrivateReads += 1;
        throw new Error('Bot private state escaped');
      }
      return { seat: 0, hand: { brick: 1 }, slots: {}, ext: { hidden: 'never-send' } };
    },
    getLegalCommands: () => ({ commands: [], templates: [] }),
    getEvents: () => [],
    controllableSeats: () => [0, 2],
    async submit() {
      await submitted;
      return success(undefined);
    },
    cancelPending: () => true,
    dispose() {
      listeners[0]?.(update(3));
      finishSubmit();
    },
  };
  try {
    expect(
      (
        await worker.handle(
          request(1, { kind: 'initialize', mode: 'fresh', self: identity.peerId, invite }),
        )
      ).result.ok,
    ).toBe(true);
    Reflect.set(worker, 'startup', {
      snapshot: () => ({
        phase: 'playing',
        awaitingSeats: [],
        locallyConsented: true,
        error: null,
        gameId: 'test',
      }),
      game: () => ({ gameId: 'test', genesis: { public: true }, seat: 0, session }),
      close: async () => undefined,
    });
    const publish: unknown = Reflect.get(worker, 'publishStartup');
    if (typeof publish !== 'function') throw new Error('Missing worker publication method');
    Reflect.apply(publish, worker, []);
    const first = events.filter((event) => event.kind === 'session');
    expect(first).toHaveLength(1);
    expect(first[0]?.snapshot.privateState).toEqual({
      seat: 0,
      hand: { brick: 1 },
      slots: {},
      ext: {},
    });
    expect(first[0]?.snapshot.controllableSeats).toEqual([0]);
    expect(botPrivateReads).toBe(0);
    const listener = listeners[0];
    if (!listener) throw new Error('Missing session subscription');
    listener(update(1));
    listener(update(2));
    expect(events.filter((event) => event.kind === 'session')).toHaveLength(1);

    const pending = worker.handle(
      request(2, { kind: 'submit', seat: 0, head, command: { type: 'END_TURN' } }),
    );
    await Promise.resolve();
    expect((await worker.handle(request(3, { kind: 'cancelPending', seat: 0 }))).result).toEqual({
      ok: true,
      value: true,
    });
    expect(
      (
        await worker.handle(
          request(4, { kind: 'setPrivateVisible', visible: false, visibilityToken: 1 }),
        )
      ).result.ok,
    ).toBe(true);
    expect((await worker.handle(request(5, { kind: 'cancelPending', seat: 2 }))).result.ok).toBe(
      false,
    );
    expect(
      (
        await worker.handle(
          request(6, {
            kind: 'submit',
            seat: 0,
            head: { ...head, hash: 'b'.repeat(64) },
            command: { type: 'END_TURN' },
          }),
        )
      ).result,
    ).toMatchObject({ ok: false, error: { code: 'stale-head' } });
    expect((await worker.handle(request(7, { kind: 'ackSession', snapshotId: 1 }))).result.ok).toBe(
      true,
    );
    const snapshots = events.filter((event) => event.kind === 'session');
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]?.snapshot.privateState).toBeNull();
    expect(snapshots[1]?.snapshot.visibilityToken).toBe(1);
    expect((await worker.handle(request(8, { kind: 'ackSession', snapshotId: 2 }))).result.ok).toBe(
      true,
    );
    const beforeShutdown = events.length;
    expect((await worker.handle(request(9, { kind: 'shutdown' }))).result.ok).toBe(true);
    expect((await pending).result.ok).toBe(true);
    expect(events).toHaveLength(beforeShutdown);
    expect(storeClosed).toBe(true);
  } finally {
    finishSubmit();
    await worker.close();
    identity.dispose();
  }
});

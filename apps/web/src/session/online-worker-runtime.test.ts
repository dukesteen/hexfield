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

test('worker owns bootstrap bytes before queued verification and rejects concurrent heavy exports', async () => {
  const store = Object.assign(new MemoryEscrowLifecycleStore(), { close: async () => undefined });
  const worker = new OnlineWorkerRuntime({ store, emit: () => undefined });
  let observed: Uint8Array | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  Reflect.set(worker, 'work', gate);
  Reflect.set(worker, 'destination', {
    async refreshBootstrap(bytes: Uint8Array) {
      observed = bytes;
    },
    snapshot: () => ({ phase: 'prepared' }),
    close: async () => undefined,
  });
  try {
    const backing = new Uint8Array(1000).fill(5);
    const operation = worker.handle(
      request(1, {
        kind: 'refreshTransferBootstrap',
        bootstrapBytes: backing.subarray(10, 15),
      }),
    );
    backing.fill(0);
    expect(
      (await worker.handle(request(2, { kind: 'exportTransferBootstrap' }))).result,
    ).toMatchObject({ ok: false, error: { message: 'Worker is closed or busy' } });
    release();
    expect((await operation).result.ok).toBe(true);
    expect(observed).toEqual(new Uint8Array(5).fill(5));
    expect(observed?.buffer.byteLength).toBe(5);
    expect(
      (
        await worker.handle(
          request(3, {
            kind: 'refreshTransferBootstrap',
            bootstrapBytes: new Uint8Array(new SharedArrayBuffer(10)),
          }),
        )
      ).result.ok,
    ).toBe(false);
  } finally {
    release();
    await worker.close();
  }
});

test('transfer bootstrap has one bounded slot and shutdown stops the destination before draining', async () => {
  let storeClosed = false;
  let destinationClosed = false;
  const store = Object.assign(new MemoryEscrowLifecycleStore(), {
    close: async () => {
      storeClosed = true;
    },
  });
  const worker = new OnlineWorkerRuntime({ store, emit: () => undefined });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  Reflect.set(worker, 'destination', {
    async refreshBootstrap() {
      started();
      await blocked;
    },
    snapshot: () => ({ phase: 'prepared' }),
    async close() {
      destinationClosed = true;
      release();
    },
  });
  const body = {
    kind: 'refreshTransferBootstrap' as const,
    bootstrapBytes: new Uint8Array(2 * 1024 * 1024),
  };
  try {
    const first = worker.handle(request(1, body));
    await entered;
    expect((await worker.handle(request(2, body))).result).toMatchObject({ ok: false });
    expect(
      (
        await worker.handle(
          request(3, {
            kind: 'setPrivateVisible',
            visible: false,
            visibilityToken: 1,
          }),
        )
      ).result,
    ).toMatchObject({ ok: true });
    const closing = worker.handle(request(4, { kind: 'shutdown' }));
    expect(destinationClosed).toBe(true);
    expect((await first).result).toMatchObject({ ok: false });
    expect((await closing).result).toMatchObject({ ok: true });
    expect(storeClosed).toBe(true);
  } finally {
    release();
    await worker.close();
  }
});

test('source transfer RPC rejects stale submission and wipes worker-generated entropy after shutdown', async () => {
  const store = Object.assign(new MemoryEscrowLifecycleStore(), { close: async () => undefined });
  const worker = new OnlineWorkerRuntime({ store, emit: () => undefined });
  const head = { seq: 3, hash: 'a'.repeat(64) };
  const seeds: Uint8Array[] = [];
  let submitted = false;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const session = {
    getCommittedHead: () => head,
    submitTransfer: async () => {
      submitted = true;
      return success(undefined);
    },
    async prepareTransferPrivate(authorization: unknown, entropy: Uint8Array, nonce: Uint8Array) {
      expect(authorization).toEqual(head);
      seeds.push(entropy, nonce);
      expect(entropy).toHaveLength(32);
      expect(nonce).toHaveLength(32);
      expect(entropy).not.toEqual(nonce);
      started();
      await blocked;
      return success({ sealed: 'packet' });
    },
    dispose: () => release(),
  };
  Reflect.set(worker, 'startup', {
    game: () => ({ session, seat: 0 }),
    close: async () => undefined,
  });
  try {
    expect(
      (
        await worker.handle(
          request(1, {
            kind: 'submitTransfer',
            head: { ...head, seq: 2 },
            change: {},
          }),
        )
      ).result,
    ).toMatchObject({ ok: false, error: { code: 'stale-head' } });
    expect(submitted).toBe(false);
    const sealing = worker.handle(
      request(2, { kind: 'prepareTransferPrivate', authorization: head }),
    );
    await entered;
    const closing = worker.handle(request(3, { kind: 'shutdown' }));
    expect((await sealing).result).toMatchObject({ ok: false });
    expect((await closing).result).toMatchObject({ ok: true });
    for (const seed of seeds) expect(seed.every((byte) => byte === 0)).toBe(true);
  } finally {
    release();
    await worker.close();
  }
});

test('takeover eligibility RPC returns only the local certified gate result', async () => {
  const store = Object.assign(new MemoryEscrowLifecycleStore(), { close: async () => undefined });
  const worker = new OnlineWorkerRuntime({ store, emit: () => undefined });
  const checked: number[] = [];
  Reflect.set(worker, 'startup', {
    game: () => ({
      session: {
        async canRequestTakeover(seat: number) {
          checked.push(seat);
          return seat === 2
            ? success(undefined)
            : { ok: false as const, error: { code: 'recovery-quorum', message: 'No quorum' } };
        },
        dispose: () => undefined,
      },
    }),
    close: async () => undefined,
  });
  try {
    expect(
      (await worker.handle(request(1, { kind: 'canRequestTakeover', departedSeat: 2 }))).result,
    ).toMatchObject({ ok: true, value: undefined });
    expect(
      (await worker.handle(request(2, { kind: 'canRequestTakeover', departedSeat: 1 }))).result,
    ).toMatchObject({ ok: false, error: { code: 'recovery-quorum' } });
    expect(checked).toEqual([2, 1]);
  } finally {
    await worker.close();
  }
});

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

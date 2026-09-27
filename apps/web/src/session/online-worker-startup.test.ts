// @vitest-environment happy-dom
import { hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { BASE_VERSION, createBaseEngine } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { LobbyController } from '@cp2p/protocol';
import { createMemnet, createSimulationGenesis } from '@cp2p/protocol/testing';
import { afterEach, expect, test, vi } from 'vitest';
import { OnlineWorkerClient } from './online-worker-client.js';
import type { OnlineProtocolWorkerPort } from './online-worker-client.js';
import type {
  OnlineWorkerInitialization,
  OnlineWorkerRequest,
  OnlineWorkerRequestBody,
  OnlineWorkerResumeInfo,
} from './online-worker-messages.js';
import { OnlineWorkerStartup } from './online-worker-startup.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

class FakeWorker implements OnlineProtocolWorkerPort {
  readonly requests: OnlineWorkerRequest[] = [];
  readonly messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
  readonly failureListeners = new Set<
    ((event: Event) => void) | ((event: MessageEvent<unknown>) => void)
  >();
  readonly ports: MessagePort[] = [];
  pausePin = false;
  pauseInitialize = false;
  pauseShutdown = false;
  rejectNext: OnlineWorkerRequestBody['kind'] | null = null;
  terminated = false;

  postMessage(message: OnlineWorkerRequest, _transfer: Transferable[]): void {
    this.requests.push(message);
    if (message.body.kind === 'attachTransport') this.ports.push(message.body.port);
    if (message.body.kind === 'pinFreeze' && this.pausePin) return;
    if (message.body.kind === 'initialize' && this.pauseInitialize) return;
    if (message.body.kind === 'shutdown' && this.pauseShutdown) return;
    queueMicrotask(() => this.reply(message));
  }

  reply(message: OnlineWorkerRequest): void {
    if (this.terminated) return;
    const body = message.body;
    const reject = this.rejectNext === body.kind;
    if (reject) this.rejectNext = null;
    const result =
      body.kind === 'initialize'
        ? { self: body.self, invite: body.mode === 'fresh' ? body.invite : undefined, resume: null }
        : body.kind === 'pinFreeze'
          ? { freezeHash: toHex(hashValue(body.state)) }
          : undefined;
    const event = new MessageEvent('message', {
      data: {
        protocol: message.protocol,
        generation: message.generation,
        id: message.id,
        kind: body.kind,
        result: reject
          ? { ok: false, error: { code: 'test-storage', message: 'Storage interrupted' } }
          : { ok: true, value: result },
      },
    });
    for (const listener of this.messageListeners) listener(event);
  }

  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: ((event: MessageEvent<unknown>) => void) | ((event: Event) => void),
  ): void {
    if (type === 'message') this.messageListeners.add(listener);
    else this.failureListeners.add(listener);
  }

  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  removeEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: ((event: MessageEvent<unknown>) => void) | ((event: Event) => void),
  ): void {
    if (type === 'message') this.messageListeners.delete(listener);
    else this.failureListeners.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
    for (const port of this.ports) port.close();
  }

  fail(): void {
    for (const listener of this.failureListeners) listener(new MessageEvent('error'));
  }

  emit(event: unknown): void {
    const message = new MessageEvent('message', { data: event });
    for (const listener of this.messageListeners) listener(message);
  }

  requestsOf(kind: OnlineWorkerRequestBody['kind']): OnlineWorkerRequest[] {
    return this.requests.filter((request) => request.body.kind === kind);
  }
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function fixture() {
  const secrets = [new Uint8Array(32).fill(21), new Uint8Array(32).fill(22)];
  const peers = secrets.map((key) => identityFromSecret(key).peerId);
  const hostPeer = peers[0];
  const guestPeer = peers[1];
  const hostKey = secrets[0];
  const guestKey = secrets[1];
  if (!hostPeer || !guestPeer || !hostKey || !guestKey) throw new Error('Missing identity');
  const invite = { roomId: 'workerstrt', hostPeer, serverUrl: '' };
  const network = createMemnet({ peers });
  const host = value(
    LobbyController.createHost({
      lobbyId: invite.roomId,
      name: 'Worker test',
      hostName: 'Avery',
      config: {
        modules: [{ id: 'base', version: BASE_VERSION }],
        seats: [0, 1],
        options: { base: { mapLayout: 'random' } },
      },
      transport: network.transport(hostPeer),
      clock: network.clock,
      secretKey: hostKey,
    }),
  );
  const guest = value(
    LobbyController.join({
      lobbyId: invite.roomId,
      hostPeer,
      transport: network.transport(guestPeer),
      clock: network.clock,
      secretKey: guestKey,
    }),
  );
  network.clock.advanceBy(0);
  value(guest.request({ kind: 'takeSeat', seat: 1 }));
  network.clock.advanceBy(0);
  value(host.request({ kind: 'setReady', ready: true }));
  network.clock.advanceBy(0);
  value(guest.request({ kind: 'setReady', ready: true }));
  network.clock.advanceBy(0);
  const worker = new FakeWorker();
  const client = new OnlineWorkerClient({ worker });
  const frozen = vi.fn<(peers: readonly string[]) => void>();
  const startup = new OnlineWorkerStartup({
    invite,
    self: hostPeer,
    transport: network.transport(hostPeer),
    clock: network.clock,
    lobby: host,
    freezePeers: frozen,
    client,
  });
  await tick();
  return {
    startup,
    worker,
    client,
    frozen,
    host,
    guest,
    network,
    peers,
    invite,
    async close() {
      await startup.close();
      host.dispose();
      guest.dispose();
      network.dispose();
    },
  };
}

const fixtures: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((item) => item.close()));
});

test('pin completes before local ACK, and ceremony waits for every signed freeze ACK', async () => {
  const room = await fixture();
  fixtures.push(room);
  room.worker.pausePin = true;
  const ack = vi.spyOn(room.host, 'ackFreeze');
  value(room.startup.begin());
  room.network.clock.advanceBy(0);
  await tick();
  expect(room.worker.requestsOf('pinFreeze')).toHaveLength(1);
  expect(ack).not.toHaveBeenCalled();
  expect(room.host.freezeAgreement()).toBeNull();
  expect(room.worker.requestsOf('startCeremony')).toHaveLength(0);
  expect(room.frozen).not.toHaveBeenCalled();
  const pin = room.worker.requestsOf('pinFreeze')[0];
  if (!pin) throw new Error('Missing pin request');
  room.worker.reply(pin);
  await tick();
  expect(ack).toHaveBeenCalledTimes(1);
  expect(room.host.freezeAgreement()).toBeNull();
  expect(room.worker.requestsOf('startCeremony')).toHaveLength(0);
  room.worker.pausePin = false;
  value(room.guest.ackFreeze());
  room.network.clock.advanceBy(0);
  expect(room.host.freezeAgreement()).not.toBeNull();
  await tick();
  room.network.clock.advanceBy(1_000);
  await tick();
  expect(room.frozen).toHaveBeenCalledExactlyOnceWith(room.peers);
  expect(room.worker.requestsOf('startCeremony')).toHaveLength(1);
});

test('changed lobby state while a pin is pending cannot ACK the old freeze', async () => {
  const room = await fixture();
  fixtures.push(room);
  room.worker.pausePin = true;
  const ack = vi.spyOn(room.host, 'ackFreeze');
  value(room.startup.begin());
  room.network.clock.advanceBy(0);
  await tick();
  const pinned = room.worker.requestsOf('pinFreeze')[0];
  if (!pinned) throw new Error('Missing pin request');
  const prior = room.host.state();
  if (!prior) throw new Error('Missing signed lobby state');
  // This substitutes a later observed public revision while keeping the production ACK path real.
  vi.spyOn(room.host, 'state').mockReturnValue({ ...prior, version: prior.version + 1 });
  room.worker.reply(pinned);
  await tick();
  expect(ack).not.toHaveBeenCalled();
  expect(room.host.freezeAgreement()).toBeNull();
  expect(room.frozen).not.toHaveBeenCalled();
  expect(room.worker.requestsOf('startCeremony')).toHaveLength(0);
});

test('an attach failure halts the bridge without downgrading halted to a retryable error', async () => {
  const room = await fixture();
  fixtures.push(room);
  room.worker.rejectNext = 'attachTransport';
  value(room.startup.begin());
  room.network.clock.advanceBy(0);
  await tick();
  expect(room.worker.requestsOf('attachTransport')).toHaveLength(1);
  expect(room.worker.terminated).toBe(true);
  expect(room.startup.snapshot()?.phase).toBe('halted');
  expect(room.worker.requestsOf('pinFreeze')).toHaveLength(0);
  expect(room.worker.requestsOf('startCeremony')).toHaveLength(0);
  await expect(room.startup.retryFailed()).resolves.toMatchObject({ ok: false });
});

test('a durable pin failure can retry without an ACK or fresh worker', async () => {
  const room = await fixture();
  fixtures.push(room);
  room.worker.rejectNext = 'pinFreeze';
  value(room.startup.begin());
  room.network.clock.advanceBy(0);
  await tick();
  expect(room.startup.snapshot()?.phase).toBe('error');
  expect(room.host.freezeAgreement()).toBeNull();
  expect(room.worker.terminated).toBe(false);
  expect(room.worker.requestsOf('startCeremony')).toHaveLength(0);
  expect(await room.startup.retryFailed()).toMatchObject({ ok: true });
  await tick();
  expect(room.worker.requestsOf('pinFreeze')).toHaveLength(2);
  expect(room.host.freezeAgreement()).toBeNull();
});

test('close stops worker bridge output before awaiting worker shutdown', async () => {
  const room = await fixture();
  fixtures.push(room);
  value(room.startup.begin());
  room.network.clock.advanceBy(0);
  await tick();
  const port = room.worker.ports[0];
  if (!port) throw new Error('Worker transport was not attached');
  const outbound: Uint8Array[] = [];
  const off = room.network
    .transport(room.peers[1] ?? '')
    .onMessage((_from, bytes) => outbound.push(bytes));
  port.postMessage({
    type: 'frame',
    generation: room.client.generation,
    id: 1,
    peer: room.peers[1],
    bytes: new Uint8Array([9]).buffer,
  });
  await tick();
  room.network.clock.advanceBy(0);
  expect(outbound).toEqual([new Uint8Array([9])]);
  outbound.length = 0;
  // Hold shutdown open and prove a later valid frame cannot reach the real transport.
  room.worker.pauseShutdown = true;
  const close = room.startup.close();
  port.postMessage({
    type: 'frame',
    generation: room.client.generation,
    id: 2,
    peer: room.peers[1],
    bytes: new Uint8Array([10]).buffer,
  });
  await tick();
  room.network.clock.advanceBy(0);
  expect(outbound).toEqual([]);
  expect(room.worker.terminated).toBe(false);
  const shutdown = room.worker.requestsOf('shutdown')[0];
  if (!shutdown) throw new Error('Missing shutdown request');
  room.worker.reply(shutdown);
  off();
  await close;
});

test('halt during initialization drains shutdown without attaching or accepting later startup events', async () => {
  const room = await fixture();
  fixtures.push(room);
  room.worker.pauseInitialize = true;
  room.worker.pauseShutdown = true;
  value(room.startup.begin());
  room.network.clock.advanceBy(0);
  await tick();
  const initialize = room.worker.requestsOf('initialize')[0];
  if (!initialize) throw new Error('Missing initialization request');
  const eventBase = { protocol: 'cp2p-online-worker-v1', generation: room.client.generation };
  const snapshot = {
    phase: 'halted',
    awaitingSeats: [],
    locallyConsented: false,
    error: 'Writer authority lost',
    gameId: null,
  };
  room.worker.emit({ ...eventBase, kind: 'startup', snapshot });
  room.worker.reply(initialize);
  room.worker.emit({ ...eventBase, kind: 'startup', snapshot: { ...snapshot, phase: 'opening' } });
  await tick();
  expect(room.startup.snapshot()?.phase).toBe('halted');
  expect(room.worker.requestsOf('attachTransport')).toHaveLength(0);
  expect(room.worker.requestsOf('pinFreeze')).toHaveLength(0);
  expect(room.worker.terminated).toBe(false);
  const shutdown = room.worker.requestsOf('shutdown')[0];
  if (!shutdown) throw new Error('Missing shutdown request');
  room.worker.reply(shutdown);
  await tick();
  expect(room.worker.terminated).toBe(true);
});

test('a worker crash halts startup and rejects later output', async () => {
  const room = await fixture();
  fixtures.push(room);
  const engine = createBaseEngine();
  const state = engine.createGame(
    {
      modules: [{ id: 'base', version: BASE_VERSION }],
      seats: [0, 1],
      options: { base: {} },
    },
    new Uint8Array(32).fill(3),
  );
  const eventBase = { protocol: 'cp2p-online-worker-v1', generation: room.client.generation };
  room.worker.emit({
    ...eventBase,
    kind: 'gameReady',
    game: { gameId: 'ready-game', genesis: {}, seat: 0 },
  });
  room.worker.emit({
    ...eventBase,
    kind: 'session',
    snapshotId: 1,
    snapshot: {
      committedHead: { seq: 0, hash: 'A'.repeat(64) },
      update: {
        revision: 0,
        state,
        pending: [],
        timers: [],
        events: [],
        status: { kind: 'running' },
      },
      events: [],
      localHumanSeat: 0,
      privateState: engine.createPrivateState(0),
      legal: { commands: [], templates: [] },
      controllableSeats: [0],
      visibilityToken: 0,
    },
  });
  const session = room.startup.game()?.session;
  expect(session?.getPrivate(0)).not.toBeNull();
  room.worker.fail();
  expect(room.startup.snapshot()?.phase).toBe('halted');
  expect(session?.getPrivate(0)).toBeNull();
  expect(session?.getLegalCommands(0).commands).toEqual([]);
  expect(session?.controllableSeats()).toEqual([]);
  expect(session?.getAudit?.()).toEqual({ kind: 'not-started' });
  expect(room.worker.terminated).toBe(true);
});

test('resume attaches a previously initialized client without fresh initialize or ceremony', async () => {
  const room = await fixture();
  fixtures.push(room);
  const state = room.host.state();
  if (!state) throw new Error('Missing public room state');
  // The worker admission path validates the saved record; this test covers only UI handoff.
  const resume: OnlineWorkerResumeInfo = {
    gameId: 'saved-worker-game',
    genesisDigest: toBase64Url(new Uint8Array(32)),
    agreement: { state, acks: [] },
    genesis: createSimulationGenesis({ seed: 3, humanCount: 2 }).genesis,
  };
  const initialization: OnlineWorkerInitialization = {
    self: room.peers[0] ?? '',
    invite: room.invite,
    resume,
  };
  const worker = new FakeWorker();
  const client = new OnlineWorkerClient({ worker });
  const restored = new OnlineWorkerStartup({
    invite: room.invite,
    self: room.peers[0] ?? '',
    transport: room.network.transport(room.peers[0] ?? ''),
    clock: room.network.clock,
    resume,
    client,
    initialization,
  });
  try {
    await tick();
    expect(worker.requestsOf('initialize')).toHaveLength(0);
    expect(worker.requestsOf('attachTransport')).toHaveLength(1);
    expect(worker.requestsOf('pinFreeze')).toHaveLength(0);
    expect(worker.requestsOf('startCeremony')).toHaveLength(0);
  } finally {
    await restored.close();
  }
});

import { afterEach, describe, expect, test, vi } from 'vitest';
import { ONLINE_WORKER_PROTOCOL } from './online-worker-messages.js';
import type { OnlineWorkerRequest } from './online-worker-messages.js';
import { OnlineWorkerClient } from './online-worker-client.js';
import type { OnlineProtocolWorkerPort } from './online-worker-client.js';

class FakeWorker implements OnlineProtocolWorkerPort {
  readonly requests: OnlineWorkerRequest[] = [];
  terminated = false;
  private readonly messageListeners = new Set<unknown>();
  private readonly errorListeners = new Set<unknown>();

  postMessage(message: OnlineWorkerRequest, _transfer: Transferable[]): void {
    if (this.terminated) throw new Error('worker terminated');
    this.requests.push(message);
  }

  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: unknown): void {
    if (type === 'message') this.messageListeners.add(listener);
    else this.errorListeners.add(listener);
  }

  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: unknown): void {
    if (type === 'message') this.messageListeners.delete(listener);
    else this.errorListeners.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: unknown): void {
    for (const listener of this.messageListeners)
      if (typeof listener === 'function')
        Reflect.apply(listener, undefined, [new MessageEvent('message', { data })]);
  }

  emitFailure(): void {
    for (const listener of this.errorListeners)
      if (typeof listener === 'function') Reflect.apply(listener, undefined, [new Event('error')]);
  }

  reply(request: OnlineWorkerRequest, result: unknown, kind = request.body.kind): void {
    this.emit({
      protocol: ONLINE_WORKER_PROTOCOL,
      generation: request.generation,
      id: request.id,
      kind,
      result,
    });
  }
}

function createClient(worker: FakeWorker, generation = 'worker-generation') {
  return new OnlineWorkerClient({ worker, generation });
}

function expectOk(result: unknown): void {
  expect(result).toMatchObject({ ok: true });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OnlineWorkerClient', () => {
  test('copies only visible request bytes and reserves the heavy slot for exports too', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const client = createClient(worker);
    const backing = new Uint8Array(2 * 1024 * 1024).fill(7);
    const bootstrapBytes = backing.subarray(900, 910);
    try {
      const importing = client.request({ kind: 'refreshTransferBootstrap', bootstrapBytes });
      const posted = worker.requests[0];
      if (posted?.body.kind !== 'refreshTransferBootstrap') throw new Error('Missing bootstrap');
      backing.fill(0);
      expect(posted.body.bootstrapBytes).toEqual(new Uint8Array(10).fill(7));
      expect(posted.body.bootstrapBytes.buffer.byteLength).toBe(10);
      await expect(client.request({ kind: 'exportSave' })).resolves.toMatchObject({ ok: false });
      worker.reply(posted, { ok: true, value: undefined });
      expectOk(await importing);
      const exporting = client.request({ kind: 'exportTransferBootstrap' });
      await vi.advanceTimersByTimeAsync(120_001);
      expect(worker.terminated).toBe(false);
      await expect(client.request({ kind: 'exportSave' })).resolves.toMatchObject({ ok: false });
      const exportRequest = worker.requests.at(-1);
      if (!exportRequest) throw new Error('Missing export');
      worker.reply(exportRequest, { ok: true, value: new Uint8Array() });
      expectOk(await exporting);

      backing.fill(9);
      const ordinary = client.request({
        kind: 'authorizeLiveTransfer',
        head: { seq: 1, hash: 'a'.repeat(64) },
        offer: { packet: backing.subarray(10, 20) },
      });
      const ordinaryRequest = worker.requests.at(-1);
      if (ordinaryRequest?.body.kind !== 'authorizeLiveTransfer') throw new Error('Missing offer');
      backing.fill(0);
      expect(ordinaryRequest.body.offer).toEqual({ packet: new Uint8Array(10).fill(9) });
      worker.reply(ordinaryRequest, { ok: true, value: undefined });
      expectOk(await ordinary);
      await expect(
        client.request({
          kind: 'refreshTransferBootstrap',
          bootstrapBytes: new Uint8Array(new SharedArrayBuffer(10)),
        }),
      ).resolves.toMatchObject({ ok: false });
    } finally {
      client.fail(new Error('Test cleanup'));
    }
  });

  test('forwards bounded certified route events and rejects duplicate active/catch-up devices', () => {
    const worker = new FakeWorker();
    const client = createClient(worker);
    const seen: string[] = [];
    client.subscribe((event) => seen.push(event.kind));
    const routes = {
      head: { seq: 12, hash: 'a'.repeat(64) },
      activeDevices: ['A'.repeat(43), 'B'.repeat(43)],
      catchupDevices: ['C'.repeat(43)],
      seats: [
        { seat: 0, devicePeer: 'A'.repeat(43) },
        { seat: 1, devicePeer: 'B'.repeat(43) },
      ],
    };
    const event = {
      protocol: ONLINE_WORKER_PROTOCOL,
      generation: client.generation,
      kind: 'deviceRoutes',
      routes,
    };
    worker.emit(event);
    expect(seen).toEqual(['deviceRoutes']);
    expect(worker.terminated).toBe(false);
    worker.emit({ ...event, routes: { ...routes, catchupDevices: ['A'.repeat(43)] } });
    expect(seen).toEqual(['deviceRoutes']);
    expect(worker.terminated).toBe(true);
  });

  test('permits one large public bootstrap without consuming the control byte reserve', async () => {
    const worker = new FakeWorker();
    const client = createClient(worker);
    try {
      const body = {
        kind: 'refreshTransferBootstrap' as const,
        bootstrapBytes: new Uint8Array(2 * 1024 * 1024),
      };
      const first = client.request(body);
      expect(worker.requests).toHaveLength(1);
      await expect(client.request(body)).resolves.toMatchObject({
        ok: false,
        error: { code: 'online-worker-busy' },
      });
      const control = client.request({
        kind: 'setPrivateVisible',
        visible: false,
        visibilityToken: 1,
      });
      expect(worker.requests).toHaveLength(2);
      for (const request of worker.requests) worker.reply(request, { ok: true, value: undefined });
      expectOk(await first);
      expectOk(await control);
      const retry = client.request(body);
      const posted = worker.requests.at(-1);
      if (!posted) throw new Error('Missing retry');
      worker.reply(posted, { ok: true, value: undefined });
      expectOk(await retry);
      await expect(
        client.request({
          kind: 'refreshTransferBootstrap',
          bootstrapBytes: new Uint8Array(16 * 1024 * 1024 + 1),
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'online-worker-busy' } });
      expect(worker.requests).toHaveLength(3);
    } finally {
      client.fail(new Error('test complete'));
    }
  });

  test('bounds pending ordinary request count and total canonical bytes', async () => {
    const worker = new FakeWorker();
    const client = createClient(worker);
    const requests = Array.from({ length: 12 }, () => client.request({ kind: 'retryStart' }));
    const control = client.request({ kind: 'ackSession', snapshotId: 9 });
    await expect(client.request({ kind: 'retryStart' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'online-worker-busy' },
    });
    expect(worker.requests).toHaveLength(13);
    worker.requests.forEach((request) => worker.reply(request, { ok: true, value: undefined }));
    for (const result of await Promise.all(requests)) expectOk(result);
    expectOk(await control);
    client.fail(new Error('test complete'));
  });

  test('enforces aggregate request bytes and single-request size before posting', async () => {
    const worker = new FakeWorker();
    const client = createClient(worker);
    const payload = 'x'.repeat(600_000);
    const first = client.request({ kind: 'approveRecoveryAuthorization', change: { payload } });
    const second = await client.request({
      kind: 'approveRecoveryAuthorization',
      change: { payload },
    });
    expect(second).toMatchObject({ ok: false, error: { code: 'online-worker-busy' } });
    expect(worker.requests).toHaveLength(1);
    const firstRequest = worker.requests[0];
    if (!firstRequest) throw new Error('Expected the bounded request');
    worker.reply(firstRequest, { ok: true, value: { amendment: null } });
    expect(await first).toMatchObject({ ok: true });

    const tooLarge = await client.request({
      kind: 'approveRecoveryAuthorization',
      change: { payload: 'y'.repeat(1_100_000) },
    });
    expect(tooLarge).toMatchObject({ ok: false, error: { code: 'online-worker-busy' } });
    expect(worker.requests).toHaveLength(1);
    client.fail(new Error('test complete'));
  });

  test('ignores another generation and fails closed on a reply with the wrong kind', async () => {
    const worker = new FakeWorker();
    const client = createClient(worker);
    const request = client.request({ kind: 'retryStart' });
    const pending = worker.requests[0];
    if (!pending) throw new Error('Expected a posted request');
    worker.emit({
      protocol: ONLINE_WORKER_PROTOCOL,
      generation: 'old-generation',
      id: pending.id,
      kind: 'retryStart',
      result: { ok: true, value: undefined },
    });
    expect(worker.terminated).toBe(false);
    worker.reply(pending, { ok: true, value: undefined }, 'shutdown');
    await expect(request).resolves.toMatchObject({
      ok: false,
      error: { code: 'online-worker-closed' },
    });
    expect(worker.terminated).toBe(true);
  });

  test('acknowledges each session snapshot by its snapshotId', async () => {
    const worker = new FakeWorker();
    const client = createClient(worker);
    const applied: string[] = [];
    client.subscribe((event) => applied.push(event.kind));
    worker.emit({
      protocol: ONLINE_WORKER_PROTOCOL,
      generation: 'worker-generation',
      kind: 'session',
      snapshotId: 17,
      snapshot: {
        committedHead: { seq: 0, hash: 'head-0' },
        update: { revision: 0, state: {}, status: {}, pending: [], timers: [], events: [] },
        events: [],
        controllableSeats: [0],
        visibilityToken: 0,
        localHumanSeat: 0,
      },
    });
    const acknowledgement = worker.requests[0];
    if (!acknowledgement || acknowledgement.body.kind !== 'ackSession')
      throw new Error('Expected a session snapshot acknowledgement');
    expect(acknowledgement.body.snapshotId).toBe(17);
    expect(applied).toEqual(['session']);
    worker.reply(acknowledgement, { ok: true, value: undefined });
    client.fail(new Error('test complete'));
  });

  test('notifies failure listeners before termination and fails every pending request', async () => {
    const worker = new FakeWorker();
    const client = createClient(worker);
    const observed: boolean[] = [];
    client.onFailure(() => observed.push(worker.terminated));
    const first = client.request({ kind: 'retryStart' });
    const second = client.request({ kind: 'exportSave' });
    worker.emitFailure();

    expect(observed).toEqual([false]);
    expect(worker.terminated).toBe(true);
    await expect(first).resolves.toMatchObject({
      ok: false,
      error: { code: 'online-worker-closed' },
    });
    await expect(second).resolves.toMatchObject({
      ok: false,
      error: { code: 'online-worker-closed' },
    });
  });

  test('shutdown drains only its RPC and enforces its ten-second timeout', async () => {
    const worker = new FakeWorker();
    const client = createClient(worker);
    const regular = client.request({ kind: 'retryStart' });
    const shutdown = client.shutdown();
    await Promise.resolve();
    await Promise.resolve();
    const shutdownRequest = worker.requests.find((request) => request.body.kind === 'shutdown');
    if (!shutdownRequest) throw new Error('Expected the shutdown request');
    const regularRequest = worker.requests.find((request) => request.body.kind === 'retryStart');
    if (!regularRequest) throw new Error('Expected the in-flight request');
    worker.reply(regularRequest, { ok: true, value: undefined });
    expectOk(await regular);
    worker.emit({
      protocol: ONLINE_WORKER_PROTOCOL,
      generation: 'worker-generation',
      kind: 'session',
      snapshotId: 17,
      snapshot: {
        committedHead: { seq: 0, hash: 'head-0' },
        update: { revision: 0, state: {}, status: {}, pending: [], timers: [], events: [] },
        events: [],
        controllableSeats: [0],
        visibilityToken: 0,
        localHumanSeat: 0,
      },
    });
    expect(worker.requests.map((request) => request.body.kind)).toEqual(['retryStart', 'shutdown']);
    worker.reply(shutdownRequest, { ok: true, value: undefined });
    await shutdown;
    expect(worker.terminated).toBe(true);

    vi.useFakeTimers();
    const timeoutWorker = new FakeWorker();
    const timeoutClient = createClient(timeoutWorker);
    const timeout = timeoutClient.shutdown();
    await Promise.resolve();
    await Promise.resolve();
    expect(timeoutWorker.requests[0]?.body.kind).toBe('shutdown');
    const timeoutOutcome = timeout.then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const outcome = await timeoutOutcome;
    expect(outcome.kind).toBe('rejected');
    const timeoutError = outcome.kind === 'rejected' ? outcome.error : new Error('did not timeout');
    expect(String(timeoutError)).toContain('stopped responding');
    expect(timeoutWorker.terminated).toBe(true);
  });

  test('an already queued snapshot ACK failure cannot interrupt graceful shutdown', async () => {
    const worker = new FakeWorker();
    const client = createClient(worker);
    worker.emit({
      protocol: ONLINE_WORKER_PROTOCOL,
      generation: 'worker-generation',
      kind: 'session',
      snapshotId: 21,
      snapshot: {
        committedHead: { seq: 0, hash: 'head-0' },
        update: { revision: 0, state: {}, status: {}, pending: [], timers: [], events: [] },
        events: [],
        controllableSeats: [0],
        visibilityToken: 0,
        localHumanSeat: 0,
      },
    });
    const ack = worker.requests[0];
    if (!ack || ack.body.kind !== 'ackSession') throw new Error('Expected queued ACK');
    const shutdown = client.shutdown();
    await Promise.resolve();
    await Promise.resolve();
    const stop = worker.requests.find((request) => request.body.kind === 'shutdown');
    if (!stop) throw new Error('Expected shutdown RPC');
    worker.reply(ack, { ok: false, error: { code: 'closed', message: 'already stopping' } });
    expect(worker.terminated).toBe(false);
    worker.reply(stop, { ok: true, value: undefined });
    await shutdown;
    expect(worker.terminated).toBe(true);
  });

  test('does not queue a snapshot ACK when an update listener starts shutdown', async () => {
    const worker = new FakeWorker();
    const client = createClient(worker);
    let shutdown: Promise<void> | undefined;
    client.subscribe(() => {
      shutdown = client.shutdown();
    });
    worker.emit({
      protocol: ONLINE_WORKER_PROTOCOL,
      generation: 'worker-generation',
      kind: 'session',
      snapshotId: 22,
      snapshot: {
        committedHead: { seq: 0, hash: 'head-0' },
        update: { revision: 0, state: {}, status: {}, pending: [], timers: [], events: [] },
        events: [],
        controllableSeats: [0],
        visibilityToken: 0,
        localHumanSeat: 0,
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.requests.map((request) => request.body.kind)).toEqual(['shutdown']);
    const stop = worker.requests[0];
    if (!stop) throw new Error('Expected shutdown RPC');
    worker.reply(stop, { ok: true, value: undefined });
    await shutdown;
    expect(worker.terminated).toBe(true);
  });
});

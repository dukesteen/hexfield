import { afterEach, describe, expect, test, vi } from 'vitest';
import type { OnlineTransportPort } from './online-worker-transport.js';
import {
  createMainThreadTransportBridge,
  createWorkerDeviceTransport,
  ONLINE_WORKER_MAX_FRAME_BYTES,
  ONLINE_WORKER_MAX_IN_FLIGHT_BYTES,
} from './online-worker-transport.js';

class TestPort implements OnlineTransportPort {
  readonly posted: unknown[] = [];
  readonly queued: Array<() => void> = [];
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  peer!: TestPort;
  paused = false;
  closed = false;

  postMessage(message: unknown, transfer?: Transferable[]): void {
    if (this.closed || this.peer.closed) throw new Error('port closed');
    const copy = structuredClone(message, transfer ? { transfer } : {});
    this.posted.push(copy);
    const deliver = () => {
      for (const listener of this.peer.listeners)
        listener(new MessageEvent('message', { data: copy }));
    };
    if (this.peer.paused) this.peer.queued.push(deliver);
    else queueMicrotask(deliver);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.delete(listener);
  }

  start(): void {}

  close(): void {
    this.closed = true;
  }

  flush(): void {
    while (this.queued.length > 0) this.queued.shift()?.();
  }

  inject(message: unknown): void {
    const copy = structuredClone(message);
    for (const listener of this.listeners) listener(new MessageEvent('message', { data: copy }));
  }
}

class TestTransport {
  readonly sent: Array<{ peer: string; bytes: Uint8Array }> = [];
  readonly disconnected: string[] = [];
  readonly messageListeners = new Set<(peer: string, bytes: Uint8Array) => void>();
  readonly peerListeners = new Set<(peer: string, online: boolean) => void>();
  readonly remotePeers = new Set(['device-b', 'device-c']);
  failSend = false;

  readonly transport = {
    self: 'device-a',
    peers: () => [...this.remotePeers],
    send: (peer: string, bytes: Uint8Array) => {
      if (this.failSend) throw new Error('underlying send failed');
      this.sent.push({ peer, bytes: new Uint8Array(bytes) });
    },
    broadcast: (bytes: Uint8Array) => {
      for (const peer of this.remotePeers) this.transport.send(peer, bytes);
    },
    onMessage: (listener: (peer: string, bytes: Uint8Array) => void) => {
      this.messageListeners.add(listener);
      return () => this.messageListeners.delete(listener);
    },
    onPeerChange: (listener: (peer: string, online: boolean) => void) => {
      this.peerListeners.add(listener);
      return () => this.peerListeners.delete(listener);
    },
    disconnect: (peer: string) => {
      this.disconnected.push(peer);
      if (this.remotePeers.delete(peer))
        for (const listener of this.peerListeners) listener(peer, false);
    },
  };

  emit(peer: string, bytes: Uint8Array): void {
    for (const listener of this.messageListeners) listener(peer, bytes);
  }

  setPeer(peer: string, online: boolean): void {
    if (online) this.remotePeers.add(peer);
    else this.remotePeers.delete(peer);
    for (const listener of this.peerListeners) listener(peer, online);
  }
}

function portPair(): [TestPort, TestPort] {
  const left = new TestPort();
  const right = new TestPort();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function bridgeFixture(generation = 'room-generation-1') {
  const [mainPort, workerPort] = portPair();
  const device = new TestTransport();
  const failures: Error[] = [];
  const bridge = createMainThreadTransportBridge({
    transport: device.transport,
    port: mainPort,
    generation,
    onFailure: (error) => failures.push(error),
  });
  const worker = createWorkerDeviceTransport({
    self: 'device-a',
    peers: ['device-b', 'device-c'],
    port: workerPort,
    generation,
    onFailure: (error) => failures.push(error),
  });
  return { mainPort, workerPort, device, bridge, worker, failures };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('online worker device transport', () => {
  test('copies caller bytes, routes authenticated frames both ways, and ignores stale generations', async () => {
    const fixture = bridgeFixture();
    const received: Uint8Array[] = [];
    fixture.worker.onMessage((_peer, bytes) => received.push(bytes));
    const inbound = new Uint8Array([1, 2, 3]);
    fixture.device.emit('device-b', inbound);
    fixture.device.emit('untrusted-peer', new Uint8Array([0]));
    inbound.fill(9);
    await flush();
    expect(received).toHaveLength(1);
    expect([...(received[0] ?? [])]).toEqual([1, 2, 3]);

    const outbound = new Uint8Array([4, 5, 6]);
    fixture.worker.send('device-c', outbound);
    outbound.fill(0);
    await flush();
    expect(fixture.device.sent.map(({ peer, bytes }) => [peer, [...bytes]])).toEqual([
      ['device-c', [4, 5, 6]],
    ]);

    fixture.workerPort.inject({
      type: 'frame',
      generation: 'old-generation',
      id: 20,
      peer: 'device-b',
      bytes: new Uint8Array([8]).buffer,
    });
    await flush();
    expect(received).toHaveLength(1);
    fixture.worker.close();
    fixture.bridge.close();
  });

  test('drops frames over one peer’s cap without blocking another peer', async () => {
    const fixture = bridgeFixture();
    fixture.workerPort.paused = true;
    const frame = new Uint8Array([1]);
    for (let i = 0; i < 9; i++) fixture.device.emit('device-b', frame);
    fixture.device.emit('device-c', frame);

    expect(fixture.device.disconnected).toEqual([]);
    expect(fixture.workerPort.queued).toHaveLength(9);
    fixture.workerPort.flush();
    await flush();
    expect(fixture.worker.peers()).toEqual(['device-b', 'device-c']);
    fixture.worker.close();
    fixture.bridge.close();
  });

  test('caps aggregate in-flight bytes across peers', () => {
    const fixture = bridgeFixture();
    fixture.workerPort.paused = true;
    for (const peer of ['device-b', 'device-c', 'device-d', 'device-e', 'device-f'])
      fixture.device.setPeer(peer, true);
    fixture.device.setPeer('device-g', true);
    const frame = new Uint8Array(ONLINE_WORKER_MAX_FRAME_BYTES);
    for (const peer of ['device-b', 'device-c', 'device-d', 'device-e'])
      for (let i = 0; i < 2; i++) fixture.device.emit(peer, frame);
    fixture.device.emit('device-f', frame);

    const frames = fixture.mainPort.posted.filter(
      (message) =>
        message !== null && typeof message === 'object' && Reflect.get(message, 'type') === 'frame',
    );
    expect(frames).toHaveLength(8);
    expect(frames.length * frame.byteLength).toBe(ONLINE_WORKER_MAX_IN_FLIGHT_BYTES);
    expect(fixture.device.disconnected).toEqual([]);
    fixture.bridge.close();
    fixture.worker.close();
  });

  test('drops outbound packets at bounded capacity without throwing or disconnecting', async () => {
    const fixture = bridgeFixture();
    fixture.mainPort.paused = true;
    const frame = new Uint8Array(ONLINE_WORKER_MAX_FRAME_BYTES);
    expect(() => fixture.worker.send('device-b', frame)).not.toThrow();
    expect(() => fixture.worker.send('device-b', frame)).not.toThrow();
    expect(() => fixture.worker.send('device-b', frame)).not.toThrow();
    expect(() => fixture.worker.send('offline-peer', frame)).not.toThrow();
    expect(() => fixture.worker.send('device-c', frame)).not.toThrow();
    expect(fixture.mainPort.queued).toHaveLength(3);
    expect(fixture.device.disconnected).toEqual([]);
    fixture.mainPort.flush();
    await flush();
    expect(fixture.device.sent.map(({ peer }) => peer)).toEqual([
      'device-b',
      'device-b',
      'device-c',
    ]);
    fixture.worker.close();
    fixture.bridge.close();
  });

  test('oversized packets disconnect their peer and malformed messages fail closed', async () => {
    const oversized = bridgeFixture();
    oversized.device.emit('device-b', new Uint8Array(ONLINE_WORKER_MAX_FRAME_BYTES + 1));
    expect(oversized.device.disconnected).toEqual(['device-b']);
    oversized.worker.close();
    oversized.bridge.close();

    const malformed = bridgeFixture();
    malformed.mainPort.inject({ type: 'frame', generation: 'room-generation-1', id: 1 });
    await flush();
    expect(malformed.failures).toHaveLength(1);
    expect(malformed.mainPort.closed).toBe(true);
    malformed.bridge.close();
  });

  test('duplicate acknowledgements are ignored and output stop leaves inbound controls active', async () => {
    const fixture = bridgeFixture();
    const received: number[] = [];
    fixture.worker.onMessage((_peer, bytes) => received.push(bytes[0] ?? 0));
    fixture.device.emit('device-b', new Uint8Array([7]));
    await flush();
    fixture.mainPort.inject({
      type: 'ack',
      generation: 'room-generation-1',
      id: 1,
      accepted: true,
    });
    await flush();
    expect(fixture.failures).toEqual([]);

    fixture.worker.stopOutput();
    expect(() => fixture.worker.send('device-c', new Uint8Array([2]))).not.toThrow();
    fixture.device.emit('device-b', new Uint8Array([8]));
    await flush();
    expect(received).toEqual([7, 8]);
    fixture.worker.close();
    fixture.bridge.close();
  });

  test('main-thread output stop blocks only worker network sends and close detaches listeners', async () => {
    const fixture = bridgeFixture();
    const received: number[] = [];
    fixture.worker.onMessage((_peer, bytes) => received.push(bytes[0] ?? 0));
    fixture.bridge.stopOutput();
    expect(() => fixture.worker.send('device-b', new Uint8Array([1]))).not.toThrow();
    await flush();
    expect(fixture.device.sent).toEqual([]);
    expect(fixture.failures).toEqual([]);

    fixture.bridge.close();
    fixture.worker.close();
    fixture.device.emit('device-b', new Uint8Array([2]));
    await flush();
    expect(received).toEqual([]);
  });

  test('listener failures are reported, while transient underlying send failures are dropped', async () => {
    const fixture = bridgeFixture();
    fixture.worker.onMessage(() => {
      throw new Error('protocol listener failed');
    });
    fixture.device.emit('device-b', new Uint8Array([1]));
    await flush();
    expect(fixture.failures[0]?.message).toContain('message listener failed');

    const sendFailure = bridgeFixture();
    sendFailure.device.failSend = true;
    sendFailure.worker.send('device-b', new Uint8Array([1]));
    await flush();
    expect(sendFailure.failures).toEqual([]);
    expect(sendFailure.device.sent).toEqual([]);
    sendFailure.worker.close();
    sendFailure.bridge.close();
    fixture.worker.close();
    fixture.bridge.close();
  });
});

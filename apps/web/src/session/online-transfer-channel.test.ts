import { canonicalDecode, canonicalEncode, toBase64Url } from '@cp2p/codec';
import type { Transport } from '@cp2p/protocol';
import { MAX_MESSAGE_BYTES } from '@cp2p/p2p';
import { createMemnet, VirtualClock } from '@cp2p/protocol/testing';
import { transferPrivateEnvelopeSchema } from '@cp2p/protocol';
import { parse } from 'valibot';
import { expect, test } from 'vitest';
import { OnlineTransferChannel } from './online-transfer-channel.js';
import type { OnlineTransferArtifact } from './online-transfer-channel.js';

const peers = [
  toBase64Url(new Uint8Array(32).fill(1)),
  toBase64Url(new Uint8Array(32).fill(2)),
] as const;
const scope = toBase64Url(new Uint8Array(32).fill(3));

function forward(transport: Transport): Transport {
  return {
    self: transport.self,
    peers: () => transport.peers(),
    send: (peer, bytes) => transport.send(peer, bytes),
    broadcast: (bytes) => transport.broadcast(bytes),
    disconnect: (peer) => transport.disconnect(peer),
    onMessage: (listener) => transport.onMessage(listener),
    onPeerChange: (listener) => transport.onPeerChange(listener),
  };
}

test('large public bootstrap is delivered in acknowledged chunks without sharing mutable bytes', async () => {
  const network = createMemnet({ peers });
  const received: OnlineTransferArtifact[] = [];
  const errors: Error[] = [];
  const [a, b] = peers;
  let outstanding = 0;
  let maximum = 0;
  const transport = network.transport(a);
  const counted: Transport = {
    ...forward(transport),
    send(peer, bytes) {
      outstanding += 1;
      maximum = Math.max(maximum, outstanding);
      transport.send(peer, bytes);
    },
    onMessage(listener) {
      return transport.onMessage((peer, bytes) => {
        outstanding -= 1;
        listener(peer, bytes);
      });
    },
  };
  const source = new OnlineTransferChannel({
    transport: counted,
    peer: b,
    scope,
    clock: network.clock,
    onArtifact: () => undefined,
    onError: (error) => errors.push(error),
  });
  const destination = new OnlineTransferChannel({
    transport: network.transport(b),
    peer: a,
    scope,
    clock: network.clock,
    onArtifact: (artifact) => received.push(artifact),
    onError: (error) => errors.push(error),
  });
  try {
    const bytes = Uint8Array.from({ length: 1_100_000 }, (_, index) => index % 251);
    const original = new Uint8Array(bytes);
    const sending = source.send({ kind: 'bootstrap', bytes });
    bytes.fill(0);
    await expect(source.send({ kind: 'offer', bytes: Uint8Array.of(1) })).rejects.toThrow(/busy/);
    for (let chunk = 0; chunk < 40; chunk += 1) {
      network.clock.advanceBy(1);
      // oxlint-disable-next-line no-await-in-loop -- Release each acknowledged sender continuation.
      await Promise.resolve();
    }
    expect(errors).toEqual([]);
    expect(received).toHaveLength(1);
    await sending;
    expect(maximum).toBe(1);
    expect(received).toEqual([{ kind: 'bootstrap', bytes: original }]);
    expect(errors).toEqual([]);
    await expect(source.send({ kind: 'private', bytes: new Uint8Array(65_537) })).rejects.toThrow(
      /limit/,
    );
  } finally {
    source.close();
    destination.close();
    network.dispose();
  }
});

test('missing acknowledgements time out and a separate scope cannot acknowledge delivery', async () => {
  const network = createMemnet({ peers });
  const errors: Error[] = [];
  const [a, b] = peers;
  const source = new OnlineTransferChannel({
    transport: network.transport(a),
    peer: b,
    scope,
    clock: network.clock,
    onArtifact: () => undefined,
    onError: (error) => errors.push(error),
  });
  const destination = new OnlineTransferChannel({
    transport: network.transport(b),
    peer: a,
    scope: toBase64Url(new Uint8Array(32).fill(4)),
    clock: network.clock,
    onArtifact: () => {
      throw new Error('Wrong scope delivered');
    },
    onError: (error) => errors.push(error),
  });
  try {
    const sending = source.send({ kind: 'offer', bytes: Uint8Array.of(1) });
    const rejected = sending.catch((error: unknown) => error);
    network.clock.advanceBy(30_000);
    expect(await rejected).toEqual(new Error('Transfer delivery timed out'));
    expect(errors).toHaveLength(1);
    await expect(source.send({ kind: 'offer', bytes: Uint8Array.of(1) })).rejects.toThrow(/closed/);
  } finally {
    source.close();
    destination.close();
    network.dispose();
  }
});

test('a transfer can exceed the former whole-artifact deadline while making chunk progress', async () => {
  const clock = new VirtualClock();
  const received: OnlineTransferArtifact[] = [];
  const errors: Error[] = [];
  const [a, b] = peers;
  const aListeners = new Set<(from: string, bytes: Uint8Array) => void>();
  const bListeners = new Set<(from: string, bytes: Uint8Array) => void>();
  const makeTransport = (
    self: string,
    remote: string,
    localListeners: Set<(from: string, bytes: Uint8Array) => void>,
    remoteListeners: Set<(from: string, bytes: Uint8Array) => void>,
    advanceAckClock: boolean,
  ): Transport => ({
    self,
    peers: () => [remote],
    send(_peer, bytes) {
      const frame: unknown = canonicalDecode(bytes.subarray(4));
      for (const listener of remoteListeners) listener(self, new Uint8Array(bytes));
      if (
        advanceAckClock &&
        typeof frame === 'object' &&
        frame !== null &&
        'type' in frame &&
        frame.type === 'ack'
      )
        clock.advanceBy(25_000);
    },
    broadcast(bytes) {
      this.send(remote, bytes);
    },
    onMessage(listener) {
      localListeners.add(listener);
      return () => localListeners.delete(listener);
    },
    onPeerChange: () => () => undefined,
    disconnect: () => undefined,
  });
  const transportA = makeTransport(a, b, aListeners, bListeners, false);
  const transportB = makeTransport(b, a, bListeners, aListeners, true);
  const source = new OnlineTransferChannel({
    transport: transportA,
    peer: b,
    scope,
    clock,
    onArtifact: () => undefined,
    onError: (error) => errors.push(error),
  });
  const destination = new OnlineTransferChannel({
    transport: transportB,
    peer: a,
    scope,
    clock,
    onArtifact: (artifact) => received.push(artifact),
    onError: (error) => errors.push(error),
  });
  try {
    const bytes = new Uint8Array(192 * 1024);
    const sending = source.send({ kind: 'bootstrap', bytes });
    const settled = sending.then(
      () => undefined,
      (error: unknown) => error,
    );
    for (let step = 0; step < 8; step += 1) {
      // oxlint-disable-next-line no-await-in-loop -- Let each synchronous acknowledgment schedule the next chunk.
      await Promise.resolve();
    }
    expect(clock.now()).toBeGreaterThan(120_000);
    expect(received).toHaveLength(1);
    expect(await settled).toBeUndefined();
    expect(errors).toEqual([]);
  } finally {
    source.close();
    destination.close();
  }
});

test('retries a lost first data frame and re-ACKs a lost final acknowledgment exactly once', async () => {
  const network = createMemnet({ peers });
  const received: OnlineTransferArtifact[] = [];
  const errors: Error[] = [];
  const [a, b] = peers;
  const sourceBase = network.transport(a);
  let droppedFirstData = false;
  const sourceTransport: Transport = {
    ...forward(sourceBase),
    send(peer, bytes) {
      const frame: unknown = canonicalDecode(bytes.subarray(4));
      if (
        !droppedFirstData &&
        typeof frame === 'object' &&
        frame !== null &&
        'type' in frame &&
        frame.type === 'data'
      ) {
        droppedFirstData = true;
        return;
      }
      sourceBase.send(peer, bytes);
    },
  };
  const destinationBase = network.transport(b);
  let droppedFinalAck = false;
  const destinationTransport: Transport = {
    ...forward(destinationBase),
    send(peer, bytes) {
      const frame: unknown = canonicalDecode(bytes.subarray(4));
      if (
        !droppedFinalAck &&
        typeof frame === 'object' &&
        frame !== null &&
        'type' in frame &&
        frame.type === 'ack' &&
        'index' in frame &&
        frame.index === 0
      ) {
        droppedFinalAck = true;
        return;
      }
      destinationBase.send(peer, bytes);
    },
  };
  const source = new OnlineTransferChannel({
    transport: sourceTransport,
    peer: b,
    scope,
    clock: network.clock,
    onArtifact: () => undefined,
    onError: (error) => errors.push(error),
  });
  const destination = new OnlineTransferChannel({
    transport: destinationTransport,
    peer: a,
    scope,
    clock: network.clock,
    onArtifact: (artifact) => received.push(artifact),
    onError: (error) => errors.push(error),
  });
  try {
    const sending = source.send({ kind: 'offer', bytes: Uint8Array.of(4, 5, 6) });
    network.clock.advanceBy(10_000);
    await Promise.resolve();
    await sending;
    expect(droppedFirstData).toBe(true);
    expect(droppedFinalAck).toBe(true);
    expect(received).toEqual([{ kind: 'offer', bytes: Uint8Array.of(4, 5, 6) }]);
    expect(errors).toEqual([]);
  } finally {
    source.close();
    destination.close();
    network.dispose();
  }
});

test('rejects an altered duplicate instead of extending progress or dispatching twice', async () => {
  const network = createMemnet({ peers });
  const received: OnlineTransferArtifact[] = [];
  const errors: Error[] = [];
  const [a, b] = peers;
  const sourceBase = network.transport(a);
  let dataSent = false;
  let dropAck = true;
  const sourceTransport: Transport = {
    ...forward(sourceBase),
    send(peer, bytes) {
      const frame: unknown = canonicalDecode(bytes.subarray(4));
      if (typeof frame === 'object' && frame !== null && 'type' in frame && frame.type === 'data') {
        if (dataSent && 'bytes' in frame && frame.bytes instanceof Uint8Array) {
          const firstByte = frame.bytes[0];
          if (firstByte !== undefined) frame.bytes[0] = firstByte ^ 1;
          const body = canonicalEncode(frame);
          const changed = new Uint8Array(4 + body.length);
          changed.set(bytes.subarray(0, 4));
          changed.set(body, 4);
          sourceBase.send(peer, changed);
          return;
        }
        dataSent = true;
      }
      sourceBase.send(peer, bytes);
    },
  };
  const destinationBase = network.transport(b);
  const destinationTransport: Transport = {
    ...forward(destinationBase),
    send(peer, bytes) {
      const frame: unknown = canonicalDecode(bytes.subarray(4));
      if (
        dropAck &&
        typeof frame === 'object' &&
        frame !== null &&
        'type' in frame &&
        frame.type === 'ack'
      ) {
        dropAck = false;
        return;
      }
      destinationBase.send(peer, bytes);
    },
  };
  const source = new OnlineTransferChannel({
    transport: sourceTransport,
    peer: b,
    scope,
    clock: network.clock,
    onArtifact: () => undefined,
    onError: (error) => errors.push(error),
  });
  const destination = new OnlineTransferChannel({
    transport: destinationTransport,
    peer: a,
    scope,
    clock: network.clock,
    onArtifact: (artifact) => received.push(artifact),
    onError: (error) => errors.push(error),
  });
  try {
    const sending = source.send({ kind: 'offer', bytes: Uint8Array.of(4, 5, 6) });
    const rejected = sending.catch((error: unknown) => error);
    network.clock.advanceBy(5_000);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/invalid transfer frame/i);
    expect(received).toEqual([{ kind: 'offer', bytes: Uint8Array.of(4, 5, 6) }]);
    source.close();
    await rejected;
  } finally {
    source.close();
    destination.close();
    network.dispose();
  }
});

test('encoded transfer frames remain below the WebRTC message limit', () => {
  const payload = new Uint8Array(32 * 1024);
  const body = canonicalEncode({
    type: 'data',
    scope,
    id: 1,
    index: 0,
    kind: 'bootstrap',
    length: 16 * 1024 * 1024,
    digest: '0'.repeat(64),
    bytes: payload,
  });
  expect(body.length + 4).toBeLessThan(MAX_MESSAGE_BYTES);
  const key = toBase64Url(new Uint8Array(32));
  const signature = toBase64Url(new Uint8Array(64));
  const privateEnvelope = parse(transferPrivateEnvelopeSchema, {
    protocol: 'seat-transfer-private-v1',
    genesisDigest: key,
    authorization: { seq: 1, hash: '0'.repeat(64) },
    sourceParent: { seq: 1, hash: '0'.repeat(64) },
    sourceSeat: 0,
    sourceSigner: { kind: 'current-controller', publicKey: key },
    destinationDevice: key,
    destinationGame: key,
    affectedSeats: [0],
    nonce: key,
    sealed: { ephemeral: key, ciphertext: 'x'.repeat(5_462) },
    ciphertextHash: '0'.repeat(64),
    sourceSig: signature,
  });
  expect(canonicalEncode(privateEnvelope).length).toBeLessThanOrEqual(8_192);
  expect(canonicalEncode(privateEnvelope).length).toBeLessThanOrEqual(64 * 1024);
});

test('tampered chunk data fails the digest check and never reaches its receiver', async () => {
  const network = createMemnet({ peers });
  const errors: Error[] = [];
  const received: OnlineTransferArtifact[] = [];
  const [a, b] = peers;
  const base = network.transport(a);
  const transport: Transport = {
    ...forward(base),
    send(peer, bytes) {
      const frame: unknown = canonicalDecode(bytes.subarray(4));
      if (
        typeof frame !== 'object' ||
        frame === null ||
        !('bytes' in frame) ||
        !(frame.bytes instanceof Uint8Array)
      )
        throw new Error('Missing chunk data');
      frame.bytes[0] = (frame.bytes[0] ?? 0) ^ 1;
      const body = canonicalEncode(frame);
      const changed = new Uint8Array(4 + body.length);
      changed.set(bytes.subarray(0, 4));
      changed.set(body, 4);
      base.send(peer, changed);
    },
  };
  const source = new OnlineTransferChannel({
    transport,
    peer: b,
    scope,
    clock: network.clock,
    onArtifact: () => undefined,
    onError: (error) => errors.push(error),
  });
  const destination = new OnlineTransferChannel({
    transport: network.transport(b),
    peer: a,
    scope,
    clock: network.clock,
    onArtifact: (artifact) => received.push(artifact),
    onError: (error) => errors.push(error),
  });
  try {
    const sending = source.send({ kind: 'offer', bytes: Uint8Array.of(1, 2, 3) });
    const rejected = sending.catch((error: unknown) => error);
    network.clock.advanceBy(0);
    expect(received).toEqual([]);
    expect(errors).toHaveLength(1);
    source.close();
    expect(await rejected).toEqual(new Error('Transfer channel closed'));
  } finally {
    source.close();
    destination.close();
    network.dispose();
  }
});

test('exhausting bounded channel ids closes the channel and notifies its reconnect owner', async () => {
  const network = createMemnet({ peers });
  const errors: Error[] = [];
  const [a, b] = peers;
  const source = new OnlineTransferChannel({
    transport: network.transport(a),
    peer: b,
    scope,
    clock: network.clock,
    onArtifact: () => undefined,
    onError: (error) => errors.push(error),
  });
  const destination = new OnlineTransferChannel({
    transport: network.transport(b),
    peer: a,
    scope,
    clock: network.clock,
    onArtifact: () => undefined,
    onError: () => undefined,
  });
  try {
    for (let id = 0; id < 64; id += 1) {
      const sending = source.send({ kind: 'offer', bytes: Uint8Array.of(id) });
      network.clock.advanceBy(0);
      // oxlint-disable-next-line no-await-in-loop -- Channel identifiers advance after the prior artifact has been acknowledged.
      await sending;
    }
    await expect(source.send({ kind: 'offer', bytes: Uint8Array.of(1) })).rejects.toThrow(
      'exchange limit',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('exchange limit');
    await expect(source.send({ kind: 'offer', bytes: Uint8Array.of(1) })).rejects.toThrow('closed');
  } finally {
    source.close();
    destination.close();
    network.dispose();
  }
});

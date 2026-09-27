import { identityFromSecret } from '@cp2p/crypto';
import { toBase64Url } from '@cp2p/codec';
import { describe, expect, test } from 'vitest';
import { PeerLink, applicationFingerprint } from './peer-link.js';
import { MessageFramer } from './framing.js';
import type { SignalBlob } from './signaling.js';
import { VirtualClock } from '../../protocol/src/testing/virtual-clock.js';

type Listener = (event: {
  data?: unknown;
  candidate?: { toJSON(): RTCIceCandidateInit } | null;
}) => void;

class FakeChannel {
  readonly listeners = new Map<string, Listener[]>();
  readonly sent: (string | ArrayBuffer)[] = [];
  peer: FakeChannel | null = null;
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = 'blob';
  constructor(
    readonly label: string,
    readonly id: number,
  ) {}
  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type: string, event: Parameters<Listener>[0] = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 'open') throw new Error('Channel closed');
    this.sent.push(data);
    if (data instanceof ArrayBuffer) this.bufferedAmount += data.byteLength;
    this.peer?.emit('message', { data });
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.emit('close');
  }
  low(): void {
    this.bufferedAmount = 0;
    this.emit('bufferedamountlow');
  }
}

function sdp(byte: string): string {
  return `v=0\r\na=group:BUNDLE data\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:data\r\na=fingerprint:sha-256 ${Array(32).fill(byte).join(':')}\r\na=sctp-port:5000\r\n`;
}

class GetterDescription {
  readonly #type: 'offer' | 'answer';
  readonly #sdp: string;
  constructor(type: 'offer' | 'answer', value: string) {
    this.#type = type;
    this.#sdp = value;
  }
  get type(): 'offer' | 'answer' {
    return this.#type;
  }
  get sdp(): string {
    return this.#sdp;
  }
}

class FakePc {
  readonly listeners = new Map<string, Listener[]>();
  readonly channels = new Map<number, FakeChannel>();
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'connected';
  localDescription: RTCSessionDescriptionInit | null;
  remoteDescription: RTCSessionDescriptionInit | null;
  currentLocalDescription: RTCSessionDescriptionInit | null;
  currentRemoteDescription: RTCSessionDescriptionInit | null;
  restarted = 0;
  throwOnRestart = false;
  failChannelId: number | null = null;
  throwOnGameClose = false;
  useGetterDescription = false;
  readonly candidates: (RTCIceCandidateInit | null)[] = [];
  private localGate: Promise<void> | null = null;
  private remoteGate: Promise<void> | null = null;
  rejectNextCandidate = false;
  constructor(local: string, remote: string) {
    this.currentLocalDescription = this.localDescription = { type: 'answer', sdp: local };
    this.currentRemoteDescription = this.remoteDescription = { type: 'offer', sdp: remote };
  }
  createDataChannel(label: string, options: RTCDataChannelInit): RTCDataChannel {
    if (options.id === this.failChannelId) {
      if (this.throwOnGameClose) {
        const game = this.channels.get(0);
        if (game)
          game.close = () => {
            throw new Error('game close failed');
          };
      }
      throw new Error('channel creation failed');
    }
    const channel = new FakeChannel(label, options.id ?? -1);
    this.channels.set(channel.id, channel);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test fake implements the DataChannel surface used by PeerLink.
    return channel as unknown as RTCDataChannel;
  }
  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({});
  }
  holdNextLocalDescription(): () => void {
    let release: (() => void) | undefined;
    this.localGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => release?.();
  }
  holdNextRemoteDescription(): () => void {
    let release: (() => void) | undefined;
    this.remoteGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => release?.();
  }
  async setLocalDescription(): Promise<void> {
    const gate = this.localGate;
    this.localGate = null;
    if (gate) await gate;
    if (this.signalingState === 'have-remote-offer') {
      this.localDescription = this.useGetterDescription
        ? new GetterDescription('answer', this.currentLocalDescription?.sdp ?? '')
        : { type: 'answer', sdp: this.currentLocalDescription?.sdp ?? '' };
      this.signalingState = 'stable';
    } else {
      this.localDescription = this.useGetterDescription
        ? new GetterDescription('offer', this.currentLocalDescription?.sdp ?? '')
        : { type: 'offer', sdp: this.currentLocalDescription?.sdp ?? '' };
      this.signalingState = 'have-local-offer';
    }
    this.emit('signalingstatechange');
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    const gate = this.remoteGate;
    this.remoteGate = null;
    if (gate) await gate;
    this.currentRemoteDescription = this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    this.emit('signalingstatechange');
  }
  async addIceCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    if (this.rejectNextCandidate) {
      this.rejectNextCandidate = false;
      throw new Error('Fake browser rejected one candidate');
    }
    this.candidates.push(candidate);
  }
  restartIce(): void {
    if (this.throwOnRestart) throw new Error('restart failed');
    this.restarted++;
  }
  close(): void {
    this.connectionState = 'closed';
  }
  channel(id: number): FakeChannel {
    const channel = this.channels.get(id);
    if (!channel) throw new Error('Missing fake channel');
    return channel;
  }
  rtc(): RTCPeerConnection {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test fake implements the PeerConnection surface used by PeerLink.
    return this as unknown as RTCPeerConnection;
  }
}

function pair(
  remoteForLeft = sdp('BB'),
  leftNonceByte = 3,
  rightSeed = 2,
  onLeftAuthenticated?: () => void,
  onLeftDown?: () => void,
  leftOfferMode: 'auto' | 'answer-only' = 'auto',
) {
  const leftKey = identityFromSecret(new Uint8Array(32).fill(1));
  const rightKey = identityFromSecret(new Uint8Array(32).fill(rightSeed));
  const leftPc = new FakePc(sdp('AA'), remoteForLeft);
  const rightPc = new FakePc(sdp('BB'), sdp('AA'));
  const clock = new VirtualClock();
  const leftMessages: Uint8Array[] = [];
  const rightMessages: Uint8Array[] = [];
  const leftDown: string[] = [];
  const rightDown: string[] = [];
  const leftSignals: SignalBlob[] = [];
  let leftUp = 0;
  let rightUp = 0;
  const left = new PeerLink({
    self: leftKey.peerId,
    peer: rightKey.peerId,
    secretKey: leftKey.secretKey,
    scope: 'test-lobby',
    generation: 1,
    offerMode: leftOfferMode,
    clock,
    rtcFactory: () => leftPc.rtc(),
    signal: (blob) => {
      leftSignals.push(blob);
    },
    randomBytes: (length) => new Uint8Array(length).fill(leftNonceByte),
    onMessage: (bytes) => leftMessages.push(bytes),
    onAuthenticated: () => {
      leftUp++;
      onLeftAuthenticated?.();
    },
    onDown: (reason) => {
      leftDown.push(reason);
      onLeftDown?.();
    },
  });
  const right = new PeerLink({
    self: rightKey.peerId,
    peer: leftKey.peerId,
    secretKey: rightKey.secretKey,
    scope: 'test-lobby',
    generation: 1,
    clock,
    rtcFactory: () => rightPc.rtc(),
    signal: () => undefined,
    randomBytes: (length) => new Uint8Array(length).fill(4),
    onMessage: (bytes) => rightMessages.push(bytes),
    onAuthenticated: () => {
      rightUp++;
    },
    onDown: (reason) => rightDown.push(reason),
  });
  for (const id of [0, 1]) {
    leftPc.channel(id).peer = rightPc.channel(id);
    rightPc.channel(id).peer = leftPc.channel(id);
    leftPc.channel(id).readyState = rightPc.channel(id).readyState = 'open';
  }
  return {
    left,
    right,
    leftPc,
    rightPc,
    clock,
    leftMessages,
    rightMessages,
    leftDown,
    rightDown,
    leftSignals,
    online: () => [leftUp, rightUp],
    open: () => {
      leftPc.channel(0).emit('open');
      rightPc.channel(0).emit('open');
    },
    close: () => {
      left.close();
      right.close();
    },
  };
}

describe('authenticated peer link', () => {
  test('binds both identities and current DTLS fingerprints before delivering data', () => {
    const f = pair();
    try {
      expect(() => f.left.send(new Uint8Array([1]))).toThrow(/authenticated/);
      f.open();
      expect(f.online()).toEqual([1, 1]);
      f.left.send(new Uint8Array([1, 2, 3]));
      expect(f.rightMessages).toEqual([new Uint8Array([1, 2, 3])]);
      expect(f.rightPc.channel(0).id).toBe(0);
      expect(f.rightPc.channel(1).id).toBe(1);
    } finally {
      f.close();
    }
  });

  test('a delayed earlier PONG keeps an authenticated link alive', () => {
    const f = pair();
    try {
      f.open();
      const rightGame = f.rightPc.channel(0);
      const originalSend = rightGame.send.bind(rightGame);
      let delayed: string | null = null;
      rightGame.send = (data) => {
        if (typeof data === 'string' && data.includes('"PONG"') && delayed === null) {
          delayed = data;
          return;
        }
        originalSend(data);
      };
      f.clock.advanceBy(4_000);
      expect(delayed).not.toBeNull();
      f.leftPc.channel(0).emit('message', { data: delayed });
      expect(f.left.isAuthenticated).toBe(true);
      expect(f.leftDown).toEqual([]);
    } finally {
      f.close();
    }
  });

  test('steady inbound game frames prevent false ping timeout without PONGs', () => {
    const f = pair();
    try {
      f.open();
      const rightGame = f.rightPc.channel(0);
      const originalSend = rightGame.send.bind(rightGame);
      rightGame.send = (data) => {
        if (typeof data === 'string' && (data.includes('"PONG"') || data.includes('"PING"')))
          return;
        originalSend(data);
      };
      for (let second = 0; second < 9; second++) {
        f.clock.advanceBy(1_000);
        f.right.send(new Uint8Array([second]));
      }
      expect(f.left.isAuthenticated).toBe(true);
      expect(f.leftDown).toEqual([]);
    } finally {
      f.close();
    }
  });

  test('a full game send cannot make the next PING fail on local backpressure', () => {
    const f = pair();
    try {
      f.open();
      const game = f.leftPc.channel(0);
      f.left.send(new Uint8Array(1_048_576));
      expect(game.bufferedAmount).toBeLessThanOrEqual(1_048_576);
      f.clock.advanceBy(2_000);
      expect(f.left.isAuthenticated).toBe(true);
      expect(f.leftDown).toEqual([]);
    } finally {
      f.close();
    }
  });

  test('bulk queued at local authentication waits for peer READY', () => {
    const payload = new Uint8Array([9, 8, 7]);
    const f = pair(sdp('BB'), 3, 2, () => f.left.send(payload, 'bulk'));
    try {
      f.open();
      expect(f.online()).toEqual([1, 1]);
      expect(f.rightMessages).toEqual([payload]);
      expect(f.leftDown).toEqual([]);
      expect(f.rightDown).toEqual([]);
    } finally {
      f.close();
    }
  });

  test('answer-only manual link waits for the remote offer', async () => {
    const f = pair(sdp('BB'), 3, 2, undefined, undefined, 'answer-only');
    try {
      f.leftPc.emit('negotiationneeded');
      await Promise.resolve();
      expect(f.leftSignals).toEqual([]);
      await f.left.receiveSignal({
        kind: 'description',
        generation: 1,
        revision: 1,
        description: { type: 'offer', sdp: sdp('BB') },
      });
      expect(f.leftSignals).toEqual([
        {
          kind: 'description',
          generation: 1,
          revision: 1,
          description: { type: 'answer', sdp: sdp('AA') },
        },
      ]);
    } finally {
      f.close();
    }
  });

  test('a rejected early ICE candidate cannot suppress the signed answer', async () => {
    const f = pair(sdp('BB'), 3, 2, undefined, undefined, 'answer-only');
    try {
      const release = f.leftPc.holdNextRemoteDescription();
      const offer = f.left.receiveSignal({
        kind: 'description',
        generation: 1,
        revision: 1,
        description: { type: 'offer', sdp: sdp('BB') },
      });
      await Promise.resolve();
      await f.left.receiveSignal({
        kind: 'candidate',
        generation: 1,
        revision: 1,
        candidate: { candidate: 'candidate:early' },
      });
      f.leftPc.rejectNextCandidate = true;
      release();
      await offer;
      expect(
        f.leftSignals.some(
          (signal) => signal.kind === 'description' && signal.description.type === 'answer',
        ),
      ).toBe(true);
      expect(f.leftDown).toEqual([]);
    } finally {
      f.close();
    }
  });

  test('native-style getter descriptions become plain signed signaling data', async () => {
    const f = pair();
    try {
      f.leftPc.useGetterDescription = true;
      f.leftPc.emit('negotiationneeded');
      await Promise.resolve();
      const signal = f.leftSignals[0];
      expect(signal?.kind).toBe('description');
      if (signal?.kind !== 'description') throw new Error('Missing offer');
      expect(Object.keys(signal.description)).toEqual(['type', 'sdp']);
      expect(signal.description).toEqual({ type: 'offer', sdp: sdp('AA') });
    } finally {
      f.close();
    }
  });

  test('malformed late signaling cannot close an authenticated link', async () => {
    const f = pair();
    try {
      f.open();
      await f.left.receiveSignal({
        kind: 'candidate',
        generation: 1,
        revision: 1,
        candidate: { candidate: 'x'.repeat(5_000) },
      });
      await f.left.receiveSignal({
        kind: 'description',
        generation: 1,
        revision: 2,
        description: { type: 'offer', sdp: sdp('CC') },
      });
      expect(f.left.isAuthenticated).toBe(true);
      expect(f.leftDown).toEqual([]);
    } finally {
      f.close();
    }
  });

  test('HELLO received during a local offer waits for stable SDP', () => {
    const f = pair();
    try {
      f.leftPc.signalingState = 'have-local-offer';
      f.open();
      expect(f.left.isAuthenticated).toBe(false);
      expect(f.leftDown).toEqual([]);
      f.leftPc.signalingState = 'stable';
      f.leftPc.emit('signalingstatechange');
      expect(f.online()).toEqual([1, 1]);
    } finally {
      f.close();
    }
  });

  test('a delayed HELLO is checked against our sent binding during later negotiation', () => {
    const f = pair();
    try {
      const channel = f.rightPc.channel(0);
      const originalSend = channel.send.bind(channel);
      let held: string | null = null;
      channel.send = (data) => {
        if (typeof data === 'string' && data.includes('"HELLO"')) {
          held = data;
          return;
        }
        originalSend(data);
      };
      f.open();
      expect(held).not.toBeNull();
      expect(f.left.isAuthenticated).toBe(false);
      f.leftPc.signalingState = 'have-local-offer';
      f.leftPc.channel(0).emit('message', { data: held });
      expect(f.leftDown).toEqual([]);
      expect(f.left.isAuthenticated).toBe(true);
      f.clock.advanceBy(2_000);
      expect(f.leftDown).toEqual([]);
      f.leftPc.signalingState = 'stable';
      f.leftPc.emit('signalingstatechange');
      expect(f.left.isAuthenticated).toBe(true);
    } finally {
      f.close();
    }
  });

  test('fingerprint ordering follows code units even when locale collation disagrees', () => {
    const first = identityFromSecret(new Uint8Array(32).fill(1)).peerId;
    const tenth = identityFromSecret(new Uint8Array(32).fill(10)).peerId;
    expect(Math.sign(first.localeCompare(tenth))).not.toBe(Math.sign(first < tenth ? -1 : 1));
    const f = pair(sdp('BB'), 3, 10);
    try {
      f.open();
      expect(f.online()).toEqual([1, 1]);
    } finally {
      f.close();
    }
  });

  test('accepts uppercase SHA-256 and distinguishes unsupported local fingerprint parsing', () => {
    const uppercase = pair(sdp('BB').replace('sha-256', 'SHA-256'));
    try {
      uppercase.open();
      expect(uppercase.online()).toEqual([1, 1]);
    } finally {
      uppercase.close();
    }
    const unsupported = pair(sdp('BB').replace('sha-256', 'sha-384'));
    try {
      unsupported.open();
      expect(unsupported.leftDown).toContain('fingerprint-unsupported');
      expect(unsupported.leftDown).not.toContain('hello-binding');
    } finally {
      unsupported.close();
    }
  });

  test('control ingress counts UTF-8 bytes, not JavaScript code units', () => {
    const f = pair();
    try {
      const encoded = JSON.stringify({ kind: 'HELLO_INIT', nonce: 'é'.repeat(1_100) });
      expect(encoded.length).toBeLessThan(2_048);
      expect(new TextEncoder().encode(encoded).byteLength).toBeGreaterThan(2_048);
      f.leftPc.channel(0).emit('message', { data: encoded });
      expect(f.leftDown).toContain('invalid-control');
    } finally {
      f.close();
    }
  });

  test('authenticated callback failure closes locally and partial construction cleans up', () => {
    const f = pair(
      sdp('BB'),
      3,
      2,
      () => {
        throw new Error('view failed');
      },
      () => {
        throw new Error('down observer failed');
      },
    );
    f.open();
    expect(f.left.isAuthenticated).toBe(false);
    expect(f.leftDown).toContain('local-authenticated-callback');
    expect(() => f.left.close()).not.toThrow();
    expect(f.leftPc.connectionState).toBe('closed');
    expect(f.leftPc.channel(1).readyState).toBe('closed');
    f.right.close();

    const local = identityFromSecret(new Uint8Array(32).fill(1));
    const remote = identityFromSecret(new Uint8Array(32).fill(2));
    const pc = new FakePc(sdp('AA'), sdp('BB'));
    pc.failChannelId = 1;
    pc.throwOnGameClose = true;
    expect(
      () =>
        new PeerLink({
          self: local.peerId,
          peer: remote.peerId,
          secretKey: local.secretKey,
          scope: 'test-lobby',
          generation: 1,
          clock: new VirtualClock(),
          rtcFactory: () => pc.rtc(),
          signal: () => undefined,
          onMessage: () => undefined,
          onAuthenticated: () => undefined,
          onDown: () => undefined,
          randomBytes: (length) => new Uint8Array(length).fill(3),
        }),
    ).toThrow(/channel creation failed/);
    expect(pc.connectionState).toBe('closed');
    expect(local.secretKey.some((byte) => byte !== 0)).toBe(true);
  });

  test('tampered remote fingerprint never authenticates', () => {
    const f = pair(sdp('CC'));
    try {
      f.open();
      expect(f.online()).toEqual([0, 0]);
      expect([...f.leftDown, ...f.rightDown]).toContain('hello-binding');
      expect(f.rightMessages).toEqual([]);
    } finally {
      f.close();
    }
  });

  test('backpressure resumes a bounded queued message and ICE disconnection restarts', () => {
    const f = pair();
    try {
      f.open();
      const channel = f.leftPc.channel(0);
      channel.bufferedAmount = 1_048_577;
      const prior = channel.sent.length;
      f.left.send(new Uint8Array(20_000).fill(9));
      expect(channel.sent).toHaveLength(prior);
      channel.low();
      expect(channel.sent.length).toBeGreaterThan(prior);
      expect(f.rightMessages).toEqual([new Uint8Array(20_000).fill(9)]);
      f.leftPc.connectionState = 'disconnected';
      f.leftPc.emit('connectionstatechange');
      f.clock.advanceBy(5_000);
      expect(f.leftPc.restarted).toBe(1);
    } finally {
      f.close();
    }
  });

  test('ICE restart failure closes the link and reports loss', () => {
    const f = pair();
    try {
      f.open();
      f.leftPc.throwOnRestart = true;
      f.leftPc.connectionState = 'disconnected';
      f.leftPc.emit('connectionstatechange');
      expect(() => f.clock.advanceBy(5_000)).not.toThrow();
      expect(f.leftDown).toContain('ice-restart');
      expect(f.left.isAuthenticated).toBe(false);
    } finally {
      f.close();
    }
  });

  test('a signed HELLO from an earlier connection cannot pass a fresh challenge', () => {
    const old = pair();
    old.open();
    const replay = old.rightPc
      .channel(0)
      .sent.find((sent) => typeof sent === 'string' && sent.includes('"HELLO"'));
    if (typeof replay !== 'string') throw new Error('Missing signed HELLO');
    old.close();
    const fresh = pair(sdp('BB'), 5);
    try {
      fresh.rightPc.channel(0).peer = null;
      fresh.open();
      fresh.leftPc.channel(0).emit('message', {
        data: JSON.stringify({
          kind: 'HELLO_INIT',
          nonce: toBase64Url(new Uint8Array(32).fill(4)),
        }),
      });
      fresh.leftPc.channel(0).emit('message', { data: replay });
      expect(fresh.left.isAuthenticated).toBe(false);
      expect(fresh.leftDown).toContain('hello-authentication');
    } finally {
      fresh.close();
    }
  });

  test('pre-auth data and queued-send overflow fail closed at their own boundaries', () => {
    const unauthenticated = pair();
    try {
      unauthenticated.leftPc.channel(0).emit('message', { data: new ArrayBuffer(8) });
      expect(unauthenticated.leftDown).toContain('preauth-data');
    } finally {
      unauthenticated.close();
    }
    const f = pair();
    try {
      f.open();
      f.leftPc.channel(0).bufferedAmount = 1_048_577;
      f.left.send(new Uint8Array(1_048_576));
      expect(() => f.left.send(new Uint8Array(1_048_576))).toThrow(/queue is full/);
      expect(f.left.isAuthenticated).toBe(true);
    } finally {
      f.close();
    }
  });

  test('reassembly expiry encountered by a received frame has its own diagnostic', () => {
    const f = pair();
    try {
      f.open();
      const frames = new MessageFramer().split(new Uint8Array(20_000));
      const first = frames[0];
      const second = frames[1];
      if (!first || !second) throw new Error('Missing split frame');
      f.clock.advanceBy(1_000);
      f.leftPc.channel(0).emit('message', { data: first.buffer });
      f.clock.advanceBy(30_001);
      f.leftPc.channel(0).emit('message', { data: second.buffer });
      expect(f.leftDown).toContain('reassembly-timeout');
    } finally {
      f.close();
    }
  });

  test('stable SDP fingerprint change closes an authenticated link', () => {
    const f = pair();
    try {
      f.open();
      f.leftPc.currentRemoteDescription = { type: 'answer', sdp: sdp('CC') };
      f.leftPc.emit('signalingstatechange');
      expect(f.left.isAuthenticated).toBe(false);
      expect(f.leftDown).toContain('fingerprint-changed');
    } finally {
      f.close();
    }
  });

  test('simultaneous offers make only the polite peer accept the collision', async () => {
    const f = pair();
    try {
      const releaseLeft = f.leftPc.holdNextLocalDescription();
      const releaseRight = f.rightPc.holdNextLocalDescription();
      f.leftPc.emit('negotiationneeded');
      f.rightPc.emit('negotiationneeded');
      const offerForLeft = { type: 'offer' as const, sdp: sdp('CC') };
      const offerForRight = { type: 'offer' as const, sdp: sdp('DD') };
      const receiving = Promise.all([
        f.left.receiveSignal({
          kind: 'description',
          generation: 1,
          revision: 1,
          description: offerForLeft,
        }),
        f.right.receiveSignal({
          kind: 'description',
          generation: 1,
          revision: 1,
          description: offerForRight,
        }),
      ]);
      releaseLeft();
      releaseRight();
      await receiving;
      const leftIsPolite =
        identityFromSecret(new Uint8Array(32).fill(1)).peerId <
        identityFromSecret(new Uint8Array(32).fill(2)).peerId;
      expect(f.leftPc.currentRemoteDescription?.sdp).toBe(leftIsPolite ? sdp('CC') : sdp('BB'));
      expect(f.rightPc.currentRemoteDescription?.sdp).toBe(leftIsPolite ? sdp('AA') : sdp('DD'));
    } finally {
      f.close();
    }
  });

  test('applied local offers resolve glare by stable signaling state', async () => {
    const f = pair();
    try {
      const leftId = identityFromSecret(new Uint8Array(32).fill(1)).peerId;
      const rightId = identityFromSecret(new Uint8Array(32).fill(2)).peerId;
      const politeLeft = leftId < rightId;
      const polite = politeLeft ? f.left : f.right;
      const impolite = politeLeft ? f.right : f.left;
      const politePc = politeLeft ? f.leftPc : f.rightPc;
      const impolitePc = politeLeft ? f.rightPc : f.leftPc;
      politePc.emit('negotiationneeded');
      impolitePc.emit('negotiationneeded');
      await Promise.resolve();
      expect(politePc.signalingState).toBe('have-local-offer');
      expect(impolitePc.signalingState).toBe('have-local-offer');
      await polite.receiveSignal({
        kind: 'description',
        generation: 1,
        revision: 1,
        description: { type: 'offer', sdp: politeLeft ? sdp('BB') : sdp('AA') },
      });
      await impolite.receiveSignal({
        kind: 'description',
        generation: 1,
        revision: 1,
        description: { type: 'offer', sdp: politeLeft ? sdp('AA') : sdp('BB') },
      });
      expect(politePc.signalingState).toBe('stable');
      expect(politePc.localDescription?.type).toBe('answer');
      expect(impolitePc.signalingState).toBe('have-local-offer');
      expect(impolitePc.localDescription?.type).toBe('offer');
    } finally {
      f.close();
    }
  });

  test('future ICE waits for its exact description; stale and foreign generations are ignored', async () => {
    const f = pair();
    try {
      const first = { candidate: 'candidate:first' };
      const second = { candidate: 'candidate:second' };
      await f.left.receiveSignal({
        kind: 'candidate',
        generation: 1,
        revision: 1,
        candidate: first,
      });
      expect(f.leftPc.candidates).toEqual([]);
      await f.left.receiveSignal({
        kind: 'description',
        generation: 1,
        revision: 1,
        description: { type: 'offer', sdp: sdp('BB') },
      });
      expect(f.leftPc.candidates).toEqual([first]);
      await f.left.receiveSignal({
        kind: 'candidate',
        generation: 1,
        revision: 2,
        candidate: second,
      });
      await f.left.receiveSignal({
        kind: 'candidate',
        generation: 2,
        revision: 2,
        candidate: { candidate: 'candidate:foreign' },
      });
      await f.left.receiveSignal({
        kind: 'description',
        generation: 1,
        revision: 2,
        description: { type: 'offer', sdp: sdp('BB') },
      });
      await f.left.receiveSignal({
        kind: 'candidate',
        generation: 1,
        revision: 1,
        candidate: { candidate: 'candidate:stale' },
      });
      expect(f.leftPc.candidates).toEqual([first, second]);
      expect(f.leftDown).toEqual([]);
    } finally {
      f.close();
    }
  });

  test('manual signaling wait does not consume the HELLO deadline', () => {
    const f = pair();
    try {
      f.clock.advanceBy(60_000);
      expect(f.leftDown).toEqual([]);
      f.rightPc.channel(0).peer = null;
      f.open();
      f.clock.advanceBy(10_000);
      expect(f.leftDown).toContain('hello-timeout');
    } finally {
      f.close();
    }
  });

  test('SDP parser uses the active application section and rejects ambiguity', () => {
    expect(applicationFingerprint(sdp('AA'))).toBe(`sha-256:${'aa'.repeat(32)}`);
    expect(() => applicationFingerprint(sdp('AA').replace('data', 'other'))).toThrow(/BUNDLE/);
    expect(() =>
      applicationFingerprint(sdp('AA') + 'm=application 9 UDP/DTLS/SCTP other\r\n'),
    ).toThrow(/data-only/);
  });
});

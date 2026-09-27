import { identityFromSecret } from '@cp2p/crypto';
import { toBase64Url } from '@cp2p/codec';
import type { PeerId } from '@cp2p/protocol';
import { describe, expect, test } from 'vitest';
import { InProcessSignaling } from './in-process-signaling.js';
import { signSignalEnvelope } from './signaling-envelope.js';
import type { SignedSignalEnvelope } from './signaling-envelope.js';
import { WebRtcTransport } from './web-rtc-transport.js';
import { VirtualClock } from '../../protocol/src/testing/virtual-clock.js';

type Listener = (event: {
  data?: unknown;
  candidate?: { toJSON(): RTCIceCandidateInit } | null;
}) => void;

class Channel {
  readonly listeners = new Map<string, Listener[]>();
  peer: Channel | null = null;
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = 'blob';
  constructor(readonly id: number) {}
  addEventListener(type: string, listener: Listener): void {
    const values = this.listeners.get(type) ?? [];
    values.push(listener);
    this.listeners.set(type, values);
  }
  emit(type: string, event: Parameters<Listener>[0] = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  send(value: string | ArrayBuffer): void {
    if (this.readyState !== 'open') throw new Error('Fake channel is closed');
    const copy = value instanceof ArrayBuffer ? value.slice(0) : value;
    queueMicrotask(() => this.peer?.emit('message', { data: copy }));
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.emit('close');
    this.peer?.close();
  }
  open(): void {
    this.readyState = 'open';
    this.emit('open');
  }
}

function sdp(peer: PeerId, tag?: number): string {
  const byte = peer.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase();
  return `v=0\r\na=group:BUNDLE data\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:data\r\na=fingerprint:sha-256 ${Array(32).fill(byte).join(':')}\r\na=sctp-port:5000\r\n${tag === undefined ? '' : `a=x-attempt:${tag}\r\n`}`;
}

function attemptTag(description: RTCSessionDescriptionInit | null): string | null {
  return /^a=x-attempt:(\d+)$/m.exec(description?.sdp ?? '')?.[1] ?? null;
}

class Connection {
  readonly listeners = new Map<string, Listener[]>();
  readonly channels = new Map<number, Channel>();
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'connected';
  localDescription: RTCSessionDescriptionInit | null;
  remoteDescription: RTCSessionDescriptionInit | null;
  currentLocalDescription: RTCSessionDescriptionInit | null;
  currentRemoteDescription: RTCSessionDescriptionInit | null;
  private remoteOffer = false;
  private localSet = false;
  private remoteSet = false;
  readonly candidates: (RTCIceCandidateInit | null)[] = [];
  constructor(
    readonly self: PeerId,
    readonly peer: PeerId,
    private readonly fabric: Fabric,
    private readonly tag: number,
  ) {
    this.currentLocalDescription = this.localDescription = { type: 'offer', sdp: sdp(self) };
    this.currentRemoteDescription = this.remoteDescription = { type: 'answer', sdp: sdp(peer) };
  }
  createDataChannel(_name: string, options: RTCDataChannelInit): RTCDataChannel {
    const channel = new Channel(options.id ?? -1);
    this.channels.set(channel.id, channel);
    this.fabric.wire(this.self, this.peer);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test fake implements PeerLink's RTC channel surface.
    return channel as unknown as RTCDataChannel;
  }
  addEventListener(type: string, listener: Listener): void {
    const values = this.listeners.get(type) ?? [];
    values.push(listener);
    this.listeners.set(type, values);
  }
  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({});
  }
  async setLocalDescription(): Promise<void> {
    this.currentLocalDescription = this.localDescription = {
      type: this.remoteOffer ? 'answer' : 'offer',
      sdp: sdp(
        this.self,
        this.remoteOffer ? Number(attemptTag(this.currentRemoteDescription)) : this.tag,
      ),
    };
    this.signalingState = this.remoteOffer ? 'stable' : 'have-local-offer';
    this.localSet = true;
    this.emit('signalingstatechange');
    this.fabric.wire(this.self, this.peer);
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteOffer = description.type === 'offer';
    this.currentRemoteDescription = this.remoteDescription = this.fabric.tamperRemoteFingerprint
      ? { ...description, sdp: sdp('CC', Number(attemptTag(description))) }
      : description;
    this.signalingState = this.remoteOffer ? 'have-remote-offer' : 'stable';
    this.remoteSet = true;
    this.emit('signalingstatechange');
    this.fabric.wire(this.self, this.peer);
  }
  async addIceCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    this.candidates.push(candidate);
  }
  restartIce(): void {
    this.emit('negotiationneeded');
  }
  close(): void {
    if (this.connectionState === 'closed') return;
    this.connectionState = 'closed';
    for (const channel of this.channels.values()) channel.close();
  }
  rtc(): RTCPeerConnection {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test fake implements PeerLink's RTC connection surface.
    return this as unknown as RTCPeerConnection;
  }
  get negotiated(): boolean {
    return this.localSet && this.remoteSet;
  }
  get negotiationTag(): string | null {
    return attemptTag(this.currentLocalDescription);
  }
}

class Fabric {
  private readonly connections = new Map<string, Connection>();
  private nextTag = 1;
  tamperRemoteFingerprint = false;
  create(self: PeerId, peer: PeerId): RTCPeerConnection {
    const pc = new Connection(self, peer, this, this.nextTag++);
    this.connections.set(`${self}/${peer}`, pc);
    queueMicrotask(() => pc.emit('negotiationneeded'));
    return pc.rtc();
  }
  close(self: PeerId, peer: PeerId): void {
    this.connections.get(`${self}/${peer}`)?.close();
    this.connections.get(`${peer}/${self}`)?.close();
  }
  failOneSide(self: PeerId, peer: PeerId): void {
    const pc = this.connections.get(`${self}/${peer}`);
    if (!pc) throw new Error('Missing fake connection');
    for (const channel of pc.channels.values()) channel.peer = null;
    pc.connectionState = 'failed';
    pc.emit('connectionstatechange');
  }
  connection(self: PeerId, peer: PeerId): Connection | undefined {
    return this.connections.get(`${self}/${peer}`);
  }
  wire(self: PeerId, peer: PeerId): void {
    const left = this.connections.get(`${self}/${peer}`);
    const right = this.connections.get(`${peer}/${self}`);
    if (
      !left ||
      !right ||
      !left.negotiated ||
      !right.negotiated ||
      !left.negotiationTag ||
      left.negotiationTag !== right.negotiationTag ||
      left.connectionState === 'closed' ||
      right.connectionState === 'closed'
    )
      return;
    for (const id of [0, 1]) {
      const a = left.channels.get(id);
      const b = right.channels.get(id);
      if (!a || !b || a.peer || b.peer) continue;
      a.peer = b;
      b.peer = a;
      if (id === 1)
        queueMicrotask(() => {
          for (const channel of [
            left.channels.get(0),
            left.channels.get(1),
            right.channels.get(0),
            right.channels.get(1),
          ])
            channel?.open();
        });
    }
  }
}

async function settle(): Promise<void> {
  // oxlint-disable-next-line no-await-in-loop -- each turn drains the next signaling microtask.
  for (let index = 0; index < 30; index++) await Promise.resolve();
}

function member<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing test mesh member ${index}`);
  return value;
}

function mesh(count: number, descendingIds = false, manualDeadline = false) {
  const identities = Array.from({ length: count }, (_, index) =>
    identityFromSecret(new Uint8Array(32).fill(index + 1)),
  );
  const roster = identities.map((identity) => identity.peerId);
  const signaling = new InProcessSignaling();
  const fabric = new Fabric();
  const clock = new VirtualClock();
  const adapters = identities.map((identity) => signaling.adapter(identity.peerId));
  const peers = identities.map((identity, index) => {
    let nextRandom = index + 1;
    return new WebRtcTransport({
      self: identity.peerId,
      secretKey: identity.secretKey,
      roster,
      scope: 'test-lobby',
      adapter: member(adapters, index),
      clock,
      ...(manualDeadline ? { attemptTimeoutMs: null } : {}),
      rtcFactory: (peer) => fabric.create(identity.peerId, peer),
      randomBytes: (length) =>
        new Uint8Array(length).fill(descendingIds ? 255 - nextRandom++ : nextRandom++),
    });
  });
  return {
    identities,
    roster,
    signaling,
    adapters,
    fabric,
    clock,
    peers,
    dispose: () => {
      for (const peer of peers) peer.dispose();
      signaling.dispose();
    },
  };
}

describe('authenticated WebRTC mesh', () => {
  test('four peers form six links and deliver only authenticated Transport bytes', async () => {
    const f = mesh(4);
    try {
      const changes: [PeerId, boolean][] = [];
      const received: [PeerId, Uint8Array][] = [];
      member(f.peers, 0).onPeerChange((peer, online) => changes.push([peer, online]));
      member(f.peers, 3).onMessage((from, bytes) => received.push([from, bytes]));
      expect(() => member(f.peers, 0).send(member(f.roster, 3), new Uint8Array([1]))).toThrow(
        'Peer is not authenticated',
      );
      for (let left = 0; left < 4; left++)
        for (let right = left + 1; right < 4; right++) {
          member(f.peers, left).connect(member(f.roster, right));
          // oxlint-disable-next-line no-await-in-loop -- each pair authenticates before the next is opened.
          await settle();
        }
      expect(f.peers.map((peer) => peer.peers().length)).toEqual([3, 3, 3, 3]);
      expect(changes).toHaveLength(3);
      member(f.peers, 0).send(member(f.roster, 3), new Uint8Array([7, 8]));
      await settle();
      expect(received).toEqual([[f.roster[0], new Uint8Array([7, 8])]]);
    } finally {
      f.dispose();
    }
  });

  test('manual disconnect emits one down event and blocks stale replay', async () => {
    const f = mesh(2);
    try {
      const events: boolean[] = [];
      member(f.peers, 0).onPeerChange((_peer, online) => events.push(online));
      member(f.peers, 0).connect(member(f.roster, 1));
      await settle();
      expect(events).toEqual([true]);
      member(f.peers, 0).disconnect(member(f.roster, 1));
      expect(events).toEqual([true, false]);
      expect(member(f.peers, 0).peers()).toEqual([]);
      expect(() => member(f.peers, 0).send(member(f.roster, 1), new Uint8Array([1]))).toThrow(
        'Peer is not authenticated',
      );
      f.clock.advanceBy(5_000);
      expect(events).toEqual([true, false]);
    } finally {
      f.dispose();
    }
  });

  test('canonical initiator reconnects a lost pair once', async () => {
    const f = mesh(2);
    try {
      const events: boolean[] = [];
      member(f.peers, 0).onPeerChange((_peer, online) => events.push(online));
      for (const peer of f.peers) peer.start();
      await settle();
      expect(events).toEqual([true]);
      expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1]);

      f.fabric.close(member(f.roster, 0), member(f.roster, 1));
      await settle();
      expect(events).toEqual([true, false]);
      f.clock.advanceBy(250);
      await settle();
      expect(events).toEqual([true, false, true]);
      expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1]);
    } finally {
      f.dispose();
    }
  });

  test.each([false, true])(
    'a fresh attempt replaces a stale unanswered offer with descending IDs=%s',
    async (descendingIds) => {
      const f = mesh(2, descendingIds);
      try {
        const initiator = member(f.roster, 0) < member(f.roster, 1) ? 0 : 1;
        const responder = 1 - initiator;
        let firstAttempt: string | null = null;
        f.signaling.setDrop((_from, _to, envelope) => {
          if (
            envelope.body.blob.kind === 'description' &&
            envelope.body.blob.description.type === 'offer'
          )
            firstAttempt ??= envelope.body.attemptId;
          return (
            envelope.body.blob.kind === 'description' &&
            envelope.body.blob.description.type === 'answer' &&
            envelope.body.attemptId === firstAttempt
          );
        });
        for (const peer of f.peers) peer.start();
        await settle();
        expect(f.peers.map((peer) => peer.peers().length)).toEqual([0, 0]);
        f.fabric.failOneSide(member(f.roster, initiator), member(f.roster, responder));
        f.clock.advanceBy(250);
        await settle();
        expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1]);
      } finally {
        f.dispose();
      }
    },
  );

  test('a signed offer replay from an unseen old session cannot retire an authenticated primary', async () => {
    const f = mesh(2);
    try {
      const initiator = member(f.roster, 0) < member(f.roster, 1) ? 0 : 1;
      const responder = 1 - initiator;
      const oldOffers: SignedSignalEnvelope[] = [];
      const throwaway = new WebRtcTransport({
        self: member(f.roster, initiator),
        secretKey: member(f.identities, initiator).secretKey,
        roster: f.roster,
        scope: 'test-lobby',
        clock: f.clock,
        adapter: {
          send: async (_to, envelope) => {
            oldOffers.push(envelope);
          },
          onSignal: () => () => undefined,
          close: () => undefined,
        },
        rtcFactory: (peer) => f.fabric.create(member(f.roster, initiator), peer),
        randomBytes: (length) => new Uint8Array(length).fill(47),
      });
      throwaway.connect(member(f.roster, responder));
      await settle();
      throwaway.dispose();
      const replay = oldOffers.find(
        (offer) =>
          offer.body.blob.kind === 'description' && offer.body.blob.description.type === 'offer',
      );
      if (!replay) throw new Error('Missing old signed offer');
      const events: boolean[] = [];
      const delivered: Uint8Array[] = [];
      member(f.peers, responder).onPeerChange((_peer, online) => events.push(online));
      member(f.peers, responder).onMessage((_peer, bytes) => delivered.push(bytes));
      for (const peer of f.peers) peer.start();
      await settle();
      expect(events).toEqual([true]);
      await member(f.adapters, initiator).send(member(f.roster, responder), replay);
      await settle();
      expect(events).toEqual([true]);
      expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1]);
      member(f.peers, initiator).send(member(f.roster, responder), new Uint8Array([7]));
      await settle();
      expect(delivered).toEqual([new Uint8Array([7])]);
      for (let tick = 0; tick < 15; tick++) {
        f.clock.advanceBy(2_000);
        // oxlint-disable-next-line no-await-in-loop -- deliver the next fake heartbeat before advancing virtual time.
        await settle();
      }
      expect(events).toEqual([true]);
      expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1]);
    } finally {
      f.dispose();
    }
  });

  test('the newest same-session offer inside the replacement interval is deferred, then applied', async () => {
    const f = mesh(2);
    try {
      const initiator = member(f.roster, 0) < member(f.roster, 1) ? 0 : 1;
      const responder = 1 - initiator;
      for (const peer of f.peers) peer.start();
      await settle();
      const makeOffer = (seq: number) =>
        signSignalEnvelope(
          {
            version: 1,
            scope: 'test-lobby',
            from: member(f.roster, initiator),
            to: member(f.roster, responder),
            attemptId: toBase64Url(new Uint8Array(16).fill(70 + seq)),
            sessionId: toBase64Url(new Uint8Array(16).fill(70)),
            attemptSeq: seq,
            blob: {
              kind: 'description',
              generation: 1,
              revision: 1,
              description: { type: 'offer', sdp: sdp(member(f.roster, initiator), 900 + seq) },
            },
          },
          member(f.identities, initiator).secretKey,
        );
      await member(f.adapters, initiator).send(member(f.roster, responder), makeOffer(1));
      await settle();
      const first = f.fabric.connection(member(f.roster, responder), member(f.roster, initiator));
      f.clock.advanceBy(100);
      await member(f.adapters, initiator).send(member(f.roster, responder), makeOffer(2));
      f.clock.advanceBy(20);
      await member(f.adapters, initiator).send(member(f.roster, responder), makeOffer(3));
      await settle();
      expect(f.fabric.connection(member(f.roster, responder), member(f.roster, initiator))).toBe(
        first,
      );
      f.clock.advanceBy(130);
      await settle();
      const applied = f.fabric.connection(member(f.roster, responder), member(f.roster, initiator));
      expect(applied).not.toBe(first);
      expect(applied?.currentRemoteDescription?.sdp).toContain('a=x-attempt:903');
      expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1]);
    } finally {
      f.dispose();
    }
  });

  test('wrong socket hint, lower sequence and retired attempt cannot replace a live link', async () => {
    const f = mesh(2);
    try {
      const initiator = member(f.roster, 0) < member(f.roster, 1) ? 0 : 1;
      const responder = 1 - initiator;
      const offers: SignedSignalEnvelope[] = [];
      f.signaling.setDrop((_from, _to, envelope) => {
        if (
          envelope.body.blob.kind === 'description' &&
          envelope.body.blob.description.type === 'offer'
        )
          offers.push(envelope);
        return false;
      });
      for (const peer of f.peers) peer.start();
      await settle();
      const first = offers[0];
      if (!first) throw new Error('Missing first offer');
      f.fabric.close(member(f.roster, initiator), member(f.roster, responder));
      f.clock.advanceBy(250);
      await settle();
      const current = f.fabric.connection(member(f.roster, responder), member(f.roster, initiator));
      const sign = (body: typeof first.body) =>
        signSignalEnvelope(body, member(f.identities, initiator).secretKey);
      const wrongHint = sign({
        ...first.body,
        sessionId: toBase64Url(new Uint8Array(16).fill(90)),
        attemptId: toBase64Url(new Uint8Array(16).fill(91)),
        attemptSeq: 1,
      });
      await member(f.adapters, responder).send(member(f.roster, responder), wrongHint);
      const lowerSeq = sign({ ...first.body, attemptId: toBase64Url(new Uint8Array(16).fill(92)) });
      await member(f.adapters, initiator).send(member(f.roster, responder), lowerSeq);
      const retiredId = sign({ ...first.body, attemptSeq: 3 });
      await member(f.adapters, initiator).send(member(f.roster, responder), retiredId);
      await settle();
      expect(f.fabric.connection(member(f.roster, responder), member(f.roster, initiator))).toBe(
        current,
      );
      expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1]);
    } finally {
      f.dispose();
    }
  });

  test('one-sided connection failure replaces a still-authenticated remote link', async () => {
    const f = mesh(2);
    try {
      const initiator = member(f.roster, 0) < member(f.roster, 1) ? 0 : 1;
      const responder = 1 - initiator;
      const left: boolean[] = [];
      const right: boolean[] = [];
      member(f.peers, initiator).onPeerChange((_peer, online) => left.push(online));
      member(f.peers, responder).onPeerChange((_peer, online) => right.push(online));
      for (const peer of f.peers) peer.start();
      await settle();
      expect(left).toEqual([true]);
      expect(right).toEqual([true]);
      f.fabric.failOneSide(member(f.roster, initiator), member(f.roster, responder));
      expect(left).toEqual([true, false]);
      expect(right).toEqual([true]);
      f.clock.advanceBy(250);
      await settle();
      expect(left).toEqual([true, false, true]);
      expect(right).toEqual([true, false, true]);
    } finally {
      f.dispose();
    }
  });

  test('disconnect from the replacement down observer cannot resurrect its pending link', async () => {
    const f = mesh(2);
    try {
      const initiator = member(f.roster, 0) < member(f.roster, 1) ? 0 : 1;
      const responder = 1 - initiator;
      const events: boolean[] = [];
      member(f.peers, responder).onPeerChange((peer, online) => {
        events.push(online);
        if (!online) member(f.peers, responder).disconnect(peer);
      });
      for (const peer of f.peers) peer.start();
      await settle();
      expect(events).toEqual([true]);
      f.fabric.failOneSide(member(f.roster, initiator), member(f.roster, responder));
      f.clock.advanceBy(250);
      await settle();
      expect(events).toEqual([true, false]);
      expect(member(f.peers, responder).peers()).toEqual([]);
      expect(() =>
        member(f.peers, responder).send(member(f.roster, initiator), new Uint8Array([1])),
      ).toThrow('Peer is not authenticated');
    } finally {
      f.dispose();
    }
  });

  test('responder-only failure is noticed by initiator heartbeat and reconnects', async () => {
    const f = mesh(2);
    try {
      const initiator = member(f.roster, 0) < member(f.roster, 1) ? 0 : 1;
      const responder = 1 - initiator;
      const events: boolean[] = [];
      member(f.peers, initiator).onPeerChange((_peer, online) => events.push(online));
      for (const peer of f.peers) peer.start();
      await settle();
      expect(events).toEqual([true]);
      f.fabric.failOneSide(member(f.roster, responder), member(f.roster, initiator));
      for (let tick = 0; tick < 4 && events.length === 1; tick++) {
        f.clock.advanceBy(2_000);
        // oxlint-disable-next-line no-await-in-loop -- model one heartbeat period at a time.
        await settle();
      }
      expect(events).toEqual([true, false]);
      f.clock.advanceBy(250);
      await settle();
      expect(events).toEqual([true, false, true]);
    } finally {
      f.dispose();
    }
  });

  test('verified candidates before their offer use one bounded early queue', async () => {
    const f = mesh(2);
    try {
      const initiator = member(f.roster, 0) < member(f.roster, 1) ? 0 : 1;
      const responder = 1 - initiator;
      const offers: SignedSignalEnvelope[] = [];
      f.signaling.setDrop((_from, _to, envelope) => {
        if (
          envelope.body.blob.kind === 'description' &&
          envelope.body.blob.description.type === 'offer'
        ) {
          offers.push(envelope);
          return true;
        }
        return false;
      });
      member(f.peers, initiator).connect(member(f.roster, responder));
      await settle();
      const offer = offers[0];
      if (!offer) throw new Error('Missing signed offer');
      const body = offer.body;
      for (let index = 0; index < 12; index++) {
        const candidate = signSignalEnvelope(
          {
            ...body,
            blob: {
              kind: 'candidate',
              generation: body.blob.generation,
              revision: 1,
              candidate: { candidate: `candidate:${index}`, sdpMid: 'data' },
            },
          },
          member(f.identities, initiator).secretKey,
        );
        // oxlint-disable-next-line no-await-in-loop -- preserve candidate arrival order.
        await member(f.adapters, initiator).send(member(f.roster, responder), candidate);
      }
      f.signaling.setDrop(null);
      await member(f.adapters, initiator).send(member(f.roster, responder), offer);
      await settle();
      expect(
        f.fabric.connection(member(f.roster, responder), member(f.roster, initiator))?.candidates,
      ).toHaveLength(8);
      expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1]);
    } finally {
      f.dispose();
    }
  });

  test('an unopened default attempt times out and retries without relying on peer clocks', async () => {
    const f = mesh(2);
    try {
      let blocked = true;
      f.signaling.setDrop(
        (_from, _to, envelope) =>
          blocked &&
          envelope.body.blob.kind === 'description' &&
          envelope.body.blob.description.type === 'offer',
      );
      for (const peer of f.peers) peer.start();
      await settle();
      expect(f.peers.map((peer) => peer.peers().length)).toEqual([0, 0]);
      blocked = false;
      f.clock.advanceBy(30_000);
      f.clock.advanceBy(250);
      await settle();
      expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1]);
    } finally {
      f.dispose();
    }
  });

  test('manual deadline remains finite and symmetric for initiator and answerer', async () => {
    const f = mesh(2, false, true);
    try {
      const reasons: string[] = [];
      for (const peer of f.peers) peer.onDiagnostic((_remote, reason) => reasons.push(reason));
      f.signaling.setDrop(
        (_from, _to, envelope) =>
          envelope.body.blob.kind === 'description' &&
          envelope.body.blob.description.type === 'answer',
      );
      for (const peer of f.peers) peer.start();
      await settle();
      f.clock.advanceBy(30_000);
      expect(reasons).toEqual([]);
      f.clock.advanceBy(270_000);
      expect(reasons).toEqual(['attempt-timeout', 'attempt-timeout']);
    } finally {
      f.dispose();
    }
  });

  test('two-sided fingerprint substitution reports a security failure without redial', async () => {
    const f = mesh(2);
    try {
      f.fabric.tamperRemoteFingerprint = true;
      const diagnostics: { reason: string; security: boolean }[] = [];
      for (const peer of f.peers)
        peer.onDiagnostic((_remote, reason, security) => diagnostics.push({ reason, security }));
      for (const peer of f.peers) peer.start();
      await settle();
      expect(diagnostics).toContainEqual({ reason: 'hello-binding', security: true });
      expect(f.peers.map((peer) => peer.peers().length)).toEqual([0, 0]);
      const count = diagnostics.length;
      f.clock.advanceBy(10_000);
      await settle();
      expect(diagnostics).toHaveLength(count);
    } finally {
      f.dispose();
    }
  });
});

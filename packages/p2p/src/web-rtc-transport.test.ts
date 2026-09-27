import { identityFromSecret } from '@cp2p/crypto';
import { canonicalEncode, toBase64Url } from '@cp2p/codec';
import type { PeerId } from '@cp2p/protocol';
import { describe, expect, test } from 'vitest';
import { InProcessSignaling } from './in-process-signaling.js';
import { ManualBridge } from './manual-bootstrap.js';
import { MeshRelaySignalingAdapter } from './mesh-relay-signaling.js';
import { signSignalEnvelope, verifySignalEnvelope } from './signaling-envelope.js';
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
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((value) => value !== listener),
    );
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
  statsRecords: readonly Readonly<Record<string, unknown>>[] = [];
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
  async getStats(): Promise<RTCStatsReport> {
    const report = new Map(
      this.statsRecords.map((record, index) => [
        typeof record.id === 'string' || typeof record.id === 'number'
          ? String(record.id)
          : String(index),
        record,
      ]),
    );
    return report;
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

function mesh(
  count: number,
  descendingIds = false,
  manualDeadline = false,
  selfOnly = false,
  relay = false,
  tamperDescriptions = false,
) {
  const identities = Array.from({ length: count }, (_, index) =>
    identityFromSecret(new Uint8Array(32).fill(index + 1)),
  );
  const roster = identities.map((identity) => identity.peerId);
  const signaling = new InProcessSignaling();
  const fabric = new Fabric();
  const clock = new VirtualClock();
  let tamperedDescriptions = 0;
  const adapters = identities.map((identity) => {
    const adapter = signaling.adapter(identity.peerId);
    if (!tamperDescriptions) return adapter;
    return {
      async send(to: PeerId, value: SignedSignalEnvelope): Promise<void> {
        if (value.body.blob.kind !== 'description') return adapter.send(to, value);
        tamperedDescriptions++;
        const description = value.body.blob.description;
        const fakeFingerprint = `a=fingerprint:sha-256 ${Array(32).fill('CC').join(':')}`;
        const forged: SignedSignalEnvelope = {
          ...value,
          body: {
            ...value.body,
            blob: {
              ...value.body.blob,
              description: {
                ...description,
                sdp: (description.sdp ?? '').replace(/a=fingerprint:[^\r\n]+/, fakeFingerprint),
              },
            },
          },
        };
        await adapter.send(to, forged);
      },
      onSignal: (listener: (from: PeerId, value: unknown) => void) => adapter.onSignal(listener),
      close: () => adapter.close(),
    };
  });
  const relayAdapters = relay
    ? identities.map(
        (identity, index) =>
          new MeshRelaySignalingAdapter(
            identity.peerId,
            'test-lobby',
            clock,
            member(adapters, index),
          ),
      )
    : [];
  const peers = identities.map((identity, index) => {
    let nextRandom = index + 1;
    return new WebRtcTransport({
      self: identity.peerId,
      secretKey: identity.secretKey,
      roster: selfOnly ? [identity.peerId] : roster,
      scope: 'test-lobby',
      adapter: relay ? member(relayAdapters, index) : member(adapters, index),
      clock,
      ...(manualDeadline ? { attemptTimeoutMs: null } : {}),
      rtcFactory: (peer) => fabric.create(identity.peerId, peer),
      randomBytes: (length) =>
        new Uint8Array(length).fill(descendingIds ? 255 - nextRandom++ : nextRandom++),
    });
  });
  if (relay) peers.forEach((peer, index) => member(relayAdapters, index).attachTransport(peer));
  return {
    identities,
    roster,
    signaling,
    adapters,
    relayAdapters,
    tamperedDescriptions: () => tamperedDescriptions,
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
  test('exposes address-free selected route and RTT only for authenticated peers', async () => {
    const f = mesh(3);
    try {
      const [a, b, c] = f.roster;
      if (!a || !b || !c) throw new Error('Missing stats test peers');
      const aTransport = member(f.peers, f.roster.indexOf(a));
      const bTransport = member(f.peers, f.roster.indexOf(b));
      const cTransport = member(f.peers, f.roster.indexOf(c));
      expect(await aTransport.peerStats()).toEqual([]);
      aTransport.connect(b);
      await settle();
      const connection = f.fabric.connection(a, b);
      if (!connection) throw new Error('Missing stats test connection');
      connection.statsRecords = [
        { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' },
        {
          id: 'pair',
          type: 'candidate-pair',
          localCandidateId: 'local',
          state: 'succeeded',
          nominated: true,
          currentRoundTripTime: 0.0426,
        },
        {
          id: 'local',
          type: 'local-candidate',
          candidateType: 'relay',
          address: '192.0.2.44',
          usernameFragment: 'private',
        },
      ];
      expect(await aTransport.peerStats()).toEqual([
        { peer: b, state: 'connected', route: 'relay', rttMs: 43 },
      ]);
      expect(await cTransport.peerStats()).toEqual([]);
      expect(await bTransport.peerStats()).toEqual([
        { peer: a, state: 'connected', route: 'unknown', rttMs: null },
      ]);
    } finally {
      f.dispose();
    }
  });

  test('returns unknown route and RTT when browser statistics fail', async () => {
    const f = mesh(2);
    try {
      const [a, b] = f.roster;
      if (!a || !b) throw new Error('Missing stats test peers');
      const transport = member(f.peers, f.roster.indexOf(a));
      transport.connect(b);
      await settle();
      const connection = f.fabric.connection(a, b);
      if (!connection) throw new Error('Missing stats test connection');
      connection.getStats = async () => {
        throw new Error('stats unavailable');
      };
      expect(await transport.peerStats()).toEqual([
        { peer: b, state: 'connected', route: 'unknown', rttMs: null },
      ]);
    } finally {
      f.dispose();
    }
  });

  test('signed in-mesh signaling forms the missing link after the server disappears', async () => {
    const f = mesh(3, false, false, false, true);
    try {
      const a = member(f.roster, 0);
      const b = member(f.roster, 1);
      const c = member(f.roster, 2);
      member(f.peers, a < b ? 0 : 1).connect(a < b ? b : a);
      await settle();
      member(f.peers, b < c ? 1 : 2).connect(b < c ? c : b);
      await settle();
      expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 2, 1]);
      for (const adapter of f.adapters) adapter.close();
      const leaked: Uint8Array[] = [];
      for (const peer of f.peers) peer.onMessage((_from, bytes) => leaked.push(bytes));
      member(f.peers, 0).connect(c);
      await settle();
      expect(f.peers.map((peer) => peer.peers().length)).toEqual([2, 2, 2]);
      expect(member(f.peers, 0).peers()).toContain(c);
      expect(member(f.peers, 2).peers()).toContain(a);
      expect(leaked).toEqual([]);
      const temporaryChannel = new Channel(2);
      temporaryChannel.open();
      const temporaryPc = new EventTarget();
      let closedBridgePc = false;
      Object.assign(temporaryPc, {
        close: () => {
          closedBridgePc = true;
        },
      });
      const bridge = new ManualBridge(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Route-only test PC.
        temporaryPc as unknown as RTCPeerConnection,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Route-only test channel.
        temporaryChannel as unknown as RTCDataChannel,
        'test-lobby',
        a,
        b,
        f.clock,
      );
      member(f.relayAdapters, 0).addBridge(bridge);
      expect(closedBridgePc).toBe(false);
      const routeProof = signSignalEnvelope(
        {
          version: 1,
          scope: 'test-lobby',
          from: b,
          to: a,
          attemptId: toBase64Url(new Uint8Array(16).fill(79)),
          sessionId: toBase64Url(new Uint8Array(16).fill(80)),
          attemptSeq: 1,
          blob: { kind: 'candidate', generation: 0, revision: 1, candidate: null },
        },
        member(f.identities, 1).secretKey,
      );
      const routePayload = canonicalEncode({ v: 1, hops: 1, envelope: routeProof });
      const routeFrame = new Uint8Array(5 + routePayload.length);
      routeFrame.set([0x48, 0x58, 0x52, 0x31, 0]);
      routeFrame.set(routePayload, 5);
      member(f.peers, 1).sendRelayFrame(c, routeFrame);
      await settle();
      expect(member(f.relayAdapters, 0).hasBridge(b)).toBe(false);
      expect(closedBridgePc).toBe(true);
      const received: SignedSignalEnvelope[] = [];
      member(f.relayAdapters, 2).onSignal((_from, value) => {
        const signed = verifySignalEnvelope(value, 'test-lobby', c, new Set([a]));
        if (signed) received.push(signed);
      });
      const signal = signSignalEnvelope(
        {
          version: 1,
          scope: 'test-lobby',
          from: a,
          to: c,
          attemptId: toBase64Url(new Uint8Array(16).fill(88)),
          sessionId: toBase64Url(new Uint8Array(16).fill(89)),
          attemptSeq: 1,
          blob: { kind: 'candidate', generation: 0, revision: 1, candidate: null },
        },
        member(f.identities, 0).secretKey,
      );
      await member(f.relayAdapters, 0).send(c, signal);
      await member(f.relayAdapters, 0).send(c, signal);
      await settle();
      expect(received).toEqual([signal]);
      await expect(
        member(f.relayAdapters, 0).send(c, {
          ...signal,
          sig: member(f.identities, 1).peerId,
        }),
      ).rejects.toThrow('Invalid local signal');
      expect(leaked).toEqual([]);
    } finally {
      f.dispose();
    }
  });

  test('a bounded relay holds an early signal until the target authenticates with the host', async () => {
    const f = mesh(3, false, false, false, true);
    try {
      const [a, b, c] = f.roster;
      if (!a || !b || !c) throw new Error('Missing relay test peer');
      member(f.peers, a < b ? 0 : 1).connect(a < b ? b : a);
      await settle();
      expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1, 0]);
      member(f.adapters, 0).close();
      member(f.peers, 0).connect(c);
      await settle();
      expect(member(f.peers, 0).peers()).not.toContain(c);
      member(f.peers, b < c ? 1 : 2).connect(b < c ? c : b);
      await settle();
      expect(f.peers.map((peer) => peer.peers().length)).toEqual([2, 2, 2]);
    } finally {
      f.dispose();
    }
  });
  test('can freeze a single-host game roster', () => {
    const f = mesh(2, false, false, true);
    try {
      const solo = member(f.peers, 0);
      const self = member(f.roster, 0);
      expect(solo.freezeRoster()).toEqual([self]);
      expect(() => solo.updatePreGameRoster(f.roster)).toThrow('frozen');
      expect(() => solo.connect(member(f.roster, 1))).toThrow('Unknown mesh peer');
    } finally {
      f.dispose();
    }
  });

  test('grows a one-peer lobby, preserves links, retires removed peers and freezes the roster', async () => {
    const f = mesh(3, false, false, true);
    try {
      const [a, b, c] = f.roster;
      if (!a || !b || !c) throw new Error('Missing test identity');
      expect(f.peers.map((peer) => peer.roster())).toEqual([[a], [b], [c]]);
      for (const peer of f.peers) peer.start();
      const initiator = a < b ? 0 : 1;
      const responder = 1 - initiator;
      const initiatorPeer = member(f.peers, initiator);
      const responderPeer = member(f.peers, responder);
      const initiatorId = member(f.roster, initiator);
      const responderId = member(f.roster, responder);
      const adapter = member(f.adapters, initiator);
      const originalSend = adapter.send.bind(adapter);
      const sent: SignedSignalEnvelope[] = [];
      adapter.send = async (to, envelope) => {
        sent.push(envelope);
        await originalSend(to, envelope);
      };
      responderPeer.updatePreGameRoster([a, b]);
      initiatorPeer.updatePreGameRoster([a, b]);
      await settle();
      expect([initiatorPeer.peers(), responderPeer.peers()]).toEqual([
        [responderId],
        [initiatorId],
      ]);
      const firstLink = f.fabric.connection(a, b);
      const oldOffer = sent.find(
        (item) =>
          item.body.blob.kind === 'description' && item.body.blob.description.type === 'offer',
      );
      if (!oldOffer) throw new Error('Missing first signed offer');

      initiatorPeer.updatePreGameRoster([initiatorId]);
      responderPeer.updatePreGameRoster([responderId]);
      expect(initiatorPeer.peers()).toEqual([]);
      expect(responderPeer.peers()).toEqual([]);
      expect(() => initiatorPeer.connect(responderId)).toThrow('Unknown mesh peer');
      responderPeer.updatePreGameRoster([a, b]);
      initiatorPeer.updatePreGameRoster([a, b]);
      await settle();
      const resumedLink = f.fabric.connection(a, b);
      expect(resumedLink).not.toBe(firstLink);
      await originalSend(responderId, oldOffer);
      await settle();
      expect(f.fabric.connection(a, b)).toBe(resumedLink);
      await settle();
      expect(initiatorPeer.peers()).toEqual([responderId]);
      expect(responderPeer.peers()).toEqual([initiatorId]);

      member(f.peers, 2).updatePreGameRoster([a, b, c]);
      member(f.peers, 0).updatePreGameRoster([a, b, c]);
      member(f.peers, 1).updatePreGameRoster([a, b, c]);
      await settle();
      expect(f.peers.map((peer) => peer.peers().length)).toEqual([2, 2, 2]);
      expect(f.fabric.connection(a, b)).not.toBe(firstLink);
      const retained = f.fabric.connection(a, b);
      member(f.peers, 0).updatePreGameRoster([a, b]);
      member(f.peers, 1).updatePreGameRoster([a, b]);
      member(f.peers, 2).updatePreGameRoster([c]);
      expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1, 0]);
      expect(f.fabric.connection(a, b)).toBe(retained);
      const selected = member(f.peers, 0).roster();
      Reflect.set(selected, 0, 'corrupted');
      expect(member(f.peers, 0).roster()).toEqual([a, b].toSorted());
      expect(() => member(f.peers, 0).updatePreGameRoster([a, a])).toThrow('Invalid');
      expect(() => member(f.peers, 0).updatePreGameRoster([b])).toThrow('Invalid');
      expect(member(f.peers, 0).peers()).toEqual([b]);
      expect(member(f.peers, 0).freezeRoster()).toEqual([a, b].toSorted());
      expect(() => member(f.peers, 0).updatePreGameRoster([a, b, c])).toThrow('frozen');
      member(f.peers, 0).disconnect(b);
      member(f.peers, 0).connect(b);
      await settle();
      expect(member(f.peers, 0).roster()).toEqual([a, b].toSorted());
    } finally {
      f.dispose();
    }
  });

  test('signaling loss alone leaves an authenticated game channel in place', async () => {
    const f = mesh(2);
    try {
      for (const peer of f.peers) peer.start();
      await settle();
      const received: Uint8Array[] = [];
      member(f.peers, 1).onMessage((_from, bytes) => received.push(bytes));
      member(f.adapters, 0).close();
      expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1]);
      member(f.peers, 0).send(member(f.roster, 1), new Uint8Array([9]));
      await settle();
      expect(received).toEqual([new Uint8Array([9])]);
    } finally {
      f.dispose();
    }
  });

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

  test('a signaling adapter cannot swap DTLS fingerprints inside a signed offer', async () => {
    const f = mesh(2, false, false, false, false, true);
    try {
      for (const peer of f.peers) peer.start();
      await settle();
      expect(f.tamperedDescriptions()).toBeGreaterThan(0);
      expect(f.peers.map((peer) => peer.peers().length)).toEqual([0, 0]);
    } finally {
      f.dispose();
    }
  });
});

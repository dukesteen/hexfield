import { identityFromSecret, signObject } from '@cp2p/crypto';
import type {
  ServerSignalingAdapter,
  ServerSignalingOptions,
  WebRtcTransport,
  WebRtcTransportOptions,
} from '@cp2p/p2p';
import { VirtualClock } from '@cp2p/protocol/testing';
import type { PeerId, Unsubscribe } from '@cp2p/protocol';
import { expect, test } from 'vitest';
import type { DisposableOnlineIdentity } from './online-credentials.js';
import type { OnlineTransferArtifact } from './online-transfer-channel.js';
import {
  createTransferInvite,
  createTransferInviteUrl,
  decodeTransferInvite,
  encodeTransferInvite,
  OnlineTransferLink,
  parseTransferInviteUrl,
  transferChannelScope,
} from './online-transfer-link.js';

function device(seed: number): DisposableOnlineIdentity {
  const identity = identityFromSecret(new Uint8Array(32).fill(seed));
  return { ...identity, dispose: () => identity.secretKey.fill(0) };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected transfer link fixture value');
  return value;
}

class SignalingStub {
  private readonly listeners = new Set<(peers: readonly PeerId[] | null) => void>();
  peers: readonly PeerId[] | null = null;
  closed = false;

  onRoomPeers(listener: (peers: readonly PeerId[] | null) => void): Unsubscribe {
    this.listeners.add(listener);
    listener(this.peers);
    return () => this.listeners.delete(listener);
  }

  setPeers(peers: readonly PeerId[] | null): void {
    this.peers = peers;
    for (const listener of this.listeners) listener(peers);
  }

  onSignal(): Unsubscribe {
    return () => undefined;
  }
  close(): void {
    this.closed = true;
  }
}

class MeshStub {
  readonly self: PeerId;
  readonly initialRoster: readonly PeerId[];
  roster: readonly PeerId[];
  frozen = false;
  started = false;
  disposed = false;
  connected: PeerId[] = [];
  online = false;
  other: MeshStub | null = null;
  private readonly peerListeners = new Set<(peer: PeerId, online: boolean) => void>();
  private readonly messageListeners = new Set<(peer: PeerId, bytes: Uint8Array) => void>();

  constructor(options: WebRtcTransportOptions) {
    this.self = options.self;
    this.initialRoster = [...options.roster];
    this.roster = [...options.roster];
  }

  updatePreGameRoster(peers: readonly PeerId[]): void {
    if (this.frozen) throw new Error('Frozen');
    this.roster = [...peers];
  }
  freezeRoster(): readonly PeerId[] {
    this.frozen = true;
    return [...this.roster];
  }
  start(): void {
    this.started = true;
  }
  connect(peer: PeerId): void {
    this.connected.push(peer);
  }
  peers(): PeerId[] {
    return this.online && this.other ? [this.other.self] : [];
  }
  onPeerChange(listener: (peer: PeerId, online: boolean) => void): Unsubscribe {
    this.peerListeners.add(listener);
    return () => this.peerListeners.delete(listener);
  }
  onMessage(listener: (peer: PeerId, bytes: Uint8Array) => void): Unsubscribe {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }
  send(peer: PeerId, bytes: Uint8Array): void {
    if (!this.online || !this.other || peer !== this.other.self) throw new Error('Offline');
    for (const listener of this.other.messageListeners) listener(this.self, new Uint8Array(bytes));
  }
  broadcast(bytes: Uint8Array): void {
    if (this.other) this.send(this.other.self, bytes);
  }
  disconnect(): void {
    this.online = false;
  }
  emitOnline(): void {
    this.online = true;
    if (!this.other) throw new Error('Missing counterpart');
    for (const listener of this.peerListeners) listener(this.other.self, true);
  }
  emitOffline(): void {
    this.online = false;
    if (!this.other) throw new Error('Missing counterpart');
    for (const listener of this.peerListeners) listener(this.other.self, false);
  }
  dispose(): void {
    this.disposed = true;
    this.online = false;
  }
}

test('v4 transfer invite pins source, attempt and server origin with a bounded canonical code', () => {
  const source = device(61);
  const destination = device(62);
  try {
    const invite = createTransferInvite({
      attemptId: 'a'.repeat(43),
      gameId: 'b'.repeat(22),
      seat: 0,
      genesisDigest: 'c'.repeat(43),
      serverUrl: 'wss://signal.example/',
      roomId: 'abcdefghij',
      identity: source,
    });
    expect(invite.body.protocol).toBe('cp2p/online-transfer-invite/v4');
    const code = encodeTransferInvite(invite);
    expect(decodeTransferInvite(code)).toEqual(invite);
    expect(
      parseTransferInviteUrl(createTransferInviteUrl('https://game.example/', invite)),
    ).toEqual(invite);
    const basePathUrl = createTransferInviteUrl(
      'https://game.example/hexfield/#/game/current',
      invite,
    );
    expect(basePathUrl).toMatch(/^https:\/\/game\.example\/hexfield\/#\/transfer\//);
    expect(parseTransferInviteUrl(basePathUrl)).toEqual(invite);
    expect(transferChannelScope(invite, destination.peerId)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => decodeTransferInvite(`${code}a`)).toThrow(/base64url|invitation/);
    expect(() =>
      encodeTransferInvite({ ...invite, body: { ...invite.body, attemptId: 'd'.repeat(43) } }),
    ).toThrow(/signature/);
    expect(() =>
      createTransferInvite({
        attemptId: 'a'.repeat(43),
        gameId: 'b'.repeat(22),
        seat: 0,
        genesisDigest: 'c'.repeat(43),
        serverUrl: 'wss://signal.example/path',
        identity: source,
      }),
    ).toThrow(/origin/);
    const attacker = device(63);
    try {
      expect(() =>
        encodeTransferInvite({
          body: { ...invite.body, sourceDevice: attacker.peerId },
          sig: signObject('online-transfer-invite-v4', invite.body, source.secretKey),
        }),
      ).toThrow(/signature/);
    } finally {
      attacker.dispose();
    }
  } finally {
    source.dispose();
    destination.dispose();
  }
});

test('source selects a discovered device before the isolated authenticated channel can deliver', async () => {
  const source = device(64);
  const destination = device(65);
  const stranger = device(66);
  const clock = new VirtualClock();
  const invite = createTransferInvite({
    attemptId: 'e'.repeat(43),
    gameId: 'f'.repeat(22),
    seat: 0,
    genesisDigest: 'g'.repeat(43),
    serverUrl: 'wss://signal.example/',
    roomId: 'klmnopqrst',
    identity: source,
  });
  const signaling = new Map<PeerId, SignalingStub>();
  const meshes = new Map<PeerId, MeshStub>();
  const received: OnlineTransferArtifact[] = [];
  const errors: Error[] = [];
  const channels: PeerId[] = [];
  const makeOptions = (identity: DisposableOnlineIdentity) => ({
    invite,
    identity,
    clock,
    onChannel: () => channels.push(identity.peerId),
    onArtifact: (artifact: OnlineTransferArtifact) => received.push(artifact),
    onError: (error: Error) => errors.push(error),
    signalingFactory: (options: ServerSignalingOptions) => {
      const stub = new SignalingStub();
      signaling.set(options.self, stub);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test double implements the signaling methods exercised by OnlineTransferLink.
      return stub as unknown as ServerSignalingAdapter;
    },
    transportFactory: (options: WebRtcTransportOptions) => {
      const stub = new MeshStub(options);
      meshes.set(options.self, stub);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test double implements the transport methods exercised by OnlineTransferLink.
      return stub as unknown as WebRtcTransport;
    },
  });
  const sourceChannels: import('./online-transfer-channel.js').OnlineTransferChannel[] = [];
  const original = makeOptions(source);
  const host = OnlineTransferLink.openSource({
    ...original,
    onChannel: (channel) => sourceChannels.push(channel),
  });
  const guest = OnlineTransferLink.openDestination(makeOptions(destination));
  try {
    const sourceMesh = required(meshes.get(source.peerId));
    const destinationMesh = required(meshes.get(destination.peerId));
    sourceMesh.other = destinationMesh;
    destinationMesh.other = sourceMesh;
    expect(sourceMesh.initialRoster).toEqual([source.peerId]);
    expect(destinationMesh.initialRoster).toEqual([destination.peerId, source.peerId]);
    expect(() => host.selectDestination(stranger.peerId)).toThrow(/not present/);
    expect(sourceMesh.connected).toEqual([]);
    expect(sourceChannels).toEqual([]);
    required(signaling.get(source.peerId)).setPeers([
      source.peerId,
      destination.peerId,
      stranger.peerId,
    ]);
    expect(host.candidates()).toEqual([destination.peerId, stranger.peerId]);
    host.selectDestination(destination.peerId);
    expect(sourceMesh.frozen).toBe(true);
    expect(sourceMesh.connected).toEqual([destination.peerId]);
    expect(() => host.selectDestination(stranger.peerId)).toThrow(/cannot select/);
    sourceMesh.emitOnline();
    destinationMesh.emitOnline();
    expect(sourceChannels).toHaveLength(1);
    expect(channels).toEqual([destination.peerId]);
    const sent = required(sourceChannels[0]).send({ kind: 'offer', bytes: Uint8Array.of(1, 2) });
    await sent;
    expect(received).toEqual([{ kind: 'offer', bytes: Uint8Array.of(1, 2) }]);
    expect(errors).toEqual([]);
    const firstChannel = required(sourceChannels[0]);
    sourceMesh.emitOffline();
    destinationMesh.emitOffline();
    expect(errors).toHaveLength(2);
    expect(errors.every((error) => /connection/i.test(error.message))).toBe(true);
    await expect(firstChannel.send({ kind: 'offer', bytes: Uint8Array.of(3) })).rejects.toThrow(
      /closed/,
    );
    sourceMesh.emitOnline();
    destinationMesh.emitOnline();
    expect(sourceChannels).toHaveLength(2);
    expect(channels).toEqual([destination.peerId, destination.peerId]);
    await required(sourceChannels[1]).send({ kind: 'offer', bytes: Uint8Array.of(4) });
    expect(received.at(-1)).toEqual({ kind: 'offer', bytes: Uint8Array.of(4) });
  } finally {
    host.close();
    guest.close();
    expect(meshes.get(source.peerId)?.disposed).toBe(true);
    expect(meshes.get(destination.peerId)?.disposed).toBe(true);
    expect(signaling.get(source.peerId)?.closed).toBe(true);
    expect(signaling.get(destination.peerId)?.closed).toBe(true);
    expect(source.secretKey.some((byte) => byte !== 0)).toBe(true);
    source.dispose();
    destination.dispose();
    stranger.dispose();
  }
});

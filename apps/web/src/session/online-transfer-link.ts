import {
  canonicalDecode,
  canonicalEncode,
  fromBase64Url,
  hashValue,
  toBase64Url,
} from '@cp2p/codec';
import { identityFromSecret, parsePeerId, signObject, verifyObject } from '@cp2p/crypto';
import { ServerSignalingAdapter, WebRtcTransport } from '@cp2p/p2p';
import type { ServerSignalingOptions, WebRtcTransportOptions } from '@cp2p/p2p';
import type { PeerId, ProtocolClock, Unsubscribe } from '@cp2p/protocol';
import type { Seat } from '@cp2p/engine';
import * as v from 'valibot';
import type { DisposableOnlineIdentity } from './online-credentials.js';
import { createRoomId } from './online-invite.js';
import { OnlineTransferChannel } from './online-transfer-channel.js';
import type { OnlineTransferArtifact } from './online-transfer-channel.js';

const INVITE_PROTOCOL = 'cp2p/online-transfer-invite/v4';
const INVITE_DOMAIN = 'online-transfer-invite-v4';
const SCOPE_DOMAIN = 'cp2p/online-transfer-channel/v1';
const MAX_CODE_BYTES = 2_048;
const token = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
const bodySchema = v.strictObject({
  protocol: v.literal(INVITE_PROTOCOL),
  roomId: v.pipe(v.string(), v.regex(/^[a-z2-7]{10}$/)),
  attemptId: token,
  gameId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/)),
  seat: v.picklist([0, 1, 2, 3, 4, 5] as const),
  genesisDigest: token,
  sourceDevice: token,
  serverUrl: v.pipe(v.string(), v.maxLength(512)),
});
const inviteSchema = v.strictObject({
  body: bodySchema,
  sig: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{86}$/)),
});

export type OnlineTransferInvite = v.InferOutput<typeof inviteSchema>;

function serverOrigin(value: string): string {
  const url = new URL(value);
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.href !== url.origin + '/'
  )
    throw new TypeError('Transfer requires a signaling server origin');
  return url.origin;
}

function verifiedInvite(value: unknown): OnlineTransferInvite {
  const invite = v.parse(inviteSchema, value);
  parsePeerId(invite.body.sourceDevice);
  if (serverOrigin(invite.body.serverUrl) !== invite.body.serverUrl)
    throw new TypeError('Transfer signaling server URL is not canonical');
  if (!verifyObject(INVITE_DOMAIN, invite.body, invite.sig, parsePeerId(invite.body.sourceDevice)))
    throw new TypeError('Transfer invitation signature is invalid');
  return invite;
}

export function createTransferInvite(input: {
  readonly attemptId: string;
  readonly gameId: string;
  readonly seat: Seat;
  readonly genesisDigest: string;
  readonly serverUrl: string;
  readonly identity: DisposableOnlineIdentity;
  readonly roomId?: string;
}): OnlineTransferInvite {
  const source = identityFromSecret(input.identity.secretKey);
  try {
    if (source.peerId !== input.identity.peerId)
      throw new TypeError('Transfer source device key does not match identity');
  } finally {
    source.secretKey.fill(0);
    source.publicKey.fill(0);
  }
  const body = v.parse(bodySchema, {
    protocol: INVITE_PROTOCOL,
    roomId: input.roomId ?? createRoomId(),
    attemptId: input.attemptId,
    gameId: input.gameId,
    seat: input.seat,
    genesisDigest: input.genesisDigest,
    sourceDevice: input.identity.peerId,
    serverUrl: serverOrigin(input.serverUrl),
  });
  return verifiedInvite({ body, sig: signObject(INVITE_DOMAIN, body, input.identity.secretKey) });
}

export function encodeTransferInvite(invite: OnlineTransferInvite): string {
  const bytes = canonicalEncode(verifiedInvite(invite));
  try {
    if (bytes.length > MAX_CODE_BYTES) throw new RangeError('Transfer invitation is oversized');
    return toBase64Url(bytes);
  } finally {
    bytes.fill(0);
  }
}

export function decodeTransferInvite(code: string): OnlineTransferInvite {
  if (!/^[A-Za-z0-9_-]{1,2731}$/.test(code))
    throw new TypeError('Transfer invitation code is malformed');
  const bytes = fromBase64Url(code);
  try {
    if (bytes.length > MAX_CODE_BYTES) throw new RangeError('Transfer invitation is oversized');
    const invite = verifiedInvite(canonicalDecode(bytes));
    const canonical = canonicalEncode(invite);
    try {
      if (
        canonical.length !== bytes.length ||
        canonical.some((byte, index) => byte !== bytes[index])
      )
        throw new TypeError('Transfer invitation is not canonical');
    } finally {
      canonical.fill(0);
    }
    return invite;
  } finally {
    bytes.fill(0);
  }
}

export function createTransferInviteUrl(appUrl: string, invite: OnlineTransferInvite): string {
  const url = new URL(appUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new TypeError('Invalid transfer app URL');
  url.search = '';
  url.hash = `/transfer/${encodeTransferInvite(invite)}`;
  return url.href;
}

export function parseTransferInviteUrl(value: string): OnlineTransferInvite {
  if (value.length > 4_096) throw new RangeError('Transfer invitation URL is oversized');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search)
    throw new TypeError('Invalid transfer app URL');
  const path = url.hash.slice(1);
  if (!path.startsWith('/transfer/')) throw new TypeError('Not a transfer invitation URL');
  return decodeTransferInvite(path.slice('/transfer/'.length));
}

export function transferChannelScope(
  invite: OnlineTransferInvite,
  destinationDevice: PeerId,
): string {
  const checked = verifiedInvite(invite);
  parsePeerId(destinationDevice);
  if (destinationDevice === checked.body.sourceDevice)
    throw new TypeError('Transfer destination must be another device');
  return toBase64Url(
    hashValue({
      domain: SCOPE_DOMAIN,
      attemptId: checked.body.attemptId,
      genesisDigest: checked.body.genesisDigest,
      sourceDevice: checked.body.sourceDevice,
      destinationDevice,
    }),
  );
}

export interface OnlineTransferLinkOptions {
  readonly invite: OnlineTransferInvite;
  readonly identity: DisposableOnlineIdentity;
  readonly clock: ProtocolClock;
  readonly onChannel: (channel: OnlineTransferChannel) => void;
  readonly onArtifact: (artifact: OnlineTransferArtifact) => void;
  readonly onError: (error: Error) => void;
  readonly socketFactory?: ServerSignalingOptions['socketFactory'];
  readonly rtcFactory?: WebRtcTransportOptions['rtcFactory'];
  readonly iceServers?: readonly RTCIceServer[];
  readonly iceTransportPolicy?: RTCIceTransportPolicy;
  /** Deterministic test seams; production constructs the real signaling and RTC transport. */
  readonly signalingFactory?: (options: ServerSignalingOptions) => ServerSignalingAdapter;
  readonly transportFactory?: (options: WebRtcTransportOptions) => WebRtcTransport;
}

/** A separate signaling room and two-device authenticated link; game routing is untouched. */
export class OnlineTransferLink {
  readonly #source: boolean;
  readonly #invite: OnlineTransferInvite;
  readonly #self: PeerId;
  readonly #signaling: ServerSignalingAdapter;
  readonly #transport: WebRtcTransport;
  readonly #options: OnlineTransferLinkOptions;
  readonly #off: Unsubscribe[] = [];
  readonly #candidateListeners = new Set<(peers: readonly PeerId[]) => void>();
  #candidates: readonly PeerId[] = [];
  #selected: PeerId | null = null;
  #channel: OnlineTransferChannel | null = null;
  #channelGeneration = 0;
  #closed = false;

  private constructor(options: OnlineTransferLinkOptions, source: boolean) {
    this.#options = options;
    this.#source = source;
    this.#invite = verifiedInvite(options.invite);
    this.#self = options.identity.peerId;
    const derived = identityFromSecret(options.identity.secretKey);
    try {
      if (derived.peerId !== this.#self)
        throw new TypeError('Transfer device key does not match identity');
    } finally {
      derived.secretKey.fill(0);
      derived.publicKey.fill(0);
    }
    if (source !== (this.#self === this.#invite.body.sourceDevice))
      throw new TypeError('Transfer link role differs from signed source device');
    const initialRoster = source ? [this.#self] : [this.#self, this.#invite.body.sourceDevice];
    const signalingOptions: ServerSignalingOptions = {
      serverUrl: this.#invite.body.serverUrl,
      roomId: this.#invite.body.roomId,
      self: this.#self,
      secretKey: options.identity.secretKey,
      clock: options.clock,
      ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
    };
    this.#signaling = (options.signalingFactory ?? ((value) => new ServerSignalingAdapter(value)))(
      signalingOptions,
    );
    try {
      this.#transport = (options.transportFactory ?? ((value) => new WebRtcTransport(value)))({
        self: this.#self,
        secretKey: options.identity.secretKey,
        roster: initialRoster,
        scope: `transfer:${this.#invite.body.roomId}:${this.#invite.body.attemptId}`,
        adapter: this.#signaling,
        clock: options.clock,
        rtcFactory: options.rtcFactory ?? ((_peer, config) => new RTCPeerConnection(config)),
        ...(options.iceServers ? { iceServers: options.iceServers } : {}),
        ...(options.iceTransportPolicy ? { iceTransportPolicy: options.iceTransportPolicy } : {}),
      });
    } catch (error) {
      this.#signaling.close();
      throw error;
    }
    try {
      this.#off.push(
        this.#transport.onPeerChange((peer, online) => this.#peerChanged(peer, online)),
      );
      if (source) {
        this.#off.push(this.#signaling.onRoomPeers((peers) => this.#discovered(peers)));
        this.#transport.start();
      } else {
        this.#selected = this.#invite.body.sourceDevice;
        this.#transport.freezeRoster();
        this.#transport.start();
        this.#transport.connect(this.#selected);
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  static openSource(options: OnlineTransferLinkOptions): OnlineTransferLink {
    return new OnlineTransferLink(options, true);
  }

  static openDestination(options: OnlineTransferLinkOptions): OnlineTransferLink {
    return new OnlineTransferLink(options, false);
  }

  candidates(): readonly PeerId[] {
    return this.#candidates.slice();
  }

  onCandidates(listener: (peers: readonly PeerId[]) => void): Unsubscribe {
    if (this.#closed) return () => undefined;
    this.#candidateListeners.add(listener);
    try {
      listener(this.candidates());
    } catch {
      /* Isolate UI observers. */
    }
    return () => this.#candidateListeners.delete(listener);
  }

  selectDestination(peer: PeerId): void {
    if (this.#closed || !this.#source || this.#selected)
      throw new TypeError('Transfer source cannot select a destination');
    parsePeerId(peer);
    if (!this.#candidates.includes(peer))
      throw new TypeError('Destination is not present in the transfer signaling room');
    this.#selected = peer;
    try {
      this.#transport.updatePreGameRoster([this.#self, peer]);
      this.#transport.freezeRoster();
      this.#transport.connect(peer);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  #discovered(peers: readonly PeerId[] | null): void {
    if (this.#closed) return;
    this.#candidates = (peers ?? []).filter((peer) => peer !== this.#self).slice(0, 7);
    for (const listener of this.#candidateListeners) {
      try {
        listener(this.candidates());
      } catch {
        /* Isolate UI observers. */
      }
    }
  }

  #peerChanged(peer: PeerId, online: boolean): void {
    if (this.#closed || peer !== this.#selected) return;
    if (!online) {
      this.#channelGeneration += 1;
      this.#channel?.close();
      this.#channel = null;
      this.#options.onError(new Error('Transfer connection closed'));
      return;
    }
    if (this.#channel) return;
    const generation = ++this.#channelGeneration;
    const current = () => !this.#closed && generation === this.#channelGeneration;
    try {
      const channel = new OnlineTransferChannel({
        transport: this.#transport,
        peer,
        scope: transferChannelScope(this.#invite, this.#source ? peer : this.#self),
        clock: this.#options.clock,
        onArtifact: (artifact) => {
          if (current()) this.#options.onArtifact(artifact);
        },
        onError: (error) => {
          if (current()) {
            this.#channel = null;
            this.#options.onError(error);
          }
        },
      });
      this.#channel = channel;
      this.#options.onChannel(channel);
    } catch (error) {
      this.#channel?.close();
      this.#channel = null;
      this.#options.onError(error instanceof Error ? error : new Error('Transfer channel failed'));
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#channel?.close();
    this.#channel = null;
    for (const off of this.#off) off();
    this.#off.length = 0;
    this.#candidateListeners.clear();
    this.#transport.dispose();
    this.#signaling.close();
  }
}

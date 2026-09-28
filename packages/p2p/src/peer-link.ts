import { fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { parsePeerId, signObject, verifyObject } from '@cp2p/crypto';
import type { PeerId, ProtocolClock } from '@cp2p/protocol';
import { MAX_MESSAGE_BYTES, MessageFramer } from './framing.js';
import type { SignalBlob } from './signaling.js';

const HELLO_TIMEOUT_MS = 10_000;
const PING_MS = 2_000;
const DISCONNECT_GRACE_MS = 5_000;
const DISCONNECT_LIMIT_MS = 15_000;
const MAX_CONTROL_BYTES = 2_048;
const MAX_UNAUTH_BYTES = 4_096;
const MAX_UNAUTH_MESSAGES = 4;
const SEND_HIGH_WATER = 1_048_576;
const SEND_LOW_WATER = 262_144;
const MAX_QUEUED_BYTES = 2_097_152;
const MAX_EARLY_CANDIDATES = 16;
const MAX_PENDING_DESCRIPTIONS = 16;
const utf8 = new TextEncoder();

interface HelloBody {
  version: 1;
  scope: string;
  from: PeerId;
  to: PeerId;
  nonceFrom: string;
  nonceTo: string;
  fingerprintBinding: string;
}

interface Outgoing {
  channel: RTCDataChannel;
  frames: Uint8Array[];
  bytes: number;
}

export interface PeerLinkOptions {
  readonly self: PeerId;
  readonly peer: PeerId;
  readonly secretKey: Uint8Array;
  /** Bound to this lobby/invite or signed game, independent of the signaling sender. */
  readonly scope: string;
  readonly generation: number;
  readonly clock: ProtocolClock;
  readonly rtcFactory: () => RTCPeerConnection;
  readonly signal: (blob: SignalBlob) => void | Promise<void>;
  readonly onMessage: (message: Uint8Array) => void;
  readonly onAuthenticated: () => void;
  readonly onDown: (reason: string) => void;
  readonly randomBytes?: (length: number) => Uint8Array;
  /** Manual answerers must not send a competing offer before receiving one. */
  readonly offerMode?: 'auto' | 'answer-only';
}

/** One identity-bound RTC connection. The mesh manager owns replacement links. */
export class PeerLink {
  readonly pc: RTCPeerConnection;
  readonly game: RTCDataChannel;
  readonly bulk: RTCDataChannel;
  private readonly framer = new MessageFramer();
  private readonly incoming = new MessageFramer();
  private readonly nonce: string;
  private readonly signingKey: Uint8Array;
  private remoteNonce: string | null = null;
  private remoteGeneration: number | null = null;
  private localRevision = 0;
  private localOfferRevision: number | null = null;
  private remoteRevision = -1;
  private acceptedRemoteRevision = -1;
  private ignoredRevision = -1;
  private readonly earlyCandidates = new Map<string, (RTCIceCandidateInit | null)[]>();
  private helloSent = false;
  private initSent = false;
  private helloVerified = false;
  private pendingHello: string | null = null;
  private sentBinding: string | null = null;
  private remoteReady = false;
  private verifiedBinding: string | null = null;
  private authenticated = false;
  private closed = false;
  private makingOffer = false;
  private ignoreOffer = false;
  private isSettingRemoteAnswerPending = false;
  private descriptionTail: Promise<void> | null = null;
  private pendingDescriptions = 0;
  private negotiationQueued = false;
  private unauthBytes = 0;
  private unauthMessages = 0;
  private helloTimer: unknown = null;
  private pingTimer: unknown = null;
  private disconnectedTimer: unknown = null;
  private disconnectedSince: number | null = null;
  private pingSequence = 0;
  private missedPongs = 0;
  private awaitingPong = false;
  private readonly queues = new Map<RTCDataChannel, Outgoing>();

  constructor(private readonly options: PeerLinkOptions) {
    if (
      options.self === options.peer ||
      !options.scope ||
      options.scope.length > 128 ||
      !Number.isSafeInteger(options.generation) ||
      options.generation < 0
    )
      throw new TypeError('Invalid peer link identity or scope');
    const own = parsePeerId(options.self);
    parsePeerId(options.peer);
    const challenge = (options.randomBytes ?? defaultRandomBytes)(32);
    if (!(challenge instanceof Uint8Array) || challenge.length !== 32)
      throw new TypeError('Peer link challenge must be 32 bytes');
    this.nonce = toBase64Url(challenge);
    challenge.fill(0);
    this.signingKey = options.secretKey.slice();
    try {
      // Signing an empty purpose-bound object also validates the owned key.
      if (!verifyObject('p2p-key-check', {}, signObject('p2p-key-check', {}, this.signingKey), own))
        throw new TypeError('Peer link key does not match self identity');
    } catch (error) {
      this.closed = true;
      this.signingKey.fill(0);
      throw error;
    }
    let pc: RTCPeerConnection | null = null;
    let game: RTCDataChannel | null = null;
    let bulk: RTCDataChannel | null = null;
    try {
      pc = options.rtcFactory();
      game = pc.createDataChannel('game', { negotiated: true, id: 0, ordered: true });
      bulk = pc.createDataChannel('bulk', { negotiated: true, id: 1, ordered: true });
      this.pc = pc;
      this.game = game;
      this.bulk = bulk;
      this.attachListeners();
    } catch (error) {
      this.signingKey.fill(0);
      safeClose(bulk);
      safeClose(game);
      safeClose(pc);
      throw error;
    }
  }

  private attachListeners(): void {
    for (const channel of [this.game, this.bulk]) {
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = SEND_LOW_WATER;
      this.queues.set(channel, { channel, frames: [], bytes: 0 });
      channel.addEventListener('open', () => this.channelOpened());
      channel.addEventListener('close', () => this.fail('channel-closed'));
      channel.addEventListener('error', () => this.fail('channel-error'));
      channel.addEventListener('bufferedamountlow', () => this.drain(channel));
      channel.addEventListener('message', (event) => this.receive(channel, event.data));
    }
    this.pc.addEventListener('negotiationneeded', () => {
      if (
        this.negotiationQueued ||
        (this.options.offerMode === 'answer-only' && !this.authenticated)
      )
        return;
      this.negotiationQueued = true;
      void this.enqueueDescription(() => this.negotiate()).finally(() => {
        this.negotiationQueued = false;
      });
    });
    this.pc.addEventListener('icecandidate', (event) => {
      if (this.localRevision === 0) return;
      const ufrag = event.candidate?.usernameFragment;
      if (ufrag && !this.pc.localDescription?.sdp.includes(`a=ice-ufrag:${ufrag}`)) return;
      this.sendSignal({
        kind: 'candidate',
        generation: this.options.generation,
        revision: this.localRevision,
        candidate: event.candidate?.toJSON() ?? null,
      });
    });
    this.pc.addEventListener('signalingstatechange', () => {
      this.checkCurrentBinding();
      this.trySendHello();
      if (this.pc.signalingState === 'stable' && this.pendingHello) {
        const pending = this.pendingHello;
        this.pendingHello = null;
        this.receiveControl(pending);
      }
    });
    this.pc.addEventListener('connectionstatechange', () => this.connectionChanged());
  }

  get isAuthenticated(): boolean {
    return this.authenticated && !this.closed;
  }

  get hasOpenedChannels(): boolean {
    return !this.closed && this.game.readyState === 'open' && this.bulk.readyState === 'open';
  }

  receiveSignal(blob: SignalBlob): Promise<void> {
    if (blob?.kind !== 'description') return this.applySignal(blob);
    const description = blob.description;
    if (
      !description ||
      !['offer', 'answer'].includes(description.type) ||
      typeof description.sdp !== 'string' ||
      description.sdp.length > 65_536
    )
      return Promise.resolve();
    // Detach fields before waiting; remote and local SDP operations share one
    // queue so a second setLocalDescription cannot replace an unsent answer.
    const detached: SignalBlob = {
      kind: 'description',
      generation: blob.generation,
      revision: blob.revision,
      description: { type: description.type, sdp: description.sdp },
      ...(blob.inReplyTo === undefined ? {} : { inReplyTo: blob.inReplyTo }),
    };
    return this.enqueueDescription(() => this.applySignal(detached));
  }

  private enqueueDescription(action: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pendingDescriptions >= MAX_PENDING_DESCRIPTIONS) {
      this.fail('signaling-overflow');
      return Promise.resolve();
    }
    this.pendingDescriptions++;
    const operation = this.descriptionTail
      ? this.descriptionTail.then(() => (this.closed ? undefined : action()))
      : action();
    const settled = operation
      .catch(() => this.fail('negotiation-error'))
      .finally(() => {
        this.pendingDescriptions--;
        if (this.descriptionTail === settled) this.descriptionTail = null;
      });
    this.descriptionTail = settled;
    return settled;
  }

  private async applySignal(blob: SignalBlob): Promise<void> {
    if (
      this.closed ||
      !blob ||
      !Number.isSafeInteger(blob.generation) ||
      blob.generation < 0 ||
      !Number.isSafeInteger(blob.revision) ||
      blob.revision < 1
    )
      return;
    if (this.remoteGeneration !== null && blob.generation !== this.remoteGeneration) return;
    try {
      if (blob.kind === 'description') {
        if (blob.revision <= this.remoteRevision) return;
        const description = blob.description;
        if (
          !description ||
          !['offer', 'answer'].includes(description.type) ||
          typeof description.sdp !== 'string' ||
          description.sdp.length > 65_536
        )
          return;
        const candidateKey = `${blob.generation}/${blob.revision}`;
        // Only the answer to the currently outstanding local offer may change SDP.
        if (
          description.type === 'answer' &&
          (this.pc.signalingState !== 'have-local-offer' ||
            this.isSettingRemoteAnswerPending ||
            blob.inReplyTo !== this.localOfferRevision)
        ) {
          this.ignoredRevision = Math.max(this.ignoredRevision, blob.revision);
          this.earlyCandidates.delete(candidateKey);
          return;
        }
        if (this.authenticated) {
          try {
            const current = this.pc.currentRemoteDescription?.sdp;
            if (
              !current ||
              applicationFingerprint(description.sdp) !== applicationFingerprint(current)
            ) {
              if (description.type === 'answer') this.fail('fingerprint-changed');
              return;
            }
          } catch {
            return;
          }
        }
        if (this.remoteGeneration === null) this.remoteGeneration = blob.generation;
        const readyForOffer =
          !this.makingOffer &&
          (this.pc.signalingState === 'stable' || this.isSettingRemoteAnswerPending);
        const collision = description.type === 'offer' && !readyForOffer;
        this.ignoreOffer = collision && !this.polite;
        if (this.ignoreOffer) {
          this.ignoredRevision = Math.max(this.ignoredRevision, blob.revision);
          this.earlyCandidates.delete(candidateKey);
          return;
        }
        this.isSettingRemoteAnswerPending = description.type === 'answer';
        await this.pc.setRemoteDescription(description);
        if (this.closed) return;
        this.isSettingRemoteAnswerPending = false;
        this.localOfferRevision = null;
        this.remoteRevision = blob.revision;
        this.acceptedRemoteRevision = blob.revision;
        const early = this.earlyCandidates.get(candidateKey) ?? [];
        this.earlyCandidates.clear();
        if (description.type === 'offer') {
          this.localRevision++;
          await this.pc.setLocalDescription();
          if (this.closed) return;
          const answer = this.pc.localDescription;
          if (!answer || answer.type !== 'answer') throw new Error('Missing local answer');
          this.sendSignal({
            kind: 'description',
            generation: this.options.generation,
            revision: this.localRevision,
            description: { type: answer.type, sdp: answer.sdp ?? '' },
            inReplyTo: blob.revision,
          });
        }
        for (const candidate of early) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- ICE candidates retain signaling order.
            await this.pc.addIceCandidate(candidate);
          } catch {
            /* A rejected candidate must not suppress an answer. */
          }
        }
        this.trySendHello();
      } else if (blob.kind === 'candidate') {
        if (
          blob.candidate !== null &&
          (typeof blob.candidate.candidate !== 'string' || blob.candidate.candidate.length > 4_096)
        )
          return;
        if (blob.revision <= this.ignoredRevision || blob.revision < this.acceptedRemoteRevision)
          return;
        if (blob.revision === this.acceptedRemoteRevision) {
          try {
            await this.pc.addIceCandidate(blob.candidate);
          } catch {
            /* Other candidates can still establish ICE. */
          }
          return;
        }
        const candidateKey = `${blob.generation}/${blob.revision}`;
        const pending = this.earlyCandidates.get(candidateKey) ?? [];
        const count = [...this.earlyCandidates.values()].reduce(
          (total, values) => total + values.length,
          0,
        );
        if (count >= MAX_EARLY_CANDIDATES) return;
        pending.push(blob.candidate);
        this.earlyCandidates.set(candidateKey, pending);
      }
    } catch {
      this.isSettingRemoteAnswerPending = false;
      this.fail('negotiation-error');
    }
  }

  send(message: Uint8Array, channel: 'game' | 'bulk' = 'game'): void {
    if (!this.isAuthenticated) throw new Error('Peer link is not authenticated');
    if (!(message instanceof Uint8Array) || message.byteLength > MAX_MESSAGE_BYTES)
      throw new RangeError('Transport message exceeds 1 MiB');
    const target = channel === 'game' ? this.game : this.bulk;
    const queue = this.queues.get(target);
    if (!queue || target.readyState !== 'open') throw new Error('Peer channel is unavailable');
    const frames = this.framer.split(message);
    const bytes = frames.reduce((total, frame) => total + frame.byteLength, 0);
    if (queue.bytes + bytes > MAX_QUEUED_BYTES) throw new Error('Peer send queue is full');
    queue.frames.push(...frames);
    queue.bytes += bytes;
    if (channel === 'game' || this.remoteReady) this.drain(target);
  }

  close(reason = 'closed'): void {
    this.fail(reason);
  }

  private get polite(): boolean {
    return this.options.self < this.options.peer;
  }

  private async negotiate(): Promise<void> {
    if (
      this.closed ||
      this.pc.signalingState !== 'stable' ||
      (this.options.offerMode === 'answer-only' && !this.authenticated)
    )
      return;
    try {
      this.makingOffer = true;
      this.localRevision++;
      await this.pc.setLocalDescription();
      if (this.closed) return;
      const description = this.pc.localDescription;
      if (!description || description.type !== 'offer') throw new Error('Missing local offer');
      this.localOfferRevision = this.localRevision;
      this.sendSignal({
        kind: 'description',
        generation: this.options.generation,
        revision: this.localRevision,
        description: {
          type: description.type,
          sdp: description.sdp ?? '',
        },
      });
    } catch {
      this.fail('negotiation-error');
    } finally {
      this.makingOffer = false;
    }
  }

  private sendSignal(blob: SignalBlob): void {
    if (this.closed) return;
    try {
      void Promise.resolve(this.options.signal(blob)).catch(() => this.fail('signal-error'));
    } catch {
      this.fail('signal-error');
    }
  }

  private channelOpened(): void {
    if (this.closed || this.game.readyState !== 'open' || this.bulk.readyState !== 'open') return;
    if (!this.initSent) {
      this.initSent = true;
      this.helloTimer = this.options.clock.setTimeout(
        () => this.fail('hello-timeout'),
        HELLO_TIMEOUT_MS,
      );
      this.sendControl({ kind: 'HELLO_INIT', nonce: this.nonce });
    }
    this.trySendHello();
  }

  private trySendHello(): void {
    if (
      this.closed ||
      this.helloSent ||
      !this.remoteNonce ||
      this.game.readyState !== 'open' ||
      this.bulk.readyState !== 'open'
    )
      return;
    const binding = this.fingerprintBinding();
    if (!binding) return;
    const body: HelloBody = {
      version: 1,
      scope: this.options.scope,
      from: this.options.self,
      to: this.options.peer,
      nonceFrom: this.nonce,
      nonceTo: this.remoteNonce,
      fingerprintBinding: binding,
    };
    this.sentBinding = binding;
    this.helloSent = true;
    this.sendControl({ kind: 'HELLO', body, sig: signObject('p2p-hello', body, this.signingKey) });
    if (this.closed) return;
    this.maybeAuthenticated();
  }

  private fingerprintBinding(): string | null {
    if (this.pc.signalingState !== 'stable') return null;
    const local = this.pc.currentLocalDescription?.sdp;
    const remote = this.pc.currentRemoteDescription?.sdp;
    if (!local || !remote) return null;
    try {
      const pairs = [
        { peerId: this.options.self, fingerprint: applicationFingerprint(local) },
        { peerId: this.options.peer, fingerprint: applicationFingerprint(remote) },
      ].toSorted((a, b) => (a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0));
      return toHex(hashValue({ domain: 'cp2p/v1/p2p-fingerprints', pairs }));
    } catch {
      return null;
    }
  }

  private receive(channel: RTCDataChannel, data: unknown): void {
    if (this.closed) return;
    if (typeof data === 'string') {
      if (channel !== this.game || data.length > MAX_CONTROL_BYTES) {
        this.fail('invalid-control');
        return;
      }
      const bytes = utf8.encode(data).byteLength;
      if (bytes > MAX_CONTROL_BYTES) {
        this.fail('invalid-control');
        return;
      }
      if (!this.authenticated) {
        this.unauthMessages++;
        this.unauthBytes += bytes;
        if (this.unauthMessages > MAX_UNAUTH_MESSAGES || this.unauthBytes > MAX_UNAUTH_BYTES) {
          this.fail('unauthenticated-limit');
          return;
        }
      }
      this.receiveControl(data);
      return;
    }
    if (!this.authenticated) {
      this.fail('preauth-data');
      return;
    }
    const frame =
      data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
    if (!frame) {
      this.fail('invalid-frame');
      return;
    }
    try {
      const message = this.incoming.accept(frame, this.options.clock.now());
      this.seenInbound();
      if (message) {
        try {
          this.options.onMessage(message);
        } catch {
          this.fail('application-listener');
        }
      }
    } catch (error) {
      this.fail(
        error instanceof Error && error.message === 'Transport reassembly timed out'
          ? 'reassembly-timeout'
          : 'invalid-frame',
      );
    }
  }

  private receiveControl(encoded: string): void {
    let value: unknown;
    try {
      value = JSON.parse(encoded);
    } catch {
      this.fail('invalid-control');
      return;
    }
    if (!isRecord(value)) {
      this.fail('invalid-control');
      return;
    }
    const control = value;
    if (control.kind === 'HELLO_INIT' && !this.authenticated) {
      if (
        !exactKeys(control, ['kind', 'nonce']) ||
        typeof control.nonce !== 'string' ||
        !canonicalNonce(control.nonce) ||
        (this.remoteNonce !== null && this.remoteNonce !== control.nonce)
      ) {
        this.fail('invalid-challenge');
        return;
      }
      this.remoteNonce = control.nonce;
      this.channelOpened();
      return;
    }
    if (control.kind === 'HELLO' && !this.authenticated) {
      const body = control.body;
      if (!isRecord(body) || typeof control.sig !== 'string') {
        this.fail('invalid-hello');
        return;
      }
      const hello = body;
      if (
        !exactKeys(control, ['kind', 'body', 'sig']) ||
        !exactKeys(body, [
          'version',
          'scope',
          'from',
          'to',
          'nonceFrom',
          'nonceTo',
          'fingerprintBinding',
        ]) ||
        hello.version !== 1 ||
        hello.scope !== this.options.scope ||
        hello.from !== this.options.peer ||
        hello.to !== this.options.self ||
        hello.nonceFrom !== this.remoteNonce ||
        hello.nonceTo !== this.nonce ||
        !verifyObject('p2p-hello', body, control.sig, parsePeerId(this.options.peer))
      ) {
        this.fail('hello-authentication');
        return;
      }
      this.trySendHello();
      if (!this.sentBinding && this.pc.signalingState !== 'stable') {
        this.pendingHello = encoded;
        return;
      }
      if (!this.sentBinding) {
        this.fail('fingerprint-unsupported');
        return;
      }
      if (hello.fingerprintBinding !== this.sentBinding) {
        this.fail('hello-binding');
        return;
      }
      this.helloVerified = true;
      this.verifiedBinding = this.sentBinding;
      this.maybeAuthenticated();
      return;
    }
    if (this.authenticated && control.kind === 'PING' && Number.isSafeInteger(control.sequence)) {
      this.seenInbound();
      this.sendControl({ kind: 'PONG', sequence: control.sequence });
      return;
    }
    if (control.kind === 'READY' && exactKeys(control, ['kind'])) {
      this.remoteReady = true;
      if (this.authenticated) {
        this.seenInbound();
        this.drain(this.bulk);
      }
      return;
    }
    if (
      this.authenticated &&
      control.kind === 'PONG' &&
      Number.isSafeInteger(control.sequence) &&
      Number(control.sequence) >= 1 &&
      Number(control.sequence) <= this.pingSequence
    ) {
      this.seenInbound();
      return;
    }
    this.fail('invalid-control');
  }

  private seenInbound(): void {
    this.missedPongs = 0;
    this.awaitingPong = false;
  }

  private maybeAuthenticated(): void {
    if (this.closed || this.authenticated || !this.helloSent || !this.helloVerified) return;
    this.authenticated = true;
    this.clearTimer('helloTimer');
    this.pingTimer = this.options.clock.setTimeout(() => this.ping(), PING_MS);
    try {
      this.options.onAuthenticated();
    } catch {
      this.fail('local-authenticated-callback');
      return;
    }
    this.sendControl({ kind: 'READY' });
    if (this.remoteReady) this.drain(this.bulk);
  }

  private ping(): void {
    this.pingTimer = null;
    if (!this.isAuthenticated) return;
    const now = this.options.clock.now();
    if (this.incoming.expire(now) > 0) {
      this.fail('reassembly-timeout');
      return;
    }
    if (this.disconnectedSince !== null && now - this.disconnectedSince >= DISCONNECT_LIMIT_MS) {
      this.fail('disconnected-timeout');
      return;
    }
    if (
      this.awaitingPong &&
      this.disconnectedSince === null &&
      this.game.bufferedAmount <= SEND_LOW_WATER
    )
      this.missedPongs++;
    if (this.missedPongs >= 3) {
      this.fail('ping-timeout');
      return;
    }
    if (this.disconnectedSince === null) {
      this.awaitingPong = true;
      this.sendControl({ kind: 'PING', sequence: ++this.pingSequence });
    }
    this.pingTimer = this.options.clock.setTimeout(() => this.ping(), PING_MS);
  }

  private sendControl(control: object): void {
    if (this.closed || this.game.readyState !== 'open') return;
    const encoded = JSON.stringify(control);
    if (utf8.encode(encoded).byteLength > MAX_CONTROL_BYTES) {
      this.fail('control-too-large');
      return;
    }
    if (this.game.bufferedAmount > SEND_HIGH_WATER + 65_536) {
      this.fail('control-backpressure');
      return;
    }
    try {
      this.game.send(encoded);
    } catch {
      this.fail('control-send');
    }
  }

  private drain(channel: RTCDataChannel): void {
    const queue = this.queues.get(channel);
    if (!queue || this.closed || channel.readyState !== 'open') return;
    if (channel === this.bulk && !this.remoteReady) return;
    while (queue.frames.length) {
      const next = queue.frames[0];
      if (
        !next ||
        (channel.bufferedAmount !== 0 && channel.bufferedAmount + next.byteLength > SEND_HIGH_WATER)
      )
        break;
      const frame = queue.frames.shift();
      if (!frame) break;
      queue.bytes -= frame.byteLength;
      try {
        const packet = new ArrayBuffer(frame.byteLength);
        new Uint8Array(packet).set(frame);
        channel.send(packet);
      } catch {
        this.fail('channel-send');
        return;
      }
    }
  }

  private connectionChanged(): void {
    if (this.closed) return;
    if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') {
      this.fail('connection-failed');
      return;
    }
    if (this.pc.connectionState === 'disconnected' && this.disconnectedTimer === null) {
      this.disconnectedSince ??= this.options.clock.now();
      this.disconnectedTimer = this.options.clock.setTimeout(() => {
        this.disconnectedTimer = null;
        if (!this.closed && this.pc.connectionState === 'disconnected') {
          try {
            this.pc.restartIce();
          } catch {
            this.fail('ice-restart');
          }
        }
      }, DISCONNECT_GRACE_MS);
    } else if (this.pc.connectionState === 'connected') {
      this.disconnectedSince = null;
      this.clearTimer('disconnectedTimer');
      this.checkCurrentBinding();
    }
  }

  private checkCurrentBinding(): void {
    if (
      this.authenticated &&
      this.pc.signalingState === 'stable' &&
      this.fingerprintBinding() !== this.verifiedBinding
    )
      this.fail('fingerprint-changed');
  }

  private clearTimer(which: 'helloTimer' | 'pingTimer' | 'disconnectedTimer'): void {
    const handle = this[which];
    if (handle !== null) this.options.clock.clearTimeout(handle);
    this[which] = null;
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.authenticated = false;
    this.clearTimer('helloTimer');
    this.clearTimer('pingTimer');
    this.clearTimer('disconnectedTimer');
    this.framer.clear();
    this.incoming.clear();
    this.earlyCandidates.clear();
    this.sentBinding = null;
    this.pendingHello = null;
    this.signingKey.fill(0);
    for (const queue of this.queues.values()) {
      queue.frames.length = 0;
      queue.bytes = 0;
    }
    safeClose(this.game);
    safeClose(this.bulk);
    safeClose(this.pc);
    try {
      this.options.onDown(reason);
    } catch {
      /* Closure has already completed. */
    }
  }
}

function safeClose(resource: { close(): void } | null): void {
  try {
    resource?.close();
  } catch {
    /* Continue closing the remaining owned resources. */
  }
}

function defaultRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function canonicalNonce(value: string): boolean {
  try {
    return fromBase64Url(value).length === 32 && toBase64Url(fromBase64Url(value)) === value;
  } catch {
    return false;
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The data-only link admits exactly one active SCTP media section. */
export function applicationFingerprint(sdp: string): string {
  const sections = sdp.split(/\r?\nm=/);
  const session = sections.shift() ?? '';
  if (sections.length !== 1) throw new Error('Expected data-only SDP');
  const applications = sections.filter((part) => part.startsWith('application '));
  if (applications.length !== 1) throw new Error('Expected one SCTP media section');
  const application = applications[0];
  if (!application) throw new Error('Missing SCTP media section');
  const port = /^application\s+(\d+)\s/.exec(application)?.[1];
  if (!port || Number(port) === 0) throw new Error('Inactive SCTP media section');
  const mid = /^a=mid:([^\r\n]+)$/m.exec(application)?.[1];
  const bundles = [...session.matchAll(/^a=group:BUNDLE\s+([^\r\n]+)$/gm)];
  if (bundles.length > 1) throw new Error('Multiple BUNDLE groups are unsupported');
  const bundle = bundles[0]?.[1];
  if (bundle && (!mid || !bundle.split(/\s+/).includes(mid)))
    throw new Error('SCTP media section is outside BUNDLE');
  const media = [...application.matchAll(/^a=fingerprint:([^\r\n]+)$/gm)].map((match) => match[1]);
  const sessionValues = [...session.matchAll(/^a=fingerprint:([^\r\n]+)$/gm)].map(
    (match) => match[1],
  );
  const fingerprints = media.length ? media : sessionValues;
  if (fingerprints.length === 0) throw new Error('Missing DTLS fingerprint');
  const normalized = fingerprints.map((value) => {
    const match = /^sha-256\s+((?:[\da-fA-F]{2}:){31}[\da-fA-F]{2})$/i.exec(value ?? '');
    if (!match) throw new Error('Unsupported DTLS fingerprint');
    return `sha-256:${match[1]?.replaceAll(':', '').toLowerCase()}`;
  });
  if (new Set(normalized).size !== 1) throw new Error('Conflicting DTLS fingerprints');
  const fingerprint = normalized[0];
  if (!fingerprint) throw new Error('Missing DTLS fingerprint');
  return fingerprint;
}

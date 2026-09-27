import { canonicalDecode, canonicalEncode, hashValue, toBase64Url } from '@cp2p/codec';
import { identityFromSecret, parsePeerId } from '@cp2p/crypto';
import type { PeerId, ProtocolClock, Unsubscribe } from '@cp2p/protocol';
import { decodeManualCode, encodeManualCode, manualOfferHash } from './manual-code.js';
import type { ManualCodeBody } from './manual-code.js';
import { aggregateManualSdp } from './manual-sdp.js';
import { verifySignalEnvelope } from './signaling-envelope.js';
import type { EnvelopeSignalingAdapter, SignedSignalEnvelope } from './signaling-envelope.js';

const GATHER_DEADLINE_MS = 4_000;
const MAX_BRIDGE_BYTES = 70_000;
const MAX_BRIDGE_BUFFERED = 256 * 1_024;
const MAX_PENDING_CANDIDATES = 17;
const MAX_EARLY_ENVELOPES = 16;
const BRIDGE_READY_DEADLINE_MS = 5 * 60_000;
const noGather = () => undefined;

export interface ManualBootstrapOptions {
  readonly self: PeerId;
  readonly secretKey: Uint8Array;
  readonly scope: string;
  readonly clock: ProtocolClock;
  readonly rtcFactory: () => RTCPeerConnection;
  /** Returns an owned 16-byte buffer; the bootstrap wipes it after copying the nonce. */
  readonly randomBytes?: (length: number) => Uint8Array;
  /** A smaller limit is useful for tests; real gathers cap at four seconds. */
  readonly gatherDeadlineMs?: number;
}

export interface ManualOfferOptions extends ManualBootstrapOptions {
  /** Known recipient for reconnect. Omit for the first invitation to an unknown joiner. */
  readonly to?: PeerId;
}

export interface ManualOffer {
  readonly code: string;
  readonly gatheringComplete: boolean;
  acceptAnswer(code: string): Promise<ManualBridge>;
  close(): void;
}

export interface ManualAnswer {
  readonly code: string;
  readonly peer: PeerId;
  readonly gatheringComplete: boolean;
  readonly bridge: ManualBridge;
}

function checkedOptions(options: ManualBootstrapOptions): Uint8Array {
  parsePeerId(options.self);
  if (!options.scope || options.scope.length > 128)
    throw new TypeError('Manual bootstrap scope is invalid');
  if (
    options.gatherDeadlineMs !== undefined &&
    (!Number.isSafeInteger(options.gatherDeadlineMs) ||
      options.gatherDeadlineMs < 1 ||
      options.gatherDeadlineMs > GATHER_DEADLINE_MS)
  )
    throw new TypeError('Manual ICE gathering deadline is invalid');
  const owned = options.secretKey.slice();
  try {
    const identity = identityFromSecret(owned);
    try {
      if (identity.peerId !== options.self) throw new TypeError('Manual key does not match self');
    } finally {
      identity.secretKey.fill(0);
      identity.publicKey.fill(0);
    }
    return owned;
  } catch (error) {
    owned.fill(0);
    throw error;
  }
}

function randomNonce(options: ManualBootstrapOptions): string {
  const bytes = (
    options.randomBytes ?? ((length) => crypto.getRandomValues(new Uint8Array(length)))
  )(16);
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) {
    if (bytes instanceof Uint8Array) bytes.fill(0);
    throw new TypeError('Manual invitation entropy must be 16 bytes');
  }
  const nonce = toBase64Url(bytes);
  bytes.fill(0);
  return nonce;
}

function newChannel(pc: RTCPeerConnection): RTCDataChannel {
  const channel = pc.createDataChannel('manual-signaling', {
    negotiated: true,
    id: 2,
    ordered: true,
  });
  channel.binaryType = 'arraybuffer';
  return channel;
}

function gatherCandidates(
  pc: RTCPeerConnection,
  clock: ProtocolClock,
  deadlineMs: number,
): {
  finishIfComplete(): void;
  cancel(): void;
  result: Promise<{ candidates: RTCIceCandidateInit[]; complete: boolean }>;
} {
  const candidates: RTCIceCandidateInit[] = [];
  let resolve!: (value: { candidates: RTCIceCandidateInit[]; complete: boolean }) => void;
  let done = false;
  const result = new Promise<{ candidates: RTCIceCandidateInit[]; complete: boolean }>((finish) => {
    resolve = finish;
  });
  const settle = (complete: boolean) => {
    if (done) return;
    done = true;
    pc.removeEventListener('icecandidate', onCandidate);
    pc.removeEventListener('icegatheringstatechange', onState);
    clock.clearTimeout(timer);
    resolve({ candidates, complete });
  };
  const onCandidate = (event: RTCPeerConnectionIceEvent) => {
    if (!event.candidate) {
      settle(true);
      return;
    }
    if (candidates.length < MAX_PENDING_CANDIDATES) candidates.push(event.candidate.toJSON());
  };
  const onState = () => {
    if (pc.iceGatheringState === 'complete') settle(true);
  };
  pc.addEventListener('icecandidate', onCandidate);
  pc.addEventListener('icegatheringstatechange', onState);
  const timer = clock.setTimeout(() => settle(false), deadlineMs);
  return { finishIfComplete: onState, cancel: () => settle(false), result };
}

function decodedFrame(data: unknown): unknown {
  const bytes =
    data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
  if (!bytes || bytes.length > MAX_BRIDGE_BYTES) return null;
  try {
    const value: unknown = canonicalDecode(bytes);
    const encoded = canonicalEncode(value);
    return encoded.length === bytes.length && encoded.every((byte, index) => byte === bytes[index])
      ? value
      : null;
  } catch {
    return null;
  }
}

/** Temporary authenticated signaling link. Gameplay still uses WebRtcTransport/PeerLink. */
export class ManualBridge implements EnvelopeSignalingAdapter {
  private readonly listeners = new Set<(from: PeerId, value: unknown) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly early: SignedSignalEnvelope[] = [];
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (reason: Error) => void;
  private readonly readyTimeout: unknown;
  private closed = false;

  private readonly onChannelOpen = (): void => {
    if (this.closed) return;
    this.clock.clearTimeout(this.readyTimeout);
    this.resolveReady();
  };
  private readonly onChannelClose = (): void => this.close();
  private readonly onConnectionStateChange = (): void => {
    if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') this.close();
  };
  private readonly onChannelMessage = (event: MessageEvent): void => {
    const value = verifySignalEnvelope(
      decodedFrame(event.data),
      this.scope,
      this.self,
      new Set([this.peer]),
    );
    if (!value || this.closed) return;
    if (this.listeners.size === 0) {
      if (this.early.length === MAX_EARLY_ENVELOPES) this.close();
      else this.early.push(value);
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(this.peer, value);
      } catch {
        /* One observer cannot interrupt signaling. */
      }
    }
  };

  constructor(
    private readonly pc: RTCPeerConnection,
    private readonly channel: RTCDataChannel,
    private readonly scope: string,
    private readonly self: PeerId,
    readonly peer: PeerId,
    private readonly clock: ProtocolClock,
  ) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.readyPromise.catch(() => undefined);
    this.readyTimeout = clock.setTimeout(() => this.close(), BRIDGE_READY_DEADLINE_MS);
    channel.addEventListener('open', this.onChannelOpen);
    channel.addEventListener('close', this.onChannelClose);
    pc.addEventListener('connectionstatechange', this.onConnectionStateChange);
    channel.addEventListener('message', this.onChannelMessage);
    if (channel.readyState === 'open') {
      clock.clearTimeout(this.readyTimeout);
      this.resolveReady();
    }
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onClose(listener: () => void): Unsubscribe {
    if (this.closed) {
      try {
        listener();
      } catch {
        /* Cleanup observers cannot interrupt close registration. */
      }
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async send(to: PeerId, value: SignedSignalEnvelope): Promise<void> {
    if (this.closed || to !== this.peer)
      throw new Error('Manual signaling recipient is unavailable');
    const verified = verifySignalEnvelope(value, this.scope, to, new Set([this.self]));
    if (!verified) throw new TypeError('Manual signaling envelope is invalid');
    const bytes = canonicalEncode(verified);
    if (bytes.length > MAX_BRIDGE_BYTES)
      throw new RangeError('Manual signaling frame is too large');
    await this.readyPromise;
    if (this.closed || this.channel.readyState !== 'open')
      throw new Error('Manual signaling channel is closed');
    if (this.channel.bufferedAmount + bytes.length > MAX_BRIDGE_BUFFERED)
      throw new Error('Manual signaling channel is backed up');
    const frame = new Uint8Array(bytes.length);
    frame.set(bytes);
    this.channel.send(frame);
  }

  onSignal(listener: (from: PeerId, value: unknown) => void): Unsubscribe {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    for (const value of this.early.splice(0)) {
      try {
        listener(this.peer, value);
      } catch {
        /* One observer cannot interrupt signaling. */
      }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.removeEventListener('open', this.onChannelOpen);
    this.channel.removeEventListener('close', this.onChannelClose);
    this.channel.removeEventListener('message', this.onChannelMessage);
    this.pc.removeEventListener('connectionstatechange', this.onConnectionStateChange);
    this.clock.clearTimeout(this.readyTimeout);
    this.rejectReady(new Error('Manual signaling channel is closed'));
    this.early.length = 0;
    this.listeners.clear();
    for (const listener of this.closeListeners) {
      try {
        listener();
      } catch {
        /* Cleanup observers cannot interrupt bridge shutdown. */
      }
    }
    this.closeListeners.clear();
    this.channel.close();
    this.pc.close();
  }
}

/** Create one unknown-recipient invitation, or bind a reconnect offer to a known peer. */
export async function createManualOffer(options: ManualOfferOptions): Promise<ManualOffer> {
  const key = checkedOptions(options);
  let pc: RTCPeerConnection | null = null;
  let cancelGather: () => void = noGather;
  try {
    if (options.to !== undefined) {
      parsePeerId(options.to);
      if (options.to === options.self) throw new TypeError('Cannot invite self');
    }
    const nonce = randomNonce(options);
    pc = options.rtcFactory();
    const channel = newChannel(pc);
    const gather = gatherCandidates(
      pc,
      options.clock,
      options.gatherDeadlineMs ?? GATHER_DEADLINE_MS,
    );
    cancelGather = () => gather.cancel();
    await pc.setLocalDescription();
    gather.finishIfComplete();
    const gathered = await gather.result;
    const description = pc.localDescription;
    if (!description || description.type !== 'offer')
      throw new Error('Manual offer SDP is missing');
    const body: ManualCodeBody = {
      v: 1,
      k: 'o',
      sc: options.scope,
      f: options.self,
      n: nonce,
      s: aggregateManualSdp(description.sdp, gathered.candidates),
      ...(options.to ? { t: options.to } : {}),
    };
    const code = await encodeManualCode(body, key);
    const offerHash = manualOfferHash(await decodeManualCode(code, options.scope));
    const connection = pc;
    let accepted: { hash: string; bridge: ManualBridge } | null = null;
    let accepting: { hash: string; promise: Promise<ManualBridge> } | null = null;
    let closed = false;
    return {
      code,
      gatheringComplete: gathered.complete,
      async acceptAnswer(answerCode) {
        if (closed) throw new Error('Manual invitation is closed');
        const answer = await decodeManualCode(answerCode, options.scope, options.self);
        if (
          answer.b.k !== 'a' ||
          answer.b.t !== options.self ||
          answer.b.n !== nonce ||
          answer.b.h !== offerHash ||
          (options.to !== undefined && answer.b.f !== options.to)
        )
          throw new TypeError('Manual answer does not bind this invitation');
        if (closed) throw new Error('Manual invitation is closed');
        const answerHash = toBase64Url(hashValue(answer));
        if (accepted) {
          if (accepted.hash !== answerHash) throw new Error('Manual invitation was already used');
          return accepted.bridge;
        }
        if (accepting) {
          if (accepting.hash !== answerHash) throw new Error('Manual invitation is being answered');
          return accepting.promise;
        }
        const promise = (async () => {
          if (closed) throw new Error('Manual invitation is closed');
          try {
            await connection.setRemoteDescription({ type: 'answer', sdp: answer.b.s });
            if (closed) throw new Error('Manual invitation is closed');
            const bridge = new ManualBridge(
              connection,
              channel,
              options.scope,
              options.self,
              answer.b.f,
              options.clock,
            );
            accepted = { hash: answerHash, bridge };
            return bridge;
          } catch (error) {
            closed = true;
            channel.close();
            connection.close();
            throw error;
          }
        })();
        accepting = { hash: answerHash, promise };
        try {
          return await promise;
        } finally {
          accepting = null;
        }
      },
      close() {
        if (closed) return;
        closed = true;
        if (accepted) accepted.bridge.close();
        else {
          channel.close();
          connection.close();
        }
      },
    };
  } catch (error) {
    cancelGather();
    pc?.close();
    throw error;
  } finally {
    key.fill(0);
  }
}

/** Answer a signed invitation using the guest's durable device identity. */
export async function answerManualOffer(
  options: ManualBootstrapOptions,
  offerCode: string,
): Promise<ManualAnswer> {
  const key = checkedOptions(options);
  let pc: RTCPeerConnection | null = null;
  let cancelGather: () => void = noGather;
  try {
    const offer = await decodeManualCode(offerCode, options.scope, options.self);
    if (offer.b.k !== 'o' || offer.b.f === options.self)
      throw new TypeError('Manual offer is not for this joining device');
    pc = options.rtcFactory();
    const channel = newChannel(pc);
    const gather = gatherCandidates(
      pc,
      options.clock,
      options.gatherDeadlineMs ?? GATHER_DEADLINE_MS,
    );
    cancelGather = () => gather.cancel();
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.b.s });
    await pc.setLocalDescription();
    gather.finishIfComplete();
    const gathered = await gather.result;
    const description = pc.localDescription;
    if (!description || description.type !== 'answer')
      throw new Error('Manual answer SDP is missing');
    const code = await encodeManualCode(
      {
        v: 1,
        k: 'a',
        sc: options.scope,
        f: options.self,
        t: offer.b.f,
        n: offer.b.n,
        h: manualOfferHash(offer),
        s: aggregateManualSdp(description.sdp, gathered.candidates),
      },
      key,
    );
    return {
      code,
      peer: offer.b.f,
      gatheringComplete: gathered.complete,
      bridge: new ManualBridge(pc, channel, options.scope, options.self, offer.b.f, options.clock),
    };
  } catch (error) {
    cancelGather();
    pc?.close();
    throw error;
  } finally {
    key.fill(0);
  }
}

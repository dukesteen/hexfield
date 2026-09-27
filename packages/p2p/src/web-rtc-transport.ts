import { toBase64Url } from '@cp2p/codec';
import { identityFromSecret, parsePeerId } from '@cp2p/crypto';
import type { PeerId, ProtocolClock, Transport, Unsubscribe } from '@cp2p/protocol';
import { PeerLink } from './peer-link.js';
import type { SignalBlob } from './signaling.js';
import { signSignalEnvelope, validAttemptId, verifySignalEnvelope } from './signaling-envelope.js';
import type { EnvelopeSignalingAdapter, SignedSignalEnvelope } from './signaling-envelope.js';

const RETIRED_LIMIT = 64;
const SESSION_HISTORY_LIMIT = 64;
const REMOVED_PEER_HISTORY_LIMIT = 64;
const ATTEMPT_TIMEOUT_MS = 30_000;
const MANUAL_ATTEMPT_TIMEOUT_MS = 5 * 60_000;
const EARLY_CANDIDATE_MS = 5_000;
const EARLY_CANDIDATE_LIMIT = 8;
const REPLACEMENT_INTERVAL_MS = 250;
const AVAILABILITY_RETRY_INTERVAL_MS = 1_000;
const RETRY_MIN_MS = 250;
const RETRY_MAX_MS = 4_000;

interface LinkRecord {
  readonly link: PeerLink;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly attemptSeq: number;
  readonly origin: PeerId;
  timeout: unknown;
}

interface EarlyCandidates {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly attemptSeq: number;
  readonly blobs: SignalBlob[];
  readonly timeout: unknown;
}

interface DeferredOffer {
  readonly value: SignedSignalEnvelope;
  readonly timeout: unknown;
}

export type PeerCandidateRoute = 'host' | 'srflx' | 'relay' | 'unknown';

/** Address-free connection telemetry for a peer whose link authenticated locally. */
export interface WebRtcPeerStats {
  readonly peer: PeerId;
  readonly state: RTCPeerConnectionState;
  readonly rttMs: number | null;
  readonly route: PeerCandidateRoute;
}

interface StatsRecord {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly selected?: unknown;
  readonly nominated?: unknown;
  readonly state?: unknown;
  readonly localCandidateId?: unknown;
  readonly currentRoundTripTime?: unknown;
  readonly selectedCandidatePairId?: unknown;
  readonly candidateType?: unknown;
}

function connectionStatsRouteAndRtt(report: RTCStatsReport): {
  readonly route: PeerCandidateRoute;
  readonly rttMs: number | null;
} {
  const records: StatsRecord[] = [];
  report.forEach((record) => records.push(record));
  const byId = new Map(
    records.flatMap((record) =>
      typeof record.id === 'string' ? [[record.id, record] as const] : [],
    ),
  );
  const selectedTransport = records.find(
    (record) => record.type === 'transport' && typeof record.selectedCandidatePairId === 'string',
  );
  const selectedPairId = selectedTransport?.selectedCandidatePairId;
  const selectedPair = typeof selectedPairId === 'string' ? byId.get(selectedPairId) : undefined;
  const pair =
    selectedPair ??
    records.find(
      (record) =>
        record.type === 'candidate-pair' &&
        (record.selected === true || (record.nominated === true && record.state === 'succeeded')),
    );
  if (!pair) return { route: 'unknown', rttMs: null };
  const localCandidate =
    typeof pair.localCandidateId === 'string' ? byId.get(pair.localCandidateId) : undefined;
  const route =
    localCandidate?.candidateType === 'host' ||
    localCandidate?.candidateType === 'srflx' ||
    localCandidate?.candidateType === 'relay'
      ? localCandidate.candidateType
      : 'unknown';
  const seconds = pair.currentRoundTripTime;
  return {
    route,
    rttMs:
      typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
        ? Math.round(seconds * 1_000)
        : null,
  };
}

export interface WebRtcTransportOptions {
  readonly self: PeerId;
  readonly secretKey: Uint8Array;
  readonly roster: readonly PeerId[];
  readonly scope: string;
  readonly adapter: EnvelopeSignalingAdapter;
  readonly clock: ProtocolClock;
  readonly rtcFactory: (peer: PeerId, configuration: RTCConfiguration) => RTCPeerConnection;
  readonly iceServers?: readonly RTCIceServer[];
  readonly iceTransportPolicy?: RTCIceTransportPolicy;
  /** Defaults to 30 s. Null selects a finite 5-minute manual deadline on both roles. */
  readonly attemptTimeoutMs?: number | null;
  readonly randomBytes?: (length: number) => Uint8Array;
}

export interface CertifiedRosterUpdate {
  readonly head: { readonly seq: number; readonly hash: string };
  readonly activeDevices: readonly PeerId[];
  readonly catchupDevices: readonly PeerId[];
}

/** Full-mesh Transport; only authenticated PeerLinks become visible to protocol callers. */
export class WebRtcTransport implements Transport {
  readonly self: PeerId;
  private readonly secretKey: Uint8Array;
  private readonly expected: Set<PeerId>;
  private readonly sessionId: string;
  private readonly links = new Map<PeerId, LinkRecord>();
  private readonly pendingLinks = new Map<PeerId, LinkRecord>();
  private readonly deferredOffers = new Map<PeerId, DeferredOffer>();
  private readonly online = new Set<PeerId>();
  private readonly retired = new Map<PeerId, Set<string>>();
  private readonly offerHighwater = new Map<PeerId, Map<string, number>>();
  private readonly earlyCandidates = new Map<PeerId, EarlyCandidates>();
  private readonly lastReplacement = new Map<PeerId, number>();
  private readonly lastAvailabilityRetry = new Map<PeerId, number>();
  private readonly retries = new Map<PeerId, unknown>();
  private readonly retryDelay = new Map<PeerId, number>();
  private readonly manualDisconnects = new Set<PeerId>();
  private readonly removedPeerHistory = new Set<PeerId>();
  private readonly messageListeners = new Set<(from: PeerId, bytes: Uint8Array) => void>();
  private readonly relayListeners = new Set<(from: PeerId, bytes: Uint8Array) => void>();
  private readonly peerListeners = new Set<(peer: PeerId, online: boolean) => void>();
  private readonly diagnosticListeners = new Set<
    (peer: PeerId, reason: string, security: boolean) => void
  >();
  private readonly unsubscribe: Unsubscribe;
  private generation = 0;
  private nextAttemptSeq = 0;
  private started = false;
  private rosterFrozen = false;
  private certifiedRoster: {
    readonly head: CertifiedRosterUpdate['head'];
    readonly activeDevices: ReadonlySet<PeerId>;
    readonly catchupDevices: ReadonlySet<PeerId>;
  } | null = null;
  private disposed = false;

  constructor(private readonly options: WebRtcTransportOptions) {
    this.self = options.self;
    if (
      !options.scope ||
      options.scope.length > 128 ||
      options.roster.length < 1 ||
      options.roster.length > 6 ||
      new Set(options.roster).size !== options.roster.length ||
      !options.roster.includes(options.self) ||
      (options.attemptTimeoutMs !== undefined &&
        options.attemptTimeoutMs !== null &&
        (!Number.isSafeInteger(options.attemptTimeoutMs) || options.attemptTimeoutMs < 1))
    )
      throw new TypeError('Invalid WebRTC mesh roster or scope');
    for (const peer of options.roster) parsePeerId(peer);
    const identity = identityFromSecret(options.secretKey);
    try {
      if (identity.peerId !== options.self) throw new TypeError('Mesh key does not match self');
    } finally {
      identity.secretKey.fill(0);
    }
    this.secretKey = options.secretKey.slice();
    try {
      this.sessionId = this.randomId();
    } catch (error) {
      this.secretKey.fill(0);
      throw error;
    }
    this.expected = new Set(options.roster.filter((peer) => peer !== options.self));
    try {
      this.unsubscribe = options.adapter.onSignal((from, value) => this.receive(from, value));
    } catch (error) {
      this.secretKey.fill(0);
      throw error;
    }
  }

  /** Begin signaling every roster link; manual callers may connect one peer at a time. */
  start(): void {
    if (this.disposed) throw new Error('WebRTC transport is disposed');
    this.started = true;
    for (const peer of this.expected) if (this.self < peer) this.connect(peer);
  }

  /** Explicit lobby selection. Server room snapshots never call this automatically. */
  updatePreGameRoster(roster: readonly PeerId[]): void {
    if (this.disposed) throw new Error('WebRTC transport is disposed');
    if (this.rosterFrozen) throw new Error('WebRTC roster is frozen');
    this.applyRoster(roster);
  }

  /**
   * Changes connection admission after lobby freeze. The caller must supply routes verified
   * against certified game history; this transport does not verify certificates or game packets.
   */
  updateCertifiedRoster(update: CertifiedRosterUpdate): void {
    if (this.disposed) throw new Error('WebRTC transport is disposed');
    if (!this.rosterFrozen) throw new Error('WebRTC roster is not frozen');
    const { head, activeDevices, catchupDevices } = update;
    if (
      !head ||
      !Number.isSafeInteger(head.seq) ||
      head.seq < 0 ||
      typeof head.hash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(head.hash) ||
      !Array.isArray(activeDevices) ||
      !Array.isArray(catchupDevices) ||
      activeDevices.length < 1 ||
      activeDevices.length + catchupDevices.length > 6 ||
      ![...activeDevices, ...catchupDevices].includes(this.self) ||
      new Set([...activeDevices, ...catchupDevices]).size !==
        activeDevices.length + catchupDevices.length
    )
      throw new TypeError('Invalid certified WebRTC roster');
    const previous = this.certifiedRoster;
    const active = new Set(activeDevices);
    const catchup = new Set(catchupDevices);
    if (previous) {
      if (
        head.seq < previous.head.seq ||
        (head.seq === previous.head.seq && head.hash !== previous.head.hash)
      )
        throw new Error('Stale certified WebRTC roster');
      if (
        head.seq === previous.head.seq &&
        (active.size !== previous.activeDevices.size ||
          [...active].some((peer) => !previous.activeDevices.has(peer)) ||
          [...catchup].some((peer) => !previous.catchupDevices.has(peer)))
      )
        throw new Error('Conflicting certified WebRTC roster');
    }
    const roster = [...active, ...catchup];
    for (const peer of roster) parsePeerId(peer);
    // Link teardown notifies observers synchronously. Install the head before those callbacks
    // so a reentrant newer update cannot be overwritten by this one.
    this.certifiedRoster = {
      head: { seq: head.seq, hash: head.hash },
      activeDevices: active,
      catchupDevices: catchup,
    };
    this.applyRoster(roster);
  }

  private applyRoster(roster: readonly PeerId[]): void {
    if (
      !Array.isArray(roster) ||
      roster.length < 1 ||
      roster.length > 6 ||
      new Set(roster).size !== roster.length ||
      !roster.includes(this.self)
    )
      throw new TypeError('Invalid WebRTC mesh roster');
    for (const peer of roster) parsePeerId(peer);
    const next = new Set(roster.filter((peer) => peer !== this.self));
    const removed = [...this.expected].filter((peer) => !next.has(peer));
    const added = [...next].filter((peer) => !this.expected.has(peer));
    this.expected.clear();
    for (const peer of next) this.expected.add(peer);
    for (const peer of removed) {
      if (this.expected.has(peer)) continue;
      this.clearRetry(peer);
      this.clearEarly(peer);
      this.clearDeferred(peer);
      this.retirePending(peer);
      this.retireLink(peer);
      this.manualDisconnects.delete(peer);
      this.lastReplacement.delete(peer);
      this.lastAvailabilityRetry.delete(peer);
      this.retryDelay.delete(peer);
      this.removedPeerHistory.delete(peer);
      this.removedPeerHistory.add(peer);
    }
    for (const peer of added) {
      if (this.disposed) break;
      if (this.expected.has(peer) && this.started && this.self < peer) {
        try {
          this.connect(peer);
        } catch {
          this.scheduleRetry(peer);
        }
      }
    }
    this.trimRemovedPeerHistory();
  }

  roster(): readonly PeerId[] {
    return [this.self, ...this.expected].toSorted();
  }

  freezeRoster(): readonly PeerId[] {
    if (this.disposed) throw new Error('WebRTC transport is disposed');
    this.rosterFrozen = true;
    return this.roster();
  }

  /**
   * Retry a lost offer when signaling reports an already-admitted peer online. Server presence
   * grants no roster authority, and never replaces an authenticated or manually blocked link.
   */
  hintPeerAvailable(peer: PeerId): void {
    if (
      this.disposed ||
      !this.started ||
      !this.rosterFrozen ||
      !this.expected.has(peer) ||
      this.self > peer ||
      this.manualDisconnects.has(peer) ||
      this.online.has(peer)
    )
      return;
    const primary = this.links.get(peer);
    const pending = this.pendingLinks.get(peer);
    if (primary?.link.isAuthenticated || pending?.link.isAuthenticated) return;
    const now = this.options.clock.now();
    const previous = this.lastAvailabilityRetry.get(peer);
    if (previous !== undefined && now - previous < AVAILABILITY_RETRY_INTERVAL_MS) return;
    this.lastAvailabilityRetry.set(peer, now);
    this.retirePending(peer);
    this.retireLink(peer);
    try {
      this.connect(peer);
    } catch {
      this.scheduleRetry(peer);
    }
  }

  connect(peer: PeerId): void {
    this.assertPeer(peer);
    this.manualDisconnects.delete(peer);
    this.clearRetry(peer);
    if (this.links.has(peer) || this.pendingLinks.has(peer)) return;
    if (this.nextAttemptSeq >= Number.MAX_SAFE_INTEGER)
      throw new Error('Signaling attempt sequence exhausted');
    this.startLink(
      peer,
      this.freshAttemptId(peer),
      this.self,
      this.sessionId,
      ++this.nextAttemptSeq,
    );
  }

  peers(): PeerId[] {
    return [...this.links]
      .filter(([, record]) => record.link.isAuthenticated)
      .map(([peer]) => peer)
      .toSorted();
  }

  /** Read selected ICE route and RTT for authenticated peers; candidate addresses are omitted. */
  async peerStats(): Promise<readonly WebRtcPeerStats[]> {
    const authenticated = [...this.links.entries()].filter(
      ([, record]) => record.link.isAuthenticated,
    );
    const values = await Promise.all(
      authenticated.map(async ([peer, record]): Promise<WebRtcPeerStats | null> => {
        const pc = record.link.pc;
        const state = pc.connectionState;
        let route: PeerCandidateRoute = 'unknown';
        let rttMs: number | null = null;
        try {
          ({ route, rttMs } = connectionStatsRouteAndRtt(await pc.getStats()));
        } catch {
          /* State remains useful when browser stats are unavailable. */
        }
        if (this.links.get(peer) !== record || !record.link.isAuthenticated) return null;
        return { peer, state, route, rttMs };
      }),
    );
    return values.filter((value): value is WebRtcPeerStats => value !== null);
  }

  send(to: PeerId, message: Uint8Array): void {
    const record = this.links.get(to);
    if (!record?.link.isAuthenticated) throw new Error('Peer is not authenticated');
    record.link.send(message);
  }

  /** Explicit bulk path for snapshot/sync integration; ordinary Transport traffic stays on game. */
  sendBulk(to: PeerId, message: Uint8Array): void {
    const record = this.links.get(to);
    if (!record?.link.isAuthenticated) throw new Error('Peer is not authenticated');
    record.link.send(message, 'bulk');
  }

  /** Reserved signaling control path; never delivered to gameplay listeners. */
  sendRelayFrame(to: PeerId, message: Uint8Array): void {
    this.sendBulk(to, message);
  }

  onRelayFrame(listener: (from: PeerId, bytes: Uint8Array) => void): Unsubscribe {
    if (this.disposed) return () => undefined;
    this.relayListeners.add(listener);
    return () => this.relayListeners.delete(listener);
  }

  broadcast(message: Uint8Array): void {
    let firstError: unknown = null;
    for (const peer of this.peers()) {
      try {
        this.send(peer, message);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  onMessage(listener: (from: PeerId, message: Uint8Array) => void): Unsubscribe {
    if (this.disposed) return () => undefined;
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onPeerChange(listener: (peer: PeerId, online: boolean) => void): Unsubscribe {
    if (this.disposed) return () => undefined;
    this.peerListeners.add(listener);
    return () => {
      this.peerListeners.delete(listener);
    };
  }

  /** Reports local link failures; fingerprint failures stop automatic retries until connect(). */
  onDiagnostic(listener: (peer: PeerId, reason: string, security: boolean) => void): Unsubscribe {
    if (this.disposed) return () => undefined;
    this.diagnosticListeners.add(listener);
    return () => {
      this.diagnosticListeners.delete(listener);
    };
  }

  disconnect(peer: PeerId): void {
    this.assertPeer(peer);
    this.manualDisconnects.add(peer);
    this.clearRetry(peer);
    this.clearEarly(peer);
    this.clearDeferred(peer);
    this.retirePending(peer);
    this.retireLink(peer);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      try {
        this.unsubscribe();
      } catch {
        /* Continue closing owned resources. */
      }
      for (const peer of this.expected) {
        this.clearRetry(peer);
        this.clearEarly(peer);
        this.clearDeferred(peer);
        this.retirePending(peer);
        this.retireLink(peer);
      }
      this.options.adapter.close();
    } finally {
      this.secretKey.fill(0);
      this.messageListeners.clear();
      this.relayListeners.clear();
      this.peerListeners.clear();
      this.diagnosticListeners.clear();
    }
  }

  private receive(hint: PeerId, value: unknown): void {
    if (this.disposed) return;
    const signed = verifySignalEnvelope(value, this.options.scope, this.self, this.expected);
    if (!signed || signed.body.from !== hint) return;
    const { from, attemptId, sessionId, attemptSeq, blob } = signed.body;
    if (this.retired.get(from)?.has(attemptId) || this.manualDisconnects.has(from)) return;
    const primary = this.links.get(from);
    const pending = this.pendingLinks.get(from);
    let record = [primary, pending].find(
      (candidate) =>
        candidate?.attemptId === attemptId &&
        candidate.sessionId === sessionId &&
        candidate.attemptSeq === attemptSeq,
    );
    if (!record) {
      if (blob.kind === 'candidate') {
        this.bufferEarly(from, attemptId, sessionId, attemptSeq, blob);
        return;
      }
      const current = pending ?? primary;
      if (
        blob.description.type !== 'offer' ||
        (current && from !== current.origin && from > current.origin) ||
        !this.freshOffer(from, sessionId, attemptSeq)
      )
        return;
      const now = this.options.clock.now();
      const previous = this.lastReplacement.get(from);
      const replacing = current !== undefined;
      if (
        current &&
        from === current.origin &&
        previous !== undefined &&
        now - previous < REPLACEMENT_INTERVAL_MS
      ) {
        this.deferOffer(from, signed, previous + REPLACEMENT_INTERVAL_MS - now);
        return;
      }
      this.clearDeferred(from);
      this.retirePending(from);
      const keepPrimary = primary?.link.isAuthenticated || primary?.link.hasOpenedChannels;
      if (primary && !keepPrimary) this.retireLink(from);
      try {
        record = this.startLink(
          from,
          attemptId,
          from,
          sessionId,
          attemptSeq,
          keepPrimary ? 'pending' : 'primary',
        );
      } catch {
        return;
      }
      this.rememberOffer(from, sessionId, attemptSeq);
      if (replacing) this.lastReplacement.set(from, now);
    }
    if (!record) return;
    void record.link.receiveSignal(blob);
    if (blob.kind === 'description' && blob.description.type === 'offer') {
      const early = this.earlyCandidates.get(from);
      if (
        early?.attemptId === attemptId &&
        early.sessionId === sessionId &&
        early.attemptSeq === attemptSeq
      ) {
        this.clearEarly(from);
        for (const candidate of early.blobs) void record.link.receiveSignal(candidate);
      }
    }
  }

  private startLink(
    peer: PeerId,
    attemptId: string,
    origin: PeerId,
    sessionId: string,
    attemptSeq: number,
    slot: 'primary' | 'pending' = 'primary',
  ): LinkRecord {
    const generation = ++this.generation;
    let record: LinkRecord | null = null;
    const configuration: RTCConfiguration = {
      iceServers: [...(this.options.iceServers ?? [])],
      iceTransportPolicy: this.options.iceTransportPolicy ?? 'all',
    };
    const link = new PeerLink({
      self: this.self,
      peer,
      secretKey: this.secretKey,
      scope: this.options.scope,
      generation,
      offerMode: origin === peer ? 'answer-only' : 'auto',
      clock: this.options.clock,
      rtcFactory: () => this.options.rtcFactory(peer, configuration),
      ...(this.options.randomBytes ? { randomBytes: this.options.randomBytes } : {}),
      signal: (blob) => {
        if (!this.expected.has(peer) || this.disposed || this.manualDisconnects.has(peer))
          return Promise.reject(new Error('Peer is outside the active mesh roster'));
        return this.options.adapter.send(
          peer,
          signSignalEnvelope(
            {
              version: 1,
              scope: this.options.scope,
              from: this.self,
              to: peer,
              attemptId,
              sessionId,
              attemptSeq,
              blob,
            },
            this.secretKey,
          ),
        );
      },
      onMessage: (message) => {
        if (record && this.links.get(peer) === record && link.isAuthenticated) {
          const relay =
            message.length >= 5 &&
            message[0] === 0x48 &&
            message[1] === 0x58 &&
            message[2] === 0x52 &&
            message[3] === 0x31 &&
            message[4] === 0;
          for (const listener of relay ? this.relayListeners : this.messageListeners) {
            try {
              listener(peer, message.slice());
            } catch {
              /* Isolate observers. */
            }
          }
        }
      },
      onAuthenticated: () => {
        if (record && this.pendingLinks.get(peer) === record) {
          this.retireLink(peer);
          if (
            this.disposed ||
            this.manualDisconnects.has(peer) ||
            this.pendingLinks.get(peer) !== record ||
            !link.isAuthenticated
          )
            return;
          this.pendingLinks.delete(peer);
          this.links.set(peer, record);
        }
        if (record && this.links.get(peer) === record && !this.online.has(peer)) {
          this.clearAttemptTimeout(record);
          this.retryDelay.delete(peer);
          this.online.add(peer);
          for (const listener of this.peerListeners) {
            try {
              listener(peer, true);
            } catch {
              /* Isolate observers. */
            }
          }
        }
      },
      onDown: (reason) => {
        if (record) this.linkDown(peer, record, reason);
      },
    });
    record = { link, attemptId, sessionId, attemptSeq, origin, timeout: null };
    if (slot === 'pending') this.pendingLinks.set(peer, record);
    else this.links.set(peer, record);
    const timeoutMs =
      this.options.attemptTimeoutMs === null
        ? MANUAL_ATTEMPT_TIMEOUT_MS
        : (this.options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS);
    record.timeout = this.options.clock.setTimeout(() => {
      if (
        (this.links.get(peer) === record || this.pendingLinks.get(peer) === record) &&
        !link.isAuthenticated
      )
        link.close('attempt-timeout');
    }, timeoutMs);
    return record;
  }

  private linkDown(peer: PeerId, record: LinkRecord, reason: string): void {
    if (this.pendingLinks.get(peer) === record) {
      this.pendingLinks.delete(peer);
      this.clearAttemptTimeout(record);
      this.rememberRetired(peer, record.attemptId);
      this.emitDiagnostic(peer, reason);
      if (
        !this.links.has(peer) &&
        !this.disposed &&
        !this.manualDisconnects.has(peer) &&
        this.self < peer
      )
        this.scheduleRetry(peer);
      return;
    }
    if (this.links.get(peer) !== record) return;
    this.links.delete(peer);
    this.clearAttemptTimeout(record);
    this.rememberRetired(peer, record.attemptId);
    this.emitDown(peer);
    if (isSecurityReason(reason)) {
      this.manualDisconnects.add(peer);
      this.clearDeferred(peer);
      this.retirePending(peer);
    }
    this.emitDiagnostic(peer, reason);
    if (
      !this.disposed &&
      !this.manualDisconnects.has(peer) &&
      this.self < peer &&
      !this.pendingLinks.has(peer)
    )
      this.scheduleRetry(peer);
  }

  private emitDiagnostic(peer: PeerId, reason: string): void {
    for (const listener of this.diagnosticListeners) {
      try {
        listener(peer, reason, isSecurityReason(reason));
      } catch {
        /* Isolate observers. */
      }
    }
  }

  private retireLink(peer: PeerId): void {
    const record = this.links.get(peer);
    if (!record) return;
    this.links.delete(peer);
    this.clearAttemptTimeout(record);
    this.rememberRetired(peer, record.attemptId);
    record.link.close();
    this.emitDown(peer);
  }

  private retirePending(peer: PeerId): void {
    const record = this.pendingLinks.get(peer);
    if (!record) return;
    this.pendingLinks.delete(peer);
    this.clearAttemptTimeout(record);
    this.rememberRetired(peer, record.attemptId);
    record.link.close();
  }

  private emitDown(peer: PeerId): void {
    if (!this.online.delete(peer)) return;
    for (const listener of this.peerListeners) {
      try {
        listener(peer, false);
      } catch {
        /* Isolate observers. */
      }
    }
  }

  private rememberRetired(peer: PeerId, id: string): void {
    const seen = this.retired.get(peer) ?? new Set<string>();
    seen.add(id);
    if (seen.size > RETIRED_LIMIT) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    this.retired.set(peer, seen);
  }

  private freshOffer(peer: PeerId, sessionId: string, seq: number): boolean {
    const seen = this.offerHighwater.get(peer)?.get(sessionId);
    return seen === undefined || seq > seen;
  }

  private rememberOffer(peer: PeerId, sessionId: string, seq: number): void {
    const seen = this.offerHighwater.get(peer) ?? new Map<string, number>();
    seen.delete(sessionId);
    seen.set(sessionId, seq);
    if (seen.size > SESSION_HISTORY_LIMIT) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    this.offerHighwater.set(peer, seen);
  }

  private bufferEarly(
    peer: PeerId,
    attemptId: string,
    sessionId: string,
    attemptSeq: number,
    blob: SignalBlob & { kind: 'candidate' },
  ): void {
    if (!this.freshOffer(peer, sessionId, attemptSeq)) return;
    let pending = this.earlyCandidates.get(peer);
    if (
      pending &&
      (pending.attemptId !== attemptId ||
        pending.sessionId !== sessionId ||
        pending.attemptSeq !== attemptSeq)
    ) {
      this.clearEarly(peer);
      pending = undefined;
    }
    if (!pending) {
      const timeout = this.options.clock.setTimeout(
        () => this.clearEarly(peer),
        EARLY_CANDIDATE_MS,
      );
      pending = { attemptId, sessionId, attemptSeq, blobs: [], timeout };
      this.earlyCandidates.set(peer, pending);
    }
    if (pending.blobs.length < EARLY_CANDIDATE_LIMIT) pending.blobs.push(blob);
  }

  private clearEarly(peer: PeerId): void {
    const pending = this.earlyCandidates.get(peer);
    if (!pending) return;
    this.options.clock.clearTimeout(pending.timeout);
    this.earlyCandidates.delete(peer);
  }

  private deferOffer(peer: PeerId, value: SignedSignalEnvelope, waitMs: number): void {
    const previous = this.deferredOffers.get(peer);
    if (
      previous &&
      previous.value.body.sessionId === value.body.sessionId &&
      previous.value.body.attemptSeq >= value.body.attemptSeq
    )
      return;
    this.clearDeferred(peer);
    const timeout = this.options.clock.setTimeout(
      () => {
        if (this.deferredOffers.get(peer)?.value !== value) return;
        this.deferredOffers.delete(peer);
        this.receive(peer, value);
      },
      Math.max(1, waitMs),
    );
    this.deferredOffers.set(peer, { value, timeout });
  }

  private clearDeferred(peer: PeerId): void {
    const deferred = this.deferredOffers.get(peer);
    if (!deferred) return;
    this.options.clock.clearTimeout(deferred.timeout);
    this.deferredOffers.delete(peer);
  }

  private randomId(): string {
    const bytes = (this.options.randomBytes ?? defaultRandomBytes)(16);
    if (!(bytes instanceof Uint8Array) || bytes.length !== 16)
      throw new TypeError('Attempt ID source must provide 16 bytes');
    const id = toBase64Url(bytes);
    bytes.fill(0);
    return id;
  }

  private freshAttemptId(peer: PeerId): string {
    for (let tries = 0; tries < 4; tries++) {
      const id = this.randomId();
      if (
        validAttemptId(id) &&
        !this.retired.get(peer)?.has(id) &&
        this.links.get(peer)?.attemptId !== id
      )
        return id;
    }
    throw new Error('Attempt ID source repeated a recent ID');
  }

  private scheduleRetry(peer: PeerId): void {
    if (!this.expected.has(peer) || this.disposed || this.retries.has(peer)) return;
    const delay = this.retryDelay.get(peer) ?? RETRY_MIN_MS;
    this.retryDelay.set(peer, Math.min(delay * 2, RETRY_MAX_MS));
    this.retries.set(
      peer,
      this.options.clock.setTimeout(() => {
        this.retries.delete(peer);
        if (
          !this.disposed &&
          this.expected.has(peer) &&
          !this.manualDisconnects.has(peer) &&
          !this.links.has(peer) &&
          !this.pendingLinks.has(peer)
        ) {
          try {
            this.connect(peer);
          } catch {
            this.scheduleRetry(peer);
          }
        }
      }, delay),
    );
  }

  private clearRetry(peer: PeerId): void {
    const timer = this.retries.get(peer);
    if (timer !== undefined) this.options.clock.clearTimeout(timer);
    this.retries.delete(peer);
  }

  private clearAttemptTimeout(record: LinkRecord): void {
    if (record.timeout !== null) this.options.clock.clearTimeout(record.timeout);
    record.timeout = null;
  }

  private assertPeer(peer: PeerId): void {
    if (this.disposed) throw new Error('WebRTC transport is disposed');
    if (!this.expected.has(peer)) throw new Error('Unknown mesh peer');
  }

  private trimRemovedPeerHistory(): void {
    while (this.removedPeerHistory.size > REMOVED_PEER_HISTORY_LIMIT) {
      const oldest = this.removedPeerHistory.values().next().value;
      if (oldest === undefined) return;
      this.removedPeerHistory.delete(oldest);
      if (!this.expected.has(oldest)) {
        this.retired.delete(oldest);
        this.offerHighwater.delete(oldest);
      }
    }
  }
}

function defaultRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function isSecurityReason(reason: string): boolean {
  return reason === 'hello-binding' || reason === 'fingerprint-changed';
}

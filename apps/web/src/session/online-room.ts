import { hashValue, toHex } from '@cp2p/codec';
import { createBaseEngine } from '@cp2p/engine';
import { failure, success } from '@cp2p/engine';
import type { GameConfig, Result } from '@cp2p/engine';
import {
  answerManualOffer,
  createManualOffer,
  MeshRelaySignalingAdapter,
  readManualLobbyOffer,
  ServerSignalingAdapter,
  WebRtcTransport,
} from '@cp2p/p2p';
import type { ManualBridge, ManualOffer, WebRtcPeerStats } from '@cp2p/p2p';
import type { ServerSignalingOptions, WebRtcTransportOptions } from '@cp2p/p2p';
import { LobbyController } from '@cp2p/protocol';
import type {
  LobbyDiagnostic,
  LobbyFreezeAgreement,
  LobbyState,
  PeerId,
  ProtocolClock,
  Unsubscribe,
  EscrowCeremonyStore,
} from '@cp2p/protocol';
import { acquireGameWriterLease, IndexedDbByteStore } from '@cp2p/storage';
import type { GameWriterLease } from '@cp2p/storage';
import { loadOnlineIdentity, loadOrCreateOnlineIdentity } from './online-credentials.js';
import type { DisposableOnlineIdentity } from './online-credentials.js';
import { createRoomId, validateOnlineInvite } from './online-invite.js';
import type { OnlineInvite } from './online-invite.js';
import { OnlineStartup } from './online-startup.js';
import type { OnlineStartupSnapshot } from './online-startup.js';
import type { OnlineGame } from './online-game.js';
import { createOnlineLobbyTransport } from './online-lobby-transport.js';
import { loadOnlineGameRecord } from './online-game-records.js';
import type { SavedOnlineGameRecord } from './online-game-records.js';
import { planPregameRoster } from './online-room-roster.js';

export type OpenOnlineRoom =
  | {
      readonly kind: 'host';
      readonly serverUrl: string;
      readonly name: string;
      readonly hostName: string;
      readonly config: GameConfig;
    }
  | { readonly kind: 'join'; readonly invite: OnlineInvite }
  | { readonly kind: 'manual-join'; readonly offerCode: string }
  | { readonly kind: 'resume'; readonly gameId: string };

type SignalingStatus = Parameters<NonNullable<ServerSignalingOptions['onStatus']>>[0];

export interface OnlineRoomSnapshot {
  readonly invite: OnlineInvite;
  readonly self: PeerId;
  readonly signaling: SignalingStatus;
  readonly manual: ManualSnapshot;
  readonly peers: readonly PeerId[];
  readonly lobby: LobbyState | null;
  readonly agreement: LobbyFreezeAgreement | null;
  readonly diagnostic: LobbyDiagnostic | null;
  readonly connectionError: string | null;
  readonly startup: OnlineStartupSnapshot | null;
  readonly closed: boolean;
}

export interface ManualSnapshot {
  readonly phase: 'idle' | 'offering' | 'answering' | 'connected' | 'error';
  readonly code: string | null;
  readonly peer: PeerId | null;
  readonly gatheringComplete: boolean | null;
  readonly error: string | null;
}

const idleManual: ManualSnapshot = {
  phase: 'idle',
  code: null,
  peer: null,
  gatheringComplete: null,
  error: null,
};

export interface OnlineRoomRuntime {
  readonly store?: EscrowCeremonyStore;
  readonly clock?: ProtocolClock;
  readonly socketFactory?: ServerSignalingOptions['socketFactory'];
  readonly rtcFactory?: WebRtcTransportOptions['rtcFactory'];
  readonly manualRtcFactory?: () => RTCPeerConnection;
  readonly iceServers?: readonly RTCIceServer[];
  readonly iceTransportPolicy?: RTCIceTransportPolicy;
  readonly acquireLease?: typeof acquireGameWriterLease;
}

function createBrowserClock(): ProtocolClock {
  const epoch = Date.now();
  const started = performance.now();
  return {
    now: () => epoch + performance.now() - started,
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (handle) => {
      if (typeof handle === 'number') window.clearTimeout(handle);
    },
  };
}

function freezePublic(part: unknown): void {
  if (!part || typeof part !== 'object' || ArrayBuffer.isView(part)) return;
  for (const child of Object.values(part)) freezePublic(child);
  Object.freeze(part);
}

function detachedSnapshot(value: OnlineRoomSnapshot): OnlineRoomSnapshot {
  const detached = structuredClone(value);
  freezePublic(detached);
  return detached;
}

/** Owns the browser resources for one lobby, including its exclusive device lease. */
export class OnlineRoom {
  readonly lobby: LobbyController | null;
  private readonly unsubscribers: Unsubscribe[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly serverCandidates = new Map<PeerId, true>();
  private readonly manualCandidates = new Map<PeerId, ManualBridge>();
  private manualRetryPeer: PeerId | null = null;
  private snapshot: OnlineRoomSnapshot;
  private closing: Promise<void> | null = null;
  private readonly startup: OnlineStartup;
  private manualOffer: ManualOffer | null = null;
  private manualBridge: ManualBridge | null = null;
  private unsubscribeManualBridgeClose: Unsubscribe | null = null;
  private manualAccepting: {
    readonly code: string;
    readonly promise: Promise<Result<PeerId>>;
  } | null = null;
  private manualGeneration = 0;
  private frozenRoster = false;

  private constructor(
    readonly invite: OnlineInvite,
    private readonly identity: DisposableOnlineIdentity,
    private readonly lease: GameWriterLease,
    private readonly transport: WebRtcTransport,
    private readonly signaling: ServerSignalingAdapter | null,
    private readonly relay: MeshRelaySignalingAdapter,
    controller: LobbyController | null,
    resume: SavedOnlineGameRecord | null,
    private readonly ownedStore: IndexedDbByteStore | null,
    store: EscrowCeremonyStore,
    private readonly clock: ProtocolClock,
    private readonly manualRtcFactory: () => RTCPeerConnection,
  ) {
    this.lobby = controller;
    this.snapshot = detachedSnapshot({
      invite: { ...invite },
      self: identity.peerId,
      signaling: { state: 'connecting' },
      manual: idleManual,
      peers: [],
      lobby: null,
      agreement: null,
      diagnostic: null,
      connectionError: null,
      startup: null,
      closed: false,
    });
    const common = { invite, identity, transport, store, clock, engine: createBaseEngine() };
    this.startup = new OnlineStartup(
      resume
        ? { ...common, resume }
        : {
            ...common,
            lobby: requiredLobby(controller),
            freezePeers: (peers) => {
              transport.updatePreGameRoster(peers);
              transport.freezeRoster();
              this.frozenRoster = true;
            },
          },
    );
    this.unsubscribers.push(
      this.startup.subscribe(() => this.refresh()),
      transport.onPeerChange((peer, online) => {
        if (
          online &&
          this.snapshot.manual.peer === peer &&
          this.snapshot.manual.phase === 'answering'
        )
          this.update({ manual: { ...this.snapshot.manual, phase: 'connected', code: null } });
        this.refresh();
      }),
      transport.onDiagnostic((_peer, reason) => this.update({ connectionError: reason })),
    );
    if (controller) {
      this.unsubscribers.push(
        controller.onChange(() => this.refresh()),
        controller.onDiagnostic(() => this.refresh()),
        ...(signaling ? [signaling.onRoomPeers((peers) => this.discover(peers))] : []),
      );
    }
    this.refresh();
  }

  static async open(request: OpenOnlineRoom, runtime: OnlineRoomRuntime = {}): Promise<OnlineRoom> {
    const ownedStore = runtime.store ? null : new IndexedDbByteStore();
    const store = runtime.store ?? ownedStore;
    if (!store) throw new Error('Online storage is unavailable');
    let identity: DisposableOnlineIdentity | null = null;
    let lease: GameWriterLease | null = null;
    let signaling: ServerSignalingAdapter | null = null;
    let relay: MeshRelaySignalingAdapter | null = null;
    let transport: WebRtcTransport | null = null;
    let controller: LobbyController | null = null;
    let room: OnlineRoom | null = null;
    try {
      identity =
        request.kind === 'resume'
          ? await loadOnlineIdentity(store)
          : await loadOrCreateOnlineIdentity(store);
      const resume =
        request.kind === 'resume' ? await loadOnlineGameRecord(store, request.gameId) : null;
      let inviteSource: OnlineInvite;
      if (request.kind === 'resume') {
        if (!resume) throw new Error('Saved online game is missing');
        inviteSource = resume.invite;
      } else if (request.kind === 'join') inviteSource = request.invite;
      else if (request.kind === 'manual-join') {
        const hint = await readManualLobbyOffer(request.offerCode);
        if (hint.to) throw new Error('A reconnect code requires the saved room on this device');
        inviteSource = { roomId: hint.roomId, hostPeer: hint.from, serverUrl: '' };
      } else
        inviteSource = {
          roomId: createRoomId(),
          hostPeer: identity.peerId,
          serverUrl: request.serverUrl,
        };
      const invite = validateOnlineInvite(inviteSource);
      const frozenPeers = resume?.agreement.state.seats.flatMap((seat) =>
        seat.kind === 'human' ? [seat.peer] : [],
      );
      if (resume && !frozenPeers?.includes(identity.peerId))
        throw new Error('This device does not own a human seat in the saved game');
      const scope = `lobby:${invite.roomId}`;
      const leaseId = `lobby-${toHex(hashValue({ server: invite.serverUrl, room: invite.roomId }))}`;
      lease = await (runtime.acquireLease ?? acquireGameWriterLease)(leaseId, identity.peerId);
      if (!lease) throw new Error('This lobby is already open in another tab');
      const clock = runtime.clock ?? createBrowserClock();
      let status: SignalingStatus = { state: 'connecting' };
      signaling = invite.serverUrl
        ? new ServerSignalingAdapter({
            serverUrl: invite.serverUrl,
            roomId: invite.roomId,
            self: identity.peerId,
            secretKey: identity.secretKey,
            clock,
            ...(runtime.socketFactory ? { socketFactory: runtime.socketFactory } : {}),
            onStatus(value) {
              status = value;
              room?.update({ signaling: value });
            },
          })
        : null;
      relay = new MeshRelaySignalingAdapter(identity.peerId, scope, clock, signaling);
      transport = new WebRtcTransport({
        self: identity.peerId,
        secretKey: identity.secretKey,
        roster: frozenPeers ?? [...new Set([identity.peerId, invite.hostPeer])],
        scope,
        clock,
        adapter: relay,
        rtcFactory: runtime.rtcFactory ?? ((_peer, config) => new RTCPeerConnection(config)),
        iceServers: runtime.iceServers ?? [],
        iceTransportPolicy: runtime.iceTransportPolicy ?? 'all',
      });
      relay.attachTransport(transport);
      if (resume) transport.freezeRoster();
      else {
        const common = {
          lobbyId: invite.roomId,
          transport: createOnlineLobbyTransport(transport),
          clock,
          secretKey: identity.secretKey,
        };
        const created =
          request.kind === 'host'
            ? LobbyController.createHost({
                ...common,
                name: request.name,
                hostName: request.hostName,
                config: request.config,
                takeover: { mode: 'vote', afterSeconds: 'never' },
              })
            : LobbyController.join({ ...common, hostPeer: invite.hostPeer });
        if (!created.ok) throw new Error(created.error.message);
        controller = created.value;
      }
      room = new OnlineRoom(
        invite,
        identity,
        lease,
        transport,
        signaling,
        relay,
        controller,
        resume,
        ownedStore,
        store,
        clock,
        runtime.manualRtcFactory ??
          (() =>
            new RTCPeerConnection({
              iceServers: [...(runtime.iceServers ?? [])],
              iceTransportPolicy: runtime.iceTransportPolicy ?? 'all',
            })),
      );
      room.update({ signaling: status });
      if (request.kind === 'manual-join') {
        const answered = await room.answerManualOffer(request.offerCode);
        if (!answered.ok) throw new Error(answered.error.message);
      } else if (signaling || request.kind === 'host') transport.start();
      return room;
    } catch (error) {
      if (room) {
        await room.close();
        throw error;
      }
      try {
        controller?.dispose();
      } finally {
        try {
          if (transport) transport.dispose();
          else if (relay) relay.close();
          else signaling?.close();
        } finally {
          identity?.dispose();
          try {
            await lease?.close();
          } finally {
            await ownedStore?.close();
          }
        }
      }
      throw error;
    }
  }

  getSnapshot = (): OnlineRoomSnapshot => this.snapshot;

  startGame = () => this.startup.begin();

  retryStart = () => this.startup.retryFailed();

  getGame = (): OnlineGame | null => this.startup.game();

  getPeerStats = (): Promise<readonly WebRtcPeerStats[]> => this.transport.peerStats();

  /** One signed offer, reusable byte-for-byte until cancelled or answered. */
  async startManualInvitation(
    to?: PeerId,
  ): Promise<Result<{ code: string; gatheringComplete: boolean }>> {
    if (this.manualOffer && this.snapshot.manual.peer === (to ?? null) && this.snapshot.manual.code)
      return success({
        code: this.snapshot.manual.code,
        gatheringComplete: this.manualOffer.gatheringComplete,
      });
    if (
      this.snapshot.closed ||
      this.manualOffer ||
      this.snapshot.manual.phase === 'offering' ||
      this.snapshot.manual.phase === 'answering'
    )
      return failure('manual-busy', 'A manual invitation is already active');
    const state = this.lobby?.state();
    const allowed = to
      ? this.transport.roster().includes(to) && to !== this.identity.peerId
      : !!state &&
        state.status === 'open' &&
        state.hostPeer === this.identity.peerId &&
        !this.startup.agreement();
    if (!allowed) return failure('manual-roster', 'Manual invitation target is not permitted');
    const generation = ++this.manualGeneration;
    this.update({
      manual: {
        phase: 'offering',
        code: null,
        peer: to ?? null,
        gatheringComplete: null,
        error: null,
      },
    });
    try {
      const offer = await createManualOffer({
        self: this.identity.peerId,
        secretKey: this.identity.secretKey,
        scope: `lobby:${this.invite.roomId}`,
        clock: this.clock,
        rtcFactory: this.manualRtcFactory,
        ...(to ? { to } : {}),
      });
      if (this.snapshot.closed || generation !== this.manualGeneration) {
        offer.close();
        return failure('manual-cancelled', 'Manual invitation was cancelled');
      }
      this.manualOffer = offer;
      this.update({
        manual: {
          phase: 'offering',
          code: offer.code,
          peer: to ?? null,
          gatheringComplete: offer.gatheringComplete,
          error: null,
        },
      });
      return success({ code: offer.code, gatheringComplete: offer.gatheringComplete });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Manual invitation failed';
      if (generation === this.manualGeneration)
        this.update({
          manual: {
            phase: 'error',
            code: null,
            peer: to ?? null,
            gatheringComplete: null,
            error: message,
          },
        });
      return failure('manual-offer', message);
    }
  }

  acceptManualAnswer(code: string): Promise<Result<PeerId>> {
    const pending = this.manualAccepting;
    if (pending)
      return pending.code === code
        ? pending.promise
        : Promise.resolve(failure('manual-busy', 'A different manual answer is already active'));
    const attempt = { code, promise: this.acceptManualAnswerOnce(code) };
    this.manualAccepting = attempt;
    void attempt.promise.finally(() => {
      if (this.manualAccepting === attempt) this.manualAccepting = null;
    });
    return attempt.promise;
  }

  private async acceptManualAnswerOnce(code: string): Promise<Result<PeerId>> {
    const offer = this.manualOffer;
    if (!offer || this.snapshot.closed)
      return failure('manual-offer-missing', 'No manual invitation is active');
    const generation = this.manualGeneration;
    let bridge: ManualBridge | null = null;
    let attached = false;
    try {
      bridge = await offer.acceptAnswer(code);
      if (this.snapshot.closed || offer !== this.manualOffer) {
        bridge.close();
        return failure('manual-cancelled', 'Manual invitation was cancelled');
      }
      const peer = bridge.peer;
      if (!this.transport.roster().includes(peer)) {
        const state = this.lobby?.state();
        if (
          !state ||
          state.hostPeer !== this.identity.peerId ||
          state.status !== 'open' ||
          this.startup.agreement()
        ) {
          this.cancelManualInvitation();
          return failure('manual-roster', 'This room cannot admit another device');
        }
        this.relay.addBridge(bridge);
        attached = true;
        try {
          this.manualCandidates.set(peer, bridge);
          this.refresh();
          if (!this.transport.roster().includes(peer))
            throw new Error('This room has no connection slot for another device');
          this.manualRetryPeer = peer;
        } catch (error) {
          this.manualCandidates.delete(peer);
          this.relay.removeBridge(peer);
          throw error;
        }
      } else {
        this.relay.addBridge(bridge);
        attached = true;
        this.manualCandidates.set(peer, bridge);
        this.manualRetryPeer = peer;
      }
      this.manualOffer = null;
      this.update({
        manual: {
          phase: this.transport.peers().includes(peer) ? 'connected' : 'answering',
          code: null,
          peer,
          gatheringComplete: offer.gatheringComplete,
          error: null,
        },
      });
      this.observeManualBridge(bridge, generation);
      this.transport.start();
      this.transport.connect(peer);
      return success(peer);
    } catch (error) {
      if (bridge) {
        if (attached) this.relay.removeBridge(bridge.peer);
        else bridge.close();
      }
      const message = error instanceof Error ? error.message : 'Manual answer failed';
      if (!this.snapshot.closed && generation === this.manualGeneration)
        this.update({ manual: { ...this.snapshot.manual, phase: 'error', error: message } });
      return failure('manual-answer', message);
    }
  }

  async answerManualOffer(
    code: string,
  ): Promise<Result<{ code: string; peer: PeerId; gatheringComplete: boolean }>> {
    if (this.snapshot.closed || this.snapshot.manual.phase === 'answering' || this.manualOffer)
      return failure('manual-busy', 'Manual answer is already active');
    const generation = ++this.manualGeneration;
    let bridge: ManualBridge | null = null;
    let attached = false;
    this.update({
      manual: { phase: 'answering', code: null, peer: null, gatheringComplete: null, error: null },
    });
    try {
      const answer = await answerManualOffer(
        {
          self: this.identity.peerId,
          secretKey: this.identity.secretKey,
          scope: `lobby:${this.invite.roomId}`,
          clock: this.clock,
          rtcFactory: this.manualRtcFactory,
        },
        code,
      );
      bridge = answer.bridge;
      if (
        this.snapshot.closed ||
        generation !== this.manualGeneration ||
        !this.transport.roster().includes(answer.peer)
      ) {
        answer.bridge.close();
        if (!this.snapshot.closed && generation === this.manualGeneration)
          this.update({
            manual: {
              phase: 'error',
              code: null,
              peer: null,
              gatheringComplete: null,
              error: 'Manual offer is outside the room roster',
            },
          });
        return failure('manual-roster', 'Manual offer is outside the room roster');
      }
      this.relay.addBridge(answer.bridge);
      attached = true;
      this.manualCandidates.set(answer.peer, answer.bridge);
      this.update({
        manual: {
          phase: this.transport.peers().includes(answer.peer) ? 'connected' : 'answering',
          code: this.transport.peers().includes(answer.peer) ? null : answer.code,
          peer: answer.peer,
          gatheringComplete: answer.gatheringComplete,
          error: null,
        },
      });
      this.observeManualBridge(answer.bridge, generation);
      this.transport.start();
      this.transport.connect(answer.peer);
      return success({
        code: answer.code,
        peer: answer.peer,
        gatheringComplete: answer.gatheringComplete,
      });
    } catch (error) {
      if (bridge) {
        if (attached) this.relay.removeBridge(bridge.peer);
        else bridge.close();
      }
      const message = error instanceof Error ? error.message : 'Manual offer could not be answered';
      if (generation === this.manualGeneration)
        this.update({
          manual: {
            phase: 'error',
            code: null,
            peer: null,
            gatheringComplete: null,
            error: message,
          },
        });
      return failure('manual-answer', message);
    }
  }

  cancelManualInvitation(): void {
    ++this.manualGeneration;
    this.manualAccepting = null;
    this.manualOffer?.close();
    this.manualOffer = null;
    if (
      this.manualBridge &&
      this.snapshot.manual.phase === 'answering' &&
      !this.transport.peers().includes(this.manualBridge.peer)
    )
      this.relay.removeBridge(this.manualBridge.peer);
    this.unsubscribeManualBridgeClose?.();
    this.unsubscribeManualBridgeClose = null;
    this.manualBridge = null;
    if (!this.snapshot.closed && !this.closing) {
      this.refresh();
      this.update({ manual: idleManual });
    }
  }

  private observeManualBridge(bridge: ManualBridge, generation: number): void {
    this.unsubscribeManualBridgeClose?.();
    this.manualBridge = bridge;
    this.unsubscribeManualBridgeClose = bridge.onClose(() => {
      if (this.manualCandidates.get(bridge.peer) === bridge) {
        this.manualCandidates.delete(bridge.peer);
        this.refresh();
      }
      if (this.manualBridge !== bridge) return;
      this.manualBridge = null;
      this.unsubscribeManualBridgeClose = null;
      const manual = this.snapshot.manual;
      if (
        this.snapshot.closed ||
        generation !== this.manualGeneration ||
        manual.phase !== 'answering' ||
        manual.peer !== bridge.peer ||
        this.transport.peers().includes(bridge.peer)
      )
        return;
      this.update({
        manual: {
          phase: 'error',
          code: null,
          peer: null,
          gatheringComplete: null,
          error: 'Manual bootstrap connection closed before the game connection was ready',
        },
      });
    });
  }

  subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Publish the promise before notifying views, which may call close again.
    this.closing = Promise.resolve().then(() => this.releaseResources());
    this.cancelManualInvitation();
    this.update({ closed: true });
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.listeners.clear();
    this.serverCandidates.clear();
    this.manualCandidates.clear();
    this.manualRetryPeer = null;
    return this.closing;
  }

  private async releaseResources(): Promise<void> {
    try {
      try {
        await this.startup.close();
      } finally {
        try {
          this.lobby?.dispose();
        } finally {
          try {
            this.transport.dispose();
          } finally {
            this.identity.dispose();
          }
        }
      }
    } finally {
      try {
        await this.lease.close();
      } finally {
        await this.ownedStore?.close();
      }
    }
  }

  private discover(peers: readonly PeerId[] | null): void {
    const state = this.lobby?.state();
    if (
      this.snapshot.closed ||
      this.closing ||
      this.startup.agreement() ||
      (state && state.status !== 'open')
    )
      return;
    const current = new Set(peers ?? []);
    for (const peer of this.serverCandidates.keys())
      if (!current.has(peer)) this.serverCandidates.delete(peer);
    for (const peer of current) this.serverCandidates.set(peer, true);
    this.refresh();
  }

  private refresh(): void {
    if (this.snapshot.closed || this.closing) return;
    const agreement = this.startup.agreement() ?? this.lobby?.freezeAgreement() ?? null;
    const state = this.lobby?.state();
    if (this.lobby && !this.frozenRoster && !agreement && (!state || state.status === 'open'))
      this.syncPregameRoster(state ?? null);
    this.update({
      peers: this.transport.peers(),
      lobby: agreement?.state ?? state ?? null,
      agreement,
      startup: this.startup.snapshot(),
      diagnostic: this.lobby?.getDiagnostic() ?? null,
    });
  }

  private syncPregameRoster(state: LobbyState | null): void {
    for (const [peer, bridge] of this.manualCandidates)
      if (bridge.isClosed || !this.relay.hasBridge(peer)) this.manualCandidates.delete(peer);
    const roster = planPregameRoster({
      self: this.identity.peerId,
      host: state?.hostPeer ?? this.invite.hostPeer,
      seated: state?.seats.flatMap((seat) => (seat.kind === 'human' ? [seat.peer] : [])) ?? [],
      connected: this.transport.peers(),
      spectators: state?.spectators ?? [],
      transient: [
        ...[...this.manualCandidates.keys()].toReversed(),
        ...[...this.serverCandidates.keys()].toReversed(),
        ...(this.manualRetryPeer ? [this.manualRetryPeer] : []),
      ],
    });
    const current = this.transport.roster();
    if (current.length !== roster.length || roster.some((peer) => !current.includes(peer)))
      this.transport.updatePreGameRoster(roster);
    if (this.manualRetryPeer && !roster.includes(this.manualRetryPeer)) this.manualRetryPeer = null;
    for (const peer of this.manualCandidates.keys()) {
      if (roster.includes(peer)) continue;
      this.manualCandidates.delete(peer);
      this.relay.removeBridge(peer);
    }
  }

  private update(patch: Partial<OnlineRoomSnapshot>): void {
    this.snapshot = detachedSnapshot({ ...this.snapshot, ...patch });
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* A view cannot interrupt network or lease cleanup. */
      }
    }
  }
}

function requiredLobby(value: LobbyController | null): LobbyController {
  if (!value) throw new Error('Fresh online room has no lobby controller');
  return value;
}

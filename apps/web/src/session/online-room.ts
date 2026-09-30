import { hashValue, toHex } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { GameConfig, Result, Seat } from '@cp2p/engine';
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
import { genesisDigest, LobbyController } from '@cp2p/protocol';
import type {
  LobbyDiagnostic,
  LobbyFreezeAgreement,
  LobbySeatRequest,
  LobbyState,
  PeerId,
  ProtocolClock,
  Unsubscribe,
  EscrowCeremonyStore,
  GameSession,
} from '@cp2p/protocol';
import { acquireGameWriterLease, IndexedDbByteStore } from '@cp2p/storage';
import type { GameWriterLease } from '@cp2p/storage';
import type { VaultOwnerLease } from '@cp2p/storage';
import { loadOnlineIdentity, loadOrCreateOnlineIdentity } from './online-credentials.js';
import type { DisposableOnlineIdentity } from './online-credentials.js';
import { createRoomId, validateOnlineInvite } from './online-invite.js';
import type { OnlineInvite } from './online-invite.js';
import { OnlineWorkerStartup } from './online-worker-startup.js';
import { OnlineWorkerClient } from './online-worker-client.js';
import type { OnlineProtocolWorkerPort } from './online-worker-client.js';
import type {
  OnlineWorkerInitialization,
  OnlineWorkerResumeInfo,
} from './online-worker-messages.js';
import { UnsupportedOnlineGameVersionError } from './online-game-records.js';
import type { OnlineStartupSnapshot } from './online-startup.js';
import type { OnlineGame } from './online-game.js';
import type { OnlineDeviceRoutes } from './online-game-transport.js';
import { OnlineTransferBrowser } from './online-transfer-browser.js';
import type { OnlineTransferLinkOptions } from './online-transfer-link.js';
import {
  createOnlineLobbyTransport,
  createOnlineNonChatTransport,
} from './online-lobby-transport.js';
import { OnlineChat } from './online-chat.js';
import type { ChatContent, ChatSnapshot } from './online-chat.js';
import { planPregameRoster } from './online-room-roster.js';
import { getOnlineVaultController } from './online-vault-controller.js';
import type { OnlineVaultController } from './online-vault-controller.js';

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
  /** This device's own Take seat request while the host has not seated it. */
  readonly seatRequest?: LobbySeatRequest | null;
  readonly connectionError: string | null;
  readonly startup: OnlineStartupSnapshot | null;
  readonly chat?: ChatSnapshot;
  readonly deviceRoutes?: OnlineDeviceRoutes;
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

function humanChatPeers(state: LobbyState): PeerId[] {
  return state.seats.flatMap((seat) => (seat.kind === 'human' ? [seat.peer] : []));
}

function requiredVault(value: VaultOwnerLease | null): VaultOwnerLease {
  if (!value) throw new Error('Online vault owner is unavailable');
  return value;
}

export interface OnlineRoomRuntime {
  readonly store?: EscrowCeremonyStore;
  readonly clock?: ProtocolClock;
  readonly socketFactory?: ServerSignalingOptions['socketFactory'];
  readonly rtcFactory?: WebRtcTransportOptions['rtcFactory'];
  readonly manualRtcFactory?: () => RTCPeerConnection;
  readonly iceServers?: readonly RTCIceServer[];
  readonly iceTransportPolicy?: RTCIceTransportPolicy;
  readonly acquireLease?: typeof acquireGameWriterLease;
  readonly workerFactory?: () => OnlineProtocolWorkerPort;
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
  private readonly signalingPresent = new Set<PeerId>();
  private readonly manualCandidates = new Map<PeerId, ManualBridge>();
  private manualRetryPeer: PeerId | null = null;
  private snapshot: OnlineRoomSnapshot;
  private closing: Promise<void> | null = null;
  private readonly startup: OnlineWorkerStartup;
  private readonly chat: OnlineChat;
  private chatAllowedPeers: readonly PeerId[] = [];
  private readonly resumedChatState: LobbyState | null;
  private readonly resumedPeers: readonly PeerId[] | null;
  private activeGamePeers: readonly PeerId[] | null = null;
  private chatSwitching = false;
  private chatSwitchFailed = false;
  private manualOffer: ManualOffer | null = null;
  private manualBridge: ManualBridge | null = null;
  private unsubscribeManualBridgeClose: Unsubscribe | null = null;
  private manualAccepting: {
    readonly code: string;
    readonly promise: Promise<Result<PeerId>>;
  } | null = null;
  private manualGeneration = 0;
  private frozenRoster = false;
  private lobbyDetached = false;
  private transfer: OnlineTransferBrowser | null = null;
  private transferOpening: Promise<OnlineTransferBrowser> | null = null;
  private transferOpeningTarget: { readonly seat: Seat; readonly mode: 'live' | 'return' } | null =
    null;

  private constructor(
    readonly invite: OnlineInvite,
    private readonly identity: DisposableOnlineIdentity,
    private readonly lease: GameWriterLease,
    private readonly transport: WebRtcTransport,
    private readonly signaling: ServerSignalingAdapter | null,
    private readonly relay: MeshRelaySignalingAdapter,
    controller: LobbyController | null,
    resume: OnlineWorkerResumeInfo | null,
    private readonly ownedStore: IndexedDbByteStore | null,
    private readonly vaultController: OnlineVaultController | null,
    private readonly vaultScope: VaultOwnerLease | null,
    private readonly store: EscrowCeremonyStore,
    private readonly clock: ProtocolClock,
    private readonly manualRtcFactory: () => RTCPeerConnection,
    createWorkerClient: () => OnlineWorkerClient,
    worker: { client: OnlineWorkerClient; initialization: OnlineWorkerInitialization } | null,
  ) {
    this.lobby = controller;
    this.resumedChatState = resume?.agreement.state ?? null;
    this.resumedPeers = resume?.peers ?? null;
    const initialState = this.resumedChatState ?? controller?.state();
    this.chatAllowedPeers = resume
      ? [...resume.peers]
      : initialState
        ? [...humanChatPeers(initialState), ...initialState.spectators]
        : [];
    this.chat = new OnlineChat({
      transport,
      clock,
      store,
      secretKey: identity.secretKey,
      scope: resume
        ? { kind: 'game', roomId: invite.roomId, genesisDigest: resume.genesisDigest }
        : { kind: 'lobby', roomId: invite.roomId },
      allowedSenders: () => this.chatAllowedPeers,
    });
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
      chat: this.chat.snapshot(),
      closed: false,
    });
    const common = {
      invite,
      self: identity.peerId,
      transport: createOnlineNonChatTransport(transport),
      clock,
      createClient: createWorkerClient,
      onDeviceRoutes: (routes: import('./online-game-transport.js').OnlineDeviceRoutes) => {
        if (this.closing || this.snapshot.closed) return;
        transport.updateCertifiedRoster(routes);
        this.activeGamePeers = [...routes.activeDevices];
        this.update({ deviceRoutes: routes });
        this.refresh();
      },
      ...worker,
    };
    this.startup = new OnlineWorkerStartup(
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
      this.chat.subscribe(() => this.refresh()),
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
    if (signaling) this.unsubscribers.push(signaling.onRoomPeers((peers) => this.discover(peers)));
    if (controller) {
      this.unsubscribers.push(
        controller.onChange(() => this.refresh()),
        controller.onDiagnostic(() => this.refresh()),
        controller.onSeatRequest(() => this.refresh()),
      );
    }
    void this.chat.start().catch(() => this.refresh());
    this.refresh();
  }

  static async open(request: OpenOnlineRoom, runtime: OnlineRoomRuntime = {}): Promise<OnlineRoom> {
    let room: OnlineRoom | null = null;
    let scopeCancelled = false;
    let settleOpen!: () => void;
    const openSettled = new Promise<void>((resolve) => {
      settleOpen = resolve;
    });
    const vaultController = runtime.store ? null : getOnlineVaultController();
    let vaultScope: VaultOwnerLease | null = null;
    let ownedStore: IndexedDbByteStore | null = null;
    let store: EscrowCeremonyStore | null = runtime.store ?? null;
    let identity: DisposableOnlineIdentity | null = null;
    let lease: GameWriterLease | null = null;
    let signaling: ServerSignalingAdapter | null = null;
    let relay: MeshRelaySignalingAdapter | null = null;
    let transport: WebRtcTransport | null = null;
    let controller: LobbyController | null = null;
    let worker: { client: OnlineWorkerClient; initialization: OnlineWorkerInitialization } | null =
      null;
    let workerClient: OnlineWorkerClient | null = null;
    const checkOpen = () => {
      if (scopeCancelled) throw new Error('Online room closed while opening');
      vaultScope?.assertActive();
    };
    const createWorkerClient = () => {
      checkOpen();
      const handoff = vaultScope?.handoff();
      return new OnlineWorkerClient({
        ...(runtime.workerFactory ? { worker: runtime.workerFactory() } : {}),
        ...(handoff ? { vaultHandoff: handoff } : {}),
      });
    };
    try {
      vaultScope = vaultController
        ? await vaultController.acquireScope(async () => {
            scopeCancelled = true;
            if (room) {
              await room.close();
              return;
            }
            workerClient?.fail(new Error('Local vault locked during room opening'));
            controller?.dispose();
            if (transport) transport.dispose();
            else if (relay) relay.close();
            else signaling?.close();
            identity?.dispose();
            try {
              await lease?.close();
            } finally {
              await ownedStore?.close();
            }
            await openSettled;
          })
        : null;
      ownedStore = runtime.store
        ? null
        : new IndexedDbByteStore({ vault: requiredVault(vaultScope) });
      store = runtime.store ?? ownedStore;
      if (!store) throw new Error('Online storage is unavailable');
      checkOpen();
      identity =
        request.kind === 'resume'
          ? await loadOnlineIdentity(store)
          : await loadOrCreateOnlineIdentity(store);
      checkOpen();
      if (request.kind === 'resume') {
        workerClient = createWorkerClient();
        const initialized = await workerClient.request({
          kind: 'initialize',
          mode: 'resume',
          self: identity.peerId,
          gameId: request.gameId,
        });
        checkOpen();
        if (!initialized.ok) {
          if (
            initialized.error.code === 'unsupported-version' &&
            'savedVersion' in initialized.error &&
            typeof initialized.error.savedVersion === 'number'
          )
            throw new UnsupportedOnlineGameVersionError(initialized.error.savedVersion);
          throw new Error(initialized.error.message);
        }
        if (initialized.value.self !== identity.peerId)
          throw new Error('Saved online game device identity differs');
        worker = { client: workerClient, initialization: initialized.value };
      }
      const resume = worker?.initialization.resume ?? null;
      let inviteSource: OnlineInvite;
      if (request.kind === 'resume') {
        if (!resume || !worker) throw new Error('Saved online game is missing');
        inviteSource = worker.initialization.invite;
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
      const frozenPeers = resume?.peers;
      if (resume && !frozenPeers?.includes(identity.peerId))
        throw new Error('This device does not own a human seat in the saved game');
      const scope = `lobby:${invite.roomId}`;
      const leaseId = `lobby-${toHex(hashValue({ server: invite.serverUrl, room: invite.roomId }))}`;
      lease = await (runtime.acquireLease ?? acquireGameWriterLease)(leaseId, identity.peerId);
      checkOpen();
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
                takeover: { mode: 'vote', afterSeconds: 120 },
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
        vaultController,
        vaultScope,
        store,
        clock,
        runtime.manualRtcFactory ??
          (() =>
            new RTCPeerConnection({
              iceServers: [...(runtime.iceServers ?? [])],
              iceTransportPolicy: runtime.iceTransportPolicy ?? 'all',
            })),
        createWorkerClient,
        worker,
      );
      room.update({ signaling: status });
      checkOpen();
      if (request.kind === 'manual-join') {
        const answered = await room.answerManualOffer(request.offerCode);
        checkOpen();
        if (!answered.ok) throw new Error(answered.error.message);
      } else if (signaling || request.kind === 'host') transport.start();
      checkOpen();
      return room;
    } catch (error) {
      if (room) {
        await room.close();
        throw error;
      }
      try {
        await workerClient?.shutdown();
      } finally {
        controller?.dispose();
        try {
          if (transport) transport.dispose();
          else if (relay) relay.close();
          else signaling?.close();
        } finally {
          identity?.dispose();
          try {
            await lease?.close();
          } finally {
            try {
              await ownedStore?.close();
            } finally {
              if (vaultScope) await vaultController?.releaseScope(vaultScope);
            }
          }
        }
      }
      throw error;
    } finally {
      settleOpen();
    }
  }

  getSnapshot = (): OnlineRoomSnapshot => this.snapshot;

  startGame = () => this.startup.begin();

  retryStart = () => this.startup.retryFailed();

  getGame = (): OnlineGame<GameSession> | null => this.startup.game();

  sendChat = (content: ChatContent): Promise<Result<void>> => {
    if (this.startup.game() && this.chat.scopeKind() !== 'game')
      return Promise.resolve(failure('chat-transition', 'Game chat is still opening'));
    return this.chat.send(content);
  };

  muteChat = (peer: PeerId, muted: boolean): Promise<Result<void>> =>
    this.chat.setMuted(peer, muted);

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

  returnableSeats = async (): Promise<readonly Seat[]> => {
    if (this.closing || !this.startup.game()) return [];
    const result = await this.startup.transferClient().request({ kind: 'transferStatus' });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.returnableSeats;
  };

  startTransfer = (
    network: Pick<OnlineTransferLinkOptions, 'iceServers' | 'iceTransportPolicy'>,
    target?: { readonly seat: Seat; readonly mode: 'live' | 'return' },
  ): Promise<OnlineTransferBrowser> => {
    const game = this.startup.game();
    if (this.closing || !game) return Promise.reject(new Error('Online game is unavailable'));
    const seat = target?.seat ?? game.seat;
    const mode = target?.mode ?? 'live';
    let completed: OnlineTransferBrowser | null = null;
    if (this.transfer && !this.transfer.getSnapshot().closed) {
      const snapshot = this.transfer.getSnapshot();
      if (snapshot.phase === 'cancelled' && !snapshot.busy) completed = this.transfer;
      else if (snapshot.invite.body.seat !== seat || snapshot.invite.body.mode !== mode)
        return Promise.reject(new Error('Another transfer attempt is already open'));
      else return Promise.resolve(this.transfer);
    }
    if (this.transferOpening)
      return this.transferOpeningTarget?.seat === seat && this.transferOpeningTarget.mode === mode
        ? this.transferOpening
        : Promise.reject(new Error('Another transfer attempt is opening'));
    if (mode === 'live' && seat !== game.seat)
      return Promise.reject(new Error('Live transfer must move this device’s active human'));
    if (
      mode === 'return' &&
      (!game.genesis.seats.some((item) => item.seat === seat && item.kind === 'human') ||
        game.session.getState().seats.find((item) => item.seat === seat)?.status !== 'bot')
    )
      return Promise.reject(new Error('Return target is not a recovered human seat'));
    this.transferOpeningTarget = { seat, mode };
    this.transferOpening = (async () => {
      if (completed) {
        await completed.close();
        if (this.transfer === completed) this.transfer = null;
      }
      if (mode === 'return' && !(await this.returnableSeats()).includes(seat))
        throw new Error('This device is not the certified host of that recovered seat');
      return OnlineTransferBrowser.openSource({
        identity: this.identity,
        store: this.store,
        clock: this.clock,
        worker: this.startup.transferClient(),
        gameId: game.gameId,
        genesisDigest: genesisDigest(game.genesis),
        seat,
        mode,
        serverUrl: this.invite.serverUrl,
        network,
      });
    })()
      .then(async (transfer) => {
        if (this.closing) {
          await transfer.close();
          throw new Error('Online game closed');
        }
        this.transfer = transfer;
        return transfer;
      })
      .finally(() => {
        this.transferOpening = null;
        this.transferOpeningTarget = null;
      });
    return this.transferOpening;
  };

  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Publish the promise before notifying views, which may call close again.
    this.closing = Promise.resolve().then(() => this.releaseResources());
    void this.transfer?.close().catch(() => undefined);
    void this.startup.close().catch(() => undefined);
    this.cancelManualInvitation();
    this.chat.dispose();
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
        await this.transferOpening?.catch(() => undefined);
        await this.transfer?.close();
        await this.startup.close();
        await this.chat.flush();
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
        try {
          await this.ownedStore?.close();
        } finally {
          if (this.vaultScope) await this.vaultController?.releaseScope(this.vaultScope);
        }
      }
    }
  }

  private discover(peers: readonly PeerId[] | null): void {
    if (this.snapshot.closed || this.closing) return;
    const roster = new Set(this.transport.roster());
    const present = new Set(
      (peers ?? []).filter((peer) => peer !== this.identity.peerId && roster.has(peer)),
    );
    for (const peer of present)
      if (!this.signalingPresent.has(peer)) this.transport.hintPeerAvailable(peer);
    this.signalingPresent.clear();
    for (const peer of present) this.signalingPresent.add(peer);
    const state = this.lobby?.state();
    if (!state || state.status !== 'open' || this.startup.agreement()) return;
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
    const game = this.startup.game();
    if (game && !this.lobbyDetached) {
      this.lobbyDetached = true;
      this.lobby?.dispose();
    }
    const gameChat = this.chat.scopeKind() === 'game' || game !== null;
    const chatState = gameChat ? (agreement?.state ?? this.resumedChatState) : state;
    const currentGamePeers = this.activeGamePeers ?? this.resumedPeers;
    this.chatAllowedPeers =
      currentGamePeers && gameChat
        ? [...currentGamePeers]
        : chatState
          ? [...humanChatPeers(chatState), ...(gameChat || agreement ? [] : chatState.spectators)]
          : [];
    if (
      game &&
      !this.chatSwitching &&
      !this.chatSwitchFailed &&
      this.chat.scopeKind() === 'lobby' &&
      agreement
    ) {
      this.chatSwitching = true;
      void this.chat
        .enterGame(
          { kind: 'game', roomId: this.invite.roomId, genesisDigest: genesisDigest(game.genesis) },
          () => this.chatAllowedPeers,
        )
        .catch(() => {
          this.chatSwitchFailed = true;
        })
        .finally(() => {
          this.chatSwitching = false;
          this.refresh();
        });
    }
    if (this.lobby && !this.frozenRoster && !agreement && (!state || state.status === 'open'))
      this.syncPregameRoster(state ?? null);
    this.update({
      peers: this.transport.peers(),
      lobby: agreement?.state ?? state ?? null,
      agreement,
      startup: this.startup.snapshot(),
      chat: this.chat.snapshot(),
      diagnostic: this.lobby?.getDiagnostic() ?? null,
      seatRequest: this.lobby?.seatRequest() ?? null,
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

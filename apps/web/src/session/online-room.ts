import { hashValue, toHex } from '@cp2p/codec';
import type { GameConfig } from '@cp2p/engine';
import { ServerSignalingAdapter, WebRtcTransport } from '@cp2p/p2p';
import type { ServerSignalingOptions, WebRtcTransportOptions } from '@cp2p/p2p';
import { LobbyController } from '@cp2p/protocol';
import type {
  LobbyDiagnostic,
  LobbyFreezeAgreement,
  LobbyState,
  PeerId,
  ProtocolClock,
  Unsubscribe,
} from '@cp2p/protocol';
import { acquireGameWriterLease, IndexedDbByteStore } from '@cp2p/storage';
import type { GameWriterLease } from '@cp2p/storage';
import { loadOrCreateOnlineIdentity } from './online-credentials.js';
import type { DisposableOnlineIdentity, OnlineCredentialStore } from './online-credentials.js';
import { createRoomId, validateOnlineInvite } from './online-invite.js';
import type { OnlineInvite } from './online-invite.js';

export type OpenOnlineRoom =
  | {
      readonly kind: 'host';
      readonly serverUrl: string;
      readonly name: string;
      readonly hostName: string;
      readonly config: GameConfig;
    }
  | { readonly kind: 'join'; readonly invite: OnlineInvite };

type SignalingStatus = Parameters<NonNullable<ServerSignalingOptions['onStatus']>>[0];

export interface OnlineRoomSnapshot {
  readonly invite: OnlineInvite;
  readonly self: PeerId;
  readonly signaling: SignalingStatus;
  readonly peers: readonly PeerId[];
  readonly lobby: LobbyState | null;
  readonly agreement: LobbyFreezeAgreement | null;
  readonly diagnostic: LobbyDiagnostic | null;
  readonly connectionError: string | null;
  readonly closed: boolean;
}

export interface OnlineRoomRuntime {
  readonly store?: OnlineCredentialStore;
  readonly clock?: ProtocolClock;
  readonly socketFactory?: ServerSignalingOptions['socketFactory'];
  readonly rtcFactory?: WebRtcTransportOptions['rtcFactory'];
  readonly iceServers?: readonly RTCIceServer[];
  readonly acquireLease?: typeof acquireGameWriterLease;
}

const browserClock: ProtocolClock = {
  now: () => performance.now(),
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: (handle) => {
    if (typeof handle === 'number') window.clearTimeout(handle);
  },
};

/** Owns the browser resources for one lobby, including its exclusive device lease. */
export class OnlineRoom {
  readonly lobby: LobbyController;
  private readonly unsubscribers: Unsubscribe[] = [];
  private readonly listeners = new Set<() => void>();
  private snapshot: OnlineRoomSnapshot;
  private closing: Promise<void> | null = null;

  private constructor(
    readonly invite: OnlineInvite,
    private readonly identity: DisposableOnlineIdentity,
    private readonly lease: GameWriterLease,
    private readonly transport: WebRtcTransport,
    signaling: ServerSignalingAdapter,
    controller: LobbyController,
    private readonly ownedStore: IndexedDbByteStore | null,
  ) {
    this.lobby = controller;
    this.snapshot = {
      invite: { ...invite },
      self: identity.peerId,
      signaling: { state: 'connecting' },
      peers: [],
      lobby: null,
      agreement: null,
      diagnostic: null,
      connectionError: null,
      closed: false,
    };
    this.unsubscribers.push(
      controller.onChange(() => this.refresh()),
      controller.onDiagnostic(() => this.refresh()),
      transport.onPeerChange(() => this.refresh()),
      transport.onDiagnostic((_peer, reason) => this.update({ connectionError: reason })),
      signaling.onRoomPeers((peers) => this.discover(peers)),
    );
  }

  static async open(request: OpenOnlineRoom, runtime: OnlineRoomRuntime = {}): Promise<OnlineRoom> {
    const ownedStore = runtime.store ? null : new IndexedDbByteStore();
    const store = runtime.store ?? ownedStore;
    if (!store) throw new Error('Online storage is unavailable');
    let identity: DisposableOnlineIdentity | null = null;
    let lease: GameWriterLease | null = null;
    let signaling: ServerSignalingAdapter | null = null;
    let transport: WebRtcTransport | null = null;
    let controller: LobbyController | null = null;
    try {
      identity = await loadOrCreateOnlineIdentity(store);
      const invite = validateOnlineInvite(
        request.kind === 'join'
          ? request.invite
          : {
              roomId: createRoomId(),
              hostPeer: identity.peerId,
              serverUrl: request.serverUrl,
            },
      );
      const scope = `lobby:${invite.roomId}`;
      const leaseId = `lobby-${toHex(hashValue({ server: invite.serverUrl, room: invite.roomId }))}`;
      lease = await (runtime.acquireLease ?? acquireGameWriterLease)(leaseId, identity.peerId);
      if (!lease) throw new Error('This lobby is already open in another tab');
      const clock = runtime.clock ?? browserClock;
      let room: OnlineRoom | null = null;
      let status: SignalingStatus = { state: 'connecting' };
      signaling = new ServerSignalingAdapter({
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
      });
      transport = new WebRtcTransport({
        self: identity.peerId,
        secretKey: identity.secretKey,
        roster: [...new Set([identity.peerId, invite.hostPeer])],
        scope,
        clock,
        adapter: signaling,
        rtcFactory: runtime.rtcFactory ?? ((_peer, config) => new RTCPeerConnection(config)),
        iceServers: runtime.iceServers ?? [],
      });
      const common = { lobbyId: invite.roomId, transport, clock, secretKey: identity.secretKey };
      const created =
        request.kind === 'host'
          ? LobbyController.createHost({
              ...common,
              name: request.name,
              hostName: request.hostName,
              config: request.config,
            })
          : LobbyController.join({ ...common, hostPeer: invite.hostPeer });
      if (!created.ok) throw new Error(created.error.message);
      controller = created.value;
      room = new OnlineRoom(invite, identity, lease, transport, signaling, controller, ownedStore);
      room.update({ signaling: status });
      transport.start();
      return room;
    } catch (error) {
      try {
        controller?.dispose();
      } finally {
        try {
          if (transport) transport.dispose();
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
    this.update({ closed: true });
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.listeners.clear();
    return this.closing;
  }

  private async releaseResources(): Promise<void> {
    try {
      try {
        this.lobby.dispose();
      } finally {
        try {
          this.transport.dispose();
        } finally {
          this.identity.dispose();
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
    const state = this.lobby.state();
    if (this.snapshot.closed || !peers || (state && state.status !== 'open')) return;
    // Discovery can add links, but an omitted server peer cannot revoke a live link.
    const roster = [...new Set([...this.transport.roster(), ...peers])];
    if (roster.length > 6) {
      this.update({ connectionError: 'room-full' });
      return;
    }
    this.transport.updatePreGameRoster(roster);
    this.refresh();
  }

  private refresh(): void {
    if (this.snapshot.closed) return;
    this.update({
      peers: this.transport.peers(),
      lobby: this.lobby.state(),
      agreement: this.lobby.freezeAgreement(),
      diagnostic: this.lobby.getDiagnostic(),
    });
  }

  private update(patch: Partial<OnlineRoomSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* A view cannot interrupt network or lease cleanup. */
      }
    }
  }
}

import type { CommandShape, GameEvent, LegalCommandSet, PrivateState, Seat } from '@cp2p/engine';
import type {
  Genesis,
  LobbyFreezeAgreement,
  LobbyState,
  P2PSession,
  RecoveryApprovalPreview,
  SeatTransferAuthorization,
  SessionUpdate,
  TransferPrivateEnvelope,
} from '@cp2p/protocol';
import type { OnlineInvite } from './online-invite.js';
import type { OnlineDeviceRoutes } from './online-game-transport.js';
import type { OnlineStartupSnapshot } from './online-startup.js';
import type { ExpectedOnlineTransferGame } from './online-transfer-bootstrap.js';
import type {
  OnlineTransferDestination,
  OnlineTransferDestinationSnapshot,
} from './online-transfer-destination.js';

export const ONLINE_WORKER_PROTOCOL = 'cp2p-online-worker-v1' as const;
export const MAX_ONLINE_WORKER_REQUEST_BYTES = 1_048_576;
export const MAX_ONLINE_WORKER_PENDING_REQUESTS = 16;
export const MAX_ONLINE_WORKER_SNAPSHOT_BYTES = 16 * 1024 * 1024;

export interface OnlineWorkerHead {
  readonly seq: number;
  readonly hash: string;
}

export type OnlineWorkerRequestBody =
  | {
      readonly kind: 'initializeTransfer';
      readonly self: string;
      readonly attemptId: string;
      readonly mode: 'new' | 'resume' | 'open';
      readonly expected: ExpectedOnlineTransferGame;
      readonly bootstrapBytes?: Uint8Array;
      readonly importedArchiveId?: string;
    }
  | { readonly kind: 'transferSnapshot' }
  | { readonly kind: 'prepareTransferOffer'; readonly seat: Seat; readonly mode: 'live' | 'return' }
  | { readonly kind: 'refreshTransferBootstrap'; readonly bootstrapBytes: Uint8Array }
  | { readonly kind: 'importTransferPacket'; readonly packet: TransferPrivateEnvelope }
  | { readonly kind: 'prepareTransferReadiness' }
  | { readonly kind: 'observeTransferActivation'; readonly bootstrapBytes: Uint8Array }
  | { readonly kind: 'observeTransferCancellation'; readonly bootstrapBytes: Uint8Array }
  | { readonly kind: 'exportTransferBootstrap'; readonly throughSeq?: number }
  | {
      readonly kind: 'transferStatus';
      readonly authorization?: OnlineWorkerHead;
      readonly statement?: unknown;
    }
  | {
      readonly kind: 'authorizeLiveTransfer';
      readonly offer: unknown;
      readonly head: OnlineWorkerHead;
    }
  | { readonly kind: 'submitTransfer'; readonly change: unknown; readonly head: OnlineWorkerHead }
  | { readonly kind: 'prepareTransferPrivate'; readonly authorization: OnlineWorkerHead }
  | {
      readonly kind: 'initialize';
      readonly self: string;
      readonly mode: 'fresh';
      readonly invite: OnlineInvite;
    }
  | {
      readonly kind: 'initialize';
      readonly self: string;
      readonly mode: 'resume';
      readonly gameId: string;
    }
  | {
      readonly kind: 'attachTransport';
      readonly self: string;
      readonly peers: readonly string[];
      readonly port: MessagePort;
    }
  | { readonly kind: 'pinFreeze'; readonly state: LobbyState }
  | { readonly kind: 'startCeremony'; readonly agreement: LobbyFreezeAgreement }
  | { readonly kind: 'retryStart' }
  | {
      readonly kind: 'validate';
      readonly seat: Seat;
      readonly head: OnlineWorkerHead;
      readonly command: CommandShape;
    }
  | {
      readonly kind: 'submit';
      readonly seat: Seat;
      readonly head: OnlineWorkerHead;
      readonly command: CommandShape;
    }
  | {
      readonly kind: 'setPrivateVisible';
      readonly visible: boolean;
      readonly visibilityToken: number;
    }
  | { readonly kind: 'exportSave' }
  | { readonly kind: 'retryAudit' }
  | { readonly kind: 'ackSession'; readonly snapshotId: number }
  | { readonly kind: 'approveRecoveryAuthorization'; readonly change: unknown }
  | { readonly kind: 'clearRecoveryApproval' }
  | { readonly kind: 'canRequestTakeover'; readonly departedSeat: Seat }
  | {
      readonly kind: 'requestTakeover';
      readonly departedSeat: Seat;
      readonly botLevel: 'easy' | 'medium' | 'hard';
    }
  | { readonly kind: 'cancelPending'; readonly seat: Seat }
  | { readonly kind: 'shutdown' };

export interface OnlineWorkerRequest {
  readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
  readonly generation: string;
  readonly id: number;
  readonly body: OnlineWorkerRequestBody;
}

export interface OnlineWorkerResumeInfo {
  readonly gameId: string;
  readonly genesisDigest: string;
  readonly agreement: LobbyFreezeAgreement;
  readonly genesis: Genesis;
  /** Active human device routes derived from this device's certified journal. */
  readonly peers: readonly string[];
}

export interface OnlineWorkerInitialization {
  readonly self: string;
  readonly invite: OnlineInvite;
  readonly resume: OnlineWorkerResumeInfo | null;
}

export interface OnlineWorkerReplyByKind {
  initializeTransfer: OnlineTransferDestinationSnapshot;
  transferSnapshot: OnlineTransferDestinationSnapshot;
  prepareTransferOffer: SeatTransferAuthorization;
  refreshTransferBootstrap: OnlineTransferDestinationSnapshot;
  importTransferPacket: OnlineTransferDestinationSnapshot;
  prepareTransferReadiness: Awaited<ReturnType<OnlineTransferDestination['prepareReadiness']>>;
  observeTransferActivation: {
    readonly gameId: string;
    readonly snapshot: OnlineTransferDestinationSnapshot;
  };
  observeTransferCancellation: OnlineTransferDestinationSnapshot;
  exportTransferBootstrap: Uint8Array;
  transferStatus: ReturnType<P2PSession['getTransferStatus']>;
  authorizeLiveTransfer: SeatTransferAuthorization;
  submitTransfer: void;
  prepareTransferPrivate: TransferPrivateEnvelope;
  initialize: OnlineWorkerInitialization;
  attachTransport: void;
  pinFreeze: { readonly freezeHash: string };
  startCeremony: void;
  retryStart: void;
  validate: void;
  submit: void;
  setPrivateVisible: void;
  exportSave: unknown;
  retryAudit: boolean;
  ackSession: void;
  approveRecoveryAuthorization: RecoveryApprovalPreview;
  clearRecoveryApproval: void;
  canRequestTakeover: void;
  requestTakeover: void;
  cancelPending: boolean;
  shutdown: void;
}

export type OnlineWorkerReply = {
  [K in keyof OnlineWorkerReplyByKind]: {
    readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
    readonly generation: string;
    readonly id: number;
    readonly kind: K;
    readonly result:
      | { readonly ok: true; readonly value: OnlineWorkerReplyByKind[K] }
      | {
          readonly ok: false;
          readonly error: {
            readonly code: string;
            readonly message: string;
            readonly savedVersion?: number;
          };
        };
  };
}[keyof OnlineWorkerReplyByKind];

/** A complete public snapshot. `events` is full history, unlike `update.events`. */
export interface OnlineWorkerSessionSnapshot {
  readonly committedHead: OnlineWorkerHead;
  readonly update: SessionUpdate;
  readonly events: readonly GameEvent[];
  readonly localHumanSeat: Seat;
  readonly privateState: PrivateState | null;
  readonly legal: LegalCommandSet | null;
  readonly controllableSeats: readonly Seat[];
  readonly visibilityToken: number;
}

export type OnlineWorkerEvent =
  | {
      readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
      readonly generation: string;
      readonly kind: 'deviceRoutes';
      readonly routes: OnlineDeviceRoutes;
    }
  | {
      readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
      readonly generation: string;
      readonly kind: 'startup';
      readonly snapshot: OnlineStartupSnapshot | null;
    }
  | {
      readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
      readonly generation: string;
      readonly kind: 'gameReady';
      readonly game: { readonly gameId: string; readonly genesis: Genesis; readonly seat: Seat };
    }
  | {
      readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
      readonly generation: string;
      readonly kind: 'session';
      readonly snapshotId: number;
      readonly snapshot: OnlineWorkerSessionSnapshot;
    }
  | {
      readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
      readonly generation: string;
      readonly kind: 'fatal';
      readonly error: { readonly code: string; readonly message: string };
    };

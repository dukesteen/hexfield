import type { Seat } from '@cp2p/engine';
import type { EntryRef } from './beacon-state.js';
import type { SeatSignature } from './types.js';

export interface TransferReplacement {
  readonly seat: Seat;
  readonly oldPublicKey: string;
  readonly newPublicKey: string;
  readonly newHostSeat: Seat;
}

export interface SeatTransferAuthorizationStatement {
  readonly protocol: 'seat-transfer-v1';
  readonly genesisDigest: string;
  readonly anchor: EntryRef;
  readonly validUntilSeq: number;
  readonly mode: 'live' | 'return';
  readonly seat: Seat;
  readonly currentController: {
    readonly publicKey: string;
    readonly kind: 'human' | 'bot';
    readonly activatedAt: EntryRef;
    readonly hostSeat: Seat;
  };
  readonly recovery: { readonly authorization: EntryRef; readonly activation: EntryRef } | null;
  readonly nextEpoch: number;
  readonly destination: {
    readonly devicePeer: string;
    readonly gamePeer: string;
    readonly transferEncryptionKey: string;
  };
  readonly replacements: readonly TransferReplacement[];
}

export interface SeatTransferAuthorization {
  readonly kind: 'transfer-authorize';
  readonly statement: SeatTransferAuthorizationStatement;
  readonly destinationDeviceSig: string;
  readonly destinationGameSig: string;
  readonly replacementKeySigs: readonly SeatSignature[];
  readonly ownerIntent?:
    | { readonly signer: 'current-game' | 'current-device'; readonly sig: string }
    | undefined;
  readonly returnIntent?:
    | { readonly signer: 'last-human-game-key'; readonly sig: string }
    | undefined;
  readonly humanApprovals?: readonly SeatSignature[] | undefined;
}

export interface SeatTransferActivationStatement {
  readonly protocol: 'seat-transfer-activation-v1';
  readonly genesisDigest: string;
  readonly authorization: EntryRef;
  readonly parent: EntryRef;
  readonly nextEpoch: number;
  readonly destinationDevice: string;
  readonly destinationGame: string;
  readonly replacements: readonly TransferReplacement[];
  readonly checkDigest: string;
}

export interface SeatTransferActivation {
  readonly kind: 'transfer-activate';
  readonly statement: SeatTransferActivationStatement;
  readonly destinationCheck: string;
  readonly replacementChecks: readonly SeatSignature[];
}

export interface SeatTransferCancel {
  readonly kind: 'transfer-cancel';
  readonly genesisDigest: string;
  readonly authorization: EntryRef;
  readonly parent: EntryRef;
}

export type SeatTransferChange =
  | SeatTransferAuthorization
  | SeatTransferActivation
  | SeatTransferCancel;

export interface AuthorizedTransfer {
  readonly entry: EntryRef;
  readonly statement: SeatTransferAuthorizationStatement;
}

/** Captured only while replaying the root certified recovery authorization. */
export interface TransferReturnRoot {
  readonly rootAuthorization: EntryRef;
  readonly finalAuthorization: EntryRef;
  readonly activation: EntryRef | null;
  readonly departedSeat: Seat;
  readonly lastHumanGameKey: string;
  readonly lastHumanDevice: string;
  readonly affectedSeats: readonly Seat[];
}

/** Derived from genesis and the certified prefix; peers cannot supply this map. */
export interface TransferState {
  readonly genesisDigest: string;
  readonly routes: readonly { readonly seat: Seat; readonly devicePeer: string | null }[];
  readonly knownDevicePeers: readonly string[];
  readonly recentHeads: readonly EntryRef[];
  /** Latest certified membership entry; a prior signed intent cannot cross it. */
  readonly intentBarrier: EntryRef;
  readonly pending: EntryRef | null;
  readonly authorizations: readonly AuthorizedTransfer[];
  readonly completed: readonly {
    readonly authorization: EntryRef;
    readonly outcome: 'activated' | 'cancelled';
    readonly entry: EntryRef;
  }[];
  readonly returnRoots: readonly TransferReturnRoot[];
}

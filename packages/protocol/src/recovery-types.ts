import type { Seat } from '@cp2p/engine';
import type { EntryRef } from './beacon-state.js';
import type { SeatSignature } from './types.js';

export interface RecoveryReadiness {
  readonly genesisDigest: string;
  readonly parent: EntryRef;
  readonly nextEpoch: number;
  readonly departedSeat: Seat;
  readonly hostSeat: Seat;
  readonly botLevel: 'easy' | 'medium' | 'hard';
  readonly replacements: readonly { readonly seat: Seat; readonly publicKey: string }[];
  /** Every remaining human privately verifies reconstruction before signing activation. */
  readonly recoverers: readonly { readonly seat: Seat; readonly publicKey: string }[];
  readonly previous: EntryRef | null;
}

export interface RecoveryAuthorization {
  readonly kind: 'recovery-authorize';
  readonly statement: RecoveryReadiness;
  readonly hostSig: string;
  readonly keySigs: readonly SeatSignature[];
}

export interface RecoveryActivationStatement {
  readonly genesisDigest: string;
  readonly parent: EntryRef;
  readonly nextEpoch: number;
  readonly authorization: EntryRef;
  /** Public digest of the activation parent; contains no master or private hand. */
  readonly checkDigest: string;
}

export interface RecoveryActivation {
  readonly kind: 'recovery-activate';
  readonly statement: RecoveryActivationStatement;
  readonly checks: readonly SeatSignature[];
}

export type RecoveryVoidReason =
  | 'master-encryption-key'
  | 'master-beacon-tip'
  | 'master-shuffle-key'
  | 'master-lock-key';

/** Private recoverers attest to the same failed derived-key check, without publishing a master. */
export interface RecoveryVoidStatement {
  readonly genesisDigest: string;
  readonly parent: EntryRef;
  readonly authorization: EntryRef;
  readonly dealerSeat: Seat;
  readonly reason: RecoveryVoidReason;
}

export interface RecoveryVoid {
  readonly kind: 'recovery-void';
  readonly statement: RecoveryVoidStatement;
  readonly checks: readonly SeatSignature[];
}

export type RecoveryChange = RecoveryAuthorization | RecoveryActivation | RecoveryVoid;

export interface AuthorizedRecovery {
  readonly entry: EntryRef;
  readonly statement: RecoveryReadiness;
}

/** Only replay installs these records. Amendments retain every earlier authorization. */
export interface RecoveryState {
  readonly authorizations: readonly AuthorizedRecovery[];
  readonly pending: EntryRef | null;
  /** Certified observation only; elapsed absence remains a local voting rule. */
  readonly offline: readonly { readonly seat: Seat; readonly since: EntryRef }[];
  readonly completed: readonly {
    readonly authorization: EntryRef;
    readonly activation: EntryRef;
    readonly checkDigest: string;
  }[];
  /** A certified terminal quorum decision, not a public proof against the dealer. */
  readonly void: {
    readonly entry: EntryRef;
    readonly authorization: EntryRef;
    readonly dealerSeat: Seat;
    readonly reason: RecoveryVoidReason;
  } | null;
}

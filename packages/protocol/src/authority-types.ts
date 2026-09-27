import type { Seat } from '@cp2p/engine';

/** Command authority is distinct from a seat's immutable encryption/master keys. */
export interface ControllerRecord {
  readonly seat: Seat;
  readonly publicKey: string;
  readonly hostSeat: Seat;
  readonly kind: 'human' | 'bot';
  readonly status: 'active' | 'pending-recovery';
  /** Genesis uses its full body digest; replacements use their certified activation hash. */
  readonly activatedAt: { readonly seq: number; readonly hash: string };
}

/** Derived from genesis and certified membership entries, never supplied by a peer. */
export interface SeatAuthorities {
  readonly genesisDigest: string;
  readonly epoch: number;
  readonly controllers: readonly ControllerRecord[];
  /** Retired keys remain reserved and cannot be reactivated by an old save. */
  readonly usedPublicKeys: readonly string[];
  /** Exact operations carried across the latest certified membership transition. */
  readonly carriedOperations: readonly CarriedOperation[];
}

export interface CarriedOperation {
  readonly kind: 'beacon' | 'deck' | 'count' | 'steal';
  readonly id: string;
  readonly epoch: number;
  readonly anchor: { readonly seq: number; readonly hash: string };
}

/** Explicit signature authority for a new artifact, resolved at its certified parent. */
export interface ArtifactSigner {
  readonly seat: Seat;
  readonly publicKey: string;
  readonly generation: { readonly seq: number; readonly hash: string };
}

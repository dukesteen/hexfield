import { scalarFromBytes } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Engine, PrivateState, Result, Seat } from '@cp2p/engine';
import type { ProposalContext } from './proposal.js';
import {
  initialProposalContext,
  replayCertifiedPrefix,
  replayCertifiedPrefixObserved,
} from './replay.js';
import type { ReplayPolicy } from './replay.js';
import { createPrivateReplayObserver } from './private-replay-observer.js';
import type { PrivateReplayObserver } from './private-replay-observer.js';
import type { VerifiedSessionDriver } from './verified-session-driver.js';

export interface ReconstructedPrivateSeats {
  readonly context: ProposalContext;
  /** Contains only requested seats and checks their public openings after every entry. */
  readonly driver: VerifiedSessionDriver;
  /** Relinquish one owned seat without discarding other reconstructed seats. */
  releaseSeat(seat: Seat): void;
  /** Disposes the driver and clears its retained master copies. */
  dispose(): void;
}

/**
 * Reconstruct already-owned or authorized-revealed seats from certified history.
 * This does not request secrets, authorize disclosure, activate controllers or
 * constitute a complete game audit. The caller must establish the right to use
 * every supplied master before invoking it. Deck setup must be fully certified.
 * No partially rebuilt hand is returned.
 */
export function reconstructPrivateSeats(input: {
  readonly genesisEntry: unknown;
  readonly entries: readonly unknown[];
  readonly engine: Engine;
  readonly policy: ReplayPolicy;
  readonly secrets: readonly { readonly seat: Seat; readonly master: Uint8Array }[];
  /** Independent check of detached snapshots, provisional until the entire replay succeeds. */
  readonly verifyPrivateState?: (
    seq: number,
    states: ReadonlyMap<Seat, PrivateState>,
  ) => Result<void>;
}): Result<ReconstructedPrivateSeats> {
  const masters = new Map<Seat, Uint8Array>();
  let observer: PrivateReplayObserver | undefined;
  let retained = false;
  try {
    if (!Array.isArray(input.secrets) || input.secrets.length < 1 || input.secrets.length > 6)
      return failure('private-replay-seats', 'Supply one through six distinct owned seat secrets');
    for (const { seat, master } of input.secrets) {
      if (
        !Number.isSafeInteger(seat) ||
        seat < 0 ||
        seat > 5 ||
        masters.has(seat) ||
        !(master instanceof Uint8Array) ||
        master.length !== 32
      )
        return failure('private-replay-secrets', 'Seat secrets are malformed or duplicated');
      const copy = new Uint8Array(master);
      masters.set(seat, copy);
      scalarFromBytes(copy, { nonzero: true });
    }
    // Authenticate the whole supplied branch before reporting a secret mismatch or invoking callbacks.
    const publicReplay = replayCertifiedPrefix(
      input.genesisEntry,
      input.entries,
      input.engine,
      input.policy,
    );
    if (!publicReplay.ok)
      return failure('private-replay-history', 'Certified history could not be verified', {
        reason: publicReplay.error.code,
      });
    const prepared = createPrivateReplayObserver({
      engine: input.engine,
      initial: () => initialProposalContext(input.genesisEntry, input.engine, input.policy),
      terminal: publicReplay.value.context,
      secrets: [...masters].map(([seat, master]) => ({ seat, master })),
      ...(input.verifyPrivateState ? { verifyPrivateState: input.verifyPrivateState } : {}),
    });
    if (!prepared.ok) return prepared;
    observer = prepared.value;
    const rebuilt = replayCertifiedPrefixObserved(
      input.genesisEntry,
      publicReplay.value.entries,
      input.engine,
      input.policy,
      observer.onEntry,
    );
    if (!rebuilt.ok) return rebuilt;
    observer.finishHistory();
    retained = true;
    return success({
      context: rebuilt.value.context,
      driver: observer.driver,
      releaseSeat: observer.releaseSeat,
      dispose: observer.dispose,
    });
  } catch {
    return failure('private-replay-failed', 'Could not reconstruct the requested private seats');
  } finally {
    for (const master of masters.values()) master.fill(0);
    if (!retained) observer?.dispose();
  }
}

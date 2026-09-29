import type { SchnorrProof } from '@cp2p/crypto';
import type {
  GameState,
  Input,
  Pending,
  PrivateInputData,
  PrivateState,
  Result,
  Seat,
  SystemInput,
} from '@cp2p/engine';
import type { CountOperation } from './count-reveal.js';
import type { LogContext, ValidatedEntry } from './log.js';
import type { CertifiedEntry } from './proposal.js';
import type { SessionTimer } from './session-types.js';
import type { StealContributionProducer, StealResponseProducer } from './steal-contributions.js';
import type { IndexedHandProof, SignedTradeProofRequest } from './trade-proof-delivery.js';
import type { CommandBody, SystemEvidence } from './types.js';

/** Private state and system protocols are separate from the replicated public log. */
export interface SessionDriver {
  next(context: LogContext): { input: SystemInput; evidence: SystemEvidence } | null;
  /** Check owned deterministic secret sources before journal replay or creation. */
  validateSources?(): Result<void>;
  /** Adopt verified recovered seats at the same certified head before they can act. */
  adoptRecovered?(donor: SessionDriver, context: LogContext): Result<void>;
  /** Drop private state and proof-source routes for seats retired by certified authority. */
  relinquishSeats?(seats: readonly Seat[]): void;
  /** Produce owner evidence bound to this exact parent, nonce and complete command before signing. */
  prepareCommand?(
    body: Omit<CommandBody, 'evidence'>,
    context: LogContext,
    external?: readonly IndexedHandProof[],
  ): Result<CommandBody['evidence']>;
  /** Proofs for the owned counterparty of an authenticated, accepted trade. */
  produceTradeProofs?(
    request: SignedTradeProofRequest,
    context: LogContext,
  ): Result<readonly IndexedHandProof[]>;
  /** Owner-only exact-count proof for a frozen Monopoly victim request. */
  produceCountProof?(
    operation: CountOperation,
    seat: Seat,
    context: LogContext,
  ): Result<{ count: number; proof: SchnorrProof }>;
  produceStealContribution?: StealContributionProducer;
  produceStealResponse?: StealResponseProducer;
  /**
   * Handles each certified entry, including protocol-only entries with no engine input.
   * When present, this replaces `committed`; it owns engine and private consequences too.
   */
  committedEntry?(
    entry: ValidatedEntry & CertifiedEntry,
    before: LogContext,
    after: LogContext,
  ): Result<void>;
  /** Legacy engine-input callback, used only when `committedEntry` is absent. */
  committed(before: LogContext, input: Input, after: GameState): Result<void>;
  /**
   * The answer an owned seat gives to a request only it can answer (a victory check, a private
   * look, a take), or null when it has nothing to answer yet. The session signs and submits it.
   */
  revealAnswer?(
    seat: Seat,
    pending: Extract<Pending, { kind: 'reveal' }>,
    context: LogContext,
  ): Result<SystemInput | null>;
  /** Secrets an owned seat needs to apply its own input to its private state. */
  privateInputData?(seat: Seat, input: Input): PrivateInputData | undefined;
  privateState(seat: Seat): PrivateState | null;
  getTimers?(): readonly SessionTimer[];
  dispose?(): void;
}

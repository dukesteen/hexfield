import type { Engine, GameState, Input, Result, Seat } from '@cp2p/engine';
import type { BeaconDerivations } from './beacon-state.js';
import type { CheatClaim, CheatFinding } from './cheat-types.js';
import type { CryptoContext } from './crypto-context.js';
import type { PeerId } from './transport.js';
import type { SeatAuthorities } from './authority-types.js';
import type { RecoveryState } from './recovery-types.js';
import type { TimerAnchor } from './turn-timeout.js';
import type {
  ExcludeProposerControl,
  Genesis,
  LogEntry,
  SignedCommand,
  SystemEvidence,
} from './types.js';

export interface LogContext {
  genesis: Genesis;
  engine: Engine;
  head: LogEntry;
  state: GameState;
  lastNonces: ReadonlyMap<Seat, number>;
  crypto: CryptoContext | null;
  /** Replayed controller authority. Legacy epoch-zero fixtures may omit it. */
  authority?: SeatAuthorities;
  recovery?: RecoveryState;
  /** Certified pending intervals, independent of each peer's observed elapsed time. */
  timers?: readonly TimerAnchor[];
}

export interface EntryPolicy {
  /** Derived from the agreed height/round, never from an incoming entry. */
  term: number;
  sequencer: PeerId;
  /** Simulation opt-in; stub evidence binds inputs but cannot prove hidden facts or deadlines. */
  allowStub?: boolean;
  randomDerivations?: BeaconDerivations;
  /** Pure, deterministic validation from the signed command and certified public context only.
   * Never consult clocks, network state or private hands: the same verdict is used for
   * admission, votes and objective accusations against an invalid proposer.
   */
  verifyCommand?: (command: SignedCommand, context: LogContext) => Result<void>;
  verifySystem?: (
    input: Extract<Input, { kind: 'system' }>,
    evidence: SystemEvidence,
    context: LogContext,
  ) => Result<void>;
  verifyControl?: (control: ExcludeProposerControl, context: LogContext) => Result<void>;
  /** Historical claims are resolved from a replayed certified prefix by the caller. */
  verifyHistoricalCheat?: (claim: CheatClaim) => Result<CheatFinding>;
}

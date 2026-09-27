import type {
  CommandShape,
  GameEvent,
  GameState,
  LegalCommandSet,
  Pending,
  PrivateState,
  Result,
  Seat,
} from '@cp2p/engine';
import type { ProtocolClock, Unsubscribe } from './transport.js';
import type { SessionAuditState } from './session-audit-types.js';
import type { RecoveryApprovalCandidate, RecoveryApprovalPreview } from './recovery-facade.js';
import type { SessionTimer } from './session-timer-types.js';
import type { CheatFinding } from './cheat-types.js';

export type { SessionTimer } from './session-timer-types.js';

export type SessionStatus =
  | { kind: 'running' }
  | { kind: 'complete' }
  | { kind: 'error'; message: string }
  | { kind: 'disposed' };

/** Public facts derived only from the locally verified certified history. */
export interface SessionFairness {
  readonly head: { readonly seq: number; readonly hash: string };
  /** Accepted player/bot commands, excluding automatic engine and protocol entries. */
  readonly verifiedMoves: number;
  readonly findings: readonly CheatFinding[];
}

export interface SessionUpdate {
  revision: number;
  state: GameState;
  events: readonly GameEvent[];
  pending: readonly Pending[];
  timers: readonly SessionTimer[];
  status: SessionStatus;
  audit?: SessionAuditState;
  fairness?: SessionFairness | null;
  /** A validated, current-parent takeover proposal awaiting this voter's choice. */
  recoveryCandidate?: RecoveryApprovalCandidate | null;
}

export interface SubmitOptions {
  expectedRevision?: number;
}

/** Live game session contract shared by local and peer-backed clients. */
export interface GameSession<Save = unknown> {
  readonly mode: 'local' | 'p2p' | 'replay' | 'spectator';
  getState(): GameState;
  getPrivate(seat: Seat): PrivateState | null;
  getPending(): readonly Pending[];
  getTimers(): readonly SessionTimer[];
  getLegalCommands(seat: Seat): LegalCommandSet;
  validate(seat: Seat, command: CommandShape): Result<void> | Promise<Result<void>>;
  getEvents(): readonly GameEvent[];
  getAudit?(): SessionAuditState;
  getFairness?(): SessionFairness | null;
  retryAudit?(): boolean | Promise<boolean>;
  getRecoveryCandidate?(): RecoveryApprovalCandidate | null;
  approveRecoveryAuthorization?(change: unknown): Promise<Result<RecoveryApprovalPreview>>;
  clearRecoveryApproval?(): void;
  requestTakeover?(departedSeat: Seat, botLevel: 'easy' | 'medium' | 'hard'): Promise<Result<void>>;
  controllableSeats(): Seat[];
  submit(seat: Seat, command: CommandShape, options?: SubmitOptions): Promise<Result<void>>;
  /** Cancel preparation that has not entered consensus; accepted commands cannot be cancelled. */
  cancelPending?(seat: Seat): boolean | Promise<boolean>;
  subscribe(listener: (update: SessionUpdate) => void): Unsubscribe;
  exportSave(): Save | Promise<Save>;
  /** Conceal any cached online private view when its owning seat is hidden. */
  setPrivateVisible?(visible: boolean): void;
  setPaused?(paused: boolean): void;
  dispose(): void;
}

/** Scheduler readings are local and must never be compared across peers. */
export interface SessionScheduler extends ProtocolClock {}

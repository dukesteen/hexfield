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

export type SessionStatus =
  | { kind: 'running' }
  | { kind: 'complete' }
  | { kind: 'error'; message: string }
  | { kind: 'disposed' };

/** expiresAt uses the injected scheduler's Unix-millisecond clock; null means paused. */
export interface SessionTimer {
  key: string;
  seat: Seat;
  phase: string;
  remainingMs: number;
  expiresAt: number | null;
  paused: boolean;
}

export interface SessionUpdate {
  revision: number;
  state: GameState;
  events: readonly GameEvent[];
  pending: readonly Pending[];
  timers: readonly SessionTimer[];
  status: SessionStatus;
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
  validate(seat: Seat, command: CommandShape): Result<void>;
  getEvents(): readonly GameEvent[];
  controllableSeats(): Seat[];
  submit(seat: Seat, command: CommandShape, options?: SubmitOptions): Promise<Result<void>>;
  subscribe(listener: (update: SessionUpdate) => void): Unsubscribe;
  exportSave(): Save;
  setPaused?(paused: boolean): void;
  dispose(): void;
}

/** Scheduler contract uses Unix milliseconds to match session timer expiry. */
export interface SessionScheduler extends ProtocolClock {}

import type {
  CommandShape,
  GameConfig,
  GameEvent,
  GameState,
  Input,
  LegalCommandSet,
  Pending,
  PrivateState,
  Result,
  Seat,
} from '@cp2p/engine';

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

export type Unsubscribe = () => void;

export interface LocalSaveBatch {
  submitted: Input;
  generated: Input[];
}

/** The input batches are authoritative; finalHash detects a damaged or incompatible save. */
export interface LocalSessionSave {
  v: 1;
  mode: 'local';
  engineVersion: string;
  config: GameConfig;
  genesisSeed: string;
  roles: { humanSeats: Seat[]; botSeats: Seat[] };
  genesis: Input[];
  batches: LocalSaveBatch[];
  finalHash: string;
}

export interface SubmitOptions {
  expectedRevision?: number;
}

/** Live game transport used by local, network and replay screens. */
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

/** Clock and task queue for local turns. now() uses Unix milliseconds. */
export interface SessionScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

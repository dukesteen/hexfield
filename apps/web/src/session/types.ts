import type { GameConfig, Input, Seat } from '@cp2p/engine';

export type {
  GameSession,
  SessionScheduler,
  SessionStatus,
  SessionTimer,
  SessionUpdate,
  SubmitOptions,
  Unsubscribe,
} from '@cp2p/protocol';

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

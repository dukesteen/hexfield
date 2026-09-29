import type { BotLevel } from '@cp2p/bots';
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
  roles: {
    humanSeats: Seat[];
    botSeats: Seat[];
    /** Each bot seat's level, by seat; absent (older saves) means the random bot. */
    botLevels?: Record<string, BotLevel>;
  };
  genesis: Input[];
  batches: LocalSaveBatch[];
  finalHash: string;
}

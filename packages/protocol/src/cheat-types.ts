import type { Seat } from '@cp2p/engine';

/** A malformed inner proof stays in its signed, bounded outer envelope. */
export interface RawSignedArtifact {
  readonly body: unknown;
  readonly sig: string;
}

export type CheatKind =
  | 'command-proof'
  | 'beacon-reveal'
  | 'deck-pass'
  | 'deck-unlock'
  | 'count-proof'
  | 'steal-contribution'
  | 'bad-steal-delivery'
  | 'false-steal-dispute';

export type CheatEvidence =
  | {
      kind: Exclude<CheatKind, 'deck-unlock' | 'bad-steal-delivery'>;
      at: { seq: number; hash: string };
      artifact: RawSignedArtifact;
    }
  | {
      kind: 'deck-unlock';
      at: { seq: number; hash: string };
      prefix: unknown[];
      artifact: RawSignedArtifact;
    }
  | {
      kind: 'bad-steal-delivery';
      at: { seq: number; hash: string };
      artifact: RawSignedArtifact;
    };

export interface CheatClaim {
  seat: Seat;
  evidence: CheatEvidence;
}

export interface CheatFinding {
  seat: Seat;
  kind: CheatKind;
  at: { seq: number; hash: string };
  evidenceId: string;
}

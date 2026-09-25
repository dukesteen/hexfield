import type { CommandShape, GameConfig, Seat, SystemInput } from '@cp2p/engine';
import type { PeerId } from './transport.js';
import type { SignedVote } from './votes.js';

export const PROTOCOL_VERSION = 1;

export interface HumanSeat {
  seat: Seat;
  kind: 'human';
  publicKey: PeerId;
  name: string;
  colour: string;
}

export interface BotSeat {
  seat: Seat;
  kind: 'bot';
  publicKey: PeerId;
  botHost: PeerId;
  name: string;
  colour: string;
}

export type GenesisSeat = HumanSeat | BotSeat;

/** The hash body excludes the derived gameId and all signatures. */
export interface GenesisBody {
  protocolVersion: number;
  engineVersion: string;
  config: GameConfig;
  seats: GenesisSeat[];
  genesisSeed: string;
  ceremonyNonce: string;
  security: 'stub' | 'verified';
  commitments: Record<string, unknown>;
  createdAt: number;
}

export interface SeatSignature {
  seat: Seat;
  sig: string;
}

export interface Genesis extends GenesisBody {
  gameId: string;
  signatures: SeatSignature[];
}

/** Proofs are signed with the command and checked before engine application. */
export interface CommandEvidence {
  protocol: string;
  data: unknown;
}

export interface CommandBody {
  gameId: string;
  genesisDigest: string;
  seat: Seat;
  nonce: number;
  headSeq: number;
  headHash: string;
  command: CommandShape;
  evidence?: CommandEvidence;
}

export interface SignedCommand {
  body: CommandBody;
  sig: string;
}

/** Stub evidence is permitted only for explicitly opted-in simulation genesis. */
export type SystemEvidence =
  | { kind: 'stub'; context: string }
  | { kind: 'proof'; protocol: string; data: unknown };

/** Evidence is checked against the certified parent, never a sender-supplied state. */
export type ObjectiveEvidence =
  | { kind: 'vote-equivocation'; first: SignedVote; second: SignedVote }
  | { kind: 'proposal-equivocation'; first: SignedProposal; second: SignedProposal }
  | { kind: 'invalid-command'; proposal: SignedProposal };

export interface ExcludeProposerControl {
  kind: 'control';
  action: 'exclude-proposer';
  offender: Seat;
  evidence: ObjectiveEvidence;
}

export type EntryPayload =
  | { kind: 'genesis'; genesis: Genesis }
  | { kind: 'command'; signed: SignedCommand }
  | { kind: 'system'; input: SystemInput; evidence: SystemEvidence }
  | ExcludeProposerControl
  | { kind: 'membership'; change: unknown };

export interface EntryBody {
  seq: number;
  term: number;
  prevHash: string;
  payload: EntryPayload;
  stateHash: string;
  sequencer: PeerId;
}

export interface LogEntry extends EntryBody {
  sig: string;
}

export interface ProposalBody {
  genesisDigest: string;
  epoch: number;
  entry: LogEntry;
  validRound: number | null;
  prevotes: readonly SignedVote[];
}

export interface SignedProposal {
  body: ProposalBody;
  sig: string;
}

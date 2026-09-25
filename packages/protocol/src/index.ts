export const PACKAGE_NAME = '@cp2p/protocol';

export {
  GENESIS_PREVIOUS_HASH,
  entryBody,
  entryHash,
  genesisBody,
  genesisDigest,
  genesisId,
  signEntry,
  signGenesis,
  validateGenesis,
  validateGenesisEntry,
} from './genesis.js';
export type { GenesisPolicy, ValidatedGenesis } from './genesis.js';
export { signCommand, stubEvidence, validateNextEntry, validateSignedCommand } from './log.js';
export type { EntryPolicy, LogContext, ValidatedEntry } from './log.js';
export {
  authenticateCertifiedEntry,
  proposerFor,
  signProposal,
  validateCertifiedEntry,
  validateProposal,
} from './proposal.js';
export type {
  CertifiedEntry,
  ProposalBody,
  ProposalContext,
  SignedProposal,
  ValidatedProposal,
} from './proposal.js';
export { MemorySafetyStore } from './safety-store.js';
export type { SafetyStore, StoredSafety } from './safety-store.js';
export { MemoryProtocolJournal, journalSafetyStore } from './journal.js';
export type { JournalRecord, ProtocolJournal } from './journal.js';
export { P2PSession } from './p2p-session.js';
export type { CertifiedHistory, P2PSessionOptions, SessionDriver } from './p2p-session.js';
export { ReplicatedLog } from './replicated-log.js';
export type { ReplicatedLogOptions, ReplicatedLogStatus } from './replicated-log.js';
export {
  initialProposalContext,
  replayCertifiedPrefix,
  snapshotFromContext,
  verifyReplaySnapshot,
} from './replay.js';
export type { ReplayPolicy, ReplayedPrefix } from './replay.js';
export { decodeProtocolMessage, encodeProtocolMessage, protocolMessageSchema } from './messages.js';
export type { ProtocolMessage } from './messages.js';
export type {
  GameSession,
  SessionScheduler,
  SessionStatus,
  SessionTimer,
  SessionUpdate,
  SubmitOptions,
} from './session-types.js';
export { phaseIdentity, timerKey } from './session-timing.js';
export type { PeerId, ProtocolClock, Transport, Unsubscribe } from './transport.js';
export { PROTOCOL_VERSION } from './types.js';
export type {
  BotSeat,
  CommandBody,
  CommandEvidence,
  EntryBody,
  EntryPayload,
  Genesis,
  GenesisBody,
  GenesisSeat,
  HumanSeat,
  LogEntry,
  SeatSignature,
  SignedCommand,
  SystemEvidence,
} from './types.js';
export { MAX_MESSAGE_BYTES } from './validation.js';
export { quorumSize, signVote, validateVote, verifyCertificate } from './votes.js';
export type { ExpectedVote, SignedVote, VoteBody, VoteContext, VotePhase } from './votes.js';
export { decodeMessage, encodeMessage } from './wire.js';

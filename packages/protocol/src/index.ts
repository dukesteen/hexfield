export const PACKAGE_NAME = '@cp2p/protocol';

export { createBeaconSecretSource } from './beacon-source.js';
export type { BeaconSecretProvider, BeaconSecretSourceContext } from './beacon-source.js';

export { MemoryBeaconContributionStore } from './beacon-contributions.js';
export type {
  BeaconContribution,
  BeaconContributionStore,
  BeaconSecretSource,
} from './beacon-contributions.js';
export type { CryptoContext } from './crypto-context.js';
export { MemoryCountContributionStore } from './count-contributions.js';
export type { CountContributionStore, CountProofProducer } from './count-contributions.js';
export type { CountOperation, CountState, SignedCountContribution } from './count-reveal.js';
export { createHandSecretSource } from './hand-source.js';
export type { HandSecretSource, HandSourceFactory } from './hand-source.js';
export { createRandomDerivations, randomDerivations } from './random-derivations.js';
export type { RandomDerivation, RandomPending, BeaconOutcome } from './random-derivations.js';

export {
  GENESIS_PREVIOUS_HASH,
  entryBody,
  entryHash,
  genesisBody,
  genesisDigest,
  genesisId,
  signEntry,
  validateGenesis,
  validateGenesisEntry,
} from './genesis.js';
export type { GenesisPolicy, ValidatedGenesis } from './genesis.js';
export { signCommand, stubEvidence, validateNextEntry, validateSignedCommand } from './log.js';
export type { EntryPolicy, LogContext, ValidatedEntry } from './log.js';
export { validateExcludeProposerControl, validateObjectiveAccusation } from './control.js';
export type { ControlEvidenceContext } from './control.js';
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
export { advanceContext } from './proposal.js';
export { MemorySafetyStore } from './safety-store.js';
export type { SafetyStore, StoredSafety } from './safety-store.js';
export { MemoryProtocolJournal, journalSafetyStore } from './journal.js';
export type { JournalRecord, ProtocolJournal } from './journal.js';
export { P2PSession } from './p2p-session.js';
export { VerifiedSessionDriver } from './verified-session-driver.js';
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
  ExcludeProposerControl,
  ObjectiveEvidence,
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
export {
  initDeckSetup,
  validateDeckSetupState,
  deckSetupId,
  deckPassOperationId,
  applyDeckPass,
  signDeckShuffle,
  signDeckLock,
  replayDeckSetup,
} from './deck-setup.js';
export type { DeckDefinition, DeckSetupState, SignedDeckPass } from './deck-setup.js';
export { createDeckSecretSource } from './deck-source.js';
export type { DeckSecretSource, DeckSourceFactory } from './deck-source.js';
export {
  freezeDeckDraw,
  validateDeckDrawOperation,
  deckDrawOperationId,
  verifyDeckUnlockPrefix,
  signDeckUnlock,
  verifyDeckUnlock,
  completeDeckDraw,
  decodeDeckCard,
  proveDeckReveal,
  verifyDeckReveal,
} from './deck-draw.js';
export type {
  DeckDrawRequest,
  DeckDrawOperation,
  SignedDeckUnlock,
  DealtDeckCard,
  DeckRevealContext,
  DeckCardReveal,
} from './deck-draw.js';
export { prepareDeckUnlock } from './deck-outbox.js';
export type { DeckContributionStore } from './deck-outbox.js';
export { prepareDeckPass } from './deck-setup-outbox.js';

export {
  deckCeremonyId,
  genesisDeckDefinitions,
  deckPassHash,
  createDeckGenesisCommitment,
  validateDeckGenesisCommitments,
  validateDeckCeremony,
} from './deck-genesis.js';
export type { DeckGenesisCommitment } from './deck-genesis.js';
export { DECK_DRAW_PROTOCOL, DECK_REVEAL_PROTOCOL, decksReady } from './deck-ledger.js';
export type { DeckLedger, LedgerDeck, LedgerSlot } from './deck-ledger.js';

export { prepareGenesisConsent, MemoryGenesisConsentStore } from './genesis-outbox.js';
export type { GenesisConsentStore } from './genesis-outbox.js';

export { createStealSecretSource } from './steal-source.js';
export type { StealSecretSource, StealSourceFactory } from './steal-source.js';
export type { StealState } from './steal-state.js';
export { MemoryStealDeliveryStore } from './steal-contributions.js';
export type {
  StealContributionProducer,
  StealDeliveryStore,
  StealResponse,
  StealResponseProducer,
} from './steal-contributions.js';

export const PACKAGE_NAME = '@cp2p/protocol';

export { createBeaconSecretSource } from './beacon-source.js';
export type { BeaconSecretProvider, BeaconSecretSourceContext } from './beacon-source.js';

export { MemoryBeaconContributionStore } from './beacon-contributions.js';
export { MemoryCheatCandidateStore } from './cheat-candidates.js';
export type { CheatCandidateStore } from './cheat-candidates.js';
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
export { validateGenesisOnlineStart } from './genesis-online-start.js';
export type { VerifiedOnlineStart } from './genesis-online-start.js';
export type { GenesisSeedMode } from './genesis-seed.js';
export { prepareOnlineDisclosureGuard } from './online-disclosure.js';
export { OnlineCeremony } from './online-ceremony.js';
export type {
  OnlineCeremonyOptions,
  OnlineCeremonyProgress,
  OnlineCeremonyResult,
  OnlineCeremonyPhase,
} from './online-ceremony.js';
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
export { certifiedEntrySchema } from './proposal.js';
export { genesisSchema, logEntrySchema } from './schemas.js';
export { MemorySafetyStore } from './safety-store.js';
export { createConsensusState, restoreConsensusState } from './consensus.js';
export { verifyRevealedMaster } from './genesis-secrets.js';
export { validateGenesisEscrow } from './genesis-escrow.js';
export { restoreRetiredSafety } from './retired-safety.js';
export {
  transferAuthorizationStatementSchema,
  transferChangeSchema,
  transferCheckDigest,
  transferEntryRef,
  TRANSFER_DEVICE_DOMAIN,
  TRANSFER_GAME_KEY_DOMAIN,
  TRANSFER_BOT_KEY_DOMAIN,
  TRANSFER_DESTINATION_CHECK_DOMAIN,
  TRANSFER_BOT_CHECK_DOMAIN,
} from './transfer-readiness.js';
export type {
  SeatTransferAuthorization,
  SeatTransferAuthorizationStatement,
  TransferReplacement,
} from './transfer-types.js';
export { TRANSFER_RETURN_INTENT_DOMAIN } from './transfer-readiness.js';
export {
  prepareTransferPrivate,
  importTransferPrivate,
  verifyTransferPrivateEnvelope,
  transferPrivateEnvelopeSchema,
  TRANSFER_PRIVATE_DOMAIN,
} from './transfer-private.js';
export type {
  TransferPrivateEnvelope,
  TransferPrivateStore,
  ImportedTransferPrivate,
} from './transfer-private.js';
export { transferActivationStatementSchema } from './transfer-readiness.js';
export {
  validatePendingTransferMaterial,
  validateRetiredTransferBinding,
  validateTransferOwnedMaterial,
} from './transfer-material.js';
export type { TransferOwnedMaterial, TransferOwnedSeat } from './transfer-material.js';
export type { SafetyStore, StoredSafety } from './safety-store.js';
export { MemoryProtocolJournal, journalSafetyStore } from './journal.js';
export type { JournalRecord, ProtocolJournal } from './journal.js';
export { DEFAULT_BOT_DELAY_MS, P2PSession } from './p2p-session.js';
export { VerifiedSessionDriver } from './verified-session-driver.js';
export type { CertifiedHistory, P2PSessionOptions, SessionDriver } from './p2p-session.js';
export { ReplicatedLog } from './replicated-log.js';
export type {
  ReplicatedLogOptions,
  ReplicatedLogStatus,
  RecoveredReplicaOwnership,
} from './replicated-log.js';
export { BOT_TRADE_PATIENCE_MS, botAwaitsTradeReplies, chooseBotPending } from './bot-pending.js';
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
  SessionFairness,
  SubmitOptions,
} from './session-types.js';
export { phaseIdentity, timerKey } from './session-timing.js';
export { TURN_TIMEOUT_PROTOCOL } from './turn-timeout.js';
export type { TimerAnchor } from './turn-timeout.js';
export type { PeerId, ProtocolClock, Transport, Unsubscribe } from './transport.js';
export { PROTOCOL_VERSION } from './types.js';
export { DEFAULT_TAKEOVER_POLICY, takeoverPolicySchema } from './takeover-policy.js';
export type { TakeoverPolicy } from './takeover-policy.js';
export { LobbyController, verifyLobbyFreezeAgreement } from './lobby.js';
export type { LobbyControllerOptions, HostLobbyOptions, JoinLobbyOptions } from './lobby.js';
export { LOBBY_COLOURS } from './lobby-types.js';
export type {
  LobbyBotLevel,
  LobbyColour,
  LobbyDiagnostic,
  LobbyFreezeAck,
  LobbyFreezeAgreement,
  LobbyRequest,
  LobbySeat,
  LobbyState,
} from './lobby-types.js';
export {
  ONLINE_SEAT_BINDING_DOMAIN,
  ONLINE_SEAT_BINDING_PROTOCOL,
  signGameSeatBinding,
  verifyGameSeatBindings,
} from './online-bindings.js';
export type {
  GameSeatBindingBody,
  SignedGameSeatBinding,
  SignGameSeatBindingInput,
  VerifiedGameSeatBindings,
} from './online-bindings.js';
export { EscrowCeremony } from './escrow-ceremony.js';
export type { CeremonySend, EscrowCeremonyStore } from './escrow-ceremony.js';
export type { EscrowManifestApproval } from './escrow-lifecycle.js';
export type { EscrowShareAck, AcceptedEscrowShare } from './escrow-distribution.js';
export type { EscrowShareEnvelope } from './escrow-types.js';
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
export type {
  IndexedHandProof,
  SignedTradeProofRequest,
  SignedTradeProofResponse,
  TradeProofBody,
} from './trade-proof-delivery.js';

export { artifactSigner, resolveArtifactSigner } from './authority.js';
export type { ArtifactSigner, ControllerRecord, SeatAuthorities } from './authority-types.js';
export type {
  AuthorizedRecovery,
  RecoveryActivation,
  RecoveryActivationStatement,
  RecoveryAuthorization,
  RecoveryChange,
  RecoveryReadiness,
  RecoveryState,
  RecoveryVoid,
  RecoveryVoidReason,
  RecoveryVoidStatement,
} from './recovery-types.js';
export { recoveryCheckDigest } from './recovery-membership.js';
export {
  prepareRecoveryReadiness,
  loadPreparedRecoveryReadiness,
  loadActivatedRecoveryKeys,
} from './recovery-readiness.js';
export type { RecoveryApprovalCandidate, RecoveryApprovalPreview } from './recovery-facade.js';
export type {
  ActivatedRecoveryKeySet,
  RecoveryReadinessReplacement,
  RecoveryReadinessStore,
} from './recovery-readiness.js';
export {
  prepareRecoveryRelease,
  verifyRecoveryRelease,
  openRecoveryRelease,
  recoverAuthorizedMaster,
} from './recovery-release.js';
export type { RecoveryRelease, RecoveryReleaseStore } from './recovery-release.js';
export { produceRecoveryCheck, produceRecoveryCheckFromShares } from './recovery-check.js';
export { produceRecoveryVoidCheckFromShares } from './recovery-void.js';
export type { SignedRecoveryVoidCheck, RecoveryVoidCheckInput } from './recovery-void.js';
export type {
  ProducedRecoveryCheck,
  RecoveryCheckInput,
  RecoveryCheckStore,
  SignedRecoveryCheck,
} from './recovery-check.js';
export { RecoveryInbox } from './recovery-inbox.js';
export { loadRecoveryPrivate } from './recovery-private.js';
export type { RecoveryPrivateStore } from './recovery-private.js';
export { loadRecoveredHost } from './recovered-host.js';
export type { RecoveredHost, RecoveredHostInput } from './recovered-host.js';
export { RecoveryParticipant } from './recovery-participant.js';
export type {
  RecoveryParticipantOptions,
  PreparedRecoveryPackets,
} from './recovery-participant.js';
export { auditCertifiedGame } from './audit.js';
export type { AuditCertifiedGameInput } from './audit.js';
export type { AuditReport, AuditViolation, AuditInputError, AuditEntryRef } from './audit-types.js';
export {
  MasterRevealCoordinator,
  signedMasterRevealSchema,
  verifyMasterReveal,
} from './master-reveal.js';
export type {
  MasterRevealOptions,
  MasterRevealStore,
  MasterRevealVerdict,
  SignedMasterReveal,
} from './master-reveal.js';
export type {
  SessionAuditInput,
  SessionAuditJob,
  SessionAuditRunner,
  SessionAuditState,
} from './session-audit-types.js';

import * as v from 'valibot';
import { beaconContributionSchema } from './beacon-contributions.js';
import { signedCountContributionSchema } from './count-reveal.js';
import {
  signedStealContributionSchema,
  signedStealDisputeSchema,
  signedStealReceiptSchema,
} from './steal-delivery.js';
import {
  signedTradeProofRequestSchema,
  signedTradeProofResponseSchema,
} from './trade-proof-delivery.js';
import { deckUnlockContributionSchema } from './deck-inbox.js';
import { certifiedEntrySchema, signedProposalSchema } from './proposal.js';
import {
  hashSchema,
  key32Schema,
  nonnegativeIntegerSchema,
  positiveIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import { excludeProposerControlSchema, signedCommandSchema } from './schemas.js';
import { signedVoteSchema } from './votes.js';
import { cheatClaimSchema } from './cheat-schema.js';
import { membershipChangeSchema } from './membership-change.js';
import { recoveryReleaseSchema } from './recovery-release.js';
import { signedRecoveryCheckSchema } from './recovery-inbox.js';
import { signedMasterRevealSchema } from './master-reveal.js';
import { decodeMessage, encodeMessage } from './wire.js';
import type { Result } from '@cp2p/engine';

const submitSchema = v.strictObject({ t: v.literal('SUBMIT'), cmd: signedCommandSchema });
const masterRevealMessageSchema = v.strictObject({
  t: v.literal('MASTER_REVEAL'),
  reveal: signedMasterRevealSchema,
});
const membershipSubmitSchema = v.strictObject({
  t: v.literal('MEMBERSHIP_SUBMIT'),
  change: membershipChangeSchema,
});
const recoveryReleaseMessageSchema = v.strictObject({
  t: v.literal('RECOVERY_RELEASE'),
  genesisDigest: key32Schema,
  release: recoveryReleaseSchema,
});
const recoveryCheckMessageSchema = v.strictObject({
  t: v.literal('RECOVERY_CHECK'),
  genesisDigest: key32Schema,
  check: signedRecoveryCheckSchema,
});
const systemContributionSchema = v.strictObject({
  t: v.literal('SYS_CONTRIB'),
  genesisDigest: key32Schema,
  contribution: beaconContributionSchema,
});
const deckContributionSchema = v.strictObject({
  t: v.literal('DECK_CONTRIB'),
  genesisDigest: key32Schema,
  contribution: deckUnlockContributionSchema,
});
const countContributionSchema = v.strictObject({
  t: v.literal('COUNT_CONTRIB'),
  genesisDigest: key32Schema,
  contribution: signedCountContributionSchema,
});
const stealContributionSchema = v.strictObject({
  t: v.literal('STEAL_CONTRIB'),
  genesisDigest: key32Schema,
  contribution: signedStealContributionSchema,
});
const stealResponseSchema = v.strictObject({
  t: v.literal('STEAL_RESPONSE'),
  genesisDigest: key32Schema,
  response: v.variant('kind', [
    v.strictObject({ kind: v.literal('receipt'), value: signedStealReceiptSchema }),
    v.strictObject({ kind: v.literal('dispute'), value: signedStealDisputeSchema }),
  ]),
});
const tradeProofRequestMessageSchema = v.strictObject({
  t: v.literal('TRADE_PROOF_REQUEST'),
  request: signedTradeProofRequestSchema,
});
const tradeProofResponseMessageSchema = v.strictObject({
  t: v.literal('TRADE_PROOF_RESPONSE'),
  response: signedTradeProofResponseSchema,
});
const proposalMessageSchema = v.strictObject({
  t: v.literal('PROPOSAL'),
  proposal: signedProposalSchema,
});
const voteMessageSchema = v.strictObject({ t: v.literal('VOTE'), vote: signedVoteSchema });
const commitSchema = v.strictObject({ t: v.literal('COMMIT'), certified: certifiedEntrySchema });
const accuseSchema = v.strictObject({
  t: v.literal('ACCUSE'),
  control: excludeProposerControlSchema,
});
const cheatClaimMessageSchema = v.strictObject({
  t: v.literal('CHEAT_CLAIM'),
  claim: cheatClaimSchema,
});
const syncRequestSchema = v.strictObject({
  t: v.literal('SYNC_REQ'),
  genesisDigest: key32Schema,
  fromSeq: nonnegativeIntegerSchema,
  toSeq: v.optional(nonnegativeIntegerSchema),
});
const syncResponseSchema = v.strictObject({
  t: v.literal('SYNC_RES'),
  genesisDigest: key32Schema,
  entries: v.pipe(v.array(certifiedEntrySchema), v.maxLength(200)),
  more: v.boolean(),
});
const snapshotRequestSchema = v.strictObject({
  t: v.literal('SNAPSHOT_REQ'),
  genesisDigest: key32Schema,
  atSeq: nonnegativeIntegerSchema,
});
const snapshotResponseSchema = v.strictObject({
  t: v.literal('SNAPSHOT_RES'),
  genesisDigest: key32Schema,
  atSeq: nonnegativeIntegerSchema,
  snapshot: v.unknown(),
});
const proposalRequestSchema = v.strictObject({
  t: v.literal('PROPOSAL_REQ'),
  genesisDigest: key32Schema,
  epoch: nonnegativeIntegerSchema,
  seq: positiveIntegerSchema,
  term: positiveIntegerSchema,
  valueHash: hashSchema,
});
const heartbeatSchema = v.strictObject({
  t: v.literal('HEARTBEAT'),
  body: v.strictObject({
    genesisDigest: key32Schema,
    epoch: nonnegativeIntegerSchema,
    seat: seatSchema,
    head: v.strictObject({ seq: nonnegativeIntegerSchema, hash: hashSchema }),
    term: positiveIntegerSchema,
  }),
  sig: signature64Schema,
});
const pingSchema = v.strictObject({ t: v.literal('PING'), n: nonnegativeIntegerSchema });
const pongSchema = v.strictObject({ t: v.literal('PONG'), n: nonnegativeIntegerSchema });

/** Strict message envelope; signatures and operation contexts are checked before use. */
export const protocolMessageSchema = v.variant('t', [
  submitSchema,
  masterRevealMessageSchema,
  membershipSubmitSchema,
  recoveryReleaseMessageSchema,
  recoveryCheckMessageSchema,
  systemContributionSchema,
  deckContributionSchema,
  countContributionSchema,
  stealContributionSchema,
  stealResponseSchema,
  tradeProofRequestMessageSchema,
  tradeProofResponseMessageSchema,
  proposalMessageSchema,
  voteMessageSchema,
  commitSchema,
  accuseSchema,
  cheatClaimMessageSchema,
  syncRequestSchema,
  syncResponseSchema,
  snapshotRequestSchema,
  snapshotResponseSchema,
  proposalRequestSchema,
  heartbeatSchema,
  pingSchema,
  pongSchema,
]);

export type ProtocolMessage = v.InferOutput<typeof protocolMessageSchema>;

/** Canonically encode one shape-validated protocol message. */
export function encodeProtocolMessage(value: unknown): Result<Uint8Array> {
  return encodeMessage(value, protocolMessageSchema);
}

/** Decode and shape-validate one canonical protocol message. */
export function decodeProtocolMessage(bytes: Uint8Array): Result<ProtocolMessage> {
  return decodeMessage(bytes, protocolMessageSchema);
}

import * as v from 'valibot';
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
import { decodeMessage, encodeMessage } from './wire.js';
import type { Result } from '@cp2p/engine';

const submitSchema = v.strictObject({ t: v.literal('SUBMIT'), cmd: signedCommandSchema });
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

/** Strict Stage 06 message envelope; every payload is validated before use. */
export const protocolMessageSchema = v.variant('t', [
  submitSchema,
  proposalMessageSchema,
  voteMessageSchema,
  commitSchema,
  accuseSchema,
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

/** Canonically encode one validated Stage 06 message. */
export function encodeProtocolMessage(value: unknown): Result<Uint8Array> {
  return encodeMessage(value, protocolMessageSchema);
}

/** Decode and validate one canonical Stage 06 message. */
export function decodeProtocolMessage(bytes: Uint8Array): Result<ProtocolMessage> {
  return decodeMessage(bytes, protocolMessageSchema);
}

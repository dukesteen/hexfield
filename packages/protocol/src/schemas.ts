import * as v from 'valibot';
import type { SignedProposal } from './types.js';
import { signedVoteSchema } from './votes.js';
import {
  hashSchema as hash,
  key32Schema as key32,
  nonnegativeIntegerSchema as nonnegativeInteger,
  positiveIntegerSchema as positiveInteger,
  seatSchema,
  signature64Schema as signature64,
} from './schema-values.js';

const signedInteger = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(Number.MIN_SAFE_INTEGER),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
const label = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(64),
  v.check((s) => s.trim() !== ''),
);
const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const gameId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/));

const moduleSelectionSchema = v.strictObject({ id: label, version: label });
const boardHexSchema = v.strictObject({
  id: identifier,
  q: signedInteger,
  r: signedInteger,
  terrain: label,
  token: v.nullable(nonnegativeInteger),
});
const harborSchema = v.strictObject({ edge: identifier, kind: label });
const roadSchema = v.strictObject({ edge: identifier, seat: seatSchema });
const buildingSchema = v.strictObject({ vertex: identifier, seat: seatSchema, kind: label });
const boardSchema = v.strictObject({
  hexes: v.pipe(v.array(boardHexSchema), v.maxLength(512)),
  harbors: v.pipe(v.array(harborSchema), v.maxLength(256)),
  roads: v.pipe(v.array(roadSchema), v.maxLength(1_024)),
  buildings: v.pipe(v.array(buildingSchema), v.maxLength(512)),
  robberHex: v.nullable(identifier),
});
const configSchema = v.strictObject({
  modules: v.pipe(v.array(moduleSelectionSchema), v.minLength(1), v.maxLength(32)),
  seats: v.pipe(v.array(seatSchema), v.minLength(2), v.maxLength(6)),
  options: v.record(label, v.unknown()),
  board: v.exactOptional(boardSchema),
});

const humanSeatSchema = v.strictObject({
  seat: seatSchema,
  kind: v.literal('human'),
  publicKey: key32,
  name: label,
  colour: label,
});
const botSeatSchema = v.strictObject({
  seat: seatSchema,
  kind: v.literal('bot'),
  publicKey: key32,
  botHost: key32,
  name: label,
  colour: label,
});
const genesisSeatSchema = v.variant('kind', [humanSeatSchema, botSeatSchema]);
const seatSignatureSchema = v.strictObject({ seat: seatSchema, sig: signature64 });

export const genesisSchema = v.strictObject({
  protocolVersion: positiveInteger,
  engineVersion: label,
  config: configSchema,
  seats: v.pipe(v.array(genesisSeatSchema), v.minLength(2), v.maxLength(6)),
  genesisSeed: key32,
  ceremonyNonce: key32,
  security: v.picklist(['stub', 'verified']),
  commitments: v.record(label, v.unknown()),
  createdAt: nonnegativeInteger,
  gameId,
  signatures: v.pipe(v.array(seatSignatureSchema), v.maxLength(6)),
});

const commandSchema = v.objectWithRest({ type: label }, v.unknown());
const commandEvidenceSchema = v.strictObject({ protocol: label, data: v.unknown() });

export const signedCommandSchema = v.strictObject({
  body: v.strictObject({
    gameId,
    genesisDigest: key32,
    seat: seatSchema,
    nonce: positiveInteger,
    headSeq: nonnegativeInteger,
    headHash: hash,
    command: commandSchema,
    evidence: v.exactOptional(commandEvidenceSchema),
  }),
  sig: signature64,
});

const systemInputSchema = v.objectWithRest({ kind: v.literal('system'), type: label }, v.unknown());
const systemEvidenceSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('stub'), context: hash }),
  v.strictObject({ kind: v.literal('proof'), protocol: label, data: v.unknown() }),
]);
// A proposal may itself contain a control entry. Its finite, canonical envelope is
// checked here; the complete signed proposal is verified against the certified
// parent by the control validator.
const embeddedProposalSchema = v.custom<SignedProposal>(
  (value): value is SignedProposal => typeof value === 'object' && value !== null,
);
export const objectiveEvidenceSchema = v.variant('kind', [
  v.strictObject({
    kind: v.literal('vote-equivocation'),
    first: signedVoteSchema,
    second: signedVoteSchema,
  }),
  v.strictObject({
    kind: v.literal('proposal-equivocation'),
    first: embeddedProposalSchema,
    second: embeddedProposalSchema,
  }),
  v.strictObject({ kind: v.literal('invalid-command'), proposal: embeddedProposalSchema }),
]);
export const excludeProposerControlSchema = v.strictObject({
  kind: v.literal('control'),
  action: v.literal('exclude-proposer'),
  offender: seatSchema,
  evidence: objectiveEvidenceSchema,
});
const payloadSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('genesis'), genesis: genesisSchema }),
  v.strictObject({ kind: v.literal('command'), signed: signedCommandSchema }),
  v.strictObject({
    kind: v.literal('system'),
    input: systemInputSchema,
    evidence: systemEvidenceSchema,
  }),
  excludeProposerControlSchema,
  // Membership is reserved for Stage 10. Its change is deliberately opaque here;
  // the entry validator must reject it until the membership adapter exists.
  v.strictObject({ kind: v.literal('membership'), change: v.unknown() }),
]);

export const logEntrySchema = v.strictObject({
  seq: nonnegativeInteger,
  term: positiveInteger,
  prevHash: hash,
  payload: payloadSchema,
  stateHash: hash,
  sequencer: key32,
  sig: signature64,
});

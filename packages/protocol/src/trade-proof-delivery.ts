import { hashValue, toHex } from '@cp2p/codec';
import { parsePeerId, signObject, verifyObject } from '@cp2p/crypto';
import { failure, kindsOfCounts, success } from '@cp2p/engine';
import type { Result, Seat, TradeOffer } from '@cp2p/engine';
import * as v from 'valibot';
import { resolveArtifactSigner } from './authority.js';
import type { SeatAuthorities } from './authority-types.js';
import { entryHash, genesisDigest } from './genesis.js';
import { handProofsSchema, planHandTransition, verifyHandProof } from './hand-transition.js';
import type { HandProof, HandProofBinding, HandTransitionPlan } from './hand-transition.js';
import type { LogContext } from './log.js';
import {
  hashSchema,
  key32Schema,
  nonnegativeIntegerSchema,
  positiveIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import type { CommandBody, Genesis } from './types.js';
import { parseCanonical } from './validation.js';

export type TradeProofBody = Omit<CommandBody, 'evidence' | 'command'> & {
  command: { type: 'CONFIRM_TRADE'; offerId: number; withSeat: Seat };
};

export interface IndexedHandProof {
  index: number;
  proof: HandProof;
}

export interface SignedTradeProofRequest {
  body: TradeProofBody;
  sig: string;
}

export interface SignedTradeProofResponse {
  body: { requestId: string; seat: Seat; proofs: readonly IndexedHandProof[] };
  sig: string;
}

export interface TradeProofPlan {
  body: TradeProofBody;
  plan: HandTransitionPlan;
  binding: HandProofBinding;
  owner: Seat;
  indices: readonly number[];
  termsHash: string;
}

const gameIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/));
const commandSchema = v.strictObject({
  type: v.literal('CONFIRM_TRADE'),
  offerId: nonnegativeIntegerSchema,
  withSeat: seatSchema,
});
const tradeProofBodySchema = v.strictObject({
  gameId: gameIdSchema,
  genesisDigest: key32Schema,
  seat: seatSchema,
  nonce: positiveIntegerSchema,
  headSeq: nonnegativeIntegerSchema,
  headHash: hashSchema,
  command: commandSchema,
});
export const signedTradeProofRequestSchema = v.strictObject({
  body: tradeProofBodySchema,
  sig: signature64Schema,
});
const indexedProofSchema = v.strictObject({
  index: nonnegativeIntegerSchema,
  proof: handProofsSchema.item,
});
const responseBodySchema = v.strictObject({
  requestId: hashSchema,
  seat: seatSchema,
  proofs: v.pipe(v.array(indexedProofSchema), v.maxLength(30)),
});
export const signedTradeProofResponseSchema = v.strictObject({
  body: responseBodySchema,
  sig: signature64Schema,
});

const resourceCountsSchema = v.strictObject({
  brick: nonnegativeIntegerSchema,
  lumber: nonnegativeIntegerSchema,
  wool: nonnegativeIntegerSchema,
  grain: nonnegativeIntegerSchema,
  ore: nonnegativeIntegerSchema,
});
const offerSchema = v.strictObject({
  id: nonnegativeIntegerSchema,
  proposer: seatSchema,
  give: resourceCountsSchema,
  want: resourceCountsSchema,
  to: v.pipe(v.array(seatSchema), v.maxLength(6)),
  acceptedBy: v.pipe(v.array(seatSchema), v.maxLength(6)),
  declinedBy: v.pipe(v.array(seatSchema), v.maxLength(6)),
  valid: v.boolean(),
});
const offersSchema = v.object({ offers: v.pipe(v.array(offerSchema), v.maxLength(64)) });

function certifiedOffer(context: LogContext, offerId: number): Result<TradeOffer> {
  const base = parseCanonical(context.state.ext.base, offersSchema);
  if (!base.ok) return base;
  const offer = base.value.offers.find((item) => item.id === offerId);
  return offer
    ? success(offer)
    : failure('trade-proof-offer', 'The certified trade offer is missing');
}

/** Exact, current-parent confirmation plan; all statements come from the engine. */
export function planTradeProof(body: unknown, context: LogContext): Result<TradeProofPlan> {
  try {
    return planCurrentTradeProof(body, context);
  } catch {
    // An unavailable local engine is not objective evidence against the sender.
    return failure('trade-proof-unavailable', 'Could not derive the current trade proof plan');
  }
}

function planCurrentTradeProof(body: unknown, context: LogContext): Result<TradeProofPlan> {
  const parsed = parseCanonical(body, tradeProofBodySchema);
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  if (
    context.genesis.security !== 'verified' ||
    request.gameId !== context.genesis.gameId ||
    request.genesisDigest !== genesisDigest(context.genesis)
  )
    return failure('trade-proof-game', 'Trade proof request belongs to another verified game');
  if (request.headSeq < context.head.seq)
    return failure('trade-proof-stale-head', 'Trade proof request has a stale parent');
  if (request.headSeq > context.head.seq)
    return failure('trade-proof-future-head', 'Trade proof request is ahead of this peer');
  if (request.headHash !== entryHash(context.head))
    return failure('trade-proof-parent', 'Trade proof request has a different parent hash');
  if (request.nonce !== (context.lastNonces.get(request.seat) ?? 0) + 1)
    return failure('trade-proof-nonce', 'Trade proof request needs the next certified nonce');
  if (request.seat !== context.state.turn.activeSeat)
    return failure('trade-proof-finalizer', 'Only the active seat may confirm a player trade');
  if (!context.crypto)
    return failure('trade-proof-crypto', 'Verified trade requires committed hand state');
  const offered = certifiedOffer(context, request.command.offerId);
  if (!offered.ok) return offered;
  const offer = offered.value;
  const owner = request.command.withSeat;
  if (
    !offer.valid ||
    (offer.proposer === request.seat
      ? !offer.to.includes(owner) || !offer.acceptedBy.includes(owner)
      : offer.proposer !== owner || !offer.to.includes(request.seat))
  )
    return failure('trade-proof-consent', 'The owner has not consented to this exact trade');
  const input = { kind: 'command' as const, seat: request.seat, command: request.command };
  const legal = context.engine.validate(context.state, input);
  if (!legal.ok) return legal;
  const applied = context.engine.apply(context.state, input);
  if (!applied.ok) return applied;
  const plan = planHandTransition(context.crypto.hands, context.state, input, applied.value);
  if (!plan.ok) return plan;
  const indices = plan.value.obligations.flatMap((obligation, index) =>
    obligation.seat === owner ? [index] : [],
  );
  const binding: HandProofBinding = {
    genesisDigest: request.genesisDigest,
    epoch: context.crypto.epoch,
    anchor: { seq: request.headSeq, hash: request.headHash },
    command: request,
  };
  const kinds = kindsOfCounts(context.state.bank);
  const termsHash = toHex(
    hashValue({
      offerId: offer.id,
      proposer: offer.proposer,
      give: Object.fromEntries(kinds.map((resource) => [resource, offer.give[resource]])),
      want: Object.fromEntries(kinds.map((resource) => [resource, offer.want[resource]])),
      withSeat: owner,
    }),
  );
  return success({ body: request, plan: plan.value, binding, owner, indices, termsHash });
}

/** Private producers call this again after routing, before any hand-source use. */
export function authorizeTradeProof(
  body: unknown,
  owner: Seat,
  context: LogContext,
): Result<TradeProofPlan> {
  const planned = planTradeProof(body, context);
  if (!planned.ok) return planned;
  if (owner !== planned.value.owner || planned.value.indices.length === 0)
    return failure('trade-proof-owner', 'This owner has no required proof for the trade');
  const epoch = context.crypto?.epoch ?? context.authority?.epoch ?? 0;
  const finalizer = resolveArtifactSigner(
    context.authority,
    context.genesis,
    epoch,
    planned.value.body.seat,
  );
  if (!finalizer.ok) return finalizer;
  const ownerSigner = resolveArtifactSigner(context.authority, context.genesis, epoch, owner);
  if (!ownerSigner.ok) return ownerSigner;
  return planned;
}

export function tradeProofRequestId(body: TradeProofBody): string {
  const parsed = parseCanonical(body, tradeProofBodySchema);
  if (!parsed.ok) throw new TypeError('Invalid trade proof request body');
  return toHex(hashValue({ domain: 'cp2p/v1/trade-proof-request', body: parsed.value }));
}

export function signTradeProofRequest(
  body: TradeProofBody,
  key: Uint8Array,
): SignedTradeProofRequest {
  const parsed = parseCanonical(body, tradeProofBodySchema);
  if (!parsed.ok) throw new TypeError('Invalid trade proof request body');
  return { body: parsed.value, sig: signObject('trade-proof-request', parsed.value, key) };
}

export function verifyTradeProofRequest(
  value: unknown,
  context: LogContext,
): Result<SignedTradeProofRequest> {
  const parsed = parseCanonical(value, signedTradeProofRequestSchema);
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  const finalizer = resolveArtifactSigner(
    context.authority,
    context.genesis,
    context.crypto?.epoch ?? context.authority?.epoch ?? 0,
    request.body.seat,
  );
  if (!finalizer.ok) return finalizer;
  try {
    if (
      !verifyObject(
        'trade-proof-request',
        request.body,
        request.sig,
        parsePeerId(finalizer.value.publicKey),
      )
    )
      return failure('trade-proof-signature', 'Finalizer signature is invalid');
  } catch {
    return failure('trade-proof-signature', 'Finalizer signature is malformed');
  }
  const authorized = authorizeTradeProof(request.body, request.body.command.withSeat, context);
  return authorized.ok ? success(request) : authorized;
}

export function signTradeProofResponse(
  request: SignedTradeProofRequest,
  seat: Seat,
  proofs: readonly IndexedHandProof[],
  key: Uint8Array,
): SignedTradeProofResponse {
  const parsed = parseCanonical(request, signedTradeProofRequestSchema);
  if (!parsed.ok) throw new TypeError('Invalid trade proof request');
  const body = { requestId: tradeProofRequestId(parsed.value.body), seat, proofs };
  const checked = parseCanonical(body, responseBodySchema);
  if (!checked.ok) throw new TypeError('Invalid trade proof response');
  return { body: checked.value, sig: signObject('trade-proof-response', checked.value, key) };
}

export function verifyTradeProofResponse(
  value: unknown,
  request: SignedTradeProofRequest,
  context: LogContext,
): Result<SignedTradeProofResponse> {
  const verifiedRequest = verifyTradeProofRequest(request, context);
  if (!verifiedRequest.ok) return verifiedRequest;
  const parsed = parseCanonical(value, signedTradeProofResponseSchema);
  if (!parsed.ok) return parsed;
  const response = parsed.value;
  const owner = resolveArtifactSigner(
    context.authority,
    context.genesis,
    context.crypto?.epoch ?? context.authority?.epoch ?? 0,
    response.body.seat,
  );
  if (!owner.ok) return owner;
  try {
    if (
      !verifyObject(
        'trade-proof-response',
        response.body,
        response.sig,
        parsePeerId(owner.value.publicKey),
      )
    )
      return failure('trade-proof-response-signature', 'Owner signature is invalid');
  } catch {
    return failure('trade-proof-response-signature', 'Owner signature is malformed');
  }
  const planned = authorizeTradeProof(request.body, response.body.seat, context);
  if (!planned.ok) return planned;
  if (response.body.requestId !== tradeProofRequestId(request.body))
    return failure('trade-proof-request-id', 'Response belongs to another request');
  if (
    response.body.proofs.length !== planned.value.indices.length ||
    response.body.proofs.some((item, index) => item.index !== planned.value.indices[index])
  )
    return failure('trade-proof-indices', 'Response must cover exact owner obligations in order');
  for (const item of response.body.proofs) {
    const verified = verifyHandProof(
      planned.value.plan,
      item.index,
      item.proof,
      planned.value.binding,
    );
    if (!verified.ok) return verified;
  }
  return success(response);
}

export function tradeProofHost(
  genesis: Genesis,
  seat: Seat,
  authority?: SeatAuthorities,
): string | null {
  const signer = resolveArtifactSigner(authority, genesis, authority?.epoch ?? 0, seat);
  if (!signer.ok) return null;
  if (authority) {
    const controller = authority.controllers.find((item) => item.seat === seat);
    const host = authority.controllers.find((item) => item.seat === controller?.hostSeat);
    return host?.kind === 'human' && host.status === 'active' ? host.publicKey : null;
  }
  const owner = genesis.seats.find((item) => item.seat === seat);
  return owner ? (owner.kind === 'human' ? owner.publicKey : owner.botHost) : null;
}

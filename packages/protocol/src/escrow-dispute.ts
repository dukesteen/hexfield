import {
  DERIVATION_LABELS,
  G,
  decodePoint,
  deriveBytes,
  encodePoint,
  identityFromSecret,
  openSealedWithSharedPoint,
  parsePeerId,
  proveDleq,
  scalarToBytes,
  scalePoint,
  signObject,
  verifyDleq,
  verifyObject,
} from '@cp2p/crypto';
import type { DleqProof } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { deckCeremonyId } from './deck-genesis.js';
import { escrowShareEnvelopeHash, verifyEscrowShareEphemeralProof } from './escrow-distribution.js';
import type { EscrowShareEnvelope } from './escrow-distribution.js';
import { escrowDeliveryContexts, readEscrowShareOpening } from './escrow-opening.js';
import { validateGenesisMasters } from './genesis-masters.js';
import { hashSchema, key32Schema, seatSchema, signature64Schema } from './schema-values.js';
import { genesisSchema } from './schemas.js';
import type { GenesisBody } from './types.js';
import { parseCanonical } from './validation.js';

const PROTOCOL = 'escrow-share-dispute-v1';

interface DisputeBinding {
  readonly protocol: typeof PROTOCOL;
  readonly ceremonyId: string;
  readonly dealerSeat: Seat;
  readonly holderSeat: Seat;
  readonly envelopeHash: string;
}

export interface EscrowShareDispute {
  readonly body: DisputeBinding & { readonly sharedPoint: string; readonly proof: DleqProof };
  readonly sig: string;
}

/** Both verdicts disclose a share, requiring ceremony abort and master retirement. */
export type EscrowDisputeVerdict =
  | { readonly kind: 'bad-share'; readonly dealerSeat: Seat; readonly dispute: EscrowShareDispute }
  | {
      readonly kind: 'false-complaint';
      readonly holderSeat: Seat;
      readonly dispute: EscrowShareDispute;
    };

const bodySchema = v.union([genesisSchema, v.omit(genesisSchema, ['gameId', 'signatures'])]);

const disputeSchema = v.strictObject({
  body: v.strictObject({
    protocol: v.literal(PROTOCOL),
    ceremonyId: key32Schema,
    dealerSeat: seatSchema,
    holderSeat: seatSchema,
    envelopeHash: hashSchema,
    sharedPoint: key32Schema,
    proof: v.strictObject({
      commitments: v.tuple([key32Schema, key32Schema]),
      response: key32Schema,
    }),
  }),
  sig: signature64Schema,
});

function checkedDelivery(
  envelope: unknown,
  genesis: GenesisBody,
  dealerSeat: Seat,
): Result<EscrowShareEnvelope> {
  const masters = validateGenesisMasters(genesis);
  if (!masters.ok) return masters;
  const master = masters.value.find((item) => item.seat === dealerSeat);
  if (!master) return failure('escrow-dispute-dealer', 'Dealer has no master commitment');
  return verifyEscrowShareEphemeralProof(envelope, genesis, dealerSeat, master.masterPub);
}

function binding(envelope: EscrowShareEnvelope): DisputeBinding {
  return {
    protocol: PROTOCOL,
    ceremonyId: envelope.body.ceremonyId,
    dealerSeat: envelope.body.dealer.seat,
    holderSeat: envelope.body.holder.seat,
    envelopeHash: escrowShareEnvelopeHash(envelope),
  };
}

function statement(envelope: EscrowShareEnvelope, sharedPoint: string) {
  return {
    base1: encodePoint(G),
    point1: envelope.body.holder.encryptionKey,
    base2: envelope.body.sealed.ephemeral,
    point2: sharedPoint,
  };
}

function openDisputed(envelope: EscrowShareEnvelope, sharedPoint: string) {
  return readEscrowShareOpening(
    openSealedWithSharedPoint(
      envelope.body.sealed,
      envelope.body.holder.encryptionKey,
      sharedPoint,
      escrowDeliveryContexts(envelope.body).seal,
    ),
    envelope.body,
  );
}

/**
 * Reveals decryption evidence only for an authenticated, demonstrably bad share.
 * Sender ephemeral-key knowledge must pass before computing a disclosed point.
 * Publication requires ceremony abort and retirement of all local dealing masters.
 */
export function createEscrowShareDispute(input: {
  readonly genesis: GenesisBody;
  readonly envelope: unknown;
  readonly dealerSeat: Seat;
  readonly holderSeat: Seat;
  readonly recipientEncryptionSecret: bigint;
  readonly holderSigningKey: Uint8Array;
}): Result<EscrowShareDispute> {
  let secretBytes: Uint8Array | undefined;
  let proofSeed: Uint8Array | undefined;
  try {
    const checked = checkedDelivery(input.envelope, input.genesis, input.dealerSeat);
    if (!checked.ok) return checked;
    const envelope = checked.value;
    const { holder } = envelope.body;
    if (
      holder.seat !== input.holderSeat ||
      encodePoint(scalePoint(G, input.recipientEncryptionSecret)) !== holder.encryptionKey
    )
      return failure('escrow-dispute-holder', 'Holder secret does not match this delivery');
    const identity = identityFromSecret(input.holderSigningKey);
    const matches = identity.peerId === holder.publicKey;
    identity.secretKey.fill(0);
    if (!matches) return failure('escrow-dispute-holder', 'Holder signing key does not match');
    const sharedPoint = encodePoint(
      scalePoint(decodePoint(envelope.body.sealed.ephemeral), input.recipientEncryptionSecret),
    );
    if (openDisputed(envelope, sharedPoint).ok)
      return failure('escrow-good-delivery', 'A valid share is not evidence against its dealer');
    const context = binding(envelope);
    secretBytes = scalarToBytes(input.recipientEncryptionSecret);
    proofSeed = deriveBytes(
      secretBytes,
      DERIVATION_LABELS.proofRandomness,
      { ...context, sharedPoint, role: 'escrow-dispute' },
      32,
    );
    const proof = proveDleq(
      statement(envelope, sharedPoint),
      input.recipientEncryptionSecret,
      proofSeed,
      context,
    );
    const body = { ...context, sharedPoint, proof };
    return success({ body, sig: signObject('escrow-share-dispute', body, input.holderSigningKey) });
  } catch {
    return failure('escrow-dispute-production', 'Could not prove an invalid escrow delivery');
  } finally {
    proofSeed?.fill(0);
    secretBytes?.fill(0);
  }
}

/** A successful verdict requires ceremony abort. Failure alone attributes no misconduct. */
export function verifyEscrowShareDispute(
  value: unknown,
  envelopeValue: unknown,
  genesis: GenesisBody,
): Result<EscrowDisputeVerdict> {
  try {
    const parsed = parseCanonical(value, disputeSchema);
    if (!parsed.ok) return parsed;
    const signed = parsed.value;
    const parsedGenesis = parseCanonical(genesis, bodySchema);
    if (!parsedGenesis.ok) return parsedGenesis;
    const frozenGenesis = parsedGenesis.value;
    const masters = validateGenesisMasters(frozenGenesis);
    if (!masters.ok) return masters;
    const holder = frozenGenesis.seats.find((seat) => seat.seat === signed.body.holderSeat);
    if (
      holder?.kind !== 'human' ||
      signed.body.ceremonyId !== deckCeremonyId(frozenGenesis) ||
      !verifyObject('escrow-share-dispute', signed.body, signed.sig, parsePeerId(holder.publicKey))
    )
      return failure('escrow-dispute-signature', 'Complaint is not signed by its ceremony holder');
    const checked = checkedDelivery(envelopeValue, frozenGenesis, signed.body.dealerSeat);
    if (!checked.ok) return checked;
    const envelope = checked.value;
    const context = binding(envelope);
    if (
      signed.body.holderSeat !== context.holderSeat ||
      signed.body.envelopeHash !== context.envelopeHash
    )
      return failure('escrow-dispute-binding', 'Complaint concerns another sealed share');
    decodePoint(signed.body.sharedPoint, { nonIdentity: true });
    if (!verifyDleq(statement(envelope, signed.body.sharedPoint), signed.body.proof, context))
      return failure('escrow-dispute-proof', 'Disclosed decryption point is not authenticated');
    if (openDisputed(envelope, signed.body.sharedPoint).ok)
      return success({ kind: 'false-complaint', holderSeat: holder.seat, dispute: signed });
    return success({ kind: 'bad-share', dealerSeat: signed.body.dealerSeat, dispute: signed });
  } catch {
    return failure('escrow-dispute', 'Escrow complaint could not be verified');
  }
}

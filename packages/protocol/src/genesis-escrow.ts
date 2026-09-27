import { hashValue, toHex } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { deckCeremonyId } from './deck-genesis.js';
import {
  escrowShareEnvelopeSchema,
  escrowShareEnvelopeHash,
  prepareEscrowVerifier,
} from './escrow-distribution.js';
import type { EscrowShareAck, EscrowShareEnvelope } from './escrow-distribution.js';
import { deriveEscrowRosters } from './escrow-roster.js';
import { validateGenesisMasters } from './genesis-masters.js';
import { seatSchema } from './schema-values.js';
import { genesisSchema } from './schemas.js';
import type { GenesisBody } from './types.js';
import { parseCanonical } from './validation.js';

export interface EscrowDealerCommitment {
  dealerSeat: Seat;
  shares: readonly { envelope: EscrowShareEnvelope; ack: EscrowShareAck }[];
}

const bodySchema = v.union([genesisSchema, v.omit(genesisSchema, ['gameId', 'signatures'])]);
const escrowSchema = v.pipe(
  v.array(
    v.strictObject({
      dealerSeat: seatSchema,
      shares: v.pipe(
        v.array(v.strictObject({ envelope: v.unknown(), ack: v.unknown() })),
        v.maxLength(5),
      ),
    }),
  ),
  v.maxLength(6),
);

/**
 * Verify every signed delivery and its exact holder ACK before genesis consent.
 * An ACK is evidence of holder acceptance, not a public proof of the plaintext.
 * Only authorized recovery or end-game reveal may publish the private shares.
 */
export function validateGenesisEscrow(
  value: GenesisBody,
): Result<readonly EscrowDealerCommitment[]> {
  const parsedBody = parseCanonical(value, bodySchema);
  if (!parsedBody.ok) return parsedBody;
  const genesis = parsedBody.value;
  if (genesis.security === 'stub')
    return genesis.commitments.escrow === undefined
      ? success([])
      : failure('stub-escrow', 'Stub games cannot claim escrow distribution');
  const masters = validateGenesisMasters(genesis);
  if (!masters.ok) return masters;
  const rosters = deriveEscrowRosters(genesis);
  if (!rosters.ok) return rosters;
  const parsed = parseCanonical(genesis.commitments.escrow, escrowSchema);
  if (!parsed.ok)
    return failure('genesis-escrow', 'Genesis needs an explicit bounded escrow transcript');
  const eligible = rosters.value.filter((roster) => roster.eligible);
  if (
    parsed.value.length !== eligible.length ||
    parsed.value.some((item, index) => item.dealerSeat !== eligible[index]?.dealer.seat)
  )
    return failure('genesis-escrow-roster', 'Escrow dealers differ from the original human roster');
  const ceremonyId = deckCeremonyId(genesis);
  // Reject missing holders and mixed polynomials before any signature/proof work.
  const ordered: {
    dealerSeat: Seat;
    masterPub: string;
    shares: { envelope: EscrowShareEnvelope; ack: unknown }[];
  }[] = [];
  for (const [index, roster] of eligible.entries()) {
    const item = parsed.value[index];
    const master = masters.value.find((entry) => entry.seat === roster.dealer.seat);
    if (!item || !master || item.shares.length !== roster.holders.length)
      return failure(
        'genesis-escrow-holders',
        'Every required holder must accept exactly one share',
      );
    const shares: { envelope: EscrowShareEnvelope; ack: unknown }[] = [];
    let commitmentsHash: string | null = null;
    for (const [holderIndex, holder] of roster.holders.entries()) {
      const delivery = item.shares[holderIndex];
      if (!delivery) return failure('genesis-escrow-holders', 'An escrow delivery is missing');
      const envelope = parseCanonical(delivery.envelope, escrowShareEnvelopeSchema);
      if (!envelope.ok) return envelope;
      const { body } = envelope.value;
      if (body.holder.seat !== holder.seat)
        return failure('genesis-escrow-order', 'Escrow shares must follow the exact holder order');
      if (
        body.dealer.seat !== roster.dealer.seat ||
        body.threshold !== roster.threshold ||
        body.commitments.length !== roster.threshold ||
        body.masterPub !== master.masterPub ||
        body.commitments[0] !== master.masterPub
      )
        return failure('escrow-binding', 'Escrow share differs from its frozen ceremony roster');
      const hash = toHex(hashValue(body.commitments));
      if (commitmentsHash !== null && commitmentsHash !== hash)
        return failure(
          'genesis-escrow-polynomial',
          'A dealer supplied different share polynomials',
        );
      commitmentsHash = hash;
      shares.push({ envelope: envelope.value, ack: delivery.ack });
    }
    ordered.push({ dealerSeat: roster.dealer.seat, masterPub: master.masterPub, shares });
  }
  const verifier = prepareEscrowVerifier(genesis);
  if (!verifier.ok) return verifier;
  const result: EscrowDealerCommitment[] = [];
  for (const item of ordered) {
    const shares: { envelope: EscrowShareEnvelope; ack: EscrowShareAck }[] = [];
    for (const delivery of item.shares) {
      const envelope = verifier.value.envelope(delivery.envelope, item.dealerSeat, item.masterPub);
      if (!envelope.ok) return envelope;
      const ack = verifier.value.ack(delivery.ack, {
        ceremonyId,
        dealerSeat: item.dealerSeat,
        holderSeat: envelope.value.body.holder.seat,
        expectedMasterPub: item.masterPub,
        shareHash: envelope.value.body.shareHash,
        envelopeHash: escrowShareEnvelopeHash(envelope.value),
      });
      if (!ack.ok) return ack;
      shares.push({ envelope: envelope.value, ack: ack.value });
    }
    result.push({ dealerSeat: item.dealerSeat, shares });
  }
  return success(result);
}

import { canonicalDecode, hashValue, toHex } from '@cp2p/codec';
import { decodeScalar, verifyFeldmanShare } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import * as v from 'valibot';
import type { EscrowShareEnvelope } from './escrow-types.js';
import { key32Schema, seatSchema } from './schema-values.js';
import { parseCanonical } from './validation.js';

const payloadSchema = v.strictObject({
  protocol: v.literal('escrow-share-v1'),
  ceremonyId: key32Schema,
  dealerSeat: seatSchema,
  holderSeat: seatSchema,
  holderIndex: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6)),
  threshold: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6)),
  masterPub: key32Schema,
  share: key32Schema,
});

type DeliveryBinding = Omit<EscrowShareEnvelope['body'], 'sealed' | 'ephemeralProof'>;

export function escrowDeliveryContexts(body: DeliveryBinding) {
  const { protocol, ceremonyId, dealer, holder, threshold, masterPub, commitments, shareHash } =
    body;
  const binding = {
    protocol,
    ceremonyId,
    dealer,
    holder,
    threshold,
    masterPub,
    commitments,
    shareHash,
  };
  return {
    seal: { domain: 'cp2p/v1/escrow-sealed-share', ...binding },
    proof: { domain: 'cp2p/v1/escrow-share-ephemeral-proof', ...binding },
  };
}

/** The caller authenticates the envelope first. This consumes and clears plaintext. */
export function readEscrowShareOpening(
  plaintext: Uint8Array,
  body: EscrowShareEnvelope['body'],
): Result<{ index: number; value: bigint }> {
  try {
    if (
      toHex(hashValue({ domain: 'cp2p/v1/escrow-share-payload', payload: plaintext })) !==
      body.shareHash
    )
      return failure('escrow-share-hash', 'Decrypted share payload does not match its signed hash');
    const payload = parseCanonical(canonicalDecode(plaintext), payloadSchema);
    if (!payload.ok) return failure('escrow-share-payload', 'Decrypted share payload is malformed');
    const share = { index: payload.value.holderIndex, value: decodeScalar(payload.value.share) };
    if (
      payload.value.ceremonyId !== body.ceremonyId ||
      payload.value.dealerSeat !== body.dealer.seat ||
      payload.value.holderSeat !== body.holder.seat ||
      payload.value.holderIndex !== body.holder.index ||
      payload.value.threshold !== body.threshold ||
      payload.value.masterPub !== body.masterPub ||
      !verifyFeldmanShare(share, body.commitments, {
        threshold: body.threshold,
        masterPub: body.masterPub,
        recipientIndex: body.holder.index,
      })
    )
      return failure(
        'escrow-feldman-share',
        'Decrypted share does not open its Feldman commitment',
      );
    return success(share);
  } catch {
    return failure('escrow-share-payload', 'Decrypted share payload is malformed');
  } finally {
    plaintext.fill(0);
  }
}

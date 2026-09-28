import { hashValue, toHex } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import * as v from 'valibot';
import { escrowShareEnvelopeHash } from './escrow-distribution.js';
import { verifyEscrowShareDispute } from './escrow-dispute.js';
import { validateGenesisEscrow } from './genesis-escrow.js';
import { validateGenesisOnlineStart } from './genesis-online-start.js';
import {
  onlineCeremonyAttemptId,
  onlineCeremonyPacketKey,
  verifyOnlineCeremonyPacket,
} from './online-ceremony-wire.js';
import { genesisSchema } from './schemas.js';
import type { Genesis } from './types.js';
import type { EscrowLifecycleStore } from './escrow-lifecycle.js';
import { MAX_MESSAGE_BYTES, parseCanonical } from './validation.js';

const disputeSchema = v.strictObject({ envelope: v.unknown(), dispute: v.unknown() });

/** Owns the original authenticated roster and pinned envelopes across storage awaits. */
export function prepareOnlineDisclosureGuard(genesis: Genesis): Result<{
  readonly attemptId: string;
  check(store: Pick<EscrowLifecycleStore, 'load'>): Promise<Result<boolean>>;
}> {
  const owned = parseCanonical(genesis, genesisSchema);
  if (!owned.ok) return owned;
  const start = validateGenesisOnlineStart(owned.value);
  if (!start.ok) return start;
  const escrow = validateGenesisEscrow(owned.value);
  if (!escrow.ok) return escrow;
  const state = start.value.bindings.agreement.state;
  const freezeHash = toHex(hashValue(state));
  const nonce = state.ceremonyNonce;
  if (!nonce) return failure('online-disclosure-genesis', 'Frozen ceremony nonce is missing');
  const attemptId = onlineCeremonyAttemptId(freezeHash, nonce);
  return success({
    attemptId,
    async check(store) {
      try {
        for (const dealer of escrow.value) {
          for (const { envelope } of dealer.shares) {
            const holder = state.seats.find((seat) => seat.seat === envelope.body.holder.seat);
            if (!holder || holder.kind !== 'human') continue;
            const key = onlineCeremonyPacketKey(
              attemptId,
              'escrow-dispute',
              holder.seat,
              dealer.dealerSeat,
            );
            // oxlint-disable-next-line no-await-in-loop -- Check only the bounded pinned roster slots.
            const bytes = await store.load(key);
            if (!bytes || bytes.byteLength > MAX_MESSAGE_BYTES) continue;
            const packet = verifyOnlineCeremonyPacket(bytes, holder.peer, freezeHash, nonce);
            if (
              !packet.ok ||
              packet.value.body.kind !== 'escrow-dispute' ||
              packet.value.body.seat !== holder.seat ||
              packet.value.body.step !== dealer.dealerSeat
            )
              continue;
            const payload = parseCanonical(packet.value.body.payload, disputeSchema);
            if (!payload.ok) continue;
            const verdict = verifyEscrowShareDispute(
              payload.value.dispute,
              payload.value.envelope,
              owned.value,
            );
            if (
              !verdict.ok ||
              verdict.value.dispute.body.holderSeat !== holder.seat ||
              verdict.value.dispute.body.dealerSeat !== dealer.dealerSeat ||
              verdict.value.dispute.body.envelopeHash !== escrowShareEnvelopeHash(envelope)
            )
              continue;
            return success(true);
          }
        }
        return success(false);
      } catch {
        return failure('online-disclosure-store', 'Could not inspect retained disclosure evidence');
      }
    },
  });
}

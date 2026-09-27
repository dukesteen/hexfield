import { scalarToBytes } from '@cp2p/crypto';
import type { Identity } from '@cp2p/crypto';
import type { Result, Seat } from '@cp2p/engine';
import { acceptEscrowShare, createEscrowShareEnvelopes } from '../escrow-distribution.js';
import { deriveEscrowRosters } from '../escrow-roster.js';
import type { EscrowDealerCommitment } from '../genesis-escrow.js';
import { validateGenesisMasters } from '../genesis-masters.js';
import { createStealSecretSource } from '../steal-source.js';
import type { GenesisBody } from '../types.js';

function checked<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** Test-only companions to the deterministic deck/encryption masters, 17 + seat. */
export function createGenesisEscrowFixture(
  body: GenesisBody,
  identities: ReadonlyMap<Seat, Identity>,
): GenesisBody {
  if (body.commitments.escrow !== undefined) return body;
  const rosters = checked(deriveEscrowRosters(body));
  const masters = checked(validateGenesisMasters(body));
  const escrow: EscrowDealerCommitment[] = [];
  for (const roster of rosters.filter((item) => item.eligible)) {
    const dealer = identities.get(roster.dealer.seat);
    const master = masters.find((item) => item.seat === roster.dealer.seat);
    if (!dealer || !master) throw new Error('Missing escrow dealer fixture key');
    const entropy = scalarToBytes(BigInt(17 + roster.dealer.seat));
    try {
      const envelopes = checked(
        createEscrowShareEnvelopes({
          genesis: body,
          dealerSeat: roster.dealer.seat,
          expectedMasterPub: master.masterPub,
          masterSecret: BigInt(17 + roster.dealer.seat),
          entropy,
          dealerSigningKey: dealer.secretKey,
        }),
      );
      const shares = envelopes.map((envelope) => {
        const holder = identities.get(envelope.body.holder.seat);
        if (!holder) throw new Error('Missing escrow holder fixture key');
        const retained = scalarToBytes(BigInt(17 + envelope.body.holder.seat));
        const source = createStealSecretSource(
          retained,
          body.ceremonyNonce,
          envelope.body.holder.seat,
          holder.peerId,
        );
        retained.fill(0);
        try {
          const accepted = checked(
            acceptEscrowShare({
              envelope,
              genesis: body,
              dealerSeat: roster.dealer.seat,
              expectedMasterPub: master.masterPub,
              holderSeat: envelope.body.holder.seat,
              recipientEncryptionSecret: source.encryptionSecret(),
              holderSigningKey: holder.secretKey,
            }),
          );
          return { envelope, ack: accepted.ack };
        } finally {
          source.dispose();
        }
      });
      escrow.push({ dealerSeat: roster.dealer.seat, shares });
    } finally {
      entropy.fill(0);
    }
  }
  return { ...body, commitments: { ...body.commitments, escrow } };
}

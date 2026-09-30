import { canonicalDecode, fromBase64Url } from '@cp2p/codec';
import type { Seat } from '@cp2p/engine';
import { signedMasterRevealSchema } from '@cp2p/protocol';
import type { EscrowCeremonyStore } from '@cp2p/protocol';
import * as v from 'valibot';
import { loadOnlineGameOutcome } from './online-game-history.js';
import type { SavedOnlineGameRecord } from './online-game-records.js';

const acceptedSchema = v.object({
  protocol: v.literal('master-reveal-accepted-v1'),
  packet: signedMasterRevealSchema,
});

export interface RevealedMaster {
  readonly seat: Seat;
  readonly master: Uint8Array;
}

/**
 * The master secrets every seat revealed for a game's end-of-game audit, as this device
 * accepted them. Empty unless the stored audit verified and every seat's reveal is present.
 * The masters are not trusted here: a replay passes them to the audit again, which checks each
 * one against the signed genesis before it reconstructs a hand.
 */
export async function loadRevealedMasters(
  store: EscrowCeremonyStore,
  start: Pick<SavedOnlineGameRecord, 'gameId' | 'genesisDigest'> & {
    readonly result: { readonly genesis: { readonly seats: readonly { readonly seat: Seat }[] } };
  },
): Promise<RevealedMaster[]> {
  const outcome = await loadOnlineGameOutcome(store, start.gameId, start.genesisDigest);
  if (outcome?.audit.status !== 'verified') return [];
  const { seq, hash } = outcome.terminalHead;
  const masters: RevealedMaster[] = [];
  for (const { seat } of start.result.genesis.seats) {
    const key = `master-reveal/accepted/${start.genesisDigest}/${seq}-${hash}/${seat}`;
    // oxlint-disable-next-line eslint/no-await-in-loop -- Bounded by the six-seat genesis roster.
    const bytes = await store.load(key);
    if (!bytes) break;
    try {
      const parsed = v.safeParse(acceptedSchema, canonicalDecode(bytes));
      if (!parsed.success || parsed.output.packet.body.originalSeat !== seat) break;
      masters.push({ seat, master: fromBase64Url(parsed.output.packet.body.master) });
    } finally {
      bytes.fill(0);
    }
  }
  if (masters.length === start.result.genesis.seats.length) return masters;
  for (const item of masters) item.master.fill(0);
  return [];
}

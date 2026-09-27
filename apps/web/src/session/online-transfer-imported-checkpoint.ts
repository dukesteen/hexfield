import { entryHash } from '@cp2p/protocol';
import type { Seat } from '@cp2p/engine';
import type { IndexedDbByteStore } from '@cp2p/storage';
import { openOnlineFullSave } from './online-full-save-store.js';
import type {
  ExpectedOnlineTransferGame,
  VerifiedOnlineTransferBootstrap,
} from './online-transfer-bootstrap.js';

/** An imported file is historical evidence, never a source of voting material. */
export async function verifyImportedTransferCheckpoint(
  store: IndexedDbByteStore,
  id: string,
  expected: ExpectedOnlineTransferGame,
  bootstrap: VerifiedOnlineTransferBootstrap,
): Promise<Seat> {
  const opened = await openOnlineFullSave(store, id);
  if (!opened.ok || !opened.value)
    throw new TypeError(
      `Imported full save is unavailable or invalid: ${opened.ok ? 'missing' : opened.error.code}`,
    );
  const save = opened.value;
  try {
    const archive = save.public;
    if (
      archive.gameId !== expected.gameId ||
      archive.genesisDigest !== expected.genesisDigest ||
      archive.gameId !== bootstrap.record.gameId ||
      archive.genesisDigest !== bootstrap.record.genesisDigest ||
      entryHash(archive.start.result.entry) !== entryHash(bootstrap.record.result.entry) ||
      archive.entries.length > bootstrap.entries.length ||
      archive.entries.some((item, index) => {
        const matching = bootstrap.entries[index];
        return !matching || entryHash(item.entry) !== entryHash(matching.entry);
      })
    )
      throw new TypeError('Imported full save is not an exact certified prefix of transfer');
    return save.safety.seat;
  } finally {
    save.dispose();
  }
}

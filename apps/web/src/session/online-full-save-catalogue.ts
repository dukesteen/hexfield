import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import type { EscrowCeremonyStore } from '@cp2p/protocol';
import * as v from 'valibot';
import type { VerifiedOnlineFullSave } from './online-full-save.js';

const KEY = 'online-full-import/v1/catalogue';
const LOCK = 'online-full-import/v1/catalogue-lock';
const MAX_SUMMARIES = 32;
const MAX_CATALOGUE_BYTES = 16_384;
const summarySchema = v.strictObject({
  id: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  gameId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/)),
  names: v.pipe(
    v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(40))),
    v.minLength(2),
    v.maxLength(6),
  ),
  createdAt: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  headSeq: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8192)),
  privateCapsule: v.picklist(['none', 'encrypted'] as const),
});
const catalogueSchema = v.strictObject({
  protocol: v.literal('online-full-import-catalogue-v1'),
  saves: v.pipe(v.array(summarySchema), v.maxLength(MAX_SUMMARIES)),
});

export type ImportedOnlineFullSaveSummary = v.InferOutput<typeof summarySchema>;

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

async function readCatalogue(store: Pick<EscrowCeremonyStore, 'load'>): Promise<{
  bytes: Uint8Array | null;
  saves: ImportedOnlineFullSaveSummary[];
}> {
  const bytes = await store.load(KEY);
  if (bytes === null) return { bytes: null, saves: [] };
  if (bytes.length > MAX_CATALOGUE_BYTES)
    throw new Error('Imported full-save catalogue is oversized');
  const decoded: unknown = canonicalDecode(bytes);
  const checked = v.safeParse(catalogueSchema, decoded);
  if (
    !checked.success ||
    !equalBytes(bytes, canonicalEncode(checked.output)) ||
    new Set(checked.output.saves.map((item) => item.id)).size !== checked.output.saves.length
  )
    throw new Error('Imported full-save catalogue is malformed');
  return { bytes, saves: checked.output.saves };
}

/** Display-only locators. Opening an ID revalidates the complete stored file. */
export async function listImportedOnlineFullSaveSummaries(
  store: Pick<EscrowCeremonyStore, 'load'>,
): Promise<Result<readonly ImportedOnlineFullSaveSummary[]>> {
  try {
    return success((await readCatalogue(store)).saves);
  } catch {
    return failure('full-save-catalogue', 'Imported full-save catalogue could not be read');
  }
}

/** Publish only after the immutable file manifest exists; retry repairs an orphan manifest. */
export async function catalogueImportedOnlineFullSave(
  store: EscrowCeremonyStore,
  save: VerifiedOnlineFullSave,
): Promise<Result<ImportedOnlineFullSaveSummary>> {
  try {
    const names = save.public.start.agreement.state.seats.map((seat) =>
      seat.kind === 'open' ? '' : seat.name,
    );
    const summary = v.parse(summarySchema, {
      id: save.id,
      gameId: save.public.gameId,
      names,
      createdAt: save.public.start.result.genesis.createdAt,
      headSeq: save.public.head.seq,
      privateCapsule: save.privateLocked || save.private ? 'encrypted' : 'none',
    });
    return store.withCeremonyLock(LOCK, async () => {
      const current = await readCatalogue(store);
      const prior = current.saves.find((item) => item.id === summary.id);
      if (prior) {
        const checked = canonicalEncode(summary);
        try {
          return equalBytes(canonicalEncode(prior), checked)
            ? success(prior)
            : failure('full-save-catalogue', 'Imported full-save summary conflicts');
        } finally {
          checked.fill(0);
        }
      }
      if (current.saves.length >= MAX_SUMMARIES)
        return failure('full-save-limit', 'Imported full-save catalogue is full');
      const next = canonicalEncode(
        v.parse(catalogueSchema, {
          protocol: 'online-full-import-catalogue-v1',
          saves: [...current.saves, summary],
        }),
      );
      if (next.length > MAX_CATALOGUE_BYTES)
        return failure('full-save-limit', 'Imported full-save catalogue exceeds its size limit');
      const persisted =
        current.bytes === null
          ? await store.putIfAbsent(KEY, next)
          : await store.compareAndSwap(KEY, current.bytes, next);
      return persisted
        ? success(summary)
        : failure('full-save-catalogue', 'Imported full-save catalogue changed during import');
    });
  } catch {
    return failure('full-save-catalogue', 'Imported full-save catalogue could not be updated');
  }
}

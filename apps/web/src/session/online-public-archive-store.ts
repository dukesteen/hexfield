import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import type { EscrowCeremonyStore } from '@cp2p/protocol';
import * as v from 'valibot';
import {
  MAX_ONLINE_PUBLIC_ARCHIVE_BYTES,
  peekOnlinePublicArchiveVersion,
  validateOnlinePublicArchive,
} from './online-public-archive.js';
import type { PublicArchiveVersion, VerifiedPublicOnlineArchive } from './online-public-archive.js';

const NAMESPACE = 'online-replay/v1';
const CATALOGUE_KEY = `${NAMESPACE}/catalogue`;
const CATALOGUE_LOCK = `${NAMESPACE}/catalogue-lock`;
const MAX_ARCHIVES = 32;
const ID = /^[0-9a-f]{64}$/;
const summarySchema = v.strictObject({
  id: v.pipe(v.string(), v.regex(ID)),
  gameId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/)),
  names: v.pipe(
    v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(40))),
    v.minLength(2),
    v.maxLength(6),
  ),
  createdAt: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  headSeq: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8192)),
});
const catalogueSchema = v.strictObject({
  protocol: v.literal('online-public-archive-catalogue-v1'),
  archives: v.pipe(v.array(summarySchema), v.maxLength(MAX_ARCHIVES)),
});

export type PublicArchiveSummary = v.InferOutput<typeof summarySchema>;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function archiveKey(id: string): string {
  return `${NAMESPACE}/archive/${id}`;
}

async function readCatalogue(
  store: EscrowCeremonyStore,
): Promise<{ bytes: Uint8Array | null; archives: PublicArchiveSummary[] }> {
  const bytes = await store.load(CATALOGUE_KEY);
  if (bytes === null) return { bytes: null, archives: [] };
  if (bytes.length > 16_384) throw new Error('Public replay catalogue exceeds its size limit');
  const decoded: unknown = canonicalDecode(bytes);
  const parsed = v.safeParse(catalogueSchema, decoded);
  if (
    !parsed.success ||
    !equalBytes(bytes, canonicalEncode(parsed.output)) ||
    new Set(parsed.output.archives.map((archive) => archive.id)).size !==
      parsed.output.archives.length
  )
    throw new Error('Public replay catalogue is invalid');
  return { bytes, archives: parsed.output.archives };
}

/** Catalogue IDs are locators only; opening an archive verifies its signed history afresh. */
export async function listOnlinePublicArchives(
  store: EscrowCeremonyStore,
): Promise<Result<readonly string[]>> {
  const listed = await listOnlinePublicArchiveSummaries(store);
  return listed.ok ? success(listed.value.map((item) => item.id)) : listed;
}

/** Display metadata is unverified on listing; opening checks the content address and replay. */
export async function listOnlinePublicArchiveSummaries(
  store: EscrowCeremonyStore,
): Promise<Result<readonly PublicArchiveSummary[]>> {
  try {
    const catalogue = await readCatalogue(store);
    return success(catalogue.archives);
  } catch {
    return failure('public-archive-catalogue', 'Public replay catalogue could not be read');
  }
}

/** Reads solely from the replay namespace; no session, writer lease, or voting state is made. */
export async function openOnlinePublicArchive(
  store: EscrowCeremonyStore,
  id: string,
): Promise<Result<VerifiedPublicOnlineArchive | null>> {
  if (!ID.test(id)) return failure('public-archive-id', 'Public replay identifier is invalid');
  try {
    const bytes = await store.load(archiveKey(id));
    if (bytes === null) return success(null);
    if (bytes.length > MAX_ONLINE_PUBLIC_ARCHIVE_BYTES)
      return failure('public-archive-size', 'Stored public replay exceeds its size limit');
    const checked = validateOnlinePublicArchive(bytes);
    if (!checked.ok) return checked;
    return checked.value.id === id
      ? success(checked.value)
      : failure('public-archive-id', 'Stored public replay differs from its content address');
  } catch {
    return failure('public-archive-storage', 'Stored public replay could not be opened');
  }
}

/** Why a stored archive failed to open, when it declares another version (unverified). */
export async function peekStoredOnlinePublicArchiveVersion(
  store: EscrowCeremonyStore,
  id: string,
): Promise<PublicArchiveVersion | null> {
  if (!ID.test(id)) return null;
  try {
    const bytes = await store.load(archiveKey(id));
    return bytes && bytes.length <= MAX_ONLINE_PUBLIC_ARCHIVE_BYTES
      ? peekOnlinePublicArchiveVersion(bytes)
      : null;
  } catch {
    return null;
  }
}

/**
 * Verifies before writing and indexes only immutable public bytes. If catalogue
 * persistence fails after the blob write, exact re-import repairs the orphan.
 */
export async function importOnlinePublicArchive(
  store: EscrowCeremonyStore,
  supplied: Uint8Array,
): Promise<Result<VerifiedPublicOnlineArchive>> {
  if (!(supplied instanceof Uint8Array) || supplied.length > MAX_ONLINE_PUBLIC_ARCHIVE_BYTES)
    return failure('public-archive-size', 'Public replay exceeds its size limit');
  const bytes = new Uint8Array(supplied);
  const checked = validateOnlinePublicArchive(bytes);
  if (!checked.ok) return checked;
  const archive = checked.value;
  try {
    const names = archive.start.agreement.state.seats.map((seat) =>
      seat.kind === 'open' ? '' : seat.name,
    );
    const summary = v.parse(summarySchema, {
      id: archive.id,
      gameId: archive.gameId,
      names,
      createdAt: archive.start.result.genesis.createdAt,
      headSeq: archive.head.seq,
    });
    return await store.withCeremonyLock(CATALOGUE_LOCK, async () => {
      const catalogue = await readCatalogue(store);
      const alreadyIndexed = catalogue.archives.some((item) => item.id === archive.id);
      if (!alreadyIndexed && catalogue.archives.length >= MAX_ARCHIVES)
        return failure('public-archive-limit', 'Public replay catalogue is full');
      const next = alreadyIndexed
        ? null
        : canonicalEncode(
            v.parse(catalogueSchema, {
              protocol: 'online-public-archive-catalogue-v1',
              archives: [...catalogue.archives, summary],
            }),
          );
      if (next && next.length > 16_384)
        return failure('public-archive-limit', 'Public replay catalogue exceeds its size limit');
      const key = archiveKey(archive.id);
      if (!(await store.putIfAbsent(key, bytes))) {
        const existing = await store.load(key);
        if (!existing || !equalBytes(existing, bytes))
          return failure('public-archive-conflict', 'Content address contains different bytes');
      }
      if (next === null) return success(archive);
      const indexed =
        catalogue.bytes === null
          ? await store.putIfAbsent(CATALOGUE_KEY, next)
          : await store.compareAndSwap(CATALOGUE_KEY, catalogue.bytes, next);
      return indexed
        ? success(archive)
        : failure('public-archive-catalogue', 'Public replay catalogue changed during import');
    });
  } catch {
    return failure('public-archive-storage', 'Public replay could not be stored');
  }
}

const mastersSchema = v.strictObject({
  protocol: v.literal('online-public-archive-masters-v1'),
  masters: v.pipe(
    v.array(
      v.strictObject({
        seat: v.picklist([0, 1, 2, 3, 4, 5] as const),
        master: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/)),
      }),
    ),
    v.minLength(2),
    v.maxLength(6),
  ),
});

export type ArchiveMasters = v.InferOutput<typeof mastersSchema>['masters'];

function mastersKey(id: string): string {
  return `${NAMESPACE}/masters/${id}`;
}

/**
 * Keeps the audit's revealed masters beside an archive, so reopening it can show every hand.
 * They are unverified here; opening passes them through the audit, which checks each against
 * the signed genesis. A later import replaces them (a stale set would only fail that audit).
 */
export async function saveOnlineArchiveMasters(
  store: EscrowCeremonyStore,
  id: string,
  masters: ArchiveMasters,
): Promise<Result<void>> {
  if (!ID.test(id)) return failure('public-archive-id', 'Public replay identifier is invalid');
  const parsed = v.safeParse(mastersSchema, {
    protocol: 'online-public-archive-masters-v1',
    masters,
  });
  if (!parsed.success) return failure('public-archive-masters', 'Revealed masters are invalid');
  try {
    const bytes = canonicalEncode(parsed.output);
    const key = mastersKey(id);
    if (await store.putIfAbsent(key, bytes)) return success(undefined);
    const existing = await store.load(key);
    if (existing && equalBytes(existing, bytes)) return success(undefined);
    return existing && (await store.compareAndSwap(key, existing, bytes))
      ? success(undefined)
      : failure('public-archive-masters', 'Revealed masters changed during import');
  } catch {
    return failure('public-archive-storage', 'Revealed masters could not be stored');
  }
}

export async function loadOnlineArchiveMasters(
  store: EscrowCeremonyStore,
  id: string,
): Promise<ArchiveMasters | null> {
  if (!ID.test(id)) return null;
  try {
    const bytes = await store.load(mastersKey(id));
    if (!bytes || bytes.length > 4096) return null;
    const parsed = v.safeParse(mastersSchema, canonicalDecode(bytes));
    return parsed.success ? parsed.output.masters : null;
  } catch {
    return null;
  }
}

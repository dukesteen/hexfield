import { canonicalDecode, canonicalEncode, sha256, toHex } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import type { EscrowCeremonyStore } from '@cp2p/protocol';
import * as v from 'valibot';
import {
  MAX_ONLINE_FULL_SAVE_BYTES,
  validateOnlineFullSave,
  type VerifiedOnlineFullSave,
} from './online-full-save.js';

const NAMESPACE = 'online-full-import/v1';
const ID = /^[0-9a-f]{64}$/;
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CHUNKS = Math.ceil(MAX_ONLINE_FULL_SAVE_BYTES / CHUNK_BYTES);
const manifestSchema = v.strictObject({
  format: v.literal('online-full-import-manifest-v1'),
  id: v.pipe(v.string(), v.regex(ID)),
  length: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_ONLINE_FULL_SAVE_BYTES)),
  chunks: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_CHUNKS)),
});

function manifestKey(id: string): string {
  return `${NAMESPACE}/manifest/${id}`;
}

function chunkKey(id: string, index: number): string {
  return `${NAMESPACE}/chunk/${id}/${index}`;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Imports a verified package into an inert namespace, never the live journal or key store. */
export async function importOnlineFullSave(
  store: Pick<EscrowCeremonyStore, 'load' | 'putIfAbsent'>,
  supplied: Uint8Array,
  passphrase?: string,
): Promise<Result<{ readonly id: string; readonly gameId: string }>> {
  if (!(supplied instanceof Uint8Array) || supplied.length > MAX_ONLINE_FULL_SAVE_BYTES)
    return failure('full-save-size', 'Full save exceeds its size limit');
  const bytes = new Uint8Array(supplied);
  try {
    const checked = await validateOnlineFullSave(bytes, passphrase);
    if (!checked.ok) return checked;
    try {
      if (checked.value.privateLocked)
        return failure('full-save-passphrase', 'Unlock the private capsule before importing');
      const id = checked.value.id;
      const chunks = Math.ceil(bytes.length / CHUNK_BYTES);
      for (let index = 0; index < chunks; index += 1) {
        const piece = bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
        // oxlint-disable-next-line no-await-in-loop -- Each immutable chunk is checked before the manifest is published.
        if (!(await store.putIfAbsent(chunkKey(id, index), piece))) {
          // oxlint-disable-next-line no-await-in-loop -- An exact prior chunk is an idempotent retry.
          const existing = await store.load(chunkKey(id, index));
          if (!existing || !sameBytes(existing, piece))
            return failure('full-save-conflict', 'A full-save chunk conflicts with this file');
        }
      }
      const manifest = canonicalEncode(
        v.parse(manifestSchema, {
          format: 'online-full-import-manifest-v1',
          id,
          length: bytes.length,
          chunks,
        }),
      );
      if (!(await store.putIfAbsent(manifestKey(id), manifest))) {
        const existing = await store.load(manifestKey(id));
        if (!existing || !sameBytes(existing, manifest))
          return failure('full-save-conflict', 'A full-save manifest conflicts with this file');
      }
      return success({ id, gameId: checked.value.public.gameId });
    } finally {
      checked.value.dispose();
    }
  } catch {
    return failure('full-save-storage', 'Full save could not be stored');
  } finally {
    bytes.fill(0);
  }
}

/** Revalidates the file on every open; a locator or old safety tuple confers no vote. */
export async function openOnlineFullSave(
  store: Pick<EscrowCeremonyStore, 'load'>,
  id: string,
  passphrase?: string,
): Promise<Result<VerifiedOnlineFullSave | null>> {
  if (!ID.test(id)) return failure('full-save-id', 'Full-save identifier is malformed');
  let bytes: Uint8Array | null = null;
  try {
    const manifestBytes = await store.load(manifestKey(id));
    if (manifestBytes === null) return success(null);
    if (manifestBytes.length > 256)
      return failure('full-save-format', 'Stored full-save manifest is oversized');
    const decoded: unknown = canonicalDecode(manifestBytes);
    const manifest = v.safeParse(manifestSchema, decoded);
    if (
      !manifest.success ||
      manifest.output.id !== id ||
      !sameBytes(manifestBytes, canonicalEncode(manifest.output)) ||
      manifest.output.chunks !== Math.ceil(manifest.output.length / CHUNK_BYTES)
    )
      return failure('full-save-format', 'Stored full-save manifest is malformed');
    bytes = new Uint8Array(manifest.output.length);
    for (let index = 0; index < manifest.output.chunks; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- A bounded immutable manifest determines exact chunk positions.
      const piece = await store.load(chunkKey(id, index));
      const expected = Math.min(CHUNK_BYTES, bytes.length - index * CHUNK_BYTES);
      if (!piece || piece.length !== expected)
        return failure('full-save-storage', 'Stored full-save chunk is missing or malformed');
      bytes.set(piece, index * CHUNK_BYTES);
    }
    if (toHex(sha256(bytes)) !== id)
      return failure('full-save-id', 'Stored full save differs from its content address');
    const checked = await validateOnlineFullSave(bytes, passphrase);
    if (!checked.ok) return checked;
    if (checked.value.id !== id) {
      checked.value.dispose();
      return failure('full-save-id', 'Stored full save differs from its content address');
    }
    return success(checked.value);
  } catch {
    return failure('full-save-storage', 'Stored full save could not be opened');
  } finally {
    bytes?.fill(0);
  }
}

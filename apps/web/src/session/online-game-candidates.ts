import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { MAX_MESSAGE_BYTES } from '@cp2p/protocol';
import type { CheatCandidateStore, EscrowCeremonyStore } from '@cp2p/protocol';
import * as v from 'valibot';

const candidateSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(200), v.regex(/^[A-Za-z0-9/_-]+$/)),
  bytes: v.custom<Uint8Array>(
    (value) => value instanceof Uint8Array && value.byteLength <= MAX_MESSAGE_BYTES,
  ),
});
const candidatesSchema = v.pipe(v.array(candidateSchema), v.maxLength(64));

/** A bounded per-game catalogue keeps candidate insert/delete atomic across tabs. */
export function createOnlineGameCandidateStore(
  store: EscrowCeremonyStore,
  digest: string,
): CheatCandidateStore {
  if (!/^[A-Za-z0-9_-]{43}$/.test(digest)) throw new TypeError('Invalid game digest');
  const key = `online-game/${digest}/cheat-candidates`;
  const read = async () => {
    const bytes = await store.load(key);
    if (bytes === null) return { bytes, entries: [] };
    const entries = v.parse(candidatesSchema, canonicalDecode(bytes));
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
      throw new Error('Stored cheat candidates contain duplicate identifiers');
    return { bytes, entries };
  };
  const mutate = async (
    update: (
      entries: { id: string; bytes: Uint8Array }[],
    ) => { id: string; bytes: Uint8Array }[] | null,
  ): Promise<boolean> =>
    store.withCeremonyLock(key, async () => {
      const current = await read();
      const next = update(current.entries);
      if (next === null) return false;
      const bytes = canonicalEncode(v.parse(candidatesSchema, next));
      const saved =
        current.bytes === null
          ? await store.putIfAbsent(key, bytes)
          : await store.compareAndSwap(key, current.bytes, bytes);
      if (!saved) throw new Error('Cheat candidate storage changed outside its writer lock');
      return true;
    });
  return {
    async loadAll() {
      return (await read()).entries.map(({ id, bytes }) => ({ id, bytes: bytes.slice() }));
    },
    putIfAbsent(id, supplied) {
      const entry = v.parse(candidateSchema, { id, bytes: supplied.slice() });
      return mutate((entries) =>
        entries.some((item) => item.id === id) ? null : [...entries, entry],
      );
    },
    async delete(id) {
      await mutate((entries) =>
        entries.some((item) => item.id === id) ? entries.filter((item) => item.id !== id) : null,
      );
    },
  };
}

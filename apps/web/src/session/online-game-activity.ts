import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import type { EscrowCeremonyStore, P2PSession } from '@cp2p/protocol';
import * as v from 'valibot';
import type { OnlineGameHistoryWriter } from './online-game-history-writer.js';

const integer = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER));
const activitySchema = v.strictObject({
  protocol: v.literal('online-game-activity-v1'),
  gameId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/)),
  genesisDigest: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/)),
  head: v.strictObject({ seq: integer, hash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)) }),
  lastActivityAt: integer,
});
export type OnlineGameActivity = v.InferOutput<typeof activitySchema>;
const ABANDONMENT_MS = 30 * 24 * 60 * 60 * 1_000;
const key = (gameId: string) => `online-game/${gameId}/activity`;

function parse(bytes: Uint8Array, gameId: string, digest: string): OnlineGameActivity {
  if (bytes.length > 2_048) throw new Error('Online activity record is too large');
  const record = v.parse(activitySchema, canonicalDecode(bytes));
  const canonical = canonicalEncode(record);
  if (
    canonical.length !== bytes.length ||
    !canonical.every((byte, index) => byte === bytes[index]) ||
    record.gameId !== gameId ||
    record.genesisDigest !== digest
  )
    throw new Error('Online activity record does not match this game');
  return record;
}

/** Display metadata only. It cannot change quorum, takeover clocks, or resume authority. */
export async function loadOnlineGameActivity(
  store: EscrowCeremonyStore,
  gameId: string,
  digest: string,
): Promise<OnlineGameActivity | null> {
  const bytes = await store.load(key(gameId));
  return bytes ? parse(bytes, gameId, digest) : null;
}

export function isOnlineGameAbandoned(
  activity: OnlineGameActivity | null,
  now = Date.now(),
): boolean {
  return (
    activity !== null &&
    Number.isSafeInteger(now) &&
    now >= activity.lastActivityAt &&
    now - activity.lastActivityAt >= ABANDONMENT_MS
  );
}

/** Called under the live game's writer lease; deletion cannot race an active writer. */
export async function saveOnlineGameActivity(
  store: EscrowCeremonyStore,
  input: Omit<OnlineGameActivity, 'protocol'>,
): Promise<void> {
  const supplied = v.parse(activitySchema, { protocol: 'online-game-activity-v1', ...input });
  const id = key(supplied.gameId);
  await store.withCeremonyLock(`${id}/lock`, async () => {
    const previousBytes = await store.load(id);
    const previous = previousBytes
      ? parse(previousBytes, supplied.gameId, supplied.genesisDigest)
      : null;
    if (
      previous &&
      (supplied.head.seq < previous.head.seq ||
        (supplied.head.seq === previous.head.seq && supplied.head.hash !== previous.head.hash))
    )
      throw new Error('Online activity cannot replace a newer or conflicting head');
    const lastActivityAt = Math.max(previous?.lastActivityAt ?? 0, supplied.lastActivityAt);
    if (previous?.head.hash === supplied.head.hash && previous.lastActivityAt === lastActivityAt)
      return;
    const bytes = canonicalEncode({ ...supplied, lastActivityAt });
    const written = previousBytes
      ? await store.compareAndSwap(id, previousBytes, bytes)
      : await store.putIfAbsent(id, bytes);
    if (!written) throw new Error('Online activity changed during its write');
  });
}

/** Opening counts as local activity; duplicate status updates do not rewrite the timestamp. */
export function createOnlineGameActivityWriter(options: {
  readonly store: EscrowCeremonyStore;
  readonly gameId: string;
  readonly genesisDigest: string;
  readonly session: Pick<P2PSession, 'subscribe' | 'getCommittedHead'>;
  readonly now?: () => number;
  readonly onError?: (error: Error) => void;
}): OnlineGameHistoryWriter {
  let stopped = false;
  let lastHash: string | null = null;
  let writes = Promise.resolve();
  const unsubscribe = options.session.subscribe(() => {
    if (stopped) return;
    const head = options.session.getCommittedHead();
    if (head.hash === lastHash) return;
    lastHash = head.hash;
    const lastActivityAt = options.now?.() ?? Date.now();
    writes = writes.then(async () => {
      try {
        await saveOnlineGameActivity(options.store, {
          gameId: options.gameId,
          genesisDigest: options.genesisDigest,
          head,
          lastActivityAt,
        });
      } catch (error) {
        if (lastHash === head.hash) lastHash = null;
        try {
          options.onError?.(
            error instanceof Error ? error : new Error('Could not save game activity'),
          );
        } catch {
          // Display metadata reporting has no authority over the game.
        }
      }
      return undefined;
    });
  });
  return {
    stop() {
      stopped = true;
      unsubscribe();
    },
    async flush() {
      await writes;
    },
  };
}

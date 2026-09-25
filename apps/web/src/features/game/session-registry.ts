import { LocalSession } from '../../session';
import type { LocalSessionRuntime } from '../../session';

interface Entry {
  session: LocalSession;
  users: number;
  disposal: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, Entry>();

/** Hold one local authority across React StrictMode's mount/cleanup/mount cycle. */
export function acquireLocalSession(
  gameId: string,
  save: unknown,
  runtime: LocalSessionRuntime,
  expectedRevision: number,
): LocalSession {
  let entry = sessions.get(gameId);
  if (!entry) {
    const restored = LocalSession.restore(save, runtime);
    if (!restored.ok) throw new Error(restored.error.message);
    const validated = restored.value.exportSave();
    const revision =
      validated.genesis.length +
      validated.batches.reduce((count, batch) => count + 1 + batch.generated.length, 0);
    if (revision !== expectedRevision) {
      restored.value.dispose();
      throw new Error('Saved game revision differs from its input log');
    }
    entry = { session: restored.value, users: 0, disposal: null };
    sessions.set(gameId, entry);
  }
  if (entry.disposal !== null) {
    clearTimeout(entry.disposal);
    entry.disposal = null;
  }
  entry.users += 1;
  return entry.session;
}

export function releaseLocalSession(gameId: string): void {
  const entry = sessions.get(gameId);
  if (!entry) return;
  entry.users -= 1;
  if (entry.users > 0) return;
  entry.disposal = setTimeout(() => {
    if (entry.users !== 0) return;
    entry.session.dispose();
    sessions.delete(gameId);
  }, 0);
}

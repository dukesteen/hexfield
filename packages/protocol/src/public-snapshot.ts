import type { ProposalContext } from './proposal.js';
import { snapshotFromContext } from './replay.js';

/** Cache writes are best effort and cannot affect the certified commit verdict. */
export function cacheCommittedPublicSnapshot(
  context: ProposalContext,
  save: ((snapshot: unknown) => Promise<void>) | undefined,
): void {
  if (!save || context.log.head.seq === 0 || context.log.head.seq % 100 !== 0) return;
  try {
    void save(snapshotFromContext(context)).catch(() => undefined);
  } catch {
    // A local display cache cannot halt an already durable certified commit.
  }
}

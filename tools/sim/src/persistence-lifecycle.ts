import { hashValue, toHex } from '@cp2p/codec';
import type { Seat } from '@cp2p/engine';
import { entryHash } from '@cp2p/protocol';
import type { JournalRecord, ProtocolJournal } from '@cp2p/protocol';

export interface LifecycleRestart {
  readonly boundary: number;
  readonly kind: 'periodic' | 'everyone-left';
  readonly seats: readonly Seat[];
  readonly seq: number;
  continuedAtSeq: number | null;
  continuedBySeats: Seat[];
  closedForMilliseconds: number | null;
  reopenGapsMilliseconds: number[];
  readonly restored: {
    seat: Seat;
    headHash: string;
    safetyRevision: number;
    safetyHash: string;
    loadedBeforeVoting: boolean;
    votingMessagesAfterLoad: number;
    orderingViolations: number;
    precommits: { seq: number; valueHash: string }[];
  }[];
}

export interface LifecycleHistoryEntry {
  readonly seq: number;
  readonly kind: string;
  readonly hash: string;
}

/** Test-only schedule. Each restart must demonstrate a subsequent certified command. */
export class PersistenceLifecycle {
  readonly restarts: LifecycleRestart[] = [];
  private nextBoundary = 50;
  private rotatedPeers = 0;
  private everyoneLeft = false;

  next(seq: number, turn: number): LifecycleRestart | null {
    if (this.restarts.some((event) => event.continuedAtSeq === null)) return null;
    const everyone =
      !this.everyoneLeft &&
      this.rotatedPeers >= 3 &&
      seq >= 150 &&
      turn >= 10 &&
      seq < this.nextBoundary;
    if (seq < this.nextBoundary && !everyone) return null;
    if (seq >= this.nextBoundary + 50)
      throw new Error('Persistence profile skipped a reached restart boundary');
    const rotatingSeat = ([0, 1, 2, 3] as const)[this.rotatedPeers % 4];
    if (rotatingSeat === undefined) throw new Error('Missing rotating peer');
    const seats: readonly Seat[] = everyone ? [2, 0, 3, 1] : [rotatingSeat];
    const event: LifecycleRestart = {
      boundary: everyone ? seq : this.nextBoundary,
      kind: everyone ? 'everyone-left' : 'periodic',
      seats,
      seq,
      continuedAtSeq: null,
      continuedBySeats: [],
      closedForMilliseconds: null,
      reopenGapsMilliseconds: [],
      restored: [],
    };
    if (everyone) this.everyoneLeft = true;
    else {
      this.rotatedPeers += 1;
      this.nextBoundary += 50;
    }
    this.restarts.push(event);
    return event;
  }

  observe(entries: readonly LifecycleHistoryEntry[]): void {
    for (const event of this.restarts) {
      if (event.continuedAtSeq !== null) continue;
      const minimumRestoredVoters = event.kind === 'everyone-left' ? 3 : 1;
      const continuation = entries
        .map((entry) => {
          if (entry.seq <= event.seq || entry.kind !== 'command') return null;
          const matchingSeats = event.restored
            .filter((restored) =>
              restored.precommits.some(
                (vote) => vote.seq === entry.seq && vote.valueHash === entry.hash,
              ),
            )
            .map(({ seat }) => seat);
          if (new Set(matchingSeats).size < minimumRestoredVoters) return null;
          return { entry, matchingSeats };
        })
        .find((candidate) => candidate !== null);
      if (!continuation) continue;
      event.continuedAtSeq = continuation.entry.seq;
      event.continuedBySeats = continuation.matchingSeats;
    }
  }

  finish(finalSeq?: number): void {
    // A terminal entry exactly on the next boundary leaves no live game to restart.
    if (finalSeq !== undefined && finalSeq > this.nextBoundary)
      throw new Error('Lifecycle finished past an untested restart boundary');
    if (!this.everyoneLeft || this.rotatedPeers < 4)
      throw new Error('Lifecycle game did not exercise everyone-left and every rotating peer');
    if (
      this.restarts.some(
        (event) =>
          event.continuedAtSeq === null ||
          event.continuedBySeats.length < (event.kind === 'everyone-left' ? 3 : 1) ||
          event.restored.length !== event.seats.length ||
          event.restored.some(
            (restored) => !restored.loadedBeforeVoting || restored.orderingViolations !== 0,
          ) ||
          event.continuedBySeats.some(
            (seat) =>
              event.restored.find((restored) => restored.seat === seat)?.votingMessagesAfterLoad ===
              0,
          ),
      )
    )
      throw new Error(
        'Lifecycle restart lacks exact restoration or certified command continuation',
      );
  }
}

/** Check both session replay and the controller's actual safety-store read before voting. */
export function observeRestoredJournal(
  journal: ProtocolJournal,
  expected: JournalRecord,
  evidence: LifecycleRestart['restored'][number],
): ProtocolJournal {
  let loaded = false;
  let written = false;
  const requireLoaded = (height: number, revision: number) => {
    if (!evidence.loadedBeforeVoting) {
      evidence.orderingViolations += 1;
      throw new Error('Restore persisted before validating its retained record');
    }
    if (!written && (height !== expected.height || revision !== expected.safety.revision)) {
      evidence.orderingViolations += 1;
      throw new Error('First restored write did not descend from the retained safety revision');
    }
  };
  return {
    async load() {
      const record = await journal.load();
      if (!written) {
        if (!record || toHex(hashValue(record)) !== toHex(hashValue(expected)))
          throw new Error('Restored durable prefix or safety differs before voting');
        loaded = true;
      }
      return record;
    },
    initialize: () => {
      evidence.orderingViolations += 1;
      throw new Error('Restoration must not initialize a new safety record');
    },
    async loadSafety(height) {
      if (!loaded) throw new Error('Controller loaded safety before certified replay');
      const safety = await journal.loadSafety(height);
      if (!written) {
        if (
          height !== expected.height ||
          !safety ||
          safety.revision !== expected.safety.revision ||
          toHex(hashValue(safety.bytes)) !== evidence.safetyHash
        )
          throw new Error('Controller restored different durable safety');
        evidence.loadedBeforeVoting = true;
      }
      return safety;
    },
    async saveSafety(height, revision, bytes) {
      requireLoaded(height, revision);
      const saved = await journal.saveSafety(height, revision, bytes);
      if (saved) written = true;
      return saved;
    },
    async commit(height, revision, certified, safety) {
      requireLoaded(height, revision);
      const saved = await journal.commit(height, revision, certified, safety);
      if (saved) written = true;
      return saved;
    },
  };
}

export function restartEvidence(
  seat: Seat,
  record: JournalRecord,
): LifecycleRestart['restored'][number] {
  const head = record.entries.at(-1)?.entry ?? record.genesis;
  return {
    seat,
    headHash: entryHash(head),
    safetyRevision: record.safety.revision,
    safetyHash: toHex(hashValue(record.safety.bytes)),
    loadedBeforeVoting: false,
    votingMessagesAfterLoad: 0,
    orderingViolations: 0,
    precommits: [],
  };
}

import { canonicalDecode, canonicalEncode, sha256, toHex } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import {
  copyConsensusStateData,
  createConsensusState,
  openOwnedConsensusState,
  recoverConsensusEffects,
  restoreConsensusState,
} from './consensus.js';
import type {
  ConsensusEffect,
  ConsensusEvent,
  LocalVoteAdmissibility,
  OwnedConsensusState,
  ConsensusState,
  ConsensusTransition,
} from './consensus.js';
import type { ProposalContext } from './proposal.js';
import type { SafetyStore, StoredSafety } from './safety-store.js';
import { MAX_MESSAGE_BYTES } from './validation.js';

export type { ConsensusEvent } from './consensus.js';

export interface ConsensusControllerOptions {
  context: ProposalContext;
  seat: Seat;
  secretKey: Uint8Array;
  /** One record for this game/key/height, retained across controller crashes. */
  store: SafetyStore;
  /** Repair must reuse exact durable bytes without normalizing newly found terminal evidence. */
  requireExactRestore?: boolean;
  /** Effects are at-least-once. Handlers must deduplicate committed sequence/value. */
  onEffects: (effects: readonly ConsensusEffect[]) => void | Promise<void>;
  /** Local admission only. It must not alter replay or objective validity. */
  beforePersist?: (previous: ConsensusState, next: ConsensusState) => Result<void>;
  admitLocalValue?: LocalVoteAdmissibility;
}

/**
 * Serializes a single height's transitions and persists before emission.
 * Opening the next height requires a separately persisted certified parent.
 */
export class ConsensusController {
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private contextFault = false;
  private persistedBytes: Uint8Array;
  private readonly secretKey: Uint8Array;
  private readonly rejectedProposals = new Map<string, { code: string; message: string }>();

  private constructor(
    private readonly options: ConsensusControllerOptions,
    private state: ConsensusState,
    private revision: number,
    private readonly owned: OwnedConsensusState,
  ) {
    this.secretKey = options.secretKey.slice();
    this.persistedBytes = canonicalEncode(state);
  }

  /** Only for a genuinely new height; existing or lost stores are not reset here. */
  static async create(options: ConsensusControllerOptions): Promise<Result<ConsensusController>> {
    const validKey = checkLocalKey(options);
    if (!validKey.ok) return validKey;
    const initial = createConsensusState(options.context, options.seat);
    if (!initial.ok) return initial;
    try {
      if (await options.store.load())
        return failure(
          'consensus-store-exists',
          'Restore existing vote records instead of resetting',
        );
      const owned = openOwnedConsensusState(initial.value, options.context, options.seat);
      if (!owned.ok) return owned;
      const saved = await options.store.save(null, canonicalEncode(initial.value));
      if (!saved)
        return failure('consensus-write-conflict', 'Another writer initialized this voting record');
      return success(new ConsensusController(options, initial.value, 0, owned.value));
    } catch {
      return failure('consensus-storage', 'Could not persist the initial voting record');
    }
  }

  /** An absent or damaged record fails closed; this never creates round-one state. */
  static async restore(options: ConsensusControllerOptions): Promise<Result<ConsensusController>> {
    const validKey = checkLocalKey(options);
    if (!validKey.ok) return validKey;
    let record: StoredSafety | null;
    try {
      record = await options.store.load();
    } catch {
      return failure('consensus-storage', 'Could not read the voting record');
    }
    if (!record)
      return failure(
        'consensus-store-missing',
        'The voting record is missing; key replacement is required',
      );
    if (!Number.isSafeInteger(record.revision) || record.revision < 0)
      return failure('consensus-storage', 'Stored voting revision is invalid');
    let restored: Result<ConsensusState>;
    try {
      restored = restoreConsensusState(
        canonicalDecode(record.bytes),
        options.context,
        options.seat,
      );
    } catch {
      return failure('consensus-storage', 'Stored voting data is not valid canonical data');
    }
    if (!restored.ok) return restored;
    let revision = record.revision;
    const normalized = canonicalEncode(restored.value);
    if (!sameBytes(normalized, record.bytes)) {
      if (options.requireExactRestore || restored.value.haltKind !== 'terminal')
        return failure('consensus-restore', 'Voting record changed without a terminal proof');
      try {
        if (!(await options.store.save(revision, normalized)))
          return failure('consensus-write-conflict', 'Voting record changed during terminal halt');
      } catch {
        return failure('consensus-storage', 'Could not persist the verified terminal halt');
      }
      revision++;
    }
    const owned = openOwnedConsensusState(restored.value, options.context, options.seat);
    return owned.ok
      ? success(new ConsensusController(options, restored.value, revision, owned.value))
      : owned;
  }

  /** Returns a detached, verified snapshot, never the mutable internal record. */
  snapshot(): Result<ConsensusState> {
    const snapshot = this.owned.snapshot();
    if (!snapshot.ok) {
      this.stopVoting(snapshot.error.code);
      return snapshot;
    }
    if (!sameBytes(canonicalEncode(snapshot.value), canonicalEncode(this.state))) {
      this.stopVoting();
      return failure('consensus-restore', 'Restore to persist newly verified terminal evidence');
    }
    return snapshot;
  }

  /** The opening stamp remains usable after the mutable derived context fails its guard. */
  opensOn(context: ProposalContext): boolean {
    return this.owned.matchesOpenedContext(context);
  }

  hasContextFault(): boolean {
    return this.contextFault;
  }

  settled(): Promise<void> {
    return this.queue.then(
      () => undefined,
      () => undefined,
    );
  }

  matchesPersistedRecord(record: StoredSafety): boolean {
    return record.revision === this.revision && sameBytes(record.bytes, this.persistedBytes);
  }

  /** Expected CAS revision for atomically committing this controller's height. */
  persistedRevision(): number {
    return this.revision;
  }

  /** Call after restoring to retransmit signed records and re-arm timers. */
  resume(): Promise<Result<void>> {
    return this.enqueue(async () => {
      const snapshot = this.snapshot();
      if (!snapshot.ok) return snapshot;
      const recovered = recoverConsensusEffects(this.state, this.options.context);
      if (!recovered.ok) {
        this.stopVoting();
        return recovered;
      }
      return this.emit(recovered.value);
    });
  }

  dispatch(event: ConsensusEvent): Promise<Result<void>> {
    return this.enqueue(async () => {
      if (event.kind === 'proposal' && this.isRecordedProposalReplay(event.proposal)) {
        const checked = this.snapshot();
        return checked.ok ? success(undefined) : checked;
      }
      const proposalKey = event.kind === 'proposal' ? this.proposalKey(event.proposal) : null;
      const rejected = proposalKey ? this.rejectedProposals.get(proposalKey) : undefined;
      if (rejected) {
        const checked = this.snapshot();
        if (!checked.ok) return checked;
        return failure(rejected.code, rejected.message, {
          proposalEntryRejected: true,
          cached: true,
        });
      }
      const next = this.reduce(event);
      if (!next.ok) {
        if (next.error.code === 'consensus-restore' || next.error.code === 'consensus-context')
          this.stopVoting(next.error.code);
        else if (
          proposalKey &&
          next.error.details?.proposalEntryRejected === true &&
          next.error.details.proposalControl !== true
        ) {
          // Entry validation depends on this controller's fixed certified parent,
          // not its current round/votes. Controls can discover a second offender
          // after another proof is retained, so always reconsider them.
          this.rejectedProposals.set(proposalKey, {
            code: next.error.code,
            message: next.error.message,
          });
          if (this.rejectedProposals.size > 16) {
            const oldest = this.rejectedProposals.keys().next().value;
            if (oldest !== undefined) this.rejectedProposals.delete(oldest);
          }
        }
        return next;
      }
      const candidate = next.value.state;
      const admitted = this.options.beforePersist?.(
        copyConsensusStateData(this.state),
        copyConsensusStateData(candidate),
      );
      if (admitted && !admitted.ok) {
        this.owned.discard();
        return admitted;
      }
      let persistedBytes: Uint8Array;
      try {
        const bytes = canonicalEncode(candidate);
        persistedBytes = bytes.slice();
        if (!(await this.options.store.save(this.revision, bytes))) {
          this.owned.discard();
          this.stopped = true;
          return failure(
            'consensus-write-conflict',
            'Voting stopped because a newer record exists',
          );
        }
      } catch {
        this.owned.discard();
        this.stopped = true;
        return failure(
          'consensus-storage',
          'Voting stopped because its state could not be persisted',
        );
      }
      this.persistedBytes = persistedBytes;
      this.revision += 1;
      const committed = this.owned.commit();
      if (!committed.ok) {
        this.owned.discard();
        this.stopVoting(committed.error.code);
        return committed;
      }
      this.state = copyConsensusStateData(candidate);
      // A dispose/crash during the write must not transmit after the write resolves.
      if (this.stopped)
        return failure('consensus-stopped', 'Controller stopped during persistence');
      return this.emit(next.value.effects);
    });
  }

  dispose(): void {
    this.stopVoting();
  }

  private stopVoting(code?: string): void {
    if (code === 'consensus-context') this.contextFault = true;
    this.stopped = true;
    this.secretKey.fill(0);
    this.rejectedProposals.clear();
  }

  private proposalKey(value: unknown): string | null {
    try {
      const bytes = canonicalEncode(value);
      return bytes.length <= MAX_MESSAGE_BYTES ? toHex(sha256(bytes)) : null;
    } catch {
      return null;
    }
  }

  /** Stored proposals were validated before persistence; exact replays need no transition. */
  private isRecordedProposalReplay(value: unknown): boolean {
    let bytes: Uint8Array;
    try {
      bytes = canonicalEncode(value);
    } catch {
      return false;
    }
    if (bytes.byteLength > MAX_MESSAGE_BYTES) return false;
    const recorded = [
      ...this.state.proposals,
      ...this.state.hints.flatMap((hint) => (hint.kind === 'proposal' ? [hint.proposal] : [])),
    ].find((proposal) => sameBytes(bytes, canonicalEncode(proposal)));
    if (!recorded) return false;
    // A proposal retained before entering its round may still need its first vote.
    return !(
      recorded.body.entry.term === this.state.round &&
      this.state.step === 'propose' &&
      !this.state.votes.some(
        (vote) =>
          vote.body.seat === this.state.localSeat &&
          vote.body.term === this.state.round &&
          vote.body.phase === 'prevote',
      )
    );
  }

  private enqueue(operation: () => Promise<Result<void>>): Promise<Result<void>> {
    const result = this.queue.then(async (): Promise<Result<void>> => {
      if (this.stopped)
        return failure('consensus-stopped', 'Restore the persisted record before continuing');
      try {
        return await operation();
      } catch {
        this.owned.discard();
        this.stopVoting();
        return failure('consensus-controller', 'Consensus transition failed; voting has stopped');
      }
    });
    this.queue = result;
    return result;
  }

  private reduce(event: ConsensusEvent): Result<ConsensusTransition> {
    return this.owned.dispatch(event, this.secretKey, this.options.admitLocalValue);
  }

  private async emit(effects: readonly ConsensusEffect[]): Promise<Result<void>> {
    if (effects.length === 0) return success(undefined);
    try {
      await this.options.onEffects(effects);
      return success(undefined);
    } catch {
      // The saved state can reproduce signed messages after a partial delivery.
      this.stopped = true;
      return failure('consensus-effects', 'Effect delivery failed; restore before retrying');
    }
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function checkLocalKey(options: ConsensusControllerOptions): Result<void> {
  try {
    const identity = identityFromSecret(options.secretKey);
    const voter = options.context.membership.voters.find((member) => member.seat === options.seat);
    return voter?.publicKey === identity.peerId
      ? success(undefined)
      : failure('consensus-key', 'The local key does not match the certified voter');
  } catch {
    return failure('consensus-key', 'The local voting key is invalid');
  }
}

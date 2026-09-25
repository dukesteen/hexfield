import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import {
  createConsensusState,
  inputAvailable,
  propose,
  receiveCommit,
  receiveProposal,
  receiveVote,
  recoverConsensusEffects,
  resumeAfterReplay,
  restoreConsensusState,
  timeout,
} from './consensus.js';
import type {
  ConsensusEffect,
  ConsensusState,
  ConsensusTransition,
  TimeoutPhase,
} from './consensus.js';
import type { ProposalContext } from './proposal.js';
import type { SafetyStore, StoredSafety } from './safety-store.js';
import type { LogEntry } from './types.js';

export interface ConsensusControllerOptions {
  context: ProposalContext;
  seat: Seat;
  secretKey: Uint8Array;
  /** One record for this game/key/height, retained across controller crashes. */
  store: SafetyStore;
  /** Effects are at-least-once. Handlers must deduplicate committed sequence/value. */
  onEffects: (effects: readonly ConsensusEffect[]) => void | Promise<void>;
}

export type ConsensusEvent =
  | { kind: 'input-available' }
  | { kind: 'propose'; candidate?: LogEntry }
  | { kind: 'proposal'; proposal: unknown }
  | { kind: 'vote'; vote: unknown }
  | { kind: 'commit'; certified: unknown }
  | { kind: 'resume-after-replay' }
  | { kind: 'timeout'; phase: TimeoutPhase; round: number };

/**
 * Serializes a single height's transitions and persists before emission.
 * Opening the next height requires a separately persisted certified parent.
 */
export class ConsensusController {
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly secretKey: Uint8Array;

  private constructor(
    private readonly options: ConsensusControllerOptions,
    private state: ConsensusState,
    private revision: number,
  ) {
    this.secretKey = options.secretKey.slice();
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
      const saved = await options.store.save(null, canonicalEncode(initial.value));
      if (!saved)
        return failure('consensus-write-conflict', 'Another writer initialized this voting record');
      return success(new ConsensusController(options, initial.value, 0));
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
    try {
      const restored = restoreConsensusState(
        canonicalDecode(record.bytes),
        options.context,
        options.seat,
      );
      return restored.ok
        ? success(new ConsensusController(options, restored.value, record.revision))
        : restored;
    } catch {
      return failure('consensus-storage', 'Stored voting data is not valid canonical data');
    }
  }

  /** Returns a detached, verified snapshot, never the mutable internal record. */
  snapshot(): Result<ConsensusState> {
    return restoreConsensusState(this.state, this.options.context, this.options.seat);
  }

  /** Expected CAS revision for atomically committing this controller's height. */
  persistedRevision(): number {
    return this.revision;
  }

  /** Call after restoring to retransmit signed records and re-arm timers. */
  resume(): Promise<Result<void>> {
    return this.enqueue(async () => {
      const recovered = recoverConsensusEffects(this.state, this.options.context);
      if (!recovered.ok) return recovered;
      return this.emit(recovered.value);
    });
  }

  dispatch(event: ConsensusEvent): Promise<Result<void>> {
    return this.enqueue(async () => {
      const next = this.reduce(event);
      if (!next.ok) return next;
      try {
        if (!(await this.options.store.save(this.revision, canonicalEncode(next.value.state)))) {
          this.stopped = true;
          return failure(
            'consensus-write-conflict',
            'Voting stopped because a newer record exists',
          );
        }
      } catch {
        this.stopped = true;
        return failure(
          'consensus-storage',
          'Voting stopped because its state could not be persisted',
        );
      }
      this.revision += 1;
      this.state = next.value.state;
      // A dispose/crash during the write must not transmit after the write resolves.
      if (this.stopped)
        return failure('consensus-stopped', 'Controller stopped during persistence');
      return this.emit(next.value.effects);
    });
  }

  dispose(): void {
    this.stopped = true;
    this.secretKey.fill(0);
  }

  private enqueue(operation: () => Promise<Result<void>>): Promise<Result<void>> {
    const result = this.queue.then(async (): Promise<Result<void>> => {
      if (this.stopped)
        return failure('consensus-stopped', 'Restore the persisted record before continuing');
      try {
        return await operation();
      } catch {
        this.stopped = true;
        return failure('consensus-controller', 'Consensus transition failed; voting has stopped');
      }
    });
    this.queue = result;
    return result;
  }

  private reduce(event: ConsensusEvent): Result<ConsensusTransition> {
    const context = this.options.context;
    switch (event.kind) {
      case 'input-available':
        return inputAvailable(this.state, context);
      case 'propose':
        return propose(this.state, context, this.secretKey, event.candidate);
      case 'proposal':
        return receiveProposal(this.state, context, this.secretKey, event.proposal);
      case 'vote':
        return receiveVote(this.state, context, this.secretKey, event.vote);
      case 'commit':
        return receiveCommit(this.state, context, event.certified);
      case 'resume-after-replay':
        return resumeAfterReplay(this.state, context);
      case 'timeout':
        return timeout(this.state, context, this.secretKey, event.phase, event.round);
      default: {
        const unknownEvent: never = event;
        return failure('consensus-event', `Unknown consensus event: ${String(unknownEvent)}`);
      }
    }
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

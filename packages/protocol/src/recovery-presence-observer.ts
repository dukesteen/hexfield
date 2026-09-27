import type { Seat } from '@cp2p/engine';
import type { PeerId } from './transport.js';
import { quorumSize } from './votes.js';

export interface RecoveryPresenceState {
  readonly targetSeat: Seat;
  readonly targetOnline: boolean;
  readonly quorumReachable: boolean;
  readonly quorumQualifiedAbsentMs: number;
}

interface Observation {
  readonly generation: string;
  readonly now: number;
  readonly targetOnline: boolean;
  readonly quorumReachable: boolean;
}

/** Local monotonic observation only; certified replay never reads this clock. */
export class RecoveryPresenceObserver {
  private previous: Observation | null = null;
  private qualifiedMs = 0;

  observe(sample: {
    targetSeat: Seat;
    voters: readonly { seat: Seat; publicKey: PeerId }[];
    connectedPeers: readonly PeerId[];
    self: PeerId;
    now: number;
  }): RecoveryPresenceState {
    const voters = [...sample.voters].toSorted((a, b) => a.seat - b.seat);
    const target = voters.find((voter) => voter.seat === sample.targetSeat);
    if (!target || !Number.isFinite(sample.now)) throw new RangeError('Invalid presence sample');
    const generation = voters.map(({ seat, publicKey }) => `${seat}:${publicKey}`).join('|');
    const reachable = new Set([...sample.connectedPeers, sample.self]);
    const targetOnline = reachable.has(target.publicKey);
    const quorumReachable =
      voters.filter((voter) => reachable.has(voter.publicKey)).length >= quorumSize(voters.length);
    const previous = this.previous;
    if (
      !previous ||
      previous.generation !== generation ||
      sample.now < previous.now ||
      targetOnline
    )
      this.qualifiedMs = 0;
    else if (!previous.targetOnline && previous.quorumReachable)
      this.qualifiedMs += sample.now - previous.now;
    this.previous = { generation, now: sample.now, targetOnline, quorumReachable };
    return {
      targetSeat: sample.targetSeat,
      targetOnline,
      quorumReachable,
      quorumQualifiedAbsentMs: this.qualifiedMs,
    };
  }
}

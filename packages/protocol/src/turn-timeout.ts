import { RESOURCES, failure, success } from '@cp2p/engine';
import type {
  CommandShape,
  Engine,
  GameState,
  PrivateState,
  Result,
  Seat,
  SystemInput,
} from '@cp2p/engine';
import * as v from 'valibot';
import { entryHash } from './genesis.js';
import { nonnegativeIntegerSchema, seatSchema } from './schema-values.js';
import { timerKey } from './session-timing.js';
import type { SessionTimer } from './session-timer-types.js';
import type { LogEntry, SystemEvidence } from './types.js';
import type { ProtocolClock } from './transport.js';
import { parseCanonical } from './validation.js';

export const TURN_TIMEOUT_PROTOCOL = 'turn-timeout-v1';
const timeoutDataSchema = v.strictObject({
  pendingSince: nonnegativeIntegerSchema,
  deadlineMs: v.pipe(nonnegativeIntegerSchema, v.minValue(1)),
});
const timeoutInputSchema = v.strictObject({
  kind: v.literal('system'),
  type: v.literal('TIMEOUT'),
  seat: seatSchema,
  phase: v.string(),
});

export interface TimerAnchor {
  readonly key: string;
  readonly seat: Seat;
  readonly phase: string;
  readonly deadlineMs: number;
  readonly pendingSince: { readonly seq: number; readonly hash: string };
}

/** Deterministic metadata derived only from the certified state sequence. */
export function advanceTimerAnchors(
  engine: Engine,
  state: GameState,
  entry: LogEntry,
  previous: readonly TimerAnchor[] = [],
): Result<readonly TimerAnchor[]> {
  try {
    const retained = new Map(previous.map((item) => [item.key, item]));
    const next: TimerAnchor[] = [];
    for (const pending of engine.getPending(state)) {
      if (pending.kind !== 'player' || !pending.deadline) continue;
      const key = timerKey(state, pending);
      if (key === null) continue;
      const deadlineMs = pending.deadline.seconds * 1_000;
      if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0)
        return failure('turn-timeout-duration', 'Pending timer duration is not safe');
      const prior = retained.get(key);
      next.push(
        prior &&
          prior.seat === pending.seat &&
          prior.phase === pending.deadline.phase &&
          prior.deadlineMs === deadlineMs
          ? prior
          : {
              key,
              seat: pending.seat,
              phase: pending.deadline.phase,
              deadlineMs,
              pendingSince: { seq: entry.seq, hash: entryHash(entry) },
            },
      );
    }
    if (new Set(next.map((item) => item.key)).size !== next.length)
      return failure('turn-timeout-anchor', 'Two active timers have the same identity');
    return success(next.toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)));
  } catch {
    return failure('turn-timeout-anchor', 'Could not derive pending timer anchors');
  }
}

export function verifyTimeoutEvidence(
  input: SystemInput,
  evidence: SystemEvidence,
  anchors: readonly TimerAnchor[] | undefined,
): Result<TimerAnchor> {
  const parsed = parseCanonical(input, timeoutInputSchema);
  if (!parsed.ok) return failure('turn-timeout-input', 'Timeout input has an invalid shape');
  if (evidence.kind !== 'proof' || evidence.protocol !== TURN_TIMEOUT_PROTOCOL)
    return failure('turn-timeout-evidence', 'Verified timeout needs its own proof protocol');
  const data = parseCanonical(evidence.data, timeoutDataSchema);
  if (!data.ok) return failure('turn-timeout-evidence', 'Timeout evidence is malformed');
  const anchor = anchors?.find(
    (item) =>
      item.seat === parsed.value.seat &&
      item.phase === parsed.value.phase &&
      item.pendingSince.seq === data.value.pendingSince &&
      item.deadlineMs === data.value.deadlineMs,
  );
  return anchor
    ? success(anchor)
    : failure('turn-timeout-anchor', 'Timeout differs from the certified pending interval');
}

/** Choose a legal owner's cards without exposing their hand in public timeout evidence. */
export function timedDiscardCommand(
  state: GameState,
  privateState: PrivateState,
): Result<CommandShape> {
  const publicSeat = state.seats.find((seat) => seat.seat === privateState.seat);
  if (!publicSeat) return failure('automatic-discard-seat', 'Timed-out seat is unavailable');
  const cards = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
  let remaining = Math.floor(publicSeat.resources.total / 2);
  const ordered = [...RESOURCES].toSorted(
    (a, b) =>
      (privateState.hand[b] ?? 0) - (privateState.hand[a] ?? 0) ||
      RESOURCES.indexOf(a) - RESOURCES.indexOf(b),
  );
  for (const resource of ordered) {
    const amount = Math.min(privateState.hand[resource] ?? 0, remaining);
    cards[resource] = amount;
    remaining -= amount;
  }
  return remaining === 0
    ? success({ type: 'DISCARD', cards })
    : failure('automatic-discard-hand', 'Private hand cannot satisfy the timed discard');
}

/** Local monotonic observation; a restored process begins a full fresh interval. */
export class LocalTimerObserver {
  readonly #seen = new Map<string, { anchor: TimerAnchor; observedAt: number }>();

  constructor(
    private readonly clock: ProtocolClock,
    anchors: readonly TimerAnchor[],
  ) {
    this.advance(anchors);
  }

  advance(anchors: readonly TimerAnchor[]): void {
    const now = this.clock.now();
    const active = new Set<string>();
    for (const anchor of anchors) {
      active.add(anchor.key);
      const prior = this.#seen.get(anchor.key);
      if (
        !prior ||
        prior.anchor.pendingSince.seq !== anchor.pendingSince.seq ||
        prior.anchor.pendingSince.hash !== anchor.pendingSince.hash ||
        prior.anchor.deadlineMs !== anchor.deadlineMs
      )
        this.#seen.set(anchor.key, { anchor, observedAt: now });
    }
    for (const key of this.#seen.keys()) if (!active.has(key)) this.#seen.delete(key);
  }

  timers(): readonly SessionTimer[] {
    const now = this.clock.now();
    return [...this.#seen.values()].map(({ anchor, observedAt }) => ({
      key: anchor.key,
      seat: anchor.seat,
      phase: anchor.phase,
      remainingMs: Math.max(0, observedAt + anchor.deadlineMs - now),
      expiresAt: observedAt + anchor.deadlineMs,
      paused: false,
    }));
  }

  elapsed(anchor: TimerAnchor): number | null {
    const local = this.#seen.get(anchor.key);
    if (
      !local ||
      local.anchor.pendingSince.seq !== anchor.pendingSince.seq ||
      local.anchor.pendingSince.hash !== anchor.pendingSince.hash
    )
      return null;
    const elapsed = this.clock.now() - local.observedAt;
    return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
  }

  canVote(anchor: TimerAnchor): Result<void> {
    const remaining = this.untilVote(anchor);
    return remaining === 0
      ? success(undefined)
      : failure('turn-timeout-early', 'Local pending timer has not reached its tolerance window');
  }

  untilVote(anchor: TimerAnchor): number | null {
    const elapsed = this.elapsed(anchor);
    // For one-second timers, the tolerance cannot authorize an immediate timeout.
    const minimum = Math.max(1_000, anchor.deadlineMs - 3_000);
    return elapsed === null ? null : Math.max(0, minimum - elapsed);
  }
}

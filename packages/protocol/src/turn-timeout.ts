import {
  COMMODITIES,
  HAND_LIMIT,
  failure,
  kindsOfCounts,
  success,
  trackOfDeck,
  zeroCounts,
} from '@cp2p/engine';
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

/** Private choices whose timeout only the owner's client can make: it alone knows the hand. */
export const PRIVATE_TIMEOUT_TYPES: readonly string[] = [
  'DISCARD',
  'DISCARD_PROGRESS',
  'SABOTEUR_DISCARD',
  'WEDDING_GIVE',
  'HARBOR_REPLY',
];

/** The `count` cards a hand gives when it gives its most plentiful kinds first. */
function greedyCards(
  state: GameState,
  privateState: PrivateState,
  count: number,
): Record<string, number> | null {
  const kinds = kindsOfCounts(state.bank);
  const cards = { ...zeroCounts(kinds) };
  let remaining = count;
  const ordered = [...kinds].toSorted(
    (a, b) =>
      (privateState.hand[b] ?? 0) - (privateState.hand[a] ?? 0) ||
      kinds.indexOf(a) - kinds.indexOf(b),
  );
  for (const resource of ordered) {
    const amount = Math.min(privateState.hand[resource] ?? 0, remaining);
    cards[resource] = amount;
    remaining -= amount;
  }
  return remaining === 0 ? cards : null;
}

/** Choose a legal owner's cards without exposing their hand in public timeout evidence. */
export function timedDiscardCommand(
  state: GameState,
  privateState: PrivateState,
): Result<CommandShape> {
  const publicSeat = state.seats.find((seat) => seat.seat === privateState.seat);
  if (!publicSeat) return failure('automatic-discard-seat', 'Timed-out seat is unavailable');
  const cards = greedyCards(state, privateState, Math.floor(publicSeat.resources.total / 2));
  return cards
    ? success({ type: 'DISCARD', cards })
    : failure('automatic-discard-hand', 'Private hand cannot satisfy the timed discard');
}

/**
 * The command an owner's client sends when its timer for a private choice runs out. Each is a
 * legal default that needs the private hand: the discard of half, a Saboteur's half, a Wedding's
 * two cards, the first commodity for a Commercial Harbor (or none), the surplus progress cards.
 */
export function timedPrivateCommand(
  state: GameState,
  privateState: PrivateState,
  allowed: readonly string[],
): Result<CommandShape | null> {
  const seat = state.seats.find((item) => item.seat === privateState.seat);
  if (!seat) return failure('automatic-private-seat', 'Timed-out seat is unavailable');
  if (allowed.includes('DISCARD')) return timedDiscardCommand(state, privateState);
  if (allowed.includes('SABOTEUR_DISCARD') || allowed.includes('WEDDING_GIVE')) {
    const type = allowed.includes('SABOTEUR_DISCARD') ? 'SABOTEUR_DISCARD' : 'WEDDING_GIVE';
    const count =
      type === 'SABOTEUR_DISCARD'
        ? Math.floor(seat.resources.total / 2)
        : Math.min(2, seat.resources.total);
    const cards = greedyCards(state, privateState, count);
    return cards
      ? success({ type, cards })
      : failure('automatic-private-hand', 'Private hand cannot satisfy the timed choice');
  }
  if (allowed.includes('HARBOR_REPLY')) {
    const commodity = COMMODITIES.find((kind) => (privateState.hand[kind] ?? 0) > 0);
    return success({ type: 'HARBOR_REPLY', commodity: commodity ?? 'none' });
  }
  if (allowed.includes('DISCARD_PROGRESS')) {
    const held = seat.cardSlots.filter(
      (slot) => slot.revealed === undefined && trackOfDeck(slot.deck) !== null,
    );
    const surplus = held.length - HAND_LIMIT;
    if (surplus < 1) return success(null);
    const cards = held.slice(held.length - surplus).map((slot) => ({
      slotId: slot.slotId,
      card: slot.known ?? privateState.slots[slot.slotId],
    }));
    return cards.every((item) => typeof item.card === 'string')
      ? success({ type: 'DISCARD_PROGRESS', cards })
      : failure('automatic-private-slots', 'A held progress card has no known identity');
  }
  return success(null);
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

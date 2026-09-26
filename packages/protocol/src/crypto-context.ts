import { hashValue, toHex } from '@cp2p/codec';
import { RESOURCES, failure, success } from '@cp2p/engine';
import type { Engine, GameState, Input, Result } from '@cp2p/engine';
import {
  completeBeaconState,
  extendBeaconState,
  freezeBeaconRequest,
  initializeBeaconState,
  validateBeaconState,
} from './beacon-state.js';
import type { BeaconDerivations, BeaconState, EntryRef } from './beacon-state.js';
import { entryHash, genesisDigest } from './genesis.js';
import { randomDerivations } from './random-derivations.js';
import type { Genesis, LogEntry } from './types.js';
import {
  applyDeckSetupEntry,
  captureDeckPending,
  completeDeckDeal,
  decksReady,
  initializeDeckLedger,
  validateDeckLedger,
} from './deck-ledger.js';
import type { DeckLedger } from './deck-ledger.js';
import { emptyHandCommitments, validateHandCommitments } from './hand-commitments.js';
import type { PublicHandCommitments } from './hand-commitments.js';
import { captureCountPending, validateCountState } from './count-state.js';
import type { CountState } from './count-reveal.js';

/** Public cryptographic metadata, derived only by replaying the certified log. */
export interface CryptoContext {
  epoch: number;
  beacon: BeaconState;
  decks: DeckLedger;
  hands: PublicHandCommitments;
  counts: CountState | null;
}

export const BEACON_EVIDENCE_PROTOCOL = 'beacon-v1';

function equalValue(left: unknown, right: unknown): boolean {
  return toHex(hashValue(left)) === toHex(hashValue(right));
}

/** Freeze newly created requests after their containing entry has a value hash. */
export function captureCryptoPending(
  context: CryptoContext,
  genesis: Genesis,
  engine: Engine,
  state: GameState,
  anchor: EntryRef,
  registry: BeaconDerivations = randomDerivations,
): Result<CryptoContext> {
  const random = engine.getPending(state).filter((pending) => pending.kind === 'random');
  if (random.length > 1)
    return failure(
      'ambiguous-random-request',
      'Multiple simultaneous random requests are unsupported',
    );
  const pending = random[0];
  const decks = captureDeckPending(context.decks, state, pending ?? null, anchor, context.epoch);
  if (!decks.ok) return decks;
  const counts = captureCountPending(
    context.counts,
    genesis,
    engine,
    state,
    context.hands,
    context.epoch,
    anchor,
  );
  if (!counts.ok) return counts;
  const next = { ...context, decks: decks.value, counts: counts.value };
  const frozen = context.beacon.active?.pending ?? context.beacon.fixed?.operation.pending;
  if (frozen) {
    if (!pending || !equalValue(pending, frozen))
      return failure('beacon-request-changed', 'An unfinished beacon request cannot change');
    return success(next);
  }
  if (!pending || pending.request.type === 'draw') return success(next);
  const captured = freezeBeaconRequest(
    context.beacon,
    pending,
    state,
    anchor,
    context.epoch,
    registry,
  );
  return captured.ok ? success({ ...next, beacon: captured.value }) : captured;
}

export function initializeCryptoContext(
  genesis: Genesis,
  engine: Engine,
  state: GameState,
  head: LogEntry,
  registry: BeaconDerivations = randomDerivations,
): Result<CryptoContext | null> {
  if (genesis.security === 'stub') return success(null);
  const beacon = initializeBeaconState(genesis);
  if (!beacon.ok) return beacon;
  const decks = initializeDeckLedger(genesis, state);
  if (!decks.ok) return decks;
  if (
    state.seats.some(
      ({ resources }) =>
        resources.total !== 0 ||
        RESOURCES.some(
          (resource) => resources.min[resource] !== 0 || resources.max[resource] !== 0,
        ),
    )
  )
    return failure('crypto-genesis-hands', 'Verified genesis must start with empty resource hands');
  const hands = emptyHandCommitments(genesis.config.seats);
  if (!hands.ok) return hands;
  return captureCryptoPending(
    { epoch: 0, beacon: beacon.value, decks: decks.value, hands: hands.value, counts: null },
    genesis,
    engine,
    state,
    { seq: head.seq, hash: entryHash(head) },
    registry,
  );
}

export interface CryptoTransition {
  crypto: CryptoContext | null;
  /** Handled inputs have built-in verification; other inputs still need their own policy. */
  handled: boolean;
  input: Input | null;
}

/** A prospective transition, never installed merely because a proposal was received. */
export function validateCryptoTransition(
  genesis: Genesis,
  current: CryptoContext | null,
  engine: Engine,
  state: GameState,
  entry: LogEntry,
  registry: BeaconDerivations = randomDerivations,
): Result<CryptoTransition> {
  const payload = entry.payload;
  if (genesis.security === 'stub') {
    if (current !== null || payload.kind === 'crypto')
      return failure(
        'crypto-forbidden',
        'Stub sessions cannot carry verified crypto state or entries',
      );
    return success({ crypto: null, handled: false, input: null });
  }
  if (!current || !Number.isSafeInteger(current.epoch) || current.epoch < 0)
    return failure(
      'crypto-context-required',
      'Verified sessions require replayed cryptographic state',
    );
  const beacon = validateBeaconState(current.beacon);
  if (!beacon.ok) return beacon;
  const decks = validateDeckLedger(current.decks);
  if (!decks.ok) return decks;
  const hands = validateHandCommitments(current.hands, genesis.config.seats);
  if (!hands.ok) return hands;
  const counts = validateCountState(
    current.counts,
    genesis,
    engine,
    state,
    hands.value,
    current.epoch,
  );
  if (!counts.ok) return counts;
  if (counts.value && counts.value.operation.anchor.seq >= entry.seq)
    return failure('count-anchor', 'Count operation must already exist in the certified prefix');
  if (
    beacon.value.genesisDigest !== genesisDigest(genesis) ||
    decks.value.genesisDigest !== genesisDigest(genesis)
  )
    return failure('crypto-genesis', 'Cryptographic state belongs to another genesis');
  const crypto: CryptoContext = {
    epoch: current.epoch,
    beacon: beacon.value,
    decks: decks.value,
    hands: hands.value,
    counts: counts.value,
  };
  if (payload.kind === 'control') return success({ crypto, handled: false, input: null });
  if (payload.kind === 'crypto' && payload.action === 'deck-pass') {
    const applied = applyDeckSetupEntry(crypto.decks, payload.evidence);
    return applied.ok
      ? success({ crypto: { ...crypto, decks: applied.value }, handled: true, input: null })
      : applied;
  }
  if (!decksReady(crypto.decks))
    return failure('deck-setup-pending', 'Every committed deck pass must be replayed before play');
  if (payload.kind === 'system' && payload.input.type === 'CARD_DEALT') {
    if (crypto.beacon.active || crypto.beacon.fixed)
      return failure('beacon-pending', 'A deck deal cannot answer a beacon request');
    const pending = engine.getPending(state).filter((item) => item.kind === 'random');
    if (pending.length !== 1)
      return failure('deck-pending', 'A deal requires exactly one certified random pending');
    const completed = completeDeckDeal(
      crypto.decks,
      state,
      pending[0] ?? null,
      payload.input,
      payload.evidence,
      { seq: entry.seq, hash: entryHash(entry) },
    );
    return completed.ok
      ? success({
          crypto: { ...crypto, decks: completed.value },
          handled: true,
          input: payload.input,
        })
      : completed;
  }
  if (crypto.decks.active)
    return failure('deck-pending', 'The certified draw must complete before another input');
  if (payload.kind === 'crypto' && payload.action === 'beacon-extend') {
    const extended = extendBeaconState(crypto.beacon, payload.evidence);
    return extended.ok
      ? success({ crypto: { ...crypto, beacon: extended.value }, handled: true, input: null })
      : extended;
  }
  const beaconInput =
    payload.kind === 'system' &&
    (payload.input.type === 'START_SEAT' ||
      payload.input.type === 'DICE_RESULT' ||
      (crypto.beacon.active !== null &&
        payload.input.type === crypto.beacon.active.pending.systemType));
  if (beaconInput || payload.kind === 'crypto') {
    const evidence =
      payload.kind === 'crypto'
        ? payload.evidence
        : payload.kind === 'system' &&
            payload.evidence.kind === 'proof' &&
            payload.evidence.protocol === BEACON_EVIDENCE_PROTOCOL
          ? payload.evidence.data
          : null;
    if (evidence === null)
      return failure('beacon-evidence-required', 'Random results require signed beacon evidence');
    const completed = completeBeaconState(
      crypto.beacon,
      evidence,
      state,
      { seq: entry.seq, hash: entryHash(entry) },
      registry,
    );
    if (!completed.ok) return completed;
    const outcome = completed.value.outcome;
    if (payload.kind === 'crypto') {
      if (outcome.kind !== 'steal-index')
        return failure('beacon-fixed-kind', 'Only a hidden steal index needs a fixed beacon entry');
      return success({
        crypto: { ...crypto, beacon: completed.value.state },
        handled: true,
        input: null,
      });
    }
    if (
      payload.kind !== 'system' ||
      outcome.kind !== 'system' ||
      !equalValue(payload.input, outcome.input)
    )
      return failure('beacon-result', 'System input does not match the fixed beacon outcome');
    return success({
      crypto: { ...crypto, beacon: completed.value.state },
      handled: true,
      input: outcome.input,
    });
  }
  if (crypto.beacon.active || crypto.beacon.fixed)
    return failure('beacon-pending', 'The fixed random request must complete before another input');
  return success({ crypto, handled: false, input: null });
}

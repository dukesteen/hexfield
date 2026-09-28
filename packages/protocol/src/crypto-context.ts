import { hashValue, toHex } from '@cp2p/codec';
import { failure, isPublicDraw, kindBounds, kindsOfCounts, success } from '@cp2p/engine';
import type { Engine, GameState, Input, Result } from '@cp2p/engine';
import {
  completeBeaconState,
  extendBeaconState,
  freezeBeaconRequest,
  initializeBeaconState,
  getBeaconOperation,
  getBeaconExtensionOperation,
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
import {
  disputeStealContribution,
  fixStealContribution,
  freezeStealState,
  validateStealState,
} from './steal-state.js';
import type { StealState } from './steal-state.js';
import type { CheatFinding } from './cheat-types.js';
import { permitsFrozenOperation, resolveArtifactSigner } from './authority.js';
import type { SeatAuthorities } from './authority-types.js';
import { deckDrawOperationId, deckUnlockers } from './deck-draw.js';
import { beaconOperationId } from './beacon.js';
import { beaconExtensionOperationId } from './beacon-extension.js';

/** Public cryptographic metadata, derived only by replaying the certified log. */
export interface CryptoContext {
  epoch: number;
  beacon: BeaconState;
  decks: DeckLedger;
  hands: PublicHandCommitments;
  counts: CountState | null;
  steal: StealState | null;
  /** First certified finding per seat and evidence kind, derived from log replay. */
  cheats: readonly CheatFinding[];
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
  authority?: SeatAuthorities,
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
    authority,
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
  authority?: SeatAuthorities,
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
        kindsOfCounts(state.bank).some(
          (resource) =>
            kindBounds(resources).min[resource] !== 0 || kindBounds(resources).max[resource] !== 0,
        ),
    )
  )
    return failure('crypto-genesis-hands', 'Verified genesis must start with empty resource hands');
  const hands = emptyHandCommitments(genesis.config.seats, kindsOfCounts(state.bank));
  if (!hands.ok) return hands;
  return captureCryptoPending(
    {
      epoch: 0,
      beacon: beacon.value,
      decks: decks.value,
      hands: hands.value,
      counts: null,
      steal: null,
      cheats: [],
    },
    genesis,
    engine,
    state,
    { seq: head.seq, hash: entryHash(head) },
    registry,
    authority,
  );
}

export interface CryptoTransition {
  crypto: CryptoContext | null;
  /** Input routing only; validateNextEntry applies mandatory proof and hand checks. */
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
  authority?: SeatAuthorities,
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
  const hands = validateHandCommitments(
    current.hands,
    genesis.config.seats,
    kindsOfCounts(state.bank),
  );
  if (!hands.ok) return hands;
  const counts = validateCountState(
    current.counts,
    genesis,
    engine,
    state,
    hands.value,
    current.epoch,
    authority,
  );
  if (!counts.ok) return counts;
  const steal = validateStealState(
    current.steal,
    genesis,
    beacon.value,
    hands.value,
    state,
    current.epoch,
    authority,
  );
  if (!steal.ok) return steal;
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
    steal: steal.value,
    cheats: current.cheats,
  };
  if (
    crypto.decks.active &&
    !permitsFrozenOperation(
      authority,
      'deck',
      deckDrawOperationId(crypto.decks.active),
      crypto.decks.active,
      crypto.epoch,
    )
  )
    return failure('deck-authority', 'Frozen draw is not carried by certified membership');
  if (crypto.beacon.active) {
    const exhausted = crypto.beacon.active.participants.some((item) => item.index === item.length);
    const operation = exhausted
      ? getBeaconExtensionOperation(crypto.beacon)
      : getBeaconOperation(crypto.beacon);
    if (!operation.ok) return operation;
    const id = exhausted
      ? beaconExtensionOperationId(operation.value)
      : beaconOperationId(operation.value);
    if (!permitsFrozenOperation(authority, 'beacon', id, operation.value, crypto.epoch))
      return failure('beacon-authority', 'Frozen beacon is not carried by certified membership');
  }
  if (payload.kind === 'control' || payload.kind === 'cheat-proof')
    return success({ crypto, handled: false, input: null });
  if (payload.kind === 'crypto' && payload.action === 'deck-pass') {
    const applied = applyDeckSetupEntry(crypto.decks, payload.evidence);
    return applied.ok
      ? success({ crypto: { ...crypto, decks: applied.value }, handled: true, input: null })
      : applied;
  }
  if (!decksReady(crypto.decks))
    return failure('deck-setup-pending', 'Every committed deck pass must be replayed before play');
  if (payload.kind === 'membership') return success({ crypto, handled: false, input: null });
  const randomPending =
    payload.kind === 'system'
      ? engine.getPending(state).filter((item) => item.kind === 'random')
      : [];
  // A public draw is answered under its module's system type; a private one is always CARD_DEALT.
  const publicDeal =
    payload.kind === 'system' &&
    randomPending.length === 1 &&
    randomPending[0] !== undefined &&
    isPublicDraw(randomPending[0]) &&
    randomPending[0].systemType === payload.input.type;
  if (payload.kind === 'system' && (payload.input.type === 'CARD_DEALT' || publicDeal)) {
    if (crypto.beacon.active || crypto.beacon.fixed)
      return failure('beacon-pending', 'A deck deal cannot answer a beacon request');
    const pending = randomPending;
    if (pending.length !== 1)
      return failure('deck-pending', 'A deal requires exactly one certified random pending');
    const unlockers = crypto.decks.active ? deckUnlockers(crypto.decks.active) : [];
    const signers = [];
    for (const participant of unlockers) {
      const signer = resolveArtifactSigner(authority, genesis, crypto.epoch, participant.seat);
      if (!signer.ok) return signer;
      signers.push(signer.value);
    }
    const completed = completeDeckDeal(
      crypto.decks,
      state,
      pending[0] ?? null,
      payload.input,
      payload.evidence,
      { seq: entry.seq, hash: entryHash(entry) },
      signers,
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
  if (payload.kind === 'crypto' && payload.action === 'steal-fixed') {
    if (!crypto.steal)
      return failure('steal-state-required', 'No certified steal operation is pending');
    const signer = resolveArtifactSigner(
      authority,
      genesis,
      crypto.epoch,
      crypto.steal.operation.victim.seat,
    );
    if (!signer.ok) return signer;
    const fixed = fixStealContribution(
      crypto.steal,
      payload.evidence,
      {
        seq: entry.seq,
        hash: entryHash(entry),
      },
      signer.value,
    );
    return fixed.ok
      ? success({ crypto: { ...crypto, steal: fixed.value }, handled: true, input: null })
      : fixed;
  }
  if (payload.kind === 'crypto' && payload.action === 'steal-dispute') {
    if (!crypto.steal)
      return failure('steal-state-required', 'No certified steal operation is pending');
    const signer = resolveArtifactSigner(
      authority,
      genesis,
      crypto.epoch,
      crypto.steal.operation.thief.seat,
    );
    if (!signer.ok) return signer;
    const disputed = disputeStealContribution(crypto.steal, payload.evidence, signer.value);
    return disputed.ok
      ? success({ crypto: { ...crypto, steal: disputed.value }, handled: true, input: null })
      : disputed;
  }
  if (payload.kind === 'system' && payload.input.type === 'STEAL_RESULT') {
    return success({ crypto, handled: true, input: payload.input });
  }
  if (payload.kind === 'crypto' && payload.action === 'beacon-extend') {
    const extended = extendBeaconState(
      crypto.beacon,
      payload.evidence,
      authority,
      genesis,
      crypto.epoch,
    );
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
  if (beaconInput || (payload.kind === 'crypto' && payload.action === 'beacon-fixed')) {
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
      authority,
      genesis,
      crypto.epoch,
    );
    if (!completed.ok) return completed;
    const outcome = completed.value.outcome;
    if (payload.kind === 'crypto') {
      if (outcome.kind !== 'steal-index')
        return failure('beacon-fixed-kind', 'Only a hidden steal index needs a fixed beacon entry');
      const frozen = freezeStealState(
        genesis,
        completed.value.state,
        crypto.hands,
        state,
        crypto.epoch,
        authority,
      );
      if (!frozen.ok) return frozen;
      return success({
        crypto: { ...crypto, beacon: completed.value.state, steal: frozen.value },
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

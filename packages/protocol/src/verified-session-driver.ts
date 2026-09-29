import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import {
  G,
  decodeScalar,
  encodePoint,
  encodeScalar,
  modScalar,
  openSealed,
  scalarFromBytes,
  scalarToBytes,
  scalePoint,
  seal,
  uniformInt,
} from '@cp2p/crypto';
import type { SchnorrProof } from '@cp2p/crypto';
import {
  cardKindsFor,
  decksFor,
  failure,
  kindBounds,
  kindsOfCounts,
  knightsLook,
  success,
  trackOfDeck,
  VICTORY_CARDS,
} from '@cp2p/engine';
import type {
  Engine,
  GameState,
  Input,
  Pending,
  PrivateInputData,
  PrivateState,
  Result,
  Seat,
  SystemInput,
} from '@cp2p/engine';
import { decodeDeckCard, proveDeckDenial, proveDeckReveal } from './deck-draw.js';
import type { DeckRevealContext } from './deck-draw.js';
import { relockScalar, proveSpyRequest, proveSpyUnlock } from './spy-look.js';
import { hiddenSlotsOf, lookStep } from './look-flow.js';
import { preproofNeed, proveDebitPreproof } from './preproof.js';
import { slotHolder } from './deck-ledger.js';
import type { LedgerDeck, LedgerSlot } from './deck-ledger.js';
import { bodyInput } from './seat-input.js';
import type { DeckSetupState } from './deck-setup.js';
import type { LogContext, ValidatedEntry } from './log.js';
import type { SessionDriver } from './session-driver.js';
import type { DeckSecretSource, DeckSourceFactory } from './deck-source.js';
import type { HandSourceFactory } from './hand-source.js';
import { verifyHandOpening } from './hand-commitments.js';
import {
  handProofContext,
  planHandTransition,
  proveHandObligation,
  verifyHandProof,
  verifyHandProofs,
} from './hand-transition.js';
import type { HandProof, HandProofBinding, HandTransitionPlan } from './hand-transition.js';
import { authorizeTradeProof, verifyTradeProofRequest } from './trade-proof-delivery.js';
import type { IndexedHandProof, SignedTradeProofRequest } from './trade-proof-delivery.js';
import { composeCommandProofs } from './command-proofs.js';
import { countOperationId, countProofContext, proveCountOpening } from './count-reveal.js';
import type { CountOperation } from './count-reveal.js';
import { validateCountState } from './count-state.js';
import type { CommandBody, Genesis, SystemEvidence } from './types.js';
import type { CertifiedEntry } from './proposal.js';
import { entryHash, genesisDigest } from './genesis.js';
import {
  createStealContribution,
  createStealDispute,
  createStealReceipt,
  openStealContribution,
  recoverStealTransferOpening,
  stealOperationId,
} from './steal-delivery.js';
import type {
  FixedSteal,
  SignedStealContribution,
  SignedStealDispute,
  SignedStealReceipt,
  StealOpening,
  StealOperation,
} from './steal-delivery.js';
import type { StealSecretSource, StealSourceFactory } from './steal-source.js';
import { validateStealState, verifyStealResult } from './steal-state.js';
import { resolveArtifactSigner } from './authority.js';

type CommandWithoutEvidence = Omit<CommandBody, 'evidence'>;

/** One kind's entry in a sealed hand opening: a count byte and a 32-byte blinding. */
const HAND_OPENING_ENTRY = 33;

function handLookSealContext(action: DeckRevealContext, actor: Seat, kinds: readonly string[]) {
  return { protocol: 'hand-look-v1', action, to: actor, kinds };
}

/** A hand another seat showed this one privately (Master Merchant): its counts and blindings. */
interface HandLook {
  target: Seat;
  counts: Record<string, number>;
  blindings: Record<string, string>;
}

/** Open a held slot with its holder's lock: the drawer's, or the one a take gave the seat. */
function decodeHeldCard(setup: DeckSetupState, slot: LedgerSlot, lock: bigint) {
  return decodeDeckCard(setup, slot.receipt, lock, slot.unlockSigners, slotHolder(slot));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function copyPrivate(state: PrivateState): PrivateState {
  return {
    seat: state.seat,
    hand: { ...state.hand },
    slots: { ...state.slots },
    ext: Object.fromEntries(
      Object.entries(state.ext).map(([key, value]) => [
        key,
        canonicalDecode(canonicalEncode(value)),
      ]),
    ),
  };
}

function wipePrivateBytes(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (value instanceof Uint8Array) {
    value.fill(0);
    return;
  }
  for (const nested of Object.values(value)) wipePrivateBytes(nested, seen);
}

/** The owned counts over exactly the given card kinds; a missing kind reads as -1 and fails. */
function resourceCounts(state: PrivateState, kinds: readonly string[]): Record<string, number> {
  return Object.fromEntries(kinds.map((kind) => [kind, state.hand[kind] ?? -1]));
}

function validOwnedState(state: GameState, priv: PrivateState): Result<void> {
  const holder = state.seats.find((item) => item.seat === priv.seat);
  if (!holder) return failure('verified-private-seat', 'Owned seat is missing from public state');
  let total = 0;
  const bounds = kindBounds(holder.resources);
  for (const resource of kindsOfCounts(state.bank)) {
    const count = priv.hand[resource];
    const min = bounds.min[resource] ?? 0;
    const max = bounds.max[resource] ?? 0;
    if (count === undefined || !Number.isSafeInteger(count) || count < min || count > max)
      return failure('verified-private-bounds', 'Owned resources are outside public bounds');
    total += count;
  }
  if (total !== holder.resources.total)
    return failure('verified-private-total', 'Owned resource total differs from public count');

  const publicSlots = new Map(holder.cardSlots.map((slot) => [slot.slotId, slot]));
  const decks = decksFor(state.config);
  for (const [slotId, card] of Object.entries(priv.slots)) {
    const slot = publicSlots.get(slotId);
    if (
      !slot ||
      slot.revealed !== undefined ||
      slot.known !== undefined ||
      !Object.hasOwn(decks[slot.deck]?.cards ?? {}, card)
    )
      return failure('verified-private-slots', 'Owned hidden card does not match a public slot');
  }
  // A slot whose identity is public (`known`) has no private entry.
  for (const slot of holder.cardSlots)
    if (
      slot.revealed === undefined &&
      slot.known === undefined &&
      !Object.hasOwn(priv.slots, slot.slotId)
    )
      return failure('verified-private-slots', 'Owned private cards differ from public slots');
  return success(undefined);
}

/** Local verified-session private state. Only supplied seats are ever retained. */
export class VerifiedSessionDriver implements SessionDriver {
  private readonly digest: string;
  private readonly owned = new Set<Seat>();
  private privates = new Map<Seat, PrivateState>();
  private blindings = new Map<Seat, Record<string, string>>();
  /** The last (ledger row, hand, blindings) triple whose opening verified, per owned seat. */
  private readonly openedHands = new Map<Seat, string>();
  /** What a Master Merchant seat was shown of its target's hand, until it takes its cards. */
  private readonly handLooks = new Map<Seat, HandLook>();
  /** What a Spy seat learned of its target's cards, by slot, until it takes one. */
  private readonly spyKnowledge = new Map<Seat, Map<string, string>>();
  private readonly kinds: readonly string[];
  private appliedHead: string | null = null;
  private disposed = false;
  private readonly deckRoutes = new Map<Seat, DeckSourceFactory>();
  private readonly handRoutes = new Map<Seat, HandSourceFactory>();
  private readonly stealRoutes = new Map<Seat, StealSourceFactory>();

  constructor(
    private readonly engine: Engine,
    private readonly genesis: Genesis,
    ownedSeats: readonly Seat[],
    private readonly createDeckSource: DeckSourceFactory,
    private readonly createHandSource?: HandSourceFactory,
    private readonly createStealSource?: StealSourceFactory,
  ) {
    if (genesis.security !== 'verified')
      throw new TypeError('Verified session driver requires verified genesis');
    this.digest = genesisDigest(genesis);
    this.kinds = cardKindsFor(genesis.config);
    if (ownedSeats.length === 0 || new Set(ownedSeats).size !== ownedSeats.length)
      throw new RangeError('At least one unique owned seat is required');
    const configured = new Set(genesis.config.seats);
    for (const seat of ownedSeats) {
      if (!configured.has(seat)) throw new RangeError('Owned seat is not configured in genesis');
      this.owned.add(seat);
      this.privates.set(seat, engine.createPrivateState(seat, genesis.config));
      const zero = encodeScalar(0n);
      this.blindings.set(seat, Object.fromEntries(this.kinds.map((kind) => [kind, zero])));
    }
  }

  next(_context: LogContext): { input: SystemInput; evidence: SystemEvidence } | null {
    return null;
  }

  privateState(seat: Seat): PrivateState | null {
    if (this.disposed) return null;
    const state = this.privates.get(seat);
    return state ? copyPrivate(state) : null;
  }

  private verifyOwnedOpenings(
    context: LogContext,
    privates: ReadonlyMap<Seat, PrivateState> = this.privates,
    blindingsBySeat: ReadonlyMap<Seat, Record<string, string>> = this.blindings,
  ): Result<void> {
    if (!context.crypto)
      return failure('crypto-context-required', 'Verified hand needs replayed crypto state');
    for (const seat of this.owned) {
      const priv = privates.get(seat);
      const blindings = blindingsBySeat.get(seat);
      if (!priv || !blindings)
        return failure('verified-private-missing', 'Owned hand opening is missing');
      const valid = validOwnedState(context.state, priv);
      if (!valid.ok) return valid;
      // The opening is a pure function of the ledger row, the counts and the blindings, and it
      // costs one Pedersen commitment per kind, so an unchanged triple is not opened again.
      const kinds = kindsOfCounts(context.state.bank);
      const row = context.crypto.hands.find((item) => item.seat === seat);
      const openedKey = toHex(hashValue({ kinds, row, hand: priv.hand, blindings }));
      if (this.openedHands.get(seat) === openedKey) continue;
      const opened = verifyHandOpening(
        context.crypto.hands,
        this.genesis.config.seats,
        seat,
        priv.hand,
        blindings,
        kinds,
      );
      if (!opened.ok) return opened;
      this.openedHands.set(seat, openedKey);
    }
    return success(undefined);
  }

  private currentStealContext(context: LogContext): Result<void> {
    if (
      genesisDigest(context.genesis) !== this.digest ||
      context.genesis.gameId !== this.genesis.gameId ||
      !context.crypto ||
      (this.appliedHead === null
        ? context.head.seq !== 0
        : entryHash(context.head) !== this.appliedHead)
    )
      return failure('verified-steal-context', 'Steal request has a stale or foreign parent');
    const openings = this.verifyOwnedOpenings(context);
    if (!openings.ok) return openings;
    const crypto = context.crypto;
    if (!crypto) return failure('crypto-context-required', 'Verified steal needs crypto state');
    const steal = validateStealState(
      crypto.steal,
      this.genesis,
      crypto.beacon,
      crypto.hands,
      context.state,
      crypto.epoch,
      context.authority,
    );
    return steal.ok ? success(undefined) : steal;
  }

  private checkedStealSource(seat: Seat): Result<StealSecretSource> {
    const factory = this.stealRoutes.get(seat) ?? this.createStealSource;
    if (!factory) return failure('steal-source', 'No steal secret source is configured');
    let source: StealSecretSource | null = null;
    try {
      source = factory(seat);
      const genesisKey = this.genesis.seats.find((item) => item.seat === seat)?.encryptionKey;
      if (!genesisKey || encodePoint(scalePoint(G, source.encryptionSecret())) !== genesisKey) {
        source.dispose();
        return failure(
          'steal-source-key',
          'Owned steal source differs from the genesis encryption key',
        );
      }
      return success(source);
    } catch {
      source?.dispose();
      return failure('steal-source-key', 'Could not derive the original owned encryption key');
    }
  }

  /** Fail before journal use if any locally owned seat cannot open its genesis key. */
  validateSources(): Result<void> {
    if (this.disposed) return failure('verified-driver-disposed', 'Verified driver is disposed');
    for (const seat of this.owned) {
      const checked = this.checkedStealSource(seat);
      if (!checked.ok) return checked;
      checked.value.dispose();
    }
    return success(undefined);
  }

  produceStealContribution(
    operation: StealOperation,
    seat: Seat,
    context: LogContext,
    signingKey: Uint8Array,
  ): Result<SignedStealContribution> {
    if (this.disposed) return failure('verified-driver-disposed', 'Verified driver is disposed');
    if (!this.owned.has(seat))
      return failure('seat-not-controllable', 'Verified driver does not own this steal victim');
    const current = this.currentStealContext(context);
    if (!current.ok) return current;
    const pending = context.crypto?.steal;
    const signer = resolveArtifactSigner(
      context.authority,
      context.genesis,
      context.crypto?.epoch ?? 0,
      seat,
    );
    if (!signer.ok) return signer;
    try {
      if (
        !pending ||
        pending.fixed ||
        pending.dispute ||
        pending.operation.victim.seat !== seat ||
        stealOperationId(pending.operation) !== stealOperationId(operation) ||
        operation.genesisDigest !== this.digest ||
        operation.epoch > (context.crypto?.epoch ?? -1) ||
        operation.thief.encryptionKey !==
          this.genesis.seats.find((item) => item.seat === operation.thief.seat)?.encryptionKey
      )
        return failure(
          'verified-steal-operation',
          'Victim request is not the current frozen steal',
        );
    } catch {
      return failure('verified-steal-operation', 'Victim request is malformed');
    }
    const priv = this.privates.get(seat);
    const blindings = this.blindings.get(seat);
    if (!priv || !blindings)
      return failure('verified-private-missing', 'Owned steal opening is missing');
    const sourceResult = this.checkedStealSource(seat);
    if (!sourceResult.ok) return sourceResult;
    const source = sourceResult.value;
    try {
      const seed = source.proofSeed('transfer', {
        protocol: 'steal-transfer-source-v1',
        operationId: stealOperationId(operation),
      });
      try {
        return createStealContribution(
          operation,
          resourceCounts(priv, kindsOfCounts(operation.commitments)),
          blindings,
          seed,
          signingKey,
          signer.value,
        );
      } finally {
        seed.fill(0);
      }
    } catch {
      return failure('verified-steal-contribution', 'Could not prepare owned steal contribution');
    } finally {
      source.dispose();
    }
  }

  produceStealResponse(
    fixed: FixedSteal,
    seat: Seat,
    context: LogContext,
    signingKey: Uint8Array,
  ): Result<
    { kind: 'receipt'; value: SignedStealReceipt } | { kind: 'dispute'; value: SignedStealDispute }
  > {
    if (this.disposed) return failure('verified-driver-disposed', 'Verified driver is disposed');
    if (!this.owned.has(seat))
      return failure('seat-not-controllable', 'Verified driver does not own this steal recipient');
    const current = this.currentStealContext(context);
    if (!current.ok) return current;
    const pending = context.crypto?.steal;
    const signer = resolveArtifactSigner(
      context.authority,
      context.genesis,
      context.crypto?.epoch ?? 0,
      seat,
    );
    if (!signer.ok) return signer;
    try {
      if (
        !pending?.fixed ||
        pending.dispute ||
        pending.operation.thief.seat !== seat ||
        stealOperationId(pending.operation) !== stealOperationId(fixed.operation) ||
        toHex(hashValue(pending.fixed)) !== toHex(hashValue(fixed)) ||
        fixed.operation.genesisDigest !== this.digest ||
        fixed.operation.epoch > (context.crypto?.epoch ?? -1) ||
        fixed.operation.thief.encryptionKey !==
          this.genesis.seats.find((item) => item.seat === seat)?.encryptionKey
      )
        return failure(
          'verified-steal-fixed',
          'Recipient request differs from the certified fixed steal',
        );
    } catch {
      return failure('verified-steal-fixed', 'Recipient request is malformed');
    }
    const sourceResult = this.checkedStealSource(seat);
    if (!sourceResult.ok) return sourceResult;
    const source = sourceResult.value;
    try {
      const secret = source.encryptionSecret();
      const receipt = createStealReceipt(fixed, secret, signingKey, signer.value);
      if (receipt.ok) return success({ kind: 'receipt', value: receipt.value });
      if (
        ![
          'steal-opening-size',
          'steal-opening-type',
          'steal-opening-mismatch',
          'steal-opening',
        ].includes(receipt.error.code)
      )
        return receipt;
      const seed = source.proofSeed('dispute', {
        protocol: 'steal-dispute-source-v1',
        operationId: stealOperationId(fixed.operation),
        fixed: fixed.entry,
      });
      try {
        const dispute = createStealDispute(fixed, secret, signingKey, seed, signer.value);
        return dispute.ok ? success({ kind: 'dispute', value: dispute.value }) : dispute;
      } finally {
        seed.fill(0);
      }
    } catch {
      return failure('verified-steal-response', 'Could not prepare owned steal response');
    } finally {
      source.dispose();
    }
  }

  /** Derive one owned, exact Monopoly count opening for the frozen public request. */
  produceCountProof(
    operation: CountOperation,
    seat: Seat,
    context: LogContext,
  ): Result<{ count: number; proof: SchnorrProof }> {
    if (this.disposed) return failure('verified-driver-disposed', 'Verified driver is disposed');
    if (!this.owned.has(seat))
      return failure('seat-not-controllable', 'Verified driver does not own this victim');
    const crypto = context.crypto;
    if (
      genesisDigest(context.genesis) !== this.digest ||
      context.genesis.gameId !== this.genesis.gameId ||
      !crypto ||
      (this.appliedHead === null
        ? context.head.seq !== 0
        : entryHash(context.head) !== this.appliedHead)
    )
      return failure('verified-count-context', 'Count proof has a stale or foreign parent');
    const pending = crypto.counts;
    const validPending = validateCountState(
      pending,
      this.genesis,
      this.engine,
      context.state,
      crypto.hands,
      crypto.epoch,
      context.authority,
    );
    if (!validPending.ok) return validPending;
    let sameOperation = false;
    try {
      sameOperation =
        pending !== null && countOperationId(pending.operation) === countOperationId(operation);
    } catch {
      return failure('verified-count-operation', 'Count proof operation is malformed');
    }
    const victim = operation.victims.find((item) => item.seat === seat);
    const hand = crypto.hands.find((item) => item.seat === seat);
    if (
      !pending ||
      !sameOperation ||
      !pending.remaining.includes(seat) ||
      operation.genesisDigest !== this.digest ||
      operation.epoch > crypto.epoch ||
      !victim ||
      victim.commitment !== hand?.commitments[operation.resource]
    )
      return failure('verified-count-operation', 'Count proof is not the current victim request');
    const opened = this.verifyOwnedOpenings(context);
    if (!opened.ok) return opened;
    const priv = this.privates.get(seat);
    const blindings = this.blindings.get(seat);
    if (!priv || !blindings)
      return failure('verified-private-missing', 'Owned count opening is missing');
    const factory = this.handRoutes.get(seat) ?? this.createHandSource;
    if (!factory) return failure('hand-proof-source', 'No hand proof source is configured');
    const count = priv.hand[operation.resource];
    if (count === undefined)
      return failure('verified-private-missing', 'Owned count resource is missing');
    const blinding = blindings[operation.resource];
    if (blinding === undefined)
      return failure('verified-private-missing', 'Owned count blinding is missing');
    let source: ReturnType<HandSourceFactory> | null = null;
    try {
      source = factory(seat);
      const proofContext = countProofContext(operation, seat, count);
      const seed = source.proofSeed(proofContext);
      try {
        const proof = proveCountOpening(operation, seat, count, blinding, seed);
        return proof.ok ? success({ count, proof: proof.value }) : proof;
      } finally {
        seed.fill(0);
      }
    } catch {
      return failure('verified-count-proof', 'Could not derive owned count proof');
    } finally {
      source?.dispose();
    }
  }

  private proveOwnedHand(
    plan: HandTransitionPlan,
    index: number,
    binding: HandProofBinding,
    /** An opening of the obligation's hand shown privately to the signer (Master Merchant). */
    shown?: HandLook,
    signer?: Seat,
  ): Result<HandProof> {
    const obligation = plan.obligations[index];
    const own = obligation !== undefined && this.owned.has(obligation.seat);
    if (!obligation || (!own && (shown?.target !== obligation.seat || signer === undefined)))
      return failure('hand-proof-owner', 'A hand proof from another owner is required');
    const counts = own ? this.privates.get(obligation.seat)?.hand : shown?.counts;
    const blindings = own ? this.blindings.get(obligation.seat) : shown?.blindings;
    if (!counts || !blindings)
      return failure('verified-private-missing', 'Owned hand opening is missing');
    const proverSeat = own ? obligation.seat : signer;
    if (proverSeat === undefined) return failure('hand-proof-owner', 'No prover for this proof');
    const factory = this.handRoutes.get(proverSeat) ?? this.createHandSource;
    if (!factory) return failure('hand-proof-source', 'No hand proof source is configured');
    let source: ReturnType<HandSourceFactory> | null = null;
    try {
      source = factory(proverSeat);
      const seed = source.proofSeed(handProofContext(plan, index, binding));
      try {
        return proveHandObligation(plan, index, counts, blindings, seed, binding);
      } finally {
        seed.fill(0);
      }
    } catch {
      return failure('hand-proof-generation', 'Could not derive the owned hand proof');
    } finally {
      source?.dispose();
    }
  }

  /** Return only the current trade counterparty's exact indexed obligations. */
  produceTradeProofs(
    request: SignedTradeProofRequest,
    context: LogContext,
  ): Result<readonly IndexedHandProof[]> {
    if (this.disposed) return failure('verified-driver-disposed', 'Verified driver is disposed');
    const verified = verifyTradeProofRequest(request, context);
    if (!verified.ok) return verified;
    const owner = verified.value.body.command.withSeat;
    if (!this.owned.has(owner))
      return failure(
        'seat-not-controllable',
        'Verified driver does not own this trade counterparty',
      );
    if (
      genesisDigest(context.genesis) !== this.digest ||
      context.genesis.gameId !== this.genesis.gameId ||
      (this.appliedHead === null
        ? context.head.seq !== 0
        : entryHash(context.head) !== this.appliedHead)
    )
      return failure('verified-trade-context', 'Trade proof has a stale or foreign parent');
    const authorized = authorizeTradeProof(verified.value.body, owner, context);
    if (!authorized.ok) return authorized;
    const opened = this.verifyOwnedOpenings(context);
    if (!opened.ok) return opened;
    const proofs: IndexedHandProof[] = [];
    for (const index of authorized.value.indices) {
      const proof = this.proveOwnedHand(authorized.value.plan, index, authorized.value.binding);
      if (!proof.ok) return proof;
      proofs.push({ index, proof: proof.value });
    }
    return success(proofs);
  }

  /** Attach proof material before the caller signs this exact command body. */
  prepareCommand(
    body: CommandWithoutEvidence,
    context: LogContext,
    external?: readonly IndexedHandProof[],
  ): Result<CommandBody['evidence']> {
    if (this.disposed) return failure('verified-driver-disposed', 'Verified driver is disposed');
    if (!this.owned.has(body.seat))
      return failure('seat-not-controllable', 'Verified driver does not own this seat');
    if (
      body.gameId !== context.genesis.gameId ||
      body.gameId !== this.genesis.gameId ||
      body.genesisDigest !== this.digest ||
      genesisDigest(context.genesis) !== this.digest ||
      body.headSeq !== context.head.seq ||
      body.headHash !== entryHash(context.head) ||
      (this.appliedHead === null ? context.head.seq !== 0 : body.headHash !== this.appliedHead) ||
      body.nonce !== (context.lastNonces.get(body.seat) ?? 0) + 1
    )
      return failure(
        'verified-command-context',
        'Command body differs from current certified context',
      );
    const openings = this.verifyOwnedOpenings(context);
    if (!openings.ok) return openings;
    const crypto = context.crypto;
    if (!crypto) return failure('crypto-context-required', 'Verified command needs crypto state');
    const input: Input = bodyInput(body.seat, body.command);
    const preview = this.engine.apply(context.state, input);
    if (!preview.ok) return preview;
    const plan = planHandTransition(
      crypto.hands,
      context.state,
      input,
      preview.value,
      crypto.preproofs,
    );
    if (!plan.ok) return plan;
    const binding = {
      genesisDigest: this.digest,
      epoch: crypto.epoch,
      anchor: { seq: body.headSeq, hash: body.headHash },
      command: body,
    };
    if (external !== undefined && body.command.type !== 'CONFIRM_TRADE')
      return failure('hand-proof-external', 'External hand proofs require trade confirmation');
    const supplied = new Map<number, HandProof>();
    if (external !== undefined) {
      if (!Array.isArray(external))
        return failure('hand-proof-external', 'External trade proofs must be indexed');
      for (const item of external) {
        const obligation =
          item && Number.isSafeInteger(item.index) ? plan.value.obligations[item.index] : undefined;
        if (
          !item ||
          !Number.isSafeInteger(item.index) ||
          item.index < 0 ||
          supplied.has(item.index) ||
          !obligation ||
          (body.command.type === 'CONFIRM_TRADE' && obligation.seat !== body.command.withSeat) ||
          this.owned.has(obligation.seat)
        )
          return failure('hand-proof-external', 'External trade proof index is invalid');
        const verified = verifyHandProof(plan.value, item.index, item.proof, binding);
        if (!verified.ok) return verified;
        supplied.set(item.index, item.proof);
      }
    }
    // A Master Merchant that was shown its target's hand can prove the target's debit itself.
    const shown =
      input.kind === 'system' && input.type === 'TAKE_CARDS'
        ? this.handLooks.get(body.seat)
        : undefined;
    for (const [index, obligation] of plan.value.obligations.entries())
      if (
        !this.owned.has(obligation.seat) &&
        !supplied.has(index) &&
        shown?.target !== obligation.seat
      )
        return failure('hand-proof-owner', 'A hand proof from another owner is required');
    const handProofs: HandProof[] = [];
    for (let index = 0; index < plan.value.obligations.length; index++) {
      const obligation = plan.value.obligations[index];
      if (!obligation) throw new Error('Missing planned hand obligation');
      if (!this.owned.has(obligation.seat) && shown?.target !== obligation.seat) {
        const proof = supplied.get(index);
        if (!proof)
          return failure('hand-proof-owner', 'A hand proof from another owner is required');
        handProofs.push(proof);
        continue;
      }
      const proof = this.proveOwnedHand(plan.value, index, binding, shown, body.seat);
      if (!proof.ok) return proof;
      handProofs.push(proof.value);
    }
    const complete = verifyHandProofs(plan.value, handProofs, binding);
    if (!complete.ok) return complete;

    const revealContext = {
      genesisDigest: body.genesisDigest,
      epoch: crypto.epoch,
      anchor: { seq: body.headSeq, hash: body.headHash },
      seat: body.seat,
      nonce: body.nonce,
      command: body.command,
    };
    const owned = (slotId: string, seat: Seat, deckId: string) => {
      if (seat !== body.seat)
        return failure('deck-reveal-owner', 'Input reveals another seat’s card slot');
      const deck = crypto.decks.decks.find((item) =>
        item.slots.some((slot) => slot.slotId === slotId),
      );
      const slot = deck?.slots.find((item) => item.slotId === slotId);
      if (!deck || !slot || deck.commitment.definition.deckId !== deckId)
        return failure('deck-reveal-owner', 'Reveal slot has no hidden deck receipt');
      if (slot.seat !== body.seat)
        return failure('deck-reveal-owner', 'Reveal slot is not owned by this seat');
      const publicSlot = context.state.seats
        .find((candidate) => candidate.seat === body.seat)
        ?.cardSlots.find((candidate) => candidate.slotId === slotId);
      if (
        !publicSlot ||
        publicSlot.revealed !== undefined ||
        publicSlot.known !== undefined ||
        publicSlot.deck !== deck.commitment.definition.deckId
      )
        return failure('deck-reveal-owner', 'Reveal slot is not an owned hidden public card');
      return success({ deck, slot });
    };
    /** The owner's lock for one held slot: the drawer's own, or the one a take gave it. */
    const lockOf = (deckId: string, slot: LedgerSlot): bigint => {
      if (slot.relock) return this.relockSecret(deckId, body.seat, slot);
      let source: DeckSecretSource | null = null;
      try {
        source = this.newSource(deckId, body.seat);
        return source.lock(slot.receipt.operation.position);
      } finally {
        source?.dispose();
      }
    };
    const identityOf = (deck: LedgerDeck, slot: LedgerSlot): Result<string> => {
      const lock = lockOf(deck.commitment.definition.deckId, slot);
      const decoded = decodeHeldCard(deck.setup, slot, lock);
      return decoded.ok ? success(decoded.value.identity) : decoded;
    };

    if (new Set(plan.value.reveals.map((item) => item.slotId)).size !== plan.value.reveals.length)
      return failure('deck-reveal-slots', 'Command has duplicate reveal slots');
    const data: {
      slotId: string;
      identity: string;
      proof: ReturnType<typeof proveDeckReveal>['proof'];
    }[] = [];
    for (const reveal of plan.value.reveals) {
      const held = owned(reveal.slotId, reveal.seat, reveal.deck);
      if (!held.ok) return held;
      const { deck, slot } = held.value;
      try {
        const lock = lockOf(reveal.deck, slot);
        const decoded = decodeHeldCard(deck.setup, slot, lock);
        if (!decoded.ok) return decoded;
        if (decoded.value.card !== reveal.card)
          return failure('deck-reveal-kind', 'Owned card does not match the requested input');
        let source: DeckSecretSource | null = null;
        try {
          source = this.newSource(reveal.deck, body.seat);
          const seed = source.proofSeed('reveal', { ...revealContext, slotId: reveal.slotId });
          try {
            const proven = proveDeckReveal(
              deck.setup,
              slot.receipt,
              decoded.value.identity,
              lock,
              seed,
              revealContext,
              slot.unlockSigners,
              slotHolder(slot),
            );
            data.push({ slotId: reveal.slotId, ...proven });
          } finally {
            seed.fill(0);
          }
        } finally {
          source?.dispose();
        }
      } catch {
        return failure('deck-reveal-proof', 'Could not derive the owned card reveal proof');
      }
    }
    const denials: unknown[] = [];
    for (const denial of plan.value.denials) {
      const held = owned(denial.slotId, denial.seat, denial.deck);
      if (!held.ok) return held;
      const { deck, slot } = held.value;
      try {
        const identity = identityOf(deck, slot);
        if (!identity.ok) return identity;
        const lock = lockOf(denial.deck, slot);
        let source: DeckSecretSource | null = null;
        try {
          source = this.newSource(denial.deck, body.seat);
          const seed = source.proofSeed('denial', { ...revealContext, slotId: denial.slotId });
          try {
            denials.push(
              proveDeckDenial(
                deck.setup,
                slot.receipt,
                identity.value,
                denial.excluded,
                lock,
                seed,
                revealContext,
                slot.unlockSigners,
                slotHolder(slot),
              ),
            );
          } catch {
            return failure(
              'deck-denial-witness',
              'The owned card is excluded, so it cannot be denied',
            );
          } finally {
            seed.fill(0);
          }
        } finally {
          source?.dispose();
        }
      } catch {
        return failure('deck-denial-proof', 'Could not derive the owned card denial proof');
      }
    }
    const step = lookStep(input, preview.value.state);
    let look: unknown;
    if (step === 'spy-request') {
      const built = this.spyRequestEvidence(body, context, revealContext, preview.value.state);
      if (!built.ok) return built;
      look = built.value;
    } else if (step === 'spy-unlock') {
      const built = this.spyUnlockEvidence(body, context, revealContext);
      if (!built.ok) return built;
      look = built.value;
    } else if (step === 'hand-show') {
      const built = this.handShowEvidence(body, context, input, revealContext);
      if (!built.ok) return built;
      look = built.value;
    } else if (step === 'harbor-offer') {
      const built = this.debitPreproofEvidence(body, context, input, revealContext);
      if (!built.ok) return built;
      look = built.value;
    }
    return success(composeCommandProofs(data, handProofs, { denials, look }));
  }

  committedEntry(
    entry: ValidatedEntry & CertifiedEntry,
    before: LogContext,
    after: LogContext,
  ): Result<void> {
    if (this.disposed) return failure('verified-driver-disposed', 'Verified driver is disposed');
    if (
      genesisDigest(before.genesis) !== this.digest ||
      genesisDigest(after.genesis) !== this.digest ||
      (this.appliedHead === null
        ? before.head.seq !== 0
        : entryHash(before.head) !== this.appliedHead) ||
      entry.entry.seq !== before.head.seq + 1 ||
      entry.entry.prevHash !== entryHash(before.head) ||
      entryHash(entry.entry) !== entryHash(after.head)
    )
      return failure('verified-entry-context', 'Private update differs from certified history');
    const parentOpenings = this.verifyOwnedOpenings(before);
    if (!parentOpenings.ok) return parentOpenings;
    const input = entry.input;
    if (!input) {
      const afterOpenings = this.verifyOwnedOpenings(after);
      if (!afterOpenings.ok) return afterOpenings;
      this.appliedHead = entryHash(after.head);
      return success(undefined);
    }

    const privateData: Partial<Record<Seat, { card?: string; resource?: string }>> = {};
    const nextBlindings = new Map(this.blindings);
    if (input.kind === 'system' && input.type === 'STEAL_RESULT') {
      const steal = before.crypto?.steal;
      const payload = entry.entry.payload;
      if (
        !steal?.fixed ||
        steal.dispute ||
        !after.crypto ||
        after.crypto.steal !== null ||
        payload.kind !== 'system'
      )
        return failure(
          'verified-hidden-steal',
          'Certified hidden steal is missing its fixed operation',
        );
      const signer = resolveArtifactSigner(
        before.authority,
        before.genesis,
        before.crypto?.epoch ?? 0,
        steal.operation.thief.seat,
      );
      if (!signer.ok) return signer;
      const receipt = verifyStealResult(steal, input, payload.evidence, signer.value);
      if (!receipt.ok) return receipt;
      const { operation, fixed } = steal;
      let victimOpening: StealOpening | null = null;
      let thiefOpening: StealOpening | null = null;
      if (this.owned.has(operation.victim.seat)) {
        const seat = operation.victim.seat;
        const priv = this.privates.get(seat);
        const blindings = this.blindings.get(seat);
        if (!priv || !blindings)
          return failure('verified-private-missing', 'Victim private hand is missing');
        const sourceResult = this.checkedStealSource(seat);
        if (!sourceResult.ok) return sourceResult;
        const source = sourceResult.value;
        try {
          const seed = source.proofSeed('transfer', {
            protocol: 'steal-transfer-source-v1',
            operationId: stealOperationId(operation),
          });
          try {
            const recovered = recoverStealTransferOpening(
              operation,
              fixed.contribution,
              resourceCounts(priv, kindsOfCounts(operation.commitments)),
              blindings,
              seed,
            );
            if (!recovered.ok) return recovered;
            victimOpening = recovered.value;
          } finally {
            seed.fill(0);
          }
        } catch {
          return failure(
            'verified-steal-victim',
            'Could not recover the certified victim transfer',
          );
        } finally {
          source.dispose();
        }
      }
      if (this.owned.has(operation.thief.seat)) {
        const sourceResult = this.checkedStealSource(operation.thief.seat);
        if (!sourceResult.ok) return sourceResult;
        const source = sourceResult.value;
        try {
          const opened = openStealContribution(
            operation,
            fixed.contribution,
            source.encryptionSecret(),
            fixed.signer,
          );
          if (!opened.ok) return opened;
          thiefOpening = opened.value;
        } catch {
          return failure('verified-steal-thief', 'Could not open the certified thief transfer');
        } finally {
          source.dispose();
        }
      }
      if (
        victimOpening &&
        thiefOpening &&
        toHex(hashValue(victimOpening)) !== toHex(hashValue(thiefOpening))
      )
        return failure(
          'verified-steal-opening',
          'Owned endpoints disagree about the fixed transfer',
        );
      for (const [seat, direction, opening] of [
        [operation.victim.seat, -1n, victimOpening],
        [operation.thief.seat, 1n, thiefOpening],
      ] as const) {
        if (!opening) continue;
        privateData[seat] = { resource: opening.resource };
        const parent = this.blindings.get(seat);
        if (!parent)
          return failure('verified-private-missing', 'Owned steal blindings are missing');
        const next = { ...parent };
        for (const resource of kindsOfCounts(parent)) {
          const own = parent[resource];
          const moved = opening.blindings[resource];
          if (own === undefined || moved === undefined)
            return failure('verified-steal-opening', 'Fixed transfer misses a card kind');
          next[resource] = encodeScalar(
            modScalar(decodeScalar(own) + direction * decodeScalar(moved)),
          );
        }
        nextBlindings.set(seat, next);
      }
    }
    if (input.kind === 'system' && input.type === 'CARD_DEALT') {
      const owner = this.genesis.config.seats.find((seat) => seat === input.seat);
      if (owner === undefined || typeof input.deck !== 'string' || typeof input.slotId !== 'string')
        return failure('verified-deal-context', 'Certified deal has invalid deck, seat, or slot');
      const deck = after.crypto?.decks.decks.find(
        (item) => item.commitment.definition.deckId === input.deck,
      );
      const slot = deck?.slots.find((item) => item.slotId === input.slotId);
      if (!deck || !slot || slot.seat !== owner)
        return failure('verified-deal-receipt', 'Certified deal has no matching replayed receipt');
      if (this.owned.has(owner)) {
        let source: DeckSecretSource | null = null;
        try {
          source = this.newSource(input.deck, owner);
          const decoded = decodeDeckCard(
            deck.setup,
            slot.receipt,
            source.lock(slot.receipt.operation.position),
            slot.unlockSigners,
          );
          if (!decoded.ok) return decoded;
          privateData[owner] = { card: decoded.value.card };
        } catch {
          return failure('verified-deal-decode', 'Could not decode certified card for its owner');
        } finally {
          source?.dispose();
        }
      }
    }

    // A private look: what a seat was shown becomes local knowledge until it takes a card.
    const lookUpdates: (() => void)[] = [];
    const step = lookStep(input, after.state);
    const payload = entry.entry.payload;
    const signedBody = payload.kind === 'command' ? payload.signed.body : null;
    if (step === 'spy-unlock') {
      const spy = after.crypto?.decks.spy;
      if (spy && this.owned.has(spy.actor)) {
        const known = new Map<string, string>();
        for (const requested of spy.slots) {
          const deck = after.crypto?.decks.decks.find(
            (item) => item.commitment.definition.deckId === requested.deck,
          );
          const slot = deck?.slots.find((item) => item.slotId === requested.slotId);
          if (!deck || !slot || requested.point === undefined)
            return failure('verified-spy-slot', 'A Spy card was not unlocked');
          let source: DeckSecretSource | null = null;
          try {
            source = this.newSource(requested.deck, spy.actor);
            const decoded = decodeDeckCard(
              deck.setup,
              slot.receipt,
              relockScalar(source, {
                deckId: requested.deck,
                slotId: requested.slotId,
                request: spy.request,
              }),
              slot.unlockSigners,
              { seat: spy.actor, point: requested.point, lockKey: requested.key },
            );
            if (!decoded.ok) return decoded;
            known.set(requested.slotId, decoded.value.card);
          } catch {
            return failure('verified-spy-decode', 'Could not open a Spy card');
          } finally {
            source?.dispose();
          }
        }
        lookUpdates.push(() => this.spyKnowledge.set(spy.actor, known));
      }
    }
    const inputSeat =
      input.kind === 'system'
        ? this.genesis.config.seats.find((seat) => seat === input.seat)
        : undefined;
    if (step === 'spy-take' && input.kind === 'system' && inputSeat !== undefined) {
      const taker = inputSeat;
      if (this.owned.has(taker)) {
        const card =
          typeof input.slotId === 'string'
            ? this.spyKnowledge.get(taker)?.get(input.slotId)
            : undefined;
        if (card !== undefined) privateData[taker] = { card };
        lookUpdates.push(() => this.spyKnowledge.delete(taker));
      }
    }
    if (step === 'hand-show' && signedBody) {
      const look = knightsLook(before.state);
      if (look && this.owned.has(look.actor) && after.crypto) {
        const opened = this.openHandLook(look.actor, look.target, signedBody, before, after);
        if (opened) lookUpdates.push(() => this.handLooks.set(look.actor, opened));
      }
    }
    if (step === 'hand-take' && inputSeat !== undefined) {
      const taker = inputSeat;
      if (this.owned.has(taker)) lookUpdates.push(() => this.handLooks.delete(taker));
    }

    const next = new Map(this.privates);
    for (const seat of this.owned) {
      const prior = this.privates.get(seat);
      if (!prior) return failure('verified-private-missing', 'Owned private state is missing');
      const applied = this.engine.applyPrivate(prior, before.state, input, privateData[seat]);
      if (!applied.ok) return applied;
      if (applied.value.seat !== seat)
        return failure('verified-private-seat', 'Engine changed private-state ownership');
      const checked = validOwnedState(after.state, applied.value);
      if (!checked.ok) return checked;
      next.set(seat, applied.value);
    }
    const afterOpenings = this.verifyOwnedOpenings(after, next, nextBlindings);
    if (!afterOpenings.ok) return afterOpenings;
    this.privates = next;
    this.blindings = nextBlindings;
    for (const update of lookUpdates) update();
    this.appliedHead = entryHash(after.head);
    return success(undefined);
  }

  /**
   * The answer an owned seat gives to its own `reveal` request, decided from its private state:
   * an honest victory check, an echoed public deal, the target's show, or the actor's choice.
   * A random choice is a pure function of the seat's secret and the parent, so a retry repeats it.
   */
  revealAnswer(
    seat: Seat,
    pending: Extract<Pending, { kind: 'reveal' }>,
    context: LogContext,
  ): Result<SystemInput | null> {
    if (this.disposed) return failure('verified-driver-disposed', 'Verified driver is disposed');
    const priv = this.privates.get(seat);
    if (!this.owned.has(seat) || !priv)
      return failure('seat-not-controllable', 'Verified driver does not own this seat');
    const request = pending.request;
    switch (pending.systemType) {
      case 'REVEAL_PROGRESS': {
        const slotId = request.slotId;
        if (typeof slotId !== 'string')
          return failure('reveal-request', 'A victory check names no slot');
        const held = priv.slots[slotId];
        return success({
          kind: 'system',
          type: 'REVEAL_PROGRESS',
          seat,
          slotId,
          card: held !== undefined && Object.hasOwn(VICTORY_CARDS, held) ? held : 'none',
        });
      }
      case 'DEAL_KNOWN': {
        const { type: _type, ...echoed } = request;
        return success({ ...echoed, kind: 'system', type: 'DEAL_KNOWN', seat });
      }
      case 'SHOW_HAND':
        return success({
          kind: 'system',
          type: 'SHOW_HAND',
          seat,
          to: request.to,
          what: request.what,
        });
      case 'TAKE_CARDS': {
        const shown = this.handLooks.get(seat);
        const count = request.count;
        if (!shown || shown.target !== request.from || typeof count !== 'number')
          return success(null);
        const pool = Object.keys(shown.counts).flatMap((kind) =>
          Array<string>(Math.max(0, shown.counts[kind] ?? 0)).fill(kind),
        );
        if (pool.length < count) return success(null);
        const seed = this.choiceSeed(seat, {
          protocol: 'take-cards-v1',
          head: entryHash(context.head),
          count,
        });
        const taken: Record<string, number> = {};
        try {
          for (let n = 0; n < count; n++) {
            const picked = pool.splice(uniformInt(seed, 'take-cards', pool.length, { n }), 1)[0];
            if (picked === undefined) return success(null);
            taken[picked] = (taken[picked] ?? 0) + 1;
          }
        } finally {
          seed.fill(0);
        }
        return success({
          kind: 'system',
          type: 'TAKE_CARDS',
          seat,
          from: request.from,
          cards: taken,
        });
      }
      case 'TAKE_PROGRESS': {
        const from = this.genesis.config.seats.find((item) => item === request.from);
        if (from === undefined) return failure('reveal-request', 'A Spy take names no seat');
        const knowledge = this.spyKnowledge.get(seat);
        const candidates = (context.state.seats.find((item) => item.seat === from)?.cardSlots ?? [])
          .filter(
            (slot) =>
              slot.revealed === undefined &&
              trackOfDeck(slot.deck) !== null &&
              (slot.known !== undefined || knowledge?.has(slot.slotId)),
          )
          .map((slot) => slot.slotId);
        const seed = this.choiceSeed(seat, {
          protocol: 'take-progress-v1',
          head: entryHash(context.head),
        });
        let slotId: string | null = null;
        try {
          if (candidates.length > 0)
            slotId = candidates[uniformInt(seed, 'take-progress', candidates.length, {})] ?? null;
        } finally {
          seed.fill(0);
        }
        return success({ kind: 'system', type: 'TAKE_PROGRESS', seat, from, slotId });
      }
      default:
        return success(null);
    }
  }

  /** Private data an owned seat needs to apply its own input (a Spy learns the card it took). */
  privateInputData(seat: Seat, input: Input): PrivateInputData | undefined {
    if (
      input.kind !== 'system' ||
      input.type !== 'TAKE_PROGRESS' ||
      input.seat !== seat ||
      typeof input.slotId !== 'string'
    )
      return undefined;
    const card = this.spyKnowledge.get(seat)?.get(input.slotId);
    return card === undefined ? undefined : { card };
  }

  private choiceSeed(seat: Seat, context: unknown): Uint8Array {
    const factory = this.handRoutes.get(seat) ?? this.createHandSource;
    if (!factory) throw new Error('No hand proof source is configured');
    const source = factory(seat);
    try {
      return source.proofSeed({ protocol: 'reveal-choice-v1', context });
    } finally {
      source.dispose();
    }
  }

  /** Decrypt and check the hand a target sealed to this Master Merchant; null when it is unusable. */
  private openHandLook(
    actor: Seat,
    target: Seat,
    body: CommandBody,
    before: LogContext,
    after: LogContext,
  ): HandLook | null {
    const evidence = body.evidence?.data;
    const look = isRecord(evidence) ? evidence.look : undefined;
    const sealed = isRecord(look) ? look.sealed : undefined;
    const factory = this.stealRoutes.get(actor) ?? this.createStealSource;
    if (!sealed || !factory || !after.crypto) return null;
    const kinds = kindsOfCounts(after.state.bank);
    const action: DeckRevealContext = {
      genesisDigest: body.genesisDigest,
      epoch: before.crypto?.epoch ?? 0,
      anchor: { seq: body.headSeq, hash: body.headHash },
      seat: body.seat,
      nonce: body.nonce,
      command: body.command,
    };
    let source: StealSecretSource | null = null;
    try {
      source = factory(actor);
      const plain = openSealed(
        sealed,
        source.encryptionSecret(),
        handLookSealContext(action, actor, kinds),
      );
      if (plain.length !== kinds.length * HAND_OPENING_ENTRY) return null;
      const counts: Record<string, number> = {};
      const blindings: Record<string, string> = {};
      for (const [index, kind] of kinds.entries()) {
        counts[kind] = plain[index * HAND_OPENING_ENTRY] ?? -1;
        blindings[kind] = encodeScalar(
          scalarFromBytes(
            plain.slice(index * HAND_OPENING_ENTRY + 1, (index + 1) * HAND_OPENING_ENTRY),
          ),
        );
      }
      const opened = verifyHandOpening(
        after.crypto.hands,
        this.genesis.config.seats,
        target,
        counts,
        blindings,
        kinds,
      );
      return opened.ok ? { target, counts, blindings } : null;
    } catch {
      return null;
    } finally {
      source?.dispose();
    }
  }

  committed(_before: LogContext, _input: Input, _after: GameState): Result<void> {
    return failure('verified-entry-context', 'Verified driver requires certified entry callbacks');
  }

  /**
   * Copy reconstructed bot openings into this live driver at the same certified head.
   * The donor retains its master-backed source factories; its owning bundle must
   * remain alive until this driver is disposed.
   */
  adoptRecovered(donor: SessionDriver, context: LogContext): Result<void> {
    if (
      this.disposed ||
      !(donor instanceof VerifiedSessionDriver) ||
      donor.disposed ||
      donor === this
    )
      return failure('verified-adoption-driver', 'A live verified donor is required');
    const head = entryHash(context.head);
    if (
      !context.authority ||
      !context.crypto ||
      context.head.seq === 0 ||
      this.appliedHead !== head ||
      donor.appliedHead !== head ||
      this.engine !== donor.engine ||
      this.digest !== donor.digest ||
      this.digest !== genesisDigest(context.genesis) ||
      this.genesis.gameId !== donor.genesis.gameId ||
      context.genesis.gameId !== this.genesis.gameId ||
      context.head.stateHash !== toHex(hashValue(context.state))
    )
      return failure(
        'verified-adoption-context',
        'Donor and recipient need the same verified head',
      );
    const ownOpenings = this.verifyOwnedOpenings(context);
    if (!ownOpenings.ok) return ownOpenings;
    const donorOpenings = donor.verifyOwnedOpenings(context);
    if (!donorOpenings.ok) return donorOpenings;
    if (!donor.createHandSource || !donor.createStealSource)
      return failure('verified-adoption-source', 'Donor proof sources are missing');
    const checkedSources = donor.validateSources();
    if (!checkedSources.ok) return checkedSources;

    const states = new Map<Seat, { state: PrivateState; blindings: Record<string, string> }>();
    for (const seat of donor.owned) {
      const controller = context.authority.controllers.find((item) => item.seat === seat);
      const host = context.authority.controllers.find((item) => item.seat === controller?.hostSeat);
      const state = donor.privates.get(seat);
      const blindings = donor.blindings.get(seat);
      if (
        this.owned.has(seat) ||
        controller?.kind !== 'bot' ||
        controller.status !== 'active' ||
        host?.kind !== 'human' ||
        host.status !== 'active' ||
        !this.owned.has(host.seat) ||
        !state ||
        !blindings
      )
        return failure('verified-adoption-seat', 'Donor seat is not an active hosted bot');
      try {
        states.set(seat, { state: copyPrivate(state), blindings: { ...blindings } });
      } catch {
        return failure('verified-adoption-private', 'Donor private state could not be copied');
      }
    }
    if (states.size === 0) return failure('verified-adoption-seat', 'Donor has no recovered seats');

    for (const [seat, copied] of states) {
      this.owned.add(seat);
      this.privates.set(seat, copied.state);
      this.blindings.set(seat, copied.blindings);
      this.deckRoutes.set(seat, donor.deckRoutes.get(seat) ?? donor.createDeckSource);
      this.handRoutes.set(seat, donor.handRoutes.get(seat) ?? donor.createHandSource);
      this.stealRoutes.set(seat, donor.stealRoutes.get(seat) ?? donor.createStealSource);
    }
    return success(undefined);
  }

  relinquishSeats(seats: readonly Seat[]): void {
    for (const seat of seats) {
      if (!this.owned.delete(seat)) continue;
      const privateState = this.privates.get(seat);
      if (privateState) {
        for (const resource of Object.keys(privateState.hand)) privateState.hand[resource] = 0;
        for (const slot of Object.keys(privateState.slots)) delete privateState.slots[slot];
        for (const value of Object.values(privateState.ext)) wipePrivateBytes(value);
        for (const module of Object.keys(privateState.ext)) delete privateState.ext[module];
      }
      this.privates.delete(seat);
      this.blindings.delete(seat);
      this.deckRoutes.delete(seat);
      this.handRoutes.delete(seat);
      this.stealRoutes.delete(seat);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.relinquishSeats([...this.owned]);
    this.deckRoutes.clear();
    this.handRoutes.clear();
    this.stealRoutes.clear();
  }

  /** A Commercial Harbor offer: the player proves the offered card is in its committed hand. */
  private debitPreproofEvidence(
    body: CommandWithoutEvidence,
    context: LogContext,
    input: Input,
    action: DeckRevealContext,
  ): Result<unknown> {
    const need = preproofNeed(context.state, input);
    if (!need) return success(undefined);
    const commitment = context.crypto?.hands.find((row) => row.seat === need.seat)?.commitments[
      need.resource
    ];
    const held = this.privates.get(body.seat)?.hand[need.resource];
    const blinding = this.blindings.get(body.seat)?.[need.resource];
    const factory = this.handRoutes.get(body.seat) ?? this.createHandSource;
    if (commitment === undefined || held === undefined || blinding === undefined || !factory)
      return failure('preproof-source', 'The offered card cannot be proven');
    let source: ReturnType<HandSourceFactory> | null = null;
    try {
      source = factory(body.seat);
      const seed = source.proofSeed({ protocol: 'debit-preproof-seed-v1', need, action });
      try {
        return success(
          proveDebitPreproof(need, commitment, held, decodeScalar(blinding), seed, action),
        );
      } finally {
        seed.fill(0);
      }
    } catch {
      return failure('preproof-proof', 'Could not prove the offered card');
    } finally {
      source?.dispose();
    }
  }

  /** The lock a seat holds for one card: the one it drew, or the one it chose when taking it. */
  private holderLock(deckId: string, seat: Seat, slot: LedgerSlot): bigint {
    if (slot.relock) return this.relockSecret(deckId, seat, slot);
    let source: DeckSecretSource | null = null;
    try {
      source = this.newSource(deckId, seat);
      return source.lock(slot.receipt.operation.position);
    } finally {
      source?.dispose();
    }
  }

  /** A Spy's play: a fresh lock over every hidden card its target holds. */
  private spyRequestEvidence(
    body: CommandWithoutEvidence,
    context: LogContext,
    action: DeckRevealContext,
    after: GameState,
  ): Result<unknown> {
    const crypto = context.crypto;
    const look = knightsLook(after);
    if (!crypto || !look || look.actor !== body.seat)
      return failure('spy-context', 'The play does not open a Spy look');
    const request = { seq: body.headSeq, hash: body.headHash };
    const slots: unknown[] = [];
    for (const { deck, slot } of hiddenSlotsOf(crypto.decks, context.state, look.target)) {
      const deckId = deck.commitment.definition.deckId;
      let source: DeckSecretSource | null = null;
      try {
        source = this.newSource(deckId, body.seat);
        const secret = relockScalar(source, { deckId, slotId: slot.slotId, request });
        const seed = source.proofSeed('spy-request', { ...action, slotId: slot.slotId });
        try {
          slots.push(
            proveSpyRequest(slotHolder(slot), secret, seed, {
              action,
              deckId,
              slotId: slot.slotId,
            }),
          );
        } finally {
          seed.fill(0);
        }
      } catch {
        return failure('spy-request-proof', 'Could not derive the Spy request proof');
      } finally {
        source?.dispose();
      }
    }
    return success({ kind: 'spy-request', slots });
  }

  /** The target removes its own lock from each masked card, and nothing else. */
  private spyUnlockEvidence(
    body: CommandWithoutEvidence,
    context: LogContext,
    action: DeckRevealContext,
  ): Result<unknown> {
    const spy = context.crypto?.decks.spy;
    if (!context.crypto || !spy || spy.target !== body.seat)
      return failure('spy-unlock-state', 'No Spy look awaits this seat’s unlock');
    const slots: unknown[] = [];
    for (const requested of spy.slots) {
      const deck = context.crypto.decks.decks.find(
        (item) => item.commitment.definition.deckId === requested.deck,
      );
      const slot = deck?.slots.find((item) => item.slotId === requested.slotId);
      if (!deck || !slot) return failure('spy-unlock-state', 'A requested card is missing');
      let source: DeckSecretSource | null = null;
      try {
        const lock = this.holderLock(requested.deck, body.seat, slot);
        source = this.newSource(requested.deck, body.seat);
        const seed = source.proofSeed('spy-unlock', { ...action, slotId: requested.slotId });
        try {
          slots.push(
            proveSpyUnlock(
              slotHolder(slot),
              requested.masked,
              requested.slotId,
              spy.request,
              lock,
              seed,
              action,
            ),
          );
        } finally {
          seed.fill(0);
        }
      } catch {
        return failure('spy-unlock-proof', 'Could not derive the Spy unlock proof');
      } finally {
        source?.dispose();
      }
    }
    return success({ kind: 'spy-unlock', slots });
  }

  /** The target seals the exact opening of its hand to the Master Merchant. */
  private handShowEvidence(
    body: CommandWithoutEvidence,
    context: LogContext,
    input: Input,
    action: DeckRevealContext,
  ): Result<unknown> {
    const look = knightsLook(context.state);
    const actor = input.kind === 'system' ? input.to : undefined;
    const recipient = this.genesis.seats.find((item) => item.seat === actor)?.encryptionKey;
    const priv = this.privates.get(body.seat);
    const blindings = this.blindings.get(body.seat);
    if (
      !look ||
      look.what !== 'cards' ||
      look.target !== body.seat ||
      look.actor !== actor ||
      !recipient ||
      !priv ||
      !blindings
    )
      return failure('hand-show-state', 'No Master Merchant awaits this seat’s hand');
    const kinds = kindsOfCounts(context.state.bank);
    const plain = new Uint8Array(kinds.length * HAND_OPENING_ENTRY);
    for (const [index, kind] of kinds.entries()) {
      const count = priv.hand[kind];
      const blinding = blindings[kind];
      if (count === undefined || blinding === undefined || count > 255)
        return failure('hand-show-state', 'The owned hand cannot be opened');
      plain[index * HAND_OPENING_ENTRY] = count;
      plain.set(scalarToBytes(decodeScalar(blinding)), index * HAND_OPENING_ENTRY + 1);
    }
    const factory = this.stealRoutes.get(body.seat) ?? this.createStealSource;
    if (!factory) return failure('steal-source', 'No steal secret source is configured');
    let source: StealSecretSource | null = null;
    try {
      source = factory(body.seat);
      const seed = source.proofSeed('transfer', { protocol: 'hand-look-seed-v1', action });
      try {
        return success({
          kind: 'hand-opening',
          sealed: seal(plain, recipient, seed, handLookSealContext(action, look.actor, kinds)),
        });
      } finally {
        seed.fill(0);
      }
    } catch {
      return failure('hand-show-seal', 'Could not seal the hand opening');
    } finally {
      source?.dispose();
      plain.fill(0);
    }
  }

  /** The lock a seat chose for a card it took: derived from its master, so a restart finds it. */
  private relockSecret(deckId: string, seat: Seat, slot: LedgerSlot): bigint {
    if (!slot.relock) throw new RangeError('The slot was never re-locked');
    const source = this.newSource(deckId, seat);
    try {
      return relockScalar(source, { deckId, slotId: slot.slotId, request: slot.relock.request });
    } finally {
      source.dispose();
    }
  }

  private newSource(deckId: string, seat: Seat): DeckSecretSource {
    const source = (this.deckRoutes.get(seat) ?? this.createDeckSource)(deckId, seat);
    if (!source || typeof source.dispose !== 'function')
      throw new TypeError('Deck source factory returned an invalid source');
    return source;
  }
}

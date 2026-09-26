import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { DEV_CARD_COUNTS, RESOURCES, failure, success } from '@cp2p/engine';
import type {
  Engine,
  GameState,
  Input,
  PrivateState,
  Result,
  Seat,
  SystemInput,
} from '@cp2p/engine';
import { decodeDeckCard, proveDeckReveal } from './deck-draw.js';
import { DECK_REVEAL_PROTOCOL } from './deck-ledger.js';
import type { LogContext, ValidatedEntry } from './log.js';
import type { SessionDriver } from './p2p-session.js';
import type { DeckSecretSource, DeckSourceFactory } from './deck-source.js';
import type { CommandBody, Genesis, SystemEvidence } from './types.js';
import type { CertifiedEntry } from './proposal.js';
import { entryHash, genesisDigest } from './genesis.js';

type CommandWithoutEvidence = Omit<CommandBody, 'evidence'>;

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

function validOwnedState(state: GameState, priv: PrivateState): Result<void> {
  const holder = state.seats.find((item) => item.seat === priv.seat);
  if (!holder) return failure('verified-private-seat', 'Owned seat is missing from public state');
  let total = 0;
  for (const resource of RESOURCES) {
    const count = priv.hand[resource];
    const min = holder.resources.min[resource] ?? 0;
    const max = holder.resources.max[resource] ?? 0;
    if (count === undefined || !Number.isSafeInteger(count) || count < min || count > max)
      return failure('verified-private-bounds', 'Owned resources are outside public bounds');
    total += count;
  }
  if (total !== holder.resources.total)
    return failure('verified-private-total', 'Owned resource total differs from public count');

  const publicSlots = new Map(holder.cardSlots.map((slot) => [slot.slotId, slot]));
  for (const [slotId, card] of Object.entries(priv.slots)) {
    const slot = publicSlots.get(slotId);
    if (!slot || slot.revealed !== undefined || !Object.hasOwn(DEV_CARD_COUNTS, card))
      return failure('verified-private-slots', 'Owned hidden card does not match a public slot');
  }
  for (const slot of holder.cardSlots)
    if (slot.revealed === undefined && !Object.hasOwn(priv.slots, slot.slotId))
      return failure('verified-private-slots', 'Owned private cards differ from public slots');
  return success(undefined);
}

/** Local verified-session private state. Only supplied seats are ever retained. */
export class VerifiedSessionDriver implements SessionDriver {
  private readonly digest: string;
  private readonly owned = new Set<Seat>();
  private privates = new Map<Seat, PrivateState>();
  private appliedHead: string | null = null;
  private disposed = false;

  constructor(
    private readonly engine: Engine,
    private readonly genesis: Genesis,
    ownedSeats: readonly Seat[],
    private readonly createDeckSource: DeckSourceFactory,
  ) {
    if (genesis.security !== 'verified')
      throw new TypeError('Verified session driver requires verified genesis');
    this.digest = genesisDigest(genesis);
    if (ownedSeats.length === 0 || new Set(ownedSeats).size !== ownedSeats.length)
      throw new RangeError('At least one unique owned seat is required');
    const configured = new Set(genesis.config.seats);
    for (const seat of ownedSeats) {
      if (!configured.has(seat)) throw new RangeError('Owned seat is not configured in genesis');
      this.owned.add(seat);
      this.privates.set(seat, engine.createPrivateState(seat));
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

  /** Attach proof material before the caller signs this exact command body. */
  prepareCommand(
    body: CommandWithoutEvidence,
    context: LogContext,
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
    const ids =
      body.command.type === 'PLAY_DEV_CARD'
        ? [body.command.slotId]
        : body.command.type === 'CLAIM_VICTORY'
          ? body.command.slotIds
          : null;
    if (ids === null) return success(undefined);
    if (!Array.isArray(ids) || ids.length === 0)
      return failure('deck-reveal-slots', 'Command has invalid reveal slots');
    const revealSlots: string[] = [];
    for (const id of ids) {
      if (typeof id !== 'string')
        return failure('deck-reveal-slots', 'Command has invalid reveal slots');
      revealSlots.push(id);
    }
    if (new Set(revealSlots).size !== revealSlots.length)
      return failure('deck-reveal-slots', 'Command has duplicate reveal slots');
    const crypto = context.crypto;
    if (!crypto)
      return failure('crypto-context-required', 'Verified reveal needs replayed deck state');

    const data: {
      slotId: string;
      identity: string;
      proof: ReturnType<typeof proveDeckReveal>['proof'];
    }[] = [];
    for (const slotId of revealSlots) {
      const deck = crypto.decks.decks.find((item) =>
        item.slots.some((slot) => slot.slotId === slotId),
      );
      const slot = deck?.slots.find((item) => item.slotId === slotId);
      if (!deck || !slot)
        return failure('deck-reveal-owner', 'Reveal slot has no hidden deck receipt');
      if (slot.seat !== body.seat)
        return failure('deck-reveal-owner', 'Reveal slot is not owned by this seat');
      const publicSlot = context.state.seats
        .find((candidate) => candidate.seat === body.seat)
        ?.cardSlots.find((candidate) => candidate.slotId === slotId);
      if (
        !publicSlot ||
        publicSlot.revealed !== undefined ||
        publicSlot.deck !== deck.commitment.definition.deckId
      )
        return failure('deck-reveal-owner', 'Reveal slot is not an owned hidden public card');
      let source: DeckSecretSource | null = null;
      try {
        source = this.newSource(deck.commitment.definition.deckId, body.seat);
        const lock = source.lock(slot.receipt.operation.position);
        const decoded = decodeDeckCard(deck.setup, slot.receipt, lock);
        if (!decoded.ok) return decoded;
        if (
          (body.command.type === 'PLAY_DEV_CARD' && decoded.value.card !== body.command.card) ||
          (body.command.type === 'CLAIM_VICTORY' && decoded.value.card !== 'victoryPoint')
        )
          return failure('deck-reveal-kind', 'Owned card does not match the requested command');
        const revealContext = {
          genesisDigest: body.genesisDigest,
          epoch: crypto.epoch,
          anchor: { seq: body.headSeq, hash: body.headHash },
          seat: body.seat,
          nonce: body.nonce,
          command: body.command,
        };
        const seed = source.proofSeed('reveal', { ...revealContext, slotId });
        try {
          const reveal = proveDeckReveal(
            deck.setup,
            slot.receipt,
            decoded.value.identity,
            lock,
            seed,
            revealContext,
          );
          data.push({ slotId, ...reveal });
        } finally {
          seed.fill(0);
        }
      } catch {
        return failure('deck-reveal-proof', 'Could not derive the owned card reveal proof');
      } finally {
        source?.dispose();
      }
    }
    return success({ protocol: DECK_REVEAL_PROTOCOL, data });
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
    const input = entry.input;
    if (!input) {
      this.appliedHead = entryHash(after.head);
      return success(undefined);
    }

    const privateData: Partial<Record<Seat, { card?: string }>> = {};
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

    if (input.kind === 'system' && input.type === 'STEAL_RESULT' && input.resource === 'hidden') {
      const thief = this.genesis.config.seats.find((seat) => seat === input.thief);
      const victim = this.genesis.config.seats.find((seat) => seat === input.victim);
      if (
        thief === undefined ||
        victim === undefined ||
        this.owned.has(thief) ||
        this.owned.has(victim)
      )
        return failure(
          'verified-hidden-steal',
          'Hidden transfer private result is not implemented',
        );
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
    this.privates = next;
    this.appliedHead = entryHash(after.head);
    return success(undefined);
  }

  committed(_before: LogContext, _input: Input, _after: GameState): Result<void> {
    return failure('verified-entry-context', 'Verified driver requires certified entry callbacks');
  }

  dispose(): void {
    this.disposed = true;
    this.privates.clear();
    this.owned.clear();
  }

  private newSource(deckId: string, seat: Seat): DeckSecretSource {
    const source = this.createDeckSource(deckId, seat);
    if (!source || typeof source.dispose !== 'function')
      throw new TypeError('Deck source factory returned an invalid source');
    return source;
  }
}

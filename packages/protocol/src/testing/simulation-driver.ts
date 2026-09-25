import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { DEV_CARD_COUNTS, RESOURCES, failure, success } from '@cp2p/engine';
import type {
  Engine,
  GameState,
  Input,
  LocalRandomAnswer,
  Pending,
  PrivateState,
  Resource,
  Result,
  Seat,
} from '@cp2p/engine';
import { createRng } from '@cp2p/engine/rng';
import { entryHash, genesisDigest } from '../genesis.js';
import { stubEvidence } from '../log.js';
import type { LogContext } from '../log.js';
import type { Genesis } from '../types.js';
import type { ProtocolClock } from '../transport.js';
import type { SessionTimer } from '../session-types.js';
import { timerKey } from '../session-timing.js';

type SystemPending = Extract<Pending, { kind: 'random' | 'reveal' }>;

function copyPrivate(value: PrivateState): PrivateState {
  return {
    seat: value.seat,
    hand: { ...value.hand },
    slots: { ...value.slots },
    ext: Object.fromEntries(
      Object.entries(value.ext).map(([key, item]) => [key, canonicalDecode(canonicalEncode(item))]),
    ),
  };
}

/**
 * Explicitly omniscient simulation driver. Never use with a verified genesis.
 * Peers derive the same stub answer from the committed parent, so retries and
 * proposer changes cannot consume different random streams or private cards.
 */
export class SimulationDriver {
  private privates: Map<Seat, PrivateState>;
  /** Dealt identities outlive the playable private slots consumed by dev-card actions. */
  private readonly dealtCards = new Map<string, { seat: Seat; card: string }>();
  private readonly digest: string;
  private readonly timers = new Map<string, { seat: Seat; phase: string; expiresAt: number }>();

  constructor(
    private readonly engine: Engine,
    genesis: Genesis,
    private readonly clock?: ProtocolClock,
  ) {
    if (genesis.security !== 'stub') throw new Error('Simulation driver requires stub genesis');
    this.digest = genesisDigest(genesis);
    this.privates = new Map(
      genesis.config.seats.map((seat) => [seat, engine.createPrivateState(seat)]),
    );
  }

  privateState(seat: Seat): PrivateState | null {
    const state = this.privates.get(seat);
    return state ? copyPrivate(state) : null;
  }

  getTimers(): readonly SessionTimer[] {
    const now = this.clock?.now() ?? 0;
    return [...this.timers].map(([key, timer]) => ({
      key,
      ...timer,
      paused: false,
      remainingMs: Math.max(0, timer.expiresAt - now),
    }));
  }

  /** Calling this never advances private state or consumes randomness. */
  next(context: LogContext) {
    if (genesisDigest(context.genesis) !== this.digest || context.genesis.security !== 'stub')
      throw new Error('Simulation context does not match its genesis');
    this.refreshTimers(context.state);
    if (context.state.result) return null;
    const expired = this.getTimers().find((timer) => timer.remainingMs === 0);
    if (expired) {
      const input = {
        kind: 'system' as const,
        type: 'TIMEOUT',
        seat: expired.seat,
        phase: expired.phase,
      };
      return { input, evidence: stubEvidence(context, input) };
    }
    const automatic = this.engine.getAutomaticInput(context.state, this.privates);
    if (automatic?.kind === 'system')
      return { input: automatic, evidence: stubEvidence(context, automatic) };
    const pending = this.engine
      .getPending(context.state)
      .find((item) => item.kind === 'random' || item.kind === 'reveal');
    if (!pending) return null;
    const { input } = this.answer(context, pending);
    return { input, evidence: stubEvidence(context, input) };
  }

  /** Apply private consequences only after the public entry is certified and persisted. */
  committed(before: LogContext, input: Input, after: GameState): Result<void> {
    let privateData: LocalRandomAnswer['privateData'];
    let dealt: { slotId: string; seat: Seat; card: string } | null = null;
    if (
      input.kind === 'system' &&
      (input.type === 'CARD_DEALT' ||
        (input.type === 'STEAL_RESULT' && input.resource === 'hidden'))
    ) {
      const pending = this.engine
        .getPending(before.state)
        .find((item) => item.kind !== 'player' && item.systemType === input.type);
      if (!pending || pending.kind === 'player')
        return failure('simulation-pending', 'Private result has no matching request');
      const expected = this.answer(before, pending);
      if (toHex(hashValue(expected.input)) !== toHex(hashValue(input)))
        return failure(
          'simulation-answer',
          'Committed private result differs from the simulation answer',
        );
      privateData = expected.privateData;
      if (input.type === 'CARD_DEALT') {
        const seat = before.state.config.seats.find((candidate) => candidate === input.seat);
        const slotId = input.slotId;
        if (seat === undefined || typeof slotId !== 'string')
          return failure('simulation-deck', 'Committed draw has no valid seat or slot');
        const card = privateData?.[seat]?.card;
        if (
          typeof card !== 'string' ||
          !Object.hasOwn(DEV_CARD_COUNTS, card) ||
          this.dealtCards.has(slotId)
        )
          return failure('simulation-deck', 'Committed draw has no unique private card identity');
        const beforeDeck = before.state.decks.dev;
        const afterDeck = after.decks.dev;
        const appended = afterDeck?.drawn.at(-1);
        if (
          !beforeDeck ||
          !afterDeck ||
          afterDeck.drawn.length !== beforeDeck.drawn.length + 1 ||
          !appended ||
          appended.seat !== seat ||
          appended.slotId !== slotId ||
          afterDeck.remaining !== beforeDeck.remaining - 1
        )
          return failure(
            'simulation-deck',
            'Committed draw did not advance the public deck exactly once',
          );
        dealt = { slotId, seat, card };
      }
    }
    const applied = this.engine.applyAllPrivates(this.privates, before.state, input, privateData);
    if (!applied.ok) return applied;
    for (const holder of after.seats) {
      const owned = applied.value.get(holder.seat);
      if (!owned) return failure('simulation-private', 'Private seat is missing');
      let total = 0;
      for (const resource of RESOURCES) {
        const count = owned.hand[resource];
        const min = holder.resources.min[resource] ?? 0;
        const max = holder.resources.max[resource] ?? 0;
        if (count === undefined || !Number.isSafeInteger(count) || count < min || count > max)
          return failure('simulation-private', 'Private resources are outside public bounds');
        total += count;
      }
      if (total !== holder.resources.total)
        return failure('simulation-private', 'Private resource total differs from public count');
    }
    const violations = this.engine.checkPrivateInvariants(after, applied.value);
    if (violations.length) return failure('simulation-private', violations.join('; '));
    this.privates = applied.value;
    if (dealt) this.dealtCards.set(dealt.slotId, { seat: dealt.seat, card: dealt.card });
    this.refreshTimers(after);
    return success(undefined);
  }

  private refreshTimers(state: GameState): void {
    if (!this.clock) return;
    const active = new Set<string>();
    for (const pending of this.engine.getPending(state)) {
      if (pending.kind !== 'player' || !pending.deadline) continue;
      const key = timerKey(state, pending);
      if (!key) continue;
      active.add(key);
      if (!this.timers.has(key))
        this.timers.set(key, {
          seat: pending.seat,
          phase: pending.deadline.phase,
          expiresAt: this.clock.now() + pending.deadline.seconds * 1000,
        });
    }
    for (const key of this.timers.keys()) if (!active.has(key)) this.timers.delete(key);
  }

  private answer(context: LogContext, pending: SystemPending): LocalRandomAnswer {
    const state = context.state;
    const rng = createRng(hashValue(['cp2p-simulation', this.digest, entryHash(context.head)]));
    const seat = (value: unknown): Seat => {
      const found = state.config.seats.find((item) => item === value);
      if (found === undefined) throw new Error('Unknown simulation seat');
      return found;
    };
    switch (pending.systemType) {
      case 'START_SEAT':
        return {
          input: { kind: 'system', type: 'START_SEAT', seat: rng.pick(state.config.seats) },
        };
      case 'DICE_RESULT': {
        if (pending.request.mode === 'balanced') {
          const base = state.ext.base;
          const deck: unknown =
            typeof base === 'object' && base !== null ? Reflect.get(base, 'diceDeck') : null;
          if (
            !Array.isArray(deck) ||
            !deck.every(
              (card): card is number =>
                typeof card === 'number' && Number.isSafeInteger(card) && card >= 0 && card < 36,
            )
          )
            throw new Error('Malformed balanced dice deck');
          const index = rng.int(deck.length);
          const card = deck[index];
          if (card === undefined) throw new Error('Empty balanced dice deck');
          return {
            input: {
              kind: 'system',
              type: 'DICE_RESULT',
              index,
              dice: [Math.floor(card / 6) + 1, (card % 6) + 1],
            },
          };
        }
        return {
          input: { kind: 'system', type: 'DICE_RESULT', dice: [rng.int(6) + 1, rng.int(6) + 1] },
        };
      }
      case 'CARD_DEALT': {
        const owner = seat(pending.request.seat);
        const slotId = pending.request.slotId;
        if (typeof slotId !== 'string') throw new Error('Draw request has no slot');
        const remaining = new Map<string, number>(Object.entries(DEV_CARD_COUNTS));
        const deck = state.decks.dev;
        if (!deck) throw new Error('Development deck missing');
        if (this.dealtCards.size !== deck.drawn.length)
          throw new Error('Private deck history differs from public draw count');
        const seen = new Set<string>();
        for (const ref of deck.drawn) {
          const owned = this.dealtCards.get(ref.slotId);
          const count = owned ? remaining.get(owned.card) : undefined;
          if (
            !owned ||
            seen.has(ref.slotId) ||
            owned.seat !== ref.seat ||
            count === undefined ||
            count < 1
          )
            throw new Error('Private deck history is invalid');
          seen.add(ref.slotId);
          remaining.set(owned.card, count - 1);
        }
        const cards = [...remaining].flatMap(([card, count]) => Array<string>(count).fill(card));
        if (cards.length !== deck.remaining) throw new Error('Development deck count differs');
        return {
          input: { kind: 'system', type: 'CARD_DEALT', deck: 'dev', seat: owner, slotId },
          privateData: { [owner]: { card: rng.pick(cards) } },
        };
      }
      case 'STEAL_RESULT': {
        const thief = seat(pending.request.thief);
        const victim = seat(pending.request.victim);
        const hand = this.privates.get(victim)?.hand;
        if (!hand) throw new Error('Victim hand missing');
        const cards = RESOURCES.flatMap((resource) =>
          Array<Resource>(hand[resource] ?? 0).fill(resource),
        );
        const resource = rng.pick(cards);
        return {
          input: { kind: 'system', type: 'STEAL_RESULT', thief, victim, resource: 'hidden' },
          privateData: { [thief]: { resource }, [victim]: { resource } },
        };
      }
      case 'REVEAL_COUNT': {
        if (pending.kind !== 'reveal') throw new Error('Reveal has no owner');
        const resource = RESOURCES.find((item) => item === pending.request.resource);
        const hand = this.privates.get(pending.seat)?.hand;
        if (!resource || !hand) throw new Error('Reveal hand or resource missing');
        return {
          input: {
            kind: 'system',
            type: 'REVEAL_COUNT',
            seat: pending.seat,
            resource,
            count: hand[resource] ?? 0,
          },
        };
      }
      default:
        throw new Error(`Unsupported simulation request ${pending.systemType}`);
    }
  }
}

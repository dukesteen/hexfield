import type { Engine, GameState, PrivateState, Seat } from '@cp2p/engine';
import { decksFor, devCardCountsFor } from '@cp2p/engine';
import { handBelief, sampleHand } from '../eval/index.js';
import type { BotRng, BotView } from '../types.js';

/** One sampled world consistent with everything the bot knows. */
export interface World {
  state: GameState;
  privates: Map<Seat, PrivateState>;
  /** The development deck, top card last. */
  devDeck: string[];
  /** Every other deck (progress cards, fog tiles and tokens), top card last. */
  decks: Map<string, string[]>;
}

function shuffle<T>(items: T[], rng: BotRng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const a = items[i];
    const b = items[j];
    if (a === undefined || b === undefined) continue;
    items[i] = b;
    items[j] = a;
  }
  return items;
}

function cardsOf(counts: Readonly<Record<string, number>>): string[] {
  return Object.entries(counts).flatMap(([card, count]) =>
    Array<string>(Math.max(0, count)).fill(card),
  );
}

/**
 * The module decks (every deck but the development deck): a private deck's unseen cards (its
 * composition less the cards held and known to the bot and the cards played) are dealt to the
 * opponents' unknown slots, and the rest, shuffled, form the deck; a public deck (fog) is
 * sampled from its composition. Base games have none, so they draw nothing from `rng` here.
 */
function sampleModuleDecks(
  state: GameState,
  priv: PrivateState,
  privates: Map<Seat, PrivateState>,
  rng: BotRng,
): Map<string, string[]> {
  const decks = new Map<string, string[]>();
  for (const [id, spec] of Object.entries(decksFor(state.config))) {
    if (id === 'dev') continue;
    const counts: Record<string, number> = { ...spec.cards };
    const unknown: { seat: Seat; slotId: string }[] = [];
    if (spec.reveal !== 'public')
      for (const holder of state.seats)
        for (const slot of holder.cardSlots) {
          if (slot.deck !== id) continue;
          const known =
            slot.revealed ??
            slot.known ??
            (holder.seat === priv.seat ? priv.slots[slot.slotId] : undefined);
          if (known !== undefined) counts[known] = (counts[known] ?? 0) - 1;
          else unknown.push({ seat: holder.seat, slotId: slot.slotId });
        }
    const pool = shuffle(cardsOf(counts), rng);
    for (const { seat, slotId } of unknown) {
      const card = pool.pop();
      const holder = privates.get(seat);
      if (card === undefined || !holder) continue;
      privates.set(seat, { ...holder, slots: { ...holder.slots, [slotId]: card } });
    }
    decks.set(id, pool.slice(0, state.decks[id]?.remaining ?? pool.length));
  }
  return decks;
}

/**
 * Sample the hidden parts of the game from the bot's view: each opponent's hand (consistent with its
 * public bounds, see `handBelief`), the identity of each opponent's unplayed development card (from
 * the cards not yet seen), the order of the development deck, and (with `modules`) the module
 * decks and the opponents' progress cards. The bot's own hand and cards are its real ones. The
 * public state is shared, never copied or changed.
 */
export function determinize(view: BotView, engine: Engine, rng: BotRng, modules = false): World {
  const { state, priv, seat } = view;
  const unseen: string[] = [];
  const counts: Record<string, number> = { ...devCardCountsFor(state.config) };
  for (const holder of state.seats)
    for (const slot of holder.cardSlots)
      if (slot.deck === 'dev') {
        const known =
          slot.revealed ??
          slot.known ??
          (holder.seat === seat ? priv.slots[slot.slotId] : undefined);
        if (known !== undefined) counts[known] = (counts[known] ?? 0) - 1;
      }
  for (const [card, count] of Object.entries(counts))
    for (let n = 0; n < count; n++) unseen.push(card);
  shuffle(unseen, rng);
  const privates = new Map<Seat, PrivateState>();
  for (const holder of state.seats) {
    if (holder.seat === seat) {
      privates.set(seat, priv);
      continue;
    }
    const base = engine.createPrivateState(holder.seat, state.config);
    const slots: Record<string, string> = {};
    for (const slot of holder.cardSlots) {
      if (slot.deck !== 'dev' || slot.revealed !== undefined) continue;
      const card = slot.known ?? unseen.pop();
      if (card !== undefined) slots[slot.slotId] = card;
    }
    const hand = { ...base.hand, ...sampleHand(handBelief(state, holder.seat), rng) };
    privates.set(holder.seat, { ...base, hand, slots });
  }
  const decks = modules
    ? sampleModuleDecks(state, priv, privates, rng)
    : new Map<string, string[]>();
  return {
    state,
    privates,
    devDeck: unseen.slice(0, state.decks.dev?.remaining ?? 0),
    decks,
  };
}

/** A copy of a world whose decks a rollout may draw from. */
export function copyWorld(world: World): World {
  return {
    ...world,
    devDeck: [...world.devDeck],
    decks: new Map([...world.decks].map(([id, cards]) => [id, [...cards]])),
  };
}

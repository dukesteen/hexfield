import type { Engine, GameState, PrivateState, Seat } from '@cp2p/engine';
import { devCardCountsFor } from '@cp2p/engine';
import { handBelief, sampleHand } from '../eval/index.js';
import type { BotRng, BotView } from '../types.js';

/** One sampled world consistent with everything the bot knows. */
export interface World {
  state: GameState;
  privates: Map<Seat, PrivateState>;
  /** The development deck, top card last. */
  devDeck: string[];
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

/**
 * Sample the hidden parts of the game from the bot's view: each opponent's hand (consistent with its
 * public bounds, see `handBelief`), the identity of each opponent's unplayed development card (from
 * the cards not yet seen), and the order of the development deck. The bot's own hand and cards are
 * its real ones. The public state is shared, never copied or changed.
 */
export function determinize(view: BotView, engine: Engine, rng: BotRng): World {
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
  return { state, privates, devDeck: unseen.slice(0, state.decks.dev?.remaining ?? 0) };
}

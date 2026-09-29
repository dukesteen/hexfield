import type { CardKind, Seat } from '../types/index.js';

export type ResourceEndpoint = { kind: 'bank' } | { kind: 'seat'; seat: Seat };

/** Ordered accounting facts produced by the same handler that changes public state. */
export type EngineEffect =
  | {
      type: 'resource-transfer';
      from: ResourceEndpoint;
      to: ResourceEndpoint;
      resource: CardKind;
      count: number;
    }
  | { type: 'resource-count-revealed'; seat: Seat; resource: CardKind; count: number }
  | { type: 'hidden-resource-transfer'; from: Seat; to: Seat; count: 1 }
  | { type: 'card-slot-dealt'; seat: Seat; deck: string; slotId: string }
  /** A public draw: the deck advances one position and the card is shown to every seat. */
  | { type: 'deck-card-shown'; seat: Seat; deck: string; slotId: string; card: string }
  | { type: 'card-slot-revealed'; seat: Seat; deck: string; slotId: string; card: string }
  /**
   * A card whose identity is public was dealt to a seat from a module's own queue (a played card
   * returned under its deck). No deck position is used, and the new slot carries `known: card`.
   */
  | { type: 'card-slot-known'; seat: Seat; deck: string; slotId: string; card: string }
  /** An unrevealed slot changed hands (the Spy takes a progress card). Its identity moves with it. */
  | { type: 'card-slot-moved'; from: Seat; to: Seat; deck: string; slotId: string };

import type { Resource, Seat } from '../types/index.js';

export type ResourceEndpoint = { kind: 'bank' } | { kind: 'seat'; seat: Seat };

/** Ordered accounting facts produced by the same handler that changes public state. */
export type EngineEffect =
  | {
      type: 'resource-transfer';
      from: ResourceEndpoint;
      to: ResourceEndpoint;
      resource: Resource;
      count: number;
    }
  | { type: 'resource-count-revealed'; seat: Seat; resource: Resource; count: number }
  | { type: 'hidden-resource-transfer'; from: Seat; to: Seat; count: 1 }
  | { type: 'card-slot-dealt'; seat: Seat; deck: string; slotId: string }
  /** A public draw: the deck advances one position and the card is shown to every seat. */
  | { type: 'deck-card-shown'; seat: Seat; deck: string; slotId: string; card: string }
  | { type: 'card-slot-revealed'; seat: Seat; deck: string; slotId: string; card: string };

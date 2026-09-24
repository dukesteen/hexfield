import type { ResourceBounds } from '../resources/index.js';
import type { Seat } from '../types/index.js';

export type ModuleId = string;
export type SlotId = string;
export type CardIdentity = string;

export interface ModuleSelection {
  id: ModuleId;
  version: string;
}

/** Frozen genesis choices. Module ids and versions are part of the public log. */
export interface GameConfig {
  modules: ModuleSelection[];
  seats: Seat[];
  options: Record<ModuleId, unknown>;
  board?: BoardState;
}

export interface BoardHex {
  id: string;
  q: number;
  r: number;
  terrain: string;
  token: number | null;
}

export interface HarborState {
  edge: string;
  kind: string;
}

export interface RoadPiece {
  edge: string;
  seat: Seat;
}

export interface BuildingPiece {
  vertex: string;
  seat: Seat;
  kind: string;
}

/** Only JSON data belongs here. A BoardGraph is rebuilt from hex coordinates. */
export interface BoardState {
  hexes: BoardHex[];
  harbors: HarborState[];
  roads: RoadPiece[];
  buildings: BuildingPiece[];
  robberHex: string | null;
}

export interface CardSlot {
  slotId: SlotId;
  deck: string;
  acquiredTurn: number;
  revealed?: CardIdentity;
}

export interface SeatState {
  seat: Seat;
  resources: ResourceBounds;
  piecesLeft: Record<string, number>;
  cardSlots: CardSlot[];
  publicVp: number;
  status: 'active' | 'departed' | 'bot';
}

export interface SlotRef {
  slotId: SlotId;
  seat: Seat;
}

export interface DeckPublic {
  remaining: number;
  drawn: SlotRef[];
}

export interface PhaseFrame {
  id: string;
  module: ModuleId;
  data: unknown;
}

export interface TurnState {
  number: number;
  activeSeat: Seat;
  phase: PhaseFrame[];
}

export interface GameState {
  schema: 1;
  engineVersion: string;
  config: GameConfig;
  board: BoardState;
  seats: SeatState[];
  bank: Record<string, number>;
  decks: Record<string, DeckPublic>;
  turn: TurnState;
  awards: Record<string, Seat | null>;
  counters: { nextOfferId: number; nextSlotId: number; inputSeq: number };
  ext: Record<ModuleId, unknown>;
  result: null | { winner: Seat; reason: string; atTurn: number };
}

/** Each owner holds this state locally. It is never copied into GameState. */
export interface PrivateState {
  seat: Seat;
  hand: Record<string, number>;
  slots: Record<SlotId, CardIdentity>;
  ext: Record<ModuleId, unknown>;
}

export interface PublicView {
  viewer: Seat | 'spectator';
  state: GameState;
}

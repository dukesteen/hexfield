import type { GameState } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import { KNIGHTS_ID } from './config.js';
import type { Track } from './config.js';

/** One seat's level (0 to 5) on each improvement track. */
export type TrackLevels = Record<Track, number>;

/** The city that carries a track's metropolis. */
export interface MetropolisHolder {
  seat: Seat;
  vertex: string;
}

/** A city wall under one of its owner's cities. */
export interface WallPiece {
  seat: Seat;
  vertex: string;
}

/** A knight on the board. Its level is 1 (basic), 2 (strong) or 3 (mighty). */
export interface KnightPiece {
  seat: Seat;
  vertex: string;
  level: number;
  active: boolean;
  /** Active when its owner's turn began and not acted since: the only knights that may act. */
  ready: boolean;
  /** The turn a promotion last happened on, so a knight is promoted once per turn. */
  promotedTurn: number | null;
}

/** A city piece lying on its side: a settlement on the board that still uses a city piece. */
export interface SidewaysPiece {
  seat: Seat;
  vertex: string;
}

/** What the last barbarian attack found and did, kept for logs and the UI. */
export interface AttackReport {
  turn: number;
  /** Cities on the board. */
  strength: number;
  /** Levels of all active knights. */
  defense: number;
  /** Active knight levels per seat. */
  contributions: number[];
  outcome: 'defended' | 'pillaged';
  /** The seat that took a Defender of Catan card, if any. */
  defender: Seat | null;
  /** Seats that tied for the top contribution (each is owed a progress card, from K5 on). */
  tied: Seat[];
  /** Cities lost so far; a seat that still has to choose is added when it does. */
  pillaged: { seat: Seat; vertex: string; sideways: boolean }[];
}

/** Public state under `ext.knights`. Arrays are indexed by seat. */
export interface KnightsExt {
  /** True until the first barbarian attack: the robber cannot move and nothing is stolen. */
  robberLocked: boolean;
  /** Barbarian ship faces since the last attack (0 to 7). Moved by K4. */
  barbarians: { step: number };
  /** Improvement levels per seat. */
  improvements: TrackLevels[];
  /** The metropolis of each track, or null until someone reaches level 4. */
  metropolises: Record<Track, MetropolisHolder | null>;
  /** City walls on the board. Each adds 2 to its owner's hand limit. */
  walls: WallPiece[];
  /** Knights on the board, ordered by vertex id. */
  knights: KnightPiece[];
  /** Pillaged cities lying on their side; they must be upgraded before any other settlement. */
  sideways: SidewaysPiece[];
  /** Defender of Catan cards per seat, one point each. */
  defenders: number[];
  /** The last attack, or null before the first. */
  lastAttack: AttackReport | null;
  /** The last event die face rolled, or null before the first roll. */
  eventDie: string | null;
  /** Seats with an Aqueduct that received no card on the roll being resolved. Empty at rest. */
  noProduction: Seat[];
}

/** Data of the `aqueduct` frame: the seats still to take a card, in order. */
export interface AqueductFrameData {
  queue: Seat[];
}

/** Data of the `displaced` frame: a knight in the owner's hand until it lands on a vertex. */
export interface DisplacedFrameData {
  /** The owner, who chooses where it goes. */
  seat: Seat;
  /** The vertex it stood on, where its own roads lead from. */
  origin: string;
  level: number;
  active: boolean;
  ready: boolean;
  promotedTurn: number | null;
}

/** Data of the `pillage` frame: seats that must still choose a city, and the roll held back. */
export interface PillageFrameData {
  remaining: Seat[];
  roll: number;
}

/** Data of the `metropolis` frame: the seat that must choose a city, and the track. */
export interface MetropolisFrameData {
  seat: Seat;
  track: Track;
}

export function knightsExt(state: GameState): KnightsExt {
  const value = state.ext[KNIGHTS_ID];
  if (typeof value !== 'object' || value === null) throw new Error('Missing knights state');
  // Module genesis and handlers own this extension slot.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as KnightsExt;
}

export function updateKnights(
  state: GameState,
  change: (old: KnightsExt) => KnightsExt,
): GameState {
  return { ...state, ext: { ...state.ext, [KNIGHTS_ID]: change(knightsExt(state)) } };
}

/** A seat's improvement level on a track. */
export function levelOf(state: GameState, seat: Seat, track: Track): number {
  return knightsExt(state).improvements[seat]?.[track] ?? 0;
}

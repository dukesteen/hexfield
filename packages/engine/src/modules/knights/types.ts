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
  /** City walls on the board (built by K3). Each adds 2 to its owner's hand limit. */
  walls: WallPiece[];
  /** The last event die face rolled, or null before the first roll. */
  eventDie: string | null;
  /** Seats with an Aqueduct that received no card on the roll being resolved. Empty at rest. */
  noProduction: Seat[];
}

/** Data of the `aqueduct` frame: the seats still to take a card, in order. */
export interface AqueductFrameData {
  queue: Seat[];
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

import {
  ABILITY_LEVEL,
  BARBARIAN_STEPS,
  COMMODITIES,
  HAND_LIMIT,
  KNIGHTS_ID,
  MAX_LEVEL,
  RESOURCES,
  TRACKS,
  TRACK_COMMODITY,
  VICTORY_CARDS,
  barbarianStrength,
  trackOfDeck,
  contributions,
  knightsExt,
} from '@cp2p/engine';
import type {
  AttackReport,
  GameState,
  KnightPiece,
  KnightsExt,
  PrivateState,
  Seat,
  Track,
} from '@cp2p/engine';

export type { Track };
export {
  ABILITY_LEVEL,
  BARBARIAN_STEPS,
  COMMODITIES,
  HAND_LIMIT,
  MAX_LEVEL,
  TRACKS,
  TRACK_COMMODITY,
};

/** The commodity card kinds, typed for the art helpers. */
export type CommodityKind = 'paper' | 'cloth' | 'coin';
export const COMMODITY_KINDS: readonly CommodityKind[] = ['cloth', 'coin', 'paper'];

export function isCommodity(kind: string): kind is CommodityKind {
  return kind === 'paper' || kind === 'cloth' || kind === 'coin';
}

/** True when the game uses the Cities & Knights module. */
export function isKnights(state: Readonly<GameState>): boolean {
  return state.config.modules.some((module) => module.id === KNIGHTS_ID);
}

/** The module's public state, or null in a game without it. */
export function knightsState(state: Readonly<GameState>): KnightsExt | null {
  // The engine reads its own slot; the copy is never written through.
  return isKnights(state) ? knightsExt(state) : null;
}

/** A seat's knights points: metropolises (two each), Defender cards, the merchant and shown Printer or Constitution cards. */
export function knightsVictoryPoints(state: Readonly<GameState>, seat: Seat): number {
  const ext = knightsState(state);
  if (!ext) return 0;
  const metropolises = TRACKS.filter((track) => ext.metropolises[track]?.seat === seat).length;
  const merchant = ext.merchant?.seat === seat ? 1 : 0;
  const shown =
    state.seats
      .find((item) => item.seat === seat)
      ?.cardSlots.filter(
        (slot) => slot.revealed !== undefined && Object.hasOwn(VICTORY_CARDS, slot.revealed),
      ).length ?? 0;
  return metropolises * 2 + (ext.defenders[seat] ?? 0) + merchant + shown;
}

/** A knight's strength as one of the three levels the art has. */
export function knightLevel(value: number): 1 | 2 | 3 {
  return value >= 3 ? 3 : value === 2 ? 2 : 1;
}

/** Every card kind a seat may hold: the five resources, plus the commodities in a knights game. */
export function cardKinds(state: Readonly<GameState>): readonly string[] {
  return isKnights(state) ? [...RESOURCES, ...COMMODITY_KINDS] : RESOURCES;
}

/** Improvement level of a seat on a track. */
export function levelOn(ext: KnightsExt, seat: Seat, track: Track): number {
  return ext.improvements[seat]?.[track] ?? 0;
}

/** The knights of a seat, strongest first, ordered by vertex for a stable list. */
export function knightsOfSeat(ext: KnightsExt, seat: Seat): KnightPiece[] {
  return ext.knights
    .filter((knight) => knight.seat === seat)
    .toSorted((a, b) => b.level - a.level || (a.vertex < b.vertex ? -1 : 1));
}

/** Defender points and metropolis levels are public; these are the seat's knight counts. */
export function knightSummary(
  ext: KnightsExt,
  seat: Seat,
): { total: number; active: number; strength: number; activeStrength: number } {
  const own = ext.knights.filter((knight) => knight.seat === seat);
  return {
    total: own.length,
    active: own.filter((knight) => knight.active).length,
    strength: own.reduce((sum, knight) => sum + knight.level, 0),
    activeStrength: own
      .filter((knight) => knight.active)
      .reduce((sum, knight) => sum + knight.level, 0),
  };
}

/** How many ship faces are left before the barbarians land. */
export function stepsToLanding(ext: KnightsExt): number {
  return Math.max(0, BARBARIAN_STEPS - ext.barbarians.step);
}

export interface BarbarianOdds {
  /** Cities on the board, which is the barbarians' strength. */
  readonly strength: number;
  /** The levels of every active knight on the board. */
  readonly defense: number;
  /** Each seat's share of the defense, by seat. */
  readonly bySeat: readonly { readonly seat: Seat; readonly level: number }[];
  readonly holds: boolean;
}

/** The fight if the barbarians landed now. */
export function barbarianOdds(state: Readonly<GameState>): BarbarianOdds {
  // The engine helpers take the full state and only read it.
  const full = state as GameState;
  const strength = barbarianStrength(full);
  const levels = contributions(full);
  const defense = levels.reduce((sum, level) => sum + level, 0);
  return {
    strength,
    defense,
    bySeat: state.config.seats.map((seat) => ({ seat, level: levels[seat] ?? 0 })),
    holds: defense >= strength,
  };
}

/** The last attack, or null before the first. */
export function lastAttack(ext: KnightsExt): AttackReport | null {
  return ext.lastAttack;
}

/** Progress cards a seat holds face down (a public count, victory cards excluded). */
export function progressHeld(state: Readonly<GameState>, seat: Seat): number {
  return (
    state.seats
      .find((item) => item.seat === seat)
      ?.cardSlots.filter((slot) => slot.deck.startsWith('progress-') && slot.revealed === undefined)
      .length ?? 0
  );
}

/** Level three abilities a seat has earned, by track. */
export function abilitiesOf(ext: KnightsExt, seat: Seat): Track[] {
  return TRACKS.filter((track) => levelOn(ext, seat, track) >= ABILITY_LEVEL);
}

/** The metropolises a seat holds. */
export function metropolisesOf(ext: KnightsExt, seat: Seat): Track[] {
  return TRACKS.filter((track) => ext.metropolises[track]?.seat === seat);
}

/** Victory cards a seat has shown: the Printer and the Constitution. */
export function shownVictoryCards(state: Readonly<GameState>, seat: Seat): string[] {
  return (
    state.seats
      .find((item) => item.seat === seat)
      ?.cardSlots.flatMap((slot) =>
        slot.deck.startsWith('progress-') &&
        (slot.revealed === 'printer' || slot.revealed === 'constitution')
          ? [slot.revealed]
          : [],
      ) ?? []
  );
}

/** The merchant, when a seat controls it. */
export function merchantOf(ext: KnightsExt): { seat: Seat; hex: string } | null {
  return ext.merchant;
}

/** A progress card in a seat's hand: its slot, its deck, and its identity if the viewer knows it. */
export interface HeldCard {
  readonly slotId: string;
  readonly track: Track;
  /** The card's id, from the viewer's private hand or a public identity; null when unknown. */
  readonly card: string | null;
  readonly acquiredTurn: number;
}

/**
 * The progress cards a seat holds face down. `priv` is the viewing seat's own private state, so
 * only its own cards have identities; another seat's are backs.
 */
export function heldProgress(
  state: Readonly<GameState>,
  seat: Seat,
  priv: PrivateState | null,
): HeldCard[] {
  const slots = state.seats.find((item) => item.seat === seat)?.cardSlots ?? [];
  return slots.flatMap((slot) => {
    const track = trackOfDeck(slot.deck);
    if (track === null || slot.revealed !== undefined) return [];
    const own = priv?.seat === seat;
    const card = slot.known ?? (own ? (priv.slots[slot.slotId] ?? null) : null);
    return [{ slotId: slot.slotId, track, card, acquiredTurn: slot.acquiredTurn }];
  });
}

/** How many progress cards a seat holds beyond the limit of four. */
export function progressSurplus(held: readonly HeldCard[]): number {
  return Math.max(0, held.length - HAND_LIMIT);
}

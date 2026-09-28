import type { DeckSpec } from '../../../core/modules/index.js';
import { TRACKS } from '../config.js';
import type { Track } from '../config.js';

/** Progress cards a seat may hold, victory cards excluded. */
export const HAND_LIMIT = 4;

/** The three progress decks, 18 cards each. Card ids are the 2020 names (the plan's ids). */
export const PROGRESS_CARDS: Readonly<Record<Track, Readonly<Record<string, number>>>> =
  Object.freeze({
    science: Object.freeze({
      alchemist: 2,
      crane: 2,
      engineer: 1,
      inventor: 2,
      irrigation: 2,
      medicine: 2,
      mining: 2,
      printer: 1,
      roadBuilding: 2,
      smith: 2,
    }),
    trade: Object.freeze({
      commercialHarbor: 2,
      masterMerchant: 2,
      merchant: 6,
      merchantFleet: 2,
      resourceMonopoly: 4,
      tradeMonopoly: 2,
    }),
    politics: Object.freeze({
      bishop: 2,
      constitution: 1,
      deserter: 2,
      diplomat: 2,
      intrigue: 2,
      saboteur: 2,
      spy: 3,
      warlord: 2,
      wedding: 2,
    }),
  });

/** Victory point cards: revealed the moment they are drawn, never in the hand, never returned. */
export const VICTORY_CARDS: Readonly<Record<string, Track>> = Object.freeze({
  printer: 'science',
  constitution: 'politics',
});

const PREFIX = 'progress-';

/** The deck id of a track's progress deck: `progress-science`, `progress-trade`, `progress-politics`. */
export function deckOfTrack(track: Track): string {
  return `${PREFIX}${track}`;
}

/** The track of a deck id, or null for any other deck. */
export function trackOfDeck(deck: string): Track | null {
  return TRACKS.find((track) => deckOfTrack(track) === deck) ?? null;
}

/** The deck a card belongs to. */
export function trackOfCard(card: string): Track | null {
  return TRACKS.find((track) => Object.hasOwn(PROGRESS_CARDS[track], card)) ?? null;
}

export function isProgressCard(card: unknown): card is string {
  return typeof card === 'string' && trackOfCard(card) !== null;
}

export function isVictoryCard(card: string): boolean {
  return Object.hasOwn(VICTORY_CARDS, card);
}

/** Cards in one deck. */
export function deckSize(track: Track): number {
  return Object.values(PROGRESS_CARDS[track]).reduce((sum, count) => sum + count, 0);
}

/** The `decks` hook: three private progress decks. */
export function progressDecks(
  _config: unknown,
  acc: Readonly<Record<string, DeckSpec>>,
): Record<string, DeckSpec> {
  return {
    ...acc,
    ...Object.fromEntries(
      TRACKS.map((track) => [
        deckOfTrack(track),
        { cards: { ...PROGRESS_CARDS[track] }, reveal: 'private' as const },
      ]),
    ),
  };
}

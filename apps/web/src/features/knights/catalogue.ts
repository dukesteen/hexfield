import { PROGRESS_CARDS, VICTORY_CARDS, trackOfCard } from '@cp2p/engine';
import type { GlyphName } from '@cp2p/renderer';
import type { Track } from './state';

/** How a card is played from the UI. */
export type CardPlay =
  /** No choices: confirm and play. */
  | 'confirm'
  /** Pick the two production dice (the Alchemist). */
  | 'dice'
  /** Pick an improvement track (the Crane). */
  | 'track'
  /** Pick a card kind (the monopolies and Merchant Fleet). */
  | 'kind'
  /** Pick another seat (Master Merchant, Spy, Deserter). */
  | 'seat'
  /** Tap the board (walls, cities, hexes, roads, knights). */
  | 'board'
  /** A victory card: shown when drawn, nothing to play. */
  | 'victory';

export interface CardInfo {
  readonly id: string;
  readonly track: Track;
  readonly play: CardPlay;
  /** The Alchemist is played before the roll; every other card in the action phase. */
  readonly preRoll?: boolean;
  /** An emblem for the card face: a base-game glyph, or the picture of a card kind. */
  readonly emblem:
    | { readonly glyph: GlyphName }
    | { readonly resource: 'grain' | 'ore' | 'wool' | 'brick' | 'lumber' }
    | { readonly commodity: 'paper' | 'cloth' | 'coin' }
    | { readonly piece: 'city' | 'road' }
    | { readonly die: true }
    | { readonly knight: 1 | 2 | 3 }
    | { readonly wall: true }
    | { readonly merchant: true }
    | { readonly track: true };
}

const card = (
  id: string,
  track: Track,
  play: CardPlay,
  emblem: CardInfo['emblem'],
  extra: Partial<CardInfo> = {},
): CardInfo => ({ id, track, play, emblem, ...extra });

/** Every progress card, with how it is played and its emblem. */
export const CARD_INFO: Readonly<Record<string, CardInfo>> = Object.fromEntries(
  [
    card('alchemist', 'science', 'dice', { die: true }, { preRoll: true }),
    card('crane', 'science', 'track', { track: true }),
    card('engineer', 'science', 'board', { wall: true }),
    card('inventor', 'science', 'board', { glyph: 'plenty' }),
    card('irrigation', 'science', 'confirm', { resource: 'grain' }),
    card('medicine', 'science', 'board', { piece: 'city' }),
    card('mining', 'science', 'confirm', { resource: 'ore' }),
    card('printer', 'science', 'victory', { glyph: 'victory' }),
    card('roadBuilding', 'science', 'confirm', { glyph: 'roads' }),
    card('smith', 'science', 'board', { knight: 2 }),
    card('commercialHarbor', 'trade', 'confirm', { glyph: 'playerTrade' }),
    card('masterMerchant', 'trade', 'seat', { commodity: 'coin' }),
    card('merchant', 'trade', 'board', { merchant: true }),
    card('merchantFleet', 'trade', 'kind', { glyph: 'bankTrade' }),
    card('resourceMonopoly', 'trade', 'kind', { glyph: 'monopoly' }),
    card('tradeMonopoly', 'trade', 'kind', { commodity: 'cloth' }),
    card('bishop', 'politics', 'board', { glyph: 'longest' }),
    card('constitution', 'politics', 'victory', { glyph: 'victory' }),
    card('deserter', 'politics', 'seat', { knight: 1 }),
    card('diplomat', 'politics', 'board', { piece: 'road' }),
    card('intrigue', 'politics', 'board', { knight: 3 }),
    card('saboteur', 'politics', 'confirm', { commodity: 'paper' }),
    card('spy', 'politics', 'seat', { glyph: 'knight' }),
    card('warlord', 'politics', 'confirm', { knight: 3 }),
    card('wedding', 'politics', 'confirm', { commodity: 'coin' }),
  ].map((info) => [info.id, info]),
);

/** The card's info, from the engine's own list; an unknown id gets a plain card of its deck. */
export function cardInfo(id: string): CardInfo {
  const known = CARD_INFO[id];
  if (known) return known;
  return { id, track: trackOfCard(id) ?? 'trade', play: 'confirm', emblem: { track: true } };
}

/** Every card id in the decks, in deck order (for the rules reference and tests). */
export function allCardIds(): string[] {
  return Object.values(PROGRESS_CARDS).flatMap((deck) => Object.keys(deck));
}

export function isVictoryCardId(id: string): boolean {
  return Object.hasOwn(VICTORY_CARDS, id);
}

import type { OptionSpec } from '../../core/modules/index.js';

export const KNIGHTS_ID = 'knights';
export const KNIGHTS_VERSION = '1.0.0';

/** The three city-improvement tracks: trade (yellow), politics (blue) and science (green). */
export const TRACKS = ['trade', 'politics', 'science'] as const;
export type Track = (typeof TRACKS)[number];

/** The commodity that pays for each track. */
export const TRACK_COMMODITY: Readonly<Record<Track, string>> = Object.freeze({
  trade: 'cloth',
  politics: 'coin',
  science: 'paper',
});

/** Commodity card kinds in canonical (alphabetical) order. */
export const COMMODITIES: readonly string[] = Object.freeze(['cloth', 'coin', 'paper']);

/** Commodities in the bank: 12 of each, or 18 with five-six. */
export const COMMODITY_BANK = 12;
export const COMMODITY_BANK_FIVE_SIX = 18;

/** The victory target of a Cities and Knights game. */
export const KNIGHTS_VP_TARGET = 13;

/** Hand-limit bonus per city wall. */
export const WALL_HAND_BONUS = 2;
/** City walls per seat. */
export const WALLS_PER_SEAT = 3;

/** Improvement levels per track; levels 4 and 5 carry the metropolis. */
export const MAX_LEVEL = 5;
/** The level that unlocks a track's ability (Trading House, Fortress, Aqueduct). */
export const ABILITY_LEVEL = 3;
/** A metropolis is worth two points on top of its city. */
export const METROPOLIS_VP = 2;

/** Barbarian ship faces before an attack. */
export const BARBARIAN_STEPS = 7;

/** The event die: three ships and one gate for each track. */
export const EVENT_DIE = Object.freeze({
  id: 'event',
  faces: Object.freeze(['ship', 'ship', 'ship', 'trade', 'politics', 'science']),
});

/** What a city on each terrain pays instead of two of its resource: one resource, one commodity. */
export const CITY_COMMODITY: Readonly<Record<string, { resource: string; commodity: string }>> =
  Object.freeze({
    forest: { resource: 'lumber', commodity: 'paper' },
    pasture: { resource: 'wool', commodity: 'cloth' },
    mountains: { resource: 'ore', commodity: 'coin' },
  });

/** The module has no options; its rules are fixed. */
export const KNIGHTS_OPTIONS: readonly OptionSpec[] = [];

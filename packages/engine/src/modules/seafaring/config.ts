import type { OptionSpec } from '../../core/modules/index.js';

export const SEAFARING_ID = 'seafaring';
export const SEAFARING_VERSION = '1.0.0';

/** Ships per seat. */
export const SHIPS_PER_SEAT = 15;
/** One lumber and one wool. */
export const SHIP_COST = Object.freeze({ lumber: 1, wool: 1 });

/** Unrevealed fog contents, as counts. Reserved: fog reveals are not implemented yet. */
export interface FogOption {
  terrains: Record<string, number>;
  tokens: Record<string, number>;
}

export interface SeafaringOptions {
  /** The pirate's starting sea hex, or null to start it off the board. */
  pirateHex: string | null;
  /** Hex ids whose vertices allow setup settlements. Null allows any land vertex. */
  setupAreas: string[] | null;
  /** Victory points for the first settlement on each foreign region. Null means no bonus. */
  islandBonus: { vp: number } | null;
  /** Explicit bonus regions (groups of hex ids). Null makes every island a region. */
  bonusRegions: string[][] | null;
  /** Reserved for fog reveals. Genesis rejects a non-null value for now. */
  fog: FogOption | null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

function isCounts(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0,
  );
}

function validRegions(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const group of value) {
    if (!isStringArray(group) || group.length === 0) return false;
    for (const hex of group) {
      if (seen.has(hex)) return false;
      seen.add(hex);
    }
  }
  return true;
}

export const SEAFARING_OPTIONS: readonly OptionSpec[] = [
  { key: 'pirateHex', type: 'string', nullable: true, default: null },
  {
    key: 'setupAreas',
    type: 'array',
    nullable: true,
    default: null,
    validate: (value) => value === null || (isStringArray(value) && value.length > 0),
  },
  {
    key: 'islandBonus',
    type: 'object',
    nullable: true,
    default: null,
    validate: (value) => {
      if (value === null) return true;
      if (typeof value !== 'object' || Array.isArray(value)) return false;
      const keys = Object.keys(value);
      const vp: unknown = Reflect.get(value, 'vp');
      return (
        keys.length === 1 &&
        keys[0] === 'vp' &&
        typeof vp === 'number' &&
        Number.isSafeInteger(vp) &&
        vp >= 1 &&
        vp <= 5
      );
    },
  },
  {
    key: 'bonusRegions',
    type: 'array',
    nullable: true,
    default: null,
    validate: (value) => value === null || validRegions(value),
  },
  {
    key: 'fog',
    type: 'object',
    nullable: true,
    default: null,
    validate: (value) =>
      value === null ||
      (typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).toSorted().join(',') === 'terrains,tokens' &&
        isCounts(Reflect.get(value, 'terrains')) &&
        isCounts(Reflect.get(value, 'tokens'))),
  },
];

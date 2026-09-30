import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { hexId } from '@cp2p/engine/geometry';
import * as v from 'valibot';

/** Version of the `MapDef` format; the share prefix carries it too. */
export const MAP_FORMAT = 1;

/** Terrains a map can hold. `sea`, `gold` and `fog` need the seafaring module. */
export const MAP_TERRAINS = [
  'forest',
  'hills',
  'pasture',
  'fields',
  'mountains',
  'desert',
  'gold',
  'sea',
  'fog',
] as const;
export type MapTerrain = (typeof MAP_TERRAINS)[number];

/** Terrains only a seafaring map may use. */
export const SEAFARING_MAP_TERRAINS: readonly MapTerrain[] = ['gold', 'sea', 'fog'];

export const MAP_TOKENS = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12] as const;
export type MapToken = (typeof MAP_TOKENS)[number];

/** True for a number a token can show (2–12 without 7). */
export function isMapToken(value: unknown): value is MapToken {
  return MAP_TOKENS.some((token) => token === value);
}
export const HARBOR_KINDS = ['generic', 'brick', 'lumber', 'wool', 'grain', 'ore'] as const;
export type HarborKind = (typeof HARBOR_KINDS)[number];

/** Expansion modules a map can ask for. Five-six follows the seat count, never the map. */
export const MAP_MODULES = ['seafaring', 'knights'] as const;
export type MapModule = (typeof MAP_MODULES)[number];

/**
 * Size limits. The protocol's genesis board takes 512 hexes and 256 harbors; a map stays well
 * below, so a custom board never pushes a genesis or lobby message near its 256 KiB cap.
 */
export const MAP_LIMITS = Object.freeze({
  hexes: 400,
  harbors: 64,
  /** Axial coordinates stay within this distance of the origin. */
  coordinate: 40,
  name: 60,
  /** Canonical JSON bytes, before compression. */
  jsonBytes: 48 * 1024,
  /** Share string characters. */
  shareChars: 24 * 1024,
});

const hexIdPattern = /^h:-?\d{1,2},-?\d{1,2}$/;
const edgeIdPattern = /^e:-?\d{1,2},-?\d{1,2},(?:NE|NW|W)$/;

const coordinate = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(-MAP_LIMITS.coordinate),
  v.maxValue(MAP_LIMITS.coordinate),
);
const hexRef = v.pipe(v.string(), v.regex(hexIdPattern));
const count = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAP_LIMITS.hexes));
const seatCount = v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(6));

const hexSchema = v.strictObject({
  q: coordinate,
  r: coordinate,
  terrain: v.picklist(MAP_TERRAINS),
  token: v.nullable(v.picklist(MAP_TOKENS)),
});

const harborSchema = v.strictObject({
  edge: v.pipe(v.string(), v.regex(edgeIdPattern)),
  kind: v.picklist(HARBOR_KINDS),
});

const fogSchema = v.strictObject({
  terrains: v.record(v.picklist(MAP_TERRAINS.filter((terrain) => terrain !== 'fog')), count),
  tokens: v.record(v.picklist(MAP_TOKENS.map(String)), count),
});

/** The map editor's format: a board, its setup rules and what it needs to be played. */
export const mapDefSchema = v.pipe(
  v.strictObject({
    v: v.literal(MAP_FORMAT),
    name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAP_LIMITS.name)),
    modules: v.pipe(v.array(v.picklist(MAP_MODULES)), v.maxLength(MAP_MODULES.length)),
    seats: v.pipe(
      v.strictObject({ min: seatCount, max: seatCount }),
      v.check((seats) => seats.min <= seats.max, 'seats.min exceeds seats.max'),
    ),
    vpTarget: v.pipe(v.number(), v.integer(), v.minValue(3), v.maxValue(20)),
    hexes: v.pipe(v.array(hexSchema), v.maxLength(MAP_LIMITS.hexes)),
    harbors: v.pipe(v.array(harborSchema), v.maxLength(MAP_LIMITS.harbors)),
    robber: v.nullable(hexRef),
    pirate: v.nullable(hexRef),
    /** Hexes whose corners allow setup settlements (seafaring). Null allows every land hex. */
    setupAreas: v.nullable(v.pipe(v.array(hexRef), v.minLength(1), v.maxLength(MAP_LIMITS.hexes))),
    /** The hidden fog stack: tiles by terrain and number tokens by number (seafaring). */
    fog: v.nullable(fogSchema),
  }),
  v.check(
    (map) => new Set(map.hexes.map((hex) => hexId(hex))).size === map.hexes.length,
    'duplicate hex',
  ),
  v.check((map) => new Set(map.modules).size === map.modules.length, 'duplicate module'),
);

export type MapHex = v.InferOutput<typeof hexSchema>;
export type MapHarbor = v.InferOutput<typeof harborSchema>;
export type MapFog = v.InferOutput<typeof fogSchema>;
export type MapDef = v.InferOutput<typeof mapDefSchema>;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sortedCounts(counts: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts)
      .filter(([, value]) => value > 0)
      .toSorted(([a], [b]) => byText(a, b)),
  );
}

/**
 * The canonical form: hexes by id, harbors by edge, sorted unique modules and setup hexes, and
 * fog counts without zeros. Equal maps encode to the same bytes, so their share strings match.
 */
export function canonicalMap(map: MapDef): MapDef {
  return {
    v: MAP_FORMAT,
    name: map.name.trim(),
    modules: MAP_MODULES.filter((id) => map.modules.includes(id)),
    seats: { min: map.seats.min, max: map.seats.max },
    vpTarget: map.vpTarget,
    hexes: map.hexes
      .map(({ q, r, terrain, token }) => ({ q, r, terrain, token }))
      .toSorted((a, b) => byText(hexId(a), hexId(b))),
    harbors: map.harbors
      .map(({ edge, kind }) => ({ edge, kind }))
      .toSorted((a, b) => byText(a.edge, b.edge)),
    robber: map.robber,
    pirate: map.pirate,
    setupAreas: map.setupAreas === null ? null : [...new Set(map.setupAreas)].toSorted(byText),
    fog:
      map.fog === null
        ? null
        : { terrains: sortedCounts(map.fog.terrains), tokens: sortedCounts(map.fog.tokens) },
  };
}

/** Check any value against the `MapDef` schema and return its canonical form. */
export function parseMapDef(value: unknown): Result<MapDef> {
  const parsed = v.safeParse(mapDefSchema, value);
  if (parsed.success) return success(canonicalMap(parsed.output));
  const issue = parsed.issues[0];
  const path = issue.path?.map((item) => String(item.key)).join('.') ?? '';
  return failure('MAP_INVALID', path ? `${path}: ${issue.message}` : issue.message);
}

/** A new empty map for the editor. */
export function emptyMap(name = 'Untitled map'): MapDef {
  return {
    v: MAP_FORMAT,
    name,
    modules: [],
    seats: { min: 3, max: 4 },
    vpTarget: 10,
    hexes: [],
    harbors: [],
    robber: null,
    pirate: null,
    setupAreas: null,
    fog: null,
  };
}

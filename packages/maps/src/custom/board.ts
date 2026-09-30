import { COMBO_ID, failure, success } from '@cp2p/engine';
import type { BoardState, GameConfig, Result } from '@cp2p/engine';
import { hexId } from '@cp2p/engine/geometry';
import type { Scenario } from '../scenarios.js';
import { scenarioConfig } from '../scenarios.js';
import { isCustomConfig } from './config.js';
import { MAP_FORMAT, MAP_MODULES, canonicalMap, parseMapDef } from './schema.js';
import type { MapDef, MapModule } from './schema.js';

/** The id of the scenario a custom map plays as. */
export const CUSTOM_SCENARIO_ID = 'custom';

/** The engine board a map describes, empty of pieces. Hexes and harbors are in canonical order. */
export function mapBoard(map: MapDef): BoardState {
  const canonical = canonicalMap(map);
  return {
    hexes: canonical.hexes.map(({ q, r, terrain, token }) => ({
      id: hexId({ q, r }),
      q,
      r,
      terrain,
      token,
    })),
    harbors: canonical.harbors.map(({ edge, kind }) => ({ edge, kind })),
    roads: [],
    buildings: [],
    robberHex: canonical.robber,
  };
}

/** Seat counts a map is drawn for, from its own range; expansions need at least three seats. */
export function mapSeatCounts(map: MapDef): number[] {
  const min = Math.max(map.seats.min, map.modules.length > 0 ? 3 : 2);
  return [2, 3, 4, 5, 6].filter((count) => count >= min && count <= map.seats.max);
}

/** The engine modules a map plays with at a seat count: five-six joins at five and six seats. */
export function mapModules(map: MapDef, seatCount: number): string[] {
  return ['base', ...(seatCount > 4 ? ['five-six'] : []), ...map.modules];
}

/**
 * The scenario a custom map plays as at one seat count. Its board is the map's; `mapLayout: custom`
 * lets base accept any land shape, and a seafaring map passes its pirate, setup areas and fog.
 */
export function mapScenario(map: MapDef, seatCount: number): Scenario {
  const seafaring = map.modules.includes('seafaring');
  const combo = seafaring && map.modules.includes('knights');
  const counts = mapSeatCounts(map).filter((count) => count > 4 === seatCount > 4);
  return {
    id: CUSTOM_SCENARIO_ID,
    titleKey: 'scenarioCustom',
    aboutKey: 'scenarioCustomAbout',
    modules: mapModules(map, seatCount),
    ...(combo ? { rulesModule: COMBO_ID } : {}),
    seats: { min: counts[0] ?? seatCount, max: counts.at(-1) ?? seatCount },
    board: { kind: 'fixed', shape: CUSTOM_SCENARIO_ID, board: () => mapBoard(map) },
    options: {
      base: { mapLayout: 'custom' },
      ...(seafaring
        ? {
            seafaring: {
              pirateHex: map.pirate,
              ...(map.setupAreas === null ? {} : { setupAreas: [...map.setupAreas] }),
              ...(map.fog === null
                ? {}
                : { fog: { terrains: { ...map.fog.terrains }, tokens: { ...map.fog.tokens } } }),
            },
          }
        : {}),
    },
    vpTarget: map.vpTarget,
  };
}

/**
 * The genesis config for a map at a seat count, with the player's rule choices. The board rides in
 * `config.board`, so it is hashed and signed with the genesis and every peer builds the same one.
 */
export function mapConfig(
  map: MapDef,
  seatCount: number,
  choices: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
): Result<GameConfig> {
  if (!mapSeatCounts(map).includes(seatCount))
    return failure('MAP_SEATS', `This map is not drawn for ${seatCount} players`);
  try {
    return success(scenarioConfig(mapScenario(map, seatCount), seatCount, choices));
  } catch (error) {
    return failure('MAP_CONFIG', error instanceof Error ? error.message : String(error));
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/**
 * Rebuild the map a custom config plays, for the lobby (a guest can see and save it). The seat
 * range is the config's seat count; the name is the caller's.
 */
export function mapOfConfig(config: GameConfig, name: string): MapDef | null {
  const board = config.board;
  if (!board || !isCustomConfig(config)) return null;
  const ids = new Set(config.modules.map((module) => module.id));
  const modules = MAP_MODULES.filter((id: MapModule) => ids.has(id));
  const seafaring = recordOf(config.options.seafaring);
  const base = recordOf(config.options.base);
  const setup = seafaring.setupAreas;
  const fog = recordOf(seafaring.fog);
  const parsed = parseMapDef({
    v: MAP_FORMAT,
    name,
    modules,
    seats: { min: config.seats.length, max: config.seats.length },
    vpTarget: typeof base.vpTarget === 'number' ? base.vpTarget : 10,
    hexes: board.hexes.map(({ q, r, terrain, token }) => ({ q, r, terrain, token })),
    harbors: board.harbors.map(({ edge, kind }) => ({ edge, kind })),
    robber: board.robberHex,
    pirate: typeof seafaring.pirateHex === 'string' ? seafaring.pirateHex : null,
    setupAreas: Array.isArray(setup) ? setup : null,
    fog: seafaring.fog ? { terrains: fog.terrains ?? {}, tokens: fog.tokens ?? {} } : null,
  });
  return parsed.ok ? parsed.value : null;
}

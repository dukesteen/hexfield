import type { GameConfig, GameState } from '../../core/state/index.js';
import type { VpContribution } from '../../core/modules/index.js';
import type { Seat } from '../../core/types/index.js';
import { boardGraph, boardIslands, hexesForVertex } from '../base/board/index.js';
import { seafaringExt, seafaringOptions, updateSeafaring } from './types.js';

const explicit = new WeakMap<GameConfig, ReadonlyMap<string, string>>();

/**
 * Hex id to region id. A region is an island unless the scenario lists explicit `bonusRegions`,
 * and it is named by its least hex id. Hexes outside every explicit region have no region.
 */
export function regionMap(state: GameState): ReadonlyMap<string, string> {
  const groups = seafaringOptions(state).bonusRegions;
  if (groups === null)
    return new Map(
      boardIslands(state).flatMap((island) => island.hexes.map((hex) => [hex, island.id] as const)),
    );
  let cached = explicit.get(state.config);
  if (!cached) {
    cached = new Map(
      groups.flatMap((group) => {
        const id = group.toSorted()[0] ?? '';
        return group.map((hex) => [hex, id] as const);
      }),
    );
    explicit.set(state.config, cached);
  }
  return cached;
}

/**
 * The region a settlement counts for: the least region id among the land hexes at its vertex,
 * or null when none of them is in a region.
 */
export function regionOfVertex(state: GameState, vertex: string): string | null {
  const regions = regionMap(state);
  const found = hexesForVertex(state, vertex)
    .map((hex) => regions.get(hex))
    .filter((region): region is string => region !== undefined)
    .toSorted();
  return found[0] ?? null;
}

function inSetup(state: GameState): boolean {
  const top = state.turn.phase.at(-1);
  return top?.module === 'base' && top.id === 'setup';
}

/** Hex ids around a vertex, or none off board. */
export function hexesForVertexOf(state: GameState, vertex: string): string[] {
  return hexesForVertex(state, vertex);
}

/** Hex ids on the sides of an edge, or none off board. */
export function hexesForEdge(state: GameState, edge: string): string[] {
  const graph = boardGraph(state);
  return [...(graph.edgeHexes[graph.edgeIndex[edge] ?? -1] ?? [])];
}

/** Setup placements must touch the scenario's setup areas, when it declares any. */
export function inSetupArea(state: GameState, hexes: readonly string[]): boolean {
  const areas = seafaringOptions(state).setupAreas;
  return areas === null || !inSetup(state) || hexes.some((hex) => areas.includes(hex));
}

/** The `afterBuild` hook: record home regions in setup, and award the new-island bonus after it. */
export function recordSettlement(state: GameState, seat: Seat, vertex: string): GameState {
  const region = regionOfVertex(state, vertex);
  if (region === null) return state;
  const ext = seafaringExt(state);
  if (inSetup(state)) {
    const home = ext.homeRegions[seat] ?? [];
    return home.includes(region)
      ? state
      : updateSeafaring(state, (old) => ({
          ...old,
          homeRegions: old.homeRegions.map((regions, index) =>
            index === seat ? [...regions, region].toSorted() : regions,
          ),
        }));
  }
  if (
    seafaringOptions(state).islandBonus === null ||
    (ext.homeRegions[seat] ?? []).includes(region) ||
    ext.bonus.some((token) => token.seat === seat && token.region === region)
  )
    return state;
  return updateSeafaring(state, (old) => ({
    ...old,
    bonus: [...old.bonus, { seat, region, vertex }],
  }));
}

/** The `victoryPoints` hook: public, and folded into the seat's stored public points. */
export function islandBonusPoints(
  state: GameState,
  seat: Seat,
  acc: readonly VpContribution[],
): readonly VpContribution[] {
  const bonus = seafaringOptions(state).islandBonus;
  const count =
    bonus === null ? 0 : seafaringExt(state).bonus.filter((token) => token.seat === seat).length;
  return count === 0 || bonus === null
    ? acc
    : [...acc, { source: 'island-bonus', points: bonus.vp * count, public: true, stored: true }];
}

/** Region ids that exist on the board, for invariants. */
export function regionIds(state: GameState): ReadonlySet<string> {
  return new Set(regionMap(state).values());
}

import type { GameState, Resource, Seat } from '@cp2p/engine';
import { RESOURCES, isBaseResource } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import type { BoardGraph } from '@cp2p/engine/geometry';

/** The dice weight of a number token: how many of the 36 rolls make it (2 → 1 … 6 → 5, 8 → 5 … 12 → 1). */
export function pips(token: number | null | undefined): number {
  if (token === null || token === undefined || token < 2 || token > 12 || token === 7) return 0;
  return 6 - Math.abs(7 - token);
}

/** The resource a terrain pays in the base game; gold pays a card of choice (seafaring). */
export const TERRAIN_RESOURCE: Readonly<Record<string, Resource | 'gold'>> = {
  hills: 'brick',
  forest: 'lumber',
  pasture: 'wool',
  fields: 'grain',
  mountains: 'ore',
  gold: 'gold',
};

export interface HexYield {
  hex: string;
  resource: Resource | 'gold';
  pips: number;
}

/** Derived, immutable facts about one board layout (the hexes never change during a game). */
export interface BoardInfo {
  graph: BoardGraph;
  /** Producing hexes around each vertex (by vertex index). */
  yields: readonly (readonly HexYield[])[];
  /** Whether a vertex touches any land hex. */
  onLand: readonly boolean[];
  /** The harbor kinds at each vertex ('generic' or a resource), by vertex index. */
  harbors: readonly (readonly string[])[];
}

const infos = new WeakMap<object, BoardInfo>();
const harborMaps = new WeakMap<object, (readonly string[])[]>();

function harborsByVertex(state: GameState, graph: BoardGraph): (readonly string[])[] {
  const cached = harborMaps.get(state.board.harbors);
  if (cached) return cached;
  const map: string[][] = graph.vertexIds.map(() => []);
  for (const harbor of state.board.harbors) {
    const edge = graph.edgeIndex[harbor.edge];
    if (edge === undefined) continue;
    for (const vertex of graph.edgeVertices[edge] ?? []) {
      const index = graph.vertexIndex[vertex];
      if (index !== undefined) map[index]?.push(harbor.kind);
    }
  }
  harborMaps.set(state.board.harbors, map);
  return map;
}

/** Board facts for a state, cached per hex list (hex terrains change only with fog reveals). */
export function boardInfo(state: GameState): BoardInfo {
  const hexes = state.board.hexes;
  let info = infos.get(hexes);
  if (!info) {
    const graph = buildBoardGraph(hexes);
    const byId = new Map(hexes.map((hex) => [hex.id, hex]));
    const yields = graph.vertexIds.map((_, index) =>
      (graph.vertexHexes[index] ?? []).flatMap((id): HexYield[] => {
        const hex = byId.get(id);
        const resource = hex ? TERRAIN_RESOURCE[hex.terrain] : undefined;
        const weight = pips(hex?.token);
        return resource && weight > 0 ? [{ hex: id, resource, pips: weight }] : [];
      }),
    );
    const onLand = graph.vertexIds.map((_, index) =>
      (graph.vertexHexes[index] ?? []).some((id) => {
        const terrain = byId.get(id)?.terrain;
        return terrain !== undefined && terrain !== 'sea' && terrain !== 'fog';
      }),
    );
    info = { graph, yields, onLand, harbors: [] };
    infos.set(hexes, info);
  }
  return { ...info, harbors: harborsByVertex(state, info.graph) };
}

export type Rates = Record<Resource, number>;

export function zeroRates(): Rates {
  return { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
}

/** Pips per resource at a vertex, with gold spread as a free choice over the scarcest need. */
export function vertexPips(
  info: BoardInfo,
  vertex: string,
  robberHex: string | null = null,
): Rates {
  const rates = zeroRates();
  const index = info.graph.vertexIndex[vertex];
  if (index === undefined) return rates;
  for (const item of info.yields[index] ?? []) {
    if (item.hex === robberHex) continue;
    if (item.resource === 'gold')
      for (const resource of RESOURCES) rates[resource] += item.pips / 5;
    else rates[item.resource] += item.pips;
  }
  return rates;
}

/**
 * Expected cards per dice roll for a seat, per resource: a settlement collects its hexes' pips/36
 * and a city twice that. The robber's hex pays nothing.
 */
export function productionRates(state: GameState, seat: Seat, info = boardInfo(state)): Rates {
  const rates = zeroRates();
  for (const building of state.board.buildings) {
    if (building.seat !== seat) continue;
    const multiplier = building.kind === 'settlement' ? 1 : 2;
    const pipsAt = vertexPips(info, building.vertex, state.board.robberHex);
    for (const resource of RESOURCES) rates[resource] += (pipsAt[resource] * multiplier) / 36;
  }
  return rates;
}

/** The best maritime rate a seat has for a resource (4, 3 with a generic harbor, 2 with its own). */
export function tradeRates(state: GameState, seat: Seat, info = boardInfo(state)): Rates {
  const rates: Rates = { brick: 4, lumber: 4, wool: 4, grain: 4, ore: 4 };
  for (const building of state.board.buildings) {
    if (building.seat !== seat) continue;
    const index = info.graph.vertexIndex[building.vertex];
    if (index === undefined) continue;
    for (const kind of info.harbors[index] ?? []) {
      if (kind === 'generic')
        for (const resource of RESOURCES) rates[resource] = Math.min(rates[resource], 3);
      else if (isBaseResource(kind)) rates[kind] = 2;
    }
  }
  return rates;
}

import type { GameState, Resource, Seat } from '@cp2p/engine';
import { RESOURCES, isBaseResource } from '@cp2p/engine';
import { boardInfo, productionRates, vertexPips } from './board.js';
import type { BoardInfo, Rates } from './board.js';
import { openSites } from './sites.js';

/** How much a pip of each resource is worth before the seat's own needs are known. */
export const OPENING_WEIGHTS: Readonly<Rates> = {
  brick: 1.15,
  lumber: 1.15,
  wool: 0.85,
  grain: 1.05,
  ore: 1.0,
};

export interface VertexScoreOptions {
  /** Per-resource value of one pip; defaults to `needWeights` for the seat. */
  weights?: Readonly<Rates>;
  /** Bonus per distinct resource the vertex adds. */
  diversity?: number;
  /** Weight of the best open site within two roads. */
  expansion?: number;
  /** Weight of harbor synergy. */
  harbor?: number;
}

/**
 * Per-resource pip weights for a seat: the opening weights, raised for resources the seat does not
 * yet produce (so a second settlement complements the first) and lowered for ones it has plenty of.
 */
export function needWeights(state: GameState, seat: Seat, info = boardInfo(state)): Rates {
  const rates = productionRates(state, seat, info);
  const weights = { ...OPENING_WEIGHTS };
  const total = RESOURCES.reduce((sum, resource) => sum + rates[resource], 0);
  if (total === 0) return weights;
  for (const resource of RESOURCES) {
    const share = rates[resource] / total;
    weights[resource] *= rates[resource] === 0 ? 1.45 : share > 0.3 ? 0.8 : 1;
  }
  return weights;
}

function harborBonus(
  info: BoardInfo,
  vertex: string,
  own: Readonly<Rates>,
  here: Readonly<Rates>,
): number {
  const index = info.graph.vertexIndex[vertex];
  let best = 0;
  for (const kind of index === undefined ? [] : (info.harbors[index] ?? [])) {
    if (kind === 'generic') best = Math.max(best, 1.2);
    else if (isBaseResource(kind)) best = Math.max(best, 0.35 * (own[kind] * 36 + here[kind]));
  }
  return best;
}

function expansionValue(
  state: GameState,
  info: BoardInfo,
  vertex: string,
  open: ReadonlySet<string>,
  weights: Readonly<Rates>,
): number {
  const { graph } = info;
  const start = graph.vertexIndex[vertex];
  if (start === undefined) return 0;
  const blocked = new Set([vertex, ...(graph.vertexNeighbors[start] ?? [])]);
  let best = 0;
  for (const first of graph.vertexNeighbors[start] ?? []) {
    const index = graph.vertexIndex[first];
    for (const second of index === undefined ? [] : (graph.vertexNeighbors[index] ?? [])) {
      if (blocked.has(second) || !open.has(second)) continue;
      const rates = vertexPips(info, second, state.board.robberHex);
      best = Math.max(
        best,
        RESOURCES.reduce((sum, resource) => sum + rates[resource] * weights[resource], 0),
      );
    }
  }
  return best;
}

/**
 * The value of settling a vertex for a seat: its pips weighted by need, plus bonuses for new
 * resources, a matching harbor, and room to expand. Higher is better; a typical good site scores
 * 12–16.
 */
export function vertexScore(
  state: GameState,
  seat: Seat,
  vertex: string,
  options: VertexScoreOptions = {},
  info: BoardInfo = boardInfo(state),
  open: ReadonlySet<string> = openSites(state, info),
): number {
  const weights = options.weights ?? needWeights(state, seat, info);
  const here = vertexPips(info, vertex, null);
  const own = productionRates(state, seat, info);
  let score = 0;
  let fresh = 0;
  for (const resource of RESOURCES) {
    score += here[resource] * weights[resource];
    if (here[resource] > 0 && own[resource] === 0) fresh++;
  }
  score += (options.diversity ?? 0.9) * fresh;
  score += (options.harbor ?? 1) * harborBonus(info, vertex, own, here);
  score += (options.expansion ?? 0.3) * expansionValue(state, info, vertex, open, weights);
  return score;
}

/** Sum of raw pips at a vertex: the simple placement value an easy bot uses. */
export function rawPips(state: GameState, vertex: string, info = boardInfo(state)): number {
  const rates = vertexPips(info, vertex, null);
  return RESOURCES.reduce((sum, resource: Resource) => sum + rates[resource], 0);
}

import type { CommandShape } from '@cp2p/engine';
import { needWeights, openSites, rawPips, vertexPips, vertexScore } from '../eval/index.js';
import type { TurnContext } from './context.js';

function distinctResources(context: TurnContext, vertex: string): number {
  const rates = vertexPips(context.info, vertex);
  return Object.values(rates).filter((value) => value > 0).length;
}

/** Score for placing a settlement at `vertex`, by the level's placement rule. */
export function settlementValue(
  context: TurnContext,
  vertex: string,
  open: ReadonlySet<string>,
): number {
  const { state, seat } = context.view;
  if (context.config.placement === 'pips')
    return rawPips(state, vertex, context.info) + 0.5 * distinctResources(context, vertex);
  return vertexScore(state, seat, vertex, {}, context.info, open);
}

/** Best of several scored commands; ties broken by the bot's RNG. */
export function best<T>(
  items: readonly T[],
  score: (item: T) => number,
  context: TurnContext,
): T | null {
  let top: T[] = [];
  let topScore = -Infinity;
  for (const item of items) {
    const value = score(item);
    if (value > topScore + 1e-9) {
      top = [item];
      topScore = value;
    } else if (Math.abs(value - topScore) <= 1e-9) top.push(item);
  }
  return top.length ? (top[context.rng.int(top.length)] ?? null) : null;
}

/** An opening settlement: the highest-valued legal vertex. */
export function setupSettlement(context: TurnContext): CommandShape | null {
  const open = openSites(context.view.state, context.info);
  const options = context.ofType('PLACE_SETTLEMENT');
  return best(
    options,
    (command) => settlementValue(context, String(command.vertex), open),
    context,
  );
}

/**
 * An edge leaving the seat's network: valued by the best open site it leads to within one more
 * road, so an opening road points at the next settlement.
 */
export function edgeValue(context: TurnContext, edge: string, open: ReadonlySet<string>): number {
  const { graph } = context.info;
  const { state, seat } = context.view;
  const index = graph.edgeIndex[edge];
  if (index === undefined) return 0;
  const own = new Set(
    state.board.buildings.filter((piece) => piece.seat === seat).map((piece) => piece.vertex),
  );
  const weights = needWeights(state, seat, context.info);
  const value = (vertex: string): number =>
    context.config.placement === 'pips'
      ? rawPips(state, vertex, context.info)
      : vertexScore(state, seat, vertex, { weights, expansion: 0 }, context.info, open);
  let top = 0;
  for (const end of graph.edgeVertices[index] ?? []) {
    if (own.has(end)) continue;
    if (open.has(end)) top = Math.max(top, value(end) + 1);
    const endIndex = graph.vertexIndex[end];
    for (const next of endIndex === undefined ? [] : (graph.vertexNeighbors[endIndex] ?? []))
      if (open.has(next)) top = Math.max(top, value(next));
  }
  return top;
}

/** An opening road (or a free road): toward the best reachable site. */
export function roadToward(context: TurnContext, type: string): CommandShape | null {
  const open = openSites(context.view.state, context.info);
  const goal = context.goal();
  const options = context.ofType(type);
  return best(
    options,
    (command) => {
      const edge = String(command.edge);
      return edgeValue(context, edge, open) + (goal?.firstEdges?.has(edge) ? 5 : 0);
    },
    context,
  );
}

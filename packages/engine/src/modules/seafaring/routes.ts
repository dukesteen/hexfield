import type { RouteGraph } from '../../core/modules/index.js';
import type { GameState } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import { boardGraph, edgeEndpoints } from '../base/board/index.js';
import { shipEdges } from './ships.js';

/**
 * The `routeGraph` hook: the seat's roads and ships as one typed graph. A path changes between
 * road and ship only at a vertex holding the seat's own settlement or city.
 */
export function tradeRoute(state: GameState, seat: Seat, acc: RouteGraph): RouteGraph {
  const ships = shipEdges(state, seat);
  if (ships.length === 0) return acc;
  const graph = boardGraph(state);
  return {
    ...acc,
    edges: [
      ...acc.edges.map((edge) => ({ ...edge, kind: 'road' })),
      ...ships.flatMap((edge) => {
        const vertices = edgeEndpoints(graph, edge);
        return vertices ? [{ id: edge, vertices, kind: 'ship' }] : [];
      }),
    ],
    transitions: [
      ...(acc.transitions ?? []),
      ...state.board.buildings.filter((piece) => piece.seat === seat).map((piece) => piece.vertex),
    ],
  };
}

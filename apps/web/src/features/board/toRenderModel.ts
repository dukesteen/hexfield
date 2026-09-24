import type { GameState, Seat } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import type { RenderModel } from '@cp2p/renderer';

export type BoardViewer = Seat | 'spectator';

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Invalid board ${label}`);
  return value;
}

/** Derive only public board data; viewer is intentionally not used to reveal private state. */
export function toRenderModel(state: Readonly<GameState>, _viewer: BoardViewer): RenderModel {
  const graph = buildBoardGraph(state.board.hexes);
  return {
    hexes: state.board.hexes.map((hex) => ({
      id: required(
        graph.hexIds.find((id) => id === hex.id),
        `hex id ${hex.id}`,
      ),
      q: hex.q,
      r: hex.r,
      terrain: hex.terrain,
      token: hex.token,
    })),
    harbors: state.board.harbors.map((harbor) => ({
      edge: required(
        graph.edgeIds.find((id) => id === harbor.edge),
        `harbor edge ${harbor.edge}`,
      ),
      kind: harbor.kind,
    })),
    roads: state.board.roads.map((road) => ({
      edge: required(
        graph.edgeIds.find((id) => id === road.edge),
        `road edge ${road.edge}`,
      ),
      seat: road.seat,
    })),
    buildings: state.board.buildings.map((building) => ({
      vertex: required(
        graph.vertexIds.find((id) => id === building.vertex),
        `building vertex ${building.vertex}`,
      ),
      seat: building.seat,
      kind: building.kind === 'city' ? 'city' : 'settlement',
    })),
    robberHex:
      state.board.robberHex === null
        ? null
        : required(
            graph.hexIds.find((id) => id === state.board.robberHex),
            `robber hex ${state.board.robberHex}`,
          ),
  };
}

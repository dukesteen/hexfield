import { engineForConfig } from '@cp2p/engine';
import type { GameState, Seat } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import type { HexId, VertexId } from '@cp2p/engine/geometry';
import type { RenderModel } from '@cp2p/renderer';
import { uiModulesFor } from '../modules';

export type BoardViewer = Seat | 'spectator';

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Invalid board ${label}`);
  return value;
}

/** Derive only public board data; viewer is intentionally not used to reveal private state. */
/** Slices of the render model for module renderer plugins, when any module registers one. */
function moduleLayerSlices(state: Readonly<GameState>): { layers?: Record<string, unknown> } {
  const modules = uiModulesFor(state.config.modules.map((module) => module.id));
  const plugins = modules.flatMap(({ ui }) => ui.RenderLayers ?? []);
  if (plugins.length === 0) return {};
  const hints = engineForConfig(state.config).hooks.renderHints(state, []);
  return {
    layers: Object.fromEntries(
      plugins.map((layer) => [layer.plugin.id, layer.slice(state, hints)]),
    ),
  };
}

/** Seafaring's public pieces: the pirate and the island-bonus chits, read from render hints. */
function seafaringSlices(
  state: Readonly<GameState>,
  hexIds: readonly HexId[],
  vertexIds: readonly VertexId[],
): Pick<RenderModel, 'pirateHex' | 'islandBonuses'> {
  const hints = engineForConfig(state.config).hooks.renderHints(state, []);
  const pirate = hints.find((hint) => hint.module === 'seafaring' && hint.kind === 'pirate');
  const hex = hexIds.find((id) => id === pirate?.hex) ?? null;
  const options: unknown = state.config.options.seafaring;
  const bonus =
    typeof options === 'object' && options !== null && 'islandBonus' in options
      ? options.islandBonus
      : null;
  const vp =
    typeof bonus === 'object' && bonus !== null && 'vp' in bonus && typeof bonus.vp === 'number'
      ? bonus.vp
      : 1;
  return {
    pirateHex: hex,
    islandBonuses: hints.flatMap((hint) => {
      const vertex = vertexIds.find((id) => id === hint.vertex);
      const seat = state.config.seats.find((candidate) => candidate === hint.seat);
      return hint.module === 'seafaring' &&
        hint.kind === 'island-bonus' &&
        vertex !== undefined &&
        seat !== undefined
        ? [{ vertex, seat, vp }]
        : [];
    }),
  };
}

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
    ...(state.board.ships
      ? {
          ships: state.board.ships.map((ship) => ({
            edge: required(
              graph.edgeIds.find((id) => id === ship.edge),
              `ship edge ${ship.edge}`,
            ),
            seat: ship.seat,
          })),
          ...seafaringSlices(state, graph.hexIds, graph.vertexIds),
        }
      : {}),
    ...(state.board.fixtures?.length
      ? {
          fixtures: state.board.fixtures.map((fixture) => ({
            id: fixture.id,
            module: fixture.module,
            footprint: fixture.footprint.map(({ q, r }) => ({ q, r })),
            orientation: fixture.orientation,
            art: fixture.art,
          })),
        }
      : {}),
    ...moduleLayerSlices(state),
    robberHex:
      state.board.robberHex === null
        ? null
        : required(
            graph.hexIds.find((id) => id === state.board.robberHex),
            `robber hex ${state.board.robberHex}`,
          ),
  };
}

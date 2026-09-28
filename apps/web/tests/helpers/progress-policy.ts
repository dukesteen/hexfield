import {
  CITY_COST,
  SETTLEMENT_COST,
  ROAD_COST,
  RESOURCES,
  engineForConfig,
  enumerateCommands,
} from '@cp2p/engine';
import type { CommandShape, Pending, ResourceCounts } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import type { Bot, BotRng, BotView } from '@cp2p/bots';

const terrainResource: Readonly<Record<string, string>> = {
  mountains: 'ore',
  fields: 'grain',
  hills: 'brick',
  forest: 'lumber',
  pasture: 'wool',
};
const deficit = (cost: ResourceCounts, hand: Readonly<Record<string, number>>) =>
  RESOURCES.reduce((sum, resource) => sum + Math.max(0, cost[resource] - (hand[resource] ?? 0)), 0);

/** Test-only race to the next legal VP. Reads only public state and the acting seat's hand. */
export function progressCommand(
  view: BotView,
  pending: Pending,
  rng: BotRng,
  delegate: Bot,
): CommandShape {
  if (pending.kind !== 'player' || pending.seat !== view.seat)
    throw new Error('Progress policy requires own pending');
  const phase = view.state.turn.phase.at(-1)?.id;
  if (phase !== 'main' && !pending.allowed.includes('PLACE_SETTLEMENT'))
    return delegate.decide(view, pending, rng);
  if (phase === 'main' && !pending.allowed.includes('END_TURN'))
    return delegate.decide(view, pending, rng);
  const candidates = enumerateCommands(engineForConfig(view.state.config), view.state, view.seat, view.priv, {
    candidateFilter: (command) =>
      pending.allowed.includes(command.type) &&
      [
        'PLACE_SETTLEMENT',
        'BUILD_CITY',
        'BUILD_SETTLEMENT',
        'BUILD_ROAD',
        'MARITIME_TRADE',
        'END_TURN',
      ].includes(command.type),
  });
  const graph = buildBoardGraph(view.state.board.hexes);
  const buildings = new Map(view.state.board.buildings.map((piece) => [piece.vertex, piece]));
  const hexes = new Map(view.state.board.hexes.map((hex) => [hex.id, hex]));
  const produced = new Set<string>();
  for (const piece of view.state.board.buildings.filter((owned) => owned.seat === view.seat)) {
    for (const hex of graph.vertexHexes[graph.vertexIndex[piece.vertex] ?? -1] ?? []) {
      const terrain = hexes.get(hex)?.terrain;
      if (terrain && terrainResource[terrain]) produced.add(terrainResource[terrain]);
    }
  }
  const score = (command: CommandShape) =>
    (graph.vertexHexes[graph.vertexIndex[String(command.vertex)] ?? -1] ?? []).reduce((sum, id) => {
      const hex = hexes.get(id);
      const pips = hex?.token ? 6 - Math.abs(7 - hex.token) : 0;
      const resource = hex ? terrainResource[hex.terrain] : undefined;
      return (
        sum +
        pips * (resource === 'ore' || resource === 'grain' ? 2 : 1) +
        (resource && !produced.has(resource) ? 2 : 0)
      );
    }, 0);
  const bestBuild = (commands: CommandShape[]) =>
    commands.toSorted((a, b) => score(b) - score(a))[0];
  const placement = bestBuild(candidates.filter((command) => command.type === 'PLACE_SETTLEMENT'));
  if (placement) return placement;
  const immediate = bestBuild(
    candidates.filter(
      (command) => command.type === 'BUILD_CITY' || command.type === 'BUILD_SETTLEMENT',
    ),
  );
  if (immediate) return immediate;
  const holder = view.state.seats.find((seat) => seat.seat === view.seat);
  if (!holder) throw new Error('Missing policy seat');
  const ownRoads = new Set(
    view.state.board.roads.filter((road) => road.seat === view.seat).map((road) => road.edge),
  );
  const occupiedRoads = new Set(view.state.board.roads.map((road) => road.edge));
  const open = (vertex: string) =>
    !buildings.has(vertex) &&
    !(graph.vertexNeighbors[graph.vertexIndex[vertex] ?? -1] ?? []).some((neighbor) =>
      buildings.has(neighbor),
    );
  const connected = (vertex: string) =>
    (graph.vertexEdges[graph.vertexIndex[vertex] ?? -1] ?? []).some((edge) => ownRoads.has(edge));
  const extenders = new Set<string>();
  for (const edge of graph.edgeIds) {
    if (occupiedRoads.has(edge)) continue;
    const vertices = graph.edgeVertices[graph.edgeIndex[edge] ?? -1] ?? [];
    if (
      vertices.some(
        (vertex) =>
          open(vertex) &&
          vertices.some(
            (other) =>
              other !== vertex &&
              connected(other) &&
              (!buildings.has(other) || buildings.get(other)?.seat === view.seat),
          ),
      )
    )
      extenders.add(edge);
  }
  const targets: { cost: ResourceCounts; road: boolean }[] = [];
  if (
    (holder.piecesLeft.city ?? 0) > 0 &&
    view.state.board.buildings.some(
      (piece) => piece.seat === view.seat && piece.kind === 'settlement',
    )
  )
    targets.push({ cost: CITY_COST, road: false });
  if ((holder.piecesLeft.settlement ?? 0) > 0) {
    if (graph.vertexIds.some((vertex) => open(vertex) && connected(vertex)))
      targets.push({ cost: SETTLEMENT_COST, road: false });
    if ((holder.piecesLeft.road ?? 0) > 0 && extenders.size)
      targets.push({
        cost: {
          brick: ROAD_COST.brick + SETTLEMENT_COST.brick,
          lumber: ROAD_COST.lumber + SETTLEMENT_COST.lumber,
          wool: SETTLEMENT_COST.wool,
          grain: SETTLEMENT_COST.grain,
          ore: 0,
        },
        road: true,
      });
  }
  const target = targets.toSorted(
    (a, b) => deficit(a.cost, view.priv.hand) - deficit(b.cost, view.priv.hand),
  )[0];
  if (target) {
    const road = target.road
      ? candidates.find(
          (command) => command.type === 'BUILD_ROAD' && extenders.has(String(command.edge)),
        )
      : undefined;
    if (road) return road;
    const before = deficit(target.cost, view.priv.hand);
    const trades = candidates
      .filter((command) => command.type === 'MARITIME_TRADE')
      .map((command) => {
        const next = { ...view.priv.hand };
        for (const resource of RESOURCES) {
          const give =
            typeof command.give === 'object' && command.give !== null
              ? Reflect.get(command.give, resource)
              : 0;
          const get =
            typeof command.get === 'object' && command.get !== null
              ? Reflect.get(command.get, resource)
              : 0;
          next[resource] =
            (next[resource] ?? 0) -
            (typeof give === 'number' ? give : 0) +
            (typeof get === 'number' ? get : 0);
        }
        return { command, missing: deficit(target.cost, next) };
      })
      .filter((trade) => trade.missing < before)
      .toSorted((a, b) => a.missing - b.missing);
    if (trades[0]) return trades[0].command;
  }
  const end = candidates.find((command) => command.type === 'END_TURN');
  if (!end) return delegate.decide(view, pending, rng);
  return end;
}

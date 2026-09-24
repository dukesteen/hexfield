import { createBaseEngine, enumerateCommands } from '@cp2p/engine';
import type { CommandShape, Engine, Pending, TradeOffer } from '@cp2p/engine';
import type { Resource, ResourceCounts } from '@cp2p/engine';
import { RESOURCES } from '@cp2p/engine';
import { createRng } from '@cp2p/engine/rng';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import type { BoardGraph } from '@cp2p/engine/geometry';
import type { Bot, BotRng, BotView } from './types.js';

/** The seed belongs to this bot and game, never to the public rules engine. */
export function createBotRng(seed: Uint8Array): BotRng {
  return createRng(seed);
}

const CITY_COST = { brick: 0, lumber: 0, wool: 0, grain: 2, ore: 3 };
const SETTLEMENT_COST = { brick: 1, lumber: 1, wool: 1, grain: 1, ore: 0 };
const ROAD_COST = { brick: 1, lumber: 1, wool: 0, grain: 0, ore: 0 };
const DEV_COST = { brick: 0, lumber: 0, wool: 1, grain: 1, ore: 1 };
const graphs = new WeakMap<BotView['state']['board']['hexes'], BoardGraph>();

function boardGraph(view: BotView): BoardGraph {
  const hexes = view.state.board.hexes;
  let graph = graphs.get(hexes);
  if (!graph) {
    graph = buildBoardGraph(hexes);
    graphs.set(hexes, graph);
  }
  return graph;
}

function openSites(view: BotView, graph: BoardGraph): Set<string> {
  const buildings = new Set(view.state.board.buildings.map((piece) => piece.vertex));
  return new Set(
    graph.vertexIds.filter((vertex) => {
      const index = graph.vertexIndex[vertex];
      return (
        index !== undefined &&
        !buildings.has(vertex) &&
        !(graph.vertexNeighbors[index] ?? []).some((neighbor) => buildings.has(neighbor))
      );
    }),
  );
}

function connectedSite(view: BotView, graph: BoardGraph, sites: ReadonlySet<string>): boolean {
  const roads = new Set(
    view.state.board.roads.filter((road) => road.seat === view.seat).map((road) => road.edge),
  );
  return [...sites].some((vertex) => {
    const index = graph.vertexIndex[vertex];
    return index !== undefined && (graph.vertexEdges[index] ?? []).some((edge) => roads.has(edge));
  });
}

function productiveSettlements(
  commands: readonly CommandShape[],
  view: BotView,
  graph: BoardGraph,
): CommandShape[] {
  const settlements = commands.filter(
    (command) =>
      (command.type === 'PLACE_SETTLEMENT' || command.type === 'BUILD_SETTLEMENT') &&
      typeof command.vertex === 'string',
  );
  if (settlements.length < 2) return [...commands];
  const tokens = new Map(view.state.board.hexes.map((hex) => [hex.id, hex.token]));
  const score = (command: CommandShape): number => {
    const index = graph.vertexIndex[String(command.vertex)];
    if (index === undefined) return 0;
    return (graph.vertexHexes[index] ?? []).reduce((total, hex) => {
      const token = tokens.get(hex);
      return total + (token === null || token === undefined ? 0 : 6 - Math.abs(7 - token));
    }, 0);
  };
  const best = Math.max(...settlements.map(score));
  return commands.filter((command) => !settlements.includes(command) || score(command) >= best - 2);
}

function targetCost(view: BotView, hasSettlementSite: boolean): ResourceCounts | null {
  const seat = view.state.seats.find((holder) => holder.seat === view.seat);
  if (!seat) throw new Error('Bot seat is absent from the game');
  const canUpgrade =
    (seat.piecesLeft.city ?? 0) > 0 &&
    view.state.board.buildings.some(
      (building) => building.seat === view.seat && building.kind === 'settlement',
    );
  if (hasSettlementSite && (seat.piecesLeft.settlement ?? 0) > 0) {
    if (canUpgrade) {
      const missing = (cost: ResourceCounts): number =>
        RESOURCES.reduce(
          (total, resource) =>
            total + Math.max(0, cost[resource] - (view.priv.hand[resource] ?? 0)),
          0,
        );
      if (missing(CITY_COST) <= missing(SETTLEMENT_COST)) return CITY_COST;
    }
    return SETTLEMENT_COST;
  }
  if (canUpgrade) return CITY_COST;
  return (seat.piecesLeft.settlement ?? 0) > 0 && (seat.piecesLeft.road ?? 0) > 0
    ? ROAD_COST
    : null;
}

function canSpendWithoutBreakingGoal(
  hand: Readonly<Record<string, number>>,
  spent: ResourceCounts,
  goal: ResourceCounts | null,
): boolean {
  return (
    !goal ||
    RESOURCES.every(
      (resource) =>
        spent[resource] === 0 || (hand[resource] ?? 0) - spent[resource] >= goal[resource],
    )
  );
}

function goalResource(view: BotView, cost: ResourceCounts | null): Resource | null {
  if (!cost) return null;
  const priority: readonly Resource[] =
    cost === CITY_COST
      ? ['ore', 'grain']
      : cost === ROAD_COST
        ? ['brick', 'lumber']
        : ['brick', 'lumber', 'wool', 'grain'];
  return priority.find((resource) => (view.priv.hand[resource] ?? 0) < cost[resource]) ?? null;
}

function oneResourceField(value: unknown): { resource: Resource; count: number } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  const resource = keys[0];
  if (resource === undefined) return null;
  const count = Reflect.get(value, resource);
  if (typeof count !== 'number') return null;
  switch (resource) {
    case 'brick':
    case 'lumber':
    case 'wool':
    case 'grain':
    case 'ore':
      return { resource, count };
    default:
      return null;
  }
}

function usefulTrade(
  command: CommandShape,
  view: BotView,
  cost: ResourceCounts | null,
  goal: Resource | null,
): boolean {
  if (!goal) return false;
  const received = oneResourceField(command.type === 'MARITIME_TRADE' ? command.get : command.want);
  const given = oneResourceField(command.give);
  return (
    received?.resource === goal &&
    !!given &&
    (view.priv.hand[given.resource] ?? 0) - given.count >= (cost?.[given.resource] ?? 0)
  );
}

function commandWeight(type: string, offersThisTurn: number, totalOffers: number): number {
  if (type === 'BUILD_SETTLEMENT') return 30;
  if (type === 'BUILD_CITY') return 30;
  if (type === 'BUILD_ROAD') return 12;
  if (type === 'BUY_DEV_CARD' || type === 'PLAY_DEV_CARD') return 8;
  if (type === 'OFFER_TRADE' || type === 'PROPOSE_TRADE')
    return offersThisTurn >= 1 || totalOffers >= 8 ? 0 : 1;
  if (type === 'MARITIME_TRADE') return 2;
  if (type === 'END_TURN') return offersThisTurn >= 1 ? 8 : 4;
  return 5;
}

function weightedChoice(
  commands: readonly CommandShape[],
  offersThisTurn: number,
  totalOffers: number,
  rng: BotRng,
): CommandShape {
  const groups = new Map<string, CommandShape[]>();
  for (const command of commands) {
    const group = groups.get(command.type) ?? [];
    group.push(command);
    groups.set(command.type, group);
  }
  const total = [...groups.keys()].reduce(
    (sum, type) => sum + commandWeight(type, offersThisTurn, totalOffers),
    0,
  );
  if (total <= 0) {
    const fallback = commands[rng.int(commands.length)];
    if (!fallback) throw new Error('No legal command');
    return fallback;
  }
  let index = rng.int(total);
  for (const [type, group] of groups) {
    index -= commandWeight(type, offersThisTurn, totalOffers);
    if (index < 0) {
      const chosen = group[rng.int(group.length)];
      if (chosen) return chosen;
    }
  }
  throw new Error('Bot RNG returned an out-of-range choice');
}

/** Small, reproducible policy for simulation and offline play. */
export class RandomBot implements Bot {
  readonly id = 'random';
  private gameConfig: BotView['state']['config'] | null = null;
  private turnNumber = -1;
  private offersThisTurn = 0;
  private totalOffers = 0;

  constructor(private readonly engine: Engine = createBaseEngine()) {}

  respondToTrade(_view: BotView, _offer: TradeOffer, rng: BotRng): boolean {
    return rng.int(10) < 3;
  }

  decide(view: BotView, pending: Pending, rng: BotRng): CommandShape {
    if (view.priv.seat !== view.seat || pending.kind !== 'player' || pending.seat !== view.seat)
      throw new Error('Bot decision requires its own player pending');
    if (this.gameConfig !== view.state.config) {
      this.gameConfig = view.state.config;
      this.turnNumber = -1;
      this.totalOffers = 0;
    }
    if (this.turnNumber !== view.state.turn.number) {
      this.turnNumber = view.state.turn.number;
      this.offersThisTurn = 0;
    }
    if (view.state.turn.phase.at(-1)?.id === 'preRoll') {
      const legal = this.engine.getLegalCommands(view.state, view.seat, view.priv);
      const sole = legal.templates.length === 0 ? legal.commands[0] : undefined;
      if (legal.commands.length === 1 && sole && pending.allowed.includes(sole.type)) return sole;
    }
    const graph = boardGraph(view);
    const sites = openSites(view, graph);
    const hasSettlementSite = connectedSite(view, graph, sites);
    const cost = targetCost(view, hasSettlementSite);
    const goal = goalResource(view, cost);
    const withinPending = (command: CommandShape): boolean =>
      pending.allowed.includes(command.type);
    const policyFilter = (command: CommandShape): boolean => {
      if (!withinPending(command)) return false;
      if (command.type === 'BUILD_ROAD' && hasSettlementSite) return false;
      if (
        command.type === 'BUILD_SETTLEMENT' &&
        cost === CITY_COST &&
        !canSpendWithoutBreakingGoal(view.priv.hand, SETTLEMENT_COST, CITY_COST)
      )
        return false;
      if (
        command.type === 'OFFER_TRADE' ||
        command.type === 'PROPOSE_TRADE' ||
        command.type === 'MARITIME_TRADE'
      ) {
        if (commandWeight(command.type, this.offersThisTurn, this.totalOffers) === 0) return false;
        return usefulTrade(command, view, cost, goal);
      }
      if (
        command.type === 'BUY_DEV_CARD' &&
        !canSpendWithoutBreakingGoal(view.priv.hand, DEV_COST, cost)
      )
        return false;
      return true;
    };
    const options = { sampleIndex: (maxExclusive: number) => rng.int(maxExclusive) };
    const preferred = enumerateCommands(this.engine, view.state, view.seat, view.priv, {
      ...options,
      candidateFilter: policyFilter,
    });
    const commands = preferred.length
      ? preferred
      : enumerateCommands(this.engine, view.state, view.seat, view.priv, {
          ...options,
          candidateFilter: withinPending,
        });
    if (commands.length === 0) throw new Error(`No legal command for seat ${view.seat}`);
    const responses = commands.filter((command) => command.type === 'RESPOND_TRADE');
    if (responses.length) {
      const accept = rng.int(10) < 3;
      const matching =
        responses.find((command) => command.accept === accept) ??
        responses.find((command) => command.accept === false);
      if (matching) return matching;
    }
    const roadExtenders = commands.filter((command) => {
      if (command.type !== 'BUILD_ROAD' || typeof command.edge !== 'string') return false;
      const index = graph.edgeIndex[command.edge];
      return (
        index !== undefined && (graph.edgeVertices[index] ?? []).some((vertex) => sites.has(vertex))
      );
    });
    const focused = roadExtenders.length
      ? commands.filter(
          (command) => command.type !== 'BUILD_ROAD' || roadExtenders.includes(command),
        )
      : commands;
    const discards = focused.filter((command) => command.type === 'DISCARD');
    if (discards.length > 1 && cost) {
      const lostGoal = (command: CommandShape): number => {
        const cards = command.cards;
        if (typeof cards !== 'object' || cards === null || Array.isArray(cards)) return Infinity;
        return RESOURCES.reduce((total, resource) => {
          const discarded = Reflect.get(cards, resource);
          return (
            total +
            Math.max(
              0,
              cost[resource] -
                (view.priv.hand[resource] ?? 0) +
                (typeof discarded === 'number' ? discarded : 0),
            )
          );
        }, 0);
      };
      const least = Math.min(...discards.map(lostGoal));
      const safest = discards.filter((command) => lostGoal(command) === least);
      const selected = safest[rng.int(safest.length)];
      if (!selected) throw new Error('No discard choice');
      return selected;
    }
    const selected = weightedChoice(
      productiveSettlements(focused, view, graph),
      this.offersThisTurn,
      this.totalOffers,
      rng,
    );
    if (selected.type === 'OFFER_TRADE' || selected.type === 'PROPOSE_TRADE') {
      this.offersThisTurn++;
      this.totalOffers++;
    }
    return selected;
  }
}

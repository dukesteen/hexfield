import {
  RESOURCES,
  type GameEvent,
  type GameState,
  type Resource,
  type ResourceCounts,
  type Seat,
} from '@cp2p/engine';
import { buildBoardGraph, type EdgeId, type HexId, type VertexId } from '@cp2p/engine/geometry';
import type { BoardEffect } from '@cp2p/renderer';

const terrainResource: Readonly<Record<string, Resource | null>> = {
  hills: 'brick',
  forest: 'lumber',
  pasture: 'wool',
  fields: 'grain',
  mountains: 'ore',
  desert: null,
};

export interface ResourceFlight {
  readonly id: string;
  readonly seat: Seat;
  readonly resource: Resource;
  readonly count: number;
  readonly fromHex: HexId;
}

export interface TradeCardFlight {
  readonly id: string;
  readonly from: Seat;
  readonly to: Seat;
  readonly resource: Resource;
  readonly count: number;
}

export interface StealCardFlight {
  readonly id: string;
  readonly from: Seat;
  readonly to: Seat;
}

export interface ProductionGain {
  readonly id: string;
  readonly seat: Seat;
  readonly resources: Partial<ResourceCounts>;
}

interface PublicTradeTerms {
  readonly id: number;
  readonly proposer: Seat;
  readonly give: ResourceCounts;
  readonly want: ResourceCounts;
}

export interface VisualEffects {
  readonly board: readonly BoardEffect[];
  readonly flights: readonly ResourceFlight[];
  readonly tradeFlights: readonly TradeCardFlight[];
  readonly stealFlights: readonly StealCardFlight[];
  readonly productionGains: readonly ProductionGain[];
}

function isEdgeId(value: unknown): value is EdgeId {
  return typeof value === 'string' && /^e:-?\d+,-?\d+,(NE|NW|W)$/.test(value);
}

function isVertexId(value: unknown): value is VertexId {
  return typeof value === 'string' && /^v:-?\d+,-?\d+,(N|S)$/.test(value);
}

function isHexId(value: unknown): value is HexId {
  return typeof value === 'string' && /^h:-?\d+,-?\d+$/.test(value);
}

function isSeat(state: GameState, value: unknown): value is Seat {
  return typeof value === 'number' && state.config.seats.some((seat) => seat === value);
}

function isDice(value: unknown): value is readonly [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((face) => typeof face === 'number' && face >= 1 && face <= 6)
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validResourceCounts(counts: Record<string, unknown>): counts is ResourceCounts {
  return RESOURCES.every((resource) => {
    const count = counts[resource];
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
  });
}

function tradeOfferById(state: GameState, id: unknown): PublicTradeTerms | undefined {
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return undefined;
  const base = state.ext.base;
  if (!record(base) || !Array.isArray(base.offers)) return undefined;
  const offer = base.offers.find((candidate: unknown) => {
    return record(candidate) && candidate.id === id;
  });
  if (!record(offer)) return undefined;
  if (
    typeof offer.proposer !== 'number' ||
    !isSeat(state, offer.proposer) ||
    !record(offer.give) ||
    !record(offer.want)
  )
    return undefined;
  if (!validResourceCounts(offer.give) || !validResourceCounts(offer.want)) return undefined;
  return {
    id,
    proposer: offer.proposer,
    give: offer.give,
    want: offer.want,
  };
}

/** Translate an accepted public event batch into rule-neutral, deduplicated motion cues. */
export function deriveVisualEffects(
  before: GameState,
  after: GameState,
  events: readonly GameEvent[],
  revision: number,
): VisualEffects {
  if (events.length === 0)
    return { board: [], flights: [], tradeFlights: [], stealFlights: [], productionGains: [] };
  const board: BoardEffect[] = [];
  const flights: ResourceFlight[] = [];
  const tradeFlights: TradeCardFlight[] = [];
  const stealFlights: StealCardFlight[] = [];
  const productionGains: ProductionGain[] = [];
  const rolled = events.find((event) => event.type === 'diceRolled');
  const roll = rolled && 'roll' in rolled && typeof rolled.roll === 'number' ? rolled.roll : null;
  const graph =
    roll !== null && events.some((event) => event.type === 'resourcesProduced')
      ? buildBoardGraph(after.board.hexes)
      : null;
  for (const [index, event] of events.entries()) {
    const id = `${revision}:${index}`;
    if (event.type === 'diceRolled' && 'dice' in event && isDice(event.dice)) {
      board.push({ id, kind: 'dice-roll', dice: [event.dice[0], event.dice[1]] });
    } else if (event.type === 'roadBuilt' && isSeat(after, event.seat) && isEdgeId(event.edge)) {
      board.push({
        id,
        kind: 'piece-pop',
        piece: 'road',
        seat: event.seat,
        at: { kind: 'edge', id: event.edge },
      });
    } else if (
      (event.type === 'settlementBuilt' || event.type === 'cityBuilt') &&
      isSeat(after, event.seat) &&
      isVertexId(event.vertex)
    ) {
      board.push({
        id,
        kind: 'piece-pop',
        piece: event.type === 'cityBuilt' ? 'city' : 'settlement',
        seat: event.seat,
        at: { kind: 'vertex', id: event.vertex },
      });
    } else if (
      event.type === 'robberMoved' &&
      isHexId(before.board.robberHex) &&
      isHexId(event.hex)
    ) {
      board.push({ id, kind: 'robber-move', fromHex: before.board.robberHex, toHex: event.hex });
    } else if (
      event.type === 'tradeConfirmed' &&
      'offerId' in event &&
      'withSeat' in event &&
      isSeat(after, event.withSeat)
    ) {
      const offer = tradeOfferById(before, event.offerId);
      if (!offer || offer.proposer === event.withSeat) continue;
      for (const [from, to, counts, direction] of [
        [offer.proposer, event.withSeat, offer.give, 'give'],
        [event.withSeat, offer.proposer, offer.want, 'want'],
      ] as const) {
        for (const resource of RESOURCES) {
          const count = counts[resource];
          if (count > 0) {
            tradeFlights.push({
              id: `${id}:trade:${offer.id}:${direction}:${resource}`,
              from,
              to,
              resource,
              count,
            });
          }
        }
      }
    } else if (
      event.type === 'resourceStolen' &&
      isSeat(after, event.victim) &&
      isSeat(after, event.thief) &&
      event.victim !== event.thief
    ) {
      stealFlights.push({ id: `${id}:steal`, from: event.victim, to: event.thief });
    } else if (event.type === 'resourcesProduced' && record(event.bySeat)) {
      for (const seat of after.config.seats) {
        const gains = event.bySeat[String(seat)];
        if (!record(gains)) continue;
        const resources: Partial<Record<Resource, number>> = {};
        for (const resource of RESOURCES) {
          const gained = gains[resource];
          if (typeof gained !== 'number' || !Number.isSafeInteger(gained) || gained <= 0) continue;
          resources[resource] = gained;
        }
        if (Object.keys(resources).length === 0) continue;
        productionGains.push({ id: `${id}:${seat}`, seat, resources });
        if (!graph || roll === null) continue;
        for (const resource of RESOURCES) {
          const gained = resources[resource] ?? 0;
          if (gained <= 0) continue;
          const sources = after.board.hexes
            .flatMap((hex) => {
              if (
                hex.token !== roll ||
                hex.id === after.board.robberHex ||
                terrainResource[hex.terrain] !== resource ||
                !isHexId(hex.id)
              )
                return [];
              const hexIndex = graph.hexIndex[hex.id];
              const vertices = hexIndex === undefined ? [] : (graph.hexVertices[hexIndex] ?? []);
              const demand = after.board.buildings.reduce(
                (count, building) =>
                  building.seat === seat && vertices.some((vertex) => vertex === building.vertex)
                    ? count + (building.kind === 'city' ? 2 : 1)
                    : count,
                0,
              );
              return demand > 0 ? [{ hex: hex.id, demand }] : [];
            })
            .toSorted((a, b) => (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0));
          let remaining = gained;
          for (const [sourceIndex, source] of sources.entries()) {
            if (remaining <= 0) break;
            const count = Math.min(remaining, source.demand);
            flights.push({
              id: `${id}:${seat}:${resource}:${sourceIndex}`,
              seat,
              resource,
              count,
              fromHex: source.hex,
            });
            remaining -= count;
          }
        }
      }
    }
  }
  return { board, flights, tradeFlights, stealFlights, productionGains };
}

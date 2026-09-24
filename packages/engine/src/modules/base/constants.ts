import { zeroCounts } from '../../core/resources/index.js';
import { RESOURCES } from '../../core/types/index.js';
import type { Resource, ResourceCounts } from '../../core/types/index.js';

export const BASE_VERSION = '1.0.0';
export const BANK_START = Object.freeze({ brick: 19, lumber: 19, wool: 19, grain: 19, ore: 19 });
export const PIECES_START = Object.freeze({ settlement: 5, city: 4, road: 15 });
export const ROAD_COST = Object.freeze({ brick: 1, lumber: 1, wool: 0, grain: 0, ore: 0 });
export const SETTLEMENT_COST = Object.freeze({ brick: 1, lumber: 1, wool: 1, grain: 1, ore: 0 });
export const CITY_COST = Object.freeze({ brick: 0, lumber: 0, wool: 0, grain: 2, ore: 3 });
export const DEV_COST = Object.freeze({ brick: 0, lumber: 0, wool: 1, grain: 1, ore: 1 });
export const DEV_CARD_COUNTS = Object.freeze({
  knight: 14,
  victoryPoint: 5,
  roadBuilding: 2,
  yearOfPlenty: 2,
  monopoly: 2,
});
export type DevCard = keyof typeof DEV_CARD_COUNTS;

export const TERRAIN_RESOURCE: Readonly<Record<string, Resource | null>> = Object.freeze({
  hills: 'brick',
  forest: 'lumber',
  pasture: 'wool',
  fields: 'grain',
  mountains: 'ore',
  desert: null,
});

export function emptyResources(): Record<Resource, number> {
  return zeroCounts(RESOURCES);
}

export function oneResource(resource: Resource, amount: number): ResourceCounts {
  return { ...emptyResources(), [resource]: amount };
}

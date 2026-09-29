import type { CardCounts, Resource, Seat } from '../../core/types/index.js';
import type { BaseOptions } from './config.js';

export interface TradeOffer {
  id: number;
  proposer: Seat;
  give: CardCounts;
  want: CardCounts;
  to: Seat[];
  acceptedBy: Seat[];
  declinedBy: Seat[];
  valid: boolean;
}

export interface BaseExt {
  knightsPlayed: number[];
  devPlayedTurn: number | null;
  offers: TradeOffer[];
  diceDeck: number[];
}

export interface SetupData {
  startSeat: Seat | null;
  order: Seat[];
  index: number;
  step: 'settlement' | 'road';
  lastVertex: string | null;
}

export interface DiscardData {
  remaining: Seat[];
}
export interface RobberData {
  returnTo: 'main' | 'pop';
}
export interface StealData {
  targets: Seat[];
  thief: Seat;
  returnTo: 'main' | 'pop';
}
export interface StealResultData {
  thief: Seat;
  victim: Seat;
  returnTo: 'main' | 'pop';
}
export interface DrawData {
  seat: Seat;
  slotId: string;
  /** Private deck being drawn; absent means the base `dev` deck. */
  deck?: string;
}
export interface RoadBuildingData {
  remaining: number;
}
export interface MonopolyData {
  seat: Seat;
  /** The card kind named: a base resource, or a module's kind such as a commodity. */
  resource: Resource;
  remaining: Seat[];
  /** Most cards taken from each seat (a progress card monopoly); absent takes all of them. */
  limit?: number;
}

export function baseOptions(value: unknown): BaseOptions {
  if (typeof value !== 'object' || value === null)
    throw new Error('Missing normalized base options');
  // OptionSchema validates every field at genesis; this cast only restores its static shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as BaseOptions;
}

export function baseExt(value: unknown): BaseExt {
  if (typeof value !== 'object' || value === null) throw new Error('Missing base state');
  // Base genesis and handlers own this extension slot.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as BaseExt;
}

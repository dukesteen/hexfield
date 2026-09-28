/** A base-game resource kind. Expansion modules can add other card kinds. */
export type Resource = 'brick' | 'lumber' | 'wool' | 'grain' | 'ore';

/** Base resources in their stable canonical order. */
export const RESOURCES: readonly Resource[] = Object.freeze([
  'brick',
  'lumber',
  'wool',
  'grain',
  'ore',
]);

/** A string-keyed count map shared by base resources and expansion card kinds. */
export type CountMap<K extends string = string> = Readonly<Record<K, number>>;

/** Card kinds use strings so modules can add commodities and other card types. */
export type CardKind = string;

/** Exact base-game resource counts. */
export type ResourceCounts = CountMap<Resource>;

/** Counts over the card kinds of one game: base resources plus module kinds such as commodities. */
export type CardCounts = CountMap;

/** True for a base-game resource kind, false for a module's card kind such as a commodity. */
export function isBaseResource(value: unknown): value is Resource {
  return typeof value === 'string' && (RESOURCES as readonly string[]).includes(value);
}

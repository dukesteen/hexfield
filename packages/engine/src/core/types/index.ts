export { RESOURCES } from './resources.js';
export type { CardKind, CountMap, Resource, ResourceCounts } from './resources.js';
export { failure, ruleError, success } from './result.js';
export type { Result, RuleError } from './result.js';

/** A player seat in a base or expansion game. */
export type Seat = 0 | 1 | 2 | 3 | 4 | 5;

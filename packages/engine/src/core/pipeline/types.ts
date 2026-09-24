import type { Seat } from '../types/index.js';
import type { ResourceBounds } from '../resources/index.js';

export interface CommandShape {
  type: string;
  [key: string]: unknown;
}

export interface CommandInput {
  kind: 'command';
  seat: Seat;
  command: CommandShape;
}

export interface SystemInput {
  kind: 'system';
  type: string;
  [key: string]: unknown;
}

export type Input = CommandInput | SystemInput;

export interface RandomRequest {
  type: string;
  [key: string]: unknown;
}

export interface RevealRequest {
  type: string;
  [key: string]: unknown;
}

export interface TimerSpec {
  phase: string;
  seconds: number;
}

export type Pending =
  | { kind: 'player'; seat: Seat; allowed: string[]; deadline?: TimerSpec }
  | { kind: 'random'; request: RandomRequest; systemType: string }
  | { kind: 'reveal'; seat: Seat; request: RevealRequest; systemType: string };

export interface CommandTemplate {
  type: string;
  count?: number;
  from?: ResourceBounds;
  [key: string]: unknown;
}

export interface LegalCommandSet {
  commands: CommandShape[];
  templates: CommandTemplate[];
}

/** Secrets delivered to one seat outside the replicated public input. */
export interface PrivateInputData {
  [key: string]: unknown;
}

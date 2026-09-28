import type { Engine } from '../../core/pipeline/index.js';
import type { GameConfig } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import { engineForModules, moduleSelection } from '../catalogue.js';
import { KNIGHTS_ID } from './config.js';

const SEATS: readonly Seat[] = [0, 1, 2, 3, 4, 5];

export interface KnightsConfigOptions {
  seats?: number;
  fiveSix?: boolean;
  base?: Record<string, unknown>;
}

/** A genesis config for a Cities and Knights game (with five-six when asked). */
export function knightsConfig(options: KnightsConfigOptions = {}): GameConfig {
  const fiveSix = options.fiveSix === true;
  return {
    modules: moduleSelection(['base', ...(fiveSix ? ['five-six'] : []), KNIGHTS_ID]),
    seats: SEATS.slice(0, options.seats ?? (fiveSix ? 5 : 3)),
    options: { base: { ...options.base } },
  };
}

/** An engine with base and knights, plus five-six when asked. */
export function knightsEngine(fiveSix = false): Engine {
  return engineForModules(moduleSelection(['base', ...(fiveSix ? ['five-six'] : []), KNIGHTS_ID]));
}

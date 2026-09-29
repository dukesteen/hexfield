import type { Engine } from '../../core/pipeline/index.js';
import type { GameConfig } from '../../core/state/index.js';
import { engineForModules, moduleSelection } from '../catalogue.js';
import { KNIGHTS_ID } from '../knights/config.js';
import { seafaringConfig } from '../seafaring/testing.js';
import type { SeafaringConfigOptions } from '../seafaring/testing.js';
import { COMBO_ID } from './types.js';

export type SeafarersKnightsConfigOptions = SeafaringConfigOptions;

function ids(fiveSix: boolean): string[] {
  return ['base', ...(fiveSix ? ['five-six'] : []), 'seafaring', KNIGHTS_ID, COMBO_ID];
}

/** A genesis config for seafaring with knights on the given board (default: `testArchipelago`). */
export function seafarersKnightsConfig(options: SeafarersKnightsConfigOptions = {}): GameConfig {
  const config = seafaringConfig({ seats: 3, ...options });
  return { ...config, modules: moduleSelection(ids(options.fiveSix === true)) };
}

/** An engine with base, seafaring, knights and the rules module, plus five-six when asked. */
export function seafarersKnightsEngine(fiveSix = false): Engine {
  return engineForModules(moduleSelection(ids(fiveSix)));
}

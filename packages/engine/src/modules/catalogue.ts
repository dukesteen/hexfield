import { createEngine } from '../core/pipeline/index.js';
import type { Engine } from '../core/pipeline/index.js';
import type { GameModule } from '../core/modules/index.js';
import type { GameConfig, ModuleSelection } from '../core/state/index.js';
import { failure } from '../core/types/index.js';
import type { Result } from '../core/types/index.js';
import { baseModule } from './base/index.js';
import { BASE_VERSION, DEV_CARD_COUNTS, devCardCatalogue } from './base/constants.js';
import { checkModuleCombination } from './compat.js';
import { FIVE_SIX_VERSION, fiveSixModule } from './five-six/index.js';

/** Every rules module a game can select, with the version genesis must name. */
export const MODULE_CATALOGUE: Readonly<
  Record<string, { version: string; create: () => GameModule }>
> = Object.freeze({
  base: { version: BASE_VERSION, create: baseModule },
  'five-six': { version: FIVE_SIX_VERSION, create: fiveSixModule },
});

/** The selection for a module list, with catalogue versions. */
export function moduleSelection(ids: readonly string[]): ModuleSelection[] {
  return ids.map((id) => {
    const entry = MODULE_CATALOGUE[id];
    if (!entry) throw new Error(`Unknown module ${id}`);
    return { id, version: entry.version };
  });
}

/** Check a genesis module selection against the catalogue and compatibility matrix. */
export function checkModuleSelection(selection: readonly ModuleSelection[]): Result<void> {
  if (!Array.isArray(selection) || selection.length === 0)
    return failure('module-selection', 'At least one module is required');
  const ids = selection.map((module) => module.id);
  if (new Set(ids).size !== ids.length)
    return failure('module-selection', 'A module is selected more than once');
  if (!ids.includes('base')) return failure('module-selection', 'The base module is required');
  for (const module of selection) {
    const entry = Object.hasOwn(MODULE_CATALOGUE, module.id)
      ? MODULE_CATALOGUE[module.id]
      : undefined;
    if (!entry) return failure('module-unknown', `Unknown module ${module.id}`);
    if (entry.version !== module.version)
      return failure('module-version', `No ${module.id} rules for version ${module.version}`);
  }
  return checkModuleCombination(ids, {
    viaScenario: ids.some((id) => id.startsWith('scenario:')),
  });
}

const engines = new Map<string, Engine>();

/** A cached rules engine for a validated module selection. Throws on an invalid selection. */
export function engineForModules(selection: readonly ModuleSelection[]): Engine {
  const checked = checkModuleSelection(selection);
  if (!checked.ok) throw new Error(checked.error.message);
  const key = selection
    .map((module) => `${module.id}@${module.version}`)
    .toSorted()
    .join(',');
  let engine = engines.get(key);
  if (!engine) {
    engine = createEngine(
      selection.map((module) => {
        const entry = MODULE_CATALOGUE[module.id];
        if (!entry) throw new Error(`Unknown module ${module.id}`);
        return entry.create();
      }),
    );
    engines.set(key, engine);
  }
  return engine;
}

/** The rules engine named by a genesis config. */
export function engineForConfig(config: Pick<GameConfig, 'modules'>): Engine {
  return engineForModules(config.modules);
}

/** Physical development cards for a game's module selection, in canonical order. */
export function devCardCatalogueFor(
  config: GameConfig,
): readonly Readonly<{ identity: string; card: string }>[] {
  return devCardCatalogue(engineForConfig(config).hooks.devDeck(config, DEV_CARD_COUNTS));
}

/** Development-card composition for a game's module selection. */
export function devCardCountsFor(config: GameConfig): Readonly<Record<string, number>> {
  return Object.freeze({ ...engineForConfig(config).hooks.devDeck(config, DEV_CARD_COUNTS) });
}

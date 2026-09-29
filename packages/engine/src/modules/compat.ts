import { failure, success } from '../core/types/index.js';
import type { Result } from '../core/types/index.js';

/** Expansion modules covered by the compatibility matrix (docs/11 A3). */
export const EXPANSION_IDS = ['five-six', 'seafaring', 'knights', 'frontier', 'explorers'] as const;
export type ExpansionId = (typeof EXPANSION_IDS)[number];

/**
 * `yes`: allowed and tested. `later`: allowed by the rules but disabled until the combined rules
 * are implemented and written in docs/rules/combos.md. `scenario`: allowed only through a scenario
 * that declares both modules (seafaring with knights: `scenario:seafarers-knights`, see
 * docs/rules/combos.md). `no`: never allowed.
 */
export type Compatibility = 'yes' | 'later' | 'scenario' | 'no';

type Matrix = Readonly<Record<ExpansionId, Readonly<Record<ExpansionId, Compatibility>>>>;

/** Symmetric pairwise matrix. The diagonal is unused. */
export const MODULE_COMPAT: Matrix = Object.freeze({
  'five-six': {
    'five-six': 'yes',
    seafaring: 'yes',
    knights: 'yes',
    frontier: 'scenario',
    explorers: 'no',
  },
  seafaring: {
    'five-six': 'yes',
    seafaring: 'yes',
    knights: 'scenario',
    frontier: 'no',
    explorers: 'no',
  },
  knights: {
    'five-six': 'yes',
    seafaring: 'scenario',
    knights: 'yes',
    frontier: 'scenario',
    explorers: 'no',
  },
  frontier: {
    'five-six': 'scenario',
    seafaring: 'no',
    knights: 'scenario',
    frontier: 'yes',
    explorers: 'no',
  },
  explorers: {
    'five-six': 'no',
    seafaring: 'no',
    knights: 'no',
    frontier: 'no',
    explorers: 'yes',
  },
});

function isExpansion(id: string): id is ExpansionId {
  return (EXPANSION_IDS as readonly string[]).includes(id);
}

/** Pairwise status for two module ids. Base and unlisted modules (tests, scenarios) are neutral. */
export function compatibility(a: string, b: string, viaScenario = false): Compatibility {
  if (!isExpansion(a) || !isExpansion(b) || a === b) return 'yes';
  const status = MODULE_COMPAT[a][b];
  return status === 'scenario' && viaScenario ? 'yes' : status;
}

/** Accept a module set only when every expansion pair is allowed now. */
export function checkModuleCombination(
  ids: readonly string[],
  options: { viaScenario?: boolean } = {},
): Result<void> {
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      if (a === undefined || b === undefined) continue;
      const status = compatibility(a, b, options.viaScenario === true);
      if (status !== 'yes')
        return failure(
          'module-incompatible',
          status === 'later'
            ? `${a} with ${b} is not available yet`
            : status === 'scenario'
              ? `${a} with ${b} needs a scenario that declares both`
              : `${a} cannot be combined with ${b}`,
        );
    }
  return success(undefined);
}

/**
 * Expansion ids a module must never be registered with. Scenario-only pairs are omitted here;
 * a scenario module declares them and the scenario catalogue checks the pair (docs/11 A5).
 */
export function incompatibleModules(id: string): string[] {
  return EXPANSION_IDS.filter((other) => {
    const status = compatibility(id, other);
    return status === 'no' || status === 'later';
  });
}

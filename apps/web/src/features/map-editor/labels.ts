import type { TFunction } from 'i18next';
import type { HarborKind, MapProblem } from '@cp2p/maps';

type T = TFunction<['editor', 'game', 'common', 'lobby']>;

/** A terrain's name, capitalised for palettes. */
export function terrainLabel(t: T, terrain: string): string {
  switch (terrain) {
    case 'forest':
      return t('editor:mapTerrainForest');
    case 'hills':
      return t('editor:mapTerrainHills');
    case 'pasture':
      return t('editor:mapTerrainPasture');
    case 'fields':
      return t('editor:mapTerrainFields');
    case 'mountains':
      return t('editor:mapTerrainMountains');
    case 'desert':
      return t('editor:mapTerrainDesert');
    case 'gold':
      return t('editor:mapTerrainGold');
    case 'fog':
      return t('editor:mapTerrainFog');
    default:
      return t('editor:mapTerrainSea');
  }
}

export function harborLabel(t: T, kind: HarborKind): string {
  switch (kind) {
    case 'generic':
      return t('editor:mapHarborGeneric');
    case 'brick':
      return t('common:harborBrick');
    case 'lumber':
      return t('common:harborLumber');
    case 'wool':
      return t('common:harborWool');
    case 'grain':
      return t('common:harborGrain');
    case 'ore':
      return t('common:harborOre');
    default:
      return t('common:harborUnknown');
  }
}

/** A validation finding as a sentence. */
export function problemText(t: T, problem: MapProblem): string {
  const values = problem.values ?? {};
  const count = (problem.hexes ?? problem.edges ?? []).length;
  switch (problem.code) {
    case 'no-land':
      return t('editor:mapProblemNoLand');
    case 'terrain-needs-seafaring':
      return t('editor:mapProblemTerrainNeedsSeafaring', { count });
    case 'missing-token':
      return t('editor:mapProblemMissingToken', { count });
    case 'token-on-tokenless':
      return t('editor:mapProblemTokenOnTokenless', { count });
    case 'too-many-of-number':
      return t('editor:mapProblemTooManyOfNumber', values);
    case 'unreachable-land':
      return t('editor:mapProblemUnreachableLand', { count });
    case 'harbor-not-coastal':
      return t('editor:mapProblemHarborNotCoastal', { count });
    case 'harbor-shared-water':
      return t('editor:mapProblemHarborSharedWater', { count });
    case 'harbor-shared-vertex':
      return t('editor:mapProblemHarborSharedVertex', { count });
    case 'harbor-duplicate':
      return t('editor:mapProblemHarborDuplicate');
    case 'robber-missing':
      return t('editor:mapProblemRobberMissing');
    case 'robber-not-land':
      return t('editor:mapProblemRobberNotLand');
    case 'pirate-not-sea':
      return t('editor:mapProblemPirateNotSea');
    case 'setup-needs-seafaring':
      return t('editor:mapProblemSetupNeedsSeafaring');
    case 'setup-not-land':
      return t('editor:mapProblemSetupNotLand', { count });
    case 'setup-too-small':
      return t('editor:mapProblemSetupTooSmall', values);
    case 'fog-stack-mismatch':
      return t('editor:mapProblemFogStackMismatch', values);
    case 'fog-tokens-mismatch':
      return t('editor:mapProblemFogTokensMismatch', values);
    case 'fog-beside-land':
      return t('editor:mapProblemFogBesideLand', { count });
    case 'seats-too-few':
      return t('editor:mapProblemSeatsTooFew');
    case 'engine-rejected':
      return t('editor:mapProblemEngineRejected', values);
    case 'adjacent-red':
      return t('editor:mapProblemAdjacentRed', { count });
    case 'adjacent-equal':
      return t('editor:mapProblemAdjacentEqual', { count });
    case 'missing-resource':
      return t('editor:mapProblemMissingResource', {
        terrain: terrainLabel(t, String(values.terrain ?? '')),
      });
    case 'robber-on-number':
      return t('editor:mapProblemRobberOnNumber');
    case 'no-harbors':
      return t('editor:mapProblemNoHarbors');
    case 'setup-tight':
      return t('editor:mapProblemSetupTight', values);
    default:
      return problem.code;
  }
}

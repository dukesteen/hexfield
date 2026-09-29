export const PACKAGE_NAME = '@cp2p/maps';

export { standardFixedBoard } from './standard-fixed.js';
export {
  BOARD_SHAPES,
  SCENARIOS,
  defaultScenario,
  scenarioAtSeats,
  scenarioById,
  scenarioConfig,
  scenarioIsPlayable,
  scenarioOfConfig,
  scenariosForModules,
  scenariosForSeats,
} from './scenarios.js';
export type { Scenario, ScenarioBoard } from './scenarios.js';
export {
  FIXED_SEAFARING,
  FOGBOUND_FOG,
  OPEN_SEA_OPTIONS,
  harborProblems,
  tokenProblems,
} from './scenarios/seafaring/index.js';
export type { FixedSeafaringData, FogSpec, SeafaringOptions } from './scenarios/seafaring/index.js';

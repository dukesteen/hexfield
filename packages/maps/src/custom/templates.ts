import type { Scenario } from '../scenarios.js';
import { MAP_FORMAT, MAP_MODULES, parseMapDef } from './schema.js';
import type { MapDef } from './schema.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A fixed-board scenario as an editable map (the editor's "start from" choices). Its modules,
 * seat range, target, board, pirate, setup areas and fog stack carry over. Null for generated boards.
 */
export function mapFromScenario(scenario: Scenario, name: string): MapDef | null {
  if (scenario.board.kind !== 'fixed') return null;
  const board = scenario.board.board();
  const seafaring = isRecord(scenario.options.seafaring) ? scenario.options.seafaring : {};
  const fog = isRecord(seafaring.fog) ? seafaring.fog : null;
  const counts = (value: unknown): Record<string, number> =>
    isRecord(value)
      ? Object.fromEntries(
          Object.entries(value).filter(
            (entry): entry is [string, number] => typeof entry[1] === 'number',
          ),
        )
      : {};
  const seats =
    scenario.modules.includes('five-six') || scenario.seats.max <= 4
      ? scenario.seats
      : { min: scenario.seats.min, max: 4 };
  const parsed = parseMapDef({
    v: MAP_FORMAT,
    name,
    modules: MAP_MODULES.filter((id) => scenario.modules.includes(id)),
    seats: { min: seats.min, max: seats.max },
    vpTarget: scenario.vpTarget,
    hexes: board.hexes.map(({ q, r, terrain, token }) => ({ q, r, terrain, token })),
    harbors: board.harbors.map(({ edge, kind }) => ({ edge, kind })),
    robber: board.robberHex,
    pirate: typeof seafaring.pirateHex === 'string' ? seafaring.pirateHex : null,
    setupAreas: Array.isArray(seafaring.setupAreas)
      ? seafaring.setupAreas.filter((id): id is string => typeof id === 'string')
      : null,
    fog: fog ? { terrains: counts(fog.terrains), tokens: counts(fog.tokens) } : null,
  });
  return parsed.ok ? parsed.value : null;
}

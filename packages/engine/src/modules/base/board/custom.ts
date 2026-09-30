import { perimeterFixtureSlot } from '../../../core/board/index.js';
import type { BoardShapeSpec } from '../../../core/modules/index.js';
import type { BoardState, GameConfig } from '../../../core/state/index.js';

const specs = new WeakMap<BoardState, BoardShapeSpec>();

/** True when the base options ask for the editor map in `config.board`. */
export function isCustomLayout(config: GameConfig): boolean {
  const base: unknown = config.options.base;
  return (
    typeof base === 'object' &&
    base !== null &&
    Reflect.get(base, 'mapLayout') === 'custom' &&
    config.board !== undefined
  );
}

/**
 * The shape of an editor map: its own hexes and bags, so validation checks structure (tokens follow
 * terrain, harbors are coastal, the robber stands on land) and not counts. A fixture (the
 * barbarian track) goes just outside the perimeter. Null unless the config selects a custom map.
 */
export function customShapeOf(config: GameConfig): BoardShapeSpec | null {
  const board = config.board;
  if (!board || !isCustomLayout(config)) return null;
  let spec = specs.get(board);
  if (!spec) {
    const bare: BoardShapeSpec = {
      id: 'custom',
      hexes: board.hexes.map(({ q, r }) => ({ q, r })),
      terrains: board.hexes.map((hex) => hex.terrain),
      tokens: board.hexes.flatMap((hex) => (hex.token === null ? [] : [hex.token])),
      harbors: board.harbors.map((harbor) => harbor.kind),
      harborSlots: board.harbors.map((harbor) => harbor.edge),
      fixtureSlots: [],
      pipCaps: {},
      custom: true,
    };
    const slot = perimeterFixtureSlot(bare);
    spec = slot ? { ...bare, fixtureSlots: [slot] } : bare;
    specs.set(board, spec);
  }
  return spec;
}

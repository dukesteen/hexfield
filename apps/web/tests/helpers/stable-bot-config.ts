import { deepStrictEqual } from 'node:assert';
import type { GameState } from '@cp2p/engine';

/** Browser observations are structured clones; RandomBot tracks a game by config identity. */
export function stableBotConfig(): (state: GameState) => GameState {
  let config: GameState['config'] | undefined;
  return (state) => {
    if (config === undefined) config = structuredClone(state.config);
    else deepStrictEqual(state.config, config, 'Browser bot game config changed');
    return { ...state, config };
  };
}

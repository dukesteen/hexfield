import type { GameConfig } from '@cp2p/engine';

/** True when a genesis config plays a custom (editor) map: base `mapLayout: custom` and a board. */
export function isCustomConfig(config: GameConfig): boolean {
  const base: unknown = config.options.base;
  return (
    config.board !== undefined &&
    typeof base === 'object' &&
    base !== null &&
    Reflect.get(base, 'mapLayout') === 'custom'
  );
}

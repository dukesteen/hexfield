import type { BoardAppearance } from './types.js';

export function sameAppearance(a: BoardAppearance, b: BoardAppearance): boolean {
  return (
    a === b ||
    (a.theme === b.theme &&
      a.players.length === b.players.length &&
      a.players.every((player, index) => {
        const next = b.players[index];
        return (
          next !== undefined &&
          player.seat === next.seat &&
          player.color === next.color &&
          player.marker === next.marker
        );
      }))
  );
}

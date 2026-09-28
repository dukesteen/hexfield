import { moduleSelection } from '@cp2p/engine';
import type { ModuleSelection } from '@cp2p/engine';

/** Six colour-blind-safe player identities; each colour also has its own faction crest. */
export const PLAYER_COLORS = ['blue', 'orange', 'green', 'magenta', 'yellow', 'red'] as const;
export type PlayerColor = (typeof PLAYER_COLORS)[number];
export const PLAYER_SHAPES = [
  'circle',
  'triangle',
  'square',
  'diamond',
  'hexagon',
  'star',
] as const;
export type PlayerShape = (typeof PLAYER_SHAPES)[number];
export const PLAYER_SEATS = [0, 1, 2, 3, 4, 5] as const;
export type PlayerSeat = (typeof PLAYER_SEATS)[number];

export const PLAYER_PRESETS: readonly {
  seat: PlayerSeat;
  color: PlayerColor;
  shape: PlayerShape;
}[] = PLAYER_SEATS.map((seat) => ({
  seat,
  color: PLAYER_COLORS[seat],
  shape: PLAYER_SHAPES[seat],
}));

export function isPlayerColor(value: string): value is PlayerColor {
  return (PLAYER_COLORS as readonly string[]).includes(value);
}

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

/** Five or six seats enable the five-six module automatically. */
export function modulesForSeatCount(count: number): ModuleSelection[] {
  return moduleSelection(count > 4 ? ['base', 'five-six'] : ['base']);
}

import { RESOURCES, SEAFARING_ID, baseLongestRoadLength, engineForConfig } from '@cp2p/engine';
import type { GameState, Pending, Seat } from '@cp2p/engine';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when the game has ships: its board carries a ship list, even an empty one. */
export function isSeafaring(state: Readonly<GameState>): boolean {
  return state.board.ships !== undefined;
}

/**
 * The seat's longest road, or longest trade route in a seafaring game. The module's route
 * graph joins roads and ships, so the plain road count would understate it.
 */
export function routeLength(state: Readonly<GameState>, seat: Seat): number {
  return isSeafaring(state)
    ? baseLongestRoadLength(state, seat, { hooks: engineForConfig(state.config).hooks })
    : baseLongestRoadLength(state, seat);
}

/** Points per island-bonus token in this game, or 0 without the bonus. */
export function islandBonusPoints(state: Readonly<GameState>): number {
  const options: unknown = state.config.options[SEAFARING_ID];
  const bonus = record(options) ? options.islandBonus : null;
  return record(bonus) && typeof bonus.vp === 'number' ? bonus.vp : 0;
}

/** How many islands this seat has earned the new-island bonus on, and what that is worth. */
export function islandBonusOf(
  state: Readonly<GameState>,
  seat: Seat,
): { readonly count: number; readonly points: number } {
  const ext = state.ext[SEAFARING_ID];
  const tokens = record(ext) && Array.isArray(ext.bonus) ? ext.bonus : [];
  const count = tokens.filter((token: unknown) => record(token) && token.seat === seat).length;
  return { count, points: count * islandBonusPoints(state) };
}

/**
 * The gold choice a seat has to make right now: the cards it must take, which is its claim
 * capped at what the bank holds. `null` when the top phase is not this seat's gold choice.
 */
export function goldRequest(
  state: Readonly<GameState>,
  seat: Seat,
): { readonly count: number; readonly claim: number; readonly waiting: readonly Seat[] } | null {
  const top = state.turn.phase.at(-1);
  if (top?.module !== SEAFARING_ID || top.id !== 'goldChoice' || !record(top.data)) return null;
  const queue = Array.isArray(top.data.queue) ? top.data.queue : [];
  const [head, ...rest] = queue;
  if (!record(head) || head.seat !== seat || typeof head.claim !== 'number') return null;
  const bank = RESOURCES.reduce((sum, resource) => sum + (state.bank[resource] ?? 0), 0);
  return {
    count: Math.min(head.claim, bank),
    claim: head.claim,
    waiting: rest.flatMap((item: unknown) =>
      record(item) && state.config.seats.some((candidate) => candidate === item.seat)
        ? state.config.seats.filter((candidate) => candidate === item.seat)
        : [],
    ),
  };
}

/** The system input that answers a fog draw (`FOG_REVEALED` in the seafaring module). */
const FOG_DRAW_INPUT = 'FOG_REVEALED';

/**
 * The fog draw the game is waiting for, or null. It is a public random pending that the driver
 * resolves at once in a local game and through the deck ceremony online, where it takes
 * network time, so the screen says a reveal is under way while it is open.
 */
export function fogDrawPending(pending: readonly Pending[]): { readonly hex: string } | null {
  for (const item of pending)
    if (item.kind === 'random' && item.systemType === FOG_DRAW_INPUT)
      return { hex: typeof item.request.hex === 'string' ? item.request.hex : '' };
  return null;
}

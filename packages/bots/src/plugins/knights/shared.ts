import type { CommandShape, GameState, Seat, Track } from '@cp2p/engine';
import { BARBARIAN_STEPS, TRACKS, kindBounds, knightsExt } from '@cp2p/engine';
import type { BoardInfo } from '../../eval/index.js';
import type { TurnContext } from '../../policy/context.js';
import { publicVp } from '../../policy/context.js';

/** The commodity each terrain's city adds, and the track it pays for. */
export const TERRAIN_TRACK: Readonly<Record<string, Track>> = {
  forest: 'science',
  pasture: 'trade',
  mountains: 'politics',
};

export function cardCount(hand: Readonly<Record<string, number>>): number {
  return Object.values(hand).reduce((sum, count) => sum + count, 0);
}

/** The 7-discard limit: 7, plus 2 per city wall. */
export function handLimit(state: GameState, seat: Seat): number {
  return 7 + 2 * knightsExt(state).walls.filter((wall) => wall.seat === seat).length;
}

export function citiesOf(state: GameState, seat?: Seat): string[] {
  return state.board.buildings
    .filter((piece) => piece.kind === 'city' && (seat === undefined || piece.seat === seat))
    .map((piece) => piece.vertex);
}

/** Cities without a metropolis: the ones a lost attack can take. */
export function plainCities(state: GameState, seat: Seat): string[] {
  const held = new Set(
    Object.values(knightsExt(state).metropolises).flatMap((holder) =>
      holder ? [holder.vertex] : [],
    ),
  );
  return citiesOf(state, seat).filter((vertex) => !held.has(vertex));
}

export function levelOn(state: GameState, seat: Seat, track: Track): number {
  return knightsExt(state).improvements[seat]?.[track] ?? 0;
}

/** A seat's public hand size. */
export function handTotal(state: GameState, seat: Seat): number {
  const holder = state.seats.find((item) => item.seat === seat);
  return holder ? kindBounds(holder.resources).total : 0;
}

/** Progress cards a seat holds (public count). */
export function progressHeld(state: GameState, seat: Seat): number {
  return (
    state.seats
      .find((holder) => holder.seat === seat)
      ?.cardSlots.filter((slot) => slot.deck.startsWith('progress') && !slot.revealed).length ?? 0
  );
}

/** The other seat with the most public points (ties: the larger hand). */
export function leader(state: GameState, seat: Seat): Seat | null {
  let top: Seat | null = null;
  let score = -Infinity;
  for (const holder of state.seats) {
    if (holder.seat === seat) continue;
    const value = publicVp(state, holder.seat) * 100 + handTotal(state, holder.seat);
    if (value > score) {
      score = value;
      top = holder.seat;
    }
  }
  return top;
}

/** How much the bot minds another seat gaining: the leader most, a seat near winning more. */
export function threatOf(context: TurnContext, other: Seat): number {
  const { state, seat } = context.view;
  if (other === seat) return 0;
  const gap = publicVp(state, other) - publicVp(state, seat);
  const near = publicVp(state, other) >= context.target - 3 ? 0.5 : 0;
  return Math.max(0.3, 1 + gap * 0.15 + near);
}

/** Commodity income per roll, per track, from the seat's cities (pips / 36, robber excluded). */
export function commodityIncome(
  state: GameState,
  seat: Seat,
  info: BoardInfo,
): Record<Track, number> {
  const income: Record<Track, number> = { trade: 0, politics: 0, science: 0 };
  const terrains = new Map(state.board.hexes.map((hex) => [hex.id, hex.terrain]));
  for (const vertex of citiesOf(state, seat)) {
    const index = info.graph.vertexIndex[vertex];
    if (index === undefined) continue;
    for (const item of info.yields[index] ?? []) {
      if (item.hex === state.board.robberHex) continue;
      const track = TERRAIN_TRACK[terrains.get(item.hex) ?? ''];
      if (track) income[track] += item.pips / 36;
    }
  }
  return income;
}

/** Active knight strength per seat. */
export function strengths(state: GameState): Map<Seat, number> {
  const bySeat = new Map<Seat, number>();
  for (const knight of knightsExt(state).knights)
    if (knight.active) bySeat.set(knight.seat, (bySeat.get(knight.seat) ?? 0) + knight.level);
  return bySeat;
}

/** Strength of a seat's knights that are on the board but inactive. */
export function idleStrength(state: GameState, seat: Seat): number {
  return knightsExt(state)
    .knights.filter((knight) => knight.seat === seat && !knight.active)
    .reduce((sum, knight) => sum + knight.level, 0);
}

/**
 * The chance the barbarians attack before the bot's next action phase: the ship needs
 * `stepsLeft` ship faces (half of all event-die rolls), and every seat rolls once before the bot
 * can act again (its own next roll resolves before its action phase).
 */
export function attackChance(state: GameState): number {
  const stepsLeft = BARBARIAN_STEPS - knightsExt(state).barbarians.step;
  const rolls = state.seats.length;
  let chance = 0;
  // P(at least stepsLeft successes in `rolls` fair trials).
  for (let k = stepsLeft; k <= rolls; k++) chance += binomial(rolls, k) / 2 ** rolls;
  return chance;
}

function binomial(n: number, k: number): number {
  let value = 1;
  for (let i = 1; i <= k; i++) value = (value * (n - k + i)) / i;
  return value;
}

/** Expected rolls before the attack (two rolls per ship face). */
export function rollsToAttack(state: GameState): number {
  return (BARBARIAN_STEPS - knightsExt(state).barbarians.step) * 2;
}

export function paramOf(command: CommandShape, key: string): unknown {
  const params = command.params;
  return typeof params === 'object' && params !== null ? Reflect.get(params, key) : undefined;
}

export { TRACKS };

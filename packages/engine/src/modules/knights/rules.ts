import type { Blocker, DiceSpec, Production, VpContribution } from '../../core/modules/index.js';
import type { GameState } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import { verticesForHex } from '../base/board/index.js';
import { setup } from '../base/phases/setup.js';
import { topFrame, updateSeat } from '../base/shared.js';
import {
  CITY_COMMODITY,
  COMMODITIES,
  COMMODITY_BANK,
  COMMODITY_BANK_FIVE_SIX,
  EVENT_DIE,
  KNIGHTS_VP_TARGET,
  METROPOLIS_VP,
  TRACKS,
  WALL_HAND_BONUS,
} from './config.js';
import { knightsExt, updateKnights } from './types.js';

/** The `bankInit` hook: 12 of each commodity, or 18 with five-six. */
export function commodityBank(
  config: Pick<GameState['config'], 'modules'>,
  acc: Readonly<Record<string, number>>,
): Record<string, number> {
  const each = config.modules.some((module) => module.id === 'five-six')
    ? COMMODITY_BANK_FIVE_SIX
    : COMMODITY_BANK;
  return { ...acc, ...Object.fromEntries(COMMODITIES.map((kind) => [kind, each])) };
}

/**
 * The `production` hook: a city on forest, pasture or mountains pays one resource and one
 * commodity instead of two of the resource. Fields and hills still pay two of the resource.
 */
export function cityProduction(state: GameState, roll: number, acc: Production): Production {
  const swaps: { seat: Seat; resource: string; commodity: string }[] = [];
  for (const hex of state.board.hexes) {
    if (hex.token !== roll || hex.id === state.board.robberHex) continue;
    const kind = CITY_COMMODITY[hex.terrain];
    if (!kind) continue;
    const vertices = new Set(verticesForHex(state, hex.id));
    for (const building of state.board.buildings)
      if (building.kind === 'city' && vertices.has(building.vertex))
        swaps.push({ seat: building.seat, resource: kind.resource, commodity: kind.commodity });
  }
  if (swaps.length === 0) return acc;
  const next: Record<string, Record<string, number>> = Object.fromEntries(
    Object.entries(acc).map(([seat, counts]) => [seat, { ...counts }]),
  );
  for (const { seat, resource, commodity } of swaps) {
    const row = next[seat];
    if (!row) continue;
    row[resource] = (row[resource] ?? 0) - 1;
    row[commodity] = (row[commodity] ?? 0) + 1;
  }
  return next;
}

/** The `diceSpec` hook: the event die rides along with the two production dice. */
export function withEventDie(_state: GameState, acc: DiceSpec): DiceSpec {
  return { ...acc, extra: [...acc.extra, { id: EVENT_DIE.id, faces: [...EVENT_DIE.faces] }] };
}

/** The `onDiceResult` hook: K1 only records the event die. K4 and K5 resolve it from here. */
export function recordEventDie(
  state: GameState,
  _dice: readonly [number, number],
  extra: Readonly<Record<string, string>>,
): GameState {
  return updateKnights(state, (old) => ({ ...old, eventDie: extra[EVENT_DIE.id] ?? null }));
}

/** The `handLimit` hook: 7, plus 2 for each city wall the seat has on the board. */
export function limitWithWalls(state: GameState, seat: Seat, limit: number): number {
  return (
    limit + WALL_HAND_BONUS * knightsExt(state).walls.filter((wall) => wall.seat === seat).length
  );
}

/** The `robberLike` hook: no legal hex while the robber is locked on the desert. */
export function lockRobber(state: GameState, acc: readonly Blocker[]): readonly Blocker[] {
  return knightsExt(state).robberLocked
    ? acc.map((blocker) => (blocker.id === 'robber' ? { ...blocker, legalHexes: [] } : blocker))
    : acc;
}

/** The `stealTargets` hook: nothing is stolen while the robber is locked. */
export function lockSteals(state: GameState, targets: readonly Seat[]): readonly Seat[] {
  return knightsExt(state).robberLocked ? [] : targets;
}

/** The `vpTarget` hook: at least 13, unless the game asks for more. */
export function knightsTarget(acc: number): number {
  return Math.max(acc, KNIGHTS_VP_TARGET);
}

/** The `victoryPoints` hook: a metropolis is worth two points, public and stored. */
export function metropolisPoints(
  state: GameState,
  seat: Seat,
  acc: readonly VpContribution[],
): readonly VpContribution[] {
  const held = knightsExt(state).metropolises;
  return [
    ...acc,
    ...TRACKS.filter((track) => held[track]?.seat === seat).map((track) => ({
      source: `metropolis:${track}`,
      points: METROPOLIS_VP,
      public: true,
      stored: true,
    })),
  ];
}

/**
 * The `afterBuild` hook: in the second setup round the placed settlement becomes a city. The
 * settlement piece goes back to the supply and a city piece is used, so the starting yield (which
 * base already paid as resources only, one card per hex) is unchanged.
 */
export function setupCity(state: GameState, seat: Seat, type: string, vertex: string): GameState {
  const frame = topFrame(state);
  if (type !== 'settlement' || frame?.module !== 'base' || frame.id !== 'setup') return state;
  if (setup(state).index < state.seats.length) return state;
  const converted = {
    ...state,
    board: {
      ...state.board,
      buildings: state.board.buildings.map((piece) =>
        piece.vertex === vertex && piece.seat === seat ? { ...piece, kind: 'city' } : piece,
      ),
    },
  };
  return updateSeat(converted, seat, (old) => ({
    ...old,
    piecesLeft: {
      ...old.piecesLeft,
      settlement: (old.piecesLeft.settlement ?? 0) + 1,
      city: (old.piecesLeft.city ?? 0) - 1,
    },
  }));
}

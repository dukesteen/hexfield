import type { Blocker, CommandHandler, HandlerContext } from '../../core/modules/index.js';
import type { GameState } from '../../core/state/index.js';
import { failure, success } from '../../core/types/index.js';
import type { Seat } from '../../core/types/index.js';
import { boardGraph } from '../base/board/index.js';
import { baseOptions } from '../base/types.js';
import { legalRobberHexes, resume } from '../base/robber.js';
import { frame, ownSeat, replaceTop, top } from '../base/shared.js';
import { seafaringExt, updateSeafaring } from './types.js';

/** Seats with a ship on an edge of the hex. */
function shipOwners(state: GameState, hex: string): Set<Seat> {
  const graph = boardGraph(state);
  const edges = new Set<string>(graph.hexEdges[graph.hexIndex[hex] ?? -1] ?? []);
  return new Set(
    (state.board.ships ?? []).filter((ship) => edges.has(ship.edge)).map((ship) => ship.seat),
  );
}

/** Sea hexes the pirate may move to, with the friendly-robber restriction and fall-back. */
export function legalPirateHexes(state: GameState): string[] {
  const current = seafaringExt(state).pirateHex;
  const candidates = state.board.hexes
    .filter((hex) => hex.terrain === 'sea' && hex.id !== current)
    .map((hex) => hex.id)
    .toSorted();
  if (!baseOptions(state.config.options.base).friendlyRobber) return candidates;
  const friendly = candidates.filter(
    (hex) => ![...shipOwners(state, hex)].some((seat) => ownSeat(state, seat).publicVp <= 2),
  );
  return friendly.length ? friendly : candidates;
}

/** The robber-like blockers after module hooks, with the pirate's entry present. */
export function pirateHexes(state: GameState, ctx: HandlerContext): string[] {
  const blockers = ctx.hooks.robberLike(state, [
    { id: 'robber', hex: state.board.robberHex, legalHexes: legalRobberHexes(state) },
  ]);
  return [...(blockers.find((blocker) => blocker.id === 'pirate')?.legalHexes ?? [])];
}

/** The `robberLike` hook: adds the pirate after the robber. */
export function pirateBlocker(state: GameState, acc: readonly Blocker[]): readonly Blocker[] {
  return [
    ...acc,
    { id: 'pirate', hex: seafaringExt(state).pirateHex, legalHexes: legalPirateHexes(state) },
  ];
}

/** Opponents with a ship on the hex and at least one card, after the steal-target hooks. */
export function pirateTargets(
  state: GameState,
  thief: Seat,
  hex: string,
  ctx: HandlerContext,
): Seat[] {
  const occupied = [...shipOwners(state, hex)].filter(
    (seat) => seat !== thief && ownSeat(state, seat).resources.total > 0,
  );
  return ctx.hooks.stealTargets(state, thief, 'pirate', hex, occupied).toSorted((a, b) => a - b);
}

function returnTarget(state: GameState): 'main' | 'pop' {
  const frameData = top(state);
  const value: unknown = frameData.data;
  const returnTo =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'returnTo') : '';
  if (frameData.id !== 'moveRobber' || (returnTo !== 'main' && returnTo !== 'pop'))
    throw new Error('Pirate moves need the robber phase');
  return returnTo;
}

/** Move the pirate instead of the robber, then steal as the robber's move would. */
export const movePirate: CommandHandler = {
  keys: { allowed: ['hex'] },
  validate: (state, input, ctx) => {
    const frameData = state.turn.phase.at(-1);
    if (
      frameData?.module !== 'base' ||
      frameData.id !== 'moveRobber' ||
      input.seat !== state.turn.activeSeat
    )
      return failure('not-moving-blocker', 'The pirate moves only when a blocker moves');
    return typeof input.command.hex === 'string' &&
      pirateHexes(state, ctx).includes(input.command.hex)
      ? success(undefined)
      : failure('illegal-pirate-hex', 'Pirate must move to a legal different sea hex');
  },
  apply: (state, input, ctx) => {
    const hex = input.command.hex;
    if (typeof hex !== 'string') throw new Error('Validated pirate hex missing');
    const returnTo = returnTarget(state);
    let next = updateSeafaring(state, (old) => ({ ...old, pirateHex: hex }));
    const targets = pirateTargets(next, state.turn.activeSeat, hex, ctx);
    next = targets.length
      ? replaceTop(next, frame('steal', { targets, thief: state.turn.activeSeat, returnTo }))
      : resume(next, returnTo);
    return {
      state: next,
      events: [{ type: 'pirateMoved', hex, seat: state.turn.activeSeat }],
      effects: [],
    };
  },
};

import type {
  Blocker,
  CommandHandler,
  HandlerContext,
  PhaseHandler,
} from '../../core/modules/index.js';
import type { CommandShape } from '../../core/pipeline/index.js';
import type { GameState, PhaseFrame } from '../../core/state/index.js';
import { failure, success } from '../../core/types/index.js';
import type { Result, Seat } from '../../core/types/index.js';
import { recomputeLongestRoadAward } from '../base/awards/index.js';
import { claimCommands } from '../base/legal.js';
import { verticesForHex } from '../base/board/index.js';
import { legalRobberHexes } from '../base/robber.js';
import { frame, playerPending, popPhase, pushPhase, topFrame, withClaim } from '../base/shared.js';
import { KNIGHTS_ID } from './config.js';
import { knightAt, knightReach, setKnights } from './pieces.js';
import { actionSlot } from './slot.js';
import { knightsExt } from './types.js';
import type { DisplacedFrameData, KnightPiece } from './types.js';

export const DISPLACED_FRAME = 'displaced';

function vertexOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** An own knight that is active and was active when the Action phase began, and has not acted. */
export function readyKnight(state: GameState, seat: Seat, vertex: string): Result<KnightPiece> {
  const knight = knightAt(state, vertex);
  if (knight?.seat !== seat) return failure('no-knight', 'You have no knight there');
  return knight.active && knight.ready
    ? success(knight)
    : failure('knight-not-ready', 'The knight was not active when your action phase began');
}

/** After acting, a knight is inactive and cannot act again this turn. */
function spent(knight: KnightPiece): KnightPiece {
  return { ...knight, active: false, ready: false };
}

/** A move: an own ready knight and an empty vertex it can reach along its owner's roads. */
export function moveProblem(state: GameState, seat: Seat, from: string, to: string): Result<void> {
  const knight = readyKnight(state, seat, from);
  if (!knight.ok) return knight;
  return knightReach(state, seat, from).empty.includes(to)
    ? success(undefined)
    : failure('unreachable', 'The knight cannot reach that empty vertex along your roads');
}

/** A displacement: a strictly weaker opposing knight on a vertex the knight can reach. */
export function displaceProblem(
  state: GameState,
  seat: Seat,
  from: string,
  to: string,
): Result<void> {
  const knight = readyKnight(state, seat, from);
  if (!knight.ok) return knight;
  const target = knightAt(state, to);
  if (target === undefined || target.seat === seat)
    return failure('no-target', 'There is no opposing knight there');
  if (target.level >= knight.value.level)
    return failure('not-weaker', 'Only a weaker knight can be displaced');
  return knightReach(state, seat, from).foes.includes(to)
    ? success(undefined)
    : failure('unreachable', 'The knight cannot reach that vertex along your roads');
}

/** The robber and any other blocker a module adds (the pirate), with their legal hexes. */
function blockersOf(state: GameState, ctx: HandlerContext): readonly Blocker[] {
  return ctx.hooks.robberLike(state, [
    { id: 'robber', hex: state.board.robberHex, legalHexes: legalRobberHexes(state) },
  ]);
}

/** Blockers whose hex the vertex belongs to, whether or not they can move now. */
function blockersAt(state: GameState, vertex: string, blockers: readonly Blocker[]): Blocker[] {
  return blockers.filter(
    (blocker) => blocker.hex !== null && verticesForHex(state, blocker.hex).includes(vertex),
  );
}

/** Vertices a knight may chase from: the corners of the robber's hex and of any other blocker's. */
export function chaseVertices(state: GameState, ctx: HandlerContext): string[] {
  const hexes = blockersOf(state, ctx).flatMap((blocker) =>
    blocker.hex === null ? [] : [blocker.hex],
  );
  return [...new Set(hexes.flatMap((hex) => verticesForHex(state, hex)))].toSorted();
}

/**
 * Chasing the robber (or the pirate, which the seafaring combination adds): after the first attack,
 * from a vertex of the blocker's hex, whatever kind of vertex it is.
 */
export function chaseProblem(
  state: GameState,
  seat: Seat,
  vertex: string,
  ctx: HandlerContext,
): Result<void> {
  if (knightsExt(state).robberLocked)
    return failure('robber-locked', 'The robber cannot be chased before the first attack');
  const beside = blockersAt(state, vertex, blockersOf(state, ctx));
  if (beside.length === 0)
    return failure('not-at-robber', 'The knight must stand beside the robber');
  const knight = readyKnight(state, seat, vertex);
  if (!knight.ok) return knight;
  return beside.some((blocker) => blocker.legalHexes.length > 0)
    ? success(undefined)
    : failure('no-robber-hex', 'The robber has nowhere to go');
}

export function displacedFrame(data: DisplacedFrameData): PhaseFrame {
  return { id: DISPLACED_FRAME, module: KNIGHTS_ID, data };
}

function displacedData(state: GameState): DisplacedFrameData {
  const top = topFrame(state);
  const value: unknown = top?.data;
  if (top?.module !== KNIGHTS_ID || top.id !== DISPLACED_FRAME || typeof value !== 'object')
    throw new Error('Expected a displaced knight');
  // Only DISPLACE_KNIGHT builds this phase data.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as DisplacedFrameData;
}

/** Empty vertices the displaced owner may put its knight on, by id. */
export function relocationSpots(state: GameState, data: DisplacedFrameData): string[] {
  return knightReach(state, data.seat, data.origin).empty;
}

function inFrame(state: GameState): PhaseFrame | undefined {
  const top = topFrame(state);
  return top?.module === KNIGHTS_ID && top.id === DISPLACED_FRAME ? top : undefined;
}

export const moveKnight: CommandHandler = {
  keys: { allowed: ['from', 'to'] },
  validate: (state, input) => {
    const from = vertexOf(input.command.from);
    const to = vertexOf(input.command.to);
    if (from === null || to === null) return failure('invalid-vertex', 'From and to are required');
    const slot = actionSlot(state, input.seat);
    return slot.ok ? moveProblem(state, input.seat, from, to) : slot;
  },
  apply: (state, input, ctx) => {
    const from = vertexOf(input.command.from);
    const to = vertexOf(input.command.to);
    if (from === null || to === null) throw new Error('Validated move missing');
    const next = recomputeLongestRoadAward(
      setKnights(state, (list) =>
        list.map((knight) => (knight.vertex === from ? { ...spent(knight), vertex: to } : knight)),
      ),
      ctx,
    );
    return {
      state: next,
      events: [{ type: 'knightMoved', seat: input.seat, from, to }],
      effects: [],
    };
  },
};

export const displaceKnight: CommandHandler = {
  keys: { allowed: ['from', 'to'] },
  validate: (state, input) => {
    const from = vertexOf(input.command.from);
    const to = vertexOf(input.command.to);
    if (from === null || to === null) return failure('invalid-vertex', 'From and to are required');
    const slot = actionSlot(state, input.seat);
    return slot.ok ? displaceProblem(state, input.seat, from, to) : slot;
  },
  apply: (state, input, ctx) => {
    const from = vertexOf(input.command.from);
    const to = vertexOf(input.command.to);
    const mover = from === null ? undefined : knightAt(state, from);
    const target = to === null ? undefined : knightAt(state, to);
    if (from === null || to === null || !mover || !target)
      throw new Error('Validated move missing');
    // The displacer lands first; the displaced knight waits in its owner's hand.
    let next = recomputeLongestRoadAward(
      setKnights(state, (list) => [
        ...list.filter((knight) => knight.vertex !== from && knight.vertex !== to),
        { ...spent(mover), vertex: to },
      ]),
      ctx,
    );
    const data: DisplacedFrameData = {
      seat: target.seat,
      origin: to,
      level: target.level,
      active: target.active,
      ready: target.ready,
      promotedTurn: target.promotedTurn,
    };
    const events: { type: string; [key: string]: unknown }[] = [
      { type: 'knightDisplaced', seat: input.seat, from, to, displaced: target.seat },
    ];
    if (relocationSpots(next, data).length === 0)
      events.push({ type: 'knightRemoved', seat: target.seat, vertex: to });
    else next = pushPhase(next, displacedFrame(data));
    return { state: next, events, effects: [] };
  },
};

export const chaseRobber: CommandHandler = {
  keys: { allowed: ['vertex'] },
  validate: (state, input, ctx) => {
    const vertex = vertexOf(input.command.vertex);
    if (vertex === null) return failure('invalid-vertex', 'Vertex id is required');
    const slot = actionSlot(state, input.seat);
    return slot.ok ? chaseProblem(state, input.seat, vertex, ctx) : slot;
  },
  apply: (state, input, ctx) => {
    const vertex = vertexOf(input.command.vertex);
    if (vertex === null) throw new Error('Validated vertex missing');
    const next = setKnights(state, (list) =>
      list.map((knight) => (knight.vertex === vertex ? spent(knight) : knight)),
    );
    // With a second blocker (the pirate) only the pieces beside the knight may move.
    const blockers = blockersOf(state, ctx);
    const only = blockersAt(state, vertex, blockers)
      .filter((blocker) => blocker.legalHexes.length > 0)
      .map((blocker) => blocker.id);
    return {
      state: pushPhase(
        next,
        frame('moveRobber', blockers.length > 1 ? { returnTo: 'pop', only } : { returnTo: 'pop' }),
      ),
      events: [{ type: 'robberChased', seat: input.seat, vertex }],
      effects: [],
    };
  },
};

export const relocateKnight: CommandHandler = {
  keys: { allowed: ['to'] },
  validate: (state, input) => {
    if (!inFrame(state)) return failure('no-displaced-knight', 'No displaced knight is waiting');
    const data = displacedData(state);
    if (data.seat !== input.seat)
      return failure('not-displaced', 'It is not this seat’s knight to place');
    const to = vertexOf(input.command.to);
    return to !== null && relocationSpots(state, data).includes(to)
      ? success(undefined)
      : failure('illegal-relocation', 'Place the knight on an empty vertex your roads reach');
  },
  apply: (state, input, ctx) => {
    const data = displacedData(state);
    const to = vertexOf(input.command.to);
    if (to === null) throw new Error('Validated relocation missing');
    const placed = setKnights(popPhase(state), (list) => [
      ...list,
      {
        seat: data.seat,
        vertex: to,
        level: data.level,
        active: data.active,
        ready: data.ready,
        promotedTurn: data.promotedTurn,
      },
    ]);
    return {
      state: recomputeLongestRoadAward(placed, ctx),
      events: [{ type: 'knightRelocated', seat: data.seat, from: data.origin, to }],
      effects: [],
    };
  },
};

export const displacedPhase: PhaseHandler = {
  pending: (state) => {
    const { seat } = displacedData(state);
    return withClaim(state, [playerPending(state, seat, ['RELOCATE_KNIGHT'], DISPLACED_FRAME)]);
  },
  legalCommands: (state, _frame, seat, priv, ctx) => {
    const claim = claimCommands(state, seat, priv, ctx);
    const data = displacedData(state);
    if (data.seat !== seat) return claim;
    return {
      commands: [
        ...relocationSpots(state, data).map((to) => ({ type: 'RELOCATE_KNIGHT', to })),
        ...claim.commands,
      ],
      templates: claim.templates,
    };
  },
};

/** The timeout choice: the empty vertex with the lowest id (the knight always has one here). */
export function automaticRelocation(state: GameState, seat: Seat): CommandShape | null {
  const data = displacedData(state);
  const to = relocationSpots(state, data)[0];
  return data.seat === seat && to !== undefined ? { type: 'RELOCATE_KNIGHT', to } : null;
}

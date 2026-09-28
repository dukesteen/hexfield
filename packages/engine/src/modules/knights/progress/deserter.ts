import type { CommandHandler, PhaseHandler } from '../../../core/modules/index.js';
import type { CommandShape } from '../../../core/pipeline/index.js';
import type { GameState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { Result, Seat } from '../../../core/types/index.js';
import { recomputeLongestRoadAward } from '../../base/awards/index.js';
import { claimCommands } from '../../base/legal.js';
import { playerPending, withClaim } from '../../base/shared.js';
import { KNIGHT_LEVELS } from '../config.js';
import { knightAt, knightsOf, recruitSites, setKnights, supplyOf } from '../pieces.js';
import { changed, paramsObject, seatOf } from './card.js';
import type { CardFlow, CardModule } from './card.js';
import { frameData, popPhase, pushKnights } from './frames.js';

export const DESERTER_FRAME = 'deserter';

/**
 * The target removes a knight (`remove`), then the player may put one of its own knights of the same
 * or a lower level in its place (`place`). `level` and `active` are the removed knight's.
 */
interface DeserterData {
  actor: Seat;
  target: Seat;
  stage: 'remove' | 'place';
  level: number;
  active: boolean;
}

function data(state: GameState): DeserterData | undefined {
  return frameData<DeserterData>(state, DESERTER_FRAME);
}

/** Levels the player can put on the board now: at most the removed level, with a piece in supply. */
export function placeableLevels(state: GameState, actor: Seat, level: number): number[] {
  return KNIGHT_LEVELS.filter((item) => item <= level && supplyOf(state, actor, item) > 0);
}

/** Whether the player has a piece and a site for the removed knight's replacement. */
function canPlace(state: GameState, actor: Seat, level: number): boolean {
  return placeableLevels(state, actor, level).length > 0 && recruitSites(state, actor).length > 0;
}

function targetOf(state: GameState, params: unknown): Result<Seat> {
  const object = paramsObject(params, ['target']);
  if (!object.ok) return object;
  const seat = seatOf(state, object.value.target);
  return seat === undefined ? failure('invalid-seat', 'Choose another seat') : success(seat);
}

function vertexOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The target removes one of its own knights, of its choice. */
export const deserterRemove: CommandHandler = {
  keys: { allowed: ['vertex'] },
  validate: (state, input) => {
    const frame = data(state);
    if (frame?.stage !== 'remove' || frame.target !== input.seat)
      return failure('not-removing', 'This seat has no knight to remove');
    const vertex = vertexOf(input.command.vertex);
    return vertex !== null && knightAt(state, vertex)?.seat === input.seat
      ? success(undefined)
      : failure('no-knight', 'Choose one of your knights');
  },
  apply: (state, input, ctx) => {
    const frame = data(state);
    const vertex = vertexOf(input.command.vertex);
    const knight = vertex === null ? undefined : knightAt(state, vertex);
    if (frame === undefined || vertex === null || !knight)
      throw new Error('Validated removal missing');
    const removed = recomputeLongestRoadAward(
      setKnights(popPhase(state), (list) => list.filter((item) => item.vertex !== vertex)),
      ctx,
    );
    const event = { type: 'knightRemoved', seat: input.seat, vertex };
    if (!canPlace(removed, frame.actor, knight.level))
      return { state: removed, events: [event], effects: [] };
    return {
      state: pushKnights(removed, DESERTER_FRAME, {
        ...frame,
        stage: 'place',
        level: knight.level,
        active: knight.active,
      }),
      events: [event],
      effects: [],
    };
  },
};

function placement(state: GameState, seat: Seat, frame: DeserterData, input: CommandShape) {
  const vertex = vertexOf(input.vertex);
  const level =
    input.level === undefined
      ? Math.max(0, ...placeableLevels(state, seat, frame.level))
      : input.level;
  return { vertex, level };
}

/** The player puts one of its knights on the removed knight's level or lower, with its state. */
export const deserterPlace: CommandHandler = {
  keys: { allowed: ['vertex', 'level'], optional: ['level'] },
  validate: (state, input) => {
    const frame = data(state);
    if (frame?.stage !== 'place' || frame.actor !== input.seat)
      return failure('not-placing', 'No deserting knight awaits this seat');
    const { vertex, level } = placement(state, input.seat, frame, input.command);
    if (vertex === null || !recruitSites(state, input.seat).includes(vertex))
      return failure('illegal-knight-site', 'A knight needs an empty vertex where your road ends');
    return typeof level === 'number' &&
      placeableLevels(state, input.seat, frame.level).includes(level)
      ? success(undefined)
      : failure(
          'invalid-level',
          'Place a knight of the removed level or lower that you still hold',
        );
  },
  apply: (state, input, ctx) => {
    const frame = data(state);
    if (frame === undefined) throw new Error('Validated placement missing');
    const { vertex, level } = placement(state, input.seat, frame, input.command);
    if (vertex === null || typeof level !== 'number')
      throw new Error('Validated placement missing');
    // A knight that arrives active can act the same turn: it is ready.
    const placed = recomputeLongestRoadAward(
      setKnights(popPhase(state), (list) => [
        ...list,
        {
          seat: input.seat,
          vertex,
          level,
          active: frame.active,
          ready: frame.active,
          promotedTurn: null,
        },
      ]),
      ctx,
    );
    return {
      state: placed,
      events: [{ type: 'knightBuilt', seat: input.seat, vertex, level, deserted: true }],
      effects: [],
    };
  },
};

/** The player leaves the removed knight's place empty. */
export const deserterSkip: CommandHandler = {
  keys: { allowed: [] },
  validate: (state, input) =>
    data(state)?.stage === 'place' && data(state)?.actor === input.seat
      ? success(undefined)
      : failure('not-placing', 'No deserting knight awaits this seat'),
  apply: (state) => ({ state: popPhase(state), events: [], effects: [] }),
};

export const deserterPhase: PhaseHandler = {
  pending: (state) => {
    const frame = data(state);
    if (frame === undefined) return withClaim(state, []);
    return withClaim(state, [
      frame.stage === 'remove'
        ? playerPending(state, frame.target, ['DESERTER_REMOVE'], DESERTER_FRAME)
        : playerPending(state, frame.actor, ['DESERTER_PLACE', 'DESERTER_SKIP'], DESERTER_FRAME),
    ]);
  },
  legalCommands: (state, _frame, seat, priv, ctx) => {
    const claim = claimCommands(state, seat, priv, ctx);
    const frame = data(state);
    const commands: CommandShape[] = [];
    if (frame?.stage === 'remove' && frame.target === seat)
      for (const knight of knightsOf(state, seat))
        commands.push({ type: 'DESERTER_REMOVE', vertex: knight.vertex });
    if (frame?.stage === 'place' && frame.actor === seat) {
      for (const vertex of recruitSites(state, seat))
        for (const level of placeableLevels(state, seat, frame.level))
          commands.push({ type: 'DESERTER_PLACE', vertex, level });
      commands.push({ type: 'DESERTER_SKIP' });
    }
    return { commands: [...commands, ...claim.commands], templates: claim.templates };
  },
};

const flow: CardFlow = {
  commands: {
    DESERTER_REMOVE: deserterRemove,
    DESERTER_PLACE: deserterPlace,
    DESERTER_SKIP: deserterSkip,
  },
  phases: { [DESERTER_FRAME]: deserterPhase },
  timeout: (state, request) => {
    const frame = data(state);
    if (request.phase !== DESERTER_FRAME || frame === undefined) return null;
    if (frame.stage === 'remove' && frame.target === request.seat) {
      const vertex = knightsOf(state, request.seat)
        .map((knight) => knight.vertex)
        .toSorted()[0];
      return vertex === undefined ? null : { type: 'DESERTER_REMOVE', vertex };
    }
    if (frame.stage === 'place' && frame.actor === request.seat) {
      const vertex = recruitSites(state, request.seat)[0];
      const level = Math.max(0, ...placeableLevels(state, request.seat, frame.level));
      return vertex === undefined || level === 0
        ? { type: 'DESERTER_SKIP' }
        : { type: 'DESERTER_PLACE', vertex, level };
    }
    return null;
  },
};

/**
 * Deserter (Treason): choose another seat with a knight on the board. It removes a knight of its
 * choice. You may place one of your own knights of the same or a lower level, from your supply, on
 * an empty vertex where one of your roads ends. It takes the removed knight's active state and needs
 * no Fortress, even for a mighty knight. If you cannot place one, the victim still loses its knight.
 */
export const deserter: CardModule = {
  card: {
    id: 'deserter',
    timing: 'main',
    problem: (state, seat, params) => {
      const target = targetOf(state, params);
      if (!target.ok) return target;
      return target.value !== seat && knightsOf(state, target.value).length > 0
        ? success(undefined)
        : failure('no-target', 'Choose another seat with a knight on the board');
    },
    options: (state, seat) =>
      state.config.seats
        .filter((other) => other !== seat && knightsOf(state, other).length > 0)
        .map((target) => ({ target })),
    apply: (state, seat, params) => {
      const target = targetOf(state, params);
      if (!target.ok) throw new Error('Validated Deserter target missing');
      return changed(
        pushKnights(state, DESERTER_FRAME, {
          actor: seat,
          target: target.value,
          stage: 'remove',
          level: 0,
          active: false,
        }),
        { type: 'deserterPlayed', seat, target: target.value },
      );
    },
  },
  flow,
};

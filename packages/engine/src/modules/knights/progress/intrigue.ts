import type { GameState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { Result, Seat } from '../../../core/types/index.js';
import { recomputeLongestRoadAward } from '../../base/awards/index.js';
import { pushPhase } from '../../base/shared.js';
import { displacedFrame, relocationSpots } from '../actions.js';
import { knightAt, roadEndsAt, setKnights } from '../pieces.js';
import { knightsExt } from '../types.js';
import type { DisplacedFrameData } from '../types.js';
import { paramsObject, stringOf } from './card.js';
import type { CardModule } from './card.js';

function vertexOf(params: unknown): Result<string> {
  const object = paramsObject(params, ['vertex']);
  if (!object.ok) return object;
  const vertex = stringOf(object.value.vertex);
  return vertex === undefined
    ? failure('invalid-vertex', 'Choose an opposing knight')
    : success(vertex);
}

/** Opposing knights standing where one of the seat's roads ends, by vertex id. */
function targets(state: GameState, seat: Seat): string[] {
  return knightsExt(state)
    .knights.filter((knight) => knight.seat !== seat && roadEndsAt(state, seat, knight.vertex))
    .map((knight) => knight.vertex);
}

/**
 * Intrigue: displace an opposing knight that stands where one of your roads ends. No knight of
 * yours moves and no strengths are compared. The owner relocates the knight as after any
 * displacement (a `displaced` frame), and loses it when it has nowhere to go.
 */
export const intrigue: CardModule = {
  card: {
    id: 'intrigue',
    timing: 'main',
    problem: (state, seat, params) => {
      const vertex = vertexOf(params);
      if (!vertex.ok) return vertex;
      return targets(state, seat).includes(vertex.value)
        ? success(undefined)
        : failure('no-target', 'Choose an opposing knight where one of your roads ends');
    },
    options: (state, seat) => targets(state, seat).map((vertex) => ({ vertex })),
    apply: (state, seat, params, ctx) => {
      const vertex = vertexOf(params);
      const target = vertex.ok ? knightAt(state, vertex.value) : undefined;
      if (!vertex.ok || !target) throw new Error('Validated Intrigue target missing');
      let next = recomputeLongestRoadAward(
        setKnights(state, (list) => list.filter((knight) => knight.vertex !== vertex.value)),
        ctx,
      );
      const data: DisplacedFrameData = {
        seat: target.seat,
        origin: vertex.value,
        level: target.level,
        active: target.active,
        ready: target.ready,
        promotedTurn: target.promotedTurn,
      };
      const events: { type: string; [key: string]: unknown }[] = [
        { type: 'knightDisplaced', seat, from: null, to: vertex.value, displaced: target.seat },
      ];
      if (relocationSpots(next, data).length === 0)
        events.push({ type: 'knightRemoved', seat: target.seat, vertex: vertex.value });
      else next = pushPhase(next, displacedFrame(data));
      return { state: next, events, effects: [] };
    },
  },
};

import type { GameState } from '../../../core/state/index.js';
import type { GameEvent } from '../../../core/events/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { Result, Seat } from '../../../core/types/index.js';
import { promotePiece, promoteProblem } from '../recruit.js';
import { knightsOf } from '../pieces.js';
import { paramsObject } from './card.js';
import type { CardModule } from './card.js';

function verticesOf(params: unknown): Result<string[]> {
  const object = paramsObject(params, ['vertices']);
  if (!object.ok) return object;
  const list = object.value.vertices;
  if (
    !Array.isArray(list) ||
    list.length < 1 ||
    list.length > 2 ||
    !list.every((item) => typeof item === 'string') ||
    new Set(list).size !== list.length
  )
    return failure('invalid-vertices', 'Choose one or two different knights');
  return success(list.map(String));
}

/** Promote the knights one after another; the second is judged on the board the first left. */
function promoteAll(
  state: GameState,
  seat: Seat,
  vertices: readonly string[],
): Result<{ state: GameState; events: GameEvent[] }> {
  let next = state;
  const events: GameEvent[] = [];
  for (const vertex of vertices) {
    const problem = promoteProblem(next, seat, vertex);
    if (!problem.ok) return problem;
    const promoted = promotePiece(next, seat, vertex);
    next = promoted.state;
    events.push(...promoted.events);
  }
  return success({ state: next, events });
}

/**
 * Smith (Smithing): promote up to two of your knights one level each for free. A knight's active
 * state does not change. Basic to strong needs nothing, strong to mighty needs the Fortress, and a
 * knight is promoted at most once a turn, however it was promoted.
 */
export const smith: CardModule = {
  card: {
    id: 'smith',
    timing: 'main',
    problem: (state, seat, params) => {
      const vertices = verticesOf(params);
      if (!vertices.ok) return vertices;
      const done = promoteAll(state, seat, vertices.value);
      return done.ok ? success(undefined) : done;
    },
    options: (state, seat) => {
      const own = knightsOf(state, seat).map((knight) => knight.vertex);
      const sets: { vertices: string[] }[] = [];
      for (const [index, first] of own.entries()) {
        if (promoteAll(state, seat, [first]).ok) sets.push({ vertices: [first] });
        for (const second of own.slice(index + 1))
          if (promoteAll(state, seat, [first, second]).ok) sets.push({ vertices: [first, second] });
      }
      return sets;
    },
    apply: (state, seat, params) => {
      const vertices = verticesOf(params);
      if (!vertices.ok) throw new Error('Validated Smith knights missing');
      const done = promoteAll(state, seat, vertices.value);
      if (!done.ok) throw new Error('Validated Smith promotions failed');
      return { ...done.value, effects: [] };
    },
  },
};

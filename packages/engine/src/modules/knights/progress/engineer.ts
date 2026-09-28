import { failure, success } from '../../../core/types/index.js';
import type { Result } from '../../../core/types/index.js';
import { citiesOf } from '../improvements.js';
import { placeWall, wallProblem } from '../recruit.js';
import { paramsObject, stringOf } from './card.js';
import type { CardModule } from './card.js';

function vertexOf(params: unknown): Result<string> {
  const object = paramsObject(params, ['vertex']);
  if (!object.ok) return object;
  const vertex = stringOf(object.value.vertex);
  return vertex === undefined
    ? failure('invalid-vertex', 'Choose one of your cities')
    : success(vertex);
}

/** Engineer: build one city wall for free under a city without one, if a wall piece is left. */
export const engineer: CardModule = {
  card: {
    id: 'engineer',
    timing: 'main',
    problem: (state, seat, params) => {
      const vertex = vertexOf(params);
      return vertex.ok ? wallProblem(state, seat, vertex.value) : vertex;
    },
    options: (state, seat) =>
      citiesOf(state, seat)
        .filter((vertex) => wallProblem(state, seat, vertex).ok)
        .map((vertex) => ({ vertex })),
    apply: (state, seat, params) => {
      const vertex = vertexOf(params);
      if (!vertex.ok) throw new Error('Validated wall vertex missing');
      return { ...placeWall(state, seat, vertex.value), effects: [] };
    },
  },
};

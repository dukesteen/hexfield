import { isLandHex } from '../../base/board/index.js';
import type { GameState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { Result } from '../../../core/types/index.js';
import { paramsObject } from './card.js';
import type { CardModule } from './card.js';

/** Number tokens the Inventor may not move: the two most productive numbers and the extremes. */
const FIXED_TOKENS: ReadonlySet<number> = new Set([2, 6, 8, 12]);

function hexesOf(params: unknown): Result<[string, string]> {
  const object = paramsObject(params, ['hexes']);
  if (!object.ok) return object;
  const hexes = object.value.hexes;
  return Array.isArray(hexes) &&
    hexes.length === 2 &&
    typeof hexes[0] === 'string' &&
    typeof hexes[1] === 'string'
    ? success<[string, string]>([hexes[0], hexes[1]])
    : failure('invalid-hexes', 'Choose two land hexes');
}

function tokenOf(state: GameState, hex: string): number | null {
  return state.board.hexes.find((item) => item.id === hex)?.token ?? null;
}

/** Two different land hexes, each with a token that is not 2, 6, 8 or 12, and different values. */
function swapProblem(state: GameState, first: string, second: string): Result<void> {
  if (first === second) return failure('same-hex', 'Choose two different hexes');
  for (const hex of [first, second]) {
    if (!isLandHex(state, hex)) return failure('not-land', 'Number tokens sit on land hexes');
    const token = tokenOf(state, hex);
    if (token === null) return failure('no-token', 'That hex has no number token');
    if (FIXED_TOKENS.has(token))
      return failure('fixed-token', 'The 2, 6, 8 and 12 tokens cannot be swapped');
  }
  return tokenOf(state, first) === tokenOf(state, second)
    ? failure('same-token', 'Swapping equal numbers changes nothing')
    : success(undefined);
}

/**
 * Inventor: swap two number tokens, neither being 2, 6, 8 or 12 and of different values. No
 * building is needed. The robber stays where it is and blocks whichever number arrives.
 */
export const inventor: CardModule = {
  card: {
    id: 'inventor',
    timing: 'main',
    problem: (state, _seat, params) => {
      const hexes = hexesOf(params);
      return hexes.ok ? swapProblem(state, hexes.value[0], hexes.value[1]) : hexes;
    },
    options: (state) => {
      const ids = state.board.hexes.map((hex) => hex.id).toSorted();
      const pairs: { hexes: [string, string] }[] = [];
      for (const [index, first] of ids.entries())
        for (const second of ids.slice(index + 1))
          if (swapProblem(state, first, second).ok) pairs.push({ hexes: [first, second] });
      return pairs;
    },
    apply: (state, seat, params) => {
      const hexes = hexesOf(params);
      if (!hexes.ok) throw new Error('Validated Inventor hexes missing');
      const [first, second] = hexes.value;
      const a = tokenOf(state, first);
      const b = tokenOf(state, second);
      return {
        state: {
          ...state,
          board: {
            ...state.board,
            hexes: state.board.hexes.map((hex) =>
              hex.id === first
                ? { ...hex, token: b }
                : hex.id === second
                  ? { ...hex, token: a }
                  : hex,
            ),
          },
        },
        events: [{ type: 'tokensSwapped', seat, hexes: [first, second] }],
        effects: [],
      };
    },
  },
};

// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { knightsExt } from '@cp2p/engine';
import type { CommandShape, GameState, KnightPiece, Seat } from '@cp2p/engine';
import knights from '../../i18n/locales/en/knights.json';
import { KnightSheet } from './KnightSheet';
import { knightStatus } from './knight-status';
import { genesis, testI18n, withI18n } from './test-support';

let i18n: Awaited<ReturnType<typeof testI18n>>;
beforeAll(async () => {
  i18n = await testI18n();
});
afterEach(cleanup);

const KNIGHT = 'v:0,0,N';

/** The game with one knight of seat 0, in a step of a seat's turn. */
function withKnight(piece: Partial<KnightPiece>, step = 'main', activeSeat: Seat = 0): GameState {
  const ext = knightsExt(genesis);
  return {
    ...genesis,
    turn: { ...genesis.turn, activeSeat, phase: [{ module: 'base', id: step, data: null }] },
    ext: {
      ...genesis.ext,
      knights: {
        ...ext,
        knights: [
          {
            seat: 0,
            vertex: KNIGHT,
            level: 1,
            active: false,
            ready: false,
            promotedTurn: null,
            ...piece,
          },
        ],
      },
    },
  };
}

function present<T>(value: T | null): T {
  if (value === null) throw new Error('No knight status');
  return value;
}

const move = (to: string): CommandShape => ({ type: 'MOVE_KNIGHT', from: KNIGHT, to });

test('a ready knight offers each legal move, and a move goes on to the board', () => {
  const state = withKnight({ active: true, ready: true, level: 2 });
  const status = knightStatus(state, 0, KNIGHT, [move('v:1,0,N'), move('v:0,1,N')]);
  expect(status).toMatchObject({ readiness: 'ready', level: 2, idle: null });
  expect(status?.moves).toEqual(['v:1,0,N', 'v:0,1,N']);
  const onChoose = vi.fn<(kind: string) => void>();
  withI18n(
    i18n,
    <KnightSheet
      status={present(status)}
      owner="Ada"
      color="blue"
      onChoose={onChoose}
      onSubmit={vi.fn<(command: CommandShape) => void>()}
      onClose={vi.fn<() => void>()}
    />,
  );
  expect(screen.getByText(knights.knightSheet.level2)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Move knight (2 places)' }));
  expect(onChoose).toHaveBeenCalledWith('moveKnight');
});

test('a knight activated this turn says it is ready next turn, and offers only what is legal', () => {
  const state = withKnight({ active: true, ready: false });
  const promote: CommandShape = { type: 'PROMOTE_KNIGHT', vertex: KNIGHT };
  const status = knightStatus(state, 0, KNIGHT, [promote]);
  expect(status).toMatchObject({ readiness: 'activatedThisTurn', idle: 'activatedThisTurn' });
  const onSubmit = vi.fn<(command: CommandShape) => void>();
  withI18n(
    i18n,
    <KnightSheet
      status={present(status)}
      owner="Ada"
      color="blue"
      onChoose={vi.fn<(kind: string) => void>()}
      onSubmit={onSubmit}
      onClose={vi.fn<() => void>()}
    />,
  );
  expect(screen.getByRole('status').textContent).toBe(knights.knightSheet.idle.activatedThisTurn);
  fireEvent.click(screen.getByRole('button', { name: knights.action.promote }));
  expect(onSubmit).toHaveBeenCalledWith(promote);
});

test('the reasons follow the rules: inactive, not your turn, before the roll, not yours', () => {
  expect(knightStatus(withKnight({}), 0, KNIGHT, [])?.idle).toBe('inactive');
  const ready = { active: true, ready: true };
  expect(knightStatus(withKnight(ready, 'main', 1), 0, KNIGHT, [])?.idle).toBe('notYourTurn');
  expect(knightStatus(withKnight(ready, 'preRoll'), 0, KNIGHT, [])?.idle).toBe('afterRoll');
  expect(knightStatus(withKnight(ready, 'discard'), 0, KNIGHT, [])?.idle).toBe('finishStep');
  expect(knightStatus(withKnight(ready), 0, KNIGHT, [])?.idle).toBe('noTarget');
  // Another seat's knight shows its state, and never that seat's commands.
  const theirs = knightStatus(withKnight(ready), 1, KNIGHT, [move('v:1,0,N')]);
  expect(theirs).toMatchObject({ idle: 'notYours', moves: [] });
  expect(knightStatus(withKnight(ready), 0, 'v:9,9,N', [])).toBeNull();
});

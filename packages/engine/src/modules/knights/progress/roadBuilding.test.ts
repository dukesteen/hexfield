import { describe, expect, test } from 'vitest';
import { failure } from '../../../core/types/index.js';
import { handOf, rejection, submit, top, withHand } from '../support.js';
import { knightsExt } from '../types.js';
import { engine, held, play, refusal, scene, withCards } from './testing.js';

function position() {
  const { state } = scene();
  return { state: withHand(withCards(state, 0, 'roadBuilding'), 0, {}) };
}

const roads = (state: ReturnType<typeof scene>['state'], seat = 0) =>
  state.board.roads.filter((road) => road.seat === seat).length;

describe('Road Building', () => {
  test('two roads are built for free, one after another', () => {
    const { state } = position();
    const started = play(state, 0, 'roadBuilding');
    expect(top(started)).toMatchObject({
      module: 'base',
      id: 'roadBuilding',
      data: { remaining: 2 },
    });
    const first = engine
      .getLegalCommands(started, 0)
      .commands.find((command) => command.type === 'PLACE_FREE_ROAD');
    if (!first) throw new Error('No free road offered');
    const one = submit(engine, started, 0, first);
    expect(top(one)).toMatchObject({ data: { remaining: 1 } });
    const second = engine
      .getLegalCommands(one, 0)
      .commands.find((command) => command.type === 'PLACE_FREE_ROAD');
    if (!second) throw new Error('No second free road offered');
    const two = submit(engine, one, 0, second);
    expect(top(two)?.id).toBe('main');
    expect(roads(two)).toBe(roads(state) + 2);
    expect(handOf(two, 0)).toEqual(handOf(state, 0));
    expect(held(two, 0)).toEqual([]);
    expect(knightsExt(two).bottom.science).toEqual(['roadBuilding']);
  });

  test('the player may stop after the first road', () => {
    const { state } = position();
    const started = play(state, 0, 'roadBuilding');
    const first = engine
      .getLegalCommands(started, 0)
      .commands.find((command) => command.type === 'PLACE_FREE_ROAD');
    if (!first) throw new Error('No free road offered');
    const one = submit(engine, started, 0, first);
    const done = submit(engine, one, 0, { type: 'SKIP' });
    expect(top(done)?.id).toBe('main');
    expect(roads(done)).toBe(roads(state) + 1);
  });

  test('with no road piece or site left it cannot be played', () => {
    const { state } = position();
    const spent = {
      ...state,
      seats: state.seats.map((seat) =>
        seat.seat === 0 ? { ...seat, piecesLeft: { ...seat.piecesLeft, road: 0 } } : seat,
      ),
    };
    expect(refusal(spent, 0, 'roadBuilding')).toBe('no-road-site');
    expect(refusal(state, 0, 'roadBuilding', { edge: 'e' })).toBe('unknown-field');
    expect(failure('x', 'y').ok).toBe(false);
  });

  test('roads are only free for the player, and only in its action phase', () => {
    const { state } = position();
    const started = play(state, 0, 'roadBuilding');
    expect(rejection(engine, started, 1, { type: 'PLACE_FREE_ROAD', edge: 'e' })).toBe(
      'not-pending',
    );
  });
});

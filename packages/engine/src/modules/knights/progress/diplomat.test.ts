import { describe, expect, test } from 'vitest';
import type { GameState } from '../../../core/state/index.js';
import {
  edgeBetween,
  inMain,
  newGame,
  pathVertices,
  ringLayout,
  withBuildings,
  withRoads,
} from '../support.js';
import { isOpenRoad, knightsConnected } from './diplomat.js';
import {
  at,
  engine,
  held,
  knightsOn,
  play,
  playParam,
  refusal,
  scene,
  withCards,
} from './testing.js';

/**
 * Seat 0 has a settlement and a chain of five roads round the ring, ending at ring 4. Seat 1 has a
 * city at ring 5 and a two-road spur out of it.
 */
function position() {
  const { state, ring, out } = scene();
  const spur = pathVertices(state, 3, at(ring, 5), [...ring.slice(0, 5), at(out, 0)]);
  const roads = withRoads(state, 1, spur);
  return { state: withCards(roads, 0, 'diplomat'), ring, out, spur };
}

const chain = (ring: readonly string[], out: readonly string[]) => [
  edgeBetween(scene().state, at(out, 0), at(ring, 0)),
  edgeBetween(scene().state, at(ring, 0), at(ring, 1)),
  edgeBetween(scene().state, at(ring, 1), at(ring, 2)),
  edgeBetween(scene().state, at(ring, 2), at(ring, 3)),
  edgeBetween(scene().state, at(ring, 3), at(ring, 4)),
];

describe('Diplomat', () => {
  test('only a road with a free end is open', () => {
    const { state, ring, out, spur } = position();
    const [first, second, , , last] = chain(ring, out);
    // The first road ends at the settlement, the middle ones join two roads.
    expect(isOpenRoad(state, first ?? '')).toBe(false);
    expect(isOpenRoad(state, second ?? '')).toBe(false);
    expect(isOpenRoad(state, last ?? '')).toBe(true);
    expect(isOpenRoad(state, edgeBetween(state, at(spur, 1), at(spur, 2)))).toBe(true);
    expect(isOpenRoad(state, edgeBetween(state, at(spur, 0), at(spur, 1)))).toBe(false);
    // A road with a building at each end, or a knight at the free end, is not open.
    const knight = knightsOn(state, 0, [at(ring, 4)]);
    expect(isOpenRoad(knight, last ?? '')).toBe(false);
  });

  test('removing an open road of another seat returns it to that seat', () => {
    const { state, spur } = position();
    const edge = edgeBetween(state, at(spur, 1), at(spur, 2));
    const after = play(state, 0, 'diplomat', { edge, build: null });
    expect(after.board.roads.some((road) => road.edge === edge)).toBe(false);
    expect(after.seats[1]?.piecesLeft.road).toBe((state.seats[1]?.piecesLeft.road ?? 0) + 1);
    expect(held(after, 0)).toEqual([]);
    // The player gets no road for another seat's road.
    expect(refusal(state, 0, 'diplomat', { edge, build: 'x' })).toBe('not-own-road');
  });

  test('removing the player’s own road allows one free road, elsewhere, in the same play', () => {
    const { state, ring, out } = position();
    const last = chain(ring, out)[4] ?? '';
    const edges = playParam(state, 0, 'edge');
    const builds = playParam(state, 0, 'build');
    const replacements = builds.filter((item, index) => edges[index] === last && item !== null);
    expect(replacements.length).toBeGreaterThan(0);
    // The removed edge is never offered again.
    expect(replacements.every((item) => item !== last)).toBe(true);
    const build = String(replacements[0]);
    const after = play(state, 0, 'diplomat', { edge: last, build });
    expect(after.board.roads.some((road) => road.edge === last)).toBe(false);
    expect(after.board.roads.some((road) => road.edge === build && road.seat === 0)).toBe(true);
    expect(after.seats[0]?.piecesLeft.road).toBe(state.seats[0]?.piecesLeft.road);
    expect(refusal(state, 0, 'diplomat', { edge: last, build: last })).toBe('illegal-road');
    expect(refusal(state, 0, 'diplomat', { edge: last, build: 'nowhere' })).toBe('illegal-road');
  });

  test('the free road is optional', () => {
    const { state, ring, out } = position();
    const last = chain(ring, out)[4] ?? '';
    const after = play(state, 0, 'diplomat', { edge: last });
    expect(after.seats[0]?.piecesLeft.road).toBe((state.seats[0]?.piecesLeft.road ?? 0) + 1);
  });

  test('an interior road, an empty edge and a road that would strand a knight are refused', () => {
    const { state, ring, out } = position();
    const [first, second, , , last] = chain(ring, out);
    expect(refusal(state, 0, 'diplomat', { edge: first })).toBe('not-open');
    expect(refusal(state, 0, 'diplomat', { edge: second })).toBe('not-open');
    expect(refusal(state, 0, 'diplomat', { edge: 'e:nowhere' })).toBe('no-road');
    // A knight that reaches its settlement only over the last road would be cut off.
    const stranded = knightsOn(state, 0, [at(ring, 4)]);
    expect(refusal(stranded, 0, 'diplomat', { edge: last })).toBe('not-open');
    // Two knights at the free end are the same. A knight beyond a removable spur is judged too.
    expect(knightsConnected(stranded, 0)).toBe(true);
  });

  test('a knight must stay connected to a settlement or city', () => {
    const { state, ring, out } = position();
    const [, , , fourth, last] = chain(ring, out);
    // The knight stands at ring 3: it reaches the settlement over four roads. Removing the open
    // last road leaves it connected, removing anything else is not allowed anyway.
    const knight = knightsOn(state, 0, [at(ring, 3)]);
    expect(refusal(knight, 0, 'diplomat', { edge: last })).toBeNull();
    // Cut the chain by another seat's city at ring 2: the knight can no longer reach the settlement.
    const cut = withBuildings(knight, [{ vertex: at(ring, 2), seat: 2, kind: 'city' }]);
    expect(knightsConnected(cut, 0)).toBe(false);
    expect(fourth).toBeDefined();
  });

  test('a loop of roads has no open road', () => {
    const base = inMain(newGame(engine, { seats: 3 }));
    const layout = ringLayout(base);
    const closed = withRoads(base, 2, [...layout.ring, at(layout.ring, 0)]);
    expect(closed.board.roads.filter((road) => road.seat === 2)).toHaveLength(6);
    for (const road of closed.board.roads) expect(isOpenRoad(closed, road.edge)).toBe(false);
    // Open the loop and its two end roads become open.
    const open = { ...closed, board: { ...closed.board, roads: closed.board.roads.slice(0, 5) } };
    expect(open.board.roads.filter((road) => isOpenRoad(open, road.edge))).toHaveLength(2);
  });

  test('Longest Road is settled after the removal', () => {
    const base = inMain(newGame(engine, { seats: 3 }));
    const long = pathVertices(base, 7);
    const rich = withRoads(base, 1, long);
    const holder: GameState = { ...rich, awards: { ...rich.awards, longestRoad: 1 } };
    const edge = edgeBetween(holder, at(long, 5), at(long, 6));
    const after = play(withCards(holder, 0, 'diplomat'), 0, 'diplomat', { edge });
    // Seat 1 had six roads in a row; five keep the award.
    expect(after.awards.longestRoad).toBe(1);
    const inner = edgeBetween(holder, at(long, 4), at(long, 5));
    const twice = play(withCards(after, 0, 'diplomat'), 0, 'diplomat', { edge: inner });
    expect(twice.awards.longestRoad).toBeNull();
  });

  test('parameters are checked', () => {
    const { state } = position();
    expect(refusal(state, 0, 'diplomat')).toBe('invalid-params');
    expect(refusal(state, 0, 'diplomat', { edge: 5 })).toBe('invalid-edge');
    expect(refusal(state, 0, 'diplomat', { edge: 'e', more: 1 })).toBe('unknown-field');
    expect(refusal(state, 0, 'diplomat', { edge: 'e', build: 7 })).toBe('invalid-edge');
  });
});

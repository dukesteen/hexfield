import { describe, expect, test } from 'vitest';
import type { GameState } from '../../core/state/index.js';
import { boardGraph } from '../base/board/index.js';
import { regionOfVertex, seafaringExt } from './index.js';
import { seafaringEngine } from './testing.js';
import { edgeId, edgesAt, edgesOfHex, newGame, rejection, submit, vertexId } from './support.js';

const engine = seafaringEngine();
const V0 = vertexId({ q: 2, r: -1 }, 'NE');
const COAST_EDGE = edgeId({ q: 2, r: -1 }, 'NE');

function started(state: GameState, seat = 0): GameState {
  const result = engine.apply(state, { kind: 'system', type: 'START_SEAT', seat });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.state;
}

/** Vertices touching every one of the listed hexes. */
function verticesTouching(state: GameState, hexes: readonly string[]): string[] {
  const graph = boardGraph(state);
  return graph.vertexIds.filter((vertex) => {
    const around: readonly string[] = graph.vertexHexes[graph.vertexIndex[vertex] ?? -1] ?? [];
    return hexes.every((hex) => around.includes(hex));
  });
}

describe('setup', () => {
  test('settlements must lie in the setup areas', () => {
    const state = started(newGame(engine, { seats: 2 }));
    const island = verticesTouching(state, ['h:4,-3'])[0] ?? '';
    expect(rejection(engine, state, 0, { type: 'PLACE_SETTLEMENT', vertex: island })).toBe(
      'illegal-settlement',
    );
    expect(rejection(engine, state, 0, { type: 'PLACE_SETTLEMENT', vertex: V0 })).toBeNull();
    const open = started(newGame(engine, { seats: 2, seafaring: { setupAreas: null } }));
    expect(rejection(engine, open, 0, { type: 'PLACE_SETTLEMENT', vertex: island })).toBeNull();
    const legal = engine.getLegalCommands(state, 0).commands;
    expect(legal.length).toBeGreaterThan(0);
    expect(legal.every((command) => command.vertex !== island)).toBe(true);
  });
  test('a coastal setup settlement may be followed by a ship instead of a road', () => {
    let state = started(newGame(engine, { seats: 2 }));
    expect(rejection(engine, state, 0, { type: 'PLACE_SETUP_SHIP', edge: COAST_EDGE })).toBe(
      'not-pending',
    );
    state = submit(engine, state, 0, { type: 'PLACE_SETTLEMENT', vertex: V0 });
    const pending = engine.getPending(state);
    expect(pending).toEqual([
      { kind: 'player', seat: 0, allowed: ['PLACE_ROAD', 'PLACE_SETUP_SHIP'] },
    ]);
    const legal = engine.getLegalCommands(state, 0).commands;
    expect(legal.filter((command) => command.type === 'PLACE_SETUP_SHIP').length).toBeGreaterThan(
      0,
    );
    expect(legal.filter((command) => command.type === 'PLACE_ROAD').length).toBeGreaterThan(0);
    state = submit(engine, state, 0, { type: 'PLACE_SETUP_SHIP', edge: COAST_EDGE });
    expect(state.board.ships).toEqual([{ edge: COAST_EDGE, seat: 0 }]);
    expect(state.board.roads).toEqual([]);
    expect(state.seats[0]?.piecesLeft.ship).toBe(14);
    expect(state.turn.activeSeat).toBe(1);
    expect(engine.getPending(state)[0]).toMatchObject({ kind: 'player', seat: 1 });
    expect(engine.checkInvariants(state)).toEqual([]);
  });
  test('a setup ship must touch the new settlement, the sea and not the pirate', () => {
    let state = started(newGame(engine, { seats: 2 }));
    const far = edgeId({ q: 2, r: -2 }, 'NE');
    state = submit(engine, state, 0, { type: 'PLACE_SETTLEMENT', vertex: V0 });
    expect(rejection(engine, state, 0, { type: 'PLACE_SETUP_SHIP', edge: far })).toBe(
      'illegal-ship',
    );
    expect(rejection(engine, state, 0, { type: 'PLACE_SETUP_SHIP' })).toBe('invalid-edge');
    // A settlement beside the pirate's hex: no ship on that hex's edges, not even in setup.
    const graph = boardGraph(state);
    const shore = graph.hexVertices[graph.hexIndex['h:2,0'] ?? -1]?.find((vertex) =>
      (graph.vertexHexes[graph.vertexIndex[vertex] ?? -1] ?? []).includes('h:3,0'),
    );
    const next = submit(engine, state, 0, {
      type: 'PLACE_ROAD',
      edge: edgesAt(state, V0)[0] ?? '',
    });
    const placed = submit(engine, next, 1, { type: 'PLACE_SETTLEMENT', vertex: shore ?? '' });
    const pirate = edgesOfHex(placed, 'h:3,0');
    const blocked = edgesAt(placed, shore ?? '').filter((edge) => pirate.includes(edge));
    expect(blocked.length).toBeGreaterThan(0);
    expect(
      blocked.map((edge) => rejection(engine, placed, 1, { type: 'PLACE_SETUP_SHIP', edge })),
    ).toEqual(blocked.map(() => 'illegal-ship'));
    const legal = engine.getLegalCommands(placed, 1).commands;
    expect(
      legal.some(
        (command) => command.type === 'PLACE_SETUP_SHIP' && pirate.includes(String(command.edge)),
      ),
    ).toBe(false);
  });
  test('a setup road may not use a sea edge', () => {
    const state = submit(engine, started(newGame(engine, { seats: 2 })), 0, {
      type: 'PLACE_SETTLEMENT',
      vertex: V0,
    });
    const seaEdge = edgesAt(state, V0).find(
      (edge) => rejection(engine, state, 0, { type: 'PLACE_ROAD', edge }) !== null,
    );
    expect(seaEdge).toBeDefined();
    expect(
      rejection(engine, state, 0, { type: 'PLACE_SETUP_SHIP', edge: seaEdge ?? '' }),
    ).toBeNull();
  });
  test('a setup ship is refused while a settlement is pending', () => {
    const state = started(newGame(engine, { seats: 2 }));
    expect(rejection(engine, state, 0, { type: 'PLACE_SETUP_SHIP', edge: COAST_EDGE })).toBe(
      'not-pending',
    );
  });
  test('home regions are recorded from setup settlements, and setup earns no bonus or gold', () => {
    let state = started(newGame(engine, { seats: 2, seafaring: { setupAreas: null } }));
    const goldSite = verticesTouching(state, ['h:4,-3', 'h:4,-2'])[0] ?? '';
    const inland = verticesTouching(state, ['h:0,0', 'h:1,0', 'h:0,1'])[0] ?? '';
    const other = verticesTouching(state, ['h:-1,0', 'h:0,0', 'h:0,-1'])[0] ?? '';
    const picks: [0 | 1, string][] = [
      [0, inland],
      [1, other],
      [1, goldSite],
      [0, V0],
    ];
    for (const [seat, vertex] of picks) {
      state = submit(engine, state, seat, { type: 'PLACE_SETTLEMENT', vertex });
      const road = engine
        .getLegalCommands(state, seat)
        .commands.find((c) => c.type === 'PLACE_ROAD');
      state = submit(engine, state, seat, road ?? { type: 'PLACE_ROAD' });
    }
    const ext = seafaringExt(state);
    expect(ext.homeRegions[0]).toEqual([regionOfVertex(state, inland)]);
    expect(ext.homeRegions[1]?.length).toBe(2);
    expect(ext.bonus).toEqual([]);
    // Seat 1's second settlement touches gold (6) and fields (9): only grain is paid.
    expect(state.seats[1]?.resources.total).toBe(1);
    expect(state.seats[1]?.resources.min.grain).toBe(1);
    expect(state.turn.phase.at(-1)?.id).toBe('preRoll');
    expect(engine.checkInvariants(state)).toEqual([]);
  });
});
